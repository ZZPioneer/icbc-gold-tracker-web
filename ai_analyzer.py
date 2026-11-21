# -*- coding: utf-8 -*-
"""AI 每日行情分析模块（DeepSeek）。

设计要点：
  1. 涨跌特征全部在本地计算，即使没有 API Key 也能生成完整的特征 md 存档；
     API Key 到位后重新生成会在同一份报告里补上 DeepSeek 的文字点评。
  2. 依赖仅用标准库（urllib），不引入新的第三方包，与项目现有风格一致。
  3. 报告写入独立目录 ``行情记录/YYYY-MM-DD.md``；日期经过严格校验，防目录穿越。

数据来源：MySQL quotes 表。gran=1 日K线提供开/高/低/收；gran=0 明细提供
日内高点/低点时点、波动率、回撤等更细的盘中特征（老数据被压缩后自动降级）。
"""
from __future__ import annotations

import json
import math
import os
import re
import statistics
import urllib.request
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "ai_config.json")

DEFAULT_CONFIG = {
    "api_key": "",
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "timeout": 60,
    "auto_on_close": True,
    "report_dir": "行情记录",
}

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_DIR_LABEL = {"up": "涨", "down": "跌", "flat": "平"}


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
def load_ai_config() -> dict:
    """读取 ai_config.json，与默认值合并；文件缺失或损坏时返回默认配置。"""
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


def is_configured(cfg: dict | None = None) -> bool:
    """是否已填入有效的 DeepSeek API Key。"""
    cfg = cfg or load_ai_config()
    key = str(cfg.get("api_key") or "").strip()
    return bool(key) and not key.startswith("sk-换成") and key.lower() != "your_api_key"


def report_dir(cfg: dict | None = None) -> str:
    """报告目录的绝对路径（相对路径按项目根目录解析）。"""
    cfg = cfg or load_ai_config()
    value = str(cfg.get("report_dir") or DEFAULT_CONFIG["report_dir"]).strip()
    if os.path.isabs(value):
        path = value
    else:
        path = os.path.join(BASE_DIR, value)
    os.makedirs(path, exist_ok=True)
    return path


def _valid_day(day: str) -> str:
    """校验并规范化 YYYY-MM-DD，非法则抛 ValueError（同时防目录穿越）。"""
    if not isinstance(day, str) or not _DATE_RE.match(day.strip()):
        raise ValueError("日期格式须为 YYYY-MM-DD")
    day = day.strip()
    try:
        datetime.strptime(day, "%Y-%m-%d")
    except ValueError:
        raise ValueError("日期不合法")
    return day


# ---------------------------------------------------------------------------
# 数值工具
# ---------------------------------------------------------------------------
def _num(v):
    return v if isinstance(v, (int, float)) and math.isfinite(v) else None


def _r(v, n=4):
    """安全四舍五入：None 透传。"""
    x = _num(v)
    return round(x, n) if x is not None else None


def _pct(part, base):
    if part is None or base in (None, 0):
        return None
    return round(part / base * 100.0, 4)


def _shape(open_, close, high, low, body_pct, upper, lower) -> str:
    """根据 K 线实体/影线比例给出形态描述。"""
    if None in (open_, close, high, low):
        return "数据不足"
    rng = high - low
    if rng <= 0:
        return "全天价格持平（一字）"
    up_ratio = upper / rng
    lo_ratio = lower / rng
    body_abs = abs(body_pct or 0)
    if body_abs < 0.05:
        if up_ratio > 0.5 and lo_ratio > 0.5:
            return "长上下影·多空拉锯（十字星）"
        if lo_ratio > 0.5:
            return "下影长·探底回升（锤子线）"
        if up_ratio > 0.5:
            return "上影长·冲高回落（流星线）"
        return "小实体·窄幅震荡（十字星）"
    rising = close >= open_
    core = "阳线" if rising else "阴线"
    if lo_ratio > 0.5 and up_ratio < 0.2:
        return core + "·下影长（低位承接明显）"
    if up_ratio > 0.5 and lo_ratio < 0.2:
        return core + "·上影长（高位抛压）"
    if up_ratio > 0.4 and lo_ratio > 0.4:
        return core + "·上下影均衡（震荡加剧）"
    if up_ratio < 0.1 and lo_ratio < 0.1:
        return core + "·光头光脚（单边）"
    return core


