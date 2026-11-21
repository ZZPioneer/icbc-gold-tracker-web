# -*- coding: utf-8 -*-
"""大盘云图数据层测试：python -m unittest -v test_market_map

用临时缓存目录 + mock 上游，验证市场/周期清单、缓存/降级、三源合并、总览/搜索，不依赖真实网络。
"""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import market_map as M


def fake_payload(market, period="day"):
    return {
        "market": market, "period": period, "updatedAt": "2026-11-20T16:00:00+08:00",
        "stockCount": 2, "boardCount": 1,
        "summary": {"advanceCount": 1, "flatCount": 0, "declineCount": 1,
                    "turnoverAmount": 100, "turnoverDelta": 10, "indexChangePct": 0.5},
        "nodes": [{"code": "B1", "name": "板块一", "value": 100, "stockCount": 2,
                   "children": [
                       {"code": "000001.SZ", "name": "平安银行", "value": 60, "changePct": 1.2, "price": 12.3},
                       {"code": "600000.SH", "name": "浦发银行", "value": 40, "changePct": -0.8, "price": 9.1},
                   ]}],
    }


class MarketTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patcher = patch.object(M, "CACHE_DIR", self.tmp.name)
        self.patcher.start()
        M.ensure_cache_dir()

    def tearDown(self):
        self.patcher.stop()
        self.tmp.cleanup()

    def test_market_registry(self):
        keys = [m["key"] for m in M.MARKETS]
        self.assertEqual(keys, ["all", "bj", "etf", "cb", "hk", "us"])
        self.assertTrue(M._valid_market("bj"))
        self.assertFalse(M._valid_market("stock"))

    def test_period_registry(self):
        keys = [p["key"] for p in M.PERIODS]
        self.assertEqual(keys, ["day", "week", "month", "year"])
        self.assertTrue(M._valid_period("year"))
        self.assertFalse(M._valid_period("random"))
        self.assertEqual(M._norm_period("bad"), "day")

    def test_invalid_market(self):
        self.assertFalse(M.get_market("bogus")["ok"])

    def test_fetch_and_cache(self):
        with patch.object(M, "_fetch_remote", side_effect=lambda m, **k: fake_payload(m)) as f:
            r = M.get_market("all")
            self.assertTrue(r["ok"])
            self.assertFalse(r["cached"])
            self.assertEqual(r["name"], "A股全图")
            self.assertEqual(r["period"], "day")
            f.assert_called_once()
            r2 = M.get_market("all")
            self.assertTrue(r2["cached"])
            self.assertFalse(r2["stale"])
            f.assert_called_once()
            M.get_market("all", force=True)
            self.assertEqual(f.call_count, 2)

    def test_periods_cached_separately(self):
        """不同周期使用独立缓存，互不覆盖。"""
        seen = []
        def fake(m, period="day", **k):
            seen.append((m, period))
            return fake_payload(m, period)
        with patch.object(M, "_fetch_remote", side_effect=fake):
            M.get_market("all", period="day")
            M.get_market("all", period="week")
            M.get_market("all", period="year")
            # 同周期第二次命中缓存
            M.get_market("all", period="week")
        self.assertEqual(seen, [("all", "day"), ("all", "week"), ("all", "year")])

    def test_skeleton_shared_across_periods(self):
        """骨架按 market 下载一次，被多周期共享（周期无关）。"""
        calls = []
        def fake_get(url, timeout):
            if "/treemap?" in url:
                calls.append(url)
                return fake_payload("all")
            if "/quotes?" in url:
                return {"updatedAt": "2026-11-20T16:15:00+08:00", "quotes": {}}
            if "/summary?" in url:
                return {"updatedAt": "2026-11-20T16:59:00+08:00", "summary": {}}
            raise AssertionError("unexpected url " + url)
        with patch.object(M, "_get_json", side_effect=fake_get):
            M._fetch_remote("all", period="day")
            M._fetch_remote("all", period="week")
            M._fetch_remote("all", period="year")
        self.assertEqual(len(calls), 1, "骨架应只下载一次")

    def test_stale_fallback(self):
        with patch.object(M, "_fetch_remote", side_effect=lambda m, **k: fake_payload(m)):
            M.get_market("etf")
        with patch.object(M, "_fetch_remote", side_effect=RuntimeError("network down")):
            r = M.get_market("etf", force=True)
            self.assertTrue(r["ok"])
            self.assertTrue(r["cached"])
            self.assertTrue(r["stale"])
            self.assertIn("network down", r["error"])

    def test_no_cache_no_upstream(self):
        with patch.object(M, "_fetch_remote", side_effect=RuntimeError("down")):
            r = M.get_market("hk")
            self.assertFalse(r["ok"])
            self.assertIn("down", r["error"])

    def test_list_markets(self):
        with patch.object(M, "_fetch_remote", side_effect=lambda m, **k: fake_payload(m)):
            M.get_market("all")
        items = M.list_markets()
        self.assertEqual(len(items), 6)
        all_item = [x for x in items if x["key"] == "all"][0]
        self.assertTrue(all_item["hasData"])
        self.assertEqual(all_item["stockCount"], 2)
        self.assertEqual(all_item["summary"]["indexChangePct"], 0.5)
        cb_item = [x for x in items if x["key"] == "cb"][0]
        self.assertFalse(cb_item["hasData"])

    def test_prefetch_all_periods(self):
        with patch.object(M, "_fetch_remote", side_effect=lambda m, **k: fake_payload(m)), \
             patch.object(M, "get_overview", return_value={"ok": True}):
            r = M.prefetch_all()
        # 6 市场 × 4 周期 = 24
        for m in ["all", "bj", "etf", "cb", "hk", "us"]:
            for p in ["day", "week", "month", "year"]:
                self.assertTrue(r[m + "." + p])

    def test_fetch_remote_merges_three_sources(self):
        tree = fake_payload("all")
        def fake_get(url, timeout):
            if "/treemap?" in url:
                return tree
            if "/quotes?" in url:
                return {"updatedAt": "2026-11-20T16:15:00+08:00", "quotes": {
                    "000001.SZ": {"price": 13.5, "changePct": 5.5, "turnoverAmount": 999},
                    "600000.SH": {"price": 8.0, "changePct": -2.2, "turnoverAmount": 888},
                }}
            if "/summary?" in url:
                return {"updatedAt": "2026-11-20T16:59:00+08:00", "summary": {
                    "advanceCount": 9, "flatCount": 1, "declineCount": 2,
                    "turnoverAmount": 500, "indexChangePct": 1.23,
                }}
            raise AssertionError("unexpected url " + url)
        with patch.object(M, "_get_json", side_effect=fake_get):
            r = M._fetch_remote("all", period="week")
        self.assertEqual(r["period"], "week")
        c0 = r["nodes"][0]["children"][0]
        self.assertEqual(c0["price"], 13.5)
        self.assertEqual(c0["changePct"], 5.5)
        self.assertEqual(c0["turnoverAmount"], 999)
        self.assertEqual(r["summary"]["advanceCount"], 9)
        self.assertEqual(r["summary"]["indexChangePct"], 1.23)
        self.assertEqual(r["updatedAt"], "2026-11-20T16:59:00+08:00")
        self.assertTrue(r["_merge"]["quotes"])
        self.assertTrue(r["_merge"]["summary"])

    def test_fetch_remote_degrades_when_quotes_fail(self):
        tree = fake_payload("all")
        def fake_get(url, timeout):
            if "/treemap?" in url:
                return tree
            raise RuntimeError("down")
        with patch.object(M, "_get_json", side_effect=fake_get):
            r = M._fetch_remote("all")
        self.assertEqual(r["nodes"][0]["children"][0]["price"], 12.3)
        self.assertEqual(r["summary"]["indexChangePct"], 0.5)
        self.assertFalse(r["_merge"]["quotes"])
        self.assertFalse(r["_merge"]["summary"])

    def test_overview(self):
        ov = {"period": "day", "updatedAt": "2026-11-20T16:15:00+08:00",
              "markets": [{"market": "all", "changePct": -2.72, "stockCount": 5566}]}
        with patch.object(M, "_get_json", return_value=ov) as g:
            r = M.get_overview("day")
            self.assertTrue(r["ok"])
            self.assertEqual(len(r["data"]["markets"]), 1)
            self.assertFalse(r["cached"])
            r2 = M.get_overview("day")
            self.assertTrue(r2["cached"])
            self.assertEqual(g.call_count, 1)

    def test_search(self):
        sr = {"query": "工商银行", "items": [
            {"code": "601398.SH", "name": "工商银行", "boardName": "银行"}]}
        with patch.object(M, "_get_json", return_value=sr) as g:
            r = M.search("工商银行")
            self.assertTrue(r["ok"])
            self.assertEqual(r["items"][0]["name"], "工商银行")
            url = g.call_args[0][0]
            self.assertIn("%E5%B7%A5", url, "中文 q 应被 URL 编码")
        self.assertEqual(M.search("")["items"], [])


if __name__ == "__main__":
    unittest.main()
