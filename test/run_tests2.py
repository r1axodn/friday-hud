import quickjs, pathlib

ROOT = pathlib.Path('/workspace/work/friday-hud')
HARNESS = (ROOT / 'test/harness.js').read_text()
APP = (ROOT / 'app.js').read_text()

ctx = quickjs.Context()
ctx.eval("var __SB_OK = undefined; var __SEARCH = '';")   # SDK 없음 -> 데모 모드
ctx.eval(HARNESS)
ctx.eval(APP)

print('== D) 카드 상한 / 고정 / 자동 닫힘 ==')
print(ctx.eval("""
(function(){
  var t = [];
  function cards(){ return __store.feed.children.length; }

  /* 6장 투입 (duration 1초) */
  for (var i = 0; i < 6; i++) {
    window.__hud.receive({ id:'c'+i, type:'news', title:'카드 '+i, body:'b', duration:1 }, 'demo');
  }
  t.push('6장 투입 후 카드 수=' + cards() + ' (상한 4 기대)');

  /* 첫 카드(최신) 고정 후 2장 더 */
  var top = __store.feed.children[0];
  top.classList.add('pinned');
  for (var j = 0; j < 2; j++) {
    window.__hud.receive({ id:'d'+j, type:'news', title:'추가 '+j, body:'b', duration:1 }, 'demo');
  }
  var stillThere = false;
  for (var k = 0; k < __store.feed.children.length; k++) if (__store.feed.children[k] === top) stillThere = true;
  t.push('고정 카드 유지=' + stillThere + ' / 카드 수=' + cards());

  /* 타이머 실행 (1초 뒤 dismiss -> 300ms 뒤 제거) */
  var ran = 0;
  for (var p = 0; p < __timers.length; p++) { if (__timers[p].ms === 1000) { __timers[p].fn(); ran++; } }
  t.push('1초 타이머 실행=' + ran);
  var removed = 0;
  for (var q = 0; q < __timers.length; q++) { if (__timers[q].ms === 300) { __timers[q].fn(); removed++; } }
  t.push('제거 콜백 실행=' + removed + ' -> 남은 카드=' + cards() + ' (고정 1장만 기대)');

  /* 알림 배너 자동 닫힘 */
  window.__hud.receive({ id:'al', type:'alert', title:'긴급', body:'내용', duration:1 }, 'demo');
  t.push('배너 수=' + __store.banners.children.length);
  for (var r = 0; r < __timers.length; r++) { if (__timers[r].ms === 1000) __timers[r].fn(); }
  for (var s = 0; s < __timers.length; s++) { if (__timers[s].ms === 300) __timers[s].fn(); }
  t.push('배너 자동 닫힘 후=' + __store.banners.children.length);
  return t.join('\\n');
})()
"""))

print('\n== E) 히스토리 클릭 재호출 / 비우기 ==')
print(ctx.eval("""
(function(){
  var t = [];
  t.push('history=' + __store.history.children.length);
  var item = __store.history.children[0];
  var before = __store.feed.children.length;
  item.dispatch('click');
  t.push('히스토리 클릭 후 카드 ' + before + ' -> ' + __store.feed.children.length);
  __store.btnClear.dispatch('click');
  t.push('비우기 후 카드=' + __store.feed.children.length + ' history=' + __store.history.children.length + ' railEmpty.hidden=' + __store.railEmpty.hidden);
  return t.join('\\n');
})()
"""))
