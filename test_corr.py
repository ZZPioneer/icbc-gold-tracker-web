# -*- coding: utf-8 -*-
"""盘面分析（板块 × 黄金相关性）测试：python -m unittest -v test_corr

覆盖：统计函数正确性（已知值）、秩与并列、t 检验 p 值、BH-FDR、
板块收益合成（含停牌剔除）、累计净值、滚动相关、降级路径。
不依赖真实网络。
"""
import math
import tempfile
import unittest
from unittest.mock import patch

import sector_corr as sc


class StatTests(unittest.TestCase):
    def test_pearson_bounds(self):
        self.assertAlmostEqual(sc.pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1.0, places=9)
        self.assertAlmostEqual(sc.pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1.0, places=9)
        # 常数序列没有方差 → 无法计算
        self.assertIsNone(sc.pearson([1, 1, 1, 1], [1, 2, 3, 4]))
        self.assertIsNone(sc.pearson([1, 2], [1, 2]))  # 样本不足

    def test_pearson_known_value(self):
        # 教科书标准数据集：r = 6 / sqrt(60) ≈ 0.774597
        x = [1, 2, 3, 4, 5]
        y = [2, 4, 5, 4, 5]
        self.assertAlmostEqual(sc.pearson(x, y), 6 / math.sqrt(60), places=9)

    def test_ranks_average_on_ties(self):
        self.assertEqual(sc.ranks([10, 20, 20, 30, 40]), [1.0, 2.5, 2.5, 4.0, 5.0])
        self.assertEqual(sc.ranks([5, 5, 5]), [2.0, 2.0, 2.0])

    def test_spearman_monotonic(self):
        # 严格单调（非线性）→ Spearman = 1，Pearson < 1
        x = [1, 2, 3, 4, 5]
        y = [1, 4, 9, 16, 25]
        self.assertAlmostEqual(sc.spearman(x, y), 1.0, places=9)
        self.assertLess(sc.pearson(x, y), 1.0)

    def test_t_pvalue_matches_theory(self):
        # r = 0.5, n = 30 → t = 3.0551, df = 28, 双尾 p ≈ 0.004905
        r, n = 0.5, 30
        df = n - 2
        t = r * math.sqrt(df / (1 - r * r))
        self.assertAlmostEqual(t, 3.0551, places=4)
        self.assertAlmostEqual(sc.t_pvalue(t, df), 0.004905, delta=2e-5)

    def test_corr_pvalue_extremes(self):
        self.assertAlmostEqual(sc.corr_pvalue(1.0, 50), 0.0, places=9)
        # 大样本下 r=0.3 应显著
        self.assertLess(sc.corr_pvalue(0.3, 250), 1e-5)
        # 小样本下 r=0.3 不显著
        self.assertGreater(sc.corr_pvalue(0.3, 10), 0.05)

    def test_bh_fdr_known_sequence(self):
        # p = [0.001,0.008,0.039,0.041,0.042], m=5
        # 期望 q = [0.005,0.020,0.042,0.042,0.042]
        q = sc.bh_fdr([0.001, 0.008, 0.039, 0.041, 0.042])
        self.assertEqual([round(v, 4) for v in q], [0.005, 0.02, 0.042, 0.042, 0.042])

    def test_bh_fdr_preserves_order_and_bounds(self):
        p = [0.9, 0.001, 0.02]
        q = sc.bh_fdr(p)
        self.assertEqual(len(q), 3)
        self.assertTrue(all(0.0 <= v <= 1.0 for v in q))
        # 最小 p 对应的 q 也最小
        self.assertEqual(min(range(3), key=lambda i: q[i]), 1)

    def test_strength_and_direction(self):
        self.assertEqual(sc.strength_label(0.85), "极强")
        self.assertEqual(sc.strength_label(-0.6), "强")
        self.assertEqual(sc.strength_label(0.35), "中等")
        self.assertEqual(sc.strength_label(0.2), "弱")
        self.assertEqual(sc.strength_label(0.05), "几乎无关")
        self.assertEqual(sc.strength_label(None), "样本不足")
        self.assertEqual(sc.direction_label(0.4), "positive")
        self.assertEqual(sc.direction_label(-0.4), "negative")
        self.assertEqual(sc.direction_label(0.02), "neutral")

    def test_rolling_corr_length(self):
        x = [i * 0.01 for i in range(30)]
        y = [i * 0.01 for i in range(30)]
        out = sc.rolling_corr(x, y, 10)
        self.assertEqual(len(out), 30)
        self.assertTrue(all(v is None for v in out[:9]))
        self.assertAlmostEqual(out[-1], 1.0, places=9)


class SymbolTests(unittest.TestCase):
    def test_to_symbol(self):
        self.assertEqual(sc.to_symbol("601138.SH"), "sh601138")
        self.assertEqual(sc.to_symbol("000333.SZ"), "sz000333")
        self.assertEqual(sc.to_symbol("430047.BJ"), "bj430047")
        self.assertEqual(sc.to_symbol("600000"), "sh600000")
        self.assertEqual(sc.to_symbol("688385.sh"), "sh688385")


