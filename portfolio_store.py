# -*- coding: utf-8 -*-
"""个人数据持久化：持仓 / 持仓节点 / 昨收基准 / 买入赎回记录。

这些原先存在浏览器 localStorage，换电脑或换浏览器即丢失。改为存到项目目录的
portfolio-data.json，随项目文件夹一起走。

写入采用「临时文件 + os.replace」原子替换，避免进程中断时留下半个 JSON 导致数据全丢。
"""
from __future__ import annotations

import json
import os
import tempfile
import threading

DEFAULT_DATA = {
    "position": None,
    "positionNodes": [],
    "baselines": {},
    "trades": [],
}


class PortfolioStore:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()

    def load(self) -> dict:
        """读取；文件不存在或损坏时返回默认空数据，不抛异常。"""
        with self._lock:
            if not os.path.exists(self.path):
                return dict(DEFAULT_DATA)
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if not isinstance(data, dict):
                    return dict(DEFAULT_DATA)
                return {**DEFAULT_DATA, **{k: data.get(k, v) for k, v in DEFAULT_DATA.items()}}
            except (OSError, ValueError):
                return dict(DEFAULT_DATA)

    def save(self, data: dict) -> dict:
        """整体写入并原子替换；只保留已知字段，避免前端误传污染文件。"""
        clean = {
            "position": data.get("position") if isinstance(data.get("position"), (dict, type(None))) else None,
            "positionNodes": data.get("positionNodes") if isinstance(data.get("positionNodes"), list) else [],
            "baselines": data.get("baselines") if isinstance(data.get("baselines"), dict) else {},
            "trades": data.get("trades") if isinstance(data.get("trades"), list) else [],
        }
        clean["positionNodes"] = clean["positionNodes"][-50:]
        clean["trades"] = clean["trades"][-2000:]
        with self._lock:
            directory = os.path.dirname(self.path) or "."
            fd, tmp = tempfile.mkstemp(prefix=".portfolio-", suffix=".tmp", dir=directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(clean, f, ensure_ascii=False, separators=(",", ":"))
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.path)
            except Exception:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise
        return clean