def _direction(open_, close, prev_close, high, low, high_t, low_t) -> str:
    """结合开盘相对昨收、收盘相对开盘、高低点时点，描述盘中节奏。"""
    if None in (open_, close):
        return "数据不足"
    gap = None if prev_close in (None, 0) else (open_ - prev_close) / prev_close
    body = close - open_
    body_small = abs(body) < (0.0005 * open_)
    if gap is not None and abs(gap) >= 0.0005:
        gap_word = "高开" if gap > 0 else "低开"
    else:
        gap_word = "平开"
    if body_small:
        tail = "窄幅整理，收盘接近开盘"
    elif body > 0:
        tail = "盘中走高，收在开盘之上"
    else:
        tail = "盘中走低，收在开盘之下"
    # 高低点出现在尾盘则补充节奏描述（时点为 'HH:MM:SS' 字符串）
    extra = ""
    if high_t and low_t:
        try:
            if high_t[:2] >= "21" and low_t[:2] < "15":
                extra = "；冲高后回吐，尾盘走弱"
            elif low_t[:2] >= "21" and high_t[:2] < "15":
                extra = "；探底后回升，尾盘转强"
        except (TypeError, IndexError):
            pass
    return gap_word + "·" + tail + extra


# ---------------------------------------------------------------------------
# 特征计算
# ---------------------------------------------------------------------------
def _prev_close(store, code: str, day: str):
    """取该金种在 day 之前最近一根日K线的收盘价（作为昨收基准）。

    日K线的 fetched_at 固化为「当天 00:00:00」，而 recent_quotes 的 until 是闭区间，
    因此不能直接传 day 00:00:00（会包含当日K线本身），改用前一自然日 23:59:59。
    """
    prev_day = (datetime.strptime(day, "%Y-%m-%d").date() - timedelta(days=1)).strftime("%Y-%m-%d")
    try:
        rows = store.recent_quotes(code=code, limit=1, gran=1, until=prev_day + " 23:59:59")
    except Exception:
        return None
    return _num(rows[-1].get("active")) if rows else None


