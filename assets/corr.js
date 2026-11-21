/* 盘面分析：板块涨跌 与 黄金涨跌 的相关性
 * 数据：/api/corr/result（摘要）+ /api/corr/detail（单板块序列）
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  var state = {
    options: null,
    bench: "gold_etf",
    window: 250,
    payload: null,
    activeSector: null,
    detailTab: "scatter",
    detail: null,
    loading: false,
    started: false,
    reqId: 0,
    detailSeq: 0
  };

  var COLORS = {
    up: "#f2555a",
    down: "#35c07a",
    flat: "#8a9bb2",
    blue: "#5aa9f7",
    gold: "#e9b94f",
    text: "#e9eff8",
    muted: "#8a9bb2",
    grid: "rgba(41,54,74,.85)",
    panel: "#0f1319"
  };

  // ---------------- 格式化 ----------------
  function fx(v, d) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return Number(v).toFixed(d === undefined ? 2 : d);
  }
  function fpct(v, d) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    var n = Number(v) * 100;
    return (n > 0 ? "+" : "") + n.toFixed(d === undefined ? 2 : d) + "%";
  }
  function fp(p) {
    if (p === null || p === undefined || isNaN(p)) return "—";
    if (p < 0.0001) return "<0.0001";
    if (p < 0.01) return p.toFixed(5);
    return p.toFixed(4);
  }
  function tone(v) {
    if (v === null || v === undefined) return "mm-stat-flat";
    return v > 0 ? "mm-stat-up" : (v < 0 ? "mm-stat-down" : "mm-stat-flat");
  }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---------------- 数据加载 ----------------
  function loadOptions() {
    return fetch("/api/corr/options", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.options = d;
        state.bench = d.default_bench || "gold_etf";
        state.window = d.default_window || 250;
        renderBench();
        renderWindows();
      })
      .catch(function () { /* 选项加载失败时用默认值 */ });
  }

  function loadResult(force) {
    var myId = ++state.reqId;
    showLoading(true);
    var url = "/api/corr/result?bench=" + encodeURIComponent(state.bench) +
      "&window=" + state.window + (force ? "&force=1" : "");
    return fetch(url, { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (myId !== state.reqId) return;
        if (!d.ok) {
          state.payload = null;
          showEmpty(d.error || "分析失败");
          return;
        }
        state.payload = d;
        showEmpty("");
        renderAll();
      })
      .catch(function (e) {
        if (myId === state.reqId) showEmpty("网络错误：" + e.message);
      })
      .then(function () {
        if (myId === state.reqId) showLoading(false);
      });
  }

  function loadDetail(sector) {
    if (!sector) return;
    var myId = ++state.detailSeq;
    var url = "/api/corr/detail?bench=" + encodeURIComponent(state.bench) +
      "&window=" + state.window + "&sector=" + encodeURIComponent(sector);
    fetch(url, { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (myId !== state.detailSeq) return;
        if (!d.ok) return;
        state.detail = d;
        $("crDetailPanel").hidden = false;
        renderDetailMeta();
        drawChart();
      })
      .catch(function () { /* 忽略单板块详情失败 */ });
  }

  // ---------------- 渲染：基础控件 ----------------
  function renderBench() {
    var box = $("crBench");
    if (!box) return;
    var list = (state.options && state.options.benchmarks) || [];
    box.innerHTML = list.map(function (b) {
      return '<button type="button" data-bench="' + esc(b.key) + '"' +
        (b.key === state.bench ? ' class="active"' : '') + '>' +
        esc(b.name) + '<small>' + esc(b.note) + '</small></button>';
    }).join("");
  }

  function renderWindows() {
    var box = $("crWindows");
    if (!box) return;
    var list = (state.options && state.options.windows) || [];
    box.innerHTML = list.map(function (w) {
      return '<button type="button" data-window="' + w.key + '"' +
        (w.key === state.window ? ' class="active"' : '') + '>' + esc(w.name) + '</button>';
    }).join("");
  }

  function renderAll() {
    renderGoldCard();
    renderKpis();
    renderBars();
    $("crRange").textContent = state.payload.date_from + " ~ " + state.payload.date_to;
    $("crSample").textContent = state.payload.sample + " 个交易日 · " + state.payload.bench_name;
    $("crUpdated").textContent = "更新于 " + (state.payload.computed_at || "").slice(11, 16);
    // 默认选中相关性最强的板块
    var first = (state.payload.sectors || [])[0];
    if (first) {
      selectSector(first.name, false);
    } else {
      $("crDetailPanel").hidden = true;
    }
  }

  function renderGoldCard() {
    var box = $("crGoldCard");
    var p = state.payload;
    if (!box || !p) return;
    var ret = p.bench_total_return;
    box.innerHTML =
      '<div class="cr-gold-head"><b>' + esc(p.bench_name) + '</b><span>基准</span></div>' +
      '<div class="cr-gold-pct ' + tone(ret) + '">' + fpct(ret) + '</div>' +
      '<div class="cr-gold-sub"><span>区间累计</span><span>年化波动 ' + fx((p.bench_vol_annual || 0) * 100, 1) + '%</span></div>' +
      '<div class="cr-gold-sub" style="margin-top:3px"><span>' + esc(p.date_from.slice(5)) + ' 起</span><span>' + p.sample + ' 日</span></div>';
  }

  function renderKpis() {
    var box = $("crKpis");
    var p = state.payload;
    if (!box || !p) return;
    var sectors = p.sectors || [];
    var pos = sectors.filter(function (s) { return (s.r || 0) > 0; })[0];
    var negs = sectors.filter(function (s) { return (s.r || 0) < 0; })
      .sort(function (a, b) { return a.r - b.r; })[0];
    var sig = sectors.filter(function (s) { return s.p_adj !== null && s.p_adj < 0.05; }).length;

    var cards = [];
    cards.push({
      k: "最强正相关",
      v: pos ? esc(pos.name) : "无",
      cls: pos ? "mm-stat-up" : "",
      s: pos ? "r = " + fx(pos.r, 3) + " · " + pos.strength : "—"
    });
    cards.push({
      k: "最强负相关",
      v: (negs && Math.abs(negs.r) >= 0.15) ? esc(negs.name) : "无明显",
      cls: (negs && Math.abs(negs.r) >= 0.15) ? "mm-stat-down" : "",
      s: negs ? "最低 r = " + fx(negs.r, 3) + (Math.abs(negs.r) >= 0.15 ? " · " + negs.strength : " · 接近无关")
        : "无反向板块"
    });
    cards.push({
      k: "统计显著板块",
      v: sig + " / " + sectors.length,
      cls: "mm-stat-flat",
      s: "FDR 校正后 q < 0.05"
    });
    cards.push({
      k: "黄金区间涨跌",
      v: fpct(p.bench_total_return),
      cls: tone(p.bench_total_return),
      s: p.date_from + " 起"
    });

    box.innerHTML = cards.map(function (c) {
      return '<div class="cr-kpi"><div class="k">' + c.k + '</div>' +
        '<div class="v ' + c.cls + '">' + c.v + '</div>' +
        '<div class="s">' + c.s + '</div></div>';
    }).join("");
  }

  function renderBars() {
    var box = $("crBars");
    var p = state.payload;
    if (!box || !p) return;
    var sectors = p.sectors || [];
    if (!sectors.length) {
      box.innerHTML = '<div class="cr-hint">无可用板块</div>';
      return;
    }
    var html = sectors.map(function (s) {
      var r = s.r === null || s.r === undefined ? 0 : s.r;
      var w = Math.max(1.2, Math.min(50, Math.abs(r) * 50));
      var isPos = r >= 0;
      var sig = s.p_adj !== null && s.p_adj < 0.05;
      var dirCls = r >= 0.15 ? "pos" : (r <= -0.15 ? "neg" : "");
      return '<div class="cr-bar-row" data-sector="' + esc(s.name) + '">' +
        '<div class="cr-bar-name" title="' + esc(s.name) + '">' + esc(s.name) +
        '<em>' + (s.members || 0) + '只</em></div>' +
        '<div class="cr-bar-track"><div class="cr-bar-zero"></div>' +
        '<div class="cr-bar-fill ' + (isPos ? "pos" : "neg") + (sig ? "" : " dim") +
        '" style="width:' + w + '%"></div></div>' +
        '<div class="cr-bar-val ' + tone(r) + '">' + (r > 0 ? "+" : "") + fx(r, 3) + '</div>' +
        '<div class="cr-bar-tag ' + dirCls + (sig ? " sig" : "") + '" title="' +
        (sig ? "FDR q=" + fp(s.p_adj) + " 显著" : "q=" + fp(s.p_adj) + " 不显著") + '">' +
        (sig ? esc(s.strength) : "—") + '</div>' +
        '</div>';
    }).join("");
    box.innerHTML = html;
  }

  // ---------------- 交互 ----------------
  function selectSector(name, scroll) {
    state.activeSector = name;
    var rows = $("crBars").querySelectorAll(".cr-bar-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle("active", rows[i].getAttribute("data-sector") === name);
    }
    $("crDetailTitle").textContent = name + " × " + (state.payload ? state.payload.bench_name : "黄金");
    loadDetail(name);
  }

  function renderDetailMeta() {
    var box = $("crDetailMeta");
    var d = state.detail;
    if (!box || !d || !d.sector) return;
    var s = d.sector;
    var ll = s.lead_lag || {};
    var items = [
      ["Pearson r", fx(s.r, 3)],
      ["Spearman ρ", fx(s.rho, 3)],
      ["p 值", fp(s.p)],
      ["FDR q 值", fp(s.p_adj)],
      ["样本", s.n + " 日"],
      ["beta(对黄金)", fx(s.beta, 2)],
      ["R²", fx(s.r2, 3)],
      ["成分股", s.members + "/" + s.member_total + " 只"],
      ["板块领先", fx(ll.sector_leads, 3)],
      ["黄金领先", fx(ll.gold_leads, 3)],
      ["板块年化波动", fx((s.vol || 0) * Math.sqrt(250) * 100, 1) + "%"]
    ];
    box.innerHTML = items.map(function (it) {
      return '<span>' + it[0] + ' <b>' + it[1] + '</b></span>';
    }).join("");
  }

  function setTab(tab) {
    state.detailTab = tab;
    var btns = $("crDetailTabs").querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].getAttribute("data-tab") === tab);
    }
    drawChart();
  }

  function showLoading(on) {
    state.loading = on;
    $("crLoading").hidden = !on;
  }
  function showEmpty(msg) {
    var box = $("crEmpty");
    if (!msg) { box.hidden = true; return; }
    $("crEmptyMsg").textContent = msg;
    box.hidden = false;
  }

  // ---------------- 图表 ----------------
  function canvasCtx() {
    var cv = $("crCanvas");
    if (!cv) return null;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 600;
    var h = cv.clientHeight || 290;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function axisFont(ctx, size) {
    ctx.font = (size || 10) + "px -apple-system,'Microsoft YaHei',sans-serif";
  }

  function drawChart() {
    var c = canvasCtx();
    if (!c) return;
    var s = state.detail && state.detail.sector;
    if (!s) {
      c.ctx.fillStyle = COLORS.muted;
      axisFont(c.ctx, 12);
      c.ctx.textAlign = "center";
      c.ctx.fillText("选择左侧板块查看详情", c.w / 2, c.h / 2);
      return;
    }
    if (state.detailTab === "trend") drawTrend(c, s);
    else if (state.detailTab === "rolling") drawRolling(c, s);
    else drawScatter(c, s);
  }

  function plotBox(w, h, padLeft, padBottom) {
    var pl = padLeft || 52, pb = padBottom || 30, pt = 16, pr = 16;
    return { x: pl, y: pt, w: Math.max(10, w - pl - pr), h: Math.max(10, h - pt - pb) };
  }

  function drawGrid(ctx, box, yMin, yMax, yTicks, fmt, xLabels) {
    ctx.save();
    axisFont(ctx, 9.5);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (var i = 0; i <= yTicks; i++) {
      var v = yMin + (yMax - yMin) * i / yTicks;
      var y = box.y + box.h - box.h * i / yTicks;
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(box.x, y);
      ctx.lineTo(box.x + box.w, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(fmt(v), box.x - 7, y);
    }
    if (xLabels && xLabels.length) {
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = COLORS.muted;
      for (var k = 0; k < xLabels.length; k++) {
        var px = box.x + box.w * (xLabels.length === 1 ? 0.5 : k / (xLabels.length - 1));
        if (k === xLabels.length - 1) ctx.textAlign = "right";
        else if (k === 0) ctx.textAlign = "left";
        else ctx.textAlign = "center";
        ctx.fillText(xLabels[k], px, box.y + box.h + 7);
      }
    }
    ctx.restore();
  }

  function drawScatter(c, s) {
    var ctx = c.ctx, box = plotBox(c.w, c.h);
    var pts = s.scatter || [];
    if (!pts.length) return;
    var xs = pts.map(function (p) { return p[0]; });
    var ys = pts.map(function (p) { return p[1]; });
    var xMax = Math.max.apply(null, xs.map(Math.abs)) || 0.01;
    var yMax = Math.max.apply(null, ys.map(Math.abs)) || 0.01;
    var lim = Math.max(xMax, yMax) * 1.12;
    lim = Math.min(lim, 0.15);

    var X = function (v) { return box.x + box.w * (v + lim) / (2 * lim); };
    var Y = function (v) { return box.y + box.h - box.h * (v + lim) / (2 * lim); };

    drawGrid(ctx, box, -lim, lim, 4, function (v) { return (v * 100).toFixed(1) + "%"; },
      ["-" + (lim * 100).toFixed(1) + "%", "0%", "+" + (lim * 100).toFixed(1) + "%"]);

    // 原点十字
    ctx.strokeStyle = "rgba(90,169,247,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(0), box.y); ctx.lineTo(X(0), box.y + box.h);
    ctx.moveTo(box.x, Y(0)); ctx.lineTo(box.x + box.w, Y(0));
    ctx.stroke();

    // 散点
    ctx.fillStyle = "rgba(90,169,247,.5)";
    for (var i = 0; i < pts.length; i++) {
      var px = X(pts[i][0]), py = Y(pts[i][1]);
      if (px < box.x - 2 || px > box.x + box.w + 2 || py < box.y - 2 || py > box.y + box.h + 2) continue;
      ctx.beginPath();
      ctx.arc(px, py, 2.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 回归线（斜率用 beta，过原点近似）
    if (s.beta !== null && s.beta !== undefined) {
      ctx.strokeStyle = COLORS.up;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(X(-lim), Y(-lim * s.beta));
      ctx.lineTo(X(lim), Y(lim * s.beta));
      ctx.stroke();
    }

    // 轴标题
    ctx.save();
    axisFont(ctx, 10);
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "center";
    ctx.fillText("黄金日涨跌幅", box.x + box.w / 2, c.h - 6);
    ctx.translate(14, box.y + box.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(s.name + " 日涨跌幅", 0, 0);
    ctx.restore();

    // 图内统计
    ctx.save();
    axisFont(ctx, 10);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "left";
    ctx.fillText("r = " + fx(s.r, 3) + "   β = " + fx(s.beta, 2) + "   R² = " + fx(s.r2, 3),
      box.x + 7, box.y + 11);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText("n = " + s.n + " 日", box.x + 7, box.y + 25);
    ctx.restore();
  }

  function drawTrend(c, s) {
    var ctx = c.ctx, box = plotBox(c.w, c.h);
    var dates = s.dates || [];
    var a = s.cum_sector || [];
    var b = s.cum_bench || [];
    if (!dates.length) return;
    var all = a.concat(b).filter(function (v) { return v !== null && !isNaN(v); });
    var mx = Math.max.apply(null, all.map(Math.abs));
    var lim = Math.max(0.02, mx * 1.12);

    var X = function (i) { return box.x + (dates.length === 1 ? 0 : box.w * i / (dates.length - 1)); };
    var Y = function (v) { return box.y + box.h - box.h * (v + lim) / (2 * lim); };

    var labels = [dates[0], dates[Math.floor(dates.length / 2)], dates[dates.length - 1]]
      .map(function (d) { return d ? d.slice(0, 7).replace("-", "/") : ""; });
    drawGrid(ctx, box, -lim, lim, 4, function (v) { return (v * 100).toFixed(0) + "%"; }, labels);

    ctx.strokeStyle = "rgba(138,155,178,.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(box.x, Y(0)); ctx.lineTo(box.x + box.w, Y(0));
    ctx.stroke();

    function line(arr, color, width) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      var started = false;
      for (var i = 0; i < arr.length; i++) {
        var v = arr[i];
        if (v === null || v === undefined || isNaN(v)) { started = false; continue; }
        var px = X(i), py = Y(v);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    line(b, COLORS.gold, 1.4);
    line(a, COLORS.blue, 1.9);

    // 图例
    ctx.save();
    axisFont(ctx, 10);
    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.blue;
    ctx.fillRect(box.x + 8, box.y + 6, 12, 3);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(s.name + " " + fpct(a[a.length - 1] || 0), box.x + 25, box.y + 10);
    ctx.fillStyle = COLORS.gold;
    ctx.fillRect(box.x + 8, box.y + 22, 12, 3);
    ctx.fillStyle = COLORS.text;
    ctx.fillText("黄金 " + fpct(b[b.length - 1] || 0), box.x + 25, box.y + 26);
    ctx.restore();
  }

  function drawRolling(c, s) {
    var ctx = c.ctx, box = plotBox(c.w, c.h);
    var dates = s.dates || [];
    var roll = s.rolling || [];
    var win = s.rolling_window || 60;
    if (!dates.length) return;

    var X = function (i) { return box.x + (dates.length === 1 ? 0 : box.w * i / (dates.length - 1)); };
    var Y = function (v) { return box.y + box.h - box.h * (v + 1) / 2; };

    drawGrid(ctx, box, -1, 1, 4, function (v) { return v.toFixed(1); },
      [dates[0], dates[Math.floor(dates.length / 2)], dates[dates.length - 1]]
        .map(function (d) { return d ? d.slice(0, 7).replace("-", "/") : ""; }));

    // ±0.3 参考带
    ctx.fillStyle = "rgba(90,169,247,.07)";
    ctx.fillRect(box.x, Y(0.3), box.w, Y(-0.3) - Y(0.3));
    ctx.strokeStyle = "rgba(138,155,178,.45)";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    [0.3, -0.3].forEach(function (v) {
      ctx.beginPath();
      ctx.moveTo(box.x, Y(v)); ctx.lineTo(box.x + box.w, Y(v));
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(138,155,178,.7)";
    ctx.beginPath(); ctx.moveTo(box.x, Y(0)); ctx.lineTo(box.x + box.w, Y(0)); ctx.stroke();

    // 滚动相关线：正值红、负值绿分段
    var prev = null;
    for (var i = 0; i < roll.length; i++) {
      var v = roll[i];
      if (v === null || v === undefined || isNaN(v)) { prev = null; continue; }
      if (prev) {
        ctx.strokeStyle = v >= 0 ? COLORS.up : COLORS.down;
        ctx.lineWidth = 1.9;
        ctx.beginPath();
        ctx.moveTo(X(i - 1), Y(prev));
        ctx.lineTo(X(i), Y(v));
        ctx.stroke();
      }
      prev = v;
    }

    // 当前值
    var last = null;
    for (var k = roll.length - 1; k >= 0; k--) {
      if (roll[k] !== null && roll[k] !== undefined) { last = roll[k]; break; }
    }
    ctx.save();
    axisFont(ctx, 10);
    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.text;
    ctx.fillText(win + "日滚动相关　当前 " + fx(last, 3), box.x + 8, box.y + 11);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText("最近 " + s.n + " 个交易日", box.x + 8, box.y + 25);
    ctx.restore();

    // 轴标题
    ctx.save();
    axisFont(ctx, 10);
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "center";
    ctx.fillText("相关系数（+1 完全同向 / -1 完全反向）", box.x + box.w / 2, c.h - 6);
    ctx.restore();
  }

  // ---------------- 事件 ----------------
  function bind() {
    $("crBench").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-bench]");
      if (!btn || btn.getAttribute("data-bench") === state.bench) return;
      state.bench = btn.getAttribute("data-bench");
      state.detail = null;
      renderBench();
      loadResult(false);
    });

    $("crWindows").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-window]");
      if (!btn || Number(btn.getAttribute("data-window")) === state.window) return;
      state.window = Number(btn.getAttribute("data-window"));
      state.detail = null;
      renderWindows();
      loadResult(false);
    });

    $("crRefresh").addEventListener("click", function () {
      if (state.loading) return;
      loadResult(true);
    });

    $("crBars").addEventListener("click", function (e) {
      var row = e.target.closest(".cr-bar-row");
      if (!row) return;
      selectSector(row.getAttribute("data-sector"), true);
    });

    $("crDetailTabs").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-tab]");
      if (btn) setTab(btn.getAttribute("data-tab"));
    });

    window.addEventListener("resize", function () {
      if (!$("view-corr").hidden && state.detail) drawChart();
    });
  }

  // ---------------- 对外接口 ----------------
  function activate() {
    if (!state.started) {
      state.started = true;
      bind();
      loadOptions().then(function () { loadResult(false); });
    } else {
      requestAnimationFrame(function () {
        if (state.detail) drawChart();
      });
    }
  }

  window.CorrPanel = { activate: activate };
})();