class SectorReturnTests(unittest.TestCase):
    def setUp(self):
        # 专注合成逻辑，不受真实最小样本阈值影响
        self._patched = patch.object(sc, "MIN_BARS", 3)
        self._patched.start()

    def tearDown(self):
        self._patched.stop()

    def test_weighted_average(self):
        members = [
            {"symbol": "a", "weight": 1.0},
            {"symbol": "b", "weight": 1.0},
        ]
        klines = {
            "a": [("2026-01-01", 10.0), ("2026-01-02", 11.0), ("2026-01-03", 11.0)],
            "b": [("2026-01-01", 20.0), ("2026-01-02", 20.0), ("2026-01-03", 22.0)],
        }
        rets, used = sc._sector_returns(members, klines)
        self.assertEqual(used, 2)
        self.assertAlmostEqual(rets["2026-01-02"], 0.05, places=9)   # (10% + 0%) / 2
        self.assertAlmostEqual(rets["2026-01-03"], 0.05, places=9)   # (0% + 10%) / 2

    def test_weight_matters(self):
        members = [
            {"symbol": "a", "weight": 3.0},
            {"symbol": "b", "weight": 1.0},
        ]
        klines = {
            "a": [("2026-01-01", 10.0), ("2026-01-02", 11.0), ("2026-01-03", 11.0)],
            "b": [("2026-01-01", 10.0), ("2026-01-02", 9.0), ("2026-01-03", 9.0)],
        }
        rets, _ = sc._sector_returns(members, klines)
        # (0.3*0.1 + 0.1*(-0.1)) / 0.4 = 0.05
        self.assertAlmostEqual(rets["2026-01-02"], 0.05, places=9)

    def test_suspended_stock_not_mispriced(self):
        """停牌股的跨期涨幅不能被当成单日涨幅计入。"""
        members = [
            {"symbol": "a", "weight": 1.0},   # 01-03/01-04 停牌
            {"symbol": "b", "weight": 1.0},
        ]
        klines = {
            "a": [("2026-01-01", 10.0), ("2026-01-02", 11.0), ("2026-01-05", 12.1)],
            "b": [("2026-01-01", 20.0), ("2026-01-02", 20.0), ("2026-01-03", 22.0),
                  ("2026-01-04", 22.0), ("2026-01-05", 22.0)],
        }
        rets, used = sc._sector_returns(members, klines)
        self.assertEqual(used, 2)
        # 01-05 只应由 b 贡献（0%），a 因前一日不是自己的交易日被剔除
        self.assertAlmostEqual(rets["2026-01-05"], 0.0, places=9)

    def test_too_few_members(self):
        members = [{"symbol": "a", "weight": 1.0}]
        klines = {"a": [("2026-01-01", 10.0), ("2026-01-02", 11.0)]}
        rets, used = sc._sector_returns(members, klines)
        self.assertEqual(rets, {})
        self.assertEqual(used, 0)


class CumulateTests(unittest.TestCase):
    def test_cumulate(self):
        rets = {"2026-01-02": 0.1, "2026-01-03": -0.1}
        dates = ["2026-01-01", "2026-01-02", "2026-01-03"]
        out = sc._cumulate(rets, dates)
        self.assertAlmostEqual(out[0], 0.0, places=9)
        self.assertAlmostEqual(out[1], 0.1, places=6)
        self.assertAlmostEqual(out[2], 1.1 * 0.9 - 1.0, places=6)


class LoadSectorsTests(unittest.TestCase):
    def test_missing_cache_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(sc, "MAP_CACHE_DIR", tmp):
                self.assertEqual(sc.load_sectors(), [])


class AnalyzeDegradeTests(unittest.TestCase):
    def test_no_sectors(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(sc, "CORR_DIR", tmp), patch.object(sc, "MAP_CACHE_DIR", tmp):
                sc._CACHE.clear()
                out = sc.analyze("gold_etf", 250, force=True)
        self.assertFalse(out["ok"])
        self.assertIn("云图板块数据", out["error"])

    def test_options_payload(self):
        opt = sc.options()
        self.assertTrue(opt["ok"])
        self.assertTrue(any(b["key"] == "gold_etf" for b in opt["benchmarks"]))
        self.assertEqual([w["key"] for w in opt["windows"]], [60, 120, 250])

    def test_invalid_window_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(sc, "CORR_DIR", tmp), patch.object(sc, "MAP_CACHE_DIR", tmp):
                sc._CACHE.clear()
                out = sc.analyze("gold_etf", 999, force=True)
        # 无板块数据 → 降级，但不应抛异常
        self.assertIn("ok", out)


class SummaryTests(unittest.TestCase):
    def test_summary_strips_arrays(self):
        payload = {
            "ok": True, "bench": "gold_etf", "sectors": [
                {"name": "有色", "r": 0.5, "dates": ["d"], "scatter": [[1, 2]],
                 "rolling": [0.1], "cum_sector": [0.1], "cum_bench": [0.2]},
            ],
        }
        out = sc.summary(payload)
        row = out["sectors"][0]
        for key in ("dates", "scatter", "rolling", "cum_sector", "cum_bench"):
            self.assertNotIn(key, row)
        self.assertEqual(row["name"], "有色")


if __name__ == "__main__":
    unittest.main()
