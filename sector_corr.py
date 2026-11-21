#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""盘面分析：A 股板块涨跌 与 黄金涨跌 的相关性研究。

数据链路
--------
1. 板块与成分股：读云图缓存 ``marketmap-cache/all.json``（申万一级 31 个行业）
2. 板块历史：每个板块按流通市值取 Top N 成分股，拉取日 K，按流通市值加权
   合成板块日收益率序列（停牌股自动剔除，不做价格跳跃错配）
3. 黄金基准：黄金 ETF 518880（A 股交易时段，与板块完全对齐，主基准）
4. 统计：Pearson r、Spearman ρ、t 检验 p 值、BH-FDR 多重检验校正、
   60 日滚动相关、领先滞后相关、beta 敏感度

所有外部抓取都带磁盘缓存（按自然日失效），避免反复打行情接口。
"""
from __future__ import annotations

import json
import math
import os
import ssl
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MAP_CACHE_DIR = os.path.join(BASE_DIR, "marketmap-cache")
KLINE_DIR = os.path.join(MAP_CACHE_DIR, "kline")
CORR_DIR = os.path.join(MAP_CACHE_DIR, "corr")

# 黄金基准：518880 华安黄金ETF 跟踪上海金，交易时段与 A 股板块一致，最适合做相关性
BENCHMARKS = {
    "gold_etf": {
        "key": "gold_etf",
        "name": "黄金ETF(518880)",
        "symbol": "sh518880",
        "note": "跟踪上海金，A股交易时段，与板块时段完全对齐",
    },
    "gold_stock": {
        "key": "gold_stock",
        "name": "黄金股指数(山东黄金)",
        "symbol": "sh600547",
        "note": "黄金采选龙头，反映黄金板块股票情绪",
    },
}

# 分析窗口（交易日）
WINDOWS = [
    {"key": 60, "name": "近60日"},
    {"key": 120, "name": "近120日"},
    {"key": 250, "name": "近250日"},
]

DEFAULT_BENCH = "gold_etf"
DEFAULT_WINDOW = 250
DEFAULT_MAX_MEMBERS = 12       # 每板块取流通市值前 N 只成分股
KLINE_DATALEN = 340            # 拉取日 K 条数（覆盖 250 交易日 + 缓冲）
MIN_BARS = 30                  # 单只股票/单板块参与计算的最小样本条数
CACHE_TTL_SECONDS = 3600 * 6   # 结果缓存 6 小时

_CACHE = {}                    # key -> (payload, ts)
_LOCK = threading.RLock()
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


# ============================================================
# 基础工具
# ============================================================
def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _http_json(url: str, referer: str = "", timeout: float = 12.0):
    req = urllib.request.Request(url, headers={
        "User-Agent": _UA,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": referer,
    })
    with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
        raw = resp.read()
    text = raw.decode("utf-8", "replace").strip()
    # 新浪偶尔返回 JSONP / 空响应
    if text.endswith(";") and not text.startswith("[") and not text.startswith("{"):
        text = text.rstrip(";")
    return json.loads(text)


def to_symbol(code: str) -> str:
    """'601138.SH' -> 'sh601138'；'430047.BJ' -> 'bj430047'。"""
    parts = str(code or "").split(".")
    num = parts[0].strip()
    mkt = (parts[1] if len(parts) > 1 else "SH").strip().upper()
    pre = {"SH": "sh", "SZ": "sz", "BJ": "bj"}.get(mkt, "sh")
    return pre + num


# ============================================================
# 日 K 抓取（新浪优先，腾讯兜底，磁盘缓存按自然日失效）
# ============================================================
def _cache_file(symbol: str) -> str:
    return os.path.join(KLINE_DIR, symbol + ".json")


def _read_kline_cache(symbol: str):
    path = _cache_file(symbol)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)
        if obj.get("asof") != _today():
            return None
        bars = obj.get("bars") or []
        return [(b[0], float(b[1])) for b in bars] if bars else None
    except (OSError, ValueError, TypeError, IndexError):
        return None


def _write_kline_cache(symbol: str, bars):
    try:
        os.makedirs(KLINE_DIR, exist_ok=True)
        tmp = _cache_file(symbol) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"asof": _today(), "bars": [[d, c] for d, c in bars]},
                      f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, _cache_file(symbol))
    except OSError:
        pass


def _fetch_sina(symbol: str, datalen: int):
    url = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
           "CN_MarketData.getKLineData?symbol=%s&scale=240&ma=no&datalen=%d"
           % (symbol, datalen))
    data = _http_json(url, referer="https://finance.sina.com.cn/")
    if not isinstance(data, list):
        return None
    out = []
    for row in data:
        try:
            day = str(row["day"])[:10]
            close = float(row["close"])
        except (KeyError, TypeError, ValueError):
            continue
        if close > 0 and day:
            out.append((day, close))
    return out or None


def _fetch_tencent(symbol: str, datalen: int):
    url = ("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=%s,day,,,%d,qfq"
           % (symbol, datalen))
    data = _http_json(url, referer="https://gu.qq.com/")
    if not isinstance(data, dict):
        return None
    node = ((data.get("data") or {}).get(symbol) or {})
    bars = node.get("qfqday") or node.get("day") or []
    out = []
    for b in bars:
        try:
            day = str(b[0])[:10]
            close = float(b[2])
        except (IndexError, TypeError, ValueError):
            continue
        if close > 0 and day:
            out.append((day, close))
    return out or None


def fetch_kline(symbol: str, datalen: int = KLINE_DATALEN, force: bool = False):
    """返回 [(date, close), ...]，升序。失败返回 None。"""
    if not force:
        hit = _read_kline_cache(symbol)
        if hit and len(hit) >= 20:
            return hit
    for fn in (_fetch_sina, _fetch_tencent):
        try:
            bars = fn(symbol, datalen)
        except Exception:
            bars = None
        if bars and len(bars) >= 20:
            _write_kline_cache(symbol, bars)
            return bars
    return _read_kline_cache(symbol)  # 网络失败时退回旧缓存


def fetch_many(symbols, datalen: int = KLINE_DATALEN, workers: int = 10, force: bool = False):
    """并发抓取多只股票日 K，返回 {symbol: [(date, close), ...]}。"""
    result = {}
    if not symbols:
        return result
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_kline, s, datalen, force): s for s in symbols}
        for fut, sym in futures.items():
            try:
                bars = fut.result()
            except Exception:
                bars = None
            if bars:
                result[sym] = bars
    return result


# ============================================================
# 统计函数（纯 Python 实现，不依赖 numpy/scipy）
# ============================================================
def pearson(x, y):
    n = len(x)
    if n < 3 or n != len(y):
        return None
    mx = sum(x) / n
    my = sum(y) / n
    sxy = sxx = syy = 0.0
    for a, b in zip(x, y):
        da = a - mx
        db = b - my
        sxy += da * db
        sxx += da * da
        syy += db * db
    if sxx <= 0 or syy <= 0:
        return None
    r = sxy / math.sqrt(sxx * syy)
    return max(-1.0, min(1.0, r))


def ranks(values):
    """平均秩（正确处理并列）。"""
    n = len(values)
    order = sorted(range(n), key=lambda i: values[i])
    out = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            out[order[k]] = avg
        i = j + 1
    return out


def spearman(x, y):
    if len(x) < 3 or len(x) != len(y):
        return None
    return pearson(ranks(x), ranks(y))


def _betacf(a, b, x):
    """不完全 beta 函数的连分式（Lentz 算法）。"""
    MAXIT, EPS, FPMIN = 300, 3e-16, 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < FPMIN:
        d = FPMIN
    d = 1.0 / d
    h = d
    for m in range(1, MAXIT + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < EPS:
            break
    return h


def _betai(a, b, x):
    """正则化不完全 beta 函数 I_x(a, b)。"""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbeta = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
    bt = math.exp(lbeta + a * math.log(x) + b * math.log(1.0 - x))
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


def t_pvalue(t, df):
    """双尾 t 检验 p 值。"""
    if df <= 0 or t is None:
        return None
    x = df / (df + t * t)
    return _betai(df / 2.0, 0.5, x)


def corr_pvalue(r, n):
    """相关系数的双尾显著性 p 值。"""
    if r is None or n is None or n < 3:
        return None
    if abs(r) >= 1.0:
        return 0.0
    df = n - 2
    t = r * math.sqrt(df / (1.0 - r * r))
    return t_pvalue(t, df)


def bh_fdr(pvalues):
    """Benjamini-Hochberg 多重检验校正，返回与输入同序的 q 值。"""
    m = len(pvalues)
    if m == 0:
        return []
    idx = sorted(range(m), key=lambda i: (pvalues[i] is None, pvalues[i] if pvalues[i] is not None else 1.0))
    adj = [1.0] * m
    prev = 1.0
    for rank in range(m - 1, -1, -1):
        i = idx[rank]
        p = pvalues[i]
        if p is None:
            adj[i] = 1.0
            continue
        val = p * m / (rank + 1)
        prev = min(prev, val)
        adj[i] = max(0.0, min(1.0, prev))
    return adj


def stddev(values):
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / (n - 1)
    return math.sqrt(max(0.0, var))


def rolling_corr(x, y, window):
    """滚动 Pearson 相关，返回与 x 等长的列表（不足窗口为 None）。"""
    n = len(x)
    out = [None] * n
    if window < 3 or n < window:
        return out
    for end in range(window - 1, n):
        seg_x = x[end - window + 1:end + 1]
        seg_y = y[end - window + 1:end + 1]
        out[end] = pearson(seg_x, seg_y)
    return out


def strength_label(r):
    """按 |r| 给出强度标签。"""
    if r is None:
        return "样本不足"
    a = abs(r)
    if a >= 0.7:
        return "极强"
    if a >= 0.5:
        return "强"
    if a >= 0.3:
        return "中等"
    if a >= 0.15:
        return "弱"
    return "几乎无关"


def direction_label(r):
    if r is None:
        return "unknown"
    if r >= 0.15:
        return "positive"
    if r <= -0.15:
        return "negative"
    return "neutral"


# ============================================================
# 板块与成分股
# ============================================================
def load_sectors(max_members: int = DEFAULT_MAX_MEMBERS):
    """从云图缓存读取板块与 Top N 成分股。

    返回 [{'name':..., 'members':[{'code','name','symbol','weight'}], 'total':int}, ...]
    """
    path = os.path.join(MAP_CACHE_DIR, "all.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []

    sectors = []
    seen = set()
    for board in data.get("nodes") or []:
        name = (board.get("name") or "").strip()
        if not name or name in seen:
            continue
        children = board.get("children") or []
        if len(children) < 3:
            continue
        seen.add(name)
        ranked = sorted(children, key=lambda s: -(s.get("value") or 0))[:max_members]
        members = []
        for s in ranked:
            code = s.get("code") or ""
            if not code:
                continue
            members.append({
                "code": code,
                "name": s.get("name") or code,
                "symbol": to_symbol(code),
                "weight": float(s.get("value") or 1.0),
            })
        if len(members) >= 3:
            sectors.append({"name": name, "members": members, "total": len(children)})
    return sectors


def _prev_map(bars):
    """{date: 前一交易日}，用于识别停牌导致的跨期价格跳跃。"""
    out = {}
    for i in range(1, len(bars)):
        out[bars[i][0]] = bars[i - 1][0]
    return out


def _sector_returns(members, klines):
    """按流通市值加权合成板块日收益率 {date: ret}。"""
    prepared = []
    for m in members:
        bars = klines.get(m["symbol"])
        if not bars or len(bars) < MIN_BARS:
            continue
        close = {}
        for d, c in bars:
            if c and c > 0:
                close[d] = c
        if len(close) < MIN_BARS:
            continue
        prepared.append({"close": close, "prev": _prev_map(bars), "w": m["weight"]})
    if not prepared:
        return {}, 0

    dates = sorted({d for p in prepared for d in p["close"]})
    rets = {}
    for i in range(1, len(dates)):
        d0, d1 = dates[i - 1], dates[i]
        num = den = 0.0
        for p in prepared:
            close, prev = p["close"], p["prev"]
            c0, c1 = close.get(d0), close.get(d1)
            if not c0 or not c1:
                continue
            # 只接受「d0 确实是该股 d1 的前一交易日」，避免停牌跨期错配
            if prev.get(d1) != d0:
                continue
            num += p["w"] * (c1 / c0 - 1.0)
            den += p["w"]
        if den > 0:
            rets[d1] = num / den
    return rets, len(prepared)


def _bench_returns(bench_key, klines):
    cfg = BENCHMARKS.get(bench_key) or BENCHMARKS[DEFAULT_BENCH]
    bars = klines.get(cfg["symbol"])
    if not bars:
        return {}
    rets = {}
    prev = None
    for d, c in bars:
        if prev is not None and prev > 0 and c > 0:
            rets[d] = c / prev - 1.0
        prev = c
    return rets


def _cumulate(rets, dates):
    """由日收益率序列生成累计净值（起点 1.0）。"""
    out = []
    level = 1.0
    for d in dates:
        r = rets.get(d)
        if r is not None:
            level *= (1.0 + r)
        out.append(round(level - 1.0, 6))
    return out


# ============================================================
# 主分析
# ============================================================
def _result_file(bench_key, window):
    return os.path.join(CORR_DIR, "%s_%d.json" % (bench_key, window))


def _load_result_file(bench_key, window):
    path = _result_file(bench_key, window)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _save_result_file(bench_key, window, payload):
    try:
        os.makedirs(CORR_DIR, exist_ok=True)
        tmp = _result_file(bench_key, window) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, _result_file(bench_key, window))
    except OSError:
        pass


def analyze(bench: str = DEFAULT_BENCH, window: int = DEFAULT_WINDOW,
            force: bool = False, max_members: int = DEFAULT_MAX_MEMBERS):
    """计算全部板块与黄金基准的相关性。

    返回完整结果（含各板块序列），字段：
      meta / sectors[i] = {name, r, rho, p, p_adj, n, beta, r2, strength, direction,
                            lead_lag, vol, dates, cum_sector, cum_bench, rolling, scatter}
    """
    bench = bench if bench in BENCHMARKS else DEFAULT_BENCH
    try:
        window = int(window)
    except (TypeError, ValueError):
        window = DEFAULT_WINDOW
    if window not in [w["key"] for w in WINDOWS]:
        window = DEFAULT_WINDOW

    key = "corr:%s:%d:%d" % (bench, window, max_members)
    now = datetime.now().timestamp()
    if not force:
        with _LOCK:
            hit = _CACHE.get(key)
            if hit and now - hit[1] < CACHE_TTL_SECONDS:
                return hit[0]
        cached = _load_result_file(bench, window)
        if cached and cached.get("max_members") == max_members:
            with _LOCK:
                _CACHE[key] = (cached, now)
            return cached

    sectors = load_sectors(max_members)
    if not sectors:
        return {"ok": False, "error": "云图板块数据不可用，请先打开一次大盘云图预热数据", "sectors": []}

    # 唯一 symbol 并发抓取
    symbols = []
    seen = set()
    bench_sym = BENCHMARKS[bench]["symbol"]
    for s in sectors:
        for m in s["members"]:
            if m["symbol"] not in seen:
                seen.add(m["symbol"])
                symbols.append(m["symbol"])
    if bench_sym not in seen:
        symbols.append(bench_sym)

    klines = fetch_many(symbols, KLINE_DATALEN, workers=10, force=False)
    bench_rets = _bench_returns(bench, klines)
    if len(bench_rets) < 30:
        return {"ok": False, "error": "黄金基准历史数据获取失败，请稍后重试", "sectors": []}

    rows = []
    skipped = []
    for s in sectors:
        rets, used = _sector_returns(s["members"], klines)
        if len(rets) < 30:
            skipped.append(s["name"])
            continue
        dates = sorted(set(rets) & set(bench_rets))
        if len(dates) < 30:
            skipped.append(s["name"])
            continue
        dates = dates[-window:]
        x = [bench_rets[d] for d in dates]     # 黄金
        y = [rets[d] for d in dates]           # 板块

        r = pearson(x, y)
        rho = spearman(x, y)
        p = corr_pvalue(r, len(dates))

        bvol = stddev(x)
        svol = stddev(y)
        beta = None
        if bvol > 0:
            beta = r * svol / bvol if r is not None else None
        r2 = (r * r) if r is not None else None

        # 领先滞后：板块领先黄金 / 黄金领先板块
        lead_lag = {}
        if len(dates) >= 20:
            lead_lag["sector_leads"] = pearson(y[:-1], x[1:])
            lead_lag["gold_leads"] = pearson(x[:-1], y[1:])

        # 滚动相关窗口自适应：样本越短窗口越小，保证曲线有足够点
        rwin = max(20, min(60, len(dates) // 4))

        rows.append({
            "name": s["name"],
            "r": round(r, 4) if r is not None else None,
            "rho": round(rho, 4) if rho is not None else None,
            "p": p,
            "n": len(dates),
            "beta": round(beta, 4) if beta is not None else None,
            "r2": round(r2, 4) if r2 is not None else None,
            "vol": round(svol, 6),
            "bench_vol": round(bvol, 6),
            "strength": strength_label(r),
            "direction": direction_label(r),
            "members": used,
            "member_total": s["total"],
            "lead_lag": {k: (round(v, 4) if v is not None else None) for k, v in lead_lag.items()},
            "dates": dates,
            "cum_sector": _cumulate(rets, dates),
            "cum_bench": _cumulate(bench_rets, dates),
            "rolling": [round(v, 4) if v is not None else None
                        for v in rolling_corr(x, y, rwin)],
            "rolling_window": rwin,
            "scatter": [[round(a, 5), round(b, 5)] for a, b in zip(x, y)],
        })

    if not rows:
        return {"ok": False, "error": "所有板块样本不足，无法计算相关性", "sectors": []}

    # BH-FDR 多重检验校正（保留原始精度，极小值不要被 round 抹成 0）
    qvals = bh_fdr([row["p"] for row in rows])
    for row, q in zip(rows, qvals):
        row["p_adj"] = q

    rows.sort(key=lambda x: -(abs(x["r"]) if x["r"] is not None else -1))

    # 基准自身表现
    bench_dates = rows[0]["dates"]
    bench_cum = rows[0]["cum_bench"]
    bench_total = bench_cum[-1] if bench_cum else 0.0

    payload = {
        "ok": True,
        "bench": bench,
        "bench_name": BENCHMARKS[bench]["name"],
        "bench_note": BENCHMARKS[bench]["note"],
        "window": window,
        "max_members": max_members,
        "date_from": bench_dates[0] if bench_dates else "",
        "date_to": bench_dates[-1] if bench_dates else "",
        "sample": len(bench_dates),
        "bench_total_return": round(bench_total, 6),
        "bench_vol_annual": round(stddev([bench_rets[d] for d in bench_dates]) * math.sqrt(250), 6),
        "sector_count": len(rows),
        "skipped": skipped,
        "computed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "sectors": rows,
    }

    with _LOCK:
        _CACHE[key] = (payload, now)
    _save_result_file(bench, window, payload)
    return payload


def summary(payload):
    """裁掉大数组，返回轻量摘要供列表接口使用。"""
    if not payload:
        return payload
    out = {k: v for k, v in payload.items() if k != "sectors"}
    out["sectors"] = []
    for row in payload.get("sectors") or []:
        light = {k: v for k, v in row.items()
                 if k not in ("dates", "cum_sector", "cum_bench", "rolling", "scatter")}
        out["sectors"].append(light)
    return out


def detail(bench: str = DEFAULT_BENCH, window: int = DEFAULT_WINDOW, sector: str = ""):
    """返回单个板块的完整序列，供散点图/走势对比/滚动相关使用。"""
    payload = analyze(bench, window)
    if not payload or not payload.get("ok"):
        return payload
    for row in payload.get("sectors") or []:
        if row["name"] == sector:
            return {"ok": True, "bench_name": payload["bench_name"],
                    "window": payload["window"], "sector": row}
    return {"ok": False, "error": "未找到板块：%s" % sector}


def options():
    return {
        "ok": True,
        "benchmarks": [{"key": k, "name": v["name"], "note": v["note"]}
                       for k, v in BENCHMARKS.items()],
        "windows": WINDOWS,
        "default_bench": DEFAULT_BENCH,
        "default_window": DEFAULT_WINDOW,
    }
