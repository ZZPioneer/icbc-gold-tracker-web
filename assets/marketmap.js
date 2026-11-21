/* 大盘云图 —— 前端渲染引擎（原生 Canvas，无第三方依赖）
 * 复刻 dapanyuntu.com：6 市场 × 4 周期；面积=流通市值/总市值/成交额，颜色=涨跌幅（红涨绿跌）。
 * 交互：周期/口径切换、市场切换、搜索定位、板块筛选、缩略统计、自选热力图、个股详情、
 *       滚轮缩放、拖拽平移、悬停详情、双击行情、全屏、秒级自动刷新。
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };

  var METRIC_LABEL = { value: "流通市值", totalMarketCap: "总市值", turnoverAmount: "成交额" };
  var WATCH_KEY = "mmWatchlist";
  var LS_KEY = "mmRefreshPref";

  var state = {
    markets: [],
    market: "all",
    period: "day",
    meta: null,
    payload: null,     // 后端完整结果 {ok, data, cached, stale, ...}
    overview: null,
    rects: [],         // 平铺个股色块 {x,y,w,h,stock,board}
    boardRects: [],
    tx: 0, ty: 0, scale: 1,
    dragging: false, dragStart: null, dragMoved: false,
    hoverRect: null,
    mouse: { x: 0, y: 0, inside: false },
    dpr: 1,
    loading: false,
    raf: 0,
    metric: "value",   // 面积口径
    filterBoard: null, // 当前筛选的板块 code
    mini: false,       // 缩略统计
    // 自选热力图模式
    watchMode: false,
    watchItems: [],    // [{code,name,...}]
    // 秒级刷新
    autoRefresh: false,
    intervalSec: 6,
    countdown: 6
  };

  var stage, canvas, ctx, tooltip;

  // hover 富信息卡（inspector）状态
  var inspector = {
    rect: null,       // 当前展示的个股色块
    sortIdx: 0,       // 排序方式索引
    locked: false,    // G 键锁定
    hideTimer: 0
  };
  var INSPECTOR_SORTS = [
    { key: "changePct", dir: -1, label: "涨幅" },
    { key: "changePct", dir: 1, label: "跌幅" },
    { key: "turnoverAmount", dir: -1, label: "成交额" },
    { key: "name", dir: 1, label: "名称" },
    { key: "totalMarketCap", dir: -1, label: "总市值" },
    { key: "value", dir: -1, label: "流通市值" }
  ];

  // ---------- 工具 ----------
  function fmtMoney(v) {
    if (v == null || !isFinite(v)) return "—";
    var a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + "万亿";
    if (a >= 1e8) return (v / 1e8).toFixed(1) + "亿";
    if (a >= 1e4) return (v / 1e4).toFixed(1) + "万";
    return Number(v).toFixed(0);
  }
  function fmtPct(v) {
    if (v == null || !isFinite(v)) return "—";
    return (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%";
  }
  function tone(v) { return v > 0 ? "mm-stat-up" : (v < 0 ? "mm-stat-down" : "mm-stat-flat"); }

  // ---------- 外部图片（与原站同源：新浪日K / 东财走势图） ----------
  var BLANK_GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  // code 形如 601138.SH / 00700.HK / 43xxxx.BJ；拆出 symbol 与市场
  function splitCode(code) {
    var parts = String(code || "").split(".");
    return { symbol: parts[0] || "", market: (parts[1] || "SH").toUpperCase() };
  }
  // 外部图片走本地同源代理（服务端转发新浪/东财，规避 CSP img-src 'self' 与网络限制）
  // 代理端按原站规则拼真实 URL：日K=新浪gif/东财KXL；迷你图=东财RJY。
  function klineUrl(code) {
    var c = splitCode(code);
    return c.symbol ? "/api/marketmap/img?kind=kline&code=" + encodeURIComponent(code) : BLANK_GIF;
  }
  function sparkUrl(code) {
    var c = splitCode(code);
    return c.symbol ? "/api/marketmap/img?kind=spark&code=" + encodeURIComponent(code) : BLANK_GIF;
  }

  // 涨跌色阶：红涨绿跌
  function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
  function colorFor(pct, scale) {
    if (pct == null || !isFinite(pct)) return "#2a2f38";
    var t = Math.min(1, Math.abs(pct) / (scale || 10));
    t = Math.pow(t, 0.62);
    if (pct > 0.02) return "rgb(" + lerp(74, 214, t) + "," + lerp(46, 47, t) + "," + lerp(52, 47, t) + ")";
    if (pct < -0.02) return "rgb(" + lerp(58, 16, t) + "," + lerp(66, 145, t) + "," + lerp(62, 78, t) + ")";
    return "#2a2f38";
  }
  function textColorFor(pct, scale) {
    if (pct == null) return "rgba(255,255,255,.82)";
    var t = Math.min(1, Math.abs(pct) / (scale || 10));
    return t > 0.5 ? "#fff" : "rgba(255,255,255,.82)";
  }

  // 文字渲染工具：文字统一在“屏幕坐标系”绘制，字号为固定像素，避免被 ctx.scale 放大导致重叠。
  var FONT_CN = "-apple-system,'Microsoft YaHei',sans-serif";
  var FONT_NUM = "-apple-system,sans-serif";
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  // 按可用宽度截断文本，超出以省略号结尾（调用前需先设置 ctx.font）
  function fitText(text, maxW) {
    text = String(text == null ? "" : text);
    if (maxW <= 0) return "";
    if (ctx.measureText(text).width <= maxW) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s + "…";
  }
  // 在屏幕坐标画多行居中文字：字号/行距均为固定像素，垂直整体居中，行与行不会重叠。
  function drawLines(lines, cx, cy, maxW) {
    var n = lines.length, gap = 2, i, total = 0;
    for (i = 0; i < n; i++) total += lines[i].size + (i ? gap : 0);
    var cursor = cy - total / 2;
    for (i = 0; i < n; i++) {
      var l = lines[i];
      ctx.font = l.weight + " " + l.size + "px " + (l.family || FONT_CN);
      ctx.fillStyle = l.color;
      ctx.fillText(fitText(l.text, maxW), cx, cursor + l.size / 2);
      cursor += l.size + gap;
    }
  }

  // 色阶量程：day 用 meta.scale，其他周期用数据分位数自适应
  function effectiveScale() {
    if (state.period === "day" || state.watchMode) return (state.meta && state.meta.scale) || 10;
    var vals = [];
    var data = state.payload && state.payload.data;
    if (data && data.nodes) {
      for (var b = 0; b < data.nodes.length; b++) {
        var ch = data.nodes[b].children || [];
        for (var i = 0; i < ch.length; i++) {
          if (ch[i].changePct != null && isFinite(ch[i].changePct)) vals.push(Math.abs(ch[i].changePct));
        }
      }
    }
    if (!vals.length) return 20;
    vals.sort(function (a, b) { return a - b; });
    var p90 = vals[Math.floor(vals.length * 0.9)] || 1;
    return Math.max(3, Math.ceil(p90));
  }

  // ---------- squarify 布局 ----------
  function squarify(items, x, y, w, h) {
    var out = [];
    if (!items.length || w <= 0 || h <= 0) return out;
    var total = 0, i;
    for (i = 0; i < items.length; i++) total += Math.max(0, items[i].value || 0);
    if (total <= 0) return out;
    var scale = (w * h) / total;
    var entries = items.map(function (it) { return { item: it, area: Math.max(0, (it.value || 0) * scale) }; })
                       .filter(function (e) { return e.area > 0; });
    var idx = 0, side = Math.min(w, h);
    function worst(row) {
      var sum = 0, max = -Infinity, min = Infinity;
      for (var j = 0; j < row.length; j++) { var a = row[j].area; sum += a; if (a > max) max = a; if (a < min) min = a; }
      if (sum <= 0 || min <= 0) return Infinity;
      var s2 = side * side;
      return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
    }
    while (idx < entries.length) {
      var row = [], prevWorst = Infinity;
      while (idx < entries.length) {
        var trial = row.concat([entries[idx]]);
        var ww = worst(trial);
        if (row.length === 0 || ww <= prevWorst) { row.push(entries[idx]); prevWorst = ww; idx++; }
        else break;
      }
      if (!row.length) break;
      var rowSum = 0;
      for (i = 0; i < row.length; i++) rowSum += row[i].area;
      if (w >= h) {
        var stripW = rowSum / h, cy = y;
        for (i = 0; i < row.length; i++) {
          var rh = row[i].area / stripW;
          out.push({ item: row[i].item, x: x, y: cy, w: stripW, h: rh });
          cy += rh;
        }
        x += stripW; w -= stripW;
      } else {
        var stripH = rowSum / w, cx = x;
        for (i = 0; i < row.length; i++) {
          var rw = row[i].area / stripH;
          out.push({ item: row[i].item, x: cx, y: y, w: rw, h: stripH });
          cx += rw;
        }
        y += stripH; h -= stripH;
      }
      side = Math.min(w, h);
      if (w <= 0.5 || h <= 0.5) break;
    }
    return out;
  }

  function metricValue(stock) {
    var v = stock[state.metric];
    if (v == null || !isFinite(v) || v <= 0) v = stock.value;
    return v || 0;
  }

  function buildLayout() {
    var data = state.payload && state.payload.data;
    state.rects = [];
    state.boardRects = [];
    if (!data || !data.nodes) return;
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (W < 10 || H < 10) return;

    var boards = data.nodes.slice();
    if (state.filterBoard) boards = boards.filter(function (b) { return b.code === state.filterBoard; });
    // 板块 value = 其个股按当前口径求和
    boards.forEach(function (b) {
      b._area = 0;
      (b.children || []).forEach(function (c) { b._area += metricValue(c); });
    });
    boards.sort(function (a, b) { return (b._area || 0) - (a._area || 0); });
    var boardBoxes = squarify(boards.map(function (b) { return { _item: b, value: b._area }; }), 0, 0, W, H);

    for (var bi = 0; bi < boardBoxes.length; bi++) {
      var bb = boardBoxes[bi];
      var board = bb.item._item;
      var headerH = Math.min(20, Math.max(13, Math.min(bb.w, bb.h) * 0.16));
      state.boardRects.push({ x: bb.x, y: bb.y, w: bb.w, h: bb.h, headerH: headerH, board: board, area: bb.item.value });
      var innerY = bb.y + headerH, innerH = bb.h - headerH;
      var stocks = (board.children || []).slice().sort(function (a, b) { return metricValue(b) - metricValue(a); });
      var boxes = squarify(stocks.map(function (s) { return { _item: s, value: metricValue(s) }; }),
                           bb.x + 1, innerY + 1, Math.max(0, bb.w - 2), Math.max(0, innerH - 2));
      for (var si = 0; si < boxes.length; si++) {
        var sb = boxes[si];
        state.rects.push({ x: sb.x, y: sb.y, w: sb.w, h: sb.h, stock: sb.item._item, board: board });
      }
    }
  }

  // ---------- 绘制 ----------
  function resize() {
    var rect = stage.getBoundingClientRect();
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(rect.width * state.dpr));
    canvas.height = Math.max(1, Math.round(rect.height * state.dpr));
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    buildLayout();
    fitView();
    draw();
  }
  function fitView() { state.scale = 1; state.tx = 0; state.ty = 0; }

  function draw() {
    if (!ctx) return;
    var W = canvas.clientWidth, H = canvas.clientHeight;
    var sc = state.scale, tx = state.tx, ty = state.ty;
    var scaleMax = effectiveScale();

    // ===== 阶段 1：世界坐标绘制底色（标题条 / 色块 / hover 描边） =====
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0b0f15";
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(sc, sc);

    // 板块标题条背景
    for (var b = 0; b < state.boardRects.length; b++) {
      var br = state.boardRects[b];
      ctx.fillStyle = "#1a2433";
      ctx.fillRect(br.x, br.y, br.w, br.headerH);
    }
    // 个股色块
    for (var i = 0; i < state.rects.length; i++) {
      var r = state.rects[i];
      ctx.fillStyle = colorFor(r.stock.changePct, scaleMax);
      ctx.fillRect(r.x, r.y, Math.max(0.5, r.w), Math.max(0.5, r.h));
      if (r.w > 2 && r.h > 2) {
        ctx.strokeStyle = "rgba(8,11,17,.55)";
        ctx.lineWidth = 0.5 / sc;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
    }
    if (state.hoverRect) {
      var hr = state.hoverRect;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5 / sc;
      ctx.strokeRect(hr.x, hr.y, hr.w, hr.h);
    }
    ctx.restore();

    // ===== 阶段 2：屏幕坐标绘制文字（固定像素字号/行距，缩放不重叠） =====
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.textBaseline = "middle";

    // 板块标题：字号随标题条“屏幕高度”档位化，始终不溢出
    ctx.textAlign = "left";
    for (var b2 = 0; b2 < state.boardRects.length; b2++) {
      var br2 = state.boardRects[b2];
      var bx = br2.x * sc + tx, by = br2.y * sc + ty;
      var bw = br2.w * sc, bh = br2.headerH * sc;
      if (bx + bw < 0 || bx > W || by + bh < 0 || by > H) continue; // 视口裁剪
      if (bh < 11 || bw < 26) continue;
      var hSize = clamp(Math.round(bh * 0.62), 10, 22);
      ctx.font = "600 " + hSize + "px " + FONT_CN;
      ctx.fillStyle = "#c4d0e0";
      ctx.save();
      ctx.beginPath(); ctx.rect(bx + 3, by, Math.max(0, bw - 6), bh); ctx.clip();
      ctx.fillText(fitText(br2.board.name, bw - 8), bx + 4, by + bh / 2);
      ctx.restore();
    }

    // 个股文字：按色块“屏幕尺寸”分三档，字号有上限、行距按字号自适应
    ctx.textAlign = "center";
    for (var k = 0; k < state.rects.length; k++) {
      var q = state.rects[k], s = q.stock;
      var sx = q.x * sc + tx, sy = q.y * sc + ty;
      var sw = q.w * sc, sh = q.h * sc;
      if (sx + sw < 0 || sx > W || sy + sh < 0 || sy > H) continue; // 视口裁剪
      if (sw < 26 || sh < 13) continue; // 太小不画字

      var cx = sx + sw / 2, cy = sy + sh / 2;
      var maxTextW = Math.max(0, sw - 6);
      var name = s.name || s.code || "";
      var col = textColorFor(s.changePct, scaleMax);
      var lines = [];

      if (sw >= 96 && sh >= 66) {
        // 大色块：名称 + 涨跌幅（+ 价格）
        lines.push({ text: name, size: clamp(Math.round(sh / 4.2), 13, 20), weight: 700, color: col, family: FONT_CN });
        lines.push({ text: fmtPct(s.changePct), size: clamp(Math.round(sh / 6.4), 11, 15), weight: 600, color: col, family: FONT_NUM });
        if (sh >= 96 && s.price != null) {
          lines.push({ text: String(s.price), size: clamp(Math.round(sh / 9), 10, 12), weight: 400, color: "rgba(255,255,255,.62)", family: FONT_NUM });
        }
      } else if (sw >= 50 && sh >= 32) {
        // 中色块：名称 + 涨跌幅
        lines.push({ text: name, size: clamp(Math.round(Math.min(sw / 5, sh / 3.4)), 10, 14), weight: 600, color: col, family: FONT_CN });
        if (sh >= 46) lines.push({ text: fmtPct(s.changePct), size: clamp(Math.round(sh / 5.6), 10, 13), weight: 600, color: col, family: FONT_NUM });
      } else {
        // 小色块：仅名称
        lines.push({ text: name, size: clamp(Math.round(Math.min(sw / 5, sh / 2.4)), 9, 12), weight: 500, color: col, family: FONT_CN });
      }
      drawLines(lines, cx, cy, maxTextW);
    }
  }
  function scheduleDraw() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(function () { state.raf = 0; draw(); });
  }

  // ---------- 命中与 tooltip ----------
  function hitTest(sx, sy) {
    var wx = (sx - state.tx) / state.scale, wy = (sy - state.ty) / state.scale;
    for (var i = state.rects.length - 1; i >= 0; i--) {
      var r = state.rects[i];
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return r;
    }
    return null;
  }
  // 取同板块（优先细分板块 subBoardName，否则一级板块 boardName）的所有个股
  function peersOf(r) {
    var s = r.stock;
    var key = s.subBoardName || s.boardName || (r.board && r.board.name) || "";
    var peers = [];
    for (var i = 0; i < state.rects.length; i++) {
      var o = state.rects[i];
      var ok = s.subBoardName ? (o.stock.subBoardName === s.subBoardName && o.stock.boardName === s.boardName)
                              : ((o.stock.boardName || (o.board && o.board.name) || "") === s.boardName);
      if (ok) peers.push(o.stock);
    }
    return { key: key, peers: peers };
  }
  function sortPeers(peers) {
    var cfg = INSPECTOR_SORTS[inspector.sortIdx];
    var key = cfg.key, dir = cfg.dir;
    return peers.slice().sort(function (a, b) {
      if (key === "name") return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN") * dir;
      var av = a[key], bv = b[key];
      if (av == null) av = -Infinity; if (bv == null) bv = -Infinity;
      return (av - bv) * dir;
    });
  }
  // 构造富信息卡 HTML（顶部报价条 + 日K大图 + 同板块统计 + 可排序个股列表）
  function buildInspectorHtml(r) {
    var s = r.stock;
    var unit = (state.meta && state.meta.unit) || "元";
    var pct = s.changePct;
    var boardName = r.board && r.board.name || s.boardName || "";
    var subName = s.subBoardName || "";
    var sectorLabel = boardName + (subName ? " - " + subName : "");

    var got = peersOf(r);
    var peers = got.peers;
    var up = 0, down = 0, flat = 0, sumPct = 0, cntPct = 0;
    for (var i = 0; i < peers.length; i++) {
      var c = peers[i].changePct;
      if (c == null || !isFinite(c)) { continue; }
      if (c > 0) up++; else if (c < 0) down++; else flat++;
      sumPct += c; cntPct++;
    }
    var avgPct = cntPct ? sumPct / cntPct : null;

    // 排序标签
    var tabs = INSPECTOR_SORTS.map(function (t, idx) {
      return '<button type="button" class="ins-tab' + (idx === inspector.sortIdx ? ' active' : '') +
        '" data-ins-sort="' + idx + '">' + t.label + '</button>';
    }).join("");

    // 同板块个股列表
    var sorted = sortPeers(peers);
    var rows = sorted.map(function (o) {
      var op = o.changePct;
      return '<div class="ins-row" data-ins-code="' + esc(o.code) + '">' +
        '<span class="ins-rname">' + esc(o.name || o.code) + '</span>' +
        '<img class="ins-spark" src="' + sparkUrl(o.code) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" ' +
          'onerror="this.style.visibility=\'hidden\'">' +
        '<span class="ins-rprice">' + (o.price != null ? esc(o.price) : "—") + '</span>' +
        '<span class="ins-rpct ' + tone(op) + '">' + fmtPct(op) + '</span>' +
        '</div>';
    }).join("");
    if (!rows) rows = '<div class="ins-empty">暂无同板块个股</div>';

    return '' +
      '<div class="ins-bar">' +
        '<div class="ins-ident">' +
          '<div class="ins-name">' + esc(s.name || s.code) + '</div>' +
          '<div class="ins-code">' + esc(s.code) + ' · ' + esc(sectorLabel) + '</div>' +
        '</div>' +
        '<div class="ins-quote">' +
          '<div class="ins-price ' + tone(pct) + '">' + (s.price != null ? esc(s.price) : "—") +
            ' <span class="ins-unit">' + unit + '</span></div>' +
          '<div class="ins-qsub"><span>成交额 ' + fmtMoney(s.turnoverAmount) + '</span>' +
            '<span class="' + tone(pct) + '">' + fmtPct(pct) + '</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="ins-kline"><img src="' + klineUrl(s.code) + '" alt="日K线图" loading="lazy" decoding="async" ' +
        'referrerpolicy="no-referrer" onerror="this.parentNode.classList.add(\'img-fail\')"></div>' +
      '<div class="ins-keys">快捷键：<b>G</b> 锁定/解锁 · <b>M</b> 停屏/刷新 · <b>S</b>/<b>Shift+S</b> 切换排序</div>' +
      '<div class="ins-sector">' +
        '<div class="ins-sector-title">' + esc(sectorLabel) + '</div>' +
        '<div class="ins-sector-stat"><span class="mm-stat-up">涨 ' + up + '</span>' +
          '<span class="mm-stat-down">跌 ' + down + '</span>' +
          (flat ? '<span class="mm-stat-flat">平 ' + flat + '</span>' : '') +
          '<b class="' + tone(avgPct) + '">' + fmtPct(avgPct) + '</b></div>' +
      '</div>' +
      '<div class="ins-tabs">' + tabs + '</div>' +
      '<div class="ins-list">' + rows + '</div>' +
      '<div class="ins-hint">' + (inspector.locked ? '🔒 已锁定 · 再按 G 解锁' : '单击看详情 · 双击看行情 · 滚轮缩放') + '</div>';
  }
  function positionTooltip(sx, sy) {
    var tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    var stageRect = stage.getBoundingClientRect();
    var left = sx + 16, top = sy + 14;
    if (left + tw > stageRect.width - 8) left = sx - tw - 16;
    if (top + th > stageRect.height - 8) top = sy - th - 14;
    tooltip.style.left = Math.max(6, left) + "px";
    tooltip.style.top = Math.max(6, top) + "px";
  }
  function showTooltip(r, sx, sy) {
    if (!r) { hideTooltipSoon(); return; }
    // 锁定状态下：鼠标移到别的股票不切换内容
    if (inspector.locked && inspector.rect && r.stock.code !== inspector.rect.stock.code) {
      if (tooltip.hidden) positionTooltip(sx, sy);
      return;
    }
    clearTimeout(inspector.hideTimer);
    var changed = !inspector.rect || inspector.rect.stock.code !== r.stock.code;
    inspector.rect = r;
    if (changed || tooltip.hidden) {
      tooltip.innerHTML = buildInspectorHtml(r);
      var list = tooltip.querySelector(".ins-list");
      if (list) list.scrollTop = 0;
    }
    tooltip.hidden = false;
    positionTooltip(sx, sy);
  }
  function hideTooltipSoon() {
    if (inspector.locked) return;
    clearTimeout(inspector.hideTimer);
    inspector.hideTimer = setTimeout(function () {
      if (!tooltip.matches(":hover")) tooltip.hidden = true;
    }, 120);
  }
  function rerenderInspector() {
    if (inspector.rect && !tooltip.hidden) tooltip.innerHTML = buildInspectorHtml(inspector.rect);
  }

  // ---------- 交互 ----------
  function onWheel(e) {
    e.preventDefault();
    var rect = stage.getBoundingClientRect();
    var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    state.mouse.x = sx; state.mouse.y = sy; state.mouse.inside = true;
    var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    var next = Math.max(1, Math.min(40, state.scale * factor));
    if (next === state.scale) return;
    var wx = (sx - state.tx) / state.scale, wy = (sy - state.ty) / state.scale;
    state.tx = sx - wx * next; state.ty = sy - wy * next; state.scale = next;
    clampTranslate();
    scheduleDraw();
    var r = hitTest(sx, sy); state.hoverRect = r; showTooltip(r, sx, sy);
  }
  function clampTranslate() {
    var W = canvas.clientWidth, H = canvas.clientHeight;
    var minX = W - W * state.scale, minY = H - H * state.scale;
    state.tx = Math.min(0, Math.max(minX, state.tx));
    state.ty = Math.min(0, Math.max(minY, state.ty));
  }
  function onMouseDown(e) {
    if (e.target.closest && e.target.closest('.mm-mini-panel')) return;
    state.dragging = true; state.dragMoved = false;
    state.dragStart = { x: e.clientX - state.tx, y: e.clientY - state.ty };
    stage.style.cursor = "grabbing";
  }
  function onMouseMove(e) {
    if (state.dragging && state.dragStart) {
      state.tx = e.clientX - state.dragStart.x; state.ty = e.clientY - state.dragStart.y;
      clampTranslate(); scheduleDraw(); state.dragMoved = true; tooltip.hidden = true;
      return;
    }
    // 鼠标在信息卡内部（排序/查看同板块）时不切换 hover 目标，保持内容稳定
    if (!tooltip.hidden && e.target && e.target.closest && e.target.closest(".mm-tooltip")) {
      clearTimeout(inspector.hideTimer);
      return;
    }
    var rect = stage.getBoundingClientRect();
    var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    state.mouse.x = sx; state.mouse.y = sy; state.mouse.inside = true;
    var r = hitTest(sx, sy);
    if (r !== state.hoverRect) { state.hoverRect = r; scheduleDraw(); }
    showTooltip(r, sx, sy);
  }
  function onMouseUp(e) { state.dragging = false; state.dragStart = null; stage.style.cursor = "crosshair"; }
  function onMouseLeave() {
    state.dragging = false; state.dragStart = null;
    state.hoverRect = null; state.mouse.inside = false;
    hideTooltipSoon(); stage.style.cursor = "crosshair";
    scheduleDraw();
  }
  function onClick(e) {
    // 信息卡内交互：排序标签 / 同板块个股行
    if (e.target && e.target.closest && e.target.closest(".mm-tooltip")) {
      var sortBtn = e.target.closest("[data-ins-sort]");
      if (sortBtn) {
        inspector.sortIdx = parseInt(sortBtn.getAttribute("data-ins-sort"), 10) || 0;
        rerenderInspector();
        return;
      }
      var peerRow = e.target.closest("[data-ins-code]");
      if (peerRow) {
        var code = peerRow.getAttribute("data-ins-code");
        var target = null;
        for (var pi = 0; pi < state.rects.length; pi++) {
          if (state.rects[pi].stock.code === code) { target = state.rects[pi]; break; }
        }
        if (target) {
          inspector.rect = target; tooltip.innerHTML = buildInspectorHtml(target);
          var plist = tooltip.querySelector(".ins-list"); if (plist) plist.scrollTop = 0;
        }
        return;
      }
      return;
    }
    if (state.dragMoved) return;
    var rect = stage.getBoundingClientRect();
    // 点板块标题条 → 筛选
    var wx = (e.clientX - rect.left - state.tx) / state.scale, wy = (e.clientY - rect.top - state.ty) / state.scale;
    for (var b = 0; b < state.boardRects.length; b++) {
      var br = state.boardRects[b];
      if (wx >= br.x && wx <= br.x + br.w && wy >= br.y && wy <= br.y + br.headerH) {
        setFilter(state.filterBoard === br.board.code ? null : br.board.code, br.board.name);
        return;
      }
    }
    var r = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (r && r.stock) openDetail(r.stock, r.board);
  }
  function onDblClick(e) {
    var rect = stage.getBoundingClientRect();
    var r = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (r && r.stock) window.open(stockUrl(r.stock), "_blank", "noopener,noreferrer");
  }
  function stockUrl(s) {
    var code = String(s.code || ""), ex = s.exchange || "";
    if (code.indexOf(".HK") >= 0 || ex === "HK") return "https://quote.eastmoney.com/hk/" + code.replace(".HK", "") + ".html";
    if (code.indexOf(".") < 0 && ex === "US") return "https://finance.yahoo.com/quote/" + code;
    var num = code.split(".")[0];
    var p = ex === "SH" ? "sh" : (ex === "BJ" ? "bj" : "sz");
    return "https://quote.eastmoney.com/" + p + num + ".html";
  }

  // ---------- 板块筛选 ----------
  function setFilter(code, name) {
    state.filterBoard = code;
    var bar = $("mmFilter");
    if (code) { bar.hidden = false; $("mmFilterVal").textContent = name; }
    else { bar.hidden = true; $("mmFilterVal").textContent = ""; }
    buildLayout(); fitView(); draw();
  }

  // ---------- 缩略统计 ----------
  function renderMini() {
    var panel = $("mmMiniPanel");
    if (!state.mini) { panel.hidden = true; return; }
    var data = state.payload && state.payload.data;
    if (!data || !data.nodes) { panel.hidden = true; return; }
    var rows = data.nodes.map(function (b) {
      var area = 0, up = 0, down = 0;
      (b.children || []).forEach(function (c) {
        area += metricValue(c);
        if (c.changePct > 0) up++; else if (c.changePct < 0) down++;
      });
      return { name: b.name, area: area, up: up, down: down };
    }).filter(function (r) { return r.area > 0; }).sort(function (a, b) { return b.area - a.area; }).slice(0, 12);
    var max = rows.length ? rows[0].area : 1;
    panel.innerHTML = '<h4>板块统计（面积=当前口径）</h4>' + (rows.length ? rows.map(function (r) {
      var w = Math.max(4, Math.round(r.area / max * 100));
      return '<div class="mm-mini-row"><span class="mr-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span>' +
        '<span class="mr-bar" style="width:' + (w * 0.7) + 'px;background:linear-gradient(90deg,#c99a35,#e9b94f)"></span>' +
        '<span class="mr-val">' + fmtMoney(r.area) + '</span></div>';
    }).join("") : '<div class="mm-mini-empty">无数据</div>');
    panel.hidden = false;
  }

  // ---------- 个股详情 ----------
  var detailStock = null;
  function openDetail(stock, board) {
    detailStock = stock;
    var unit = (state.meta && state.meta.unit) || "元";
    var pct = stock.changePct;
    var body = '<div class="md-name">' + esc(stock.name || stock.code) + '</div>' +
      '<div class="md-code">' + esc(stock.code) + ' · ' + esc(board ? board.name : (stock.boardName || "")) +
      (stock.subBoardName ? ' / ' + esc(stock.subBoardName) : '') + '</div>' +
      '<div class="md-price ' + tone(pct) + '">' + (stock.price != null ? esc(stock.price) : "—") + ' <span>' + unit + '</span></div>' +
      '<div class="md-pct ' + tone(pct) + '">' + fmtPct(pct) + ' <span style="color:var(--muted);font-size:11px">' +
      ({"day":"今日","week":"近5日","month":"近20日","year":"今年以来"}[state.period] || "") + '</span></div>' +
      '<div class="md-grid">' +
      '<div class="md-cell"><span class="k">流通市值</span><span class="v">' + fmtMoney(stock.value) + '</span></div>' +
      '<div class="md-cell"><span class="k">总市值</span><span class="v">' + fmtMoney(stock.totalMarketCap) + '</span></div>' +
      '<div class="md-cell"><span class="k">成交额</span><span class="v">' + fmtMoney(stock.turnoverAmount) + '</span></div>' +
      '<div class="md-cell"><span class="k">交易所</span><span class="v">' + esc(stock.exchange || "—") + '</span></div>' +
      '</div>';
    $("mmDetailBody").innerHTML = body;
    $("mmDetailWatch").textContent = isWatched(stock.code) ? "★ 已在自选" : "★ 加入自选";
    $("mmDetailMask").hidden = false;
  }
  function closeDetail() { $("mmDetailMask").hidden = true; detailStock = null; }

  // ---------- 自选 ----------
  function loadWatch() {
    try { state.watchItems = JSON.parse(localStorage.getItem(WATCH_KEY) || "[]"); }
    catch (e) { state.watchItems = []; }
    updateWatchBadge();
  }
  function saveWatch() {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(state.watchItems)); } catch (e) {}
    updateWatchBadge();
  }
  function updateWatchBadge() { $("mmWatchBadge").textContent = String(state.watchItems.length); }
  function isWatched(code) { return state.watchItems.some(function (x) { return x.code === code; }); }
  function addWatch(item) {
    if (isWatched(item.code)) return false;
    state.watchItems.push({ code: item.code, name: item.name, boardName: item.boardName || "",
      price: item.price, changePct: item.changePct, value: item.value, exchange: item.exchange || "" });
    saveWatch(); renderWatchList(); return true;
  }
  function removeWatch(code) {
    state.watchItems = state.watchItems.filter(function (x) { return x.code !== code; });
    saveWatch(); renderWatchList();
  }
  function renderWatchList() {
    var box = $("mmWatchList");
    $("mmWatchCount").textContent = state.watchItems.length + " 只";
    if (!state.watchItems.length) { box.innerHTML = '<div class="mm-watch-empty">暂无自选，搜索添加股票</div>'; return; }
    box.innerHTML = state.watchItems.map(function (x) {
      return '<div class="mm-watch-item"><div class="wi-name">' + esc(x.name) + '<small>' + esc(x.code) + '</small></div>' +
        '<span class="wi-pct ' + tone(x.changePct) + '">' + fmtPct(x.changePct) + '</span>' +
        '<button type="button" class="wi-del" data-code="' + esc(x.code) + '" title="移除">×</button></div>';
    }).join("");
  }
  // 搜索下拉（自选添加用）
  var watchSearchTimer = null;
  function watchSearch(q) {
    var pop = $("mmWatchSearchPop");
    q = (q || "").trim();
    if (!q) { pop.hidden = true; return; }
    fetch("/api/marketmap/search?q=" + encodeURIComponent(q), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d && d.items) || [];
        if (!items.length) { pop.innerHTML = '<div class="mm-sp-empty">未找到</div>'; pop.hidden = false; return; }
        pop.innerHTML = items.map(function (it) {
          return '<button type="button" class="mm-sp-item" data-code="' + esc(it.code) + '" data-name="' + esc(it.name) +
            '" data-board="' + esc(it.boardName || "") + '" data-ex="' + esc(it.exchange || "") + '">' +
            '<span>' + esc(it.name) + '</span><span class="sp-code">' + esc(it.code) + '</span></button>';
        }).join("");
        pop.hidden = false;
      })
      .catch(function () { pop.hidden = true; });
  }
  // 生成自选热力图：用当前所有市场的已缓存数据补全行情，再合成一张自绘图
  function generateWatchMap() {
    if (!state.watchItems.length) { alert("请先添加自选股票"); return; }
    // 从当前 payload 找匹配的行情；否则保留自选里已存的价格
    var quotes = {};
    var data = state.payload && state.payload.data;
    if (data && data.nodes) data.nodes.forEach(function (b) {
      (b.children || []).forEach(function (c) { quotes[c.code] = c; });
    });
    var items = state.watchItems.map(function (x) {
      var q = quotes[x.code];
      return {
        code: x.code, name: x.name, boardName: x.boardName || "自选",
        price: q ? q.price : x.price, changePct: q ? q.changePct : x.changePct,
        value: q ? Math.max(1, metricValue(q)) : (x.value || 1),
        totalMarketCap: q ? q.totalMarketCap : null, turnoverAmount: q ? q.turnoverAmount : null,
        exchange: x.exchange || ""
      };
    });
    // 未补齐的从各市场缓存抓（尽力而为）
    var missing = items.filter(function (x) { return x.changePct == null; });
    var markets = ["all", "bj", "etf", "cb", "hk", "us"];
    var jobs = [];
    markets.forEach(function (mk) {
      jobs.push(fetch("/api/marketmap/data?market=" + mk + "&period=" + state.period + "&ttl=3600", { cache: "no-store" })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok || !d.data || !d.data.nodes) return;
          d.data.nodes.forEach(function (b) { (b.children || []).forEach(function (c) {
            items.forEach(function (x) {
              if (x.code === c.code && x.changePct == null) {
                x.changePct = c.changePct; x.price = c.price; x.value = Math.max(1, metricValue(c));
                x.totalMarketCap = c.totalMarketCap; x.turnoverAmount = c.turnoverAmount;
              }
            });
          }); });
        }).catch(function () {}));
    });
    Promise.all(jobs).then(function () {
      state.watchItems = items.map(function (x) {
        return { code: x.code, name: x.name, boardName: x.boardName, price: x.price,
          changePct: x.changePct, value: x.value, totalMarketCap: x.totalMarketCap,
          turnoverAmount: x.turnoverAmount, exchange: x.exchange };
      });
      saveWatch();
      // 合成 payload
      state.watchMode = true;
      state.payload = { ok: true, name: "我的自选", cached: true, stale: false,
        data: { market: "watch", period: state.period, updatedAt: new Date().toISOString(),
          nodes: [{ code: "WATCH", name: "自选股", value: items.length, children: items }],
          stockCount: items.length, boardCount: 1,
          summary: { advanceCount: items.filter(function (x) { return x.changePct > 0; }).length,
            flatCount: items.filter(function (x) { return x.changePct === 0; }).length,
            declineCount: items.filter(function (x) { return x.changePct < 0; }).length,
            indexChangePct: null, turnoverAmount: null } } };
      state.meta = { key: "watch", name: "我的自选", unit: "元", scale: 10 };
      state.filterBoard = null; $("mmFilter").hidden = true;
      $("mmWatchMask").hidden = true;
      renderHeader(); renderStats(); buildLayout(); fitView(); renderMini(); draw();
    });
  }

  // ---------- 渲染头部/统计/侧栏 ----------
  function renderMarkets() {
    var box = $("mmMarkets");
    if (!state.markets.length) { box.innerHTML = '<div class="mm-placeholder">暂无市场数据</div>'; return; }
    var head = state.watchMode ? '<button type="button" class="mm-market-item active" data-key="__watch">' +
      '<span class="mmi-name">我的自选<small>自选热力图</small></span><span class="mmi-chg mm-stat-flat">★</span></button>' : "";
    box.innerHTML = head + state.markets.map(function (m) {
      var chg = m.summary && m.summary.indexChangePct;
      var cls = tone(chg);
      var active = (!state.watchMode && m.key === state.market) ? " active" : "";
      return '<button type="button" class="mm-market-item' + active + '" data-key="' + esc(m.key) + '" role="tab">' +
        '<span class="mmi-name">' + esc(m.short) + '<small>' + esc(m.name) + '</small></span>' +
        '<span class="mmi-chg ' + cls + '">' + fmtPct(chg) + '</span></button>';
    }).join("");
  }
  function renderOverview() {
    var box = $("mmOverview");
    if (!state.overview || !state.overview.data || !state.overview.data.markets) { box.hidden = true; return; }
    var mks = state.overview.data.markets.filter(function (m) {
      return ["all", "sse", "szse", "hs300", "zza50", "cyb", "kc50", "bj"].indexOf(m.market) >= 0;
    });
    var names = { all: "上证指数", sse: "上证A股", szse: "深证A股", hs300: "沪深300", zza50: "中证A500", cyb: "创业板指", kc50: "科创板", bj: "北交所" };
    if (!mks.length) { box.hidden = true; return; }
    $("mmOverviewPeriod").textContent = ({ day: "今日", week: "近5日", month: "近20日", year: "今年以来" }[state.period] || "");
    $("mmOvList").innerHTML = mks.map(function (m) {
      return '<div class="mm-ov-item"><span class="ov-name">' + esc(names[m.market] || m.market) + '</span>' +
        '<span class="ov-val ' + tone(m.changePct) + '">' + fmtPct(m.changePct) + '</span></div>';
    }).join("");
    box.hidden = false;
  }
  function renderStats() {
    var box = $("mmStats");
    var data = state.payload && state.payload.data;
    if (!data || !data.summary) { box.innerHTML = '<div class="mm-stats-empty">选择市场后显示统计</div>'; return; }
    var s = data.summary;
    var up = s.advanceCount || 0, down = s.declineCount || 0, flat = s.flatCount || 0;
    var total = up + down + flat || 1;
    var upPct = (up / total * 100).toFixed(0);
    var idx = s.indexChangePct;
    var chgAmt = s.turnoverDelta;
    box.innerHTML =
      (idx != null ? '<div class="mm-stat-row"><span class="k">代表指数涨跌</span><span class="v mm-stat-big ' + tone(idx) + '">' + fmtPct(idx) + '</span></div>' : '') +
      '<div class="mm-stat-row"><span class="k">上涨 / 平 / 下跌</span><span class="v"><b class="mm-stat-up">' + up + '</b> / <b class="mm-stat-flat">' + flat + '</b> / <b class="mm-stat-down">' + down + '</b></span></div>' +
      '<div class="mm-stat-row"><span class="k">上涨占比</span><span class="v ' + tone(upPct - 50) + '">' + upPct + '%</span></div>' +
      (s.turnoverAmount != null ? '<div class="mm-stat-row"><span class="k">总成交额</span><span class="v">' + fmtMoney(s.turnoverAmount) + '</span></div>' : '') +
      (chgAmt != null ? '<div class="mm-stat-row"><span class="k">较上日</span><span class="v ' + tone(chgAmt) + '">' + (chgAmt > 0 ? "+" : "") + fmtMoney(chgAmt) + '</span></div>' : '') +
      '<div class="mm-stat-row"><span class="k">成分数量</span><span class="v">' + (data.stockCount || 0) + ' 只 / ' + (data.boardCount || 0) + ' 组</span></div>';
  }
  function renderHeader() {
    var p = state.payload, data = p.data;
    var title = state.watchMode ? "我的自选" : (p.name || state.market);
    $("mmTitle").textContent = title;
    $("mmScaleNote").textContent = "面积 = " + METRIC_LABEL[state.metric] + " · 颜色 = 涨跌幅" +
      ((state.meta && state.meta.unit) ? " · " + state.meta.unit : "");
    $("mmMetricLabel").textContent = METRIC_LABEL[state.metric];
    var stale = $("mmStalePill");
    if (p.stale) { stale.hidden = false; stale.textContent = "缓存快照" + (p.error ? "（刷新失败）" : ""); }
    else stale.hidden = true;
    var upd = data.updatedAt ? String(data.updatedAt).replace("T", " ").slice(0, 19) : "—";
    $("mmUpdated").textContent = "数据时间 " + upd + (p.cached ? " · 本地缓存" : " · 刚更新");
    var mg = data._merge || {};
    var srcTxt = (mg.quotes && mg.summary) ? "行情与统计均为最新" : (mg.quotes || mg.summary ? "部分数据降级" : "缓存快照");
    if (state.watchMode) srcTxt = "自选本地数据";
    $("mmDataNote").textContent = "数据来源：大盘云图公开接口（板块骨架 + 实时行情 + 实时统计合并，" + srcTxt +
      "），可能有延迟；仅供复盘参考，不构成投资建议。双击色块跳转第三方行情站。";
    var grad = $("mmGradient"), sc = effectiveScale();
    grad.style.background = "linear-gradient(90deg,#0d6b3f,#176b47,#2a2f38," + colorFor(sc * 0.5, sc) + "," + colorFor(sc, sc) + ")";
    $("mmBreadcrumb").innerHTML = "<b>" + esc(title) + "</b> › " +
      (state.filterBoard ? "已筛选板块" : "全部板块") + " › 共 " + (data.nodes ? data.nodes.length : 0) + " 个分组 · " + (data.stockCount || 0) + " 只标的";
    // 周期按钮状态
    Array.prototype.forEach.call($("mmPeriods").querySelectorAll("button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-period") === state.period);
    });
  }

  // ---------- 数据加载 ----------
  function loadMarket(market, force, opts) {
    if (state.loading) return;
    opts = opts || {};
    var silent = !!opts.silent;
    var keepView = silent || !!opts.keepView;
    state.loading = true;
    if (market === "__watch") { state.loading = false; generateWatchMap(); return; }
    state.watchMode = false;
    state.market = market;
    state.meta = state.markets.filter(function (m) { return m.key === market; })[0] || { key: market, scale: 10, unit: "元" };
    if (!silent) { $("mmLoading").hidden = false; $("mmEmpty").hidden = true; renderMarkets(); }
    var url = "/api/marketmap/data?market=" + encodeURIComponent(market) + "&period=" + state.period + (force ? "&force=1" : "");
    fetch(url, { cache: "no-store" })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.data.ok) throw new Error((res.data && res.data.error) || "加载失败");
        var prev = { tx: state.tx, ty: state.ty, scale: state.scale };
        state.payload = res.data;
        state.filterBoard = null; $("mmFilter").hidden = true;
        renderHeader(); renderStats(); buildLayout();
        if (keepView) { state.tx = prev.tx; state.ty = prev.ty; state.scale = prev.scale; }
        else fitView();
        if (state.mouse.inside && !state.dragging) {
          var r = hitTest(state.mouse.x, state.mouse.y);
          state.hoverRect = r; showTooltip(r, state.mouse.x, state.mouse.y);
        }
        renderMini(); draw();
        if (!state.rects.length) $("mmEmpty").hidden = false;
        loadOverview(state.period);
      })
      .catch(function (err) {
        if (silent) $("mmUpdated").textContent = "刷新失败 · " + (err.message || "未知错误");
        else { $("mmEmpty").hidden = false; $("mmEmpty").textContent = "加载失败：" + (err.message || "未知错误"); }
      })
      .finally(function () { state.loading = false; if (!silent) $("mmLoading").hidden = true; });
  }
  function loadMarkets() {
    return fetch("/api/marketmap/markets?period=" + state.period, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        state.markets = (res && res.items) || [];
        renderMarkets();
      }).catch(function () {});
  }
  function loadOverview(period) {
    return fetch("/api/marketmap/overview?period=" + period, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) { state.overview = d; renderOverview(); } })
      .catch(function () {});
  }

  // 顶部搜索（云图数据内查找并定位）
  var topSearchTimer = null;
  function topSearch(q) {
    q = (q || "").trim();
    var pop = $("mmSearchPop");
    if (!q) { pop.hidden = true; return; }
    fetch("/api/marketmap/search?q=" + encodeURIComponent(q), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d && d.items) || [];
        if (!items.length) { pop.innerHTML = '<div class="mm-sp-empty">未找到匹配股票</div>'; pop.hidden = false; return; }
        pop.innerHTML = items.map(function (it) {
          return '<button type="button" class="mm-sp-item" data-code="' + esc(it.code) + '">' +
            '<span>' + esc(it.name) + '<span class="sp-code"> · ' + esc(it.boardName || "") + '</span></span>' +
            '<span class="sp-code">' + esc(it.code) + '</span></button>';
        }).join("");
        pop.hidden = false;
      }).catch(function () { pop.hidden = true; });
  }
  function locateStock(code) {
    // 在当前云图找色块；找不到则提示
    var found = null;
    for (var i = 0; i < state.rects.length; i++) {
      if (state.rects[i].stock.code === code) { found = state.rects[i]; break; }
    }
    if (found) {
      var cx = found.x + found.w / 2, cy = found.y + found.h / 2;
      state.scale = Math.max(state.scale, 3);
      state.tx = canvas.clientWidth / 2 - cx * state.scale;
      state.ty = canvas.clientHeight / 2 - cy * state.scale;
      clampTranslate(); draw();
      state.hoverRect = found;
      showTooltip(found, canvas.clientWidth / 2, canvas.clientHeight / 2);
      setTimeout(function () { openDetail(found.stock, found.board); }, 120);
    } else {
      if (confirm("当前图中未找到该股票，是否打开行情页？")) {
        window.open("https://quote.eastmoney.com/search.html?keyword=" + encodeURIComponent(code), "_blank", "noopener,noreferrer");
      }
    }
  }

  // ---------- 自动刷新 ----------
  var VALID_INTERVALS = [4, 5, 6, 8, 10];
  function loadPref() {
    try {
      var p = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      if (VALID_INTERVALS.indexOf(Number(p.interval)) >= 0) state.intervalSec = Number(p.interval);
      state.autoRefresh = !!p.auto;
      if (p.period && ["day", "week", "month", "year"].indexOf(p.period) >= 0) state.period = p.period;
      if (p.metric && METRIC_LABEL[p.metric]) state.metric = p.metric;
      if (typeof p.mini === "boolean") state.mini = p.mini;
    } catch (e) {}
  }
  function savePref() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ auto: state.autoRefresh, interval: state.intervalSec,
        period: state.period, metric: state.metric, mini: state.mini }));
    } catch (e) {}
  }
  function updateAutoUI() {
    $("mmAutoToggle").checked = state.autoRefresh;
    $("mmAutoWrap").classList.toggle("on", state.autoRefresh);
    $("mmInterval").value = String(state.intervalSec);
    var cd = $("mmCountdown");
    cd.hidden = !state.autoRefresh;
    if (state.autoRefresh) cd.textContent = "下次 " + state.countdown + "s";
    $("mmMetric").value = state.metric;
    $("mmMiniToggle").checked = state.mini;
  }
  function startAuto() { state.autoRefresh = true; state.countdown = state.intervalSec; updateAutoUI(); savePref(); }
  function stopAuto() { state.autoRefresh = false; state.countdown = state.intervalSec; updateAutoUI(); savePref(); }
  function onIntervalChange() {
    var v = Number($("mmInterval").value);
    if (VALID_INTERVALS.indexOf(v) < 0) return;
    state.intervalSec = v; state.countdown = v; updateAutoUI(); savePref();
  }
  function tickAuto() {
    if (!state.autoRefresh || $("view-marketmap").hidden || state.watchMode) return;
    state.countdown--;
    if (state.countdown <= 0) {
      state.countdown = state.intervalSec;
      loadMarket(state.market, false, { silent: true });
    }
    updateAutoUI();
  }

  // ---------- 导航 ----------
  function switchView(view) {
    var isMap = view === "marketmap";
    var isCorr = view === "corr";
    $("view-gold").hidden = isMap || isCorr;
    $("view-marketmap").hidden = !isMap;
    $("navGold").classList.toggle("active", !isMap && !isCorr);
    $("navMarketMap").classList.toggle("active", isMap);
    $("navGold").setAttribute("aria-selected", String(!isMap && !isCorr));
    $("navMarketMap").setAttribute("aria-selected", String(isMap));
    var navCorr = $("navCorr"), viewCorr = $("view-corr");
    if (navCorr) {
      navCorr.classList.toggle("active", isCorr);
      navCorr.setAttribute("aria-selected", String(isCorr));
    }
    if (viewCorr) viewCorr.hidden = !isCorr;
    if (isMap) {
      requestAnimationFrame(function () { resize(); });
      if (!state.payload) { loadMarkets(); loadMarket(state.market, false); loadOverview(state.period); }
    }
    if (isCorr && window.CorrPanel) window.CorrPanel.activate();
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $("navGold").addEventListener("click", function () { switchView("gold"); });
    $("navMarketMap").addEventListener("click", function () { switchView("marketmap"); });
    var navCorr = $("navCorr");
    if (navCorr) navCorr.addEventListener("click", function () { switchView("corr"); });
    $("mmMarkets").addEventListener("click", function (e) {
      var btn = e.target.closest(".mm-market-item");
      if (btn) loadMarket(btn.getAttribute("data-key"), false);
    });
    $("mmPeriods").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-period]");
      if (!btn || btn.getAttribute("data-period") === state.period) return;
      state.period = btn.getAttribute("data-period");
      updateAutoUI(); savePref();
      state.payload = null; state.watchMode = false;
      loadMarkets(); loadMarket(state.market, false);
    });
    $("mmMetric").addEventListener("change", function () {
      state.metric = $("mmMetric").value; savePref();
      buildLayout(); renderHeader(); renderMini(); draw();
    });
    $("mmMiniToggle").addEventListener("change", function () {
      state.mini = $("mmMiniToggle").checked; savePref(); renderMini();
    });
    $("mmFilterClear").addEventListener("click", function () { setFilter(null); });
    // 顶部搜索
    $("mmSearch").addEventListener("input", function () {
      clearTimeout(topSearchTimer);
      var q = $("mmSearch").value; topSearchTimer = setTimeout(function () { topSearch(q); }, 220);
    });
    $("mmSearchPop").addEventListener("click", function (e) {
      var it = e.target.closest(".mm-sp-item");
      if (it) { $("mmSearchPop").hidden = true; $("mmSearch").value = ""; locateStock(it.getAttribute("data-code")); }
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".mm-search-wrap")) $("mmSearchPop").hidden = true;
      if (!e.target.closest(".mm-watch-add") && !e.target.closest(".mm-watch-search-pop")) $("mmWatchSearchPop").hidden = true;
    });
    // 详情
    $("mmDetailClose").addEventListener("click", closeDetail);
    $("mmDetailMask").addEventListener("click", function (e) { if (e.target === $("mmDetailMask")) closeDetail(); });
    $("mmDetailWatch").addEventListener("click", function () {
      if (detailStock && addWatch(detailStock)) { $("mmDetailWatch").textContent = "★ 已在自选"; }
    });
    $("mmDetailOpen").addEventListener("click", function () {
      if (detailStock) window.open(stockUrl(detailStock), "_blank", "noopener,noreferrer");
    });
    // 自选抽屉
    $("mmWatchlistBtn").addEventListener("click", function () { renderWatchList(); $("mmWatchMask").hidden = false; });
    $("mmWatchClose").addEventListener("click", function () { $("mmWatchMask").hidden = true; });
    $("mmWatchMask").addEventListener("click", function (e) { if (e.target === $("mmWatchMask")) $("mmWatchMask").hidden = true; });
    $("mmWatchInput").addEventListener("input", function () {
      clearTimeout(watchSearchTimer);
      var q = $("mmWatchInput").value; watchSearchTimer = setTimeout(function () { watchSearch(q); }, 220);
    });
    $("mmWatchSearchPop").addEventListener("click", function (e) {
      var it = e.target.closest(".mm-sp-item");
      if (it) {
        addWatch({ code: it.getAttribute("data-code"), name: it.getAttribute("data-name"),
          boardName: it.getAttribute("data-board"), exchange: it.getAttribute("data-ex") });
        $("mmWatchInput").value = ""; $("mmWatchSearchPop").hidden = true;
      }
    });
    $("mmWatchAddBtn").addEventListener("click", function () { watchSearch($("mmWatchInput").value); });
    $("mmWatchList").addEventListener("click", function (e) {
      var del = e.target.closest(".wi-del");
      if (del) removeWatch(del.getAttribute("data-code"));
    });
    $("mmWatchGenerate").addEventListener("click", generateWatchMap);
    // 投研工具
    $("mmToolsBtn").addEventListener("click", function () { $("mmToolsMask").hidden = false; });
    $("mmToolsClose").addEventListener("click", function () { $("mmToolsMask").hidden = true; });
    $("mmToolsMask").addEventListener("click", function (e) { if (e.target === $("mmToolsMask")) $("mmToolsMask").hidden = true; });
    // 刷新
    $("mmRefreshBtn").addEventListener("click", function () {
      if (state.watchMode) generateWatchMap(); else loadMarket(state.market, true);
    });
    $("mmAutoToggle").addEventListener("change", function () { if ($("mmAutoToggle").checked) startAuto(); else stopAuto(); });
    $("mmInterval").addEventListener("change", onIntervalChange);
    $("mmFullscreenBtn").addEventListener("click", function () {
      if (!document.fullscreenElement) { if (stage.requestFullscreen) stage.requestFullscreen(); }
      else if (document.exitFullscreen) document.exitFullscreen();
    });
    // 画布
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", function (e) { if (state.dragging) onMouseMove(e); });
    stage.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    stage.addEventListener("mouseleave", onMouseLeave);
    stage.addEventListener("click", onClick);
    stage.addEventListener("dblclick", onDblClick);
    document.addEventListener("fullscreenchange", function () { setTimeout(resize, 80); });
    window.addEventListener("resize", function () { if (!$("view-marketmap").hidden) resize(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeDetail(); $("mmWatchMask").hidden = true; $("mmToolsMask").hidden = true;
        if (inspector.locked) { inspector.locked = false; rerenderInspector(); }
        return;
      }
      if (!$("view-marketmap").hidden && inspector.rect && tooltip && !tooltip.hidden) {
        var k = (e.key || "").toLowerCase();
        if (k === "g") { // 锁定/解锁
          inspector.locked = !inspector.locked; rerenderInspector(); e.preventDefault();
        } else if (k === "s") { // 切换排序（Shift 反向循环）
          inspector.sortIdx = (inspector.sortIdx + (e.shiftKey ? INSPECTOR_SORTS.length - 1 : 1)) % INSPECTOR_SORTS.length;
          rerenderInspector(); e.preventDefault();
        } else if (k === "m") { // 手动刷新当前数据
          loadMarket(state.market, true, { silent: true }); e.preventDefault();
        }
      }
    });
  }

  function init() {
    stage = $("mmStage"); canvas = $("mmCanvas"); tooltip = $("mmTooltip");
    if (!stage || !canvas) return;
    ctx = canvas.getContext("2d");
    bind();
    loadPref();
    loadWatch();
    updateAutoUI();
    loadMarkets();
    loadOverview(state.period);
    setInterval(tickAuto, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
