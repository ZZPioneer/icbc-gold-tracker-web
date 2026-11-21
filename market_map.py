# -*- coding: utf-8 -*-
"""大盘云图数据层：抓取原站 6 个市场 × 4 个周期的云图数据，本地缓存后供网页读取。

数据源（与原站网页一致，三源合并）：
  - treemap: ``/api/heatmap/treemap?market=<key>&period=<p>`` 提供板块/个股骨架、市值面积。
    该接口的价格/涨跌是旧快照，且骨架（结构/面积）经实测与周期无关，故按 market 长缓存共享。
  - quotes : ``/api/heatmap/quotes?market=<key>&period=<p>`` 提供个股最新价、涨跌幅、成交额。
  - summary: ``/api/heatmap/summary?market=<key>&period=<p>`` 提供涨跌家数、成交额、指数涨跌。
  合并规则：treemap 做骨架，用 quotes 按 code 覆盖 price/changePct/turnoverAmount，
  用 summary 覆盖顶层 summary；任一源失败则保留该部分原值并降级，不中断。

另外提供：
  - overview: ``/api/heatmap/overview?period=<p>`` 市场总览（各指数涨跌，供左侧概览栏）。
  - search   : ``/api/heatmap/search?q=<词>`` 股票搜索（供搜索定位）。

缓存：
  - 骨架 ``marketmap-cache/<key>.skeleton.json``（30 分钟 TTL，周期共享，已验证与周期无关）。
  - 合并结果 ``marketmap-cache/<key>.<period>.json``（day 兼容旧名 ``<key>.json``）。
  - overview ``marketmap-cache/overview.<period>.json``。
  - 抓不到时用旧缓存兜底并标 stale。前端只访问本地服务，不跨域直连原站。

市场键：all=A股全图  bj=北交所  etf=ETF  cb=可转债  hk=港股  us=美股
周期键：day=今日  week=近5日  month=近20日  year=今年以来
"""
from __future__ import annotations

import copy
import json
import os
import threading
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, "marketmap-cache")
UPSTREAM_BASE = "https://dapanyuntu.com/api/heatmap"
TREEMAP_URL = UPSTREAM_BASE + "/treemap?market={market}&period={period}"
QUOTE_URL = UPSTREAM_BASE + "/quotes?market={market}&period={period}"
SUMMARY_URL = UPSTREAM_BASE + "/summary?market={market}&period={period}"
OVERVIEW_URL = UPSTREAM_BASE + "/overview?period={period}"
SEARCH_URL = UPSTREAM_BASE + "/search?q={q}"
DEFAULT_TTL = 15 * 60  # 秒
SKELETON_TTL = 30 * 60  # 骨架缓存（周期共享）
OVERVIEW_TTL = 10 * 60  # 总览缓存

# 有序市场表（前端侧边栏按此顺序渲染）；scale 为 day 周期色阶量程
MARKETS = [
    {"key": "all", "name": "A股全图", "short": "股票", "unit": "元", "scale": 10.0},
    {"key": "bj",  "name": "北交所", "short": "北交所", "unit": "元", "scale": 10.0},
    {"key": "etf", "name": "ETF 全市场", "short": "ETF", "unit": "元", "scale": 5.0},
    {"key": "cb",  "name": "可转债全市场", "short": "可转债", "unit": "元", "scale": 5.0},
    {"key": "hk",  "name": "港股全市场", "short": "港股", "unit": "港元", "scale": 12.0},
    {"key": "us",  "name": "美股全市场", "short": "美股", "unit": "美元", "scale": 8.0},
]
MARKET_KEYS = {m["key"] for m in MARKETS}
_META = {m["key"]: m for m in MARKETS}

# 周期表：day 用固定量程，其余用数据分位数自适应（前端处理）
PERIODS = [
    {"key": "day", "name": "今日", "short": "日"},
    {"key": "week", "name": "近5日", "short": "周"},
    {"key": "month", "name": "近20日", "short": "月"},
    {"key": "year", "name": "今年以来", "short": "年"},
]
PERIOD_KEYS = {p["key"] for p in PERIODS}
DEFAULT_PERIOD = "day"

_lock = threading.RLock()


def _valid_market(market: str) -> bool:
    return market in MARKET_KEYS


def _valid_period(period: str) -> bool:
    return period in PERIOD_KEYS


def _norm_period(period: str | None) -> str:
    return period if period in PERIOD_KEYS else DEFAULT_PERIOD


def ensure_cache_dir() -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)


def _cache_path(market: str, period: str = DEFAULT_PERIOD) -> str:
    # day 沿用旧文件名，兼容已 seed 的缓存
    name = market if period == DEFAULT_PERIOD else (market + "." + period)
    return os.path.join(CACHE_DIR, name + ".json")


