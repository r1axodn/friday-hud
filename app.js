/* ==========================================================================
   FRIDAY HUD — app.js
   · 실시간 시계 / D-DAY / 텔레메트리
   · Supabase Realtime(INSERT) → 카드 팝업 (news · youtube · image · briefing · alert)
   · 연결이 없어도 ?demo=1 또는 DEMO POPUP 으로 연출 확인 가능
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------- config */
  var SUPABASE_URL = 'https://vipaohlgodyrbjnsewuo.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_pl28DHu3fwfqU-Nw92hyPg_nLcdeJaS';
  var TABLE = 'hud_panels';
  var MAX_CARDS = 6;

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
  var feedEl = $('feed');
  var bannersEl = $('banners');
  var histEl = $('history');
  var focusEl = $('focus');

  /* ---- 시계 ---- */
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  function tickClock() {
    var now = new Date();
    $('tH').textContent = pad(now.getHours());
    $('tM').textContent = pad(now.getMinutes());
    $('tS').textContent = pad(now.getSeconds());
    $('date').textContent = now.getFullYear() + '.' + pad(now.getMonth() + 1) + '.' + pad(now.getDate()) +
      ' (' + WEEK[now.getDay()] + ')';
    var key = dateKey(now);
    $('lockTime').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
    $('lockDate').textContent = now.getFullYear() + '.' + pad(now.getMonth() + 1) + '.' + pad(now.getDate()) +
      ' (' + WEEK[now.getDay()] + ')';
    var e = dday(EXAM_START, key);
    $('dExam').textContent = e.text;
    $('dExam').className = 'stat-v ' + e.tone;
    var s = dday(SUNEUNG, key);
    $('dSuneung').textContent = s.text;
    $('dSuneung').className = 'stat-v ' + s.tone;
    $('uptime').textContent = hhmmss(Date.now() - state.start);
    $('teleClock').textContent = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
      ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    if (state.lat != null) {
      $('latency').textContent = state.lat.toFixed(2) + 's';
      $('latency').className = 'stat-v mono' + (state.lat < 0.5 ? ' hot' : '');
    }
  }

  /* ---- 시계 크기 맞추기 ---- */
  function fitClock() {
    var wrap = document.querySelector('.clock-wrap');
    if (!wrap) return;
    var h = wrap.clientHeight || 0, w = wrap.clientWidth || 0;
    var base = Math.min(h, w);
    var size = Math.max(24, Math.min(base * 0.128, 108));
    document.documentElement.style.setProperty('--clk', size.toFixed(1) + 'px');

    /* 세로 모드: 팝업 시트가 D-DAY 줄을 가리지 않도록 그 위에 띄움 */
    var st = document.querySelector('.stats');
    if (st) {
      var top = st.getBoundingClientRect().top;
      var clear = Math.round(window.innerHeight - top + 16);
      if (clear > 40 && clear < window.innerHeight * 0.6) {
        document.documentElement.style.setProperty('--sheet-bottom', clear + 'px');
      }
    }
  }

  /* ---- 링 눈금 ---- */
  function drawTicks() {
    var g = $('ticks');
    if (!g || g.childNodes.length) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 60; i++) {
      var a = (i * 6 - 90) * Math.PI / 180;
      var big = i % 5 === 0;
      var r1 = 184, r2 = big ? 172 : 178;
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

  /* --------------------------------------------------------- 카드 만들기 */
  function tagLabel(t) { return TYPE_LABEL[t] || 'PANEL'; }
  function clockLabel(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function buildCard(panel) {
    var type = TYPE_LABEL[panel.type] ? panel.type : 'news';
    var el = document.createElement('article');
    el.className = 'card';
    el.dataset.type = type;
    el.dataset.id = panel.id || ('x' + Date.now());

    var src = panel.source ? '<span class="card-src">' + esc(panel.source) + '</span>' : '';
    var head = '<div class="card-head">' +
      '<span class="tag">' + tagLabel(type) + '</span>' + src +
      '<span class="card-time">' + clockLabel(panel.created_at) + '</span></div>';

    var html = head;
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
    } else if (type === 'briefing') {
      html += title;
      if (panel.body) html += '<div class="card-body">' + mdLite(panel.body) + '</div>';
    } else {
      /* news · alert */
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
    foot += '<div class="card-actions">' +
      '<button class="icon-btn act-expand" type="button" title="전체화면으로 보기" aria-label="전체화면으로 보기">⤢</button>' +
      '<button class="icon-btn act-pin" type="button" title="고정 (자동으로 사라지지 않게)" aria-label="고정" aria-pressed="false">◈</button>' +
      '<button class="icon-btn act-close" type="button" title="닫기" aria-label="닫기">✕</button>' +
      '</div></div>';

    el.innerHTML = html + foot;

    /* 동작 */
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
      } else {
        state.pinned.delete(el.dataset.id);
      }
    });

    return el;
  }

  function scheduleDismiss(el, panel) {
    var dur = panel && panel.duration != null ? Number(panel.duration) : 25;
    if (panel && panel.pinned) dur = 0;
    clearTimeout(el._timer);
    var pg = el.querySelector('.card-progress');
    if (!dur || dur <= 0) {
      if (pg) pg.remove();
      return;
    }
    if (!pg) {
      pg = document.createElement('div');
      pg.className = 'card-progress';
      el.appendChild(pg);
    }
    pg.style.animationDuration = dur + 's';
    el._timer = setTimeout(function () { dismiss(el); }, dur * 1000);
  }

  function dismiss(el) {
    if (!el || el.classList.contains('out')) return;
    clearTimeout(el._timer);
    el.style.setProperty('--h', (el.offsetHeight + 9) + 'px');
    el.classList.add('out');
    setTimeout(function () { if (el.parentNode) el.remove(); }, 300);
  }

  /* 사용자가 위쪽을 보고 있을 때만 맨 위로 (임베드 로드 등으로 스크롤이 밀리는 것 방지) */
  function keepTop() {
    if (feedEl.scrollTop < 60) feedEl.scrollTop = 0;
  }

  function capCards() {
    var cards = feedEl.querySelectorAll('.card:not(.pinned)');
    if (cards.length > MAX_CARDS) {
      for (var i = MAX_CARDS; i < cards.length; i++) dismiss(cards[i]);
    }
    /* 고정 카드도 너무 쌓이면 오래된 것부터 정리 (전체 6장 상한) */
    var all = feedEl.querySelectorAll('.card');
    if (all.length > MAX_CARDS + 2) {
      for (var j = MAX_CARDS + 2; j < all.length; j++) dismiss(all[j]);
    }
  }

  /* ------------------------------------------------------------ 카드 띄우기 */
  function pushCard(panel) {
    var el = buildCard(panel);
    if (state.pinned.has(el.dataset.id)) {
      el.classList.add('pinned');
      var pb = el.querySelector('.act-pin');
      if (pb) { pb.classList.add('pinned'); pb.setAttribute('aria-pressed', 'true'); }
    }
    feedEl.insertBefore(el, feedEl.firstChild);
    keepTop();                               /* 새 카드가 항상 보이도록 */
    capCards();
    setTimeout(keepTop, 350);
    setTimeout(keepTop, 1200);
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
    keepTop();
    var dur = panel.duration != null ? Number(panel.duration) : 25;
    if (dur > 0) el._timer = setTimeout(function () { kill(el, 'out'); }, dur * 1000);
    blip(660, 0.22, 0.05);
    return el;
  }
  function kill(el, cls) {
    clearTimeout(el._timer);
    el.classList.add(cls || 'out');
    setTimeout(function () { el.remove(); syncBannerOffset(); }, 300);
    syncBannerOffset();
  }
  /* 배너가 떠 있는 동안 카드 영역이 가려지지 않게 위쪽 여백 확보 + 헤더는 가리지 않기 */
  function syncBannerOffset() {
    var h = 0, kids = bannersEl.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].classList.contains('out')) continue;
      h += (kids[i].offsetHeight || 0) + 6;
    }
    document.documentElement.style.setProperty('--banner-h', h + 'px');
    var topEl = document.querySelector('.top');
    if (topEl) {
      var bottom = topEl.getBoundingClientRect().bottom;
      document.documentElement.style.setProperty('--top-h', Math.round(bottom + 4) + 'px');
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
  }
  $('btnClear').addEventListener('click', function () {
    var cards = feedEl.querySelectorAll('.card');
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
    var card = buildCard(panel);
    card.classList.add('pinned');
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
      duration: 25
    },
    {
      type: 'youtube',
      title: '임베드 플레이어 동작 확인용 데모 영상',
      body: '유튜브 카드는 `videoId` 또는 url 만 넣으면 바로 재생됩니다. (카드를 누르면 플레이어가 켜집니다)',
      url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
      source: 'YouTube',
      duration: 30
    },
    {
      type: 'image',
      title: '이미지 카드 — 사진 + 캡션',
      image_url: 'https://picsum.photos/seed/fridayhud/1200/720',
      caption: '이미지는 image_url 한 줄로. 캡션은 caption 필드.',
      source: 'DEMO',
      duration: 25
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
        /* 오래된 것부터 넣으면 최신이 맨 위에 온다 */
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
      if (!focusEl.hidden) closeFocus();
      else {
        var first = feedEl.querySelector('.card');
        if (first) dismiss(first);
      }
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
    setTimeout(fitClock, 460);
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
    setTimeout(fitClock, 400);
    syncBannerOffset();
    window.addEventListener('resize', function () { fitClock(); syncBannerOffset(); });
    window.addEventListener('orientationchange', function () { setTimeout(function () { fitClock(); syncBannerOffset(); }, 250); });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitClock);

    var params = new URLSearchParams(location.search);
    var demoParam = params.get('demo');

    if (params.get('lock') === '0') { locked = false; lockEl.hidden = true; }

    $('btnLock').addEventListener('click', lockNow);

    if (initSupabase()) {
      setNet('init');
      bulkLoad();
    }

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
    });

    /* PWA (https 에서만) */
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    /* 디버그용 */
    window.__hud = { state: state, demo: demoPopup, receive: receive, setNet: setNet };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
