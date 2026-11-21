# -*- coding: utf-8 -*-
"""历史快照存储：追加式 JSONL + 内存索引。

原实现每次采集都「全量读 JSON → 追加 → 全量写回」，2 秒采集下开销随
历史长度线性增长。这里改为 append-only，读取只走内存中的 deque。
"""
from __future__ import annotations

import csv
import io
import json
import os
import threading
from collections import deque

_CSV_HEADER = ["采集时间", "金种", "实时主动积存价格", "最低价", "最高价",
               "定期积存价", "赎回价", "主动涨跌", "定期涨跌", "赎回涨跌"]
_DIR_LABELS = {"up": "涨", "down": "跌", "flat": "持平"}


class HistoryStore:
    def __init__(self, path: str, max_items: int = 20000, compact_every: int = 500):
        self.path = path
        self.max_items = max_items
        self.compact_every = compact_every
        self._items: deque = deque(maxlen=max_items)
        self._lock = threading.Lock()
        self._writes_since_compact = 0
        self._migrate_legacy(path[:-6] + ".json" if path.endswith(".jsonl") else None)
        self._load()

    # ---------- 初始化 ----------
    def _migrate_legacy(self, legacy_path: str | None):
        """把旧版 history.json 一次性迁移为 JSONL。"""
        if not legacy_path or not os.path.exists(legacy_path) or os.path.exists(self.path):
            return
        try:
            with open(legacy_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                with open(self.path, "w", encoding="utf-8") as f:
                    for item in data[-self.max_items:]:
                        f.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
        except (OSError, ValueError):
            pass

    def _load(self):
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(item, dict):
                        self._items.append(item)
        except OSError:
            pass

    # ---------- 写入 ----------
    def append(self, records: list[dict]):
        if not records:
            return
        with self._lock:
            with open(self.path, "a", encoding="utf-8") as f:
                for record in records:
                    f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                    self._items.append(record)
            self._writes_since_compact += 1
            if self._writes_since_compact >= self.compact_every:
                self._compact()

    def _compact(self):
        """限制磁盘文件无限增长（内存 deque 已自动裁剪）。"""
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for item in self._items:
                f.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
        os.replace(tmp, self.path)
        self._writes_since_compact = 0

    # ---------- 读取 ----------
    def all(self) -> list[dict]:
        with self._lock:
            return list(self._items)

    def count(self) -> int:
        with self._lock:
            return len(self._items)

    def recent(self, code: str | None = None, limit: int = 500) -> list[dict]:
        with self._lock:
            if code:
                matched = [x for x in self._items if x.get("code") == code]
            else:
                matched = list(self._items)
            return matched[-limit:]

    def csv_text(self) -> str:
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(_CSV_HEADER)
        for r in self.all():
            writer.writerow([
                r.get("fetched_at"), r.get("name"), r.get("active"),
                r.get("low"), r.get("high"), r.get("regular"), r.get("redeem"),
                _DIR_LABELS.get(r.get("active_dir"), ""),
                _DIR_LABELS.get(r.get("regular_dir"), ""),
                _DIR_LABELS.get(r.get("redeem_dir"), ""),
            ])
        return "\ufeff" + out.getvalue()
