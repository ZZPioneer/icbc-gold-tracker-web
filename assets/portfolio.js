/* 持仓盈亏计算（纯函数，便于单测） */
(function (root) {
  "use strict";

  function calc(position, price) {
    if (!position || !(Number(price) > 0)) return null;
    var grams = Number(position.grams);
    var cost = Number(position.cost);
    var total = position.total == null ? null : Number(position.total);
    if (!(grams > 0) || !(cost > 0) && !(total > 0)) return null;

    var costTotal = (total != null && total > 0) ? total : grams * cost;
    var effectiveCost = costTotal / grams;
    var market = grams * price;
    var pnl = market - costTotal;
    var pnlPct = costTotal ? pnl / costTotal * 100 : 0;

    return {
      grams: grams,
      price: price,
      costTotal: costTotal,
      effectiveCost: effectiveCost,
      market: market,
      pnl: pnl,
      pnlPct: pnlPct,
      ratio: costTotal ? Math.max(0, Math.min(100, market / costTotal * 100)) : 0,
      breakEven: price > 0 ? Math.max(0, (effectiveCost / price - 1) * 100) : 0
    };
  }

  function effectiveCostOf(position) {
    if (!position) return null;
    var grams = Number(position.grams);
    var cost = Number(position.cost);
    var total = position.total == null ? null : Number(position.total);
    if (!(grams > 0)) return null;
    return (total != null && total > 0) ? total / grams : cost;
  }

  function pnlPercent(position, price) {
    var effectiveCost = effectiveCostOf(position);
    if (effectiveCost == null || !(effectiveCost > 0) || !(Number(price) > 0)) return null;
    return (price - effectiveCost) / effectiveCost * 100;
  }

  function changePercent(price, baseline) {
    if (!(Number(price) > 0) || !(Number(baseline) > 0)) return null;
    return (price - baseline) / baseline * 100;
  }

  // 行情涨跌幅序列：对一组历史快照，用同一个昨收基准价逐点计算
  // (当前报价 − 昨收) ÷ 昨收 × 100%。基准固定、与区间首价/持仓无关。
  // 未设置有效昨收基准时返回全 null（图表据此不画该曲线）。
  function marketChangeSeries(rows, baseline, priceKey) {
    var key = priceKey || "active";
    var base = Number(baseline);
    if (!(base > 0)) return (rows || []).map(function () { return null; });
    return (rows || []).map(function (r) {
      var p = r ? Number(r[key]) : NaN;
      return isFinite(p) && p > 0 ? (p - base) / base * 100 : null;
    });
  }

  // 单笔交易盈亏：
  //  买入 buy：price=买入成交价，currentRedeem=当前实时赎回价（可变现价）
  //    浮动盈亏 =（当前赎回价 − 买入价）× 克数，浮动收益率 = 盈亏 ÷ 买入成本
  //  赎回 sell：price=赎回成交价，cost=该笔对应买入成本价
  //    已实现盈亏 =（赎回价 − 成本价）× 克数，收益率 = 盈亏 ÷ 持有成本
  function tradePnl(trade, currentRedeem) {
    if (!trade) return null;
    var grams = Number(trade.grams);
    var price = Number(trade.price);
    if (!(grams > 0) || !(price > 0)) return null;
    if (trade.type === "sell") {
      var cost = Number(trade.cost);
      var costOk = isFinite(cost) && cost > 0;
      return {
        type: "sell", grams: grams,
        cost: costOk ? cost : null,
        costTotal: costOk ? cost * grams : null,
        refPrice: price, market: price * grams,
        pnl: costOk ? (price - cost) * grams : null,
        pct: costOk ? (price - cost) / cost * 100 : null,
        realized: true
      };
    }
    var ref = Number(currentRedeem);
    var refOk = isFinite(ref) && ref > 0;
    return {
      type: "buy", grams: grams,
      cost: price, costTotal: price * grams,
      refPrice: refOk ? ref : null,
      market: refOk ? ref * grams : null,
      pnl: refOk ? (ref - price) * grams : null,
      pct: refOk ? (ref - price) / price * 100 : null,
      realized: false
    };
  }

  // 交易汇总：买入浮动盈亏 + 赎回已实现盈亏
  function tradeSummary(trades, currentRedeem) {
    var list = trades || [];
    var s = {
      buyGrams: 0, sellGrams: 0, netGrams: 0,
      buyCost: 0, sellProceeds: 0,
      floatingPnl: 0, realizedPnl: 0, totalPnl: 0,
      hasFloating: false, hasRealized: false
    };
    list.forEach(function (t) {
      var r = tradePnl(t, currentRedeem);
      if (!r) return;
      if (r.type === "buy") {
        s.buyGrams += r.grams;
        s.buyCost += r.costTotal;
        if (r.pnl != null) { s.floatingPnl += r.pnl; s.hasFloating = true; }
      } else {
        s.sellGrams += r.grams;
        s.sellProceeds += r.market;
        if (r.pnl != null) { s.realizedPnl += r.pnl; s.hasRealized = true; }
      }
    });
    s.netGrams = s.buyGrams - s.sellGrams;
    s.totalPnl = (s.hasFloating ? s.floatingPnl : 0) + (s.hasRealized ? s.realizedPnl : 0);
    return s;
  }

  // 双口径分析：①行情涨跌幅以昨收为基准，②持仓收益率/浮动盈亏以自身成本为基准
  function analyze(position, quote, baseline) {
    if (!quote) return null;
    var current = Number(quote.active);
    var redeem = Number(quote.redeem);
    var base = Number(baseline);
    var result = {
      current: isFinite(current) && current > 0 ? current : null,
      redeem: isFinite(redeem) && redeem > 0 ? redeem : null,
      baseline: isFinite(base) && base > 0 ? base : null,
      marketChange: null,
      marketChangeAmount: null,
      holding: null
    };
    if (result.current != null && result.baseline != null) {
      result.marketChange = changePercent(result.current, result.baseline);
      result.marketChangeAmount = result.current - result.baseline;
    }
    if (position && result.redeem != null) {
      var effCost = effectiveCostOf(position);
      var c = calc(position, result.redeem);
      if (effCost != null && effCost > 0 && c) {
        result.holding = {
          effectiveCost: effCost,
          redeem: result.redeem,
          grams: c.grams,
          costTotal: c.costTotal,
          market: c.market,
          yieldPct: (result.redeem - effCost) / effCost * 100,
          pnl: c.pnl,
          pnlPct: c.pnlPct,
          breakEven: c.breakEven
        };
      }
    }
    return result;
  }

  // 把明细行 + 日K线行合并为「按自然日」的 OHLC 蜡烛序列。
  // 输入行需含 fetched_at、active，日K行还应含 open_price/high/low。
  // 没有 open_price 的日子以当日第一笔 active 作为开盘。
  function dayKey(fetchedAt) { return String(fetchedAt || "").slice(0, 10); }

  function dailyCandles(rows) {
    var groups = {};
    (rows || []).forEach(function (r) {
      if (!r) return;
      var day = dayKey(r.fetched_at || r.t);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      (groups[day] || (groups[day] = [])).push(r);
    });
    return Object.keys(groups).sort().map(function (day) {
      var g = groups[day];
      var acts = [], highs = [], lows = [];
      g.forEach(function (r) {
        var a = Number(r.active); if (isFinite(a)) acts.push(a);
        var h = Number(r.high); if (isFinite(h)) highs.push(h);
        var l = Number(r.low); if (isFinite(l)) lows.push(l);
      });
      var openRow = null, closeRow = null;
      g.forEach(function (r) {
        if (dayKey(r.fetched_at || r.t) !== day) return;
        if (Number(r.open_price) > 0 && !openRow) openRow = r;
      });
      var open = openRow && Number(openRow.open_price) > 0
        ? Number(openRow.open_price)
        : (acts.length ? acts[0] : null);
      var close = acts.length ? acts[acts.length - 1] : null;
      // 极值：把开盘/收盘也纳入，避免只有单笔时 high/low 缺失
      if (open != null) { highs.push(open); lows.push(open); }
      if (close != null) { highs.push(close); lows.push(close); }
      var t = new Date(day.replace(/-/g, "/") + " 00:00:00").getTime();
      return {
        key: day, label: day.slice(5), t: t,
        open: open, high: highs.length ? Math.max.apply(null, highs) : null,
        low: lows.length ? Math.min.apply(null, lows) : null, close: close,
        count: g.length
      };
    }).filter(function (c) { return c.open != null && c.close != null; });
  }

  // 把日K蜡烛按自然周(周一起) / 自然月聚合成更大周期的蜡烛。
  // period: "day" | "week" | "month"
  function _weekStart(day) {
    var d = new Date(day.replace(/-/g, "/") + " 00:00:00");
    var wd = d.getDay();                       // 0=周日
    var diff = (wd === 0 ? -6 : 1 - wd);       // 归到周一
    d.setDate(d.getDate() + diff);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function aggregateCandles(daily, period) {
    var list = daily || [];
    if (period !== "week" && period !== "month") return list;
    var groups = {};
    list.forEach(function (c) {
      var key = period === "week" ? _weekStart(c.key) : c.key.slice(0, 7);
      (groups[key] || (groups[key] = [])).push(c);
    });
    return Object.keys(groups).sort().map(function (key) {
      var g = groups[key];
      var highs = [], lows = [];
      g.forEach(function (c) {
        if (c.high != null) highs.push(c.high);
        if (c.low != null) lows.push(c.low);
      });
      return {
        key: key,
        label: period === "month" ? key : key.slice(5) + " 起",
        t: g[0].t,
        open: g[0].open, close: g[g.length - 1].close,
        high: highs.length ? Math.max.apply(null, highs) : null,
        low: lows.length ? Math.min.apply(null, lows) : null,
        days: g.length
      };
    });
  }

  root.Portfolio = {
    calc: calc, pnlPercent: pnlPercent, changePercent: changePercent,
    marketChangeSeries: marketChangeSeries,
    tradePnl: tradePnl, tradeSummary: tradeSummary,
    effectiveCostOf: effectiveCostOf, analyze: analyze,
    dailyCandles: dailyCandles, aggregateCandles: aggregateCandles
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).Portfolio;
}
