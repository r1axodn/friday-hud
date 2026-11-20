/* ==========================================================================
   FRIDAY HUD — app.js
   · 화면 정중앙 고정 코어 시계 / D-DAY / 텔레메트리
   · Supabase Realtime(INSERT) → 화면 전체에 뜨는 플로팅 홀로그램 창
   · 창은 슬롯 배치(자동) + 드래그 이동 + 클릭 시 최상단
   · 연결이 없어도 ?demo=1 또는 DEMO POPUP 으로 연출 확인 가능
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------- config */
  var SUPABASE_URL = 'https://vipaohlgodyrbjnsewuo.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_pl28DHu3fwfqU-Nw92hyPg_nLcdeJaS';
  var TABLE = 'hud_panels';
  var MAX_CARDS = 6;
  var MIN_W = 180, MIN_H = 130;          /* 창을 줄일 수 있는 최소 크기 */

  /* 단대부고 2026 2학기 2학년 기말고사: 12/8(화) 1교시 미적분Ⅰ ~ 12/14(월) 기하 */
  var EXAM_START = '2026-12-08';
  var EXAM_END = '2026-12-14';
  var SUNEUNG = '2027-11-18';

  var TYPE_LABEL = { news: 'NEWS', youtube: 'VIDEO', image: 'IMAGE', briefing: 'BRIEFING', alert: 'ALERT' };

  /* ------------------------------------------------------------- helpers */
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeUrl(u) {
    if (!u) return null;
    var s = String(u).trim();
    if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) return s;
    if (/^\/\//.test(s)) return 'https:' + s;
    return null;
  }
  function ytId(u) {
    if (!u) return null;
    var s = String(u).trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    var m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
    return m ? m[1] : null;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  var KST_DATE = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  function dateKey(d) { return KST_DATE.format(d); }          /* 2026-11-20 */
  function dayDiff(a, b) {                                    /* b - a, 일 단위 */
    var A = a.split('-').map(Number), B = b.split('-').map(Number);
    return Math.round((Date.UTC(B[0], B[1] - 1, B[2]) - Date.UTC(A[0], A[1] - 1, A[2])) / 86400000);
  }
  function dday(targetKey, nowKey) {
    var d = dayDiff(nowKey, targetKey);
    if (d > 0) return { text: 'D-' + d, tone: d <= 7 ? 'hot' : '' };
    if (d === 0) return { text: 'D-DAY', tone: 'today' };
    return { text: 'D+' + (-d), tone: '' };
  }
  function hhmmss(ms) {
    var t = Math.max(0, Math.floor(ms / 1000));
    return pad(Math.floor(t / 3600)) + ':' + pad(Math.floor(t / 60) % 60) + ':' + pad(t % 60);
  }

  /* --------------------------------------------------------------- state */
  var state = {
    seen: new Set(),      /* 이미 큐에 올린 패널 id */
    pinned: new Set(),
    rx: 0,
    lat: null,
    start: Date.now(),
    lastCreatedAt: null,
    channel: null,
    pollTimer: null,
    demoTimer: null,
    net: 'init',
    sfx: false
  };

  /* 잠금 상태 (카드 수신은 버퍼링해 두었다가 해제 시 한번에 렌더) */
  var locked = true;
  var pending = [];

  /* ---------------------------------------------------------------- view */
  var stageEl = $('stage');
  var bannersEl = $('banners');
  var histEl = $('history');
  var focusEl = $('focus');
  var topEl = document.querySelector('.top');
  var bottomEl = $('bottom');

  var zTop = 100;
  var seq = 0;

  /* --------------------------------------------------------------- 시간 */
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  var SEC_RING_LEN = 2 * Math.PI * 161;      /* r=161 */

  function tickClock() {
    var now = new Date();
    $('tH').textContent = pad(now.getHours());
    $('tM').textContent = pad(now.getMinutes());
    $('tS').textContent = pad(now.getSeconds());
    $('date').textContent = now.getFullYear() + '.' + pad(now.getMonth() + 1) + '.' + pad(now.getDate()) +
      ' (' + WEEK[now.getDay()] + ')';
    var key = dateKey(now);

    /* 초침 링 */
    var sr = $('secRing');
    if (sr) sr.style.strokeDashoffset = (SEC_RING_LEN * (1 - (now.getSeconds() + now.getMilliseconds() / 1000) / 60)).toFixed(1);

    $('lockTime').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
    $('lockDate').textContent = now.getFullYear() + '.' + pad(now.getMonth() + 1) + '.' + pad(now.getDate()) +
      ' (' + WEEK[now.getDay()] + ')';

    var e = dday(EXAM_START, key);
    $('dExam').textContent = e.text;
    $('dExam').className = 'stat-v ' + e.tone;
    var s = dday(SUNEUNG, key);
    $('dSuneung').textContent = s.text;
    $('dSuneung').className = 'stat-v ' + s.tone;

    /* 코어 하단: 가장 가까운 일정 */
    var next = dayDiff(key, EXAM_START);
    var nx = $('coreNext');
    if (nx) {
      nx.innerHTML = next > 0
        ? 'NEXT <b>' + e.text + '</b> 기말고사 · ' + EXAM_START.replace(/-/g, '.')
        : 'NEXT <b>' + s.text + '</b> 수능 · ' + SUNEUNG.replace(/-/g, '.');
    }

    $('uptime').textContent = hhmmss(Date.now() - state.start);
    $('teleClock').textContent = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
      ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    if (state.lat != null) {
      $('latency').textContent = state.lat.toFixed(2) + 's';
      $('latency').className = 'stat-v mono' + (state.lat < 0.5 ? ' hot' : '');
    }
  }

  /* ---- 코어(시계) 크기: 화면 대비 + 창이 비켜설 공간 확보 ---- */
  function fitClock() {
    var vw = window.innerWidth, vh = window.innerHeight;
    /* 링 지름을 먼저 정하고, 시계 글자는 링 안쪽(약 0.72 지름)에 들어오게 */
    var d = clamp(Math.min(vw * 0.62, vh * 0.92), 210, 780);
    var size = clamp(d * 0.135, 30, 118);
    document.documentElement.style.setProperty('--clk', size.toFixed(1) + 'px');
    document.documentElement.style.setProperty('--coreD', d.toFixed(0) + 'px');

    var t = topEl.getBoundingClientRect();
    document.documentElement.style.setProperty('--top-h', Math.round(t.bottom + 4) + 'px');
  }

  /* ---- 링 눈금 ---- */
  function drawTicks() {
    var g = $('ticks');
    if (!g || g.childNodes.length) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 60; i++) {
      var a = (i * 6 - 90) * Math.PI / 180;
      var big = i % 5 === 0;
      var r1 = 188, r2 = big ? 176 : 182;
      var ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('x1', (200 + r1 * Math.cos(a)).toFixed(2));
      ln.setAttribute('y1', (200 + r1 * Math.sin(a)).toFixed(2));
      ln.setAttribute('x2', (200 + r2 * Math.cos(a)).toFixed(2));
      ln.setAttribute('y2', (200 + r2 * Math.sin(a)).toFixed(2));
      if (big) ln.setAttribute('class', 'big');
      frag.appendChild(ln);
    }
    g.appendChild(frag);
  }

  /* ==================================================================
     배치 엔진 — 화면 전체를 쓰는 플로팅 창
     ================================================================== */
  function isCompact() { return window.innerWidth <= 640; }

  /* 창이 놓일 수 있는 영역: 상단바(긴급 배너 포함) 아래 ~ 하단 계기 위 */
  function area() {
    var t = topEl.getBoundingClientRect();
    var b = bottomEl.getBoundingClientRect();
    var p = isCompact() ? 6 : 12;
    var x0 = p, y0 = Math.round(t.bottom + 6);
    if (bannersEl.children.length) {
      var bn = bannersEl.getBoundingClientRect();
      if (bn.height > 0 && bn.bottom > y0 - 6) y0 = Math.round(bn.bottom + 8);
    }
    var x1 = window.innerWidth - p, y1 = Math.round(b.top - 6);
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: Math.max(60, x1 - x0), h: Math.max(60, y1 - y0) };
  }

  /* 시계 글자가 차지하는 영역 — 창은 이 안쪽을 비운다 */
  function coreSafe() {
    var el = document.querySelector('.core-body');
    var c = el.getBoundingClientRect();
    var g = 14;
    return {
      x0: c.left - g, y0: c.top - g, x1: c.right + g, y1: c.bottom + g,
      cx: (c.left + c.right) / 2, cy: (c.top + c.bottom) / 2
    };
  }

  function fitRect(r, A) {
    var w = Math.min(r.w, A.w), h = Math.min(r.h, A.h);
    return {
      x: clamp(r.x, Math.min(A.x0, A.x1 - w), Math.max(A.x0, A.x1 - w)),
      y: clamp(r.y, Math.min(A.y0, A.y1 - h), Math.max(A.y0, A.y1 - h)),
      w: Math.max(120, w), h: Math.max(120, h)
    };
  }

  /* 좌·우 두 열 + 위·아래 분할 (가로 화면) */
  function sideSlots(A, C, n) {
    var g = 14;
    var leftMax = (C.x0 - g) - A.x0;
    var rightMax = A.x1 - (C.x1 + g);
    var maxW = Math.min(leftMax, rightMax);
    var pref = n === 1 ? 0.46 : n === 2 ? 0.42 : n === 3 ? 0.36 : n === 4 ? 0.34 : 0.30;
    var w = clamp(Math.min(A.w * pref, maxW), 200, 640);
    var xL = A.x0, xR = A.x1 - w;
    var hHalf = (A.h - g) / 2;
    var s;

    if (n === 1) {
      var h1 = Math.min(A.h * 0.88, 680);
      s = [{ x: xR, y: A.y0 + (A.h - h1) / 2, w: w, h: h1 }];
    } else if (n === 2) {
      var h2 = Math.min(A.h * 0.82, 640);
      s = [{ x: xR, y: A.y0 + (A.h - h2) / 2, w: w, h: h2 },
           { x: xL, y: A.y0 + (A.h - h2) / 2, w: w, h: h2 }];
    } else if (n === 3) {
      s = [{ x: xR, y: A.y0, w: w, h: A.h },
           { x: xL, y: A.y0, w: w, h: hHalf },
           { x: xL, y: A.y0 + hHalf + g, w: w, h: hHalf }];
    } else if (n === 4) {
      s = [{ x: xR, y: A.y0, w: w, h: hHalf },
           { x: xR, y: A.y0 + hHalf + g, w: w, h: hHalf },
           { x: xL, y: A.y0, w: w, h: hHalf },
           { x: xL, y: A.y0 + hHalf + g, w: w, h: hHalf }];
    } else {
      /* 5~6: 두 열을 3칸으로 나눠 겹치지 않게 (5개는 왼쪽만 3칸) */
      var rows = 3;
      var hr = (A.h - g * (rows - 1)) / rows;
      s = [];
      if (n === 5) {
        var h2 = (A.h - g) / 2;
        s.push({ x: xR, y: A.y0, w: w, h: h2 });
        s.push({ x: xR, y: A.y0 + h2 + g, w: w, h: h2 });
        for (var r = 0; r < 3; r++) s.push({ x: xL, y: A.y0 + r * (hr + g), w: w, h: hr });
      } else {
        for (var q = 0; q < rows; q++) {
          s.push({ x: xR, y: A.y0 + q * (hr + g), w: w, h: hr });
          s.push({ x: xL, y: A.y0 + q * (hr + g), w: w, h: hr });
        }
      }
    }
    return s.map(function (r) { return fitRect(r, A); });
  }

  /* 세로 화면: 시계 위·아래 띠에 2열로 */
  function bandSlots(A, C, n) {
    var g = 14;
    var belowTop = C.y1 + g, belowH = A.y1 - belowTop;
    var aboveBot = C.y0 - g, aboveH = aboveBot - A.y0;
    var zones = [];
    if (belowH > 120) zones.push({ y: belowTop, h: belowH });
    if (aboveH > 120) zones.push({ y: A.y0, h: aboveH });
    if (!zones.length) return [];

    var cols = A.w >= 460 ? 2 : 1;
    var rows = Math.max(1, Math.ceil(n / (zones.length * cols)));
    var minH = 130;
    while (rows > 1 && zones.every(function (z) { return (z.h - g * (rows - 1)) / rows < minH; })) rows--;

    var slots = [];
    var w = (A.w - g * (cols - 1)) / cols;
    for (var zi = 0; zi < zones.length && slots.length < n; zi++) {
      var z = zones[zi];
      var h = (z.h - g * (rows - 1)) / rows;
      for (var r = 0; r < rows && slots.length < n; r++) {
        for (var c = 0; c < cols && slots.length < n; c++) {
          slots.push({ x: A.x0 + c * (w + g), y: z.y + r * (h + g), w: w, h: h });
        }
      }
    }
    return slots.map(function (rr) { return fitRect(rr, A); });
  }

  /* 폰: 화면 폭을 꽉 쓰는 계단식 창 (최신 창이 아래, 제목줄은 위로 계단처럼) */
  function compactSlots(A, C, n) {
    var g = 8;
    var cols = A.w >= 620 ? 2 : 1;
    var w = (A.w - g * (cols - 1)) / cols;
    var out = [];

    if (cols === 1 && n === 1) {
      /* 한 장이면 시계 아래에 붙여 시계를 가리지 않는다 */
      var y0 = clamp(C.y1 + 10, A.y0, Math.max(A.y0, A.y1 - 150));
      return [fitRect({ x: A.x0, y: y0, w: A.w, h: A.y1 - y0 }, A)];
    }

    var h = Math.max(150, Math.min(A.h * (cols === 1 ? 0.5 : 0.62), cols === 1 ? 320 : 250));
    var step = cols === 1 ? 46 : 30;
    var maxStack = Math.max(0, A.h - h);

    for (var i = 0; i < n; i++) {
      var row = Math.floor(i / cols);
      var col = i % cols;
      var dy = (cols === 1) ? Math.min((n - 1 - i) * step, maxStack)
                            : Math.min(row * step, maxStack);
      var dx = Math.min(i * 3, 12);
      out.push({ x: A.x0 + col * (w + g) + dx, y: A.y0 + dy, w: w - dx, h: h });
    }
    return out.map(function (r) { return fitRect(r, A); });
  }

  function computeSlots(A, C, n) {
    if (isCompact()) return compactSlots(A, C, n);
    var sideRoom = Math.min(C.x0 - A.x0, A.x1 - C.x1);
    if (sideRoom >= 250 && A.h >= 300) return sideSlots(A, C, n);
    var bands = bandSlots(A, C, n);
    if (bands.length >= n) return bands;
    return compactSlots(A, C, n);
  }

  function applyRect(el, r) {
    el.style.left = Math.round(r.x) + 'px';
    el.style.top = Math.round(r.y) + 'px';
    el.style.width = Math.round(r.w) + 'px';
    el.style.height = Math.round(r.h) + 'px';
  }

  function layout(force) {
    var cards = [].slice.call(stageEl.querySelectorAll('.card:not(.out)'));
    if (!cards.length) return;
    var A = area(), C = coreSafe();
    var slots = computeSlots(A, C, cards.length);
    cards.sort(function (a, b) { return (b._seq || 0) - (a._seq || 0); });   /* 최신 먼저 */

    var si = 0;
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i];
      if (el._moved && !force) {
        /* 사용자가 옮기거나 키운 창은 그대로 (transform 영향 없는 offset 기준) */
        applyRect(el, fitRect({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }, A));
        continue;
      }
      var s = slots[si] || slots[slots.length - 1];
      si++;
      if (s) applyRect(el, s);
    }
  }

  var layoutRAF = 0;
  function requestLayout(force) {
    if (layoutRAF) return;
    layoutRAF = requestAnimationFrame(function () {
      layoutRAF = 0;
      layout(force);
    });
  }

  function tidy() {
    var cards = [].slice.call(stageEl.querySelectorAll('.card'));
    for (var i = 0; i < cards.length; i++) {
      cards[i]._moved = false;
      if (cards[i]._maximized) { cards[i]._maximized = false; updateSizeBtn(cards[i]); }
    }
    layout(true);
  }

  /* --------------------------------------------------------------- 창 조작 */
  var activeEl = null;

  /* 클릭한 창을 맨 앞으로 (z-index 최상위) + 활성 표시 */
  function raise(el) {
    el.style.zIndex = String(++zTop);
    if (activeEl === el) return;
    if (activeEl) activeEl.classList.remove('active');
    activeEl = el;
    el.classList.add('active');
  }

  function topMostCard(exclude) {
    var best = null, bz = -1;
    var cards = stageEl.querySelectorAll('.card:not(.out)');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c === exclude) continue;
      var z = +c.style.zIndex || 0;
      if (z > bz) { bz = z; best = c; }
    }
    return best;
  }

  function startDrag(e, el) {
    if (e.button != null && e.button !== 0) return;
    var bar = e.currentTarget;
    if (e.target.closest && e.target.closest('.card-actions')) return;
    e.preventDefault();
    raise(el);
    el._moved = true;

    /* 패럴랙스 transform 에 흔들리지 않도록 실제 좌표(offset)를 기준으로 */
    var ox = el.offsetLeft, oy = el.offsetTop;
    var sx = e.clientX, sy = e.clientY;
    var w = el.offsetWidth, h = el.offsetHeight;
    var A = area();

    el.classList.add('dragging');
    document.body.classList.add('is-dragging');
    if (bar.setPointerCapture) { try { bar.setPointerCapture(e.pointerId); } catch (err) {} }

    function move(ev) {
      var nx = clamp(ox + ev.clientX - sx, Math.min(A.x0, A.x1 - w), Math.max(A.x0, A.x1 - w));
      var ny = clamp(oy + ev.clientY - sy, Math.min(A.y0, A.y1 - h), Math.max(A.y0, A.y1 - h));
      el.style.left = Math.round(nx) + 'px';
      el.style.top = Math.round(ny) + 'px';
    }
    function up() {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      bar.removeEventListener('lostpointercapture', up);
      el.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
    }
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
    bar.addEventListener('lostpointercapture', up);
  }

  /* ---- 창 크기 조절: 우하단 손잡이를 끌어 자유롭게 ---- */
  function startResize(e, el) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    raise(el);

    var A = area();
    var ox = el.offsetLeft, oy = el.offsetTop;
    var w0 = el.offsetWidth, h0 = el.offsetHeight;
    var sx = e.clientX, sy = e.clientY;

    /* 최대: 지금 위치에서 스테이지 끝까지 (화면 밖으로 나가지 않게) */
    var maxW = Math.max(120, A.x1 - ox);
    var maxH = Math.max(120, A.y1 - oy);
    var minW = Math.min(MIN_W, maxW), minH = Math.min(MIN_H, maxH);

    el._moved = true;
    if (el._maximized) { el._maximized = false; updateSizeBtn(el); }

    var handle = e.currentTarget;
    el.classList.add('resizing');
    document.body.classList.add('is-resizing');
    el.style.setProperty('--px', '0px');
    el.style.setProperty('--py', '0px');
    el.style.left = Math.round(ox) + 'px';
    el.style.top = Math.round(oy) + 'px';
    if (handle.setPointerCapture) { try { handle.setPointerCapture(e.pointerId); } catch (err) {} }

    function move(ev) {
      var nw = clamp(w0 + (ev.clientX - sx), minW, maxW);
      var nh = clamp(h0 + (ev.clientY - sy), minH, maxH);
      el.style.width = Math.round(nw) + 'px';
      el.style.height = Math.round(nh) + 'px';
    }
    function up() {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.removeEventListener('lostpointercapture', up);
      el.classList.remove('resizing');
      document.body.classList.remove('is-resizing');
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    handle.addEventListener('lostpointercapture', up);
  }

  /* ---- 헤더 ⤢ 버튼: 한 번에 크게 / 원래 크기 ---- */
  function updateSizeBtn(el) {
    var b = el.querySelector('.act-size');
    if (!b) return;
    var on = !!el._maximized;
    b.textContent = on ? '⤡' : '⤢';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = on ? '원래 크기로 되돌리기' : '창을 화면 가득 크게';
    b.setAttribute('aria-label', on ? '원래 크기로 되돌리기' : '창을 화면 가득 크게');
  }

  function toggleSize(el) {
    var A = area();
    if (el._maximized && el._restore) {
      applyRect(el, fitRect(el._restore, A));
      el._maximized = false;
    } else {
      el._restore = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      applyRect(el, { x: A.x0, y: A.y0, w: A.w, h: A.h });
      el._maximized = true;
    }
    el._moved = true;                       /* 다음 자동 배치가 건드리지 않게 */
    el.style.setProperty('--px', '0px');
    el.style.setProperty('--py', '0px');
    raise(el);
    updateSizeBtn(el);
  }

  /* 시차(parallax): 마우스가 움직이면 창이 살짝 따라 흐른다 */
  var mouseX = 0, mouseY = 0, paraRAF = 0;
  function parallaxMove(e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    mouseX = e.clientX; mouseY = e.clientY;
    if (paraRAF) return;
    paraRAF = requestAnimationFrame(function () {
      paraRAF = 0;
      var dx = (mouseX / window.innerWidth - 0.5) * 2;
      var dy = (mouseY / window.innerHeight - 0.5) * 2;
      var cards = stageEl.querySelectorAll('.card');
      for (var i = 0; i < cards.length; i++) {
        var el = cards[i];
        if (el.classList.contains('dragging') || el.classList.contains('resizing')) continue;
        var d = el.dataset.depth || '0.6';
        el.style.setProperty('--px', (-dx * 9 * d).toFixed(1) + 'px');
        el.style.setProperty('--py', (-dy * 7 * d).toFixed(1) + 'px');
      }
    });
  }

  /* ---- 연결 상태 ---- */
  var NET_TEXT = {
    init: 'CONNECTING',
    live: 'ONLINE · REALTIME',
    demo: 'DEMO · NO LINK',
    setup: 'DB SETUP NEEDED',
    off: 'OFFLINE'
  };
  function setNet(kind, text) {
    state.net = kind;
    var pill = $('netPill');
    pill.className = 'pill ' + (kind === 'live' ? 'on' : kind === 'off' ? 'off' : kind === 'init' ? '' : 'warn');
    $('netText').textContent = text || NET_TEXT[kind] || String(kind).toUpperCase();
    $('connShort').textContent = kind === 'live' ? 'realtime link' : kind === 'setup' ? 'sql required' : kind === 'demo' ? 'demo mode' : String(kind);
    var cl = $('coreLink');
    if (cl) cl.textContent = kind === 'live' ? 'LIVE' : kind === 'demo' ? 'DEMO' : kind === 'setup' ? 'SETUP' : kind === 'off' ? 'OFFLINE' : 'LINK';
    var tele = {
      live: 'REALTIME LINK ACTIVE',
      demo: 'DEMO MODE — NO REALTIME LINK',
      setup: 'TABLE MISSING — RUN SUPABASE SQL',
      off: 'LINK DOWN — RETRYING',
      init: 'SYSTEM READY'
    };
    $('teleState').textContent = tele[kind] || 'SYSTEM READY';
  }

  /* ---- 토스트 ---- */
  var toastTimer = null;
  function toast(msg) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 260);
    }, 2600);
  }

  /* ---- 알림음 ---- */
  var actx = null;
  function blip(freq, dur, gainV) {
    if (!state.sfx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = actx || new AC();
      if (actx.state === 'suspended') actx.resume();
      var osc = actx.createOscillator(), g = actx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.value = 0;
      osc.connect(g); g.connect(actx.destination);
      var t = actx.currentTime;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gainV || 0.05, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.start(t); osc.stop(t + dur + 0.02);
    } catch (e) { /* 무음 실패는 무시 */ }
  }
  function ping() { blip(880, 0.16, 0.045); setTimeout(function () { blip(1320, 0.18, 0.035); }, 90); }

  /* --------------------------------------------------- 마크다운(간단) */
  function mdInline(s) {
    return s
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function mdLite(text) {
    var lines = esc(text).split(/\r?\n/);
    var out = '', inList = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (/^[-*•]\s+/.test(line)) {
        if (!inList) { out += '<ul>'; inList = true; }
        out += '<li>' + mdInline(line.replace(/^[-*•]\s+/, '')) + '</li>';
        continue;
      }
      if (inList) { out += '</ul>'; inList = false; }
      if (!line) continue;
      if (/^#{1,4}\s+/.test(line)) {
        out += '<h3>' + mdInline(line.replace(/^#{1,4}\s+/, '')) + '</h3>';
        continue;
      }
      out += '<div class="ln">' + mdInline(line) + '</div>';
    }
    if (inList) out += '</ul>';
    return out;
  }

  /* --------------------------------------------------------- 창 만들기 */
  function tagLabel(t) { return TYPE_LABEL[t] || 'PANEL'; }
  function clockLabel(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function buildCard(panel, opts) {
    opts = opts || {};
    var type = TYPE_LABEL[panel.type] ? panel.type : 'news';
    var el = document.createElement('article');
    el.className = 'card';
    el.dataset.type = type;
    el.dataset.id = panel.id || ('x' + Date.now());
    el._seq = ++seq;
    el.dataset.depth = (0.35 + ((seq * 37) % 60) / 100).toFixed(2);   /* 창마다 다른 깊이 */

    var src = panel.source ? '<span class="card-src">' + esc(panel.source) + '</span>' : '';
    var bar = '<div class="card-bar" role="group" aria-label="창 이동">' +
      '<span class="grip" aria-hidden="true"></span>' +
      '<span class="tag">' + tagLabel(type) + '</span>' + src +
      '<span class="card-time">' + clockLabel(panel.created_at) + '</span>' +
      '<div class="card-actions">' +
        '<button class="icon-btn act-size" type="button" title="창을 화면 가득 크게" aria-label="창을 화면 가득 크게" aria-pressed="false">⤢</button>' +
        '<button class="icon-btn act-expand" type="button" title="카드 전체화면으로 보기" aria-label="카드 전체화면으로 보기">▣</button>' +
        '<button class="icon-btn act-pin" type="button" title="고정 (오래된 창 정리에서 제외)" aria-label="고정" aria-pressed="false">◈</button>' +
        '<button class="icon-btn act-close" type="button" title="닫기" aria-label="닫기">✕</button>' +
      '</div></div>';

    var html = '';
    var title = panel.title ? '<h3 class="card-title">' + esc(panel.title) + '</h3>' : '';

    if (type === 'youtube') {
      var vid = ytId(panel.url);
      html += title;
      if (vid) {
        html += '<div class="card-media"><div class="yt">' +
          '<iframe src="https://www.youtube.com/embed/' + vid +
          '?playsinline=1&rel=0" title="' + esc(panel.title || 'YouTube') +
          '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"' +
          ' allowfullscreen tabindex="-1" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div></div>';
      } else if (panel.url) {
        html += '<p class="caption">유튜브 주소를 해석하지 못했어요. 링크로 열어 주세요.</p>';
      }
      if (panel.body) html += '<div class="card-body">' + mdLite(panel.body) + '</div>';
    } else if (type === 'image') {
      var img = safeUrl(panel.image_url) || safeUrl(panel.url);
      html += title;
      if (img) {
        html += '<div class="card-media"><img src="' + esc(img) + '" alt="' + esc(panel.caption || panel.title || 'image') +
          '" loading="lazy" referrerpolicy="no-referrer"></div>';
      }
      if (panel.caption) html += '<p class="caption">' + esc(panel.caption) + '</p>';
      if (panel.body) html += '<div class="card-body">' + mdLite(panel.body) + '</div>';
    } else {
      html += title;
      if (panel.body) html += '<div class="card-body">' + mdLite(panel.body) + '</div>';
    }

    var link = safeUrl(panel.url);
    var foot = '<div class="card-foot">';
    if (link && type !== 'youtube') {
      foot += '<a class="card-link" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' +
        (panel.source ? esc(panel.source) : '원문 열기') + ' ↗</a>';
    } else if (link && type === 'youtube') {
      foot += '<a class="card-link" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">YouTube ↗</a>';
    }
    foot += '<span class="card-id">p ' + pad(seq) + '</span></div>';

    el.innerHTML = bar + '<div class="card-scroll">' + html + '</div>' + foot +
      '<div class="card-resize" title="끌어서 창 크기 조절" aria-label="창 크기 조절"></div>';

    /* 동작 */
    var barEl = el.querySelector('.card-bar');
    var sizeBtn = el.querySelector('.act-size');
    var handle = el.querySelector('.card-resize');
    if (opts.flat) {
      /* 전체화면 보기용 사본에서는 창 조작을 두지 않는다 */
      if (handle) handle.remove();
      if (sizeBtn) sizeBtn.remove();
      barEl.style.cursor = 'default';
      barEl.style.touchAction = 'auto';
    } else {
      el.addEventListener('pointerdown', function () { raise(el); });
      barEl.addEventListener('pointerdown', function (e) { startDrag(e, el); });
      if (handle) handle.addEventListener('pointerdown', function (e) { startResize(e, el); });
      if (sizeBtn) sizeBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleSize(el); });
    }

    el.querySelector('.act-close').addEventListener('click', function () { dismiss(el); });
    el.querySelector('.act-expand').addEventListener('click', function () { openFocus(panel); });
    var pinBtn = el.querySelector('.act-pin');
    pinBtn.addEventListener('click', function () {
      var on = !el.classList.contains('pinned');
      el.classList.toggle('pinned', on);
      pinBtn.classList.toggle('pinned', on);
      pinBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) {
        state.pinned.add(el.dataset.id);
        clearTimeout(el._timer);
        var pg = el.querySelector('.card-progress');
        if (pg) pg.remove();
        raise(el);
      } else {
        state.pinned.delete(el.dataset.id);
        scheduleDismiss(el);
      }
    });

    return el;
  }

  /* 플로팅 창은 스스로 사라지지 않는다.
     · 자동 닫힘 타이머와 .card-progress 바를 돌리지 않음 (DB 의 duration 값은 무시)
     · 닫히는 경우: 사용자가 ✕ 를 누를 때, ESC 로 가장 위 창을 닫을 때,
       MAX_CARDS(6) 를 넘겨 오래된 창이 정리될 때(capCards) 뿐.
     · 상단 알림 배너(alert)의 자동 사라짐은 showBanner 쪽에서 따로 처리한다. */
  function scheduleDismiss(el) {
    clearTimeout(el._timer);
    el._timer = null;
    var pg = el.querySelector('.card-progress');
    if (pg) pg.remove();
  }

  function dismiss(el) {
    if (!el || el.classList.contains('out')) return;
    clearTimeout(el._timer);
    el.classList.add('out');
    if (activeEl === el) {
      activeEl = null;
      var next = topMostCard(el);
      if (next) raise(next);
    }
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      layout();
    }, 300);
  }

  function capCards() {
    /* 최신 창이 앞·위 → 오래된 것부터 정리 */
    var cards = [].slice.call(stageEl.querySelectorAll('.card:not(.out)'))
      .sort(function (a, b) { return (b._seq || 0) - (a._seq || 0); });
    var free = cards.filter(function (c) { return !c.classList.contains('pinned'); });
    if (free.length > MAX_CARDS) {
      for (var i = MAX_CARDS; i < free.length; i++) dismiss(free[i]);
    }
    if (cards.length > MAX_CARDS + 2) {
      for (var j = MAX_CARDS + 2; j < cards.length; j++) dismiss(cards[j]);
    }
  }

  /* ------------------------------------------------------------ 창 띄우기 */
  function pushCard(panel) {
    var el = buildCard(panel);
    if (state.pinned.has(el.dataset.id)) {
      el.classList.add('pinned');
      var pb = el.querySelector('.act-pin');
      if (pb) { pb.classList.add('pinned'); pb.setAttribute('aria-pressed', 'true'); }
    }

    /* 첫 위치는 애니메이션 없이 즉시 */
    el.style.transition = 'none';
    stageEl.appendChild(el);
    raise(el);
    layout();

    requestAnimationFrame(function () {
      el.style.transition = '';
    });

    capCards();
    layout();
    scheduleDismiss(el);
    ping();
    return el;
  }

  /* ------------------------------------------------------------ 알림 배너 */
  function showBanner(panel) {
    var el = document.createElement('div');
    el.className = 'banner';
    el.innerHTML =
      '<span class="bx" aria-hidden="true">!</span>' +
      '<div class="bt"><h4>' + esc(panel.title || '긴급 알림') + '</h4>' +
      (panel.body ? '<p>' + esc(panel.body) + '</p>' : '') +
      '<div class="bmeta">ALERT · ' + clockLabel(panel.created_at) +
      (panel.source ? ' · ' + esc(panel.source) : '') + '</div></div>' +
      '<button class="icon-btn act-close" type="button" aria-label="닫기">✕</button>';
    el.querySelector('.act-close').addEventListener('click', function () { kill(el, 'out'); });
    bannersEl.appendChild(el);
    syncBannerOffset();
    requestLayout();
    var dur = panel.duration != null ? Number(panel.duration) : 25;
    if (dur > 0) el._timer = setTimeout(function () { kill(el, 'out'); }, dur * 1000);
    blip(660, 0.22, 0.05);
    return el;
  }
  function kill(el, cls) {
    clearTimeout(el._timer);
    el.classList.add(cls || 'out');
    setTimeout(function () { el.remove(); syncBannerOffset(); layout(); }, 300);
    syncBannerOffset();
  }
  function syncBannerOffset() {
    var h = 0, kids = bannersEl.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].classList.contains('out')) continue;
      h += (kids[i].offsetHeight || 0) + 6;
    }
    document.documentElement.style.setProperty('--banner-h', h + 'px');
    var t = topEl.getBoundingClientRect();
    document.documentElement.style.setProperty('--top-h', Math.round(t.bottom + 4) + 'px');
  }

  /* --------------------------------------------------------------- 히스토리 */
  var history = [];
  function addHistory(panel) {
    history.unshift(panel);
    if (history.length > 12) history.length = 12;
    renderHistory();
  }
  function renderHistory() {
    histEl.innerHTML = '';
    for (var i = 0; i < history.length; i++) {
      var p = history[i];
      var li = document.createElement('li');
      li.className = 'rail-item';
      li.dataset.type = TYPE_LABEL[p.type] ? p.type : 'news';
      li.innerHTML = '<span class="b"></span><span class="t">' + clockLabel(p.created_at).slice(0, 5) + '</span>' +
        '<span class="n">' + esc(p.title || tagLabel(p.type)) + '</span>';
      li.title = p.title || tagLabel(p.type);
      (function (panel) {
        li.addEventListener('click', function () {
          if (panel.type === 'alert') showBanner(panel); else pushCard(panel);
        });
      })(p);
      histEl.appendChild(li);
    }
    $('railEmpty').hidden = history.length > 0;
    requestLayout();
  }
  $('btnClear').addEventListener('click', function () {
    var cards = stageEl.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) dismiss(cards[i]);
    history.length = 0;
    renderHistory();
    var bs = bannersEl.querySelectorAll('.banner');
    for (var j = 0; j < bs.length; j++) kill(bs[j]);
  });

  /* ------------------------------------------------------------ 전체화면 보기 */
  function openFocus(panel) {
    focusEl.innerHTML = '<div class="focus-inner"></div>' +
      '<button class="focus-close" type="button" aria-label="닫기">✕</button>';
    var inner = focusEl.querySelector('.focus-inner');
    var card = buildCard(panel, { flat: true });
    card.classList.add('pinned', 'active');
    var bar = card.querySelector('.card-bar');
    if (bar) { bar.style.cursor = 'default'; bar.style.touchAction = 'auto'; }
    var pg = card.querySelector('.card-progress'); if (pg) pg.remove();
    inner.appendChild(card);
    focusEl.hidden = false;
    focusEl.querySelector('.focus-close').addEventListener('click', closeFocus);
    focusEl.addEventListener('click', function (e) { if (e.target === focusEl) closeFocus(); }, { once: true });
  }
  function closeFocus() {
    focusEl.hidden = true;
    focusEl.innerHTML = '';
  }

  /* ------------------------------------------------------- 패널 수신 처리 */
  function receive(panel, source) {
    if (!panel || !panel.type) return;
    var id = panel.id || ('x' + Date.now() + Math.random().toString(16).slice(2));
    panel.id = id;
    if (state.seen.has(id)) return;
    state.seen.add(id);

    state.rx++;
    $('rxCount').textContent = String(state.rx);

    if (source === 'realtime' && panel.created_at) {
      var t = new Date(panel.created_at).getTime();
      if (!isNaN(t)) {
        var lat = (Date.now() - t) / 1000;
        if (lat >= 0 && lat < 120) state.lat = lat;
      }
    }

    addHistory(panel);
    if (locked) { pending.push(panel); if (pending.length > MAX_CARDS) pending.shift(); return; }
    if (panel.type === 'alert') showBanner(panel); else pushCard(panel);
  }

  /* --------------------------------------------------------------- DEMO */
  var DEMO = [
    {
      type: 'news',
      title: '삼성전자, HBM4 양산 라인 투자 확대… 내년 1분기 본격 가동',
      body: '업계에 따르면 평택 P4 라인 일부를 HBM4 전용으로 전환한다는 계획이 확인됐어요. **SK하이닉스**도 6세대 HBM 샘플 공급을 늘리는 중.',
      source: '연합뉴스',
      url: 'https://news.google.com/search?q=HBM4',
      duration: 40
    },
    {
      type: 'youtube',
      title: '임베드 플레이어 동작 확인용 데모 영상',
      body: '유튜브 창은 `videoId` 또는 url 만 넣으면 바로 재생됩니다.',
      url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
      source: 'YouTube',
      duration: 45
    },
    {
      type: 'image',
      title: '이미지 창 — 사진 + 캡션',
      image_url: 'https://picsum.photos/seed/fridayhud/1200/720',
      caption: '이미지는 image_url 한 줄로. 캡션은 caption 필드.',
      source: 'DEMO',
      duration: 40
    },
    {
      type: 'briefing',
      title: '오늘의 브리핑',
      body: '### 일정\n- 09:00 기상 · 아침 브리핑\n- 13:00 학원\n- 22:00 큐브 Sub-30 훈련 20분\n\n### 체크\n- **미적분Ⅰ** p.75~157 1회독\n- 물질과 에너지 보충교재 정리\n- 수면 7시간 확보',
      source: 'FRIDAY',
      duration: 0,
      pinned: true
    },
    {
      type: 'alert',
      title: '기말고사 D-18 · 오늘 할당량 미달',
      body: '미적분Ⅰ 진도 12p 남았습니다. 지금 20분만 채우면 오늘 목표 달성.',
      source: 'FRIDAY',
      duration: 20
    },
    {
      type: 'news',
      title: '수능 2028학년도 개편 — 통합형 수학·선택과목 폐지',
      body: '2028학년도 수능은 수학이 통합형으로 바뀌고 선택과목이 폐지됩니다. **기하·미적분** 진도를 어떻게 가져갈지가 관건.',
      source: '교육부',
      url: 'https://www.moe.go.kr/',
      duration: 45
    }
  ];
  var demoIdx = 0;
  function demoPopup() {
    var base = DEMO[demoIdx % DEMO.length];
    demoIdx++;
    var p = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) p[k] = base[k];
    p.id = 'demo-' + Date.now() + '-' + demoIdx;
    p.created_at = new Date().toISOString();
    receive(p, 'demo');
  }

  /* ------------------------------------------------------------- Supabase */
  var client = null;

  function initSupabase() {
    if (window.__sbLoadFail || !window.supabase || typeof window.supabase.createClient !== 'function') {
      setNet('demo', 'DEMO · SDK 없음');
      return false;
    }
    try {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        realtime: { params: { eventsPerSecond: 20 } }
      });
    } catch (e) {
      setNet('demo', 'DEMO · 연결 실패');
      return false;
    }
    return true;
  }

  function bulkLoad() {
    if (!client) return;
    client.from(TABLE).select('*').order('created_at', { ascending: false }).limit(8)
      .then(function (res) {
        if (res.error) {
          var code = res.error.code || '';
          var msg = String(res.error.message || '');
          if (code === 'PGRST205' || /schema cache/i.test(msg) || code === '42P01') {
            setNet('setup', 'DB SETUP NEEDED');
            toast('Supabase SQL을 실행하면 실시간 연결이 켜집니다');
          } else {
            setNet('off', 'OFFLINE');
          }
          return;
        }
        var rows = (res.data || []).slice();           /* 최신순 */
        var pick = [];
        for (var i = 0; i < rows.length; i++) {
          var age = (Date.now() - new Date(rows[i].created_at).getTime()) / 1000;
          if (pick.length < MAX_CARDS && age >= 0 && age < 24 * 3600) {
            pick.push(rows[i]);
          } else {
            state.seen.add(rows[i].id);
            addHistory(rows[i]);
          }
        }
        /* 오래된 것부터 넣으면 최신이 가장 좋은 자리를 받는다 */
        for (var j = pick.length - 1; j >= 0; j--) receive(pick[j], 'load');
        renderHistory();
        subscribe();
      }, function () { setNet('off', 'OFFLINE'); subscribe(); });
  }

  function subscribe() {
    if (!client) return;
    if (state.channel) { try { client.removeChannel(state.channel); } catch (e) {} state.channel = null; }

    state.channel = client.channel('friday_hud_live', { config: { broadcast: { self: false } } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABLE },
        function (payload) { if (payload && payload.new) receive(payload.new, 'realtime'); })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          setNet('live');
          stopPolling();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setNet('off', 'RECONNECTING');
          startPolling();
        } else if (status === 'CLOSED') {
          setNet('off', 'CLOSED');
          startPolling();
        }
      });
  }

  /* Realtime 이 막힌 환경 대비: 8초 폴링 */
  function startPolling() {
    if (state.pollTimer || !client) return;
    state.pollTimer = setInterval(function () {
      client.from(TABLE).select('*').order('created_at', { ascending: false }).limit(5)
        .then(function (res) {
          if (res.error) return;
          var rows = (res.data || []).slice().reverse();
          for (var i = 0; i < rows.length; i++) receive(rows[i], 'poll');
          if (rows.length && state.net === 'off') setNet('demo', 'ONLINE · POLLING');
        }, function () {});
    }, 8000);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  /* ------------------------------------------------------------- 컨트롤 */
  $('btnDemo').addEventListener('click', function () { demoPopup(); });
  $('btnTidy').addEventListener('click', function () { tidy(); toast('창을 화면 전체에 다시 펼쳤어요'); });
  $('btnSfx').addEventListener('click', function () {
    state.sfx = !state.sfx;
    this.setAttribute('aria-pressed', state.sfx ? 'true' : 'false');
    if (state.sfx) blip(1180, 0.14, 0.05);
  });
  $('btnFull').addEventListener('click', toggleFullscreen);

  function toggleFullscreen() {
    var d = document.documentElement;
    var req = d.requestFullscreen || d.webkitRequestFullscreen;
    var isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFs) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
      return;
    }
    if (req) {
      var p = req.call(d);
      if (p && p.catch) p.catch(function () {
        toast('전체화면이 막혔어요 — 사파리 [공유 → 홈 화면에 추가]로 열면 꽉 찹니다');
      });
    } else {
      toast('이 브라우저는 전체화면 API를 지원하지 않아요. [공유 → 홈 화면에 추가]로 설치해 주세요');
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (locked) {
      var kd = e.key;
      if (!padEl.hidden) {
        if (/^[0-9]$/.test(kd)) onPadKey(kd);
        else if (kd === 'Backspace') onPadKey('back');
        else if (kd === 'Escape') hidePad();
      } else if (kd === 'Enter' || kd === ' ') { showPad(); e.preventDefault(); }
      return;
    }
    var k = e.key.toLowerCase();
    if (k === 'd') { demoPopup(); }
    else if (k === 'f') { toggleFullscreen(); }
    else if (e.key === 'Escape') {
      if (!focusEl.hidden) { closeFocus(); return; }
      var tops = [].slice.call(stageEl.querySelectorAll('.card:not(.out)'))
        .sort(function (a, b) { return (+b.style.zIndex || 0) - (+a.style.zIndex || 0); });
      if (tops.length) dismiss(tops[0]);
    }
  });

  /* ------------------------------------------------------------- 잠금 화면 */
  var PASS_KEY = 'fridayhud.pass';
  var DEFAULT_PASS = '0409';
  function getPass() {
    try { return localStorage.getItem(PASS_KEY) || DEFAULT_PASS; } catch (e) { return DEFAULT_PASS; }
  }
  var lockEl = $('lock'), padEl = $('lockPad'), dotsEl = $('lockDots'), lockCore = $('lockCore');
  var passBuf = '', pressTimer = null;

  function updateDots() {
    var dots = dotsEl.querySelectorAll('i');
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i < passBuf.length);
  }
  function showPad() {
    if (!locked) return;
    lockCore.hidden = true;
    padEl.hidden = false;
    passBuf = ''; updateDots(); dotsEl.classList.remove('bad');
  }
  function hidePad() {
    padEl.hidden = true; lockCore.hidden = false;
    passBuf = ''; updateDots(); dotsEl.classList.remove('bad');
  }
  function flushPending() {
    var list = pending.slice();
    pending.length = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].type === 'alert') showBanner(list[i]); else pushCard(list[i]);
    }
  }
  function unlock() {
    if (!locked) return;
    locked = false;
    lockEl.classList.add('out');
    setTimeout(function () { lockEl.hidden = true; lockEl.classList.remove('out'); }, 420);
    setTimeout(function () { fitClock(); layout(true); }, 460);
    flushPending();
  }
  function lockNow() {
    if (locked) return;
    locked = true;
    lockEl.hidden = false;
    lockEl.classList.remove('out');
    hidePad();
  }
  function checkPass() {
    if (passBuf === getPass()) {
      blip(1320, 0.18, 0.05);
      setTimeout(function () { blip(1760, 0.2, 0.04); }, 100);
      unlock();
    } else {
      dotsEl.classList.add('bad');
      padEl.classList.add('shake');
      setTimeout(function () { padEl.classList.remove('shake'); }, 340);
      setTimeout(function () { passBuf = ''; updateDots(); dotsEl.classList.remove('bad'); }, 520);
    }
  }
  function onPadKey(k) {
    if (k === 'cancel') { hidePad(); return; }
    if (k === 'back') { passBuf = passBuf.slice(0, -1); updateDots(); return; }
    if (passBuf.length >= 4) return;
    passBuf += k;
    updateDots();
    blip(1100, 0.06, 0.03);
    if (passBuf.length === 4) setTimeout(checkPass, 140);
  }
  if (lockEl) {
    lockCore.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    lockCore.addEventListener('pointerdown', function () {
      clearTimeout(pressTimer);
      pressTimer = setTimeout(showPad, 480);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      lockCore.addEventListener(ev, function () { clearTimeout(pressTimer); });
    });
    dotsEl.parentNode.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-k]') : null;
      if (b) onPadKey(b.getAttribute('data-k'));
    });
    padEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ------------------------------------------------------------- 시작 */
  function boot() {
    drawTicks();
    fitClock();
    tickClock();
    setInterval(tickClock, 250);

    syncBannerOffset();
    window.addEventListener('resize', function () {
      fitClock();
      syncBannerOffset();
      requestLayout();
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { fitClock(); syncBannerOffset(); layout(); }, 260);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { fitClock(); requestLayout(); });
    }
    document.addEventListener('pointermove', parallaxMove, { passive: true });

    var params = new URLSearchParams(location.search);
    var demoParam = params.get('demo');

    if (params.get('lock') === '0') { locked = false; lockEl.hidden = true; }

    $('btnLock').addEventListener('click', lockNow);

    if (initSupabase()) {
      setNet('init');
      bulkLoad();
    }

    setTimeout(function () { fitClock(); layout(); }, 400);
    setTimeout(function () { layout(); }, 1400);

    if (demoParam !== null && demoParam !== '0') {
      setTimeout(function () {
        demoPopup();
        state.demoTimer = setInterval(demoPopup, 5200);
      }, 700);
    } else if (!client) {
      setTimeout(function () {
        if (!history.length) demoPopup();
      }, 900);
    }

    /* 탭이 다시 보이면 연결 상태 재확인 */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && client && state.net !== 'live') {
        client.from(TABLE).select('id').limit(1).then(function (res) {
          if (!res.error) subscribe();
        }, function () {});
      }
      if (!document.hidden) { fitClock(); requestLayout(); }
    });

    /* PWA (https 에서만) */
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    /* 디버그용 */
    window.__hud = {
      state: state, demo: demoPopup, receive: receive, setNet: setNet,
      layout: layout, tidy: tidy, slots: function () { return computeSlots(area(), coreSafe(), stageEl.querySelectorAll('.card').length); }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