def compute_features(store, day: str, until: str | None = None) -> dict:
    """计算指定交易日的涨跌特征。返回可直接渲染/送 AI 的结构化数据。

    使用 gran=1 日K线取开高低收（收盘=active），gran=0 明细取盘中细节。
    若当日尚无日K线（如未收盘），则用明细自行聚合出 OHLC。
    until: 可选的 'YYYY-MM-DD HH:MM:SS' 上限，用于收盘后把明细定格在收盘点。
    """
    day = _valid_day(day)
    day_start = day + " 00:00:00"
    day_end = until or (day + " 23:59:59")

    try:
        klines = store.recent_quotes(limit=20000, gran=1, since=day_start, until=day_end)
    except Exception:
        klines = []
    try:
        raws = store.recent_quotes(limit=20000, gran=0, since=day_start, until=day_end)
    except Exception:
        raws = []

    # 收集当日出现的金种代码（排除如意金积存）
    codes = sorted({r.get("code") for r in klines if r.get("code") and r.get("code") != "080020000501"})
    codes += [c for c in sorted({r.get("code") for r in raws
                                 if r.get("code") and r.get("code") != "080020000501"}) if c not in codes]
    if not codes:
        return {"day": day, "gold": [], "summary": {"count": 0}, "empty": True,
                "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}

    kline_by_code = {c: [r for r in klines if r.get("code") == c] for c in codes}
    raw_by_code = {c: [r for r in raws if r.get("code") == c] for c in codes}

    gold_list = []
    for code in codes:
        k = kline_by_code[code]
        raw = raw_by_code[code]
        name = None
        for row in (k or raw):
            if row.get("name"):
                name = row["name"]
        name = name or code

        # OHLC：优先日K线，缺失则用明细聚合
        if k:
            bar = k[-1]
            open_ = _num(bar.get("open_price"))
            close = _num(bar.get("active"))
            high = _num(bar.get("high"))
            low = _num(bar.get("low"))
        else:
            acts = [_num(x.get("active")) for x in raw if _num(x.get("active")) is not None]
            hi = [_num(x.get("high")) for x in raw if _num(x.get("high")) is not None]
            lo = [_num(x.get("low")) for x in raw if _num(x.get("low")) is not None]
            open_ = acts[0] if acts else None
            close = acts[-1] if acts else None
            high = max(hi + acts) if (hi or acts) else None
            low = min(lo + acts) if (lo or acts) else None

        prev = _prev_close(store, code, day)
        baseline = prev if prev is not None else open_  # 无昨收时退回开盘价做参考
        baseline_kind = "昨收" if prev is not None else "今开(无昨收数据)"

        chg = round(close - baseline, 4) if (close is not None and baseline is not None) else None
        chg_pct = _pct(close - baseline, baseline) if (close is not None and baseline is not None) else None
        body = round(close - open_, 4) if (close is not None and open_ is not None) else None
        body_pct = _pct(close - open_, open_) if (close is not None and open_) else None
        amplitude = _pct(high - low, baseline) if (high is not None and low is not None and baseline) else None

        hi_idx = lo_idx = None
        hi_t = lo_t = None
        acts_series = [(_num(x.get("active")), str(x.get("fetched_at") or "")[11:19])
                       for x in raw if _num(x.get("active")) is not None]
        if acts_series:
            hi_idx = max(range(len(acts_series)), key=lambda i: acts_series[i][0])
            lo_idx = min(range(len(acts_series)), key=lambda i: acts_series[i][0])
            hi_t = acts_series[hi_idx][1] or None
            lo_t = acts_series[lo_idx][1] or None

        upper = round(high - max(open_, close), 4) if None not in (high, open_, close) else None
        lower = round(min(open_, close) - low, 4) if None not in (low, open_, close) else None

        # 盘中波动率/最大回撤（基于明细 active 序列）
        prices = [p for p, _ in acts_series]
        vol = round(statistics.pstdev(prices), 4) if len(prices) >= 2 else None
        max_dd = None
        if prices:
            peak = prices[0]
            dds = []
            for p in prices:
                peak = max(peak, p)
                if peak:
                    dds.append((p - peak) / peak * 100)
            max_dd = round(min(dds), 4) if dds else None

        gold_list.append({
            "code": code,
            "name": name,
            "baseline": _r(baseline),
            "baseline_kind": baseline_kind,
            "open": _r(open_),
            "close": _r(close),
            "high": _r(high),
            "low": _r(low),
            "change": _r(chg),
            "change_pct": _r(chg_pct),
            "body": _r(body),
            "body_pct": _r(body_pct),
            "amplitude_pct": _r(amplitude),
            "upper_shadow": _r(upper),
            "lower_shadow": _r(lower),
            "shape": _shape(open_, close, high, low, body_pct, upper or 0, lower or 0),
            "direction": _direction(open_, close, prev, high, low, hi_t, lo_t),
            "high_time": hi_t,
            "low_time": lo_t,
            "intraday_volatility": vol,
            "max_drawdown_pct": _r(max_dd),
            "samples": len(prices),
        })

    # 汇总：涨跌家数、涨跌幅极值、平均涨跌
    valid = [g for g in gold_list if g.get("change_pct") is not None]
    up = sum(1 for g in valid if g["change_pct"] > 0)
    down = sum(1 for g in valid if g["change_pct"] < 0)
    flat = sum(1 for g in valid if g["change_pct"] == 0)
    summary = {
        "count": len(gold_list),
        "up": up, "down": down, "flat": flat,
        "avg_change_pct": _r(statistics.mean([g["change_pct"] for g in valid])) if valid else None,
    }
    if valid:
        top = max(valid, key=lambda g: g["change_pct"])
        bottom = min(valid, key=lambda g: g["change_pct"])
        summary["top"] = {"name": top["name"], "change_pct": top["change_pct"]}
        summary["bottom"] = {"name": bottom["name"], "change_pct": bottom["change_pct"]}

    return {
        "day": day,
        "gold": gold_list,
        "summary": summary,
        "empty": False,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


# ---------------------------------------------------------------------------
# AI 调用
# ---------------------------------------------------------------------------
def build_prompt(features: dict) -> str:
    """把结构化特征压缩成给 DeepSeek 的中文提示词。"""
    payload = {
        "日期": features.get("day"),
        "汇总": features.get("summary"),
        "各金种特征": [{k: g.get(k) for k in (
            "name", "baseline_kind", "baseline", "open", "close", "high", "low",
            "change", "change_pct", "body_pct", "amplitude_pct", "upper_shadow",
            "lower_shadow", "shape", "direction", "high_time", "low_time",
            "intraday_volatility", "max_drawdown_pct", "samples")}
            for g in features.get("gold", [])],
    }
    data_json = json.dumps(payload, ensure_ascii=False, indent=2)
    return (
        "你是一位严谨的黄金市场分析师。以下是某日工商银行积存金的量化行情特征（由 4 秒级快照与日K线统计得出）。"
        "请基于这些数据做当日复盘分析，不要编造数据中没有的信息。\n\n"
        "要求：\n"
        "1. 用中文，专业但通俗，分四个小节：①当日综述 ②涨跌特征解读 ③走势形态与多空力量 ④后市关注点。\n"
        "2. 引用具体数值（涨跌幅、振幅、高点/低点时点、上下影线、回撤等）支撑判断。\n"
        "3. 结尾加一句风险提示，说明数据来源可能有延迟、不构成投资建议。\n"
        "4. 输出 Markdown，不要使用一级标题（#），小节用二级标题（##）。\n\n"
        "数据：\n" + data_json
    )


def call_deepseek(features: dict, cfg: dict | None = None) -> dict:
    """调用 DeepSeek Chat Completions（OpenAI 兼容）。返回 {status, text, error}。

    status: ok=成功 / no_key=未配置 / error=调用失败（均已降级，不影响 md 生成）。
    """
    cfg = cfg or load_ai_config()
    if not is_configured(cfg):
        return {"status": "no_key", "text": "", "error": ""}
    url = str(cfg.get("base_url") or DEFAULT_CONFIG["base_url"]).rstrip("/") + "/chat/completions"
    model = str(cfg.get("model") or DEFAULT_CONFIG["model"])
    timeout = cfg.get("timeout", DEFAULT_CONFIG["timeout"])
    try:
        timeout = float(timeout)
    except (TypeError, ValueError):
        timeout = 60.0
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "你是专业的黄金行情复盘分析师，回答简洁、客观、有数据支撑。"},
            {"role": "user", "content": build_prompt(features)},
        ],
        "stream": False,
        "temperature": 0.6,
        "max_tokens": 1400,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + str(cfg["api_key"]).strip(),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
        parsed = json.loads(raw)
        text = parsed["choices"][0]["message"]["content"].strip()
        return {"status": "ok", "text": text, "error": ""}
    except Exception as exc:  # 网络/鉴权/解析任何失败都降级，不阻断存档
        return {"status": "error", "text": "", "error": f"{type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------------------
# Markdown 渲染
# ---------------------------------------------------------------------------
def _fmt(v, suffix="", digits=4):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.{digits}f}{suffix}"
    return f"{v}{suffix}"


