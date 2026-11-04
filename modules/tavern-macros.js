/* 酒馆宏：纯原生解析，赋值与读取分两阶段；不触碰宿主私有状态。 */
(function () {
  'use strict';
  var bridge = window.MyChat;
  if (!bridge) return;
  var previewGlobals = null;
  var own = function (obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); };
  function clean(text) {
    return String(text || '').replace(/\{\{\/\/[\s\S]*?\}\}/g, '').replace(/\s*\{\{\s*trim\s*\}\}\s*/gi, '');
  }
  function expand(text, session, phase) {
    var s = session || {}, source = clean(text), changed = false, globalChanged = false;
    var local = s.tavernVars && typeof s.tavernVars === 'object' && !Array.isArray(s.tavernVars) ? s.tavernVars : {};
    var globals = previewGlobals || bridge.getGlobalTavernVars();
    function read(store, key) { return own(store, key) ? String(store[key]) : ''; }
    function write(store, key, value, global) {
      Object.defineProperty(store, key, { value:String(value), enumerable:true, configurable:true, writable:true });
      if (global) globalChanged = true; else changed = true;
    }
    var out = source.replace(/\{\{\s*((?:set|add|inc|dec)(?:global)?var)\s*::([\s\S]*?)\}\}/gi, function (all, op, args) {
      op = op.toLowerCase();
      var global = op.indexOf('global') !== -1, store = global ? globals : local;
      var at = args.indexOf('::'), name = (at < 0 ? args : args.slice(0, at)).trim();
      var value = at < 0 ? '' : args.slice(at + 2), old = read(store, name), next;
      // 赋值参数允许读取先前模块已设置的变量。
      value = value.replace(/\{\{\s*get(global)?var\s*::([\s\S]*?)\}\}/gi, function (_, g, n) { return read(g ? globals : local, n.trim()); });
      if (op.indexOf('set') === 0) next = value;
      else if (op.indexOf('add') === 0) next = old.trim() !== '' && value.trim() !== '' && Number.isFinite(Number(old)) && Number.isFinite(Number(value)) ? Number(old) + Number(value) : old + value;
      else next = (Number.isFinite(Number(old)) ? Number(old) : 0) + (op.indexOf('inc') === 0 ? 1 : -1);
      write(store, name, next, global);
      return /^(inc|dec)/.test(op) ? String(next) : '';
    });
    if (changed) { s.tavernVars = local; if (!previewGlobals) bridge.saveSession(s, {background:true}); }
    if (globalChanged && !previewGlobals) bridge.saveGlobalTavernVars(globals);
    if (phase === 'assign') return out;
    var messages = (s.messages || []).filter(function (m) { return m && !m._pending; });
    var last = messages[messages.length - 1];
    function lastRole(role) { return messages.slice().reverse().find(function (m) { return m.role === role; }); }
    var now = new Date(), pad = function (v) { return String(v).padStart(2, '0'); };
    var stamp = last && (last.timestamp || last.createdAt), elapsed = stamp ? Math.max(0, Date.now() - new Date(stamp).getTime()) : 0;
    var target = bridge.getActiveTarget() || {}, params = bridge.getSessionParams(s) || {};
    var context = {
      newline:'\n', noop:'', persona:s.userPersona || '', model:target.modelId || '', maxprompt:params.contextLimit == null ? '' : params.contextLimit,
      lastmessage:last ? last.content : '', lastusermessage:(lastRole('user') || {}).content || '', lastcharmessage:(lastRole('assistant') || {}).content || '',
      lastmessageid:messages.length, isodate:now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
      isotime:pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()),
      idle_duration:elapsed < 60000 || !Number.isFinite(elapsed) ? '刚刚' : elapsed < 3600000 ? Math.floor(elapsed / 60000) + '分钟' : elapsed < 86400000 ? Math.floor(elapsed / 3600000) + '小时' : Math.floor(elapsed / 86400000) + '天'
    };
    return out.replace(/\{\{\s*([a-z_]+)\s*(?:(::|:)([\s\S]*?))?\}\}/gi, function (all, name, sep, args) {
      name = name.toLowerCase();
      if (name === 'getvar' || name === 'getglobalvar') return read(name === 'getvar' ? local : globals, String(args || '').trim());
      if (name === 'random' || name === 'pick') {
        var items = String(args || '').split(sep === ':' ? ',' : '::');
        var index;
        if (name === 'pick') {
          var seed = String(s.id || '') + ':' + source.length, hash = 2166136261;
          for (var i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
          index = (hash >>> 0) % items.length;
        } else index = Math.floor(Math.random() * items.length);
        return items[index];
      }
      if (name === 'roll') {
        var dice = String(args || '').trim().match(/^(\d*)d(\d+)$/i);
        if (!dice) return '';
        var count = Number(dice[1] || 1), sides = Number(dice[2]);
        if (count < 1 || count > 10000 || sides < 1 || sides > 1000000000) return '';
        var sum = 0;
        for (var d = 0; d < count; d++) sum += 1 + Math.floor(Math.random() * sides);
        return String(sum);
      }
      return own(context, name) && !sep ? String(context[name]) : all;
    });
  }
  window.MyChatTavernMacros = {
    expand:expand,
    // 同步只读事务：宏赋值只作用于会话副本和临时全局字典。
    withPreview:function (callback) {
      var previous = previewGlobals;
      previewGlobals = JSON.parse(JSON.stringify(previous || bridge.getGlobalTavernVars()));
      try { return callback(); } finally { previewGlobals = previous; }
    },
    preparePreset:function (preset, session) {
      if (!preset || !Array.isArray(preset.modules)) return preset;
      var modules = preset.modules.map(function (m) {
        return Object.assign({}, m, {content:m.enabled === true ? expand(m.content, session, 'assign') : m.content});
      });
      // 所有模块赋值完成后才展开读取；原预设保持不变。
      modules.forEach(function (m) { if (m.enabled === true) m.content = bridge.replaceMacros(m.content, session); });
      return Object.assign({}, preset, {modules:modules});
    }
  };
  bridge.registerHook('beforeSend', function (messages, context) {
    if (!Array.isArray(messages)) return;
    return messages.map(function (msg) {
      return Object.assign({}, msg, {content:bridge.replaceMacros(msg.content, context && context.session)});
    });
  });
})();
