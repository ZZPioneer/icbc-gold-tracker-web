#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工行积存金实盘跟踪 —— 本地 HTTP 服务（Python 标准库 + MySQL）。

结构：
  icbc_client.py   取数与解析
  db.py            MySQL 数据层（行情 / 金种 / 个人数据 / 用户 / 设置）
  auth.py          密码哈希与签名会话
  server.py        缓存 / 调度 / HTTP 路由 / 鉴权
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import threading
import time
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ai_analyzer
import market_map
import sector_corr
from auth import (clear_cookie_header, cookie_header, hash_password, make_session,
                  parse_session, token_from_cookie_header, verify_password)
from db import MySQLStore, load_config
from icbc_client import IcbcClient, now_str

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DEFAULT_UPSTREAM_INTERVAL = 2.0
BACKOFF_SECONDS = (5, 10, 20, 60)
MAX_HISTORY = 20000
DEFAULT_CLOSE_AT = "22:30"  # 每日收盘闸门：到本地时间即停止采集，次日重启恢复

_LOG = logging.getLogger("gold-tracker")


def _snapshot(quote: dict) -> list[dict]:
    """把一次行情转成历史记录（采集时间使用本地时间，工行时间另存）。"""
    records = []
    for row in quote["rows"]:
        item = dict(row)
        item["t"] = quote["source_time"]
        item["fetched_at"] = quote["fetched_at"]
        records.append(item)
    return records