def _skeleton_path(market: str) -> str:
    return os.path.join(CACHE_DIR, market + ".skeleton.json")


def _overview_path(period: str) -> str:
    return os.path.join(CACHE_DIR, "overview." + period + ".json")


def _load_json_file(path: str) -> tuple[dict | None, float | None]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        age = max(0.0, datetime.now().timestamp() - os.path.getmtime(path))
        return (data if isinstance(data, dict) else None), age
    except (OSError, ValueError):
        return None, None


def _save_json_file(path: str, data: dict) -> None:
    ensure_cache_dir()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _load_skeleton(market: str) -> tuple[dict | None, float | None]:
    data, age = _load_json_file(_skeleton_path(market))
    if not (data and data.get("market") and isinstance(data.get("nodes"), list)):
        return None, None
    return data, age


def _save_skeleton(market: str, tree: dict) -> None:
    _save_json_file(_skeleton_path(market), tree)


def _load_cache(market: str, period: str = DEFAULT_PERIOD) -> dict | None:
    data, _ = _load_json_file(_cache_path(market, period))
    return data if (data and data.get("market")) else None


def _save_cache(market: str, period: str, data: dict) -> None:
    _save_json_file(_cache_path(market, period), data)


def _age_of(path: str) -> float | None:
    try:
        return max(0.0, datetime.now().timestamp() - os.path.getmtime(path))
    except OSError:
        return None


def _get_json(url: str, timeout: float) -> dict:
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; GoldTrackerMarketMap/1.0)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _fetch_remote(market: str, period: str = DEFAULT_PERIOD,
                  timeout: float = 15.0) -> dict:
    """抓取并合并三源数据，对齐原站网页的展示口径。

    骨架按 market 缓存（已验证与周期无关，30 分钟复用），每次只抓轻量的
    quotes+summary（带 period），因此秒级刷新不会被 1.2MB 骨架拖慢。
    """
    period = _norm_period(period)

    def safe_get(url):
        try:
            return _get_json(url, timeout)
        except Exception:
            return None

    # 1) 骨架：命中缓存则复用，否则下载
    skeleton, sk_age = _load_skeleton(market)
    need_tree = skeleton is None or sk_age is None or sk_age >= SKELETON_TTL
    q = s = tree = None
    with ThreadPoolExecutor(max_workers=3) as pool:
        tree_fut = pool.submit(safe_get, TREEMAP_URL.format(market=market, period=period)) if need_tree else None
        q_fut = pool.submit(safe_get, QUOTE_URL.format(market=market, period=period))
        s_fut = pool.submit(safe_get, SUMMARY_URL.format(market=market, period=period))
        if tree_fut:
            tree = tree_fut.result()
        q = q_fut.result()
        s = s_fut.result()

    if need_tree:
        if not isinstance(tree, dict) or not tree.get("market") or not isinstance(tree.get("nodes"), list):
            raise ValueError("上游 treemap 数据格式异常")
        skeleton = tree
        _save_skeleton(market, copy.deepcopy(tree))  # 存原始骨架，避免被行情覆盖
    tree = copy.deepcopy(skeleton)  # 用副本合并，不污染骨架缓存
    tree["period"] = period

    merged_at = [tree["updatedAt"]] if tree.get("updatedAt") else []

    # 2) quotes 覆盖个股最新价/涨跌幅/成交额
    quote_ok = False
    quotes = q.get("quotes") if isinstance(q, dict) else None
    if isinstance(quotes, dict) and quotes:
        count = 0
        for board in tree.get("nodes", []):
            for child in board.get("children", []):
                qt = quotes.get(child.get("code"))
                if not isinstance(qt, dict):
                    continue
                if qt.get("price") is not None:
                    child["price"] = qt["price"]
                if qt.get("changePct") is not None:
                    child["changePct"] = qt["changePct"]
                if qt.get("turnoverAmount") is not None:
                    child["turnoverAmount"] = qt["turnoverAmount"]
                count += 1
        quote_ok = count > 0
    if isinstance(q, dict) and q.get("updatedAt"):
        merged_at.append(q["updatedAt"])

    # 3) summary 覆盖顶层统计
    summary_ok = False
    sm = s.get("summary") if isinstance(s, dict) else None
    if isinstance(sm, dict) and sm:
        tree["summary"] = sm
        summary_ok = True
    if isinstance(s, dict) and s.get("updatedAt"):
        merged_at.append(s["updatedAt"])

    # 数据时间取各源中最新的（ISO 字符串按字典序即为时间序，同一时区 +08:00）
    if merged_at:
        tree["updatedAt"] = max(merged_at)
    tree["_merge"] = {"quotes": quote_ok, "summary": summary_ok}
    return tree