def render_markdown(features: dict, ai: dict) -> str:
    day = features["day"]
    summary = features.get("summary", {})
    lines = [
        f"# 积存金行情复盘 · {day}",
        "",
        f"> 由本地采集数据自动生成 · 生成时间 {features.get('generated_at', '')}",
        "> 涨跌基准：优先取上一交易日日K线收盘价；无昨收数据时改用当日开盘价（表中已标注）。",
        "",
        "## 一、当日概览",
        "",
    ]
    if features.get("empty"):
        lines.append("当日暂无行情数据（尚未开盘采集，或历史明细已被压缩且无日K线）。")
        return "\n".join(lines) + "\n"

    avg = _fmt(summary.get("avg_change_pct"), "%")
    leaders = ""
    if summary.get("count", 0) > 1 and summary.get("top") and summary.get("bottom"):
        leaders = (f"；领涨 **{summary['top']['name']}（{_fmt(summary['top']['change_pct'], '%')}）**"
                   f"，领跌 **{summary['bottom']['name']}（{_fmt(summary['bottom']['change_pct'], '%')}）**")
    lines += [
        f"- 收录金种：**{summary.get('count', 0)}** 个；上涨 **{summary.get('up', 0)}** / 下跌 **{summary.get('down', 0)}** / 持平 **{summary.get('flat', 0)}**。",
        f"- 平均涨跌幅：**{avg}**{leaders}。",
        "",
        "## 二、涨跌特征明细",
        "",
        "| 金种 | 基准 | 开盘 | 最高 | 最低 | 收盘 | 涨跌额 | 涨跌幅 | 振幅 | 实体 | 上影 | 下影 |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for g in features["gold"]:
        lines.append("| {name} | {base}({kind}) | {o} | {h} | {l} | {c} | {chg} | {pct} | {amp} | {body} | {up} | {lo} |".format(
            name=g.get("name") or g.get("code"),
            base=_fmt(g.get("baseline")),
            kind=g.get("baseline_kind") or "—",
            o=_fmt(g.get("open")), h=_fmt(g.get("high")), l=_fmt(g.get("low")), c=_fmt(g.get("close")),
            chg=_fmt(g.get("change")), pct=_fmt(g.get("change_pct"), "%"),
            amp=_fmt(g.get("amplitude_pct"), "%"), body=_fmt(g.get("body")),
            up=_fmt(g.get("upper_shadow")), lo=_fmt(g.get("lower_shadow")),
        ))

    lines += ["", "## 三、盘中行为特征", "",
              "| 金种 | K线形态 | 盘中节奏 | 最高点时刻 | 最低点时刻 | 日内波动率 | 最大回撤 | 样本数 |",
              "|---|---|---|---|---:|---:|---:|"]
    for g in features["gold"]:
        lines.append("| {name} | {shape} | {direc} | {ht} | {lt} | {vol} | {dd} | {n} |".format(
            name=g.get("name") or g.get("code"),
            shape=g.get("shape") or "—", direc=g.get("direction") or "—",
            ht=g.get("high_time") or "—", lt=g.get("low_time") or "—",
            vol=_fmt(g.get("intraday_volatility")), dd=_fmt(g.get("max_drawdown_pct"), "%"),
            n=g.get("samples", 0),
        ))

    lines += ["", "## 四、AI 复盘点评", ""]
    if ai.get("status") == "ok" and ai.get("text"):
        lines += [ai["text"].strip(), ""]
    elif ai.get("status") == "no_key":
        lines += [
            "> ⚠️ 尚未配置 DeepSeek API Key，已跳过 AI 点评；上方量化特征已完整记录。",
            "> 配置方法：打开项目根目录 `ai_config.json`，把 `api_key` 填入你的 DeepSeek Key，",
            "> 然后在网页「AI 每日分析」中重新生成，即可补上 AI 点评。",
            "",
        ]
    else:
        lines += [
            f"> ⚠️ AI 点评生成失败（{ai.get('error', '未知错误')}），量化特征不受影响。",
            "> 可稍后在网页「AI 每日分析」中重新生成重试。",
            "",
        ]

    lines += ["---", "", "*数据来源：工行官网公开行情页面；可能有延迟，交易决策请以工商银行实际成交价为准。*"]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# 编排与文件管理
# ---------------------------------------------------------------------------
def _report_path(day: str, cfg: dict | None = None) -> str:
    return os.path.join(report_dir(cfg), _valid_day(day) + ".md")


def analyze_day(store, day: str, cfg: dict | None = None, force: bool = False,
                call_ai: bool = True, until: str | None = None) -> dict:
    """分析指定日期并写入 md。返回 {ok, day, path, features, ai, exists, error}。

    force=False 且报告已存在时直接返回 exists=True（收盘自动触发避免重复调用 AI）。
    until: 收盘后把当日明细定格到收盘点（'YYYY-MM-DD HH:MM:SS'）。
    """
    cfg = cfg or load_ai_config()
    try:
        day = _valid_day(day)
    except ValueError as exc:
        return {"ok": False, "day": day, "error": str(exc)}
    path = _report_path(day, cfg)
    if os.path.exists(path) and not force:
        return {"ok": True, "day": day, "path": path, "exists": True, "error": ""}

    try:
        features = compute_features(store, day, until=until)
        ai = call_deepseek(features, cfg) if call_ai else {"status": "skipped", "text": "", "error": ""}
        md = render_markdown(features, ai)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(md)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        return {"ok": True, "day": day, "path": path, "features": features,
                "ai": ai, "exists": False, "error": ""}
    except Exception as exc:
        return {"ok": False, "day": day, "error": f"{type(exc).__name__}: {exc}"}


def list_reports(cfg: dict | None = None) -> list[dict]:
    """列出已有报告（按日期倒序）。每项含 date / filename / size / mtime / title。"""
    cfg = cfg or load_ai_config()
    d = report_dir(cfg)
    items = []
    for name in os.listdir(d):
        if not name.endswith(".md") or not _DATE_RE.match(name[:-3]):
            continue
        p = os.path.join(d, name)
        try:
            st = os.stat(p)
            title = ""
            with open(p, "r", encoding="utf-8") as f:
                for _ in range(3):
                    line = f.readline().strip()
                    if line.startswith("# "):
                        title = line[2:].strip()
                        break
            items.append({"date": name[:-3], "filename": name, "size": st.st_size,
                          "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                          "title": title})
        except OSError:
            continue
    items.sort(key=lambda x: x["date"], reverse=True)
    return items


def read_report(day: str, cfg: dict | None = None) -> str | None:
    """读取某日报告全文；不存在或日期非法返回 None。"""
    cfg = cfg or load_ai_config()
    try:
        path = _report_path(day, cfg)
    except ValueError:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None
