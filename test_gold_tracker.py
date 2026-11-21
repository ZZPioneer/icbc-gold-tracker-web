# -*- coding: utf-8 -*-
"""解析器与存储的回归测试：python -m unittest -v test_gold_tracker"""
import os
import tempfile
import unittest
from datetime import datetime
from unittest.mock import patch

from db import MySQLStore
from history_store import HistoryStore
from icbc_client import parse_page
from portfolio_store import PortfolioStore
from server import QuoteService

PAGE_FIXTURE = """
<table>
<tr>
  <td id="prodnoo_080020000521">积存金</td>
  <td id="activeprice_080020000521">817.07</td>
  <td id="updown1_080020000521"><img src="/fdown.png" alt="跌"></td>
  <td id="lowprice_080020000521">815.15</td>
  <td id="highprice_080020000521">821.97</td>
  <td id="regprice_080020000521">821.30</td>
  <td id="updown2_080020000521"><img src="/fmid.png" alt="无变化"></td>
  <td id="sellprice_080020000521">817.07</td>
  <td id="updown3_080020000521"><img src="/fup.png" alt="涨"></td>
</tr>
</table>
<script>更新时间:2026-11-18 10:14:55</script>
"""

class ParserTests(unittest.TestCase):
    def test_parse_page(self):
        rows, source_time = parse_page(PAGE_FIXTURE)
        self.assertEqual(source_time, "2026-11-18 10:14:55")
        row = rows[0]
        self.assertEqual(row["name"], "积存金")
        self.assertEqual(row["active"], 817.07)
        self.assertEqual(row["low"], 815.15)
        self.assertEqual(row["high"], 821.97)
        self.assertEqual(row["regular"], 821.30)
        self.assertEqual(row["active_dir"], "down")
        self.assertEqual(row["regular_dir"], "flat")
        self.assertEqual(row["redeem_dir"], "up")

    def test_parse_page_rejects_garbage(self):
        with self.assertRaises(ValueError):
            parse_page("<tr><td id='prodnoo_1'>积存金</td><td id='activeprice_1'>--</td></tr>")

class RuyiExclusionTests(unittest.TestCase):
    def test_detects_ruyi_by_code_source_or_name(self):
        self.assertTrue(MySQLStore._is_ruyi({"code": "080020000501"}))
        self.assertTrue(MySQLStore._is_ruyi({"source": "ajax"}))
        self.assertTrue(MySQLStore._is_ruyi({"name": "如意金积存"}))
        self.assertFalse(MySQLStore._is_ruyi({"code": "080020000521", "name": "积存金", "source": "page"}))


class StoreTests(unittest.TestCase):
    def test_append_recent_and_csv(self):
        with tempfile.TemporaryDirectory() as d:
            store = HistoryStore(os.path.join(d, "history.jsonl"), max_items=3)
            store.append([{"code": "A", "name": "积存金", "active": 1.0, "active_dir": "up"}])
            store.append([{"code": "A", "name": "积存金", "active": 2.0, "active_dir": "down"}])
            self.assertEqual(store.count(), 2)
            self.assertEqual(store.recent("A", 1)[0]["active"], 2.0)
            self.assertEqual(store.recent("B"), [])
            self.assertIn("涨", store.csv_text())
            self.assertIn("跌", store.csv_text())


