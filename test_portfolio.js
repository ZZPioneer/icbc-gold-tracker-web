/* 持仓盈亏计算回归测试：node test_portfolio.js */
const assert = require("assert");
const { calc, pnlPercent, changePercent, marketChangeSeries, effectiveCostOf, analyze, tradePnl, tradeSummary } = require("./assets/portfolio.js");

// 用户截图：10 克 / 成本 886.86 元 / 总成本 8868.62 元 / 市价 816.26 元
const r = calc({ grams: 10, cost: 886.86, total: 8868.62, basis: "active" }, 816.26);
assert.strictEqual(r.market.toFixed(2), "8162.60");
assert.strictEqual(r.costTotal.toFixed(2), "8868.62");
assert.strictEqual(r.pnl.toFixed(2), "-706.02");
assert.strictEqual(r.pnlPct.toFixed(2), "-7.96");
assert.strictEqual(r.effectiveCost.toFixed(3), "886.862");
assert.strictEqual(r.breakEven.toFixed(2), "8.65");

// 不填总成本时按 克数 × 成本价 计算
const r2 = calc({ grams: 10, cost: 886.86, total: null }, 816.26);
assert.strictEqual(r2.costTotal.toFixed(2), "8868.60");
assert.strictEqual(r2.pnl.toFixed(2), "-706.00");

// 非法输入
assert.strictEqual(calc(null, 816.26), null);
assert.strictEqual(calc({ grams: 10, cost: 886.86 }, 0), null);
assert.strictEqual(calc({ grams: 0, cost: 886.86 }, 816.26), null);

// 右轴百分比
assert.strictEqual(pnlPercent({ grams: 10, cost: 886.86, total: 8868.62 }, 816.26).toFixed(2), "-7.96");
assert.strictEqual(changePercent(820, 800).toFixed(2), "2.50");
assert.strictEqual(pnlPercent(null, 816.26), null);

// 双口径：①行情涨跌幅 昨收480 → 当前484.8 = +1%
assert.strictEqual(changePercent(484.8, 480).toFixed(2), "1.00");
// ②持仓收益率：成本470 → 赎回484.8 ≈ +3.15%；10克浮动盈亏=148元
assert.strictEqual(pnlPercent({ grams: 10, cost: 470 }, 484.8).toFixed(2), "3.15");
assert.strictEqual(effectiveCostOf({ grams: 10, cost: 470, total: 4700 }), 470);
const a = analyze({ grams: 10, cost: 470 }, { active: 484.8, redeem: 484.8 }, 480);
assert.strictEqual(a.marketChange.toFixed(2), "1.00");
assert.strictEqual(a.marketChangeAmount.toFixed(2), "4.80");
assert.ok(Math.abs(a.holding.yieldPct - 14.8 / 470 * 100) < 1e-9);
assert.strictEqual(a.holding.pnl.toFixed(2), "148.00");
// 未设昨收时行情口径为空，但持仓口径仍可计算
const a2 = analyze({ grams: 10, cost: 470 }, { active: 484.8, redeem: 484.8 }, null);
assert.strictEqual(a2.marketChange, null);
assert.ok(a2.holding != null);

// 图表曲线：固定昨收基准逐点算行情涨跌幅，与区间首价/顺序无关
const hist = [{ active: 480 }, { active: 484.8 }, { active: 472 }];
const series = marketChangeSeries(hist, 480, "active");
assert.strictEqual(series[0], 0);                       // 首点=昨收 → 0%
assert.strictEqual(series[1].toFixed(2), "1.00");       // +1%
assert.strictEqual(series[2].toFixed(2), "-1.67");      // 相对昨收 -1.67%
// 基准无效时整条曲线为空（不画），而不是回退到区间首价
assert.deepStrictEqual(marketChangeSeries(hist, null, "active"), [null, null, null]);
assert.deepStrictEqual(marketChangeSeries(hist, 0, "active"), [null, null, null]);
// 缺值点返回 null 断线，不影响其它点
assert.deepStrictEqual(
  marketChangeSeries([{ active: 484.8 }, { active: null }, {}], 480, "active").map(function (v) { return v == null ? null : v.toFixed(2); }),
  ["1.00", null, null]
);

// 单笔交易：买入 10 克 @800，现赎回价 850 → 浮盈 500 元 / +6.25%
const buy = tradePnl({ type: "buy", grams: 10, price: 800 }, 850);
assert.strictEqual(buy.pnl.toFixed(2), "500.00");
assert.strictEqual(buy.pct.toFixed(2), "6.25");
assert.strictEqual(buy.costTotal.toFixed(2), "8000.00");
assert.strictEqual(buy.realized, false);
// 买入价高于现价 → 浮亏
const buyLoss = tradePnl({ type: "buy", grams: 10, price: 900 }, 850);
assert.strictEqual(buyLoss.pnl.toFixed(2), "-500.00");
assert.strictEqual(buyLoss.pct.toFixed(2), "-5.56");
// 现价无效时盈亏为空，但成本仍记录
const buyNoPrice = tradePnl({ type: "buy", grams: 10, price: 800 }, null);
assert.strictEqual(buyNoPrice.pnl, null);
assert.strictEqual(buyNoPrice.costTotal.toFixed(2), "8000.00");
// 赎回 10 克 @850，成本 800 → 已实现盈利 500 元 / +6.25%
const sell = tradePnl({ type: "sell", grams: 10, price: 850, cost: 800 }, 999);
assert.strictEqual(sell.pnl.toFixed(2), "500.00");
assert.strictEqual(sell.pct.toFixed(2), "6.25");
assert.strictEqual(sell.realized, true);
assert.strictEqual(sell.refPrice, 850);   // 赎回用成交价，不受现价影响
// 赎回未填成本 → 盈亏为空
assert.strictEqual(tradePnl({ type: "sell", grams: 10, price: 850 }, 850).pnl, null);
// 无效数据
assert.strictEqual(tradePnl({ type: "buy", grams: 0, price: 800 }, 850), null);
assert.strictEqual(tradePnl(null, 850), null);
// 汇总：1 笔买入 @800(10克) + 1 笔赎回 @850(5克,成本800)，现价 840
const trades = [
  { type: "buy", grams: 10, price: 800 },
  { type: "sell", grams: 5, price: 850, cost: 800 }
];
const sum = tradeSummary(trades, 840);
assert.strictEqual(sum.buyGrams, 10);
assert.strictEqual(sum.sellGrams, 5);
assert.strictEqual(sum.netGrams, 5);
assert.strictEqual(sum.buyCost.toFixed(2), "8000.00");
assert.strictEqual(sum.sellProceeds.toFixed(2), "4250.00");
assert.strictEqual(sum.floatingPnl.toFixed(2), "400.00");   // (840-800)*10
assert.strictEqual(sum.realizedPnl.toFixed(2), "250.00");    // (850-800)*5
assert.strictEqual(sum.totalPnl.toFixed(2), "650.00");

console.log("portfolio tests OK (35 checks)");