class QuoteService:
    """后台线程持续采集 + 缓存 + 单飞 + 退避。

    采集由服务端后台线程驱动，与网页是否打开无关：bat 启动即开始按 collect_interval
    定时抓取工行并写入 MySQL。HTTP 的 get() 只读取缓存，force 仅用于手动立即刷新。
    """

    def __init__(self, store: MySQLStore, upstream_interval: float = DEFAULT_UPSTREAM_INTERVAL,
                 collect_interval: float = 4.0,
                 compact_interval: float = 600.0,
                 keep_days: int = 2,
                 close_at: str | None = DEFAULT_CLOSE_AT):
        self.client = IcbcClient()
        self.store = store
        self.upstream_interval = upstream_interval
        # 采集间隔不得低于上游保护间隔，避免对工行站点压力过大
        self.collect_interval = max(float(collect_interval), upstream_interval)
        # 分层保留：压缩周期 / 明细保留天数
        self.compact_interval = max(float(compact_interval), 60.0)
        self.keep_days = max(int(keep_days), 1)
        # 每日收盘闸门：到点后停止采集，网页服务保持可用；次日重启进程才恢复
        self.close_at = close_at
        self._close_hour, self._close_min = self._parse_close_at(close_at)
        self._closed = False           # 锁存：一旦到点置 True，跨天也不自动恢复
        self._closed_at: str | None = None
        self._lock = threading.RLock()
        self._cache: dict | None = None
        self._last_fetch = 0.0
        self._next_fetch = 0.0
        self._consecutive_errors = 0
        self._inflight = False
        self._seq = 0              # 每次成功采集 +1，前端据此判断是否需要重载历史
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._compact_thread: threading.Thread | None = None
        self._last_compact: float = 0.0
        self._last_compact_result: dict | None = None
        # AI 每日分析：配置 + 收盘自动触发（只触发一次）+ 最近一次结果
        self.ai_cfg = ai_analyzer.load_ai_config()
        self._close_analysis_done = False
        self._last_analysis: dict | None = None

    @staticmethod
    def _parse_close_at(value: str | None):
        """把 'HH:MM' 解析为 (时, 分)；None / 'off' / 非法值表示不启用收盘闸门。"""
        if value is None:
            return None, None
        text = str(value).strip().lower()
        if text in ("", "off", "none", "0"):
            return None, None
        try:
            hh, mm = text.split(":")
            hh, mm = int(hh), int(mm)
            if 0 <= hh <= 23 and 0 <= mm <= 59:
                return hh, mm
        except (ValueError, TypeError):
            pass
        return None, None

    @staticmethod
    def _past_close(now: datetime, close_hour: int | None, close_min: int | None) -> bool:
        """判断当前本地时间是否已过当日收盘点。"""
        if close_hour is None:
            return False
        return (now.hour, now.minute) >= (close_hour, close_min or 0)

    def _check_close(self):
        """到点则锁存收盘状态；只记一次日志，并触发当日 AI 分析。"""
        if self._closed:
            return
        if self._past_close(datetime.now(), self._close_hour, self._close_min):
            self._closed = True
            self._closed_at = now_str()
            _LOG.info("已到本地收盘时间 %02d:%02d，停止采集；网页服务保持运行，重启后恢复",
                      self._close_hour, self._close_min or 0)
            self._maybe_auto_analyze()

    @staticmethod
    def _with_deltas(quote: dict, prev: dict) -> dict:
        """在服务端计算「较上次抓取」的变动，避免前端用缓存值算出 0。"""
        rows = []
        for row in quote["rows"]:
            item = dict(row)
            old = prev.get(row["code"], {})
            for key in ("active", "regular", "redeem"):
                item["delta_" + key] = (
                    round(row[key] - old[key], 4)
                    if old.get(key) is not None and row.get(key) is not None else None
                )
            rows.append(item)
        return {**quote, "rows": rows}

    def _stale(self, **extra):
        """兼容旧调用：返回当前缓存快照（含 seq），供测试与错误兜底使用。"""
        with self._lock:
            retry = max(0, int(self._next_fetch - time.time()))
        return {**(self._cache or {
            "ok": False, "rows": [], "fetched_at": None, "source_time": None
        }), "cached": True, "seq": self._seq, "retry_after": retry,
            "market_closed": self._closed, "closed_at": self._closed_at,
            "close_at": self.close_at, **extra}

    def restore_cache_from_db(self) -> bool:
        """从当天明细只读恢复最近一帧到内存缓存（不抓上游、不写库）。

        用于收盘后启动：此时首帧抓取被闸门拦截，若无此步则 /api/quote 返回空，
        页面「什么都不显示」。恢复后页面可正常展示当天行情与图表。
        """
        if self._cache is not None:
            return True
        # 收盘后定格在收盘点：取 <= 当日收盘时刻的最后一帧，而不是收盘后多采的尾巴。
        # 未启用收盘闸门时 _close_hour 为 None，则取当天最后一帧。
        until = None
        if self._close_hour is not None:
            today = datetime.now().strftime("%Y-%m-%d")
            until = f"{today} {self._close_hour:02d}:{self._close_min or 0:02d}:00"
        try:
            snap = self.store.latest_snapshot(until=until)
        except Exception as exc:
            _LOG.warning("从数据库恢复当日行情失败: %s: %s", type(exc).__name__, exc)
            return False
        if not snap or not snap.get("rows"):
            return False
        with self._lock:
            if self._cache is None:
                self._cache = snap
                self._closed_at = self._closed_at or now_str()
        _LOG.info("已从数据库恢复当日最近一帧行情（%d 个金种）供收盘后展示", len(snap["rows"]))
        return True

    def _collect_once(self, force: bool = False) -> bool:
        """执行一次采集并入库；受收盘闸门 / 退避 / 单飞 / 上游间隔保护。返回是否真的抓取。"""
        now = time.time()
        self._check_close()
        with self._lock:
            if self._closed:                    # 当日已收盘：不再抓取入库
                return False
            if now < self._next_fetch:          # 退避期，跳过
                return False
            if not force and now - self._last_fetch < self.upstream_interval:
                return False
            if self._inflight:                   # 单飞：已有采集在进行
                return False
            self._inflight = True
            prev = {r["code"]: r for r in (self._cache or {}).get("rows", [])}

        try:
            raw = self.client.fetch()
            quote = self._with_deltas(raw, prev)
            with self._lock:
                self._cache = quote
                self._last_fetch = time.time()
                self._last_collect_wall = time.time()
                self._consecutive_errors = 0
                self._seq += 1
            # 写库放到锁外，避免 MySQL 慢查询阻塞其它请求读取缓存
            self.store.append_quotes(_snapshot(quote))
            return True
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            _LOG.warning("抓取失败: %s", message)
            with self._lock:
                self._consecutive_errors += 1
                delay = BACKOFF_SECONDS[min(self._consecutive_errors - 1, len(BACKOFF_SECONDS) - 1)]
                self._next_fetch = time.time() + delay
            return False
        finally:
            with self._lock:
                self._inflight = False

    def _loop(self):
        """后台循环：到点采集，失败则按退避推迟下一次；到收盘点则退出。"""
        while not self._stop.is_set():
            self._check_close()
            with self._lock:
                if self._closed:            # 收盘：结束采集线程，进程仍存活供网页查询
                    break
                due = max(self._last_fetch + self.collect_interval, self._next_fetch)
                wait = max(due - time.time(), 0.1)
            if self._stop.wait(wait):
                break
            self._collect_once()

    def _compact_loop(self):
        """定时压缩线程：把过期明细聚合成日K线，控制库体积。"""
        while not self._stop.wait(self.compact_interval):
            self.compact_now()

    def compact_now(self) -> dict | None:
        """执行一次压缩（供定时线程与手动触发共用）。"""
        try:
            result = self.store.compact_raw(keep_days=self.keep_days)
            with self._lock:
                self._last_compact = time.time()
                self._last_compact_result = result
            if result.get("days"):
                _LOG.info("行情压缩完成：聚合 %d 天 / 日K %d 条 / 删除明细 %d 条",
                          result["days"], result["kline_written"], result["raw_deleted"])
            return result
        except Exception as exc:
            _LOG.warning("行情压缩失败: %s: %s", type(exc).__name__, exc)
            return None

    def start(self):
        """启动后台采集线程 + 立即采集一次（服务一跑起来就有数据）."""
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        # 如意金积存已完全停用：启动时清理历史库中残留的行情与金种资料
        purge = getattr(self.store, "purge_ruyi", None)
        if callable(purge):
            try:
                result = purge() or {}
                if result.get("quotes") or result.get("gold_types"):
                    _LOG.info("已清理如意金积存历史数据：行情 %d 条 / 金种 %d 条",
                              result.get("quotes", 0), result.get("gold_types", 0))
            except Exception as exc:
                _LOG.warning("如意金积存历史清理失败: %s: %s", type(exc).__name__, exc)
        self._collect_once(force=True)   # 首帧同步抓取（若已收盘则内部跳过），失败也不影响线程启动
        with self._lock:
            closed = self._closed
            cache_empty = self._cache is None
        # 收盘后启动 / 首帧抓取失败：从当天明细只读恢复最近一帧，避免页面空白。
        # 这不会抓取上游、不写库，仅填充内存缓存供展示。
        if cache_empty:
            self.restore_cache_from_db()
        # 已收盘时不启动采集线程，避免空转轮询；网页服务、历史查询不受影响。
        if closed:
            _LOG.info("当前已过收盘点，采集线程不启动；已展示当天最近行情，重启服务后恢复采集")
        else:
            self._thread = threading.Thread(target=self._loop, name="quote-collector", daemon=True)
            self._thread.start()
            _LOG.info("后台采集已启动：每 %.1f 秒记录一次行情", self.collect_interval)
        self.compact_now()               # 启动时先压缩一次，处理停机期间积压
        self._compact_thread = threading.Thread(target=self._compact_loop, name="quote-compactor", daemon=True)
        self._compact_thread.start()
        _LOG.info("行情压缩已启动：每 %.0f 秒检查一次，明细保留 %d 天",
                  self.compact_interval, self.keep_days)

    def stop(self):
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)
        if self._compact_thread and self._compact_thread.is_alive():
            self._compact_thread.join(timeout=3)

    # ---------- AI 每日分析 ----------
    def _analysis_until(self, day: str) -> str | None:
        """收盘后把当日明细定格到收盘点，与历史查询口径一致。"""
        if self._closed and self._close_hour is not None:
            return f"{day} {self._close_hour:02d}:{self._close_min or 0:02d}:00"
        return None

    def run_analysis(self, day: str | None = None, force: bool = True) -> dict:
        """同步执行一次当日分析并写 md（供手动接口 / 收盘触发共用）。"""
        day = day or datetime.now().strftime("%Y-%m-%d")
        result = ai_analyzer.analyze_day(
            self.store, day, cfg=self.ai_cfg, force=force,
            until=self._analysis_until(day),
        )
        self._last_analysis = {k: result.get(k) for k in
                               ("ok", "day", "path", "exists", "error")}
        if result.get("ok"):
            ai_status = (result.get("ai") or {}).get("status")
            _LOG.info("AI 分析完成 %s：%s（AI=%s）", day, result.get("path"), ai_status)
        else:
            _LOG.warning("AI 分析失败 %s：%s", day, result.get("error"))
        return result

    def _maybe_auto_analyze(self):
        """收盘闸门锁存时触发一次当日分析（后台线程，避免网络调用阻塞采集线程）。"""
        if not bool(self.ai_cfg.get("auto_on_close", True)):
            return
        with self._lock:
            if self._close_analysis_done:
                return
            self._close_analysis_done = True
        day = datetime.now().strftime("%Y-%m-%d")

        def _bg():
            try:
                # 收盘时先压缩一次，确保当天日K线已固化（开高低收更准确），再写分析。
                # 放到后台线程，避免 MySQL 压缩或 DeepSeek 网络调用阻塞采集线程。
                if callable(getattr(self.store, "compact_raw", None)):
                    self.compact_now()
                self.run_analysis(day, force=True)
            except Exception as exc:  # 兜底：任何异常都不影响主服务
                _LOG.warning("收盘自动分析异常: %s: %s", type(exc).__name__, exc)

        threading.Thread(target=_bg, name="close-ai-analysis", daemon=True).start()
        _LOG.info("已排入收盘后当日 AI 分析任务：%s", day)

    def get(self, force: bool = False) -> dict:
        """读取当前缓存；force 触发一次立即采集（仍受退避保护）。"""
        if force:
            self._collect_once(force=True)
        return self._stale()

    def status(self) -> dict:
        with self._lock:
            return {
                "ok": True,
                "time": now_str(),
                "history_count": self.store.count_quotes(),
                "last_fetch": self._cache["fetched_at"] if self._cache else None,
                "latency_ms": self._cache.get("latency_ms") if self._cache else None,
                "consecutive_errors": self._consecutive_errors,
                "next_fetch_in": max(0, round(self._next_fetch - time.time(), 1)),
                "upstream_interval": self.upstream_interval,
                "collect_interval": self.collect_interval,
                "collector_alive": bool(self._thread and self._thread.is_alive()),
                "compactor_alive": bool(self._compact_thread and self._compact_thread.is_alive()),
                "compact_interval": self.compact_interval,
                "keep_days": self.keep_days,
                "last_compact": self._last_compact_result,
                "seq": self._seq,
                "market_closed": self._closed,
                "closed_at": self._closed_at,
                "close_at": self.close_at,
            }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive：4 秒轮询不必反复握手
    server_version = "GoldTracker/3.0"

    service: QuoteService
    db: MySQLStore
    static: dict

    def log_message(self, fmt, *args):
        _LOG.info("%s - %s", self.address_string(), fmt % args)

    def _send(self, status: int, body, content_type: str, extra: dict | None = None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; connect-src 'self'; img-src 'self' data:; "
                         "style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, status: int = 200, extra: dict | None = None):
        self._send(status, json.dumps(obj, ensure_ascii=False, separators=(",", ":")),
                   "application/json; charset=utf-8", extra)

    # ---------- 鉴权 ----------
    def _current_user(self):
        token = token_from_cookie_header(self.headers.get("Cookie"))
        uid = parse_session(token) if token else None
        if uid is None:
            return None
        try:
            return self.db.get_user_by_id(uid)
        except Exception as exc:
            _LOG.warning("会话查询失败: %s", exc)
            return None

    def _require_auth(self):
        user = self._current_user()
        if user is None:
            self._json({"ok": False, "auth_required": True, "error": "请先登录"}, 401)
            return None
        return user

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except (TypeError, ValueError):
            length = 0
        if length <= 0 or length > 2 * 1024 * 1024:
            raise ValueError("invalid body size")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        return payload

    # ---------- GET ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path in self.static:
            body, content_type = self.static[path]
            self._send(200, body, content_type)
            return

        # 登录状态（免鉴权，前端据此决定是否弹登录框）
        if path == "/api/auth/status":
            user = self._current_user()
            self._json({
                "ok": True,
                "authenticated": user is not None,
                "need_setup": self.db.count_users() == 0,
                "user": ({"id": user["id"], "username": user["username"], "role": user["role"]}
                         if user else None),
            })
            return

        if path in ("/api/status", "/api/health"):
            self._json(self.service.status())
            return

        # 以下均需登录
        if self._require_auth() is None:
            return

        # 大盘云图外部图片代理（新浪日K / 东财走势图）：同源转发，规避 CSP 与网络限制
        if path == "/api/marketmap/img":
            kind = (query.get("kind", [""])[0] or "").lower()
            code = query.get("code", [""])[0] or ""
            import re as _re
            if kind not in ("kline", "spark") or not _re.fullmatch(r"[0-9A-Za-z]{1,10}\.(SH|SZ|BJ|HK)", code, _re.I):
                self._send(400, b"bad params", "text/plain; charset=utf-8")
                return
            data, ctype, err = market_map.get_image(kind, code)
            if data is None:
                self._send(502, ("image unavailable: " + err).encode("utf-8", "replace"), "text/plain; charset=utf-8")
                return
            extra = {"Cache-Control": "public, max-age=21600"}
            self._send(200, data, ctype, extra)
            return

        if path == "/api/quote":
            self._json(self.service.get(force="1" in query.get("force", ["0"])))
            return

        if path == "/api/history":
            code = query.get("code", [None])[0]
            try:
                limit = max(1, min(int(query.get("limit", [500])[0]), MAX_HISTORY))
            except ValueError:
                limit = 500
            gran_raw = query.get("gran", ["0"])[0]
            try:
                gran = 1 if int(gran_raw) == 1 else 0
            except ValueError:
                gran = 0
            since = query.get("since", [None])[0]
            # 收盘后明细定格到收盘点：不展示收盘闸门之后多采的尾巴，
            # 与主行情卡片「收盘时数据」保持一致。日K线(gran=1)本来每天一条，不截断。
            until = None
            if gran == 0 and self.service._closed and self.service._close_hour is not None:
                today = datetime.now().strftime("%Y-%m-%d")
                until = f"{today} {self.service._close_hour:02d}:{self.service._close_min or 0:02d}:00"
            items = self.db.recent_quotes(code, limit, gran=gran, since=since, until=until)
            self._json({
                "count": self.db.count_quotes(gran=gran),
                "gran": gran,
                "items": items,
            })
            return

        if path == "/api/export.csv":
            self._send(200, self.db.csv_text(), "text/csv; charset=utf-8",
                       {"Content-Disposition": 'attachment; filename="gold_history.csv"'})
            return

        if path == "/api/portfolio":
            from portfolio_store import DEFAULT_DATA
            self._json({"ok": True, **self.db.load_portfolio(DEFAULT_DATA)})
            return

        if path == "/api/gold-types":
            self._json({"ok": True, "items": self.db.list_gold_types()})
            return

        # 大盘云图
        if path == "/api/marketmap/markets":
            period = query.get("period", ["day"])[0]
            self._json({"ok": True, "items": market_map.list_markets(period=period),
                        "periods": market_map.list_periods()})
            return

        if path == "/api/marketmap/data":
            market = query.get("market", ["all"])[0]
            period = query.get("period", ["day"])[0]
            force = "1" in query.get("force", ["0"])
            # 秒级刷新：ttl 默认 4 秒，下限 4 秒（避免 4-10 秒轮询把上游接口打爆），
            # 上限 1 天。force=1（手动刷新）时忽略 ttl，强制抓上游。
            try:
                ttl = int(query.get("ttl", ["4"])[0])
            except (TypeError, ValueError):
                ttl = 4
            ttl = max(4, min(86400, ttl))
            result = market_map.get_market(market, period=period, force=force, ttl=ttl)
            if not result.get("ok"):
                self._json({"ok": False, "error": result.get("error", "数据获取失败")}, 400)
                return
            self._json(result)
            return

        if path == "/api/marketmap/overview":
            period = query.get("period", ["day"])[0]
            force = "1" in query.get("force", ["0"])
            result = market_map.get_overview(period=period, force=force)
            if not result.get("ok"):
                self._json({"ok": False, "error": result.get("error", "总览获取失败")}, 400)
                return
            self._json(result)
            return

        if path == "/api/marketmap/search":
            q = query.get("q", [""])[0]
            self._json(market_map.search(q))
            return

        # 盘面分析：板块涨跌 与 黄金涨跌 的相关性
        if path == "/api/corr/options":
            self._json(sector_corr.options())
            return

        if path == "/api/corr/result":
            bench = query.get("bench", [sector_corr.DEFAULT_BENCH])[0]
            try:
                window = int(query.get("window", [str(sector_corr.DEFAULT_WINDOW)])[0])
            except (TypeError, ValueError):
                window = sector_corr.DEFAULT_WINDOW
            force = "1" in query.get("force", ["0"])
            try:
                payload = sector_corr.analyze(bench, window, force=force)
            except Exception as exc:
                _LOG.warning("盘面分析失败: %s: %s", type(exc).__name__, exc)
                self._json({"ok": False, "error": "分析失败：%s" % exc}, 500)
                return
            if not payload.get("ok"):
                self._json(payload, 400)
                return
            # 摘要接口不返回大数组，首屏更轻；序列走 /api/corr/detail
            self._json(sector_corr.summary(payload))
            return

        if path == "/api/corr/detail":
            bench = query.get("bench", [sector_corr.DEFAULT_BENCH])[0]
            sector = query.get("sector", [""])[0]
            try:
                window = int(query.get("window", [str(sector_corr.DEFAULT_WINDOW)])[0])
            except (TypeError, ValueError):
                window = sector_corr.DEFAULT_WINDOW
            payload = sector_corr.detail(bench, window, sector)
            self._json(payload, 200 if payload.get("ok") else 404)
            return

        # AI 每日分析
        if path == "/api/analysis/config":
            cfg = self.service.ai_cfg
            self._json({
                "ok": True,
                "configured": ai_analyzer.is_configured(cfg),
                "model": cfg.get("model"),
                "auto_on_close": bool(cfg.get("auto_on_close", True)),
                "report_dir": os.path.basename(ai_analyzer.report_dir(cfg)),
                "last": self.service._last_analysis,
            })
            return

        if path == "/api/analysis/reports":
            self._json({"ok": True, "items": ai_analyzer.list_reports(self.service.ai_cfg)})
            return

        if path == "/api/analysis/report":
            day = query.get("date", [None])[0]
            content = ai_analyzer.read_report(day, self.service.ai_cfg) if day else None
            if content is None:
                self._json({"ok": False, "error": "报告不存在"}, 404)
                return
            self._send(200, content, "text/markdown; charset=utf-8")
            return

        self._send(404, "Not Found", "text/plain; charset=utf-8")

    # ---------- POST ----------
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 注册：首个用户自动成为管理员；之后仅管理员可创建账号
        if path == "/api/auth/register":
            try:
                payload = self._read_json_body()
            except (ValueError, UnicodeDecodeError) as exc:
                self._json({"ok": False, "error": str(exc)}, 400)
                return
            username = str(payload.get("username", "")).strip()
            password = str(payload.get("password", ""))
            if len(username) < 2 or len(username) > 32 or len(password) < 6:
                self._json({"ok": False, "error": "用户名至少 2 字、密码至少 6 位"}, 400)
                return
            try:
                is_first = self.db.count_users() == 0
                if not is_first:
                    actor = self._current_user()
                    if actor is None:
                        self._json({"ok": False, "auth_required": True, "error": "请先登录"}, 401)
                        return
                    if actor["role"] != "admin":
                        self._json({"ok": False, "error": "仅管理员可添加账号"}, 403)
                        return
                if self.db.get_user_by_name(username):
                    self._json({"ok": False, "error": "用户名已存在"}, 400)
                    return
                user = self.db.create_user(username, hash_password(password),
                                           "admin" if is_first else "user")
            except Exception as exc:
                _LOG.warning("注册失败: %s", exc)
                self._json({"ok": False, "error": str(exc)}, 400)
                return
            token = make_session(user["id"])
            self._json({"ok": True, "user": {"id": user["id"], "username": username,
                                             "role": user["role"]}},
                       extra={"Set-Cookie": cookie_header(token)})
            return

        if path == "/api/auth/login":
            try:
                payload = self._read_json_body()
            except (ValueError, UnicodeDecodeError) as exc:
                self._json({"ok": False, "error": str(exc)}, 400)
                return
            username = str(payload.get("username", "")).strip()
            password = str(payload.get("password", ""))
            user = self.db.get_user_by_name(username)
            if not user or not verify_password(password, user["password_hash"]):
                self._json({"ok": False, "error": "用户名或密码错误"}, 401)
                return
            self.db.touch_login(user["id"])
            token = make_session(user["id"])
            self._json({"ok": True, "user": {"id": user["id"], "username": username,
                                             "role": user["role"]}},
                       extra={"Set-Cookie": cookie_header(token)})
            return

        if path == "/api/auth/logout":
            self._json({"ok": True}, extra={"Set-Cookie": clear_cookie_header()})
            return

        if self._require_auth() is None:
            return

        if path == "/api/portfolio":
            try:
                payload = self._read_json_body()
                saved = self.db.save_portfolio(payload)
            except (ValueError, UnicodeDecodeError, Exception) as exc:
                _LOG.warning("保存个人数据失败: %s", exc)
                self._json({"ok": False, "error": str(exc)}, 400)
                return
            from portfolio_store import DEFAULT_DATA
            self._json({"ok": True, **DEFAULT_DATA, **saved})
            return

        if path == "/api/gold-types":
            try:
                payload = self._read_json_body()
                code = str(payload.get("code", ""))
                if not code:
                    raise ValueError("缺少 code")
                updated = self.db.update_gold_type(code, payload)
            except (ValueError, UnicodeDecodeError, Exception) as exc:
                _LOG.warning("更新金种资料失败: %s", exc)
                self._json({"ok": False, "error": str(exc)}, 400)
                return
            self._json({"ok": True, "item": updated})
            return

        if path == "/api/analysis/generate":
            try:
                payload = self._read_json_body()
            except (ValueError, UnicodeDecodeError):
                payload = {}
            day = payload.get("date") or None
            force = bool(payload.get("force", True))
            result = self.service.run_analysis(day=day, force=force)
            if not result.get("ok"):
                self._json({"ok": False, "error": result.get("error", "生成失败")}, 400)
                return
            # 不把完整 features 回传（体积大），前端拿日期去 /report 读取 md
            self._json({
                "ok": True, "day": result.get("day"), "path": result.get("path"),
                "exists": result.get("exists", False),
                "ai_status": (result.get("ai") or {}).get("status", "skipped"),
                "configured": ai_analyzer.is_configured(self.service.ai_cfg),
            })
            return

        if path == "/api/corr/refresh":
            try:
                payload = self._read_json_body()
            except (ValueError, UnicodeDecodeError):
                payload = {}
            bench = payload.get("bench") or sector_corr.DEFAULT_BENCH
            try:
                window = int(payload.get("window") or sector_corr.DEFAULT_WINDOW)
            except (TypeError, ValueError):
                window = sector_corr.DEFAULT_WINDOW
            try:
                result = sector_corr.analyze(bench, window, force=True)
            except Exception as exc:
                _LOG.warning("盘面分析刷新失败: %s: %s", type(exc).__name__, exc)
                self._json({"ok": False, "error": "刷新失败：%s" % exc}, 500)
                return
            if not result.get("ok"):
                self._json(result, 400)
                return
            self._json(sector_corr.summary(result))
            return

        self._send(404, "Not Found", "text/plain; charset=utf-8")


def load_static() -> dict:
    files = {
        "/": ("index.html", "text/html; charset=utf-8"),
        "/app.js": ("assets/app.js", "application/javascript; charset=utf-8"),
        "/portfolio.js": ("assets/portfolio.js", "application/javascript; charset=utf-8"),
        "/marketmap.js": ("assets/marketmap.js", "application/javascript; charset=utf-8"),
        "/corr.js": ("assets/corr.js", "application/javascript; charset=utf-8"),
        "/style.css": ("assets/style.css", "text/css; charset=utf-8"),
    }
    result = {}
    for route, (name, content_type) in files.items():
        path = os.path.join(BASE_DIR, name)
        with open(path, "rb") as f:
            result[route] = (f.read(), content_type)
    return result


def main():
    parser = argparse.ArgumentParser(description="工行积存金实盘跟踪（MySQL 版）")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--upstream-interval", type=float, default=DEFAULT_UPSTREAM_INTERVAL,
                        help="抓取工行站点的最短间隔（秒），默认 2 秒")
    parser.add_argument("--collect-interval", type=float, default=4.0,
                        help="后台自动记录行情的间隔（秒），默认 4 秒；与网页是否打开无关")
    parser.add_argument("--compact-interval", type=float, default=600.0,
                        help="压缩明细为日K线的检查周期（秒），默认 600 秒")
    parser.add_argument("--keep-days", type=int, default=2,
                        help="原始明细保留天数（含今天），默认 2 天；更早的聚合成日K线")
    parser.add_argument("--close-at", default=DEFAULT_CLOSE_AT,
                        help="每日收盘停止采集的本地时间 HH:MM，默认 22:30；off 表示不启用。"
                             "到点后网页服务保留、次日重启服务恢复采集")
    parser.add_argument("--db-config", default=None, help="MySQL 连接配置文件路径")
    parser.add_argument("--analyze", nargs="?", const="", default=None, metavar="YYYY-MM-DD",
                        help="只执行一次指定日期的 AI 行情分析（默认今天）并写入 md，随后退出；不启动网页服务")
    parser.add_argument("--no-auto-analysis", action="store_true",
                        help="关闭收盘后自动生成当日分析（仍可在网页手动生成）")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config()
    if args.db_config:
        with open(args.db_config, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))

    try:
        store = MySQLStore(cfg, max_items=MAX_HISTORY)
    except Exception as exc:
        print(f"[启动失败] 无法连接 MySQL：{exc}", flush=True)
        print(f"请确认 MySQL 已启动，且 {cfg['user']}@{cfg['host']} 的密码正确（配置见 db_config.json）", flush=True)
        raise SystemExit(1)

    service = QuoteService(store, upstream_interval=args.upstream_interval,
                           collect_interval=args.collect_interval,
                           compact_interval=args.compact_interval,
                           keep_days=args.keep_days,
                           close_at=args.close_at)
    if args.no_auto_analysis:
        service.ai_cfg["auto_on_close"] = False

    # 命令行单次分析模式：--analyze [YYYY-MM-DD]，不启动后台采集与网页
    if args.analyze is not None:
        day = args.analyze.strip() or datetime.now().strftime("%Y-%m-%d")
        result = service.run_analysis(day=day, force=True)
        if result.get("ok"):
            print(f"[分析完成] {result['day']} → {result['path']}", flush=True)
            ai_status = (result.get("ai") or {}).get("status")
            if ai_status == "no_key":
                print("[提示] 未配置 DeepSeek API Key：特征已记录，AI 点评已跳过（见 ai_config.json）", flush=True)
            elif ai_status == "error":
                print(f"[提示] AI 点评失败：{(result.get('ai') or {}).get('error')}", flush=True)
        else:
            print(f"[分析失败] {result.get('error')}", flush=True)
            raise SystemExit(1)
        return

    Handler.service = service
    Handler.db = store
    Handler.static = load_static()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"工行积存金实盘跟踪: http://127.0.0.1:{args.port}", flush=True)
    print(f"存储: MySQL {cfg['host']}:{cfg['port']}/{cfg['database']} / "
          f"个人数据加密存储 / 行情明文", flush=True)
    print(f"后台采集: 每 {service.collect_interval:.1f} 秒自动记录一次，网页关闭也持续运行；按 Ctrl+C 停止", flush=True)
    print("采集范围: 仅官网表格行情（如意金积存已停用，不再抓取/入库）", flush=True)
    if service._close_hour is not None:
        print(f"收盘闸门: 每日 {service._close_hour:02d}:{service._close_min:02d} 停止采集，"
              f"网页保留，次日重启服务恢复（--close-at 可改，off 关闭）", flush=True)
    print(f"分层保留: 明细保留 {service.keep_days} 天，更早聚合成日K线；每 {service.compact_interval:.0f} 秒压缩一次", flush=True)
    _ai_on = ai_analyzer.is_configured(service.ai_cfg)
    print(f"AI 分析: DeepSeek {'已配置' if _ai_on else '未配置 Key（仍记录特征，AI 点评跳过）'} / "
          f"模型 {service.ai_cfg.get('model')} / 收盘自动生成"
          f"{'开' if service.ai_cfg.get('auto_on_close') else '关'} / 报告目录 「{os.path.basename(ai_analyzer.report_dir(service.ai_cfg))}」", flush=True)
    if store.count_users() == 0:
        print("首次运行：请在页面注册管理员账号", flush=True)

    # 大盘云图：后台预热 6 市场 × 4 周期缓存（骨架按市场共享），不阻塞启动，失败时保留旧缓存
    def _prefetch_markets():
        try:
            result = market_map.prefetch_all()
            _LOG.info("大盘云图缓存预热完成：%s", ", ".join(
                f"{k}={'OK' if v else 'FAIL'}" for k, v in result.items()))
        except Exception as exc:
            _LOG.warning("大盘云图缓存预热异常: %s: %s", type(exc).__name__, exc)

    threading.Thread(target=_prefetch_markets, name="marketmap-prefetch", daemon=True).start()

    # 盘面分析：后台预热黄金相关性结果（依赖云图板块缓存，稍晚启动）
    def _prefetch_corr():
        try:
            time.sleep(5)
            for win in (250, 120, 60):
                sector_corr.analyze(sector_corr.DEFAULT_BENCH, win)
            _LOG.info("盘面分析相关性缓存预热完成")
        except Exception as exc:
            _LOG.warning("盘面分析预热异常: %s: %s", type(exc).__name__, exc)

    threading.Thread(target=_prefetch_corr, name="corr-prefetch", daemon=True).start()

    service.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()
        server.server_close()


if __name__ == "__main__":
    main()
