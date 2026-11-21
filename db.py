# -*- coding: utf-8 -*-
"""MySQL 数据层：统一管理网页所需的基本信息。

表结构：
  users        登录账号（仅认证，密码 PBKDF2 哈希）
  gold_types   金种基础资料（代码/名称/别名/备注/星标/排序）
  quotes       行情历史快照
  portfolio    个人数据（整包 Fernet 加密存储，全局共享一份，不按用户隔离）
  settings     其它网页基本信息（KV）

连接信息来自 db_config.json（不写死在源码里）；首次运行自动建库建表并迁移旧的
history.jsonl / portfolio-data.json。
"""
from __future__ import annotations

import csv
import io
import json
import os
import threading
from datetime import datetime, timedelta
from typing import Any

import pymysql
from pymysql.cursors import DictCursor

from crypto_util import decrypt_json, encrypt_json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RUYI_CODE = "080020000501"  # 工行如意金积存产品代码，不再采集与保存
CONFIG_FILE = os.path.join(BASE_DIR, "db_config.json")
LEGACY_HISTORY = os.path.join(BASE_DIR, "history.jsonl")
LEGACY_PORTFOLIO = os.path.join(BASE_DIR, "portfolio-data.json")

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "root",
    "password": "123456",
    "database": "gold_tracker",
    "charset": "utf8mb4",
}

_CSV_HEADER = ["采集时间", "金种", "记录类型", "实时主动积存价格(日K为收盘)", "开盘价(仅日K)",
               "最低价", "最高价", "定期积存价", "赎回价", "主动涨跌", "定期涨跌", "赎回涨跌"]
_DIR_LABELS = {"up": "涨", "down": "跌", "flat": "持平"}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                user_cfg = json.load(f)
            if isinstance(user_cfg, dict):
                cfg.update({k: v for k, v in user_cfg.items() if k in DEFAULT_CONFIG})
        except (OSError, ValueError):
            pass
    return cfg


def save_config(cfg: dict) -> None:
    clean = {k: cfg.get(k, v) for k, v in DEFAULT_CONFIG.items()}
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(clean, f, ensure_ascii=False, indent=2)


SCHEMA = """
CREATE DATABASE IF NOT EXISTS `{db}` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `{db}`;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'user',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gold_types (
  code VARCHAR(32) NOT NULL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  alias VARCHAR(128) NOT NULL DEFAULT '',
  note VARCHAR(500) NOT NULL DEFAULT '',
  starred TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS quotes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  fetched_at VARCHAR(32) NOT NULL,
  source_time VARCHAR(32) NULL,
  name VARCHAR(128) NULL,
  active DOUBLE NULL, low DOUBLE NULL, high DOUBLE NULL,
  regular DOUBLE NULL, redeem DOUBLE NULL,
  open_price DOUBLE NULL,
  active_dir VARCHAR(8) NULL, regular_dir VARCHAR(8) NULL, redeem_dir VARCHAR(8) NULL,
  source VARCHAR(24) NULL,
  gran TINYINT NOT NULL DEFAULT 0,
  KEY idx_code_time (code, gran, fetched_at),
  KEY idx_fetched (fetched_at),
  KEY idx_gran_time (gran, fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS portfolio (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(64) NOT NULL PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"""


