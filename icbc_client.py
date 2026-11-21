# -*- coding: utf-8 -*-
"""工行积存金行情抓取与解析。

这一层只负责「取数 + 解析」，不关心缓存、存储和 HTTP，便于单独测试。
"""
from __future__ import annotations

import html
import http.cookiejar
import re
import ssl
import time
import urllib.parse
import urllib.request
from datetime import datetime

PAGE_URL = "https://icbcphp.icbc.com.cn/icbc/newperbank/perbank3/gold/goldaccrual_query_out.jsp"

_USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

# 工行站点使用旧版 TLS 重协商，新版 Python 默认拒绝。
# OP_LEGACY_SERVER_CONNECT 是 3.10.12+/3.11.4+/3.12+ 才有的安全补丁常量，
# 老版本上用 getattr 兜底为 0，保证服务至少能启动（不因 AttributeError 崩溃）。
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.options |= getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0)

# 正则预编译：解析是 2 秒一次的热路径
_ROW_RE = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.I | re.S)
_TIME_RE = re.compile(r"更新时间\s*[:：]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})")
_ALT_RE = re.compile(r'alt\s*=\s*["\']([^"\']+)["\']', re.I)
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
_TAG_RE = re.compile(r"<[^>]+>")
_CELL_RES = {
    field: re.compile(r'id\s*=\s*["\']' + field + r'_(\d+)["\'][^>]*>(.*?)</td>', re.I | re.S)
    for field in ("prodnoo", "activeprice", "updown1", "lowprice", "highprice",
                  "regprice", "updown2", "sellprice", "updown3")
}


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _cell(row_html: str, field: str, raw: bool = False):
    """取 id 形如 field_xxx 的单元格；raw=True 保留 img 的 alt 文本。"""
    m = _CELL_RES[field].search(row_html)
    if not m:
        return None, None
    inner = m.group(2).strip()
    if raw:
        return m.group(1), (inner or None)
    return m.group(1), (html.unescape(_TAG_RE.sub("", inner)).strip() or None)


def _num(value) -> float | None:
    if value is None:
        return None
    m = _NUM_RE.search(str(value).replace(",", ""))
    return float(m.group()) if m else None


def _direction(cell_html: str | None):
    """把工行涨跌图标的 alt 文本归一为 up / down / flat。"""
    if not cell_html:
        return None
    m = _ALT_RE.search(cell_html)
    if not m:
        return None
    label = m.group(1)
    if "涨" in label or "up" in label.lower():
        return "up"
    if "跌" in label or "down" in label.lower():
        return "down"
    return "flat"


def _row(code, name, source, active, low, high, regular, redeem,
         active_dir=None, regular_dir=None, redeem_dir=None):
    return {
        "code": code, "name": name, "source": source,
        "active": active, "active_dir": active_dir,
        "low": low, "high": high,
        "regular": regular, "regular_dir": regular_dir,
        "redeem": redeem, "redeem_dir": redeem_dir,
    }


def parse_page(page_html: str):
    """解析服务端渲染的表格，返回 (rows, 工行更新时间)。"""
    rows = []
    for match in _ROW_RE.finditer(page_html):
        row = match.group(1)
        code, name = _cell(row, "prodnoo")
        if not code or not name:
            continue
        _, updown1 = _cell(row, "updown1", raw=True)
        _, updown2 = _cell(row, "updown2", raw=True)
        _, updown3 = _cell(row, "updown3", raw=True)
        rows.append(_row(
            code, name, "page",
            _num(_cell(row, "activeprice")[1]),
            _num(_cell(row, "lowprice")[1]),
            _num(_cell(row, "highprice")[1]),
            _num(_cell(row, "regprice")[1]),
            _num(_cell(row, "sellprice")[1]),
            _direction(updown1), _direction(updown2), _direction(updown3),
        ))

    time_match = _TIME_RE.search(page_html)
    source_time = time_match.group(1) if time_match else None

    # 数据合法性校验：避免解析异常时把垃圾值写进历史
    if not rows or all(r["active"] is None for r in rows):
        raise ValueError("页面中未找到有效的积存金价格")
    for row in rows:
        if row["active"] is not None and not (0 < row["active"] < 100000):
            raise ValueError(f"价格超出合理范围: {row['name']}={row['active']}")
    return rows, source_time


class IcbcClient:
    """带 Cookie 会话的工行行情客户端。"""

    def __init__(self, timeout: float = 10.0):
        self.timeout = timeout
        jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar),
            urllib.request.HTTPSHandler(context=_SSL_CTX),
        )

    def _request(self, url, data=None, referer=None, timeout=None):
        headers = {"User-Agent": _USER_AGENT, "Accept": "*/*"}
        if referer:
            headers["Referer"] = referer
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
            data = urllib.parse.urlencode(data).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers)
        started = time.perf_counter()
        with self._opener.open(req, timeout=timeout or self.timeout) as resp:
            body = resp.read()
        return body, round((time.perf_counter() - started) * 1000)

    def fetch(self) -> dict:
        """只抓取官网表格行情；异步的如意金积存行情不再采集。"""
        page_bytes, page_ms = self._request(PAGE_URL)
        rows, source_time = parse_page(page_bytes.decode("gb18030", "replace"))
        return {
            "ok": True,
            "fetched_at": now_str(),
            "source_time": source_time or now_str(),
            "rows": rows,
            "error": None,
            "latency_ms": {"page": page_ms},
        }
