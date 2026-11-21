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

  var ddayCfg = { d1: null, d2: null };  /* 인증 후 서버(hud_settings)에서만 로드 */

  var TYPE_LABEL = { news: 'NEWS', youtube: 'VIDEO', image: 'IMAGE', briefing: 'BRIEFING', alert: 'ALERT' };

  /* 코어 상태 행: hud_panels 스키마를 그대로 쓰기 위한 표식 (type=alert, source=__CORE_STATE__) */
  var CORE_SRC = '__CORE_STATE__';
  var CORE_TTL = 180000;                 /* 작업 중 갱신이 3분 없으면 idle 로 복귀 */

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

  var HUD_AUTH_EMAIL = 'friday-hud@r1axodn.local';

  /* 잠금 상태 (인증 확인 전까지 대시보드 DOM 생성/데이터 fetch/구독 일절 금지) */
  var locked = true;
  var dashboardMounted = false;
  var authBusy = false;
  var pending = [];

  /* ---------------------------------------------------------------- view */
  var stageEl = null;
  var bannersEl = null;
  var histEl = null;
  var focusEl = null;
  var topEl = null;
  var bottomEl = null;

  var zTop = 100;
  var seq = 0;

  /* --------------------------------------------------------------- 시간 */
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  var SEC_RING_LEN = 2 * Math.PI * 161;      /* r=161 */

  function tickClock() {
    var now = new Date();
    var lt = $('lockTime'), ld = $('lockDate');
    if (lt) lt.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
    if (ld) ld.textContent = now.getFullYear() + '.' + pad(now.getMonth() + 1) + '.' + pad(now.getDate()) +
      ' (' + WEEK[now.getDay()] + ')';

    if (!dashboardMounted) return;

    $('tH').textContent = pad(now.getHours());
    $('tM').textContent = pad(now.getMinutes());
    $('tS').textContent = pad(now.getSeconds());
    $('date').textContent = now.getFullYear() + '.' + pad(now.getMonth() + 1) + '.' + pad(now.getDate()) +
      ' (' + WEEK[now.getDay()] + ')';
    var key = dateKey(now);

    /* 초침 링 */
    var sr = $('secRing');
    if (sr) sr.style.strokeDashoffset = (SEC_RING_LEN * (1 - (now.getSeconds() + now.getMilliseconds() / 1000) / 60)).toFixed(1);

    var d1 = ddayCfg.d1, d2 = ddayCfg.d2;
    if (d1) {
      var e = dday(d1.date, key);
      $('dExamLabel').textContent = d1.label;
      $('dExam').textContent = e.text;
      $('dExam').className = 'stat-v ' + e.tone;
      $('dExamSub').textContent = d1.sub || d1.date.replace(/-/g, '.');
    }
    if (d2) {
      var s = dday(d2.date, key);
      $('dSuneungLabel').textContent = d2.label;
      $('dSuneung').textContent = s.text;
      $('dSuneung').className = 'stat-v ' + s.tone;
      $('dSuneungSub').textContent = d2.sub || d2.date.replace(/-/g, '.');
    }

    /* 코어 하단: 가장 가까운 일정 */
    var nx = $('coreNext');
    if (nx) {
      if (d1 && dayDiff(key, d1.date) >= 0) {
        var e1 = dday(d1.date, key);
        nx.innerHTML = 'NEXT <b>' + esc(e1.text) + '</b> ' + esc(d1.label) + ' · ' + esc(d1.date.replace(/-/g, '.'));
      } else if (d2) {
        var e2 = dday(d2.date, key);
        nx.innerHTML = 'NEXT <b>' + esc(e2.text) + '</b> ' + esc(d2.label) + ' · ' + esc(d2.date.replace(/-/g, '.'));
      } else {
        nx.textContent = 'SYSTEM ONLINE';
      }
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
    if (!dashboardMounted || !topEl) return;
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

  /* ==================================================================
     가운데 코어 상태 — 피클이 뒤에서 "작업 중"일 때의 반응
     · 푸시: p_source=__CORE_STATE__ 인 alert 행 (p_title=working|idle, p_body=문구)
     · 창·상단 배너·히스토리에는 쌓지 않고 코어만 바꾼다
     · 3분 넘게 갱신이 없으면 안전장치로 스스로 idle
     ================================================================== */
  var core = { state: 'idle', msg: '', at: 0, timer: null };

  function coreWatch() {
    clearTimeout(core.timer);
    core.timer = null;
    if (core.state !== 'working') return;
    var left = CORE_TTL - (Date.now() - core.at);
    if (left <= 0) { setCoreState('idle'); return; }   /* 오래된 working → idle */
    core.timer = setTimeout(coreWatch, Math.min(left, CORE_TTL) + 400);
  }

  function renderCore() {
    var on = core.state === 'working';
    document.body.classList.toggle('is-working', on);
    var msg = $('coreStatusMsg');
    if (msg) msg.textContent = core.msg || '작업 중';
    var pill = $('corePill');
    if (pill) pill.hidden = !on;
    var btn = $('btnCore');
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setCoreState(next, msg, atMs) {
    var s = next === 'working' ? 'working' : 'idle';
    var t = (typeof atMs === 'number' && !isNaN(atMs)) ? atMs : Date.now();
    if (t > Date.now() + 5000) t = Date.now();         /* 기기 시계 오차 보정 */
    core.state = s;
    core.msg = s === 'working' ? String(msg == null ? '' : msg).trim() : '';
    core.at = t;
    renderCore();
    coreWatch();
  }

  function isCoreState(panel) {
    return String((panel && panel.source) || '') === CORE_SRC;
  }

  function applyCore(panel) {
    var s = String(panel.title == null ? '' : panel.title).trim().toLowerCase();
    if (s !== 'working' && s !== 'idle') return false;
    var t = panel.created_at ? new Date(panel.created_at).getTime() : NaN;
    setCoreState(s, panel.body, isNaN(t) ? Date.now() : t);
    return true;
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
    /* 음성 대화 기록 창이 하단 계기 띠 위에 뜨도록 */
    if (bottomEl) {
      document.documentElement.style.setProperty('--bottom-h', Math.round(bottomEl.offsetHeight) + 'px');
    }
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

    /* 코어 상태 행은 창도 배너도 히스토리도 아님 — 가운데 코어만 전환 */
    if (isCoreState(panel)) { applyCore(panel); return; }

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
      body: '### 일정\n- 09:00 모닝 브리핑\n- 14:00 집중 블록\n- 20:00 리캡\n\n### 체크\n- 오늘 목표 3건 점검\n- 미확인 알림 정리',
      source: 'FRIDAY',
      duration: 0,
      pinned: true
    },
    {
      type: 'alert',
      title: '시스템 알림 · 샘플 배너',
      body: '긴급 알림 배너가 상단에 어떻게 표시되는지 미리 보는 샘플입니다.',
      source: 'FRIDAY',
      duration: 20
    },
    {
      type: 'news',
      title: '실시간 HUD 카드 샘플',
      body: '인증된 세션에서만 **Supabase Realtime**을 통해 카드가 실시간으로 표시됩니다.',
      source: 'SYSTEM',
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
          if (isCoreState(rows[i])) { state.seen.add(rows[i].id); continue; }  /* 코어 상태 행은 창이 아니다 */
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
        loadCoreState();
        subscribe();
      }, function () { setNet('off', 'OFFLINE'); subscribe(); });
  }

  /* 페이지를 열었을 때: 가장 최근 __CORE_STATE__ 가 있으면 창 없이 코어 상태만 되살린다 */
  function loadCoreState() {
    if (!client) return;
    client.from(TABLE).select('*').eq('source', CORE_SRC)
      .order('created_at', { ascending: false }).limit(1)
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) return;
        var row = res.data[0];
        state.seen.add(row.id);
        applyCore(row);
      }, function () {});
  }

  function loadSettings() {
    if (!client) return;
    client.from('hud_settings').select('dday_1_label,dday_1_date,dday_1_sub,dday_2_label,dday_2_date,dday_2_sub')
      .limit(1)
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) return;
        var r = res.data[0];
        ddayCfg.d1 = { label: r.dday_1_label, date: r.dday_1_date, sub: r.dday_1_sub };
        ddayCfg.d2 = { label: r.dday_2_label, date: r.dday_2_date, sub: r.dday_2_sub };
        tickClock();
      }, function () {});
  }

  function subscribe() {
    if (!client) return;
    if (state.channel) { try { client.removeChannel(state.channel); } catch (e) {} state.channel = null; }

    state.channel = client.channel('friday_hud_live', { config: { private: true, broadcast: { self: false } } })
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
  function bindDashboardControls() {
    $('btnClear').addEventListener('click', function () {
      var cards = stageEl.querySelectorAll('.card');
      for (var i = 0; i < cards.length; i++) dismiss(cards[i]);
      history.length = 0;
      renderHistory();
      var bs = bannersEl.querySelectorAll('.banner');
      for (var j = 0; j < bs.length; j++) kill(bs[j]);
    });
    $('btnDemo').addEventListener('click', function () { demoPopup(); });
    $('btnCore').addEventListener('click', function () {
      /* DB 를 건드리지 않는 미리보기 토글 */
      if (core.state === 'working') {
        setCoreState('idle');
        toast('코어 · 평상시 상태');
      } else {
        setCoreState('working', '자료 찾는 중...');
        toast('코어 · 작업 중 상태 미리보기 (3분 뒤 자동 복귀)');
      }
    });
    $('btnTidy').addEventListener('click', function () { tidy(); toast('창을 화면 전체에 다시 펼쳤어요'); });
    $('btnSfx').addEventListener('click', function () {
      state.sfx = !state.sfx;
      this.setAttribute('aria-pressed', state.sfx ? 'true' : 'false');
      if (state.sfx) blip(1180, 0.14, 0.05);
    });
    $('btnFull').addEventListener('click', toggleFullscreen);
    $('btnLock').addEventListener('click', lockNow);
  }

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
        if (kd === 'Escape') hidePad();
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

  /* ------------------------------------------------------------- 잠금 화면 (Supabase Auth 서버 검증) */
  var lockEl = $('lock'), padEl = $('lockPad'), lockCore = $('lockCore');
  var lockForm = $('lockForm'), lockPass = $('lockPass'), lockCancel = $('lockCancel');
  var pressTimer = null;

  var DASHBOARD_HTML = '' +
    '<div class="bg" aria-hidden="true">' +
      '<div class="bg-grid"></div><div class="bg-sweep"></div><div class="bg-rings"></div>' +
      '<div class="bg-scan"></div><div class="bg-vignette"></div>' +
    '</div>' +
    '<header class="top">' +
      '<div class="brand">' +
        '<svg class="logo" viewBox="0 0 44 44" aria-hidden="true">' +
          '<circle cx="22" cy="22" r="20" fill="none" stroke="currentColor" stroke-opacity=".28" stroke-width="1.2"/>' +
          '<circle cx="22" cy="22" r="14" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-width="1.2" stroke-dasharray="10 6"/>' +
          '<circle cx="22" cy="22" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
          '<circle cx="22" cy="22" r="2.2" fill="currentColor"/>' +
          '<path d="M22 2v6M22 36v6M2 22h6M36 22h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
        '</svg>' +
        '<div class="brand-txt">' +
          '<h1>FRIDAY<span class="brand-sub">HUD</span></h1>' +
          '<p>personal heads-up display <span class="sep">//</span> <span id="connShort">link</span></p>' +
        '</div>' +
      '</div>' +
      '<div class="top-actions">' +
        '<div class="pill work" id="corePill" title="피클이 지금 뒤에서 작업 중입니다" hidden>' +
          '<span class="dot" aria-hidden="true"></span><span id="corePillText">WORKING</span>' +
        '</div>' +
        '<div class="pill" id="netPill" title="실시간 연결 상태">' +
          '<span class="dot" aria-hidden="true"></span><span id="netText">CONNECTING</span>' +
        '</div>' +
        '<button class="btn" id="btnTidy" type="button" title="창을 화면 전체에 다시 펼치기">TIDY</button>' +
        '<button class="btn" id="btnDemo" type="button">DEMO POPUP</button>' +
        '<button class="btn ghost" id="btnCore" type="button" aria-pressed="false" title="가운데 코어의 작업 중 상태를 미리 보기 (누를 때마다 작업 중 ↔ 평상시)">CORE TEST</button>' +
        '<button class="btn ghost" id="btnSfx" type="button" aria-pressed="false" title="알림음 켜기/끄기">SFX</button>' +
        '<button class="btn ghost" id="btnFull" type="button" title="전체화면 (아이패드: 화면 꽉 채우기)">FULL</button>' +
        '<button class="btn ghost" id="btnLock" type="button" title="잠그기">LOCK</button>' +
      '</div>' +
    '</header>' +
    '<div class="core" id="core">' +
      '<div class="core-rings" aria-hidden="true">' +
        '<svg viewBox="0 0 400 400">' +
          '<g id="ticks"></g>' +
          '<circle class="ring thin" cx="200" cy="200" r="191"></circle>' +
          '<circle class="ring arc a1" cx="200" cy="200" r="176"></circle>' +
          '<circle class="ring sec" id="secRing" cx="200" cy="200" r="161" transform="rotate(-90 200 200)"></circle>' +
          '<circle class="ring dash" cx="200" cy="200" r="142"></circle>' +
          '<circle class="ring arc a2" cx="200" cy="200" r="118"></circle>' +
          '<circle class="ring faint" cx="200" cy="200" r="88"></circle>' +
          '<circle class="ring arc a3" cx="200" cy="200" r="62"></circle>' +
        '</svg>' +
      '</div>' +
      '<div class="core-body">' +
        '<div class="core-tag"><i class="live" aria-hidden="true"></i>FRIDAY CORE<span class="sep">//</span><span id="coreLink">LINK</span></div>' +
        '<div class="clock">' +
          '<div class="time" id="time" aria-label="현재 시각"><span id="tH">--</span><i class="colon">:</i><span id="tM">--</span><i class="colon">:</i><span id="tS">--</span></div>' +
          '<div class="date" id="date">—</div>' +
        '</div>' +
        '<div class="core-foot" id="coreNext">NEXT —</div>' +
        '<div class="core-status-wrap">' +
          '<div class="core-status" id="coreStatus" aria-live="polite">' +
            '<span class="cs-dot" aria-hidden="true"></span><b>WORKING</b><span class="cs-sep" aria-hidden="true">·</span><span class="cs-msg" id="coreStatusMsg">작업 중</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<span class="core-mark m1" aria-hidden="true"></span><span class="core-mark m2" aria-hidden="true"></span>' +
      '<span class="core-mark m3" aria-hidden="true"></span><span class="core-mark m4" aria-hidden="true"></span>' +
    '</div>' +
    '<div class="stage" id="stage" aria-live="polite" aria-label="실시간 패널"></div>' +
    '<div class="bottom" id="bottom">' +
      '<div class="stats" id="stats">' +
        '<div class="stat"><span class="stat-k" id="dExamLabel">SLOT 1</span><b class="stat-v" id="dExam">—</b><span class="stat-s" id="dExamSub">—</span></div>' +
        '<div class="stat"><span class="stat-k" id="dSuneungLabel">SLOT 2</span><b class="stat-v" id="dSuneung">—</b><span class="stat-s" id="dSuneungSub">—</span></div>' +
        '<div class="stat"><span class="stat-k">SESSION</span><b class="stat-v mono" id="uptime">00:00:00</b><span class="stat-s">uptime</span></div>' +
        '<div class="stat"><span class="stat-k">RX</span><b class="stat-v mono" id="rxCount">0</b><span class="stat-s">panels received</span></div>' +
        '<div class="stat"><span class="stat-k">LATENCY</span><b class="stat-v mono" id="latency">—</b><span class="stat-s">push → screen</span></div>' +
      '</div>' +
      '<section class="voice" id="voiceBar" aria-label="피클 음성 대화">' +
        '<div class="voice-head"><span class="vh-id">VOICE LINK</span><span class="vh-sep" aria-hidden="true">//</span>' +
          '<span class="vh-state" id="vState"><i class="vh-dot" aria-hidden="true"></i><b id="vStateTxt">대기</b></span></div>' +
        '<button class="mic" id="btnMic" type="button" aria-pressed="false" title="누르고 있는 동안 말하세요 — 손을 떼면 전송">' +
          '<span class="mic-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="9" y="2.6" width="6" height="11" rx="3"/><path d="M5.5 11.4a6.5 6.5 0 0 0 13 0M12 17.9v3.5M9 21.4h6"/></svg></span>' +
          '<span class="mic-txt" id="micTxt">HOLD TO TALK</span>' +
        '</button>' +
        '<p class="voice-line" id="vLine">마이크를 길게 누르고 말하면 피클이 듣고, 답을 소리로 읽어 줍니다</p>' +
        '<div class="voice-actions">' +
          '<button class="btn tiny ghost" id="btnText" type="button" title="음성 인식이 안 될 때 텍스트로 입력">입력</button>' +
          '<button class="btn tiny ghost" id="btnTts" type="button" aria-pressed="true" title="피클의 답을 소리로 읽기">🔊 읽기</button>' +
          '<button class="btn tiny ghost" id="btnVlog" type="button" aria-pressed="false" title="대화 기록 펼치기 (V)">LOG</button>' +
          '<a class="btn tiny call" id="btnCall" href="pickle://call" title="피클 앱 음성 통화를 바로 겁니다">📞 지금 통화</a>' +
        '</div>' +
      '</section>' +
      '<form class="voice-in" id="vForm" hidden autocomplete="off">' +
        '<input id="vInput" type="text" enterkeyhint="send" maxlength="600" placeholder="여기에 말을 적고 Enter — 예: 오늘 일정 알려줘" aria-label="피클에게 보낼 말">' +
        '<button class="btn tiny" id="vSend" type="submit">보내기</button>' +
        '<button class="btn tiny ghost" id="vCancel" type="button">닫기</button>' +
      '</form>' +
      '<section class="rail">' +
        '<div class="rail-head"><span>RECENT FEED</span><button class="mini" id="btnClear" type="button">비우기</button></div>' +
        '<ul class="rail-list" id="history"></ul>' +
        '<p class="rail-empty" id="railEmpty">아직 받은 패널이 없어요 · <b>DEMO POPUP</b> 으로 미리 볼 수 있어요</p>' +
      '</section>' +
      '<footer class="foot">' +
        '<div class="tele"><span id="teleState">SYSTEM READY</span><span class="tele-sep">|</span>' +
          '<span id="teleSource">SUPABASE · vipaohlgodyrbjnsewuo</span><span class="tele-sep">|</span><span id="teleClock">—</span></div>' +
        '<div class="hint">창 제목줄 끌어 옮기기 · 우하단 모서리로 크기 조절 · <kbd>D</kbd> 데모 · <kbd>F</kbd> 전체화면 · <kbd>ESC</kbd> 닫기</div>' +
      '</footer>' +
    '</div>';

  var OVERLAYS_HTML = '' +
    '<div class="vlog" id="vlog" hidden aria-label="음성 대화 기록">' +
      '<div class="vlog-head"><span>VOICE LOG</span><span class="vlog-sub">나 ↔ FRIDAY</span>' +
        '<button class="icon-btn" id="btnVlogClose" type="button" aria-label="닫기">✕</button></div>' +
      '<ul class="vlog-list" id="vlogList"></ul>' +
      '<p class="vlog-empty" id="vlogEmpty">아직 대화가 없어요 · 마이크를 길게 눌러 말해 보세요</p>' +
    '</div>' +
    '<div class="banners" id="banners" aria-live="assertive"></div>' +
    '<div class="focus" id="focus" hidden></div>';

  function mountDashboard() {
    if (dashboardMounted) return;
    var hudEl = $('hud');
    var ovEl = $('overlays');
    hudEl.innerHTML = DASHBOARD_HTML;
    hudEl.hidden = false;
    ovEl.innerHTML = OVERLAYS_HTML;

    stageEl = $('stage');
    bannersEl = $('banners');
    histEl = $('history');
    focusEl = $('focus');
    topEl = document.querySelector('.top');
    bottomEl = $('bottom');
    dashboardMounted = true;

    drawTicks();
    tickClock();
    fitClock();
    renderCore();
    syncBannerOffset();
    bindDashboardControls();
    vInitVoice();
  }

  function unmountDashboard() {
    if (state.channel && client) { try { client.removeChannel(state.channel); } catch (e) {} state.channel = null; }
    if (V.sub && client) { try { client.removeChannel(V.sub); } catch (e) {} V.sub = null; }
    stopPolling();
    if (V.pollTimer) { clearInterval(V.pollTimer); V.pollTimer = null; }
    if (state.demoTimer) { clearInterval(state.demoTimer); state.demoTimer = null; }

    dashboardMounted = false;
    ddayCfg = { d1: null, d2: null };
    state.seen.clear();
    state.pinned.clear();
    state.rx = 0;
    history.length = 0;
    pending.length = 0;

    var hudEl = $('hud');
    var ovEl = $('overlays');
    if (hudEl) { hudEl.innerHTML = ''; hudEl.hidden = true; }
    if (ovEl) { ovEl.innerHTML = ''; }
    stageEl = bannersEl = histEl = focusEl = topEl = bottomEl = null;
  }

  function showPad() {
    if (!locked) return;
    lockCore.hidden = true;
    padEl.hidden = false;
    if (lockPass) { lockPass.value = ''; lockPass.classList.remove('bad'); setTimeout(function () { try { lockPass.focus(); } catch (e) {} }, 40); }
  }
  function hidePad() {
    padEl.hidden = true; lockCore.hidden = false;
    if (lockPass) { lockPass.value = ''; lockPass.classList.remove('bad'); }
  }
  function flushPending() {
    var list = pending.slice();
    pending.length = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].type === 'alert') showBanner(list[i]); else pushCard(list[i]);
    }
  }
  function unlockWithSession() {
    if (!locked) return;
    locked = false;
    mountDashboard();
    lockEl.classList.add('out');
    setTimeout(function () { lockEl.hidden = true; lockEl.classList.remove('out'); }, 420);
    setTimeout(function () { fitClock(); layout(true); }, 460);
    setNet('init');
    loadSettings();
    bulkLoad();
    vProbe();
    flushPending();
  }
  function lockNow() {
    if (locked) return;
    locked = true;
    if (client && client.auth) { try { client.auth.signOut(); } catch (e) {} }
    unmountDashboard();
    lockEl.hidden = false;
    lockEl.classList.remove('out');
    hidePad();
  }
  function failPass() {
    if (lockPass) lockPass.classList.add('bad');
    padEl.classList.add('shake');
    setTimeout(function () { padEl.classList.remove('shake'); }, 340);
    setTimeout(function () {
      if (lockPass) { lockPass.value = ''; lockPass.classList.remove('bad'); try { lockPass.focus(); } catch (e) {} }
    }, 520);
  }
  function checkPass() {
    if (authBusy) return;
    var pw = lockPass ? lockPass.value : '';
    if (!pw || !client || !client.auth) { failPass(); return; }
    authBusy = true;
    client.auth.signInWithPassword({ email: HUD_AUTH_EMAIL, password: pw })
      .then(function (res) {
        authBusy = false;
        if (res && res.data && res.data.session) {
          blip(1320, 0.18, 0.05);
          setTimeout(function () { blip(1760, 0.2, 0.04); }, 100);
          unlockWithSession();
        } else {
          failPass();
        }
      }, function () {
        authBusy = false;
        failPass();
      });
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
    if (lockForm) lockForm.addEventListener('submit', function (e) { e.preventDefault(); checkPass(); });
    if (lockCancel) lockCancel.addEventListener('click', hidePad);
    padEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ==================================================================
     VOICE LINK — 마이크로 말하고, 피클의 답을 소리로 듣는다
     · 발화 : Web Speech API(ko-KR) → RPC voice_say  (HUD 쪽은 익명)
     · 답   : hud_voice INSERT(role='pickle') Realtime 구독 → 화면 + speechSynthesis
     · 통화 : pickle://call 딥링크로 피클 앱 음성 통화
     · 읽기 정책상 사용자 발화는 anon 으로 읽히지 않고, 내 답만 공개된다
     ================================================================== */
  var VDEV_KEY = 'fridayhud.vdev';
  var VLOG_KEY = 'fridayhud.vlog';
  var VTTS_KEY = 'fridayhud.tts';
  var VMAX_TURN = 60;

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var V = {
    tts: true,
    supported: !!SR,
    unlocked: false,
    dbReady: false,
    listening: false,
    holding: false,
    stopping: false,
    finishing: false,
    sent: false,
    hadErr: false,
    rec: null,
    finalText: '',
    interim: '',
    restarts: 0,
    sending: false,
    speaking: false,
    queue: [],
    turns: [],
    seen: new Set(),
    lastAt: 0,
    waitTimer: null,
    pollTimer: null,
    sub: null
  };

  var voiceBar = null;
  var vLineEl = null;
  var vStateTxt = null;
  var btnMic = null;
  var micTxt = null;
  var btnTts = null;
  var btnVlog = null;
  var vlogEl = null;
  var vlogList = null;
  var vlogEmpty = null;
  var vForm = null;
  var vInput = null;
  var vlogOpen = false;
  var vKeyBound = false;

  function vBindDom() {
    voiceBar = $('voiceBar');
    vLineEl = $('vLine');
    vStateTxt = $('vStateTxt');
    btnMic = $('btnMic');
    micTxt = $('micTxt');
    btnTts = $('btnTts');
    btnVlog = $('btnVlog');
    vlogEl = $('vlog');
    vlogList = $('vlogList');
    vlogEmpty = $('vlogEmpty');
    vForm = $('vForm');
    vInput = $('vInput');
  }

  /* ---- 상태 표시 ---- */
  function vStatus(kind, text) {
    if (!voiceBar) return;
    voiceBar.classList.remove('listening', 'speaking', 'err');
    if (kind === 'listening' || kind === 'speaking' || kind === 'err') voiceBar.classList.add(kind);
    if (vStateTxt) vStateTxt.textContent = text || '대기';
  }
  function vShow(text, role) {
    if (!vLineEl) return;
    vLineEl.textContent = String(text == null ? '' : text);
    if (role) vLineEl.dataset.role = role; else vLineEl.removeAttribute('data-role');
  }

  function vDevice() {
    var d = '';
    try { d = localStorage.getItem(VDEV_KEY) || ''; } catch (e) {}
    if (!d) {
      d = 'hud-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem(VDEV_KEY, d); } catch (e) {}
    }
    return d;
  }

  function vTime(ms) {
    var d = new Date(ms || Date.now());
    if (isNaN(d.getTime())) d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---- 대화 기록 ---- */
  function vLoad() {
    try {
      var raw = localStorage.getItem(VLOG_KEY);
      if (raw) {
        var arr = JSON.parse(raw);
        if (arr && arr.length) V.turns = arr.slice(-VMAX_TURN);
      }
    } catch (e) { V.turns = []; }
    for (var i = 0; i < V.turns.length; i++) {
      var t = V.turns[i];
      if (t.id) V.seen.add(t.id);
      if (t.at > V.lastAt) V.lastAt = t.at;
    }
  }
  function vSave() {
    try { localStorage.setItem(VLOG_KEY, JSON.stringify(V.turns.slice(-VMAX_TURN))); } catch (e) {}
  }
  function vAddTurn(role, text, at, id) {
    var t = {
      role: role === 'pickle' ? 'pickle' : 'user',
      text: String(text == null ? '' : text).trim(),
      at: (typeof at === 'number' && !isNaN(at)) ? at : Date.now(),
      id: id || null
    };
    if (!t.text) return null;
    V.turns.push(t);
    if (V.turns.length > VMAX_TURN) V.turns.shift();
    if (t.id) V.seen.add(t.id);
    if (t.at > V.lastAt) V.lastAt = t.at;
    vSave();
    vRenderLog();
    return t;
  }
  function vRenderLog() {
    if (!vlogList) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < V.turns.length; i++) {
      var t = V.turns[i];
      var li = document.createElement('li');
      li.className = 'vlog-item';
      li.dataset.role = t.role;
      var who = document.createElement('span');
      who.className = 'vlog-who';
      who.textContent = (t.role === 'pickle' ? 'FRIDAY' : '나') + ' · ' + vTime(t.at);
      var tx = document.createElement('span');
      tx.className = 'vlog-t';
      tx.textContent = t.text;
      li.appendChild(who);
      li.appendChild(tx);
      frag.appendChild(li);
    }
    vlogList.innerHTML = '';
    vlogList.appendChild(frag);
    if (vlogEmpty) vlogEmpty.hidden = V.turns.length > 0;
    if (vlogOpen) vlogList.scrollTop = vlogList.scrollHeight;
  }
  function vToggleLog(force) {
    vlogOpen = (typeof force === 'boolean') ? force : !vlogOpen;
    if (!vlogEl) return;
    vlogEl.hidden = !vlogOpen;
    if (btnVlog) btnVlog.setAttribute('aria-pressed', vlogOpen ? 'true' : 'false');
    if (vlogOpen) {
      vRenderLog();
      vlogList.scrollTop = vlogList.scrollHeight;
      syncBannerOffset();
    }
  }

  /* ---- 소리 읽기 (TTS) ---- */
  function vPlain(s) {
    return String(s == null ? '' : s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
      .replace(/[*_`#>]+/g, '')
      .replace(/^\s*[-•]\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function vKoVoice() {
    var S = window.speechSynthesis;
    if (!S || !S.getVoices) return null;
    var vs = S.getVoices() || [], best = null;
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      if (String(v.lang || '').toLowerCase().indexOf('ko') !== 0) continue;
      if (!best) best = v;
      if (/yuna|sora|google|premium|enhanced/i.test(v.name || '')) best = v;
    }
    return best;
  }
  function vSpeak(text) {
    var S = window.speechSynthesis, U = window.SpeechSynthesisUtterance;
    if (!S || !U) return;
    var t = vPlain(text);
    if (!t) return;
    if (t.length > 600) t = t.slice(0, 600) + '…';
    var u = new U(t);
    u.lang = 'ko-KR';
    var vo = vKoVoice();
    if (vo) u.voice = vo;
    u.rate = 1;
    u.pitch = 1;
    u.volume = 1;
    u.onstart = function () { V.speaking = true; vStatus('speaking', '읽는 중'); };
    u.onend = function () {
      V.speaking = false;
      if (!V.listening && !V.queue.length) vStatus('idle', '대기');
      vPump();
    };
    u.onerror = function () {
      V.speaking = false;
      if (!V.listening) vStatus('idle', '대기');
      vPump();
    };
    V.queue.push(u);
    vPump();
  }
  function vPump() {
    var S = window.speechSynthesis;
    if (!S || V.speaking || !V.queue.length) return;
    var u = V.queue.shift();
    try { S.speak(u); } catch (e) { V.speaking = false; }
  }
  function vStopSpeaking() {
    V.queue.length = 0;
    V.speaking = false;
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
  /* iOS 사파리: 사용자 제스처 안에서 첫 speak 를 해 둬야 이후 답을 읽어 준다 */
  function vUnlockAudio() {
    if (V.unlocked) return;
    V.unlocked = true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        actx = actx || new AC();
        if (actx.state === 'suspended' && actx.resume) {
          var pr = actx.resume();
          if (pr && pr.catch) pr.catch(function () {});
        }
      }
    } catch (e) {}
    try {
      var S = window.speechSynthesis, U = window.SpeechSynthesisUtterance;
      if (S && U) {
        var u = new U(' ');
        u.volume = 0;
        u.lang = 'ko-KR';
        S.speak(u);
      }
    } catch (e) {}
  }

  /* ---- 발화 보내기 ---- */
  function vArmWait() {
    clearTimeout(V.waitTimer);
    V.waitTimer = setTimeout(function () {
      if (V.listening || V.sending) return;
      vStatus('idle', '답 대기');
    }, 20000);
  }

  function vSend(text) {
    text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!text) return;
    vAddTurn('user', text);
    vShow('“' + text + '”', 'user');
    if (!client) {
      vStatus('err', 'DB 없음');
      vShow('DB 연결이 없어 보내지 못했어요 — 데모 모드', 'err');
      return;
    }
    V.sending = true;
    vStatus('idle', '보내는 중');
    client.rpc('voice_say', { p_text: text, p_lang: 'ko-KR', p_device: vDevice() })
      .then(function (res) {
        V.sending = false;
        if (res && res.error) {
          var m = String(res.error.message || res.error);
          vStatus('err', '전송 실패');
          vShow(/voice_say|schema cache|PGRST2|does not exist/i.test(m)
            ? '음성 DB가 아직 없어요 — supabase/hud_voice.sql 을 한 번 실행해 주세요'
            : '전송 실패: ' + m, 'err');
          return;
        }
        V.dbReady = true;
        vStatus('idle', '답 기다리는 중');
        vShow('피클에게 전했어요 — 답이 오면 여기에 뜨고 소리로 읽어 줍니다', 'user');
        vArmWait();
      }, function (err) {
        V.sending = false;
        vStatus('err', '전송 실패');
        vShow('전송 실패: ' + ((err && err.message) || '연결 오류'), 'err');
      });
  }

  /* ---- 피클의 답이 도착했을 때 ---- */
  function vOnReply(row) {
    if (!row || row.role !== 'pickle' || !row.text) return;
    var at = row.created_at ? new Date(row.created_at).getTime() : Date.now();
    if (isNaN(at)) at = Date.now();
    if (row.id && V.seen.has(row.id)) return;
    if (!row.id && at <= V.lastAt) return;
    clearTimeout(V.waitTimer);
    vAddTurn('pickle', row.text, at, row.id);
    vShow(row.text, 'pickle');
    vStatus('speaking', '답 도착');
    blip(1240, 0.16, 0.045);
    setTimeout(function () { blip(1660, 0.2, 0.035); }, 95);
    if (V.tts) vSpeak(row.text);
    else { vStatus('idle', '대기'); vToggleLogBlink(); }
  }
  function vToggleLogBlink() {
    if (!btnVlog) return;
    btnVlog.classList.add('pinned');
    setTimeout(function () { btnVlog.classList.remove('pinned'); }, 2200);
  }

  /* ---- 음성 인식 (누르고 말하기) ---- */
  function vNewRec() {
    if (!SR) return null;
    var r;
    try { r = new SR(); } catch (e) { return null; }
    r.lang = 'ko-KR';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = function () {
      V.listening = true;
      V.restarts = 0;
      btnMic.setAttribute('aria-pressed', 'true');
      vStatus('listening', '듣는 중');
    };
    r.onresult = function (e) {
      var interim = '';
      try {
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var res = e.results[i];
          var txt = res[0] ? res[0].transcript : '';
          if (res.isFinal) {
            var add = String(txt || '').trim();
            if (add) V.finalText += (V.finalText ? ' ' : '') + add;
          } else interim += txt;
        }
      } catch (err) {}
      V.interim = interim;
      var live = (V.finalText + ' ' + interim).replace(/\s+/g, ' ').trim();
      if (live) vShow(live, 'user');
    };
    r.onerror = function (e) {
      var code = String((e && e.error) || '');
      if (code === 'no-speech') return;      /* 조용했을 뿐 — 계속 듣는다 */
      if (code === 'aborted') return;
      V.hadErr = true;
      V.holding = false;
      V.stopping = true;
      var msg = {
        'not-allowed': '마이크 권한이 꺼져 있어요 — 아이패드 설정 → 앱 → 마이크를 켜 주세요',
        'service-not-allowed': '음성 인식을 쓸 수 없어요 — 설정 → Siri 및 받아쓰기를 켜 주세요',
        'audio-capture': '마이크를 잡지 못했어요 — 다른 앱이 쓰고 있는지 확인해 주세요',
        'network': '음성 인식 서버에 연결되지 않았어요 — [입력]으로 적어 주세요'
      }[code] || ('음성 인식 오류: ' + code);
      vStatus('err', '오류');
      vShow(msg, 'err');
      btnMic.setAttribute('aria-pressed', 'false');
      btnMic.classList.remove('on');
    };
    r.onend = function () {
      V.listening = false;
      btnMic.setAttribute('aria-pressed', 'false');
      /* 손을 떼지 않았는데 브라우저가 문장마다 끊는 경우(iOS) — 이어서 다시 */
      if (V.holding && !V.stopping && V.restarts < 8) {
        V.restarts++;
        try { r.start(); return; } catch (e) {}
      }
      if (V.holding) V.holding = false;
      vFinish();
    };
    return r;
  }

  function vStart() {
    if (V.holding) return;
    vUnlockAudio();
    if (!SR) {
      vStatus('err', '미지원');
      vShow('이 브라우저는 음성 인식을 지원하지 않아요 — [입력]으로 적으면 피클에게 갑니다', 'err');
      vOpenText();
      return;
    }
    if (V.speaking) vStopSpeaking();
    V.holding = true;
    V.stopping = false;
    V.finishing = false;
    V.sent = false;
    V.hadErr = false;
    V.finalText = '';
    V.interim = '';
    V.restarts = 0;
    if (!V.rec) V.rec = vNewRec();
    if (!V.rec) {
      V.holding = false;
      vStatus('err', '미지원');
      vShow('음성 인식을 시작하지 못했어요 — [입력]으로 적어 주세요', 'err');
      vOpenText();
      return;
    }
    btnMic.classList.add('on');
    vStatus('listening', '듣는 중');
    vShow('듣고 있어요 — 말을 마치면 손을 떼세요', 'user');
    try {
      V.rec.start();
    } catch (e) {
      /* 이미 돌고 있던 경우: 멈추고 잠깐 뒤 다시 */
      try { V.rec.stop(); } catch (e2) {}
      setTimeout(function () {
        if (!V.holding) return;
        try { V.rec.start(); } catch (e3) {
          V.holding = false;
          vStatus('err', '오류');
          vShow('마이크를 다시 시작하지 못했어요 — 한 번 더 눌러 보세요', 'err');
        }
      }, 220);
    }
  }

  function vStop() {
    if (!V.holding) return;
    V.holding = false;
    V.stopping = true;
    try { if (V.rec) V.rec.stop(); } catch (e) {}
    btnMic.classList.remove('on');
    btnMic.setAttribute('aria-pressed', 'false');
    if (!V.hadErr) vStatus('idle', '정리 중');
    /* onend 가 끝내 오지 않는 브라우저 대비 */
    setTimeout(function () {
      if (!V.listening && !V.sent) vFinish();
    }, 900);
  }

  function vFinish() {
    if (V.finishing || V.sent) return;
    V.finishing = true;
    setTimeout(function () { V.finishing = false; }, 60);
    var text = (V.finalText + ' ' + V.interim).replace(/\s+/g, ' ').trim();
    V.interim = '';
    V.stopping = true;
    V.listening = false;
    btnMic.setAttribute('aria-pressed', 'false');
    btnMic.classList.remove('on');
    if (text) {
      V.sent = true;
      vSend(text);
      return;
    }
    if (!V.hadErr) {
      vStatus('idle', '대기');
      vShow('아무 말도 들리지 않았어요 — 다시 길게 눌러 말해 주세요', 'err');
    }
  }

  function vOpenText() {
    if (!vForm) return;
    vForm.hidden = false;
    try { vInput.focus(); } catch (e) {}
    syncBannerOffset();
  }
  function vCloseText() {
    if (vForm) vForm.hidden = true;
    syncBannerOffset();
  }

  /* ---- Supabase 연결 (답 구독 + 폴링 폴백) ---- */
  function vProbe() {
    if (!client) return;
    client.from('hud_voice').select('id').limit(1).then(function (res) {
      if (res.error) {
        V.dbReady = false;
        vStatus('err', 'DB 없음');
        vShow('음성 DB가 아직 없어요 — supabase/hud_voice.sql 을 한 번 실행해 주세요', 'err');
        return;
      }
      V.dbReady = true;
      vLoadRecent();
      vSubscribe();
      vStartPoll();
    }, function () {});
  }

  function vLoadRecent() {
    if (!client) return;
    client.from('hud_voice')
      .select('id,created_at,role,text')
      .eq('role', 'pickle')
      .order('created_at', { ascending: false })
      .limit(12)
      .then(function (res) {
        if (res.error || !res.data) return;
        var rows = res.data.slice().reverse();
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (!r || !r.text || (r.id && V.seen.has(r.id))) continue;
          vAddTurn('pickle', r.text, new Date(r.created_at).getTime(), r.id);
        }
        vSave();
      }, function () {});
  }

  function vSubscribe() {
    if (!client || V.sub) return;
    try {
      V.sub = client.channel('friday_voice', { config: { private: true } })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'hud_voice' },
          function (payload) { if (payload && payload.new) vOnReply(payload.new); })
        .subscribe();
    } catch (e) { V.sub = null; }
  }

  function vStartPoll() {
    if (V.pollTimer || !client) return;
    V.pollTimer = setInterval(function () {
      if (document.hidden || !V.dbReady) return;
      client.from('hud_voice')
        .select('id,created_at,role,text')
        .eq('role', 'pickle')
        .order('created_at', { ascending: false })
        .limit(5)
        .then(function (res) {
          if (res.error || !res.data) return;
          var rows = res.data.slice().reverse();
          for (var i = 0; i < rows.length; i++) vOnReply(rows[i]);
        }, function () {});
    }, 15000);
  }

  /* ---- 버튼 ---- */
  function vInitVoice() {
    vBindDom();
    if (!voiceBar) return;

    try { if (localStorage.getItem(VTTS_KEY) === '0') V.tts = false; } catch (e) {}
    if (btnTts) btnTts.setAttribute('aria-pressed', V.tts ? 'true' : 'false');

    vLoad();
    vRenderLog();
    vStatus('idle', '대기');

    if (!V.supported) {
      btnMic.classList.add('unsupported');
      if (micTxt) micTxt.textContent = 'TEXT';
      vStatus('err', '음성 미지원');
      vShow('이 브라우저는 음성 인식을 지원하지 않아요 — [입력]으로 적으면 피클에게 전달됩니다', 'err');
    }

    /* 마이크 — 누르고 있는 동안만 듣는다 */
    btnMic.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    btnMic.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      vStart();
    });
    btnMic.addEventListener('pointerup', function (e) { e.preventDefault(); vStop(); });
    btnMic.addEventListener('pointercancel', function () { vStop(); });
    btnMic.addEventListener('pointerleave', function () { if (V.holding) vStop(); });
    btnMic.addEventListener('touchstart', function (e) { e.preventDefault(); vStart(); }, { passive: false });
    btnMic.addEventListener('touchend', function (e) { e.preventDefault(); vStop(); }, { passive: false });
    btnMic.addEventListener('touchcancel', function () { vStop(); });

    if (btnTts) btnTts.addEventListener('click', function () {
      vUnlockAudio();
      V.tts = !V.tts;
      btnTts.setAttribute('aria-pressed', V.tts ? 'true' : 'false');
      try { localStorage.setItem(VTTS_KEY, V.tts ? '1' : '0'); } catch (e) {}
      if (!V.tts) vStopSpeaking();
      toast(V.tts ? '답을 소리로 읽습니다' : '소리 읽기 꺼짐 — 화면에만 표시');
    });

    if (btnVlog) btnVlog.addEventListener('click', function () { vToggleLog(); });
    var btnVlogClose = $('btnVlogClose');
    if (btnVlogClose) btnVlogClose.addEventListener('click', function () { vToggleLog(false); });

    var btnText = $('btnText');
    if (btnText) btnText.addEventListener('click', function () {
      if (vForm && vForm.hidden) vOpenText(); else vCloseText();
    });
    var vCancel = $('vCancel');
    if (vCancel) vCancel.addEventListener('click', function () { vCloseText(); });
    if (vForm) vForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = vInput ? vInput.value.trim() : '';
      if (!text) { vCloseText(); return; }
      if (vInput) vInput.value = '';
      vUnlockAudio();
      vSend(text);
    });

    var btnCall = $('btnCall');
    if (btnCall) btnCall.addEventListener('click', function () {
      vUnlockAudio();
      /* pickle://call 은 앵커 그대로 동작. 앱이 없으면 사파리가 안내한다 */
    });

    /* 첫 터치에서 오디오 잠금 해제 (iOS) */
    voiceBar.addEventListener('pointerdown', function () { vUnlockAudio(); });

    /* 데스크톱 확인용 키: M 누르고 말하기, V 대화 기록 (한 번만 바인딩) */
    if (!vKeyBound) {
      vKeyBound = true;
      document.addEventListener('keydown', function (e) {
        if (locked || !dashboardMounted || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
        var tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        var k = String(e.key || '').toLowerCase();
        if (k === 'v') { vToggleLog(); }
        else if (k === 'm') { vStart(); }
      });
      document.addEventListener('keyup', function (e) {
        if (locked || !dashboardMounted) return;
        var tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (String(e.key || '').toLowerCase() === 'm') vStop();
      });

      if (window.speechSynthesis) {
        try {
          window.speechSynthesis.addEventListener('voiceschanged', function () { vPump(); });
        } catch (e) {}
      }
    }

    /* 디버그 훅 */
    window.__hudVoice = {
      state: V,
      send: vSend,
      reply: vOnReply,
      speak: vSpeak,
      log: vToggleLog,
      probe: vProbe,
      turns: function () { return V.turns.slice(); },
      supported: V.supported
    };
  }

  /* ------------------------------------------------------------- 시작 */
  function boot() {
    tickClock();
    setInterval(tickClock, 250);

    window.addEventListener('resize', function () {
      if (!dashboardMounted) return;
      fitClock();
      syncBannerOffset();
      requestLayout();
    });
    window.addEventListener('orientationchange', function () {
      if (!dashboardMounted) return;
      setTimeout(function () { fitClock(); syncBannerOffset(); layout(); }, 260);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        if (!dashboardMounted) return;
        fitClock();
        requestLayout();
      });
    }
    document.addEventListener('pointermove', function (e) {
      if (!dashboardMounted) return;
      parallaxMove(e);
    }, { passive: true });

    /* 인증 확인 전까지 어떠한 데이터 fetch / 구독 / 대시보드 렌더링도 수행하지 않는다 */
    if (initSupabase() && client.auth) {
      client.auth.getSession().then(function (res) {
        var session = res && res.data && res.data.session;
        if (session && session.user) {
          unlockWithSession();
        }
      }, function () {});
    }

    /* 탭이 다시 보이면 인증된 세션이 풀려 있을 때만 연결 상태 재확인 */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !locked && dashboardMounted && client && state.net !== 'live') {
        client.from(TABLE).select('id').limit(1).then(function (res) {
          if (!res.error) subscribe();
        }, function () {});
      }
      if (!document.hidden && dashboardMounted) { coreWatch(); fitClock(); requestLayout(); }
    });

    /* PWA (https 에서만) */
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    /* 디버그용 (인증 후에만 동작) */
    window.__hud = {
      state: state,
      isLocked: function () { return locked; },
      demo: function () { if (dashboardMounted) demoPopup(); },
      receive: receive, setNet: setNet,
      core: core,
      coreStatus: function (s, msg) { if (dashboardMounted) setCoreState(s, msg); },
      layout: function () { if (dashboardMounted) layout(); },
      tidy: function () { if (dashboardMounted) tidy(); }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