def get_market(market: str, period: str = DEFAULT_PERIOD, force: bool = False,
               ttl: int = DEFAULT_TTL, timeout: float = 15.0) -> dict:
    """取得某市场某周期云图数据。

    返回 {ok, market, period, name, ... , data, cached, stale, age, error}。
    """
    if not _valid_market(market):
        return {"ok": False, "market": market, "error": "未知市场"}
    period = _norm_period(period)
    try:
        ttl = max(0, int(ttl))
    except (TypeError, ValueError):
        ttl = DEFAULT_TTL

    with _lock:
        cached = _load_cache(market, period)
        age = _age_of(_cache_path(market, period)) if cached else None
        fresh = cached is not None and age is not None and age < ttl

        if fresh and not force:
            return _wrap(cached, cached=True, stale=False, age=age)

        try:
            data = _fetch_remote(market, period=period, timeout=timeout)
            _save_cache(market, period, data)
            return _wrap(data, cached=False, stale=False, age=0.0)
        except Exception as exc:
            if cached is not None:
                return _wrap(cached, cached=True, stale=True, age=age,
                             error=f"{type(exc).__name__}: {exc}")
            return {"ok": False, "market": market, "period": period,
                    "error": f"{type(exc).__name__}: {exc}"}


def _wrap(data: dict, cached: bool, stale: bool, age: float | None, error: str = "") -> dict:
    key = data.get("market")
    meta = _META.get(key, {})
    return {
        "ok": True,
        "market": key,
        "period": data.get("period", DEFAULT_PERIOD),
        "name": meta.get("name", key),
        "short": meta.get("short", key),
        "unit": meta.get("unit", "元"),
        "scale": meta.get("scale", 10.0),
        "cached": cached,
        "stale": stale,
        "age": round(age, 1) if age is not None else None,
        "error": error,
        "data": data,
    }


def list_markets(period: str = DEFAULT_PERIOD, include_stats: bool = True) -> list[dict]:
    """列出全部市场的元信息 + 指定周期本地缓存里的统计摘要。"""
    period = _norm_period(period)
    out = []
    for m in MARKETS:
        item = dict(m)
        cached = _load_cache(m["key"], period)
        if cached:
            item["hasData"] = True
            item["updatedAt"] = cached.get("updatedAt")
            item["stockCount"] = cached.get("stockCount")
            item["boardCount"] = cached.get("boardCount")
            if include_stats:
                item["summary"] = cached.get("summary")
        else:
            item["hasData"] = False
        out.append(item)
    return out


def list_periods() -> list[dict]:
    return [dict(p) for p in PERIODS]


# ---------- 市场总览（左侧概览栏） ----------
def get_overview(period: str = DEFAULT_PERIOD, force: bool = False,
                 timeout: float = 15.0) -> dict:
    """取得市场总览（各指数涨跌）。返回 {ok, period, data, cached, stale, age, error}。"""
    period = _norm_period(period)
    path = _overview_path(period)
    with _lock:
        cached, age = _load_json_file(path)
        if cached and not force and age is not None and age < OVERVIEW_TTL:
            return {"ok": True, "period": period, "data": cached,
                    "cached": True, "stale": False, "age": round(age, 1), "error": ""}
        try:
            data = _get_json(OVERVIEW_URL.format(period=period), timeout)
            if not isinstance(data, dict) or not isinstance(data.get("markets"), list):
                raise ValueError("上游 overview 数据格式异常")
            _save_json_file(path, data)
            return {"ok": True, "period": period, "data": data,
                    "cached": False, "stale": False, "age": 0.0, "error": ""}
        except Exception as exc:
            if cached:
                return {"ok": True, "period": period, "data": cached,
                        "cached": True, "stale": True, "age": round(age or 0, 1),
                        "error": f"{type(exc).__name__}: {exc}"}
            return {"ok": False, "period": period, "error": f"{type(exc).__name__}: {exc}"}


# ---------- 搜索 ----------
def search(q: str, timeout: float = 10.0) -> dict:
    """股票搜索，返回原站 search 接口结果 {ok, query, items}。"""
    q = (q or "").strip()
    if not q:
        return {"ok": True, "query": q, "items": []}
    url = SEARCH_URL.format(q=urllib.parse.quote(q))
    try:
        data = _get_json(url, timeout)
        items = data.get("items", []) if isinstance(data, dict) else []
        return {"ok": True, "query": q, "items": items[:20]}
    except Exception as exc:
        return {"ok": False, "query": q, "items": [], "error": f"{type(exc).__name__}: {exc}"}


