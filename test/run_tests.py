import quickjs, pathlib

ROOT = pathlib.Path('/workspace/work/friday-hud')
HARNESS = (ROOT / 'test/harness.js').read_text()
APP = (ROOT / 'app.js').read_text()

BOOT_FAKE = r"""
var __mode='ok'; var __rows=[]; var __calls=[]; var __insertHandlers=[]; var __subscribeCb=null;
function fakeBuilder(){
  var b = {
    select: function(){ __calls.push('select'); return b; },
    order: function(){ __calls.push('order'); return b; },
    limit: function(){ __calls.push('limit'); return b; },
    then: function(f, r){
      __calls.push('then');
      if (__mode === 'missing') { f({ data: null, error: { code: 'PGRST205', message: 'Could not find the table in the schema cache' } }); }
      else if (__mode === 'netfail') { r(new Error('network')); }
      else { f({ data: __rows, error: null }); }
      return b;
    }
  };
  return b;
}
window.supabase = { createClient: function(){
  __calls.push('createClient');
  return {
    from: function(){ __calls.push('from'); return fakeBuilder(); },
    channel: function(){
      __calls.push('channel');
      return { on: function(e,f,cb){ __calls.push('on'); __insertHandlers.push(cb); return this; },
               subscribe: function(cb){ __calls.push('subscribe'); __subscribeCb = cb; return this; } };
    },
    removeChannel: function(){ return Promise.resolve(); }
  };
}};
"""


def make_ctx(search='', mode='ok', rows='[]'):
    ctx = quickjs.Context()
    ctx.eval("var __SB_OK = true; var __SEARCH = '';")
    ctx.eval(HARNESS)
    ctx.eval("var __SEARCH2 = 1;")
    ctx.eval(BOOT_FAKE)
    ctx.eval("__mode = %r; __rows = %s;" % (mode, rows))
    ctx.eval(APP)
    return ctx


print('== A) table missing -> setup state ==')
ctx = make_ctx(mode='missing')
print(ctx.eval("JSON.stringify({calls:__calls.slice(0,6), net:__store.netText.textContent, tele:__store.teleState.textContent, cards:__store.feed.children.length})"))

print('\n== B) rows load + realtime insert ==')
ctx = make_ctx(mode='ok', rows="""[
  { id:'a1', created_at: new Date(Date.now()-120000).toISOString(), type:'news', title:'지난 뉴스', body:'요약' },
  { id:'a2', created_at: new Date(Date.now()-30000).toISOString(), type:'briefing', title:'최근 브리핑', body:'- 항목' }
]""")
print(ctx.eval("""
(function(){
  var t = [];
  t.push('after load: cards=' + __store.feed.children.length + ' history=' + __store.history.children.length + ' net=' + __store.netText.textContent);
  if (__subscribeCb) { __subscribeCb('SUBSCRIBED'); }
  t.push('after SUBSCRIBED: net=' + __store.netText.textContent + ' | tele=' + __store.teleState.textContent);
  if (__insertHandlers.length) {
    __insertHandlers[0]({ new: { id:'r1', created_at:new Date(Date.now()-180).toISOString(), type:'news', title:'실시간 뉴스', body:'바로 뜸', source:'테스트' } });
  }
  t.push('after INSERT: cards=' + __store.feed.children.length + ' rx=' + __store.rxCount.textContent + ' lat=' + __store.latency.textContent);
  t.push('top card is realtime: ' + (__store.feed.children[0].innerHTML.indexOf('실시간 뉴스') >= 0));
  __subscribeCb('CHANNEL_ERROR');
  t.push('after CHANNEL_ERROR: net=' + __store.netText.textContent + ' polling=' + (window.__hud.state.pollTimer ? 'on' : 'off'));
  return t.join('\\n');
})()
"""))

print('\n== C) ?demo=1 auto demo ==')
ctx2 = quickjs.Context()
ctx2.eval("var __SB_OK = undefined; var __SEARCH = '?demo=1';")
ctx2.eval(HARNESS)
ctx2.eval(APP)
print(ctx2.eval("""
(function(){
  var t = [];
  t.push('search=' + location.search + ' net=' + __store.netText.textContent);
  /* 예약된 타이머 실행 (데모 시작) */
  for (var i = 0; i < __timers.length; i++) { if (__timers[i].ms === 700) __timers[i].fn(); }
  t.push('after 700ms timer: cards=' + __store.feed.children.length + ' intervals=' + __intervals.length);
  return t.join('\\n');
})()
"""))
