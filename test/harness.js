// FRIDAY HUD — 최소 DOM 하네스 (quickjs 로 app.js 로직 스모크 테스트)
var __timers = [], __intervals = [], __log = [];

function makeClassList(el) {
  function set() { return String(el.className || '').split(/\s+/).filter(Boolean); }
  return {
    add: function (c) { var s = set(); if (s.indexOf(c) < 0) s.push(c); el.className = s.join(' '); },
    remove: function (c) { el.className = set().filter(function (x) { return x !== c; }).join(' '); },
    toggle: function (c, on) { var has = set().indexOf(c) >= 0; if (on === undefined) on = !has; if (on) this.add(c); else this.remove(c); return on; },
    contains: function (c) { return set().indexOf(c) >= 0; }
  };
}

function El(tag) {
  this.tagName = String(tag || 'div').toUpperCase();
  this.children = [];
  this.parentNode = null;
  this._html = '';
  this.className = '';
  this.id = '';
  this.dataset = {};
  this.attributes = {};
  this.style = { setProperty: function () {}, animationDuration: '' };
  this.hidden = false;
  this.textContent = '';
  this.offsetHeight = 120;
  this.clientHeight = 600;
  this.clientWidth = 760;
  this._listeners = {};
  this.classList = makeClassList(this);
}
Object.defineProperty(El.prototype, 'innerHTML', {
  get: function () { return this._html; },
  set: function (v) { this._html = String(v); this.children = []; }
});
Object.defineProperty(El.prototype, 'childNodes', { get: function () { return this.children; } });
Object.defineProperty(El.prototype, 'firstChild', { get: function () { return this.children[0] || null; } });
El.prototype.appendChild = function (c) { if (c) { c.parentNode = this; this.children.push(c); } return c; };
El.prototype.insertBefore = function (c, ref) { c.parentNode = this; var i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; };
El.prototype.remove = function () { if (this.parentNode) { var i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } };
El.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); };
El.prototype.getAttribute = function (k) { return this.attributes[k]; };
El.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
El.prototype.dispatch = function (t, ev) { (this._listeners[t] || []).forEach(function (f) { f(ev || { target: this }); }); };
El.prototype.querySelector = function (sel) {
  var m = /^\.([\w-]+)$/.exec(sel);
  if (m) {
    var re = new RegExp('class="[^"]*\\b' + m[1] + '\\b');
    if (re.test(this._html)) { var e = new El('span'); e.className = m[1]; return e; }
    for (var i = 0; i < this.children.length; i++) {
      if (String(this.children[i].className || '').split(/\s+/).indexOf(m[1]) >= 0) return this.children[i];
      var hit = this.children[i].querySelector(sel);
      if (hit) return hit;
    }
  }
  return null;
};
El.prototype.querySelectorAll = function (sel) {
  var m = /^\.([\w-]+)(?::not\(\.([\w-]+)\))?$/.exec(sel);
  var out = [];
  if (!m) return out;
  var want = m[1], not = m[2];
  for (var i = 0; i < this.children.length; i++) {
    var cls = String(this.children[i].className || '').split(/\s+/);
    if (cls.indexOf(want) >= 0 && (!not || cls.indexOf(not) < 0)) out.push(this.children[i]);
  }
  return out;
};

var __ids = ['feed', 'banners', 'history', 'focus', 'tH', 'tM', 'tS', 'date', 'dExam', 'dExamSub',
  'dSuneung', 'dSuneungSub', 'uptime', 'rxCount', 'latency', 'teleState', 'teleSource', 'teleClock',
  'netPill', 'netText', 'connShort', 'btnDemo', 'btnSfx', 'btnFull', 'btnClear', 'railEmpty', 'ticks'];
var __store = {};
__ids.forEach(function (id) { var e = new El('div'); e.id = id; __store[id] = e; });

var document = {
  readyState: 'complete',
  hidden: false,
  documentElement: new El('html'),
  body: new El('body'),
  getElementById: function (id) { return __store[id] || null; },
  querySelector: function (sel) {
    if (sel === '.clock-wrap') { var e = new El('div'); e.className = 'clock-wrap'; return e; }
    if (sel === '.toast') return null;
    return null;
  },
  querySelectorAll: function () { return []; },
  createElement: function (t) { return new El(t); },
  createElementNS: function (ns, t) { return new El(t); },
  createDocumentFragment: function () { return new El('fragment'); },
  addEventListener: function () {}
};
document.documentElement.style.setProperty = function () {};

var window = {};
window.__sbLoadFail = (typeof __SB_OK === 'undefined');
window.addEventListener = function () {};
window.setTimeout = function (fn, ms) { __timers.push({ fn: fn, ms: ms }); return __timers.length; };
window.setInterval = function (fn, ms) { __intervals.push({ fn: fn, ms: ms }); return __intervals.length; };
window.clearTimeout = function () {};
window.clearInterval = function () {};
var navigator = { userAgent: 'test' };
var location = { search: (typeof __SEARCH !== 'undefined' ? __SEARCH : ''), protocol: 'https:', href: 'https://r1axodn.github.io/friday-hud/' };

function setTimeout(fn, ms) { return window.setTimeout(fn, ms); }
function setInterval(fn, ms) { return window.setInterval(fn, ms); }
function clearTimeout() {}
function clearInterval() {}

var Intl = {
  DateTimeFormat: function () {
    this.format = function (d) {
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    };
  }
};
function URLSearchParams(s) {
  var q = String(s || '').replace(/^\?/, '');
  this.get = function (k) {
    var m = new RegExp('(?:^|&)' + k + '=([^&]*)').exec(q);
    return m ? decodeURIComponent(m[1]) : null;
  };
}

__log.push('harness ready');
