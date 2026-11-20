import quickjs, pathlib

ROOT = pathlib.Path('/workspace/work/friday-hud')
ctx = quickjs.Context()
ctx.eval("var __SB_OK = undefined; var __SEARCH = '';")
ctx.eval((ROOT / 'test/harness.js').read_text())
ctx.eval((ROOT / 'app.js').read_text())

print(ctx.eval("""
(function(){
  var t = [];
  window.__hud.receive({ id:'h1', type:'news', title:'히스토리 테스트', body:'b', duration:3 }, 'demo');
  t.push('cards after receive=' + __store.feed.children.length);
  t.push('history children=' + __store.history.children.length);
  var li = __store.history.children[0];
  t.push('li className=' + li.className + ' listeners=' + JSON.stringify(Object.keys(li._listeners || {})));
  try {
    li.dispatch('click');
    t.push('dispatch ok, cards=' + __store.feed.children.length);
  } catch (e) {
    t.push('dispatch error: ' + e);
  }
  return t.join('\\n');
})()
"""))
