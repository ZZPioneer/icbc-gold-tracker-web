/* 工行积存金实盘跟踪 —— 前端逻辑
 * 要点：2 秒轮询本地 API；图表静态层与悬停层分离；变动值直接取服务端计算结果。
 */
(function () {
  "use strict";

  var COLORS = {
    active: "#e8b54a", regular: "#5aa9f7", redeem: "#35c07a",
    cost: "#e9b94f", change: "#a98cf7",
    pnlAmount: "#f0a35e", pnlPct: "#a98cf7"
  };
  var NAMES = {
    active: "实时主动积存价格", regular: "定期积存价", redeem: "赎回价",
    change: "行情涨跌幅"
  };
  var TRADE_COLORS = { buy: "#e8b54a", sell: "#5aa9f7" };
  var KEYS = ["active", "regular", "redeem"];
  var PCT_KEYS = ["change"];   // 盈亏比已移到独立的「持仓盈亏走势」图

  var state = {
    quote: null,
    history: [],
    selectedCode: null,
    rangeMinutes: 15,
    pnlRangeMinutes: 15,   // 盈亏图独立时间范围，与价格图互不干扰
    series: { active: true, regular: false, redeem: false, cost: false, change: true, trades: true },
    pnlChart: { amount: true, pct: true },   // 盈亏走势图图例开关
    pnlGeom: null,
    pnlHoverX: null,
    pnlRafPending: false,
    klinePeriod: "day",      // K 线周期：day / week / month
    klineGeom: null,
    klineHoverX: null,
    klineRafPending: false,
    positionNodes: [],
    trades: [],             // 买入/赎回记录，每条 {id,type,code,grams,price,cost,time}
    baselines: {},          // 昨收基准价，按金种 code 存储
    displayed: {},          // 上次渲染的价格，用于闪烁提示
    pollCount: 0,
    errorStreak: 0,
    needHistory: true,
    lastSeq: -1,            // 上次已加载到图表的采集序号；后台采集 seq 变化时重载历史
    busy: false,
    storageMode: "file",    // 个人数据存储位置：file=MySQL数据库 / local=浏览器缓存（兜底）
    historyKline: [],     // 选中金种的全部日K线（gran=1）
    pnlHistoryKline: [],  // 持仓金种的全部日K线（gran=1）
    intervalSec: 4,
    cycleMs: 4000,
    nextAt: 0,
    timer: null,
    hoverX: null,
    rafPending: false,
    geom: null,
    authMode: "login",       // login / register
    authed: false,
    goldTypes: []            // 金种基础资料（别名/备注/星标）
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------- 鉴权 ----------
  // 统一请求包装：任何接口返回 401 都弹出登录框，避免带着失效会话反复轮询。
  function showAuth(message) {
    state.authed = false;
    clearTimeout(state.timer);
    $("authModal").hidden = false;
    if (message) $("authError").textContent = message;
  }

  function apiFetch(url, options) {
    return fetch(url, options).then(function (r) {
      if (r.status === 401) {
        showAuth("登录已失效，请重新登录");
        var err = new Error("未登录"); err.authRequired = true; throw err;
      }
      return r;
    });
  }

  function setAuthMode(mode, needSetup) {
    state.authMode = mode;
    var isReg = mode === "register";
    $("authTitle").textContent = isReg ? "创建管理员账号" : "登录";
    $("authDesc").textContent = isReg
      ? "首次运行，请设置用户名和密码以启用实盘跟踪"
      : "登录后查看实盘行情、持仓与交易记录";
    $("authSubmit").textContent = isReg ? "注册并登录" : "登录";
    $("authUser").autocomplete = isReg ? "username" : "username";
    $("authPass").autocomplete = isReg ? "new-password" : "current-password";
    $("authError").textContent = "";
    // 注册入口：仅首次部署（无用户）或已登录管理员可添加账号；登录态下不显示切换
    var wrap = $("authSwitchWrap");
    if (state.authed) {
      wrap.hidden = true;
    } else if (needSetup) {
      // 必须注册，不允许切回登录
      wrap.hidden = true;
      state.authMode = "register";
      $("authTitle").textContent = "创建管理员账号";
      $("authSubmit").textContent = "注册并登录";
    } else {
      wrap.hidden = false;
      $("authSwitch").textContent = isReg ? "已有账号？去登录" : "注册管理员账号";
    }
  }

  function checkAuth() {
    return fetch("/api/auth/status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && s.authenticated) {
          state.authed = true;
          $("authModal").hidden = true;
          $("userChip").hidden = false;
          $("userName").textContent = (s.user && s.user.username) || "用户";
          $("userAvatar").textContent = ((s.user && s.user.username) || "U").slice(0, 1).toUpperCase();
          // 关键：刷新页面时 cookie 仍有效，checkAuth 判定已登录，但 bootApp 只在
          // 手动点登录按钮时被调用过——这里必须补上，否则持仓/节点/图表全不加载，
          // 表现为"刷新后持仓点消失"。bootApp 内有 booted 幂等保护，重复调用安全。
          bootApp();
          return true;
        }
        setAuthMode(s && s.need_setup ? "register" : "login", s && s.need_setup);
        showAuth();
        return false;
      })
      .catch(function () {
        setAuthMode("login", false);
        showAuth("无法连接本地服务");
        return false;
      });
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmt(value, digits) {
    if (value === null || value === undefined || value === "") return "—";
    var n = Number(value);
    return isFinite(n) ? n.toFixed(digits == null ? 2 : digits) : "—";
  }
  function sign(n) { return n > 0 ? "+" : ""; }
  function tone(n) { return n > 0 ? "up-text" : (n < 0 ? "down-text" : "flat-text"); }
  function parseTime(s) { return new Date(String(s || "").replace(/-/g, "/")); }

  // 交易时间可能是 "2026-11-18 12:03" / ISO 字符串，统一解析为毫秒
  function parseTradeTime(value) {
    var raw = String(value || "").trim();
    if (!raw) return NaN;
    var ms = parseTime(raw.replace("T", " ")).getTime();
    if (!isFinite(ms)) ms = new Date(raw).getTime();
    return ms;
  }

  function tradeTimeLabel(ms, t0, t1) {
    var d = new Date(ms);
    var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    // 跨天区间补上日期，避免「12:03」分不清是哪一天
    if (new Date(t0).toDateString() !== new Date(t1).toDateString()) {
      return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
    }
    return hm;
  }

  function dirHtml(dir) {
    if (dir === "up") return '<span class="dir up">▲ 涨</span>';
    if (dir === "down") return '<span class="dir down">▼ 跌</span>';
    if (dir === "flat") return '<span class="dir flat">— 持平</span>';
    return '<span class="dir none">—</span>';
  }

  // delta 由服务端基于「上一次成功抓取」计算，缓存poll不会把它清零
  function deltaHtml(row, key) {
    var d = row["delta_" + key];
    if (d === null || d === undefined) return '<span class="delta">较上次 —</span>';
    return '<span class="delta ' + tone(d) + '">较上次 ' + sign(d) + fmt(d) + "</span>";
  }

  function mainRow() {
    var rows = state.quote && state.quote.rows;
    if (!rows || !rows.length) return null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].code === state.selectedCode) return rows[i];
    }
    return rows[0];
  }

  function setStatus(mode, text) {
    $("statusDot").className = "dot " + mode;
    $("statusText").textContent = text;
  }

  function renderBanner(q) {
    var banner = $("banner");
    if (q.market_closed) {
      // 每日收盘闸门：到点后服务端停止采集，网页与历史查询仍可用，次日重启恢复
      banner.textContent = "今日已收盘" +
        (q.closed_at ? "（" + q.closed_at.slice(11, 16) + "）" : "") +
        "，行情采集已暂停，当前为最后一次记录的数据；历史与图表仍可查看，明日重启服务后恢复采集。";
      banner.className = "banner show warn";
      setStatus("warn", "已收盘");
    } else if (q.error) {
      banner.textContent = "抓取失败，当前为最近一次成功的行情：" + q.error +
        (q.retry_after ? "（" + q.retry_after + " 秒后重试）" : "");
      banner.className = "banner show";
      setStatus("err", "连接异常");
    } else {
      banner.className = "banner";
      setStatus("live", "实时连接");
    }
  }

  function renderCards() {
    var row = mainRow();
    if (!row) return;
    $("mainLabel").textContent = row.name + " · 实时主动积存价格";
    $("mainTag").textContent = row.name;
    $("rangeTag").textContent = row.name;
    KEYS.forEach(function (key) {
      var el = $("card" + key.charAt(0).toUpperCase() + key.slice(1));
      if (el) el.innerHTML = fmt(row[key]) + "<small>元/克</small>";
    });
    KEYS.forEach(function (key) {
      var meta = $("card" + key.charAt(0).toUpperCase() + key.slice(1) + "Meta");
      if (!meta) return;
      var d = row["delta_" + key];
      var text = (d === null || d === undefined) ? "—" :
        '<span class="delta-chip ' + tone(d) + '">' + sign(d) + fmt(d) + " 元</span>";
      meta.innerHTML = dirHtml(row[key + "_dir"]) + text;
    });

    if (row.low != null && row.high != null && row.high > row.low) {
      var pos = Math.max(0, Math.min(100, (row.active - row.low) / (row.high - row.low) * 100));
      $("cardRange").innerHTML = fmt(row.low) + " <small>— " + fmt(row.high) + "</small>";
      $("cardRangeMeta").textContent = "当前位置 " + pos.toFixed(0) + "% · 振幅 " + fmt(row.high - row.low) + " 元";
      $("rangeBar").style.setProperty("--pos", pos + "%");
    } else {
      $("cardRange").textContent = "—";
      $("cardRangeMeta").textContent = row.name + "未提供区间数据";
      $("rangeBar").style.setProperty("--pos", "0%");
    }
    drawSparkline();
  }

  function drawSparkline() {
    var canvas = $("spark");
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var points = state.history.filter(function (r) { return r.code === state.selectedCode && r.active != null; })
      .slice(-80).map(function (r) { return r.active; });
    if (points.length < 2) return;
    var lo = Math.min.apply(null, points), hi = Math.max.apply(null, points);
    if (hi === lo) { hi += 0.5; lo -= 0.5; }
    var pad = 5;
    var x = function (i) { return i / (points.length - 1) * (w - 2 * pad) + pad; };
    var y = function (v) { return h - pad - (v - lo) / (hi - lo) * (h - 2 * pad); };

    var gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "rgba(233,185,79,.30)");
    gradient.addColorStop(1, "rgba(233,185,79,0)");
    ctx.beginPath();
    ctx.moveTo(x(0), y(points[0]));
    points.forEach(function (v, i) { if (i) ctx.lineTo(x(i), y(v)); });
    ctx.lineTo(x(points.length - 1), h);
    ctx.lineTo(x(0), h);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    points.forEach(function (v, i) { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); });
    ctx.strokeStyle = COLORS.active;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  function goldMeta(code) {
    for (var i = 0; i < state.goldTypes.length; i++) {
      if (state.goldTypes[i].code === code) return state.goldTypes[i];
    }
    return null;
  }

  function renderTabs() {
    var tabs = $("goldTabs");
    var rows = (state.quote && state.quote.rows) || [];
    // 星标金种排前面（与金种资料弹层顺序一致）
    rows = rows.slice().sort(function (a, b) {
      var ma = goldMeta(a.code), mb = goldMeta(b.code);
      return (mb && mb.starred ? 1 : 0) - (ma && ma.starred ? 1 : 0);
    });
    tabs.innerHTML = rows.map(function (row) {
      var active = row.code === state.selectedCode;
      var meta = goldMeta(row.code);
      var label = (meta && meta.alias) ? meta.alias : row.name;
      var star = (meta && meta.starred) ? '<i class="tab-star">★</i>' : "";
      return '<button type="button" role="tab" aria-selected="' + active + '" class="' + (active ? "active" : "") +
        '" data-code="' + esc(row.code) + '"' + ((meta && meta.note) ? ' title="' + esc(meta.note) + '"' : "") +
        '>' + star + esc(label) + "</button>";
    }).join("");
    tabs.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.selectedCode = btn.getAttribute("data-code");
        state.needHistory = true;
        renderTabs(); renderCards(); renderTable(); renderBaseline(); renderPnlTable();
        loadHistory();
      });
    });
  }

  function renderTable() {
    var q = state.quote;
    if (!q) return;
    var body = $("quoteBody");
    if (!q.rows.length) {
      body.innerHTML = '<tr><td colspan="9" class="placeholder">暂时没有行情数据</td></tr>';
      return;
    }
    body.innerHTML = q.rows.map(function (row) {
      var before = state.displayed[row.code] || {};
      var flash = function (key) {
        if (before[key] == null || row[key] == null || before[key] === row[key]) return "";
        return row[key] > before[key] ? " flash-up" : " flash-down";
      };
      return "<tr>" +
        '<td class="name">' + esc(row.name) + "<small>" +
          "官网行情" + "</small></td>" +
        '<td><span class="price' + flash("active") + '">' + fmt(row.active) + "</span>" + deltaHtml(row, "active") + "</td>" +
        "<td>" + dirHtml(row.active_dir) + "</td>" +
        '<td><span class="price">' + fmt(row.low) + "</span></td>" +
        '<td><span class="price">' + fmt(row.high) + "</span></td>" +
        '<td><span class="price' + flash("regular") + '">' + fmt(row.regular) + "</span>" + deltaHtml(row, "regular") + "</td>" +
        "<td>" + dirHtml(row.regular_dir) + "</td>" +
        '<td><span class="price' + flash("redeem") + '">' + fmt(row.redeem) + "</span>" + deltaHtml(row, "redeem") + "</td>" +
        "<td>" + dirHtml(row.redeem_dir) + "</td>" +
        "</tr>";
    }).join("");

    q.rows.forEach(function (row) {
      var copy = {};
      KEYS.forEach(function (key) { copy[key] = row[key]; });
      state.displayed[row.code] = copy;
    });
  }

  function renderHistory() {
    var rows = state.history;
    var body = $("historyBody");
    $("historyCount").textContent = "当前金种 " + rows.length + " / 共 " +
      (state.totalHistory || rows.length) + " 条";
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="placeholder">暂无记录</td></tr>';
      return;
    }
    // 一次遍历建立「同金种上一条」索引，替代 O(n²) 的 indexOf 回溯
    var last = {};
    var enriched = rows.map(function (row) {
      var prev = last[row.code];
      last[row.code] = row;
      var d = (prev && prev.active != null && row.active != null) ? row.active - prev.active : null;
      return { row: row, delta: d };
    });
    body.innerHTML = enriched.slice(-30).reverse().map(function (item) {
      var row = item.row, d = item.delta;
      var stamp = String(row.fetched_at || row.t || "");
      var date = stamp.slice(0, 10), time = stamp.slice(11);
      var deltaCls = d == null ? "flat" : (d > 0 ? "up" : (d < 0 ? "down" : "flat"));
      var deltaHtml = d == null
        ? '<span class="hdelta-chip flat">—</span>'
        : '<span class="hdelta-chip ' + deltaCls + '">' + sign(d) + fmt(d) + "</span>";
      var sourceTag = "官网行情";
      return "<tr>" +
        '<td class="h-time"><span class="ht-date">' + esc(date) + "</span>" + esc(time) + "</td>" +
        '<td class="h-name">' + esc(row.name) + "<small>" + sourceTag + "</small></td>" +
        '<td class="h-num lead">' + fmt(row.active) + "</td>" +
        '<td class="h-num">' + fmt(row.regular) + "</td>" +
        '<td class="h-num">' + fmt(row.redeem) + "</td>" +
        '<td class="h-num">' + deltaHtml + "</td></tr>";
    }).join("");
  }

  // ---------- 走势图：静态底图 + 悬停叠加层 ----------
  function visibleRows() {
    // "全部"仅在日K线跨天(≥2 条)时用它；同一天只有 1 个点画不出走势，回退到明细
    var useKline = state.rangeMinutes === 0 && state.historyKline.length >= 2;
    var source = useKline ? state.historyKline : state.history;
    var rows = source.filter(function (r) { return r.code === state.selectedCode; });
    if (state.rangeMinutes > 0) {
      var cutoff = Date.now() - state.rangeMinutes * 60000;
      rows = rows.filter(function (r) { return parseTime(r.fetched_at || r.t).getTime() >= cutoff; });
    }
    var step = Math.ceil(rows.length / 700);
    if (step > 1) rows = rows.filter(function (_, i) { return i % step === 0 || i === rows.length - 1; });
    return rows;
  }

  function drawBase() {
    var canvas = $("chart");
    var empty = $("chartEmpty");
    var rows = visibleRows();
    var keys = KEYS.filter(function (k) { return state.series[k]; });
    var pctKeys = PCT_KEYS.filter(function (k) { return state.series[k]; });
    var showCost = !!state.series.cost && !!state.position;
    var effectiveCost = null;
    if (showCost && window.Portfolio) {
      var costInfo = window.Portfolio.calc(state.position, 1);
      if (costInfo) effectiveCost = costInfo.effectiveCost;
    }
    if (!rows.length || (!keys.length && !pctKeys.length && !showCost)) {
      canvas.style.visibility = "hidden";
      empty.hidden = false;
      empty.textContent = !rows.length ? "暂无历史数据，采集几次后将自动绘制走势图" : "请至少勾选一条曲线";
      state.geom = null;
      return;
    }
    canvas.style.visibility = "visible";
    empty.hidden = true;

    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var dpr = window.devicePixelRatio || 1;
    var W = rect.width, H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var base = state.base || (state.base = document.createElement("canvas"));
    base.width = canvas.width; base.height = canvas.height;
    var ctx = base.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 行情涨跌幅 = (当前报价 − 昨收基准价) ÷ 昨收基准价 × 100%。
    // 与第二张表 ①行情涨跌幅 完全同口径：基准取用户录入的昨收价（按金种存），
    // 价格固定用主动积存价（当前报价），与持仓成本/计价基准无关，且不受所选区间影响。
    var changeKey = "active";
    var baseline = state.baselines[state.selectedCode];
    if (!(Number(baseline) > 0)) baseline = null;   // 未设置昨收基准时不画该曲线
    var changeSeries = (window.Portfolio && baseline != null)
      ? window.Portfolio.marketChangeSeries(rows, baseline, changeKey)
      : rows.map(function () { return null; });
    var pctRows = rows.map(function (r, i) { return { change: changeSeries[i] }; });
    // 标题栏动态说明当前曲线用的昨收基准，避免和「区间首价」混淆
    var chartSubBase = (baseline != null)
      ? "行情涨跌幅 · 昨收基准 " + fmt(baseline)
      : "行情涨跌幅 · 请先在下方录入昨收基准价";

    var pad = { l: 58, r: pctKeys.length ? 58 : 16, t: 14, b: 30 };
    var plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    var times = rows.map(function (r) { return parseTime(r.fetched_at || r.t).getTime(); });
    var t0 = Math.min.apply(null, times), t1 = Math.max.apply(null, times);
    if (t1 === t0) t1 = t0 + 1000;

    var values = [];
    rows.forEach(function (r) {
      keys.forEach(function (k) { if (typeof r[k] === "number" && isFinite(r[k])) values.push(r[k]); });
    });
    // 把当前区间内的交易成交价纳入纵轴范围，避免标记被压在图边而看不准位置
    if (state.series.trades) {
      state.trades.forEach(function (t) {
        if (t.code !== state.selectedCode) return;
        var ms = parseTradeTime(t.time);
        if (!isFinite(ms) || ms < t0 || ms > t1) return;
        var p = Number(t.price);
        if (!(p > 0)) {
          var near = 0, gap = Infinity;
          times.forEach(function (tv, i) {
            var diff = Math.abs(tv - ms);
            if (diff < gap) { gap = diff; near = i; }
          });
          p = rows[near].active;
        }
        if (typeof p === "number" && isFinite(p) && p > 0) values.push(p);
      });
    }
    if (showCost && effectiveCost != null) values.push(effectiveCost);
    if (!values.length) return;
    var lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
    if (hi - lo < 0.4) { lo -= 0.4; hi += 0.4; }
    var span = hi - lo;
    lo -= span * 0.08; hi += span * 0.08; span = hi - lo;

    var rightValues = [];
    pctRows.forEach(function (p) {
      pctKeys.forEach(function (k) { if (p[k] != null && isFinite(p[k])) rightValues.push(p[k]); });
    });
    var rlo = -1, rhi = 1, rspan = 2;
    if (rightValues.length) {
      rlo = Math.min.apply(null, rightValues); rhi = Math.max.apply(null, rightValues);
      if (rhi - rlo < 0.2) { rlo -= 0.2; rhi += 0.2; }
      rspan = rhi - rlo;
      rlo -= rspan * 0.12; rhi += rspan * 0.12; rspan = rhi - rlo;
    }

    var X = function (t) { return pad.l + (t - t0) / (t1 - t0) * plotW; };
    var Y = function (v) { return pad.t + (hi - v) / span * plotH; };
    var Y2 = function (v) { return pad.t + (rhi - v) / rspan * plotH; };

    ctx.clearRect(0, 0, W, H);
    ctx.font = "11px -apple-system, 'Microsoft YaHei', sans-serif";
    ctx.lineWidth = 1;
    for (var g = 0; g <= 5; g++) {
      var yy = pad.t + plotH * g / 5;
      ctx.strokeStyle = "rgba(41,54,74,.8)";
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
      ctx.fillStyle = "#8a9bb2"; ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      ctx.fillText((hi - span * g / 5).toFixed(2), pad.l - 8, yy);
      if (pctKeys.length) {
        ctx.textAlign = "left";
        ctx.fillText((rhi - rspan * g / 5).toFixed(2) + "%", W - pad.r + 7, yy);
      }
    }
    var withSeconds = (t1 - t0) < 30 * 60000;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (var i = 0; i <= 5; i++) {
      var d = new Date(t0 + (t1 - t0) * i / 5);
      var label = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      if (withSeconds) label += ":" + String(d.getSeconds()).padStart(2, "0");
      ctx.fillStyle = "#8a9bb2";
      ctx.fillText(label, pad.l + plotW * i / 5, H - pad.b + 8);
    }

    if (keys.indexOf("active") >= 0) {
      var first = null, lastX = 0;
      ctx.beginPath();
      rows.forEach(function (r, i) {
        if (typeof r.active !== "number") return;
        var px = X(times[i]), py = Y(r.active);
        if (first === null) { first = px; ctx.moveTo(px, py); } else ctx.lineTo(px, py);
        lastX = px;
      });
      if (first !== null) {
        ctx.lineTo(lastX, H - pad.b); ctx.lineTo(first, H - pad.b); ctx.closePath();
        var grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
        grad.addColorStop(0, "rgba(232,181,74,.20)");
        grad.addColorStop(1, "rgba(232,181,74,0)");
        ctx.fillStyle = grad; ctx.fill();
      }
    }

    keys.forEach(function (key) {
      var started = false;
      ctx.beginPath();
      rows.forEach(function (r, i) {
        if (typeof r[key] !== "number" || !isFinite(r[key])) { started = false; return; }
        var px = X(times[i]), py = Y(r[key]);
        started ? ctx.lineTo(px, py) : (ctx.moveTo(px, py), started = true);
      });
      ctx.strokeStyle = COLORS[key]; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    });

    if (showCost && effectiveCost != null) {
      var cy = Y(effectiveCost);
      ctx.save();
      ctx.strokeStyle = "rgba(233,185,79,.85)"; ctx.lineWidth = 1.5; ctx.setLineDash([7, 5]);
      ctx.beginPath(); ctx.moveTo(pad.l, cy); ctx.lineTo(W - pad.r, cy); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = COLORS.cost; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      ctx.fillText("成本 " + fmt(effectiveCost), W - pad.r - 4, cy - 3);
    }

    pctKeys.forEach(function (key) {
      var started = false;
      ctx.beginPath();
      pctRows.forEach(function (p, i) {
        if (p[key] == null || !isFinite(p[key])) { started = false; return; }
        var px = X(times[i]), py = Y2(p[key]);
        started ? ctx.lineTo(px, py) : (ctx.moveTo(px, py), started = true);
      });
      ctx.strokeStyle = COLORS[key]; ctx.lineWidth = 1.6;
      ctx.setLineDash(key === "change" ? [3, 3] : []);
      ctx.stroke(); ctx.setLineDash([]);
    });

    state.positionNodes.forEach(function (node) {
      if (node.code !== state.selectedCode || node.at < t0 || node.at > t1) return;
      var nx = X(node.at), ny = Y(node.price);
      ctx.strokeStyle = "rgba(233,185,79,.35)"; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(nx, pad.t); ctx.lineTo(nx, H - pad.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.cost;
      ctx.beginPath();
      ctx.moveTo(nx, ny - 5); ctx.lineTo(nx + 5, ny); ctx.lineTo(nx, ny + 5); ctx.lineTo(nx - 5, ny);
      ctx.closePath(); ctx.fill();
    });

    // ---------- 买入 / 赎回标记 ----------
    // 时间来自交易记录，纵轴优先用成交价；成交价缺失时回退到最近的行情快照。
    var tradeMarkers = [];
    if (state.series.trades) {
      state.trades.forEach(function (t) {
        if (t.code !== state.selectedCode) return;
        var ms = parseTradeTime(t.time);
        if (!isFinite(ms) || ms < t0 || ms > t1) return;
        var price = Number(t.price);
        if (!(price > 0)) price = null;
        if (price == null) {
          var best = 0, gap = Infinity;
          times.forEach(function (tv, i) {
            var diff = Math.abs(tv - ms);
            if (diff < gap) { gap = diff; best = i; }
          });
          price = typeof rows[best].active === "number" ? rows[best].active : null;
        }
        var my = price != null ? Y(price) : (H - pad.b) / 2;
        my = Math.max(pad.t + 9, Math.min(H - pad.b - 9, my));
        tradeMarkers.push({
          trade: t, ms: ms, x: X(ms), y: my, price: price,
          type: t.type === "sell" ? "sell" : "buy",
          labelTime: tradeTimeLabel(ms, t0, t1)
        });
      });
      tradeMarkers.sort(function (a, b) { return a.ms - b.ms; });

      // 标签分 4 排避让，避免同一时间段多笔交易文字叠在一起
      var rowRight = [null, null, null, null];
      ctx.font = "10px -apple-system, 'Microsoft YaHei', sans-serif";
      tradeMarkers.forEach(function (m) {
        var color = TRADE_COLORS[m.type];
        var verb = m.type === "buy" ? "▲ 买入" : "▼ 赎回";
        var text = verb + " " + fmt(m.trade.grams, 4) + "克" +
          (m.price != null ? " · " + fmt(m.price) + "元" : "") + " @" + m.labelTime;
        var boxW = Math.min(ctx.measureText(text).width + 14, W - pad.l - pad.r - 4);
        var row = 0;
        while (row < rowRight.length && rowRight[row] != null && m.x - boxW / 2 < rowRight[row] + 4) row++;
        if (row >= rowRight.length) row = rowRight.length - 1;
        rowRight[row] = m.x + boxW / 2;

        // 虚线从标记延伸到横轴，便于对应时间刻度
        ctx.save();
        ctx.strokeStyle = m.type === "buy" ? "rgba(232,181,74,.30)" : "rgba(90,169,247,.30)";
        ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x, H - pad.b); ctx.stroke();
        ctx.restore();

        var lx = Math.max(pad.l + 2, Math.min(W - pad.r - boxW - 2, m.x - boxW / 2));
        var ly = pad.t + 6 + row * 21;
        ctx.fillStyle = "rgba(9,14,22,.94)";
        ctx.strokeStyle = m.type === "buy" ? "rgba(232,181,74,.55)" : "rgba(90,169,247,.55)";
        ctx.lineWidth = 1;
        ctx.fillRect(lx, ly, boxW, 18); ctx.strokeRect(lx + 0.5, ly + 0.5, boxW - 1, 17);
        ctx.fillStyle = color; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(text, lx + 7, ly + 9.5);

        ctx.fillStyle = color;
        ctx.beginPath();
        if (m.type === "buy") {
          ctx.moveTo(m.x, m.y - 6); ctx.lineTo(m.x + 5.5, m.y + 4); ctx.lineTo(m.x - 5.5, m.y + 4);
        } else {
          ctx.moveTo(m.x, m.y + 6); ctx.lineTo(m.x + 5.5, m.y - 4); ctx.lineTo(m.x - 5.5, m.y - 4);
        }
        ctx.closePath(); ctx.fill();
      });
    }
    var codeTrades = state.trades.filter(function (t) { return t.code === state.selectedCode; }).length;
    $("chartSub").textContent = chartSubBase + (state.series.trades
      ? (" · 交易标记 " + tradeMarkers.length + " 笔" +
         (!tradeMarkers.length && codeTrades ? "（当前区间无，切「全部」查看）" : ""))
      : "");

    state.geom = {
      rows: rows, times: times, keys: keys, pctKeys: pctKeys, pctRows: pctRows,
      tradeMarkers: tradeMarkers,
      X: X, Y: Y, Y2: Y2, pad: pad, W: W, H: H, t0: t0, t1: t1, dpr: dpr
    };
    composite();
  }

  function composite() {
    var ctx = $("chart").getContext("2d");
    var g = state.geom;
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, $("chart").width, $("chart").height);
    if (state.base) ctx.drawImage(state.base, 0, 0);
    if (!g) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var tip = $("tip");
    var hover = state.hoverX;
    if (hover == null || hover < g.pad.l || hover > g.W - g.pad.r) {
      tip.style.display = "none";
      return;
    }
    var target = g.t0 + (hover - g.pad.l) / (g.W - g.pad.l - g.pad.r) * (g.t1 - g.t0);
    var best = 0, gap = Infinity;
    g.times.forEach(function (t, i) {
      var diff = Math.abs(t - target);
      if (diff < gap) { gap = diff; best = i; }
    });
    var hx = g.X(g.times[best]);
    ctx.strokeStyle = "rgba(233,185,79,.5)";
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, g.pad.t); ctx.lineTo(hx, g.H - g.pad.b); ctx.stroke();
    ctx.setLineDash([]);
    g.keys.forEach(function (key) {
      var v = g.rows[best][key];
      if (typeof v !== "number" || !isFinite(v)) return;
      ctx.fillStyle = COLORS[key];
      ctx.beginPath(); ctx.arc(hx, g.Y(v), 4, 0, Math.PI * 2); ctx.fill();
    });
    g.pctKeys.forEach(function (key) {
      var v = g.pctRows[best][key];
      if (v == null || !isFinite(v)) return;
      ctx.fillStyle = COLORS[key];
      ctx.beginPath(); ctx.arc(hx, g.Y2(v), 4, 0, Math.PI * 2); ctx.fill();
    });
    var html = ["<b>" + esc(g.rows[best].fetched_at || g.rows[best].t) + "</b>"];
    g.keys.forEach(function (key) {
      html.push('<span style="color:' + COLORS[key] + '">●</span> ' + NAMES[key] + " " + fmt(g.rows[best][key]));
    });
    g.pctKeys.forEach(function (key) {
      var v = g.pctRows[best][key];
      if (v == null || !isFinite(v)) return;
      html.push('<span style="color:' + COLORS[key] + '">●</span> ' + NAMES[key] + " " + sign(v) + fmt(v) + "%");
    });
    // 悬停到交易标记附近时，在提示框里列出该时点的买入/赎回明细
    var nearTrades = (g.tradeMarkers || []).filter(function (m) { return Math.abs(m.x - hx) <= 18; });
    if (nearTrades.length) {
      ctx.lineWidth = 2;
      nearTrades.forEach(function (m) {
        ctx.strokeStyle = TRADE_COLORS[m.type];
        ctx.beginPath(); ctx.arc(m.x, m.y, 8, 0, Math.PI * 2); ctx.stroke();
      });
      html.push('<span class="tt-sep">交易记录</span>');
      nearTrades.forEach(function (m) {
        var t = m.trade;
        html.push('<span style="color:' + TRADE_COLORS[m.type] + '">' +
          (m.type === "buy" ? "▲ 买入" : "▼ 赎回") + "</span> " +
          fmt(t.grams, 4) + " 克 · 成交 " + fmt(t.price) + " 元 · " + esc(fmtTradeTime(t.time)));
      });
    }
    tip.innerHTML = html.join("<br>");
    tip.style.display = "block";
    tip.style.left = Math.min(g.W - tip.offsetWidth - 8, Math.max(6, hx + 12)) + "px";
    tip.style.top = (g.pad.t + 6) + "px";
  }

  function scheduleComposite() {
    if (state.rafPending) return;
    state.rafPending = true;
    requestAnimationFrame(function () { state.rafPending = false; composite(); });
  }

  // ---------- 持仓盈亏走势图（独立双轴） ----------
  function pnlVisibleRows() {
    var p = state.position;
    if (!p || !window.Portfolio) return [];
    var cost = window.Portfolio.effectiveCostOf(p);
    var grams = Number(p.grams);
    if (!(cost > 0) || !(grams > 0)) return [];
    var basis = p.basis || "active";
    var useKline = state.pnlRangeMinutes === 0 && state.pnlHistoryKline.length >= 2;
    var source;
    if (useKline) {
      source = state.pnlHistoryKline;
    } else {
      source = (state.pnlHistory && state.pnlHistory.length && state.pnlHistory !== state.history)
        ? state.pnlHistory : state.history;
    }
    var rows = source.filter(function (r) { return r.code === p.code; });
    if (state.pnlRangeMinutes > 0) {
      var cutoff = Date.now() - state.pnlRangeMinutes * 60000;
      rows = rows.filter(function (r) { return parseTime(r.fetched_at || r.t).getTime() >= cutoff; });
    }
    var step = Math.ceil(rows.length / 700);
    if (step > 1) rows = rows.filter(function (_, i) { return i % step === 0 || i === rows.length - 1; });
    return rows.map(function (r) {
      var price = r[basis];
      var ok = typeof price === "number" && isFinite(price) && price > 0;
      return {
        t: parseTime(r.fetched_at || r.t).getTime(),
        price: price,
        amount: ok ? (price - cost) * grams : null,
        pct: ok ? (price - cost) / cost * 100 : null,
        fetched_at: r.fetched_at || r.t
      };
    });
  }

  // 盈亏图顶部 KPI：与曲线取同一份历史（pnlVisibleRows）的末点，保证数字与图一致
  function renderPnlKpi(rows, effCost) {
    // 数值与单位分离：数字用强调色，单位用小字，避免挤在一起
    var set = function (id, num, unit, cls) {
      var el = $(id);
      el.className = "pk-value" + (cls ? " " + cls : "");
      el.innerHTML = esc(num) + (unit ? "<small>" + esc(unit) + "</small>" : "");
    };
    var resetSubs = function () {
      $("pkMarketSub").textContent = "现价 × 持有克数";
      $("pkCostSub").textContent = "成本价 × 持有克数";
    };
    var p = state.position;
    var grams = p ? Number(p.grams) : 0;
    if (!p || !(effCost > 0) || !rows.length) {
      set("pkPnl", "—", "", ""); set("pkPct", "—", "", ""); set("pkMarket", "—", "", "");
      set("pkCost", effCost > 0 ? fmt(effCost * grams) : "—", effCost > 0 ? "元" : "", "");
      set("pkBe", "—", "", "");
      $("pkPnlSub").textContent = p ? "该金种暂无可用行情快照" : "保存持仓后显示";
      resetSubs();
      return;
    }
    // rows 为时间升序，取最后一个有有效价格的点（如意金无定期价时避免断线）
    var last = null;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (typeof rows[i].price === "number" && isFinite(rows[i].price) && rows[i].price > 0) {
        last = rows[i]; break;
      }
    }
    if (!last) {
      set("pkPnl", "—", "", ""); set("pkPct", "—", "", ""); set("pkMarket", "—", "", "");
      set("pkCost", fmt(effCost * grams), "元", ""); set("pkBe", "—", "", "");
      $("pkPnlSub").textContent = "该金种暂无可用行情快照";
      resetSubs();
      return;
    }
    var amount = (last.price - effCost) * grams;
    var pct = (last.price - effCost) / effCost * 100;
    var be = Math.max(0, (effCost / last.price - 1) * 100);
    set("pkPnl", sign(amount) + fmt(amount), "元", tone(amount));
    set("pkPct", sign(pct) + fmt(pct), "%", tone(pct));
    set("pkMarket", fmt(grams * last.price), "元", "");
    set("pkCost", fmt(effCost * grams), "元", "");
    set("pkBe", fmt(be), "%", "");
    $("pkPnlSub").textContent = "成本 " + fmt(effCost) + " · " + fmt(grams, 4) + " 克 · 实时";
    $("pkMarketSub").textContent = fmt(last.price) + " × " + fmt(grams, 4) + " 克";
    $("pkCostSub").textContent = fmt(effCost) + " × " + fmt(grams, 4) + " 克";
  }

  function drawPnlChart() {
    var canvas = $("pnlChart");
    var empty = $("pnlChartEmpty");
    var badge = $("pnlChartBadge");
    var p = state.position;
    var series = state.pnlChart;
    var rows = pnlVisibleRows();
    var effCost = window.Portfolio ? window.Portfolio.effectiveCostOf(p) : null;
    renderPnlKpi(rows, effCost);   // 所有分支都刷新顶部 KPI

    if (!p) {
      canvas.style.visibility = "hidden";
      empty.hidden = false;
      empty.textContent = "尚未保存持仓，请在上方「我的持仓」填写并保存后查看盈亏走势";
      badge.textContent = "未保存持仓";
      state.pnlGeom = null;
      return;
    }
    if (!rows.length || (!series.amount && !series.pct && !series.zero)) {
      canvas.style.visibility = "hidden";
      empty.hidden = false;
      empty.textContent = !rows.length
        ? "该金种暂无历史快照，采集几次后自动绘制盈亏走势"
        : "请至少勾选一条曲线";
      badge.textContent = "等待数据";
      state.pnlGeom = null;
      return;
    }
    canvas.style.visibility = "visible";
    empty.hidden = true;

    var basisName = { active: "主动积存价", redeem: "赎回价", regular: "定期积存价" }[p.basis] || "市价";
    badge.textContent = fmt(p.grams, 4) + " 克 · 成本 " + fmt(effCost) + " · " + basisName;
    var rangeName = { 15: "近 15 分钟", 60: "近 1 小时", 240: "近 4 小时", 0: "全部区间" }[state.pnlRangeMinutes] || "全部区间";
    $("pnlChartSub").textContent = rangeName + " · 按持仓成本回溯";

    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var dpr = window.devicePixelRatio || 1;
    var W = rect.width, H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var base = state.pnlBase || (state.pnlBase = document.createElement("canvas"));
    base.width = canvas.width; base.height = canvas.height;
    var ctx = base.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var showAmount = !!series.amount, showPct = !!series.pct, showZero = !!series.zero;
    var leftVals = [], rightVals = [];
    rows.forEach(function (r) {
      if (r.amount != null) leftVals.push(r.amount);
      if (r.pct != null) rightVals.push(r.pct);
    });
    if (showZero) { leftVals.push(0); rightVals.push(0); }
    if (!leftVals.length && !rightVals.length) return;

    function axisRange(vals, minPad) {
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      if (hi - lo < minPad) { lo -= minPad / 2; hi += minPad / 2; }
      var span = hi - lo;
      lo -= span * 0.1; hi += span * 0.1;
      return { lo: lo, hi: hi, span: hi - lo };
    }
    var L = axisRange(leftVals.length ? leftVals : [0], 1);
    var R = axisRange(rightVals.length ? rightVals : [0], 0.2);

    var times = rows.map(function (r) { return r.t; });
    var t0 = Math.min.apply(null, times), t1 = Math.max.apply(null, times);
    if (t1 === t0) t1 = t0 + 1000;
    var pad = { l: 66, r: 62, t: 14, b: 30 };
    var plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    var X = function (t) { return pad.l + (t - t0) / (t1 - t0) * plotW; };
    var Y1 = function (v) { return pad.t + (L.hi - v) / L.span * plotH; };
    var Y2 = function (v) { return pad.t + (R.hi - v) / R.span * plotH; };

    ctx.clearRect(0, 0, W, H);
    ctx.font = "11px -apple-system, 'Microsoft YaHei', sans-serif";
    ctx.lineWidth = 1;
    for (var g = 0; g <= 5; g++) {
      var yy = pad.t + plotH * g / 5;
      ctx.strokeStyle = "rgba(41,54,74,.8)";
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
      ctx.fillStyle = "#8a9bb2"; ctx.textBaseline = "middle";
      if (showAmount) {
        ctx.textAlign = "right";
        ctx.fillText((L.hi - L.span * g / 5).toFixed(0), pad.l - 8, yy);
      }
      if (showPct) {
        ctx.textAlign = "left";
        ctx.fillText((R.hi - R.span * g / 5).toFixed(2) + "%", W - pad.r + 7, yy);
      }
    }
    var withSeconds = (t1 - t0) < 30 * 60000;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (var i = 0; i <= 5; i++) {
      var d = new Date(t0 + (t1 - t0) * i / 5);
      var label = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      if (withSeconds) label += ":" + String(d.getSeconds()).padStart(2, "0");
      ctx.fillStyle = "#8a9bb2";
      ctx.fillText(label, pad.l + plotW * i / 5, H - pad.b + 8);
    }

    // 回本线（0 轴）：盈亏金额与盈亏比的 0 应落在同一水平
    if (showZero && L.lo < 0 && L.hi > 0) {
      var zy = Y1(0);
      ctx.save();
      ctx.strokeStyle = "rgba(140,155,178,.6)"; ctx.lineWidth = 1.2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(pad.l, zy); ctx.lineTo(W - pad.r, zy); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "#8a9bb2"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText("回本线", pad.l + 6, zy - 3);
    }

    // 浮动盈亏：面积 + 折线（左轴）
    if (showAmount) {
      var firstA = null, lastXA = 0;
      ctx.beginPath();
      rows.forEach(function (r, i) {
        if (r.amount == null) return;
        var px = X(times[i]), py = Y1(r.amount);
        if (firstA === null) { firstA = px; ctx.moveTo(px, py); } else ctx.lineTo(px, py);
        lastXA = px;
      });
      if (firstA !== null) {
        ctx.lineTo(lastXA, H - pad.b); ctx.lineTo(firstA, H - pad.b); ctx.closePath();
        var grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
        grad.addColorStop(0, "rgba(240,163,94,.22)");
        grad.addColorStop(1, "rgba(240,163,94,0)");
        ctx.fillStyle = grad; ctx.fill();
      }
      var started = false;
      ctx.beginPath();
      rows.forEach(function (r, i) {
        if (r.amount == null) { started = false; return; }
        var px = X(times[i]), py = Y1(r.amount);
        started ? ctx.lineTo(px, py) : (ctx.moveTo(px, py), started = true);
      });
      ctx.strokeStyle = COLORS.pnlAmount; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    }

    // 盈亏比：折线（右轴）
    if (showPct) {
      var started2 = false;
      ctx.beginPath();
      rows.forEach(function (r, i) {
        if (r.pct == null) { started2 = false; return; }
        var px = X(times[i]), py = Y2(r.pct);
        started2 ? ctx.lineTo(px, py) : (ctx.moveTo(px, py), started2 = true);
      });
      ctx.strokeStyle = COLORS.pnlPct; ctx.lineWidth = 1.8; ctx.setLineDash([5, 3]);
      ctx.stroke(); ctx.setLineDash([]);
    }

    // 持仓节点标记：在盈亏曲线上打点
    state.positionNodes.forEach(function (node) {
      if (node.code !== p.code || node.at < t0 || node.at > t1) return;
      var nx = X(node.at);
      ctx.strokeStyle = "rgba(233,185,79,.3)"; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(nx, pad.t); ctx.lineTo(nx, H - pad.b); ctx.stroke();
      ctx.setLineDash([]);
      if (node.price > 0 && showAmount) {
        var ny = Y1((node.price - effCost) * Number(p.grams));
        ctx.fillStyle = COLORS.cost;
        ctx.beginPath();
        ctx.moveTo(nx, ny - 5); ctx.lineTo(nx + 5, ny); ctx.lineTo(nx, ny + 5); ctx.lineTo(nx - 5, ny);
        ctx.closePath(); ctx.fill();
      }
    });

    state.pnlGeom = {
      rows: rows, times: times, X: X, Y1: Y1, Y2: Y2, L: L, R: R,
      pad: pad, W: W, H: H, t0: t0, t1: t1, dpr: dpr,
      showAmount: showAmount, showPct: showPct
    };
    compositePnl();
  }

  function compositePnl() {
    var canvas = $("pnlChart");
    var ctx = canvas.getContext("2d");
    var g = state.pnlGeom;
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (state.pnlBase) ctx.drawImage(state.pnlBase, 0, 0);
    if (!g) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var tip = $("pnlTip");
    var hover = state.pnlHoverX;
    if (hover == null || hover < g.pad.l || hover > g.W - g.pad.r) {
      tip.style.display = "none";
      return;
    }
    var target = g.t0 + (hover - g.pad.l) / (g.W - g.pad.l - g.pad.r) * (g.t1 - g.t0);
    var best = 0, gap = Infinity;
    g.times.forEach(function (t, i) {
      var diff = Math.abs(t - target);
      if (diff < gap) { gap = diff; best = i; }
    });
    var r = g.rows[best];
    var hx = g.X(g.times[best]);
    ctx.strokeStyle = "rgba(233,185,79,.5)";
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, g.pad.t); ctx.lineTo(hx, g.H - g.pad.b); ctx.stroke();
    ctx.setLineDash([]);
    if (g.showAmount && r.amount != null) {
      ctx.fillStyle = COLORS.pnlAmount;
      ctx.beginPath(); ctx.arc(hx, g.Y1(r.amount), 4, 0, Math.PI * 2); ctx.fill();
    }
    if (g.showPct && r.pct != null) {
      ctx.fillStyle = COLORS.pnlPct;
      ctx.beginPath(); ctx.arc(hx, g.Y2(r.pct), 4, 0, Math.PI * 2); ctx.fill();
    }
    var html = ["<b>" + esc(r.fetched_at) + "</b>"];
    html.push("当时价格 " + fmt(r.price) + " 元/克");
    html.push('<span style="color:' + COLORS.pnlAmount + '">●</span> 浮动盈亏 <b class="' + tone(r.amount) + '">' +
      sign(r.amount) + fmt(r.amount) + " 元</b>");
    html.push('<span style="color:' + COLORS.pnlPct + '">●</span> 盈亏比 <b class="' + tone(r.pct) + '">' +
      sign(r.pct) + fmt(r.pct) + "%</b>");
    tip.innerHTML = html.join("<br>");
    tip.style.display = "block";
    tip.style.left = Math.min(g.W - tip.offsetWidth - 8, Math.max(6, hx + 12)) + "px";
    tip.style.top = (g.pad.t + 6) + "px";
  }

  function schedulePnlComposite() {
    if (state.pnlRafPending) return;
    state.pnlRafPending = true;
    requestAnimationFrame(function () { state.pnlRafPending = false; compositePnl(); });
  }

  // ---------- K 线图（日 / 周 / 月，红涨绿跌） ----------
  // 数据源：永久日K(gran=1) + 今日/昨日明细(gran=0)，合并成日线 OHLC，
  // 再按所选周期聚合成蜡烛。金种跟随主图 selectedCode。
  function klineCandles() {
    if (!window.Portfolio) return [];
    var all = (state.historyKline || []).concat(state.history || []);
    var daily = window.Portfolio.dailyCandles(all);
    return window.Portfolio.aggregateCandles(daily, state.klinePeriod);
  }

  function drawKlineChart() {
    var canvas = $("klineChart");
    var empty = $("klineEmpty");
    var badge = $("klineBadge");
    var candles = klineCandles();
    var periodName = { day: "日 K", week: "周 K", month: "月 K" }[state.klinePeriod] || "日 K";

    if (!candles.length) {
      canvas.style.visibility = "hidden";
      empty.hidden = false;
      badge.textContent = "— 根 K 线";
      $("klineSub").textContent = "按每日开高低收绘制 · 红涨绿跌";
      state.klineGeom = null;
      return;
    }
    canvas.style.visibility = "visible";
    empty.hidden = true;
    badge.textContent = candles.length + " 根 " + periodName;
    var priceKey = "主动积存价";
    $("klineSub").textContent = periodName + " · " + priceKey + "开高低收 · 红涨绿跌";

    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var dpr = window.devicePixelRatio || 1;
    var W = rect.width, H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var base = state.klineBase || (state.klineBase = document.createElement("canvas"));
    base.width = canvas.width; base.height = canvas.height;
    var ctx = base.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var pad = { l: 58, r: 16, t: 14, b: 30 };
    var plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    var vals = [];
    candles.forEach(function (c) {
      if (c.high != null) vals.push(c.high);
      if (c.low != null) vals.push(c.low);
    });
    var hi = Math.max.apply(null, vals), lo = Math.min.apply(null, vals);
    if (!(hi > lo)) { hi += 1; lo -= 1; }
    var span = hi - lo;
    lo -= span * 0.08; hi += span * 0.08; span = hi - lo;

    var n = candles.length;
    var slot = plotW / n;
    var bodyW = Math.max(1.5, Math.min(18, slot * 0.62));
    var X = function (i) { return pad.l + slot * (i + 0.5); };
    var Y = function (v) { return pad.t + (hi - v) / span * plotH; };

    ctx.clearRect(0, 0, W, H);
    ctx.font = "11px -apple-system, 'Microsoft YaHei', sans-serif";
    ctx.lineWidth = 1;
    for (var g = 0; g <= 5; g++) {
      var yy = pad.t + plotH * g / 5;
      ctx.strokeStyle = "rgba(41,54,74,.8)";
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
      ctx.fillStyle = "#8a9bb2"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText((hi - span * g / 5).toFixed(2), pad.l - 8, yy);
    }

    // 蜡烛：红涨绿跌（中国习惯）。实体 开盘→收盘，影线 最高→最低。
    candles.forEach(function (c, i) {
      var cx = X(i);
      var up = c.close >= c.open;
      var color = up ? "#f2555a" : "#35c07a";
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, Y(c.high)); ctx.lineTo(cx, Y(c.low)); ctx.stroke();
      var yO = Y(c.open), yC = Y(c.close);
      var top = Math.min(yO, yC), h = Math.max(1, Math.abs(yC - yO));
      ctx.fillStyle = color;
      ctx.fillRect(cx - bodyW / 2, top, bodyW, h);
    });

    // X 轴标签：均匀抽稀，避免拥挤
    var maxLabels = Math.min(n, 7);
    ctx.fillStyle = "#8a9bb2"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (var li = 0; li < maxLabels; li++) {
      var idx = maxLabels === 1 ? 0 : Math.round(li * (n - 1) / (maxLabels - 1));
      ctx.fillText(candles[idx].label, X(idx), H - pad.b + 8);
    }

    state.klineGeom = {
      candles: candles, X: X, Y: Y, pad: pad, W: W, H: H,
      slot: slot, bodyW: bodyW, dpr: dpr, periodName: periodName
    };
    compositeKline();
  }

  function compositeKline() {
    var canvas = $("klineChart");
    var ctx = canvas.getContext("2d");
    var g = state.klineGeom;
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (state.klineBase) ctx.drawImage(state.klineBase, 0, 0);
    var tip = $("klineTip");
    if (!g) { tip.style.display = "none"; return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var hover = state.klineHoverX;
    if (hover == null || hover < g.pad.l || hover > g.W - g.pad.r) {
      tip.style.display = "none";
      return;
    }
    var idx = Math.max(0, Math.min(g.candles.length - 1, Math.floor((hover - g.pad.l) / g.slot)));
    var c = g.candles[idx];
    var hx = g.X(idx);
    ctx.strokeStyle = "rgba(233,185,79,.45)";
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, g.pad.t); ctx.lineTo(hx, g.H - g.pad.b); ctx.stroke();
    ctx.setLineDash([]);

    var prevClose = idx > 0 ? g.candles[idx - 1].close : null;
    var ref = (prevClose != null && prevClose > 0) ? prevClose : c.open;
    var chg = (ref > 0) ? (c.close - ref) / ref * 100 : null;
    var html = ["<b>" + esc(c.key) + "　" + esc(g.periodName) + "</b>"];
    html.push("开盘 <b>" + fmt(c.open) + "</b>　收盘 <b>" + fmt(c.close) + "</b>");
    html.push("最高 " + fmt(c.high) + "　最低 " + fmt(c.low));
    if (chg != null) {
      html.push((prevClose != null ? "较上期 " : "较开盘 ") +
        '<span class="' + tone(chg) + '">' + sign(chg) + fmt(chg) + "%</span>" +
        "　实体 <span class=\"" + tone(c.close - c.open) + "\">" +
        sign(c.close - c.open) + fmt(c.close - c.open) + "</span>");
    }
    if (c.days) html.push('<span class="tt-sep">由 ' + c.days + " 个交易日聚合</span>");
    else if (c.count > 1) html.push('<span class="tt-sep">当日 ' + c.count + " 笔快照汇总</span>");
    tip.innerHTML = html.join("<br>");
    tip.style.display = "block";
    tip.style.left = Math.min(g.W - tip.offsetWidth - 8, Math.max(6, hx + 12)) + "px";
    tip.style.top = (g.pad.t + 6) + "px";
  }

  function scheduleKlineComposite() {
    if (state.klineRafPending) return;
    state.klineRafPending = true;
    requestAnimationFrame(function () { state.klineRafPending = false; compositeKline(); });
  }

  function fetchHistory(code, gran, limit) {
    var url = "/api/history?code=" + encodeURIComponent(code || "") +
      "&limit=" + (limit || 3000) + "&gran=" + (gran || 0);
    return apiFetch(url, { cache: "no-store" }).then(function (r) { return r.json(); });
  }

  function loadHistory() {
    var sel = state.selectedCode || "";
    var posCode = state.position ? state.position.code : null;
    // 盈亏图需要「持仓金种」的历史；与当前选中金种不同时单独拉取
    var needPos = posCode && posCode !== sel;
    // 先取体积极小的日K线：只有跨天(≥2 条)时"全部"才用日K；
    // 只有同一天时日K只有一个点，画不出走势，需把明细限额放宽覆盖全天。
    Promise.all([
      fetchHistory(sel, 1),
      needPos ? fetchHistory(posCode, 1) : Promise.resolve(null)
    ]).then(function (k) {
      var selKline = k[0].items || [];
      var posKline = needPos ? (k[1].items || []) : selKline;
      var rawLimit = (selKline.length < 2 || posKline.length < 2) ? 20000 : 3000;
      return Promise.all([
        fetchHistory(sel, 0, rawLimit),
        needPos ? fetchHistory(posCode, 0, rawLimit) : Promise.resolve(null)
      ]).then(function (res) {
        state.history = res[0].items || [];
        state.totalHistory = res[0].count || state.history.length;
        state.historyKline = selKline;
        state.pnlHistory = needPos ? (res[1].items || []) : state.history;
        state.pnlHistoryKline = posKline;
        renderHistory(); drawBase(); drawSparkline(); renderPnlTable(); drawPnlChart(); drawKlineChart();
      });
    }).catch(function () { /* 历史失败不影响实时价格 */ });
  }

  // ---------- 金种基础资料（MySQL） ----------
  function loadGoldTypes() {
    return apiFetch("/api/gold-types", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        state.goldTypes = (res && res.items) || [];
        renderTabs();
      })
      .catch(function () { /* 资料加载失败不影响行情 */ });
  }

  function renderGoldInfoList() {
    var box = $("goldInfoList");
    var rows = (state.quote && state.quote.rows) || [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">暂无金种，请稍后刷新</div>';
      return;
    }
    box.innerHTML = rows.map(function (row) {
      var meta = goldMeta(row.code) || { code: row.code, name: row.name, alias: "", note: "", starred: false };
      var starred = meta.starred ? "on" : "";
      return '<div class="gold-info-row" data-code="' + esc(row.code) + '">' +
        '<button type="button" class="gi-star ' + starred + '" data-act="star" title="星标置顶">' +
          (meta.starred ? "★" : "☆") + "</button>" +
        '<div class="gi-main"><div class="gi-name">' + esc(row.name) +
          '<small>' + esc(row.code) + "</small></div>" +
          '<div class="gi-fields">' +
            '<input type="text" class="gi-alias" data-field="alias" value="' + esc(meta.alias || "") +
              '" placeholder="自定义名称（留空用官方名）" maxlength="40">' +
            '<input type="text" class="gi-note" data-field="note" value="' + esc(meta.note || "") +
              '" placeholder="备注，如：主要定投标的" maxlength="120">' +
          "</div></div>" +
        '<button type="button" class="gi-save" data-act="save">保存</button>' +
        '<span class="gi-status"></span>' +
      "</div>";
    }).join("");
  }

  function saveGoldTypeRow(rowEl) {
    var code = rowEl.getAttribute("data-code");
    var alias = rowEl.querySelector(".gi-alias").value.trim();
    var note = rowEl.querySelector(".gi-note").value.trim();
    var meta = goldMeta(code) || {};
    var statusEl = rowEl.querySelector(".gi-status");
    statusEl.textContent = "保存中…";
    apiFetch("/api/gold-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, alias: alias, note: note, starred: !!meta.starred })
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (res) {
      if (res && res.item) {
        var idx = -1;
        for (var i = 0; i < state.goldTypes.length; i++) {
          if (state.goldTypes[i].code === code) { idx = i; break; }
        }
        if (idx >= 0) state.goldTypes[idx] = res.item;
        else state.goldTypes.push(res.item);
      }
      statusEl.textContent = "已保存";
      renderTabs();
      setTimeout(function () { statusEl.textContent = ""; }, 1500);
    }).catch(function (e) {
      statusEl.textContent = e.authRequired ? "请先登录" : "保存失败";
    });
  }

  function toggleGoldStar(rowEl) {
    var code = rowEl.getAttribute("data-code");
    var meta = goldMeta(code) || { alias: "", note: "", starred: false };
    var starred = !meta.starred;
    apiFetch("/api/gold-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, alias: meta.alias || "", note: meta.note || "", starred: starred })
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (res) {
      if (res && res.item) {
        var idx = -1;
        for (var i = 0; i < state.goldTypes.length; i++) {
          if (state.goldTypes[i].code === code) { idx = i; break; }
        }
        if (idx >= 0) state.goldTypes[idx] = res.item;
        else state.goldTypes.push(res.item);
      }
      renderTabs();
      renderGoldInfoList();
    }).catch(function () { /* 忽略 */ });
  }

  // ---------- 个人数据持久化：MySQL 数据库优先，localStorage 兜底 ----------
  var POS_KEY = "gold-tracker-position";
  var POS_NODES_KEY = "gold-tracker-position-nodes";
  var BASE_KEY = "gold-tracker-baselines";
  var TRADE_KEY = "gold-tracker-trades";
  var PORTFOLIO_API = "/api/portfolio";

  var saveTimer = null;
  // 所有个人数据整体 POST 到服务端，写入 MySQL 数据库 gold_tracker.portfolio。
  // 用 150ms 防抖，避免连续操作（如保存持仓时顺带加节点）产生多次写库。
  function persistAll() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      apiFetch(PORTFOLIO_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          position: state.position,
          positionNodes: state.positionNodes.slice(-50),
          baselines: state.baselines,
          trades: state.trades
        })
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (res) {
        if (res && res.ok) setStorageMode("file");
      }).catch(function () {
        // 服务端不可用时退回浏览器本地缓存，保证数据不丢
        setStorageMode("local");
        persistLocalFallback();
      });
    }, 150);
  }

  function persistLocalFallback() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(state.position));
      localStorage.setItem(POS_NODES_KEY, JSON.stringify(state.positionNodes.slice(-50)));
      localStorage.setItem(BASE_KEY, JSON.stringify(state.baselines));
      localStorage.setItem(TRADE_KEY, JSON.stringify(state.trades));
    } catch (e) { /* 忽略 */ }
  }

  // 从服务端加载；首次运行若服务端为空但浏览器有旧数据，则自动迁移到服务端。
  function loadPortfolio() {
    return apiFetch(PORTFOLIO_API, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var hasRemote = data.position || (data.positionNodes && data.positionNodes.length) ||
          (data.trades && data.trades.length) || (data.baselines && Object.keys(data.baselines).length);
        if (hasRemote) {
          applyPortfolio(data);
          setStorageMode("file");
        } else {
          // 服务端为空：尝试把旧 localStorage 数据迁移上来
          migrateFromLocal();
        }
      })
      .catch(function () { setStorageMode("local"); });
  }

  function migrateFromLocal() {
    var migrated = false;
    try {
      var p = localStorage.getItem(POS_KEY);
      if (p) { state.position = JSON.parse(p); migrated = true; applyPositionFields(state.position); }
      var n = localStorage.getItem(POS_NODES_KEY);
      if (n) { var nodes = JSON.parse(n); if (Array.isArray(nodes)) { state.positionNodes = nodes.slice(-50); migrated = true; } }
      var b = localStorage.getItem(BASE_KEY);
      if (b) { var baselines = JSON.parse(b); if (baselines && typeof baselines === "object") { state.baselines = baselines; migrated = true; } }
      var t = localStorage.getItem(TRADE_KEY);
      if (t) { var trades = JSON.parse(t); if (Array.isArray(trades)) { state.trades = trades; migrated = true; } }
    } catch (e) { /* 旧数据损坏则忽略 */ }
    if (migrated) {
      setStorageMode("migrating");
      // 迁移后立即写回服务端（立即执行，不走防抖）
      apiFetch(PORTFOLIO_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          position: state.position, positionNodes: state.positionNodes.slice(-50),
          baselines: state.baselines, trades: state.trades
        })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (res && res.ok) setStorageMode("file");
      }).catch(function () { setStorageMode("local"); });
    } else {
      setStorageMode("file");
    }
  }

  function applyPortfolio(data) {
    state.position = data.position && typeof data.position === "object" ? data.position : null;
    applyPositionFields(state.position);
    state.positionNodes = Array.isArray(data.positionNodes) ? data.positionNodes.slice(-50) : [];
    state.baselines = data.baselines && typeof data.baselines === "object" ? data.baselines : {};
    state.trades = Array.isArray(data.trades) ? data.trades : [];
  }

  function applyPositionFields(p) {
    if (!p) return;
    $("posGrams").value = p.grams;
    $("posCost").value = p.cost;
    $("posTotal").value = p.total == null ? "" : p.total;
    $("posBasis").value = p.basis || "active";
    $("positionUpdated").textContent = "已保存 " + (p.savedAt || "");
  }

  function setStorageMode(mode) {
    state.storageMode = mode;
    var el = $("storageMode");
    if (!el) return;
    var labels = { file: "数据库", local: "浏览器缓存", migrating: "迁移中" };
    el.textContent = labels[mode] || mode;
    el.className = "meta-pill storage-" + mode;
    el.title = mode === "file"
      ? "持仓、节点、昨收基准、买入/赎回记录保存在 MySQL 数据库 gold_tracker.portfolio（加密）"
      : (mode === "migrating" ? "正在把浏览器里的旧数据写入数据库"
         : "数据库暂时不可用，数据暂存本机浏览器；恢复后会自动迁移");
  }

  function persistPosition() { persistAll(); }
  function persistPositionNodes() { persistAll(); }
  function persistBaselines() { persistAll(); }
  function persistTrades() { persistAll(); }

  function nowText() {
    var d = new Date();
    return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") +
      " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function addPositionNode(price) {
    var p = state.position;
    var name = "";
    ((state.quote && state.quote.rows) || []).forEach(function (r) { if (r.code === p.code) name = r.name; });
    state.positionNodes.push({
      at: Date.now(),
      time: nowText() + ":" + String(new Date().getSeconds()).padStart(2, "0"),
      code: p.code, name: name || p.code, grams: p.grams, cost: p.cost,
      total: p.total, basis: p.basis, price: price,
      pnlPct: window.Portfolio ? window.Portfolio.pnlPercent(p, price) : null
    });
    if (state.positionNodes.length > 50) state.positionNodes = state.positionNodes.slice(-50);
    persistPositionNodes();
    renderPositionNodes();
    drawBase(); drawPnlChart();
  }

  function renderPositionNodes() {
    var box = $("positionNodes");
    if (!state.positionNodes.length) {
      box.innerHTML = '<span class="nodes-empty">暂无节点</span>';
      return;
    }
    box.innerHTML = state.positionNodes.slice(-8).reverse().map(function (n) {
      var pct = n.pnlPct == null ? "—" :
        '<span class="' + tone(n.pnlPct) + '">' + sign(n.pnlPct) + fmt(n.pnlPct) + "%</span>";
      return '<span class="node-chip"><i></i>' + esc(n.time) + " · " + esc(n.name) +
        " · 市价 <b>" + fmt(n.price) + "</b> · 盈亏比 " + pct + "</span>";
    }).join("");
  }

  // ---------- 第二张表：双口径盈亏 + 昨收基准价 ----------
  function renderBaseline() {
    var row = mainRow();
    $("baselineTarget").textContent = "当前金种 " + (row ? row.name : "--");
    var code = state.selectedCode;
    var val = code ? state.baselines[code] : null;
    var input = $("baselinePrice");
    // 不覆盖用户正在输入的内容
    if (document.activeElement !== input) {
      input.value = (val == null || val === "") ? "" : String(val);
    }
  }

  function setBaseline(value, hint) {
    if (!state.selectedCode || !(Number(value) > 0)) {
      $("baselineHint").textContent = "请输入大于 0 的有效基准价";
      return;
    }
    state.baselines[state.selectedCode] = Number(value);
    persistBaselines();
    renderBaseline();
    renderPnlTable();
    drawBase();   // 行情涨跌幅曲线以昨收为基准，保存后立即重绘
    $("baselineHint").textContent = hint;
  }

  function renderPnlTable() {
    var q = state.quote;
    var body = $("pnlBody");
    $("pnlAsOf").textContent = q ? ("本地采集 " + (q.fetched_at || "--")) : "--";
    if (!q || !q.rows.length) {
      body.innerHTML = '<tr><td colspan="10" class="placeholder">暂无行情数据</td></tr>';
      return;
    }
    body.innerHTML = q.rows.map(function (row) {
      var baseline = state.baselines[row.code];
      var a = window.Portfolio ? window.Portfolio.analyze(state.position, row, baseline) : null;
      var h = a && a.holding;
      var isHolding = !!(state.position && state.position.code === row.code && h);
      var baseTxt, amtHtml, pctHtml;
      if (a && a.marketChange != null) {
        baseTxt = fmt(a.baseline);
        amtHtml = '<span class="num ' + tone(a.marketChangeAmount) + '">' +
          sign(a.marketChangeAmount) + fmt(a.marketChangeAmount) + "</span>";
        pctHtml = '<span class="pct ' + tone(a.marketChange) + '">' +
          sign(a.marketChange) + fmt(a.marketChange) + "%</span>";
      } else {
        baseTxt = '<span class="no-base">未设置</span>';
        amtHtml = '<span class="dim">—</span>';
        pctHtml = '<span class="dim">—</span>';
      }
      var holdCells = isHolding
        ? '<td><span class="num">' + fmt(h.effectiveCost) + "</span></td>" +
          '<td><span class="num">' + fmt(a.redeem) + "</span></td>" +
          '<td><span class="num">' + fmt(h.grams, 4) + "</span></td>" +
          '<td><span class="pct ' + tone(h.yieldPct) + '">' + sign(h.yieldPct) + fmt(h.yieldPct) + "%</span></td>" +
          '<td><span class="num ' + tone(h.pnl) + '">' + sign(h.pnl) + fmt(h.pnl) + "</span></td>"
        : '<td><span class="dim">—</span></td>' +
          '<td><span class="num">' + fmt(row.redeem) + "</span></td>" +
          '<td><span class="dim">—</span></td>' +
          '<td><span class="dim">—</span></td>' +
          '<td><span class="dim">—</span></td>';
      return '<tr class="' + (isHolding ? "is-holding" : "") + '">' +
        '<td class="name">' + esc(row.name) + "<small>" +
          "官网行情" + "</small></td>" +
        '<td><span class="num">' + fmt(row.active) + "</span></td>" +
        "<td>" + baseTxt + "</td>" +
        "<td>" + amtHtml + "</td>" +
        "<td>" + pctHtml + "</td>" + holdCells + "</tr>";
    }).join("");
  }

  function populateGoldSelect() {
    var rows = (state.quote && state.quote.rows) || [];
    var options = rows.map(function (row) {
      return '<option value="' + esc(row.code) + '">' + esc(row.name) + "</option>";
    }).join("");
    var select = $("posGold");
    var current = select.value || (state.position && state.position.code);
    select.innerHTML = options;
    if (rows.length) {
      var found = Array.prototype.some.call(select.options, function (o) { return o.value === current; });
      select.value = found ? current : rows[0].code;
    }
    // 交易记录金种下拉同步
    var tSelect = $("tradeGold");
    var tCurrent = tSelect.value || state.selectedCode;
    tSelect.innerHTML = options;
    if (rows.length) {
      var tFound = Array.prototype.some.call(tSelect.options, function (o) { return o.value === tCurrent; });
      tSelect.value = tFound ? tCurrent : rows[0].code;
    }
  }

  // ---------- 买入 / 赎回记录 ----------

  // 按金种找到当前行情行，取指定价格字段（买入盈亏参考赎回价）
  function quoteField(code, field) {
    var rows = (state.quote && state.quote.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].code === code) return rows[i][field];
    }
    return null;
  }

  function tradeName(code) {
    var rows = (state.quote && state.quote.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].code === code) return rows[i].name;
    }
    return code;
  }

  function renderTrades() {
    var body = $("tradeBody");
    $("tradeCount").textContent = state.trades.length + " 笔";
    if (!state.trades.length) {
      body.innerHTML = '<tr><td colspan="10" class="placeholder">暂无交易记录，填写上方表单添加一笔买入吧</td></tr>';
      renderTradeSummary();
      return;
    }
    var list = state.trades.slice().reverse();  // 最近在前
    body.innerHTML = list.map(function (t) {
      var isBuy = t.type === "buy";
      var ref = isBuy ? quoteField(t.code, "redeem") : null;   // 买入按当前赎回价算浮动盈亏
      var r = window.Portfolio ? window.Portfolio.tradePnl(t, ref) : null;
      var pnlHtml = '<span class="dim">—</span>';
      var pctHtml = '<span class="dim">—</span>';
      if (r && r.pnl != null) {
        pnlHtml = '<span class="' + tone(r.pnl) + '">' + sign(r.pnl) + fmt(r.pnl) + "</span>";
        pctHtml = '<span class="' + tone(r.pct) + '">' + sign(r.pct) + fmt(r.pct) + "%</span>";
      }
      var refTxt = isBuy ? (r && r.refPrice != null ? fmt(r.refPrice) : "—") : fmt(t.price);
      var costTxt = isBuy ? fmt(t.price) : (t.cost > 0 ? fmt(t.cost) : "—");
      var typeHtml = isBuy
        ? '<span class="trade-badge buy">买入</span>'
        : '<span class="trade-badge sell">赎回</span>';
      return "<tr>" +
        '<td class="t-name">' + esc(tradeName(t.code)) + "</td>" +
        "<td>" + typeHtml + "</td>" +
        '<td class="h-num">' + fmt(t.grams, 4) + "</td>" +
        '<td class="h-num t-price">' + fmt(t.price) + "</td>" +
        '<td class="h-num t-ref">' + refTxt + "</td>" +
        '<td class="h-num">' + costTxt + "</td>" +
        '<td class="h-num t-pnl">' + pnlHtml + "</td>" +
        '<td class="h-num t-pct">' + pctHtml + "</td>" +
        '<td class="t-time">' + esc(fmtTradeTime(t.time)) + "</td>" +
        '<td><button type="button" class="t-del" data-id="' + esc(t.id) + '" aria-label="删除">×</button></td>' +
        "</tr>";
    }).join("");
    renderTradeSummary();
  }

  function fmtTradeTime(t) {
    return String(t || "").replace("T", " ");
  }

  function renderTradeSummary() {
    var el = $("tradeSummary");
    // 逐笔现价可能属于不同金种，逐笔取当前赎回价后累加（不共用单一现价）
    var buyGrams = 0, sellGrams = 0, buyCost = 0, sellProceeds = 0;
    var floating = 0, realized = 0, hasF = false, hasR = false;
    state.trades.forEach(function (t) {
      var ref = t.type === "buy" ? quoteField(t.code, "redeem") : null;
      var r = window.Portfolio ? window.Portfolio.tradePnl(t, ref) : null;
      if (!r) return;
      if (t.type === "buy") {
        buyGrams += r.grams; buyCost += r.costTotal;
        if (r.pnl != null) { floating += r.pnl; hasF = true; }
      } else {
        sellGrams += r.grams; sellProceeds += r.market;
        if (r.pnl != null) { realized += r.pnl; hasR = true; }
      }
    });
    var total = (hasF ? floating : 0) + (hasR ? realized : 0);
    var net = buyGrams - sellGrams;
    el.innerHTML =
      '<div class="ts-item"><span class="ts-label">净持仓</span>' +
        '<span class="ts-value">' + fmt(net, 4) + "<small>克</small></span>" +
        '<span class="ts-sub">买入 ' + fmt(buyGrams, 4) + " · 赎回 " + fmt(sellGrams, 4) + "</span></div>" +
      '<div class="ts-item"><span class="ts-label">累计投入</span>' +
        '<span class="ts-value">' + fmt(buyCost) + "<small>元</small></span>" +
        '<span class="ts-sub">赎回到账 ' + fmt(sellProceeds) + " 元</span></div>" +
      '<div class="ts-item"><span class="ts-label">浮动盈亏</span>' +
        '<span class="ts-value ' + tone(floating) + '">' + (hasF ? sign(floating) + fmt(floating) : "—") + "<small>元</small></span>" +
        '<span class="ts-sub">买入未卖出 · 随实时价</span></div>' +
      '<div class="ts-item"><span class="ts-label">已实现盈亏</span>' +
        '<span class="ts-value ' + tone(realized) + '">' + (hasR ? sign(realized) + fmt(realized) : "—") + "<small>元</small></span>" +
        '<span class="ts-sub">赎回部分 · 已锁定</span></div>' +
      '<div class="ts-item"><span class="ts-label">合计盈亏</span>' +
        '<span class="ts-value ' + tone(total) + '">' + (hasF || hasR ? sign(total) + fmt(total) : "—") + "<small>元</small></span>" +
        '<span class="ts-sub">浮动 + 已实现</span></div>';
  }

  function syncTradeCostBox() {
    $("tradeCostBox").hidden = $("tradeType").value !== "sell";
  }

  function addTrade(event) {
    event.preventDefault();
    var grams = Number($("tradeGrams").value);
    var price = Number($("tradePrice").value);
    var type = $("tradeType").value;
    var costRaw = $("tradeCost").value.trim();
    var cost = costRaw === "" ? null : Number(costRaw);
    if (!(grams > 0) || !(price > 0)) return;
    if (type === "sell" && cost !== null && !(cost > 0)) return;
    state.trades.push({
      id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 7),
      type: type, code: $("tradeGold").value,
      grams: grams, price: price, cost: type === "sell" ? cost : null,
      time: $("tradeTime").value || new Date().toISOString().slice(0, 16).replace("T", " ")
    });
    persistTrades();
    $("tradeForm").reset();
    syncTradeCostBox();
    renderTrades();
    drawBase();
  }

  function savePosition(event) {
    event.preventDefault();
    var grams = Number($("posGrams").value);
    var cost = Number($("posCost").value);
    var raw = $("posTotal").value.trim();
    var total = raw === "" ? null : Number(raw);
    if (!(grams > 0) || !(cost > 0) || (total !== null && !(total > 0))) {
      $("positionUpdated").textContent = "请输入有效的克数和成本价";
      return;
    }
    state.position = {
      code: $("posGold").value, grams: grams, cost: cost, total: total,
      basis: $("posBasis").value, savedAt: nowText()
    };
    persistPosition();
    $("positionUpdated").textContent = "已保存 " + state.position.savedAt;
    var currentRow = null;
    ((state.quote && state.quote.rows) || []).forEach(function (r) {
      if (r.code === state.position.code) currentRow = r;
    });
    var currentPrice = currentRow && currentRow[state.position.basis];
    if (currentPrice > 0) addPositionNode(currentPrice);
    renderPosition(); renderPnlTable(); drawPnlChart();
    state.needHistory = true; loadHistory();
  }

  function renderPosition() {
    var p = state.position;
    var box = $("positionResult");
    if (!p) {
      box.innerHTML = '<div class="position-empty">按截图预填了 10 克 / 886.86 元，点「保存持仓」后即可实时跟踪盈亏。</div>';
      return;
    }
    var rows = (state.quote && state.quote.rows) || [];
    var row = null;
    rows.forEach(function (r) { if (r.code === p.code) row = r; });
    if (!row) row = rows[0];
    var price = row && row[p.basis];
    if (price == null || !(price > 0)) {
      box.innerHTML = '<div class="position-empty">正在获取「' + esc(row ? row.name : "该金种") + '」价格…</div>';
      return;
    }

    var calc = window.Portfolio && window.Portfolio.calc(p, price);
    if (!calc) {
      box.innerHTML = '<div class="position-empty">持仓数据不完整，请重新保存。</div>';
      return;
    }
    var costTotal = calc.costTotal, effectiveCost = calc.effectiveCost;
    var market = calc.market, pnl = calc.pnl, pnlPct = calc.pnlPct, ratio = calc.ratio;
    var basisName = { active: "主动积存价", redeem: "赎回价", regular: "定期积存价" }[p.basis] || "市价";

    box.innerHTML =
      '<div class="pos-metric"><div class="label">参考市值</div>' +
        '<div class="num big">' + fmt(market) + '<small> 元</small></div>' +
        '<div class="sub">' + fmt(p.grams, 4) + " 克 × " + fmt(price) + " 元/克（" + basisName + "）</div></div>" +
      '<div class="pos-metric"><div class="label">持仓成本</div>' +
        '<div class="num">' + fmt(costTotal) + '<small> 元</small></div>' +
        '<div class="sub">成本价 ' + fmt(effectiveCost) + " 元/克</div></div>" +
      '<div class="pos-metric"><div class="label">浮动盈亏</div>' +
        '<div class="num big ' + tone(pnl) + '">' + sign(pnl) + fmt(pnl) + '<small> 元</small></div>' +
        '<div class="sub ' + tone(pnl) + '">盈亏比 ' + sign(pnlPct) + fmt(pnlPct) + "%</div></div>" +
      '<div class="pos-metric"><div class="label">回本需涨</div>' +
        '<div class="num">' + (pnl > 0 ? "已盈利" : "+" + fmt(calc.breakEven) + "%") + '</div>' +
        '<div class="sub">现价 ' + fmt(price) + " → 成本 " + fmt(effectiveCost) + "</div></div>" +
      '<div class="pos-bar"><i style="width:' + ratio.toFixed(1) + "%;background:" + (pnl >= 0 ? "#f2555a" : "#35c07a") + '"></i></div>' +
      '<div class="pos-note">市值 / 成本 = ' + ratio.toFixed(1) + "%。持仓数据保存在本机浏览器，刷新页面不会丢失。</div>";
  }

  // ---------- 轮询调度 ----------
  function scheduleNext() {
    clearTimeout(state.timer);
    var factor = state.errorStreak ? Math.min(Math.pow(2, state.errorStreak), 16) : 1;
    state.cycleMs = state.intervalSec * 1000 * factor;
    state.nextAt = Date.now() + state.cycleMs;
    state.timer = setTimeout(function () { refresh(false); }, state.cycleMs);
  }

  function tickCountdown() {
    if (document.hidden) return;
    var left = Math.max(0, state.nextAt - Date.now());
    $("countdown").textContent = (left / 1000).toFixed(1) + "s";
    $("progressBar").style.width = Math.max(0, Math.min(100, (1 - left / state.cycleMs) * 100)) + "%";
  }

  function refresh(force) {
    if (state.busy) return;
    state.busy = true;
    $("refreshBtn").disabled = true;
    apiFetch("/api/quote" + (force ? "?force=1" : ""), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (q) {
        if (q.rows && q.rows.length) {
          state.quote = q;
          if (!state.selectedCode) state.selectedCode = q.rows[0].code;
        }
        state.pollCount++;
        // 后台线程每 4 秒采集一次并写库；seq 前进说明有新快照，重载历史图表
        if (typeof q.seq === "number") {
          if (state.lastSeq < 0) state.lastSeq = q.seq - 1;
          if (q.seq !== state.lastSeq) { state.lastSeq = q.seq; state.needHistory = true; }
        } else if (q.cached === false) {
          state.needHistory = true;  // 兼容旧版服务端
        }
        if (state.needHistory || state.pollCount % 5 === 0) {
          state.needHistory = false;
          loadHistory();
        }
        $("sourceTime").textContent = "工行更新时间 " + (q.source_time || "--");
        $("fetchTime").textContent = "本地采集 " + (q.fetched_at || "--");
        var latency = q.latency_ms && q.latency_ms.page;
        $("latency").textContent = "上游 " + (latency == null ? "--" : latency) + " ms";
        renderBanner(q); renderTabs(); renderCards(); renderTable();
        populateGoldSelect(); renderPosition(); renderBaseline(); renderPnlTable(); renderTrades();
        state.errorStreak = 0;
      })
      .catch(function (e) {
        state.errorStreak++;
        $("banner").textContent = "无法连接本地数据服务：" + e.message;
        $("banner").className = "banner show";
        setStatus("err", "服务未连接");
      })
      .finally(function () {
        state.busy = false;
        $("refreshBtn").disabled = false;
        scheduleNext();
      });
  }

  // ---------- 事件 ----------
  $("tradeForm").addEventListener("submit", addTrade);
  $("tradeType").addEventListener("change", syncTradeCostBox);
  $("tradeClear").addEventListener("click", function () {
    if (!state.trades.length) return;
    if (!window.confirm("确定清空全部 " + state.trades.length + " 笔交易记录？此操作不可恢复。")) return;
    state.trades = [];
    persistTrades();
    renderTrades();
    drawBase();
  });
  $("tradeBody").addEventListener("click", function (e) {
    var btn = e.target.closest(".t-del");
    if (!btn) return;
    var id = btn.getAttribute("data-id");
    state.trades = state.trades.filter(function (t) { return t.id !== id; });
    persistTrades();
    renderTrades();
    drawBase();
  });

  $("positionForm").addEventListener("submit", savePosition);
  $("posClear").addEventListener("click", function () {
    state.position = null;
    persistPosition();
    $("positionUpdated").textContent = "未保存";
    renderPosition(); renderPnlTable(); drawPnlChart();
  });
  $("posClearNodes").addEventListener("click", function () {
    state.positionNodes = [];
    persistPositionNodes();
    renderPositionNodes();
    drawBase();
  });
  $("posBasis").addEventListener("change", function () {
    if (state.position) {
      state.position.basis = this.value; persistPosition(); renderPosition();
      renderPnlTable(); drawPnlChart();
    }
  });
  $("posGold").addEventListener("change", function () {
    if (state.position) {
      state.position.code = this.value; persistPosition(); renderPosition(); renderPnlTable();
      state.needHistory = true; loadHistory();
    }
  });

  $("baselineSave").addEventListener("click", function () {
    setBaseline($("baselinePrice").value, "已保存该金种的昨收基准价");
  });
  $("baselineNow").addEventListener("click", function () {
    var row = mainRow();
    if (!row || !(row.active > 0)) return;
    setBaseline(row.active, "已用当前价 " + fmt(row.active) + " 作为基准（仅作参考，非昨收）");
  });
  $("baselineFirst").addEventListener("click", function () {
    var today = new Date().toDateString();
    var first = null;
    state.history.forEach(function (r) {
      if (r.code !== state.selectedCode || r.active == null) return;
      var d = parseTime(r.fetched_at || r.t);
      if (isNaN(d.getTime()) || d.toDateString() !== today) return;
      if (first == null || d.getTime() < first.t) first = { t: d.getTime(), v: r.active };
    });
    if (!first) {
      $("baselineHint").textContent = "暂无今日历史快照，可稍后再试或手动填写";
      return;
    }
    setBaseline(first.v, "已用今日首笔价 " + fmt(first.v) + " 作为基准（近似昨收）");
  });

  $("refreshBtn").addEventListener("click", function () { refresh(true); });
  $("interval").addEventListener("change", function () {
    state.intervalSec = Number(this.value);
    scheduleNext();
  });
  $("rangeTabs").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-range]");
    if (!btn) return;
    state.rangeMinutes = Number(btn.getAttribute("data-range"));
    this.querySelectorAll("button").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    drawBase();
  });
  $("pnlRangeTabs").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-range]");
    if (!btn) return;
    state.pnlRangeMinutes = Number(btn.getAttribute("data-range"));
    this.querySelectorAll("button").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    drawPnlChart();
  });
  $("klinePeriodTabs").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-period]");
    if (!btn) return;
    state.klinePeriod = btn.getAttribute("data-period");
    this.querySelectorAll("button").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    drawKlineChart();
  });
  $("legend").addEventListener("change", function (e) {
    var key = e.target.getAttribute("data-series");
    if (!key) return;
    state.series[key] = e.target.checked;
    drawBase();
  });
  $("pnlLegend").addEventListener("change", function (e) {
    var key = e.target.getAttribute("data-series");
    if (!key) return;
    state.pnlChart[key] = e.target.checked;
    drawPnlChart();
  });
  $("chart").addEventListener("mousemove", function (e) {
    state.hoverX = e.clientX - this.getBoundingClientRect().left;
    scheduleComposite();
  });
  $("chart").addEventListener("mouseleave", function () {
    state.hoverX = null;
    scheduleComposite();
  });
  $("pnlChart").addEventListener("mousemove", function (e) {
    state.pnlHoverX = e.clientX - this.getBoundingClientRect().left;
    schedulePnlComposite();
  });
  $("pnlChart").addEventListener("mouseleave", function () {
    state.pnlHoverX = null;
    schedulePnlComposite();
  });
  $("klineChart").addEventListener("mousemove", function (e) {
    state.klineHoverX = e.clientX - this.getBoundingClientRect().left;
    scheduleKlineComposite();
  });
  $("klineChart").addEventListener("mouseleave", function () {
    state.klineHoverX = null;
    scheduleKlineComposite();
  });
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { drawBase(); drawPnlChart(); drawKlineChart(); });
    document.querySelectorAll(".chart-wrap").forEach(function (el) { ro.observe(el); });
  } else {
    window.addEventListener("resize", function () { drawBase(); drawPnlChart(); drawKlineChart(); });
  }
  document.addEventListener("visibilitychange", function () {
    if (!state.authed) return;
    if (document.hidden) {
      clearTimeout(state.timer);
    } else {
      refresh(true);
    }
  });

  // ---------- 登录 / 注册 ----------
  $("authSwitch").addEventListener("click", function () {
    setAuthMode(state.authMode === "login" ? "register" : "login", false);
  });
  $("authForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var username = $("authUser").value.trim();
    var password = $("authPass").value;
    var errEl = $("authError");
    errEl.textContent = "";
    if (!username || !password) { errEl.textContent = "请填写用户名和密码"; return; }
    var isReg = state.authMode === "register";
    var btn = $("authSubmit");
    btn.disabled = true;
    btn.textContent = isReg ? "注册中…" : "登录中…";
    fetch("/api/auth/" + (isReg ? "register" : "login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(function (r) {
        return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
      })
      .then(function (res) {
        if (!res.ok) { errEl.textContent = (res.data && res.data.error) || "操作失败"; return; }
        state.authed = true;
        $("authModal").hidden = true;
        $("userChip").hidden = false;
        $("userName").textContent = username;
        $("userAvatar").textContent = username.slice(0, 1).toUpperCase();
        $("authPass").value = "";
        bootApp();
      })
      .catch(function () { errEl.textContent = "无法连接本地服务"; })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = isReg ? "注册并登录" : "登录";
      });
  });
  $("logoutBtn").addEventListener("click", function () {
    fetch("/api/auth/logout", { method: "POST" })
      .catch(function () {})
      .finally(function () {
        clearTimeout(state.timer);
        $("userChip").hidden = true;
        state.authed = false;
        state.quote = null;
        state.history = [];
        state.historyKline = [];
        state.pnlHistory = [];
        state.pnlHistoryKline = [];
        setAuthMode("login", false);
        showAuth();
      });
  });

  // ---------- 金种资料弹层 ----------
  $("goldInfoBtn").addEventListener("click", function () {
    renderGoldInfoList();
    $("goldInfoModal").hidden = false;
  });
  $("goldInfoClose").addEventListener("click", function () { $("goldInfoModal").hidden = true; });
  $("goldInfoModal").addEventListener("click", function (e) {
    if (e.target === this) this.hidden = true;
  });
  $("goldInfoList").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var row = btn.closest(".gold-info-row");
    if (!row) return;
    if (btn.getAttribute("data-act") === "save") saveGoldTypeRow(row);
    else if (btn.getAttribute("data-act") === "star") toggleGoldStar(row);
  });

  // ---------- AI 每日分析 ----------
  var analysisState = { reports: [], activeDate: null, loading: false };

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  // 极简 Markdown 渲染：标题/表格/列表/引用/分割线/加粗。内容由本地服务生成，仍先转义。
  function mdInline(text) {
    return esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  function renderMarkdown(md) {
    var lines = String(md || "").split(/\r?\n/);
    var out = [], i = 0;
    function isTableSep(s) { return /^\|?[\s:\-\|]+\|/.test(s) && s.indexOf("-") >= 0; }
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { var lv = h[1].length; out.push("<h" + lv + ">" + mdInline(h[2]) + "</h" + lv + ">"); i++; continue; }
      if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (line.trim().indexOf("|") === 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = line.replace(/^\||\|$/g, "").split("|").map(function (x) { return x.trim(); });
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].trim().indexOf("|") === 0 && lines[i].trim()) {
          rows.push(lines[i].replace(/^\||\|$/g, "").split("|").map(function (x) { return x.trim(); }));
          i++;
        }
        var t = '<table><thead><tr>' + head.map(function (c) { return "<th>" + mdInline(c) + "</th>"; }).join("") + '</tr></thead><tbody>';
        t += rows.map(function (r) {
          return "<tr>" + head.map(function (_, ci) { return "<td>" + mdInline(r[ci] == null ? "" : r[ci]) + "</td>"; }).join("") + "</tr>";
        }).join("");
        out.push(t + "</tbody></table>");
        continue;
      }
      if (/^>\s?/.test(line)) {
        var qt = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { qt.push(lines[i].replace(/^>\s?/, "")); i++; }
        out.push("<blockquote>" + qt.map(mdInline).join("<br>") + "</blockquote>");
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        var li = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) { li.push(lines[i].replace(/^[-*]\s+/, "")); i++; }
        out.push("<ul>" + li.map(function (x) { return "<li>" + mdInline(x) + "</li>"; }).join("") + "</ul>");
        continue;
      }
      var para = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|[-*]\s|---+\s*$)/.test(lines[i]) &&
             !(lines[i].trim().indexOf("|") === 0 && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        para.push(lines[i]); i++;
      }
      out.push("<p>" + para.map(mdInline).join("<br>") + "</p>");
    }
    return out.join("");
  }

  function loadAnalysisConfig() {
    return apiFetch("/api/analysis/config", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var pill = $("analysisConfigPill");
        if (!res || !res.ok) { pill.textContent = "AI 状态未知"; return; }
        if (res.configured) {
          pill.textContent = "DeepSeek 已就绪";
          pill.className = "meta-pill ai-on";
          pill.title = "模型 " + (res.model || "deepseek-chat") + " · 收盘自动生成" +
            (res.auto_on_close ? "开" : "关") + " · 报告目录 " + (res.report_dir || "行情记录");
        } else {
          pill.textContent = "未配置 Key · 仅记录特征";
          pill.className = "meta-pill ai-off";
          pill.title = "未配置 DeepSeek API Key：涨跌特征仍会完整记录，AI 点评跳过。" +
            "请在项目根目录 ai_config.json 填入 api_key。";
        }
      })
      .catch(function () { $("analysisConfigPill").textContent = "AI 状态未知"; });
  }

  function loadAnalysisReports(selectDate) {
    return apiFetch("/api/analysis/reports", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        analysisState.reports = (res && res.items) || [];
        renderAnalysisList();
        if (selectDate) openAnalysisReport(selectDate);
      })
      .catch(function () { /* 静默：不影响行情主流程 */ });
  }

  function renderAnalysisList() {
    var box = $("analysisList");
    if (!analysisState.reports.length) {
      box.innerHTML = '<div class="analysis-empty">暂无报告，收盘后自动生成，或点「生成/刷新」</div>';
      return;
    }
    box.innerHTML = analysisState.reports.map(function (r) {
      var active = r.date === analysisState.activeDate ? " active" : "";
      return '<button type="button" class="ar-item' + active + '" data-date="' + esc(r.date) + '">' +
        '<span class="ar-date">' + esc(r.date) + '</span>' +
        '<span class="ar-meta">更新 ' + esc((r.mtime || "").slice(5, 16)) + ' · ' +
        (r.size < 1024 ? r.size + " B" : (r.size / 1024).toFixed(1) + " KB") + '</span></button>';
    }).join("");
  }

  function openAnalysisReport(date) {
    analysisState.activeDate = date;
    renderAnalysisList();
    $("analysisDoc").innerHTML = '<div class="analysis-empty">报告加载中…</div>';
    apiFetch("/api/analysis/report?date=" + encodeURIComponent(date), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("missing"); return r.text(); })
      .then(function (md) {
        $("analysisDoc").innerHTML = '<article class="md-body">' + renderMarkdown(md) + '</article>';
        $("analysisDoc").scrollTop = 0;
      })
      .catch(function () {
        $("analysisDoc").innerHTML = '<div class="analysis-empty">报告读取失败</div>';
      });
  }

  function generateAnalysis() {
    var btn = $("analysisGenBtn");
    if (analysisState.loading) return;
    var date = $("analysisDate").value || todayStr();
    analysisState.loading = true;
    btn.disabled = true; btn.textContent = "生成中…";
    $("analysisDoc").innerHTML = '<div class="analysis-empty">正在生成 ' + esc(date) +
      ' 的分析（如已配置 AI，调用 DeepSeek 可能需要几十秒）…</div>';
    apiFetch("/api/analysis/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: date, force: true })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.data.ok) {
          $("analysisDoc").innerHTML = '<div class="analysis-empty">生成失败：' +
            esc((res.data && res.data.error) || "未知错误") + '</div>';
          return;
        }
        $("analysisDate").value = res.data.day || date;
        return loadAnalysisReports(res.data.day || date).then(function () {
          if (res.data.ai_status === "no_key") {
            $("analysisConfigPill").textContent = "未配置 Key · 仅记录特征";
          }
        });
      })
      .catch(function () {
        $("analysisDoc").innerHTML = '<div class="analysis-empty">生成失败：无法连接本地服务</div>';
      })
      .finally(function () {
        analysisState.loading = false;
        btn.disabled = false; btn.textContent = "生成/刷新";
      });
  }

  $("analysisGenBtn").addEventListener("click", generateAnalysis);
  $("analysisList").addEventListener("click", function (e) {
    var item = e.target.closest(".ar-item");
    if (item) openAnalysisReport(item.getAttribute("data-date"));
  });

  // ---------- 启动：鉴权通过后才拉数据 ----------
  var booted = false;
  function bootApp() {
    if (booted) return;
    booted = true;
    if (!$("analysisDate").value) $("analysisDate").value = todayStr();
    loadAnalysisConfig();
    loadAnalysisReports();
    syncTradeCostBox();
    renderTrades();
    renderPositionNodes();
    renderBaseline();
    loadPortfolio().then(function () {
      syncTradeCostBox();
      renderPosition(); renderTrades(); renderPositionNodes();
      renderBaseline(); renderPnlTable(); drawBase(); drawPnlChart();
    });
    loadGoldTypes();
    scheduleNext();
    refresh(true);
  }

  setInterval(tickCountdown, 100);
  checkAuth();
})();
