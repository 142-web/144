/* 外部对话导入：本地纯解析，完全成功后通过宿主批量追加；不注册消息处理钩子。
 * 依赖 MyChat 桥接；不直接读取存储、不请求网络。第三方保持原白名单，本机扩展恢复完整副本。
 */
(function () {
  'use strict';
  var MAX = 128 * 1024 * 1024;
  function fail(text) { throw new Error(text); }
  function json(text) { try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { fail('文件格式错误'); } }
  function time(value) {
    var n = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(n) ? (n > 0 && n < 100000000000 ? n * 1000 : n) : undefined;
  }
  function text(value) { return typeof value === 'string' ? value : ''; }
  function body(m) {
    var content = [], reasoning = [];
    if (Array.isArray(m.contentParts)) {
      m.contentParts.forEach(function (p) {
        if (!p || typeof p !== 'object') return;
        if (p.type === 'text') content.push(text(p.text));
        if (p.type === 'reasoning' || p.type === 'thinking') reasoning.push(text(p.text || p.reasoning || p.content));
      });
    } else content.push(text(m.content));
    var extra = text(m.reasoningContent || m.reasoning);
    if (extra && reasoning.indexOf(extra) < 0) reasoning.push(extra);
    return { content: content.join(''), reasoning: reasoning.filter(Boolean).join('\n\n') };
  }
  function chatboxSession(s, index) {
    if (!s || !Array.isArray(s.messages)) fail('会话格式错误');
    var systems = [];
    function convert(list, collectedSystems) {
      if (!Array.isArray(list)) fail('消息格式错误');
      var out = [];
      list.forEach(function (m) {
        if (!m || typeof m !== 'object') fail('消息格式错误');
        var b = body(m);
        if (m.role === 'system') { if (b.content.trim()) collectedSystems.push(b.content); return; }
        if (m.role !== 'user' && m.role !== 'assistant') return;
        if (!b.content && !b.reasoning) return;
        out.push({ role: m.role, content: b.content, reasoning: b.reasoning, timestamp: time(m.timestamp || m.createdAt) });
      });
      return out;
    }
    var subs = [{ title: text(s.threadName) || '主对话', messages: convert(s.messages, systems), updatedAt: time(s.updatedAt) }];
    if (s.threads !== undefined && !Array.isArray(s.threads)) fail('子对话格式错误');
    (s.threads || []).forEach(function (t, i) {
      var threadSystems = [];
      subs.push({ title: text(t.name || t.title) || '子对话 ' + (i + 1), messages: convert(t.messages, threadSystems), updatedAt: time(t.updatedAt || t.createdAt) });
      // 主对话优先；仅在缺失时采用首个非空线程，避免系统提示跨线程重复。
      if (!systems.length && threadSystems.length) systems = threadSystems;
    });
    return { title: text(s.name || s.title) || '导入对话 ' + (index + 1), system: systems.join('\n\n'), subChats: subs, updatedAt: time(s.updatedAt || s.createdAt) };
  }
  function parseChatbox(value) {
    var list = Array.isArray(value) ? value : value && value.sessions !== undefined ? value.sessions : [value];
    if (list && !Array.isArray(list) && typeof list === 'object') list = Object.keys(list).map(function (key) { return list[key]; });
    if (!Array.isArray(list) || !list.length) fail('未找到对话');
    return list.map(chatboxSession);
  }
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function settingsSnapshot(session) {
    var settings = clone(session);
    ['id', 'messages', 'subChats', 'memoryData', 'activeSubChatId'].forEach(function (key) { delete settings[key]; });
    return settings;
  }
  function exportSessionToTavernJsonl(session, subChat) {
    if (!session || typeof session !== 'object') fail('未找到对话');
    var subs = Array.isArray(session.subChats) ? session.subChats : [];
    var selected = typeof subChat === 'string' ? subs.find(function (sub) { return sub.id === subChat; }) : subChat;
    if (subChat && (!selected || subs.indexOf(selected) < 0)) fail('未找到子对话');
    selected = selected || subs.find(function (sub) { return sub.id === session.activeSubChatId; }) || subs[0] || session;
    if (!Array.isArray(selected.messages)) fail('消息格式错误');
    var userName = text(session.userName) || '用户', characterName = text(session.charName) || '助手';
    function date(value) { return Number.isFinite(value) ? new Date(value).toISOString() : new Date(0).toISOString(); }
    var header = {
      user_name: userName, character_name: characterName, create_date: date(session.createdAt || session.updatedAt),
      chat_metadata: { _mychat_session_meta: { title: session.title || '', memoryData: clone(selected.memoryData), settingsSnapshot: settingsSnapshot(session) } },
      _mychat_ext: { version: 1, type: 'session', session: clone(session), subChatId: selected === session ? null : selected.id }
    };
    return [JSON.stringify(header)].concat(selected.messages.map(function (msg, index) {
      var messageId = msg.id == null ? 'msg_' + index : msg.id;
      var extra = { reasoning: text(msg.reasoning) || text(msg.nativeReasoning), presetThinking: text(msg.presetThinking) || text(msg.tagReasoning), _mychat_msg_id: messageId };
      var row = { name: text(msg.name) || (msg.role === 'user' ? userName : characterName), is_user: msg.role === 'user',
        is_system: msg.is_system === true || msg.role === 'system', send_date: date(msg.timestamp), mes: text(msg.content),
        extra: extra, presetThinking: extra.presetThinking, _mychat_msg_id: messageId,
        _mychat_ext: { version: 1, type: 'message', message: clone(msg) } };
      if (Array.isArray(msg.swipes) && msg.swipes.length) {
        row.swipes = msg.swipes.map(function (swipe) { return typeof swipe === 'string' ? swipe : text(swipe.content); });
        row.swipe_id = Number.isInteger(msg.swipeIndex) ? Math.max(0, Math.min(row.swipes.length - 1, msg.swipeIndex)) : 0;
        row.swipe_info = msg.swipes.map(function (swipe) { return { send_date: date(swipe.timestamp), extra: { reasoning: text(swipe.reasoning) || text(swipe.nativeReasoning), presetThinking: text(swipe.presetThinking) || text(swipe.tagReasoning) } }; });
      } else { row.swipes = [row.mes]; row.swipe_id = 0; }
      return JSON.stringify(row);
    })).join('\n') + '\n';
  }
  function downloadSession(session, subChat) {
    try {
      var source = exportSessionToTavernJsonl(session, subChat);
      var url = URL.createObjectURL(new Blob([source], { type: 'application/x-ndjson;charset=utf-8' }));
      var link = document.createElement('a'); link.href = url;
      var subs = Array.isArray(session.subChats) ? session.subChats : [];
      var selected = typeof subChat === 'string' ? subs.find(function (sub) { return sub.id === subChat; }) : subChat;
      selected = selected || subs.find(function (sub) { return sub.id === session.activeSubChatId; }) || subs[0];
      link.download = ((text(session.title) || '对话') + '_' + (selected && text(selected.title) || '主对话')).replace(/[\\/:*?"<>|]/g, '_') + '.jsonl';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return true;
    } catch (err) { window.MyChat.showToast(err.message || '导出失败'); return false; }
  }
  function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') fail('扩展副本格式错误');
    var subs = Array.isArray(snapshot.subChats) && snapshot.subChats.length ? snapshot.subChats : [snapshot];
    subs.forEach(function (sub) {
      if (!sub || !Array.isArray(sub.messages)) fail('扩展分支格式错误');
      sub.messages.forEach(function (msg) {
        if (!msg || typeof msg.content !== 'string' || !['user', 'assistant', 'system'].includes(msg.role)) fail('扩展消息格式错误');
      });
    });
  }
  function parseTavern(source, filename) {
    var value;
    if (typeof source === 'string') {
      var clean = source.replace(/^\uFEFF/, '').trim();
      try { value = JSON.parse(clean); } catch (e) {
        value = clean.split(/\r?\n/).filter(function (line) { return line.trim(); }).map(function (line, i) {
          try { return JSON.parse(line); } catch (err) { fail('第 ' + (i + 1) + ' 行格式错误'); }
        });
      }
    } else value = source;
    var rows = Array.isArray(value) ? value : value && (value.messages || value.chat) || [value];
    if (!Array.isArray(rows)) fail('消息格式错误');
    var metadata = rows[0] && typeof rows[0].mes !== 'string' ? rows[0] : {};
    var ext = metadata._mychat_ext;
    var meta = metadata.chat_metadata && metadata.chat_metadata._mychat_session_meta;
    if (ext && ext.type === 'session' && ext.version === 1) {
      var snapshot = clone(ext.session);
      validateSnapshot(snapshot);
      if (!Array.isArray(snapshot.subChats) || !snapshot.subChats.length) {
        snapshot.subChats = [{ title: '主对话', messages: clone(snapshot.messages), memoryData: clone(snapshot.memoryData) }];
      }
      snapshot.title = text(snapshot.title) || text(meta && meta.title) || '酒馆对话';
      snapshot._mychatImportSnapshot = clone(snapshot);
      return [snapshot];
    }
    var messages = [];
    rows.forEach(function (m) {
      if (!m || typeof m !== 'object') fail('消息格式错误');
      if (typeof m.mes !== 'string') {
        if (m === metadata) return;
        fail('消息正文缺失');
      }
      // is_system 也可能表示隐藏历史，不能据此移除楼层或生成系统预设。
      var reasoning = text(m.extra && m.extra.reasoning);
      var msg = { role: m.is_user ? 'user' : 'assistant', content: m.mes, reasoning: reasoning, timestamp: time(m.send_date) };
      var thinking = text(m.extra && m.extra.presetThinking) || text(m.presetThinking);
      if (thinking) { msg.tagReasoning = thinking; msg.presetThinking = thinking; }
      var messageId = m._mychat_msg_id || (m.extra && m.extra._mychat_msg_id);
      if (messageId != null) msg.id = messageId;
      if (!m.is_user && Array.isArray(m.swipes) && m.swipes.length) {
        msg.swipes = m.swipes.map(function (v, i) {
          var info = m.swipe_info && m.swipe_info[i];
          return { content: typeof v === 'string' ? v : text(v && (v.mes || v.content)), reasoning: text(info && info.extra && info.extra.reasoning) || (i === m.swipe_id ? reasoning : ''), tagReasoning: text(info && info.extra && info.extra.presetThinking) || (i === m.swipe_id ? thinking : ''), timestamp: time(info && info.send_date) };
        });
        msg.swipeIndex = Number.isInteger(m.swipe_id) ? Math.max(0, Math.min(m.swipes.length - 1, m.swipe_id)) : 0;
        msg.content = msg.swipes[msg.swipeIndex].content;
        msg.reasoning = msg.swipes[msg.swipeIndex].reasoning;
        if (msg.swipes[msg.swipeIndex].tagReasoning) msg.tagReasoning = msg.swipes[msg.swipeIndex].tagReasoning;
      }
      if (m._mychat_ext && m._mychat_ext.type === 'message' && m._mychat_ext.version === 1) {
        var restored = clone(m._mychat_ext.message);
        if (!restored || typeof restored.content !== 'string' || !['user', 'assistant', 'system'].includes(restored.role)) fail('扩展消息格式错误');
        messages.push(restored); return;
      }
      if (!msg.content.trim() && !msg.reasoning && !msg.tagReasoning) return;
      messages.push(msg);
    });
    if (!messages.length && !meta) fail('未找到对话');
    var characterName = text(metadata.character_name) || text(value && value.character_name);
    var draft = { title: characterName ? '导入对话 - ' + characterName : text(filename).replace(/\.[^.]+$/, '') || '酒馆对话', subChats: [{ title: '主对话', messages: messages }] };
    if (meta && typeof meta === 'object') {
      var restoredSession = Object.assign({}, clone(meta.settingsSnapshot || {}), { title: text(meta.title) || draft.title, subChats: [{ title: '主对话', messages: messages, memoryData: clone(meta.memoryData) }] });
      validateSnapshot(restoredSession);
      draft = restoredSession;
      draft._mychatImportSnapshot = clone(restoredSession);
    }
    if (!draft._mychatImportSnapshot && rows.some(function (row) {
      return row && (row._mychat_ext || row._mychat_msg_id != null || row.presetThinking || (row.extra && (row.extra.presetThinking || row.extra._mychat_msg_id != null)));
    })) draft._mychatImportSnapshot = clone(draft);
    return [draft];
  }
  function crc32(bytes) {
    var crc = -1;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (var b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ -1) >>> 0;
  }
  // ZIP 只读中央目录；数据描述符不影响定位，不释放任何文件到磁盘。
  function openZip(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX) fail('文件过大');
    var view = new DataView(buffer), bytes = new Uint8Array(buffer), end = -1;
    function bounds(pos, length) { if (pos < 0 || pos + length > bytes.length) fail('压缩包损坏'); }
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    }
    if (end < 0) fail('压缩包损坏');
    var count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), pos = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535 || pos === 0xffffffff) fail('不支持分卷或 ZIP64');
    bounds(pos, size);
    var stop = pos + size, entries = new Map(), total = 0;
    for (i = 0; i < count; i++) {
      bounds(pos, 46);
      if (view.getUint32(pos, true) !== 0x02014b50) fail('中央目录损坏');
      var flags = view.getUint16(pos + 8, true), method = view.getUint16(pos + 10, true), compressed = view.getUint32(pos + 20, true), length = view.getUint32(pos + 24, true);
      var nl = view.getUint16(pos + 28, true), el = view.getUint16(pos + 30, true), cl = view.getUint16(pos + 32, true);
      bounds(pos + 46, nl + el + cl);
      var name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(pos + 46, pos + 46 + nl));
      if (entries.has(name) || name.split('/').includes('..') || name.startsWith('/') || name.includes('\\')) fail('压缩包路径错误');
      total += length;
      if (total > MAX || length === 0xffffffff || compressed === 0xffffffff) fail('解压内容过大');
      entries.set(name, { flags: flags, method: method, compressed: compressed, length: length, crc: view.getUint32(pos + 16, true), offset: view.getUint32(pos + 42, true) });
      pos += 46 + nl + el + cl;
    }
    if (pos !== stop || stop > end) fail('中央目录损坏');
    return async function read(name) {
      var e = entries.get(name);
      if (!e) fail('缺少会话文件');
      if (e.flags & 1) fail('不支持加密压缩包');
      bounds(e.offset, 30);
      if (view.getUint32(e.offset, true) !== 0x04034b50) fail('压缩包损坏');
      var start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
      bounds(start, e.compressed);
      var raw = bytes.subarray(start, start + e.compressed), result;
      if (e.method === 0) result = raw;
      else if (e.method === 8) {
        if (!window.DecompressionStream) fail('浏览器不支持解压');
        var ds;
        try { ds = new DecompressionStream('deflate-raw'); } catch (err) { fail('浏览器不支持解压'); }
        var reader = new Blob([raw]).stream().pipeThrough(ds).getReader(), chunks = [], n = 0;
        try {
          while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            n += chunk.value.length;
            if (n > e.length || n > MAX) { await reader.cancel(); fail('解压内容过大'); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        result = new Uint8Array(n); var at = 0;
        chunks.forEach(function (c) { result.set(c, at); at += c.length; });
      } else fail('不支持此压缩方式');
      if (result.length !== e.length || crc32(result) !== e.crc) fail('压缩包校验失败');
      return json(new TextDecoder('utf-8', { fatal: true }).decode(result));
    };
  }
  async function parseZip(buffer) {
    var read = openZip(buffer), manifest = await read('manifest.json');
    if (!Array.isArray(manifest.sessions) || !manifest.sessions.length) fail('缺少会话索引');
    var all = [], paths = new Set();
    for (var i = 0; i < manifest.sessions.length; i++) {
      var item = manifest.sessions[i], path = typeof item === 'string' ? item : item && item.path;
      if (typeof path !== 'string' || paths.has(path)) fail('会话索引错误');
      paths.add(path);
      all.push(chatboxSession(await read(path), i));
    }
    return all;
  }
  async function parseFile(file, format) {
    if (!file || file.size > MAX) fail('文件过大');
    if (format === 'chatbox' && /\.zip$/i.test(file.name)) return parseZip(await file.arrayBuffer());
    var source = await file.text();
    return format === 'tavern' ? parseTavern(source, file.name) : parseChatbox(json(source));
  }
  async function importFile(file, format, bridge) {
    var drafts;
    if (format === 'tavern') {
      if (!file || file.size > MAX) fail('文件过大');
      var source = await file.text(), value;
      try { value = JSON.parse(source.replace(/^\uFEFF/, '')); } catch (e) { /* JSONL 继续逐行解析。 */ }
      // 只按标准 prompts 结构识别真实预设，绝不从隐藏消息拼接预设。
      var pending = [value], preset = null;
      while (pending.length) {
        var obj = pending.pop();
        if (!obj || typeof obj !== 'object') continue;
        if (Array.isArray(obj.prompts)) { preset = obj; break; }
        Object.keys(obj).forEach(function (key) {
          if (key === '_mychat_ext' || key === '_mychat_session_meta') return;
          if (obj[key] && typeof obj[key] === 'object') pending.push(obj[key]);
        });
      }
      if (preset) {
        var importer = window.MyChatTavern;
        if (!importer || typeof importer.importPreset !== 'function') fail('酒馆预设导入器未加载');
        if (!importer.importPreset(preset, file.name)) fail('预设导入失败');
        return { sessions: 0, presets: 1, ids: [] };
      }
      drafts = parseTavern(source, file.name);
    } else drafts = await parseFile(file, format);
    var host = bridge || window.MyChat;
    // 宿主只负责白名单追加与全局唯一 ID；扩展数据只写新建对象，绝不覆盖已有会话。
    var safeDrafts = drafts.map(function (draft) {
      if (!draft._mychatImportSnapshot) return draft;
      return { title: draft.title, subChats: draft.subChats.map(function (sub) { return { title: sub.title, messages: sub.messages.filter(function (msg) { return msg.role !== 'system'; }) }; }) };
    });
    var result = host.appendExternalChats(safeDrafts);
    drafts.forEach(function (draft, index) {
      if (!draft._mychatImportSnapshot) return;
      var live = host.getSessionById(result.ids[index]);
      if (!live) fail('新对话恢复失败');
      var before = clone(live), restored = clone(draft._mychatImportSnapshot);
      var activeIndex = (restored.subChats || []).findIndex(function (sub) { return sub.id === restored.activeSubChatId; });
      restored.id = live.id;
      restored.subChats.forEach(function (sub, i) { sub.id = live.subChats[i].id; });
      restored.activeSubChatId = restored.subChats[Math.max(0, activeIndex)].id;
      var active = restored.subChats[Math.max(0, activeIndex)];
      restored.messages = active.messages;
      if (active.memoryData !== undefined) restored.memoryData = active.memoryData;
      Object.assign(live, restored);
      // appendExternalChats 已更新时间戳并安排同步；补全时不再次改写来源会话时间。
      try {
        if (host.saveSession(live, { background: true, silent: true }) === false) fail('存储保存失败');
      } catch (error) {
        var baseActive = before.subChats && before.subChats.find(function (sub) { return sub.id === before.activeSubChatId; });
        if (baseActive) {
          before.messages = baseActive.messages;
          if (baseActive.memoryData !== undefined) before.memoryData = baseActive.memoryData;
        }
        Object.keys(live).forEach(function (key) { delete live[key]; }); Object.assign(live, before);
        fail('扩展保存失败，已保留基础对话');
      }
    });
    return result;
  }
  var api = { parseChatbox: parseChatbox, parseTavern: parseTavern, parseZip: parseZip, parseFile: parseFile, importFile: importFile,
    exportSessionToTavernJsonl: exportSessionToTavernJsonl, downloadSession: downloadSession };
  window.MyChatExternalImporter = api;
  function init() {
    var button = document.getElementById('btn-import-external-chat');
    if (!button || !window.MyChat) return;
    var modal = document.createElement('div');
    modal.className = 'external-import-modal'; modal.hidden = true;
    modal.innerHTML = '<section class="external-import-card" role="dialog" aria-modal="true" aria-labelledby="external-import-title"><header><strong id="external-import-title">导入外部对话</strong><button type="button" title="关闭" aria-label="关闭"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><label for="external-import-format">来源格式</label><select id="external-import-format"><option value="chatbox">导入 Chatbox 对话（ZIP / JSON）</option><option value="tavern">导入酒馆对话（JSONL / JSON）</option></select><input type="file" aria-label="选择对话文件" accept=".zip,.json,.jsonl"><p role="status"></p></section>';
    document.body.appendChild(modal);
    var close = modal.querySelector('button'), select = modal.querySelector('select'), input = modal.querySelector('input'), status = modal.querySelector('p'), busy = false;
    function hide() { if (busy) return; modal.hidden = true; button.focus(); }
    button.addEventListener('click', function () { modal.hidden = false; status.textContent = ''; input.value = ''; select.focus(); });
    close.addEventListener('click', hide);
    modal.addEventListener('click', function (e) { if (e.target === modal) hide(); });
    modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); if (e.key === 'Tab') { var items = [close, select, input].filter(function (v) { return !v.disabled; }); var first = items[0], last = items[items.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } });
    select.addEventListener('change', function () { input.accept = select.value === 'chatbox' ? '.zip,.json' : '.jsonl,.json'; input.value = ''; });
    input.addEventListener('change', async function () {
      if (!input.files[0] || busy) return;
      busy = true; input.disabled = select.disabled = close.disabled = true; status.textContent = '正在解析';
      try {
        var result = await importFile(input.files[0], select.value);
        window.MyChat.showToast('已导入 ' + result.sessions + ' 个对话，' + result.presets + ' 个预设');
        busy = false; hide();
      } catch (e) { status.textContent = e.message || '导入失败'; }
      finally { busy = false; input.disabled = select.disabled = close.disabled = false; input.value = ''; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