def prefetch_all(periods: list[str] | None = None, timeout: float = 15.0,
                 max_workers: int = 6) -> dict[str, bool]:
    """后台预热：把 6 个市场 × 指定周期都抓一遍（已有新鲜缓存则跳过）。

    全周期预取：默认取全部 4 个周期。用线程池并发但限制并发数，避免打爆上游。
    """
    periods = [_norm_period(p) for p in (periods or [p["key"] for p in PERIODS])]
    combos = [(m["key"], p) for m in MARKETS for p in periods]
    result: dict[str, bool] = {}

    def work(market, period):
        r = get_market(market, period=period, timeout=timeout)
        return (market + "." + period), bool(r.get("ok"))

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futs = [pool.submit(work, mk, p) for mk, p in combos]
        for f in as_completed(futs):
            try:
                k, ok = f.result()
                result[k] = ok
            except Exception:
                pass
    # 总览一并预热（各周期）
    for p in periods:
        try:
            result["overview." + p] = bool(get_overview(p, timeout=timeout).get("ok"))
        except Exception:
            result["overview." + p] = False
    _ = _lock  # 保持锁对象被引用（预热期间 get_* 内部已加锁）
    return result


# ---------- 外部图片代理（K线大图 / 迷你走势图） ----------
# 原站图片直连新浪 image.sinajs.cn 与东财 webquotepic.eastmoney.com。
# 浏览器直连可能受网络/DNS/跨域限制，改由本地服务端抓取并转发，前端同源访问更稳。
IMG_CACHE_DIR = os.path.join(BASE_DIR, "marketmap-cache", "img")
IMG_TTL = 6 * 3600  # 图片缓存 6 小时（日K/走势日内也会变，缓存不宜过长）
_IMG_LOCK = threading.RLock()
_IMG_CACHE: dict[str, tuple[bytes, str, float]] = {}  # key -> (bytes, content_type, ts)


def _split_code(code: str) -> tuple[str, str]:
    parts = str(code or "").split(".")
    return (parts[0] or "", (parts[1] or "SH").upper())


def image_url(kind: str, code: str) -> tuple[str, str]:
    """按原站规则拼出外部图片 URL。kind=kline(日K) / spark(迷你走势)。"""
    sym, mkt = _split_code(code)
    if not sym:
        return "", "image/gif"
    if kind == "kline":
        if mkt == "HK":
            return "https://webquotepic.eastmoney.com/GetPic.aspx?nid=116.%s&imageType=KXL" % sym, "image/png"
        pre = "sh" if mkt == "SH" else ("bj" if mkt == "BJ" else "sz")
        return "https://image.sinajs.cn/newchart/daily/n/%s%s.gif" % (pre, sym), "image/gif"
    # spark
    pre = "1" if mkt == "SH" else ("116" if mkt == "HK" else "0")
    return "https://webquotepic.eastmoney.com/GetPic.aspx?nid=%s.%s&imageType=RJY" % (pre, sym), "image/png"


def get_image(kind: str, code: str, timeout: float = 12.0) -> tuple[bytes | None, str, str]:
    """抓取外部图片。返回 (bytes, content_type, error)。带内存+磁盘双层缓存。"""
    url, ctype = image_url(kind, code)
    if not url:
        return None, ctype, "空代码"
    key = kind + "." + code
    now = datetime.now().timestamp()
    with _IMG_LOCK:
        hit = _IMG_CACHE.get(key)
        if hit and now - hit[2] < IMG_TTL:
            return hit[0], hit[1], ""
        # 磁盘缓存兜底
        path = os.path.join(IMG_CACHE_DIR, key.replace("/", "_") + (".gif" if ctype == "image/gif" else ".png"))
        try:
            with open(path, "rb") as f:
                data = f.read()
            if data:
                _IMG_CACHE[key] = (data, ctype, now)
                return data, ctype, ""
        except (OSError, ValueError):
            pass

    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; GoldTrackerMarketMap/1.0)",
        "Accept": ctype + ",image/*,*/*",
        "Referer": "https://dapanyuntu.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
            real_ct = resp.headers.get("Content-Type", ctype).split(";")[0].strip() or ctype
        if not data:
            raise ValueError("空图片")
        with _IMG_LOCK:
            _IMG_CACHE[key] = (data, real_ct, now)
            try:
                os.makedirs(IMG_CACHE_DIR, exist_ok=True)
                with open(path, "wb") as f:
                    f.write(data)
            except OSError:
                pass
        return data, real_ct, ""
    except Exception as exc:
        return None, ctype, "%s: %s" % (type(exc).__name__, exc)
