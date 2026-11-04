/* 全局调试透视：仅内存保存，不拦截全局 fetch，不记录鉴权头。 */
(function () {
  'use strict';
  var M = window.MyChat, queue = [], limit = 60, serial = 0;
  var modal, list, detail, selected = '', filter = '', query = '', tab = 'inspector', mode = 'cards', restoreFocus;
  var channels = {main_chat:'主对话', memory_summary:'记忆总结', memory_recall:'记忆检索', dry_run:'干跑预演', misc:'其他'};
  var states = {pending:'进行中', success:'成功', error:'失败', dry_run:'预演'};
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return String.fromCharCode(38) + '#' + c.charCodeAt(0) + ';'; }); }
  function svg(name) {
    var paths = {bug:'M8 2l1.88 1.88m4.24 0L16 2M9 7h6M4 13h2m12 0h2M4 7l3 3m10 0 3-3M4 19l3-3m10 0 3 3M12 7v13M6 10a6 6 0 0 1 12 0v4a6 6 0 0 1-12 0z', close:'M6 6l12 12M18 6 6 18', copy:'M9 9h12v12H9zM5 15H3V3h12v2', trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7', bolt:'m13 2-9 12h7l-1 8 10-12h-7z', file:'M14 2H6v20h12V6zM14 2v6h6M8 13h8m-8 4h8'};
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + paths[name] + '"/></svg>';
  }
  function button(label, icon, fn, host) {
    var b = document.createElement('button'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = svg(icon); b.onclick = fn; if (host) host.appendChild(b); return b;
  }
  function get(id) { return queue.find(function (item) { return item.id === id; }); }
  function start(data) {
    try {
      var item = Object.assign({id:'trace-' + Date.now().toString(36) + '-' + (++serial), timestamp:Date.now(), category:'misc', status:'pending', durationMs:0,
        title:'请求', sessionId:'', sessionTitle:'', subChatId:'', inspectorMeta:{}, request:{}, response:{}}, clone(data || {}));
      item.request = Object.assign({endpoint:'', model:'', temperature:null, maxTokens:null, messages:[]}, item.request);
      item.response = Object.assign({rawText:'', parsedData:null, validationResult:null, httpStatus:null, errorMsg:''}, item.response);
      queue.push(item); if (queue.length > limit) queue.splice(0, queue.length - limit);
      if (!get(selected)) selected = queue[queue.length - 1].id;
      render(); return item.id;
    } catch (e) { console.warn('[调试透视] 记录失败', e); return ''; }
  }
  function update(id, patch) {
    try {
      var item = get(id); if (!item) return;
      var p = clone(patch || {});
      ['response','request','inspectorMeta'].forEach(function (key) { if (p[key]) p[key] = Object.assign({}, item[key], p[key]); });
      Object.assign(item, p); render();
    } catch (e) { console.warn('[调试透视] 更新失败', e); }
  }
  function finish(id, patch) { var item = get(id); if (item) update(id, Object.assign({status:'success', durationMs:Date.now() - item.timestamp}, patch)); }
  function copy(text) {
    text = String(text);
    function fallback() {
      var el = document.createElement('textarea'); el.value = text; (modal && modal.open ? modal : document.body).appendChild(el); el.select();
      var ok = document.execCommand('copy'); el.remove(); if (M.showToast) M.showToast(ok ? '已复制' : '复制失败');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { if (M.showToast) M.showToast('已复制'); }, fallback);
    else fallback();
  }
  // 只拆解已知顶层成对标签；其余内容完整保留为纯文本，绝不把载荷交给 HTML 解析。
  function splitXml(text) {
    text = String(text); var parts = [], last = 0, match;
    var re = /<(existing_global_overview|recent_events_detail|new_dialogue_segment|global_overview|event_index|recent_context|current_context|env_context)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    while ((match = re.exec(text))) {
      if (match.index > last) parts.push({title:'纯文本', text:text.slice(last, match.index)});
      parts.push({title:match[1], text:match[0], body:match[2]}); last = re.lastIndex;
    }
    if (last < text.length) parts.push({title:'纯文本', text:text.slice(last)});
    return parts;
  }
  function block(host, title, text, fold) {
    var box = document.createElement(fold ? 'details' : 'section'); box.className = 'di-block';
    var head = document.createElement(fold ? 'summary' : 'header');
    var label = document.createElement('span'); label.textContent = title + ' · ' + text.length + ' 字符'; head.appendChild(label);
    button('复制区块', 'copy', function (e) { e.preventDefault(); e.stopPropagation(); copy(text); }, head);
    box.appendChild(head);
    function mount() { var pre = document.createElement('pre'); pre.textContent = text; box.appendChild(pre); }
    if (fold) box.addEventListener('toggle', function () { if (box.open && !box.querySelector('pre')) mount(); if (!box.open) { var pre = box.querySelector('pre'); if (pre) pre.remove(); } });
    else mount(); host.appendChild(box);
  }
  var labels = {kind:'通道', floorRange:'总结楼层区间', summarizedFloorCursor:'当前总结游标', recentEventsDetailCount:'配置近期事件数', recentEventCount:'实际注入事件数', recentEvents:'近期事件明细', existingOverview:'历史总纲', dialogueSegment:'新增对话片段', validation:'格式校验', newEventIds:'新增事件编号', overwrittenEventIds:'原位覆写编号', emptyNewEvents:'空事件数组', maxRecallCount:'最大召回数', dynamicMaxTokens:'动态输出预算', candidateCount:'索引候选数', candidateIds:'索引候选编号', hitIds:'最终命中编号', rawOutput:'模型原始输出', systemPromptChars:'系统提示词字符', worldbookEntries:'世界书注入明细', memoryOverviewChars:'常驻记忆总纲字符', memoryEvents:'历史档案注入明细', historyRange:'历史楼层区间', historyCount:'历史消息数', totalMessages:'发送消息总数', note:'预演说明', attempt:'请求次数', commitResult:'归档提交结果', characterBreakdown:'上下文字符占比'};
  function jsonTree(host, value, name) {
    if (value && typeof value === 'object') {
      var node = document.createElement('details'), head = document.createElement('summary');
      head.textContent = name + ' · ' + (Array.isArray(value) ? '数组' : '对象') + ' (' + Object.keys(value).length + ')';
      node.appendChild(head); host.appendChild(node);
      node.addEventListener('toggle', function () {
        if (!node.open || node.dataset.loaded) return; node.dataset.loaded = 'true';
        Object.keys(value).forEach(function (key) { jsonTree(node, value[key], key); });
      });
    } else { var pre = document.createElement('pre'); pre.textContent = name + ': ' + JSON.stringify(value); host.appendChild(pre); }
  }
  function showInspector(item) {
    var breakdown = item.inspectorMeta.characterBreakdown;
    if (breakdown) {
      var total = Object.values(breakdown).reduce(function (n,v) { return n + v; },0), bar = document.createElement('div'); bar.className = 'di-ratio';
      var names = {systemPrompt:'系统提示词',worldbook:'世界书',memoryOverview:'记忆总纲',memoryEvents:'历史档案',history:'对话历史'};
      Object.keys(breakdown).forEach(function (key,i) {
        if (!breakdown[key] || !total) return;
        var segment = document.createElement('span'); segment.style.width = (breakdown[key]/total*100) + '%'; segment.style.background = ['#709ade','#af8bd6','#65b49b','#d5ae65','#8494a5'][i];
        segment.title = names[key] + ' · ' + breakdown[key] + ' 字符 · ' + (breakdown[key]/total*100).toFixed(1) + '%'; bar.appendChild(segment);
      }); detail.appendChild(bar);
    }
    var cards = document.createElement('div'); cards.className = 'di-metrics'; detail.appendChild(cards);
    Object.keys(item.inspectorMeta).forEach(function (key) {
      var card = document.createElement('section'); card.className = 'di-metric';
      if (/recentEvent|validation/.test(key)) card.classList.add('di-highlight');
      var h = document.createElement('h4'); h.textContent = labels[key] || key; card.appendChild(h);
      var val = item.inspectorMeta[key], pre = document.createElement('pre');
      pre.textContent = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val); card.appendChild(pre); cards.appendChild(card);
    });
  }
  function renderDetail() {
    if (!detail) return; detail.replaceChildren(); var item = get(selected);
    if (!item) { detail.textContent = '暂无抓包记录'; return; }
    var title = document.createElement('h3'); title.textContent = item.title; detail.appendChild(title);
    if (tab === 'inspector') showInspector(item);
    if (tab === 'request') {
      var tools = document.createElement('div'); tools.className = 'di-inline'; detail.appendChild(tools);
      var toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = mode === 'cards' ? '原始纯文本' : '结构化卡片';
      toggle.onclick = function () { mode = mode === 'cards' ? 'raw' : 'cards'; renderDetail(); }; tools.appendChild(toggle);
      button('复制完整 JSON', 'copy', function () { copy(JSON.stringify(item.request, null, 2)); }, tools);
      item.request.messages.forEach(function (msg, i) {
        var section = document.createElement('section'); section.className = 'di-message'; detail.appendChild(section);
        var content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
        var header = document.createElement('h4'); header.textContent = '#' + (i + 1) + ' · ' + msg.role; section.appendChild(header);
        button('复制单条消息', 'copy', function () { copy(content); }, header);
        if (mode === 'raw') block(section, '原始纯文本', content, false);
        else splitXml(content).forEach(function (part) { block(section, part.title, part.text, true); });
      });
    }
    if (tab === 'response') {
      block(detail, '模型原始返回', item.response.rawText || '', false);
      var tree = document.createElement('section'); tree.className = 'di-json-tree'; detail.appendChild(tree); jsonTree(tree, item.response.parsedData, '解析结果');
      block(detail, '解析 JSON', JSON.stringify(item.response.parsedData, null, 2), true);
      block(detail, '校验结果', JSON.stringify(item.response.validationResult, null, 2), false);
      if (item.response.errorMsg) block(detail, '错误详情', item.response.errorMsg, false);
    }
    if (tab === 'meta') {
      block(detail, '接口与参数', JSON.stringify({endpoint:item.request.endpoint, model:item.request.model, temperature:item.request.temperature, max_tokens:item.request.maxTokens, httpStatus:item.response.httpStatus, durationMs:item.durationMs, sessionId:item.sessionId, sessionTitle:item.sessionTitle, subChatId:item.subChatId}, null, 2), false);
      var actions = document.createElement('div'); actions.className = 'di-inline'; detail.appendChild(actions);
      ['json','md'].forEach(function (format) { var b = button('导出 .' + format, 'file', function () { download(item, format); }, actions); var label = document.createElement('span'); label.textContent = '.' + format; b.appendChild(label); });
    }
  }
  function render() {
    if (!modal || !modal.open) return;
    list.replaceChildren();
    queue.slice().reverse().filter(function (item) { return (!filter || item.category === filter) && (!query || JSON.stringify(item).toLowerCase().includes(query)); }).forEach(function (item) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'di-trace' + (item.id === selected ? ' active' : '');
      b.dataset.status = item.status; b.setAttribute('aria-pressed', String(item.id === selected));
      // 所有动态模板文本统一转义；载荷正文仅使用 textContent。
      b.innerHTML = '<small>' + escapeHtml(new Date(item.timestamp).toLocaleTimeString()) + ' · ' + escapeHtml(channels[item.category]) + '</small><strong>' + escapeHtml(item.title) + '</strong><small>' + escapeHtml(states[item.status]) + (item.inspectorMeta.attempt > 1 ? ' · 重试' : '') + ' · ' + item.durationMs + ' ms · ' + escapeHtml(item.inspectorMeta.floorRange || item.inspectorMeta.historyRange || '') + '</small>';
      b.onclick = function () { selected = item.id; render(); }; list.appendChild(b);
    }); renderDetail();
  }
  function download(item, format) {
    var text = JSON.stringify(item, null, 2);
    if (format === 'md') text = '# ' + item.title + '\n\n- 时间：' + new Date(item.timestamp).toISOString() + '\n- 通道：' + item.category + '\n\n    ' + text.split('\n').join('\n    ');
    var url = URL.createObjectURL(new Blob([text], {type:format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8'}));
    var a = document.createElement('a'); a.href = url; a.download = item.id + '.' + format; a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function preview(kind) {
    try {
      if (kind === 'main') M.previewMainChatPayload();
      else { var s = M.getCurrentSession(); window.MemorySummaryModule[kind === 'recall' ? 'previewRecallPayload' : 'previewNextSummaryPayload'](s && s.id, s && s.activeSubChatId); }
    } catch (e) { if (M.showToast) M.showToast(e.message || '预演失败'); }
  }
  function ensureUI() {
    if (modal) return;
    modal = document.createElement('dialog'); modal.id = 'debug-inspector-modal'; modal.className = 'di-modal'; modal.setAttribute('aria-label', '全局调试与报文透视中心');
    modal.innerHTML = '<div class="di-shell"><header class="di-head"><strong>调试透视中心</strong></header><div class="di-toolbar"><nav class="di-filters" aria-label="通道过滤"></nav><input type="search" placeholder="搜索报文" aria-label="搜索报文"><div class="di-shortcuts"></div></div><div class="di-columns"><aside class="di-list" aria-label="抓包列表"></aside><main class="di-right"><nav class="di-tabs" aria-label="详情分类"></nav><div class="di-detail"></div></main></div></div>';
    document.body.appendChild(modal); list = modal.querySelector('.di-list'); detail = modal.querySelector('.di-detail');
    button('关闭', 'close', function () { modal.close(); }, modal.querySelector('.di-head'));
    modal.addEventListener('close', function () { if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus(); });
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.close(); });
    var filters = modal.querySelector('.di-filters');
    [['','全部'],['main_chat','主对话'],['memory_summary','记忆总结'],['memory_recall','记忆检索'],['dry_run','干跑预演']].forEach(function (entry) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = entry[1]; b.dataset.filter = entry[0];
      b.onclick = function () { filter = entry[0]; syncFilters(); render(); }; filters.appendChild(b);
    });
    modal.querySelector('input').oninput = function (e) { query = e.target.value.toLowerCase().trim(); render(); };
    var shortcuts = modal.querySelector('.di-shortcuts');
    [['summary','预演总结'],['main','预演主对话'],['recall','预演检索']].forEach(function (p) {
      var b = button(p[1], 'bolt', function () { preview(p[0]); }, shortcuts); b.className = 'di-preview'; var span = document.createElement('span'); span.textContent = p[1]; b.appendChild(span);
    });
    button('清空记录', 'trash', clear, shortcuts);
    [['inspector','解剖核对'],['request','发送报文'],['response','模型响应'],['meta','接口与导出']].forEach(function (p) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = p[1]; b.dataset.tab = p[0];
      b.onclick = function () { tab = p[0]; syncFilters(); renderDetail(); }; modal.querySelector('.di-tabs').appendChild(b);
    }); syncFilters();
  }
  function syncFilters() { modal.querySelectorAll('[data-filter]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.filter === filter)); }); modal.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.tab === tab)); }); }
  function open(id) {
    ensureUI(); if (id && get(id)) { selected = id; filter = ''; query = ''; modal.querySelector('input').value = ''; tab = 'inspector'; }
    if (!modal.open) { restoreFocus = document.activeElement; modal.showModal(); } syncFilters(); render();
    if (id && !get(id) && M.showToast) M.showToast('报文已清空或淘汰');
  }
  function clear() { queue.length = 0; selected = ''; render(); }
  function request(target, messages, maxTokens, temperature) { return {endpoint:target ? M.buildChatUrl(target.provider.baseUrl) : '', model:target ? target.model.id : '', temperature:temperature == null ? null : temperature, maxTokens:maxTokens == null ? null : maxTokens, messages:messages}; }
  function mainMeta(assembled) {
    var entries = assembled.injectedEntries || [], history = assembled.history || [];
    function entryInfo(e) { return {name:e.entryName, id:(String(e.entryName).match(/EVT_\d{3,}/) || [])[0] || '', trigger:e.constant ? 'constant' : 'keyword', position:e.position, depth:e.depth, chars:String(e.content || '').length}; }
    var overview = entries.filter(function (e) { return e.memory && e.constant; }), events = entries.filter(function (e) { return e.memory && !e.constant; });
    var system = assembled.systemPromptChars == null ? 0 : assembled.systemPromptChars;
    var world = entries.filter(function (e) { return !e.memory; }).map(entryInfo);
    var sum = function (a) { return a.reduce(function (n,e) { return n + String(e.content || '').length; }, 0); };
    return {kind:'main_chat', systemPromptChars:system, worldbookEntries:world, memoryOverviewChars:sum(overview), memoryEvents:events.map(entryInfo), historyRange:history.length ? '#' + history[0].floor + ' - #' + history[history.length-1].floor : '无', historyCount:history.length, totalMessages:assembled.apiMessages.length,
      characterBreakdown:{systemPrompt:system, worldbook:world.reduce(function (n,e) { return n+e.chars; },0), memoryOverview:sum(overview), memoryEvents:sum(events), history:history.reduce(function (n,m) { return n+String(m.content || '').length; },0)}};
  }
  window.DebugInspector = {start:start, update:update, finish:finish, open:open, clear:clear, get:function (id) { var item = get(id); return item ? clone(item) : null; }, list:function () { return clone(queue); }, request:request, mainMeta:mainMeta, splitXml:splitXml, escapeHtml:escapeHtml};
  function init() { var panel = document.getElementById('input-toolbox-panel'); if (!panel) return; var b = button('调试透视 (Debug Inspector)', 'bug', function () { if (M.closeToolbox) M.closeToolbox(); open(); }, panel); b.id = 'toolbox-debug-btn'; b.className = 'toolbox-item'; b.setAttribute('role','menuitem'); var span = document.createElement('span'); span.textContent = '调试透视'; b.appendChild(span); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