class PortfolioStoreTests(unittest.TestCase):
    def test_empty_and_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            store = PortfolioStore(os.path.join(d, "portfolio-data.json"))
            self.assertEqual(store.load(), {
                "position": None, "positionNodes": [], "baselines": {}, "trades": []})
            payload = {
                "position": {"code": "A", "grams": 10, "cost": 800},
                "positionNodes": [{"at": 1, "price": 810}],
                "baselines": {"A": 812.5},
                "trades": [{"id": "t1", "type": "buy", "grams": 2}],
                "malicious": "dropped",
            }
            saved = store.save(payload)
            self.assertNotIn("malicious", saved)
            again = PortfolioStore(os.path.join(d, "portfolio-data.json")).load()
            self.assertEqual(again["position"]["grams"], 10)
            self.assertEqual(again["baselines"]["A"], 812.5)
            self.assertEqual(again["trades"][0]["id"], "t1")

    def test_corrupt_file_returns_defaults_and_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "portfolio-data.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write("{broken json")
            store = PortfolioStore(path)
            self.assertIsNone(store.load()["position"])
            store.save({"trades": [{"id": "x"}]})
            self.assertEqual(store.load()["trades"][0]["id"], "x")


class ServiceTests(unittest.TestCase):
    def test_delta_not_lost_on_cached_response(self):
        # QuoteService 现在接收 store 依赖；这里用轻量假对象，测试不依赖 MySQL
        class _FakeStore:
            def append_quotes(self, records):
                pass

            def count_quotes(self):
                return 0

        service = QuoteService(_FakeStore())
        service._cache = {"rows": [{"code": "A", "active": 100.0}], "rows_source": "seed"}
        quote = {"rows": [{"code": "A", "active": 101.5, "name": "积存金"}],
                 "fetched_at": "now", "source_time": "now"}
        result = service._with_deltas(quote, {"A": {"active": 100.0}})
        self.assertEqual(result["rows"][0]["delta_active"], 1.5)
        service._cache = result
        cached = service._stale()
        self.assertEqual(cached["rows"][0]["delta_active"], 1.5)

    def test_restore_cache_from_db_when_empty(self):
        # 收盘后启动缓存为空：从 store 只读恢复，不调用 client.fetch（不抓上游）
        snap = {"ok": True, "rows": [{"code": "A", "name": "积存金", "active": 812.5}],
                "fetched_at": "2026-11-18 23:10:00", "source_time": "2026-11-18 23:10:00",
                "restored": True}

        seen = {}

        class _FakeStore:
            def latest_snapshot(self, until=None):
                seen["until"] = until
                return snap

            def append_quotes(self, records):
                raise AssertionError("恢复不应写库")

        service = QuoteService(_FakeStore(), close_at="22:30")
        self.assertIsNone(service._cache)
        self.assertTrue(service.restore_cache_from_db())
        self.assertEqual(service._cache["rows"][0]["active"], 812.5)
        # 收盘闸门启用时应带当天收盘时刻作为截止，定格在收盘而非当天尾巴
        self.assertIsNotNone(seen["until"])
        self.assertTrue(seen["until"].endswith(" 22:30:00"))
        # 已有缓存时不覆盖
        service._cache = {"rows": [{"code": "B", "active": 1.0}]}
        self.assertTrue(service.restore_cache_from_db())
        self.assertEqual(service._cache["rows"][0]["code"], "B")

    def test_restore_cache_noop_when_no_snapshot(self):
        class _FakeStore:
            def latest_snapshot(self, until=None):
                return None

        service = QuoteService(_FakeStore())
        self.assertFalse(service.restore_cache_from_db())
        self.assertIsNone(service._cache)

    def test_restore_cache_no_until_when_gate_off(self):
        seen = {}

        class _FakeStore:
            def latest_snapshot(self, until=None):
                seen["until"] = until
                return {"ok": True, "rows": [{"code": "A", "active": 1.0}],
                        "fetched_at": "now", "source_time": "now"}

        service = QuoteService(_FakeStore(), close_at="off")
        service.restore_cache_from_db()
        self.assertIsNone(seen["until"])  # 未启用闸门：取当天最后一帧，不设截止


class CloseGateTests(unittest.TestCase):
    """每日收盘闸门：到点停采集、次日重启恢复。用纯函数与假时钟验证，不依赖真实时间。"""

    def test_parse_close_at(self):
        self.assertEqual(QuoteService._parse_close_at("22:30"), (22, 30))
        self.assertEqual(QuoteService._parse_close_at("06:05"), (6, 5))
        self.assertEqual(QuoteService._parse_close_at("off"), (None, None))
        self.assertEqual(QuoteService._parse_close_at(None), (None, None))
        self.assertEqual(QuoteService._parse_close_at("bad"), (None, None))

    def test_past_close_boundary(self):
        t = datetime(2026, 11, 18, 22, 29)
        self.assertFalse(QuoteService._past_close(t, 22, 30))
        self.assertTrue(QuoteService._past_close(datetime(2026, 11, 18, 22, 30), 22, 30))
        self.assertTrue(QuoteService._past_close(datetime(2026, 11, 18, 23, 59), 22, 30))
        # 次日凌晨：时刻 < 收盘点，若非锁存则视为未收盘（锁存由 _closed 保证）
        self.assertFalse(QuoteService._past_close(datetime(2026, 11, 19, 8, 0), 22, 30))
        # 未配置闸门时永不收盘
        self.assertFalse(QuoteService._past_close(datetime(2026, 11, 18, 23, 0), None, None))

    def test_collect_blocked_after_close(self):
        class _FakeStore:
            def __init__(self):
                self.calls = 0

            def append_quotes(self, records):
                self.calls += 1

            def count_quotes(self):
                return 0

        store = _FakeStore()
        service = QuoteService(store)
        # 模拟已到收盘点：_check_close 会锁存 _closed
        with patch.object(service, "_check_close", side_effect=lambda: setattr(service, "_closed", True)):
            result = service._collect_once(force=True)
        self.assertFalse(result)
        self.assertEqual(store.calls, 0)
        # 状态对外可见，供前端提示
        self.assertTrue(service._stale()["market_closed"])

    def test_closed_state_latches_across_midnight(self):
        """锁存后即便时钟回到次日白天，也不会自动恢复（须重启进程）。"""
        class _FakeStore:
            def append_quotes(self, records):
                pass

            def count_quotes(self):
                return 0

        service = QuoteService(_FakeStore())
        with patch("server.datetime") as dt:
            dt.now.return_value = datetime(2026, 11, 18, 22, 31)
            service._check_close()
            self.assertTrue(service._closed)
            dt.now.return_value = datetime(2026, 11, 19, 9, 0)
            service._check_close()
            self.assertTrue(service._closed)  # 仍保持收盘，未自动恢复


class AuthTests(unittest.TestCase):
    def test_password_hashed_and_verified(self):
        from auth import hash_password, verify_password
        h = hash_password("secret123")
        self.assertTrue(h.startswith("pbkdf2_sha256$"))
        self.assertNotIn("secret123", h)
        self.assertTrue(verify_password("secret123", h))
        self.assertFalse(verify_password("wrong", h))

    def test_session_signature_roundtrip(self):
        from auth import make_session, parse_session
        token = make_session(42)
        self.assertEqual(parse_session(token), 42)
        self.assertIsNone(parse_session(token + "tampered"))
        self.assertIsNone(parse_session("garbage"))


class CryptoTests(unittest.TestCase):
    def test_encrypt_decrypt_roundtrip(self):
        from crypto_util import encrypt_text, decrypt_text, encrypt_json, decrypt_json
        cipher = encrypt_text("成本 880.21")
        self.assertNotIn("880.21", cipher)
        self.assertEqual(decrypt_text(cipher), "成本 880.21")
        self.assertEqual(decrypt_json(encrypt_json({"a": [1, 2]})), {"a": [1, 2]})


if __name__ == "__main__":
    unittest.main()
