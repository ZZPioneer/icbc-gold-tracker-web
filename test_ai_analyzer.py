# -*- coding: utf-8 -*-
"""AI 每日分析模块回归测试：python -m unittest -v test_ai_analyzer

用假 store 模拟 MySQL 行情，验证特征计算、降级、md 生成、文件管理与日期校验，
不依赖真实数据库，也不调用 DeepSeek。
"""
import os
import tempfile
import unittest
from unittest.mock import patch

import ai_analyzer as A

CODE = "080020000521"


class FakeStore:
    """按 ai_analyzer 使用的接口返回行情。"""

    def __init__(self, klines=None, raws=None):
        self.klines = klines or []
        self.raws = raws or []

    def recent_quotes(self, code=None, limit=500, gran=0, since=None, until=None):
        src = self.klines if gran == 1 else self.raws
        out = [dict(r) for r in src]
        if code:
            out = [r for r in out if r.get("code") == code]
        if since:
            out = [r for r in out if r.get("fetched_at", "") >= since]
        if until:
            out = [r for r in out if r.get("fetched_at", "") <= until]
        return out[-limit:]


def _raw(active, high, low, t):
    return {"code": CODE, "name": "积存金", "active": active, "high": high, "low": low,
            "regular": active + 3, "redeem": active - 1, "fetched_at": t}


def make_store():
    # 昨收 800，今开 810，冲高 830、探低 808，收 820 => 涨 20(+2.5%)，振幅 2.75%
    raws = [
        _raw(810, 812, 808, "2026-11-20 09:30:00"),
        _raw(820, 826, 815, "2026-11-20 11:00:00"),
        _raw(830, 830, 826, "2026-11-20 14:00:00"),
        _raw(820, 830, 808, "2026-11-20 22:29:00"),
    ]
    klines = [
        {"code": CODE, "name": "积存金", "fetched_at": "2026-11-19 00:00:00", "active": 800.0,
         "open_price": 798.0, "high": 805.0, "low": 797.0},
        {"code": CODE, "name": "积存金", "fetched_at": "2026-11-20 00:00:00", "active": 820.0,
         "open_price": 810.0, "high": 830.0, "low": 808.0},
    ]
    return FakeStore(klines=klines, raws=raws)


class ConfigTests(unittest.TestCase):
    def test_defaults_and_key_detection(self):
        cfg = dict(A.DEFAULT_CONFIG)
        self.assertFalse(A.is_configured(cfg))
        cfg["api_key"] = "sk-test-key"
        self.assertTrue(A.is_configured(cfg))
        cfg["api_key"] = "your_api_key"
        self.assertFalse(A.is_configured(cfg))

    def test_validate_day(self):
        self.assertEqual(A._valid_day("2026-11-20"), "2026-11-20")
        for bad in ("2026/11/20", "../etc/passwd", "2026-13-01", ""):
            with self.assertRaises(ValueError):
                A._valid_day(bad)


class FeatureTests(unittest.TestCase):
    def test_compute_features_core(self):
        f = A.compute_features(make_store(), "2026-11-20")
        self.assertFalse(f["empty"])
        g = f["gold"][0]
        self.assertEqual(g["baseline"], 800.0)       # 昨收
        self.assertEqual(g["baseline_kind"], "昨收")
        self.assertEqual(g["open"], 810.0)
        self.assertEqual(g["close"], 820.0)
        self.assertEqual(g["high"], 830.0)
        self.assertEqual(g["low"], 808.0)
        self.assertEqual(g["change"], 20.0)
        self.assertEqual(g["change_pct"], 2.5)
        self.assertEqual(g["amplitude_pct"], 2.75)
        self.assertEqual(g["body"], 10.0)
        self.assertEqual(g["high_time"], "14:00:00")
        self.assertEqual(g["low_time"], "09:30:00")
        self.assertEqual(g["samples"], 4)

    def test_fallback_to_open_when_no_prev_close(self):
        store = make_store()
        store.klines = [k for k in store.klines if k["fetched_at"].startswith("2026-11-20")]
        g = A.compute_features(store, "2026-11-20")["gold"][0]
        self.assertEqual(g["baseline"], 810.0)       # 退回今开
        self.assertEqual(g["baseline_kind"], "今开(无昨收数据)")

    def test_until_cutoff(self):
        f = A.compute_features(make_store(), "2026-11-20", until="2026-11-20 11:30:00")
        g = f["gold"][0]
        self.assertEqual(g["samples"], 2)            # 只保留 09:30 与 11:00 两帧
        self.assertEqual(g["close"], 820.0)          # 收盘取当日K线（不受 until 影响）

    def test_empty_day(self):
        f = A.compute_features(FakeStore(), "2026-11-20")
        self.assertTrue(f["empty"])


class RenderTests(unittest.TestCase):
    def test_render_no_key(self):
        f = A.compute_features(make_store(), "2026-11-20")
        md = A.render_markdown(f, {"status": "no_key", "text": ""})
        self.assertIn("# 积存金行情复盘 · 2026-11-20", md)
        self.assertIn("当日概览", md)
        self.assertIn("涨跌特征明细", md)
        self.assertIn("2.5", md)
        self.assertIn("尚未配置 DeepSeek API Key", md)
        self.assertIn("ai_config.json", md)

    def test_render_with_ai_text(self):
        f = A.compute_features(make_store(), "2026-11-20")
        md = A.render_markdown(f, {"status": "ok", "text": "## 当日综述\n金价放量上攻。"})
        self.assertIn("金价放量上攻", md)
        self.assertNotIn("尚未配置", md)


class FileTests(unittest.TestCase):
    def test_analyze_and_list_and_read(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = dict(A.DEFAULT_CONFIG)
            cfg["report_dir"] = d
            cfg["api_key"] = ""
            res = A.analyze_day(make_store(), "2026-11-20", cfg=cfg, force=True)
            self.assertTrue(res["ok"])
            self.assertTrue(os.path.exists(res["path"]))
            self.assertEqual(res["ai"]["status"], "no_key")

            reports = A.list_reports(cfg)
            self.assertEqual(len(reports), 1)
            self.assertEqual(reports[0]["date"], "2026-11-20")
            self.assertIn("积存金行情复盘", reports[0]["title"])
            self.assertIsNotNone(A.read_report("2026-11-20", cfg))

            # 不 force 时报告已存在，直接跳过（收盘自动触发不重复调用 AI）
            with patch.object(A, "call_deepseek") as call:
                res2 = A.analyze_day(make_store(), "2026-11-20", cfg=cfg, force=False)
                self.assertTrue(res2.get("exists"))
                call.assert_not_called()

            # 非法日期不落盘
            bad = A.analyze_day(make_store(), "../evil", cfg=cfg)
            self.assertFalse(bad["ok"])


class DeepSeekCallTests(unittest.TestCase):
    def test_no_key_short_circuit(self):
        result = A.call_deepseek({}, {"api_key": ""})
        self.assertEqual(result["status"], "no_key")

    def test_error_is_swallowed(self):
        cfg = dict(A.DEFAULT_CONFIG)
        cfg["api_key"] = "sk-fake"
        cfg["base_url"] = "http://127.0.0.1:1"  # 必然连接失败
        cfg["timeout"] = 1
        result = A.call_deepseek({}, cfg)
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["error"])


if __name__ == "__main__":
    unittest.main()