class MySQLStore:
    """线程安全：每个操作独立短连接，避免多线程共享连接串包。"""

    def __init__(self, config: dict | None = None, max_items: int = 20000):
        self.cfg = config or load_config()
        self.max_items = max_items
        self._write_lock = threading.RLock()
        self._init_schema()
        self._migrate_legacy()

    # ---------- 连接 ----------
    def _connect(self, database: bool = True):
        cfg = dict(self.cfg)
        if not database:
            cfg.pop("database", None)
        return pymysql.connect(
            host=cfg.get("host", "127.0.0.1"),
            port=int(cfg.get("port", 3306)),
            user=cfg.get("user", "root"),
            password=cfg.get("password", ""),
            database=cfg.get("database"),
            charset=cfg.get("charset", "utf8mb4"),
            autocommit=True,
            cursorclass=DictCursor,
            connect_timeout=5,
            read_timeout=10,
            write_timeout=10,
        )

    def _init_schema(self):
        db = self.cfg.get("database", "gold_tracker")
        safe_db = db.replace("`", "``")
        conn = self._connect(database=False)
        try:
            with conn.cursor() as cur:
                for statement in SCHEMA.format(db=safe_db).split(";"):
                    sql = statement.strip()
                    if sql:
                        cur.execute(sql)
        finally:
            conn.close()
        self._ensure_quote_columns()

    def _ensure_quote_columns(self):
        """兼容旧库：给已存在的 quotes 表补齐分层保留所需字段/索引。"""
        db = self.cfg.get("database", "gold_tracker")
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA=%s AND TABLE_NAME='quotes'",
                    (db,),
                )
                columns = {r["COLUMN_NAME"] for r in cur.fetchall()}
                if "gran" not in columns:
                    cur.execute(
                        "ALTER TABLE quotes ADD COLUMN gran TINYINT NOT NULL DEFAULT 0 "
                        "AFTER source"
                    )
                if "open_price" not in columns:
                    cur.execute(
                        "ALTER TABLE quotes ADD COLUMN open_price DOUBLE NULL AFTER redeem"
                    )
                cur.execute(
                    "SELECT INDEX_NAME FROM information_schema.STATISTICS "
                    "WHERE TABLE_SCHEMA=%s AND TABLE_NAME='quotes' AND INDEX_NAME='idx_gran_time'",
                    (db,),
                )
                if not cur.fetchone():
                    cur.execute("CREATE INDEX idx_gran_time ON quotes (gran, fetched_at)")
        finally:
            conn.close()

    # ---------- 迁移旧文件 ----------
    def _migrate_legacy(self):
        self._migrate_history()
        self._migrate_portfolio()

    def _migrate_history(self):
        if not os.path.exists(LEGACY_HISTORY):
            return
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS n FROM quotes")
                if int(cur.fetchone()["n"]) > 0:
                    return
            rows = []
            with open(LEGACY_HISTORY, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(item, dict) and not self._is_ruyi(item):
                        rows.append(self._quote_params(item))
            if not rows:
                return
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO quotes (code, fetched_at, source_time, name, active, low, high, "
                    "regular, redeem, active_dir, regular_dir, redeem_dir, source) "
                    "VALUES (%(code)s,%(fetched_at)s,%(source_time)s,%(name)s,%(active)s,%(low)s,"
                    "%(high)s,%(regular)s,%(redeem)s,%(active_dir)s,%(regular_dir)s,%(redeem_dir)s,%(source)s)",
                    rows[-self.max_items:],
                )
                cur.execute("SELECT DISTINCT code, name FROM quotes WHERE name IS NOT NULL")
                for g in cur.fetchall():
                    self.upsert_gold_type(g["code"], g["name"], migrated=True)
            print(f"[db] 已迁移行情历史 {len(rows)} 条到 MySQL", flush=True)
        except Exception as exc:
            print(f"[db] 行情历史迁移跳过: {exc}", flush=True)
        finally:
            conn.close()

    def _migrate_portfolio(self):
        if not os.path.exists(LEGACY_PORTFOLIO):
            return
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM portfolio WHERE id=1")
                if cur.fetchone():
                    return
            with open(LEGACY_PORTFOLIO, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                return
            self.save_portfolio(data)
            print("[db] 已迁移个人数据到 MySQL（加密存储）", flush=True)
        except Exception as exc:
            print(f"[db] 个人数据迁移跳过: {exc}", flush=True)
        finally:
            conn.close()

    @staticmethod
    def _is_ruyi(item: dict) -> bool:
        """如意金积存：不再采集、迁移、入库或参与日K聚合。"""
        return (str(item.get("code") or "") == RUYI_CODE
                or str(item.get("source") or "") == "ajax"
                or "如意" in str(item.get("name") or ""))

    @staticmethod
    def _quote_params(item: dict) -> dict:
        def num(key):
            v = item.get(key)
            return v if isinstance(v, (int, float)) else None

        return {
            "code": str(item.get("code") or "")[:32],
            "fetched_at": str(item.get("fetched_at") or "")[:32],
            "source_time": str(item.get("t") or "")[:32] or None,
            "name": str(item.get("name") or "")[:128] or None,
            "active": num("active"), "low": num("low"), "high": num("high"),
            "regular": num("regular"), "redeem": num("redeem"),
            "open_price": num("open_price"),
            "active_dir": item.get("active_dir"), "regular_dir": item.get("regular_dir"),
            "redeem_dir": item.get("redeem_dir"),
            "source": item.get("source"),
            "gran": int(item.get("gran") or 0),
        }

    # ---------- 行情 ----------
    def append_quotes(self, records: list[dict]):
        if not records:
            return
        params = [self._quote_params(r) for r in records if not self._is_ruyi(r)]
        if not params:
            return
        sql = (
            "INSERT INTO quotes (code, fetched_at, source_time, name, active, low, high, "
            "regular, redeem, open_price, active_dir, regular_dir, redeem_dir, source, gran) "
            "VALUES (%(code)s,%(fetched_at)s,%(source_time)s,%(name)s,%(active)s,%(low)s,"
            "%(high)s,%(regular)s,%(redeem)s,%(open_price)s,%(active_dir)s,%(regular_dir)s,"
            "%(redeem_dir)s,%(source)s,%(gran)s)"
        )
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.executemany(sql, params)
                # 自动补齐金种基础资料（只插入新代码，不覆盖用户的别名/备注）
                codes = {(p["code"], p["name"]) for p in params if p["code"] and p["name"]}
                for code, name in codes:
                    cur.execute(
                        "INSERT IGNORE INTO gold_types (code, name) VALUES (%s, %s)",
                        (code, name),
                    )
        finally:
            conn.close()

    def count_quotes(self, gran: int | None = None) -> int:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                if gran is None:
                    cur.execute("SELECT COUNT(*) AS n FROM quotes")
                else:
                    cur.execute("SELECT COUNT(*) AS n FROM quotes WHERE gran=%s", (gran,))
                return int(cur.fetchone()["n"])
        finally:
            conn.close()

    def recent_quotes(self, code: str | None = None, limit: int = 500,
                      gran: int = 0, since: str | None = None,
                      until: str | None = None) -> list[dict]:
        """按粒度读取行情。gran=0 原始明细；gran=1 日K线。since/until 为 'YYYY-MM-DD HH:MM:SS'。"""
        limit = max(1, min(int(limit), self.max_items))
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                clauses = ["gran=%s"]
                args: list[Any] = [int(gran)]
                if code:
                    clauses.append("code=%s")
                    args.append(code)
                if since:
                    clauses.append("fetched_at>=%s")
                    args.append(since)
                if until:
                    clauses.append("fetched_at<=%s")
                    args.append(until)
                where = " AND ".join(clauses)
                cur.execute(
                    "SELECT * FROM (SELECT * FROM quotes WHERE " + where +
                    " ORDER BY fetched_at DESC, id DESC LIMIT %s) t ORDER BY fetched_at ASC, id ASC",
                    (*args, limit),
                )
                rows = list(cur.fetchall())
            for r in rows:
                r.pop("id", None)
                if r.get("source_time"):
                    r["t"] = r["source_time"]
            return rows
        finally:
            conn.close()

    def latest_snapshot(self, day: str | None = None, until: str | None = None) -> dict | None:
        """只读恢复「收盘时点」行情，供收盘后展示，不抓取、不写入。

        按金种取 <= until(如收盘时刻 22:30:00) 的最后一帧明细；不传 until 则取当天
        最后一帧。还原成与 IcbcClient.fetch() 同构的 quote dict，让 /api/quote
        在收盘后显示定格数据，而非收盘后多采的尾巴。
        """
        day = day or datetime.now().strftime("%Y-%m-%d")
        next_day = (datetime.strptime(day, "%Y-%m-%d").date() + timedelta(days=1)).strftime("%Y-%m-%d 00:00:00")
        upper_op = "<=" if until else "<"
        upper = until or next_day
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT code, fetched_at, source_time, name, active, low, high, "
                    "regular, redeem, active_dir, regular_dir, redeem_dir, source "
                    "FROM quotes WHERE gran=0 AND fetched_at>=%s AND fetched_at " + upper_op + " %s "
                    "AND code<>%s AND (source IS NULL OR source<>'ajax') "
                    "AND (name IS NULL OR name NOT LIKE %s) "
                    "ORDER BY fetched_at ASC, id ASC",
                    (day + " 00:00:00", upper, RUYI_CODE, "%如意%"),
                )
                latest: dict[str, dict] = {}
                for r in cur.fetchall():
                    code = r.get("code")
                    row = {
                        "code": code, "name": r.get("name"), "source": r.get("source") or "page",
                        "active": r.get("active"), "low": r.get("low"), "high": r.get("high"),
                        "regular": r.get("regular"), "redeem": r.get("redeem"),
                        "active_dir": r.get("active_dir"), "regular_dir": r.get("regular_dir"),
                        "redeem_dir": r.get("redeem_dir"),
                    }
                    latest[code] = {"fetched_at": r.get("fetched_at"),
                                    "source_time": r.get("source_time"), "row": row}
        finally:
            conn.close()
        if not latest:
            return None
        fetched = max((v["fetched_at"] for v in latest.values() if v.get("fetched_at")), default=None)
        source_t = next((v["source_time"] for v in latest.values() if v.get("source_time")), None)
        rows = [latest[k]["row"] for k in sorted(latest)]
        return {
            "ok": True,
            "fetched_at": fetched,
            "source_time": source_t or fetched,
            "rows": rows,
            "error": None,
            "restored": True,
        }

    def compact_raw(self, keep_days: int = 2, max_days: int = 7) -> dict:
        """把 4 秒明细聚合成日K线(gran=1)，并删除 keep_days 天前的明细。

        - 每一天（含今天/昨天）都会生成或更新对应的日K线，保证"全部"视图每天一个点；
          今天的日K线随新数据在其明细被清理前持续刷新。
        - keep_days=2 表示保留今天+昨天的原始明细，更早的明细压缩后删除。
        - 幂等：同 (code, 日期) 的日K线先删后插；重复调用不会重复插入。
        - 每次最多处理 max_days 个自然日（按最早优先），避免单次任务过长。全程事务。
        """
        keep_days = max(1, min(int(keep_days), 365))
        max_days = max(1, min(int(max_days), 60))
        today = datetime.now().date()
        cutoff = (today - timedelta(days=keep_days - 1)).strftime("%Y-%m-%d 00:00:00")

        conn = self._connect()
        result = {"days": 0, "raw_deleted": 0, "kline_written": 0, "cutoff": cutoff}
        try:
            with self._write_lock:
                conn.begin()
                try:
                    with conn.cursor() as cur:
                        # 取所有明细的最早日期，按天分批聚合：优先处理最早（即将被清理）的日子，
                        # 这样每轮都能把最老的一天固化成日K并删掉明细，逐轮收敛。
                        cur.execute(
                            "SELECT MIN(fetched_at) AS first, MAX(fetched_at) AS last FROM quotes WHERE gran=0"
                        )
                        bounds = cur.fetchone()
                        if bounds and bounds.get("first"):
                            first_day = str(bounds["first"])[:10]
                            last_day = str(bounds["last"])[:10]
                            all_days = []
                            d = datetime.strptime(first_day, "%Y-%m-%d").date()
                            end = datetime.strptime(last_day, "%Y-%m-%d").date()
                            while d <= end and len(all_days) < max_days:
                                all_days.append(d.strftime("%Y-%m-%d"))
                                d += timedelta(days=1)

                            for day in all_days:
                                cur.execute(
                                    "SELECT id, code, fetched_at, name, active, low, high, regular, redeem "
                                    "FROM quotes WHERE gran=0 AND fetched_at>=%s AND fetched_at<%s "
                                    "AND code<>%s AND (source IS NULL OR source<>'ajax') "
                                    "AND (name IS NULL OR name NOT LIKE %s) "
                                    "ORDER BY fetched_at ASC, id ASC",
                                    (day + " 00:00:00",
                                     (datetime.strptime(day, "%Y-%m-%d").date() + timedelta(days=1)).strftime("%Y-%m-%d 00:00:00"),
                                     RUYI_CODE, "%如意%"),
                                )
                                raw = cur.fetchall()
                                by_code: dict[str, list[dict]] = {}
                                for r in raw:
                                    by_code.setdefault(r["code"], []).append(r)
                                for code, group in by_code.items():
                                    acts = [x["active"] for x in group if isinstance(x["active"], (int, float))]
                                    hi_vals = [x["high"] for x in group if isinstance(x["high"], (int, float))]
                                    lo_vals = [x["low"] for x in group if isinstance(x["low"], (int, float))]
                                    hi_vals += acts
                                    lo_vals += acts
                                    reg = next((x["regular"] for x in reversed(group)
                                                if isinstance(x["regular"], (int, float))), None)
                                    red = next((x["redeem"] for x in reversed(group)
                                                if isinstance(x["redeem"], (int, float))), None)
                                    name = next((x["name"] for x in reversed(group) if x["name"]), None)
                                    day_key = day + " 00:00:00"
                                    cur.execute(
                                        "DELETE FROM quotes WHERE gran=1 AND code=%s AND fetched_at=%s",
                                        (code, day_key),
                                    )
                                    cur.execute(
                                        "INSERT INTO quotes (code, fetched_at, source_time, name, active, "
                                        "low, high, regular, redeem, open_price, source, gran) "
                                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1)",
                                        (code, day_key, None, name,
                                         acts[-1] if acts else None,
                                         min(lo_vals) if lo_vals else None,
                                         max(hi_vals) if hi_vals else None,
                                         reg, red, acts[0] if acts else None, "kline"),
                                    )
                                    result["kline_written"] += 1

                                # 只有 cutoff 之前的明细才删除；保留最近 keep_days 天的原始明细
                                if day + " 00:00:00" < cutoff:
                                    ids = [x["id"] for x in raw]
                                    for i in range(0, len(ids), 500):
                                        chunk = ids[i:i + 500]
                                        ph = ",".join(["%s"] * len(chunk))
                                        cur.execute("DELETE FROM quotes WHERE gran=0 AND id IN (" + ph + ")", chunk)
                                        result["raw_deleted"] += cur.rowcount
                                result["days"] += 1
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
        finally:
            conn.close()
        return result

    def csv_text(self) -> str:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM quotes ORDER BY fetched_at ASC, id ASC")
                rows = cur.fetchall()
        finally:
            conn.close()
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(_CSV_HEADER)
        for r in rows:
            gran = int(r.get("gran") or 0)
            writer.writerow([
                r.get("fetched_at"), r.get("name"), "日K线" if gran == 1 else "原始",
                r.get("active"), r.get("open_price"),
                r.get("low"), r.get("high"), r.get("regular"), r.get("redeem"),
                _DIR_LABELS.get(r.get("active_dir"), ""),
                _DIR_LABELS.get(r.get("regular_dir"), ""),
                _DIR_LABELS.get(r.get("redeem_dir"), ""),
            ])
        return "\ufeff" + out.getvalue()

    def purge_ruyi(self) -> dict:
        """一次性清理历史库中的如意金积存数据（明细、日K与金种资料）。"""
        conn = self._connect()
        result = {"quotes": 0, "gold_types": 0}
        try:
            with self._write_lock:
                conn.begin()
                try:
                    with conn.cursor() as cur:
                        cur.execute(
                            "DELETE FROM quotes WHERE code=%s OR source='ajax' OR name LIKE %s",
                            (RUYI_CODE, "%如意%"),
                        )
                        result["quotes"] = cur.rowcount
                        cur.execute(
                            "DELETE FROM gold_types WHERE code=%s OR name LIKE %s",
                            (RUYI_CODE, "%如意%"),
                        )
                        result["gold_types"] = cur.rowcount
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
        finally:
            conn.close()
        return result

    # ---------- 金种基础资料 ----------
    def upsert_gold_type(self, code: str, name: str, migrated: bool = False) -> None:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO gold_types (code, name) VALUES (%s, %s) "
                    "ON DUPLICATE KEY UPDATE name=VALUES(name)",
                    (str(code)[:32], str(name)[:128]),
                )
        finally:
            conn.close()

    def list_gold_types(self) -> list[dict]:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT code, name, alias, note, starred, sort_order FROM gold_types "
                    "ORDER BY starred DESC, sort_order ASC, code ASC"
                )
                rows = list(cur.fetchall())
            for r in rows:
                r["starred"] = bool(r["starred"])
            return rows
        finally:
            conn.close()

    def update_gold_type(self, code: str, fields: dict) -> dict | None:
        allowed = {"alias": str, "note": str, "starred": lambda v: 1 if v else 0,
                   "sort_order": int, "name": str}
        sets, vals = [], []
        for key, caster in allowed.items():
            if key in fields:
                try:
                    val = caster(fields[key])
                except (ValueError, TypeError):
                    continue
                sets.append(f"{key}=%s")
                vals.append(val)
        if not sets:
            return self._get_gold_type(code)
        vals.append(code)
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(f"UPDATE gold_types SET {', '.join(sets)} WHERE code=%s", vals)
        finally:
            conn.close()
        return self._get_gold_type(code)

    def _get_gold_type(self, code: str) -> dict | None:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT code, name, alias, note, starred, sort_order FROM gold_types WHERE code=%s",
                    (code,),
                )
                row = cur.fetchone()
            if row:
                row["starred"] = bool(row["starred"])
            return row
        finally:
            conn.close()

    # ---------- 个人数据（加密） ----------
    def load_portfolio(self, default: dict) -> dict:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT payload FROM portfolio WHERE id=1")
                row = cur.fetchone()
        finally:
            conn.close()
        if not row:
            return dict(default)
        data = decrypt_json(row["payload"], default=None)
        if not isinstance(data, dict):
            return dict(default)
        return {**default, **data}

    def save_portfolio(self, data: dict) -> dict:
        payload = encrypt_json(data)
        conn = self._connect()
        try:
            with self._write_lock, conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO portfolio (id, payload) VALUES (1, %s) "
                    "ON DUPLICATE KEY UPDATE payload=VALUES(payload)",
                    (payload,),
                )
        finally:
            conn.close()
        return data

    # ---------- 用户 ----------
    def get_user_by_name(self, username: str) -> dict | None:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM users WHERE username=%s", (username,))
                return cur.fetchone()
        finally:
            conn.close()

    def get_user_by_id(self, user_id: int) -> dict | None:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM users WHERE id=%s", (user_id,))
                return cur.fetchone()
        finally:
            conn.close()

    def create_user(self, username: str, password_hash: str, role: str = "user") -> dict:
        conn = self._connect()
        try:
            with self._write_lock, conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO users (username, password_hash, role) VALUES (%s, %s, %s)",
                    (username, password_hash, role),
                )
                uid = cur.lastrowid
            return self.get_user_by_id(uid)
        finally:
            conn.close()

    def count_users(self) -> int:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS n FROM users")
                return int(cur.fetchone()["n"])
        finally:
            conn.close()

    def touch_login(self, user_id: int) -> None:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("UPDATE users SET last_login=NOW() WHERE id=%s", (user_id,))
        finally:
            conn.close()

    # ---------- 设置（网页基本信息 KV） ----------
    def get_setting(self, key: str, default: str | None = None) -> str | None:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT v FROM settings WHERE k=%s", (key,))
                row = cur.fetchone()
                return row["v"] if row else default
        finally:
            conn.close()

    def set_setting(self, key: str, value: str) -> None:
        conn = self._connect()
        try:
            with self._write_lock, conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO settings (k, v) VALUES (%s, %s) "
                    "ON DUPLICATE KEY UPDATE v=VALUES(v)",
                    (key, str(value)),
                )
        finally:
            conn.close()

    def status(self) -> dict:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS n FROM quotes")
                q = int(cur.fetchone()["n"])
                cur.execute("SELECT COUNT(*) AS n FROM quotes WHERE gran=0")
                q_raw = int(cur.fetchone()["n"])
                cur.execute("SELECT COUNT(*) AS n FROM quotes WHERE gran=1")
                q_kline = int(cur.fetchone()["n"])
                cur.execute("SELECT COUNT(*) AS n FROM users")
                u = int(cur.fetchone()["n"])
                cur.execute("SELECT COUNT(*) AS n FROM gold_types")
                g = int(cur.fetchone()["n"])
            return {"quotes": q, "quotes_raw": q_raw, "quotes_kline": q_kline,
                    "users": u, "gold_types": g}
        finally:
            conn.close()
