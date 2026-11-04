/* 词汇映射：纯本地字面量替换；通过 onReceive / onRender 接入，保护代码与 HTML 源码。 */
(function () {
  'use strict';
  var M = window.MyChat;
  if (!M) return;
  var rules = [];
  var modal;
  var bulk = false;
  var draft = [];
  var previousFocus;
  function uid() { return 'vocab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9); }
  function normalize(list) {
    return (Array.isArray(list) ? list : []).filter(function (r) { return r && typeof r.from === 'string'; }).map(function (r) {
      return { id: r.id || uid(), from: r.from, to: typeof r.to === 'string' ? r.to : '', enabled: r.enabled !== false, matchCase: r.matchCase === true };
    });
  }
  // 纯函数：规则快照只读；替换值使用回调，$& / $1 不会被当作特殊替换语法。
  function applyVocabMapping(text, ruleList) {
    var active = (ruleList || rules).filter(function (r) { return r.enabled !== false && r.from; });
    function replacePlain(part) {
      active.forEach(function (r) {
        var escaped = r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        part = part.replace(new RegExp(escaped, r.matchCase ? 'g' : 'gi'), function () { return r.to; });
      });
      return part;
    }
    // 逐段扫描；未闭合代码围栏 / HTML 也保护到末尾，流式中途不会改坏源码。
    var src = String(text == null ? '' : text);
    var marker = /(^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$))|(`+)|<!--|<![A-Za-z]|<\/?[A-Za-z][\w:-]*(?=[\s/>])/gm;
    var out = '', pos = 0, hit;
    while ((hit = marker.exec(src))) {
      var start = hit.index, end = start;
      if (hit[2]) {
        var fence = hit[2];
        var close = new RegExp('^[ \\t]*' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*(?:\\r?\\n|$)', 'gm');
        close.lastIndex = marker.lastIndex;
        var found = close.exec(src);
        end = found ? close.lastIndex : src.length;
      } else if (hit[3]) {
        var tickEnd = src.indexOf(hit[3], marker.lastIndex);
        end = tickEnd < 0 ? src.length : tickEnd + hit[3].length;
      } else if (hit[0] === '<!--') {
        var commentEnd = src.indexOf('-->', start + 4);
        end = commentEnd < 0 ? src.length : commentEnd + 3;
      } else {
        // 整个 HTML 元素（含内部文本与脚本）作为源码保护，不做 DOM 重序列化。
        var tags = /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*\/?>|<![^>]*>/g;
        tags.lastIndex = start;
        var token = tags.exec(src);
        if (!token || token.index !== start) { end = src.length; }
        else {
          end = tags.lastIndex;
          var name = (token[1] || '').toLowerCase();
          var isVoid = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name);
          if (name && !isVoid && !/^<\//.test(token[0]) && !/\/>$/.test(token[0])) {
            var depth = 1, next;
            while ((next = tags.exec(src))) {
              if ((next[1] || '').toLowerCase() !== name) continue;
              if (/^<\//.test(next[0])) depth--;
              else if (!/\/>$/.test(next[0])) depth++;
              if (!depth) { end = tags.lastIndex; break; }
            }
            if (depth) end = src.length;
          }
        }
      }
      out += replacePlain(src.slice(pos, start)) + src.slice(start, end);
      pos = end;
      marker.lastIndex = end;
    }
    return out + replacePlain(src.slice(pos));
  }
  function reload() {
    rules = normalize(M.getVocabRules());
    var label = document.getElementById('toolbox-vocab-label');
    if (label) label.textContent = '词汇映射 · ' + rules.filter(function (r) { return r.enabled && r.from; }).length;
  }
  function element(tag, text, cls) {
    var el = document.createElement(tag);
    if (text) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  function button(text, action) {
    var b = element('button', text, 'btn-secondary'); b.type = 'button'; b.onclick = action; return b;
  }
  function close() { modal.remove(); modal = null; if (previousFocus) previousFocus.focus(); }
  async function cleanHistory() {
    if (document.getElementById('btn-send').disabled) { M.showToast('请先等待当前回复完成再清洗历史'); return; }
    var session = M.getCurrentSession();
    if (!session) return;
    if (!await window.showAppConfirm('替换全部 AI 历史正文？')) return;
    if (document.getElementById('btn-send').disabled || M.getCurrentSession() !== session) return;
    var seen = new Set();
    var lists = [session.messages].concat((session.subChats || []).map(function (s) { return s.messages; }));
    lists.forEach(function (list) { (list || []).forEach(function (msg) {
      if (msg.role !== 'assistant' || seen.has(msg)) return;
      seen.add(msg);
      msg.content = applyVocabMapping(msg.content);
      if (Array.isArray(msg.swipes)) {
        msg.swipes.forEach(function (s) { s.content = applyVocabMapping(s.content); });
        var selected = msg.swipes[msg.swipeIndex];
        if (selected) msg.content = selected.content;
      }
    }); });
    M.saveSession(session); M.showToast('当前会话历史 AI 回复已清洗');
  }
  function render() {
    var card = modal.firstChild; card.replaceChildren();
    card.appendChild(element('h3', '词汇映射（硬比对替换）'));
    card.appendChild(element('p', '仅处理 AI 普通正文，不调用 AI；代码与 HTML 源码保持原样。规则依次执行，留空替换值即删除。', 'field-hint'));
    var tools = element('div', '', 'local-tools-row');
    tools.appendChild(button(bulk ? '切换单条规则列表' : '批量文本极速编辑', function () {
      if (bulk && !parseBulk()) return;
      bulk = !bulk; render();
    }));
    tools.appendChild(button('新增规则', function () { if (bulk && !parseBulk()) return; bulk = false; draft.push({ id: uid(), from: '', to: '', enabled: true, matchCase: false }); render(); }));
    card.appendChild(tools);
    var list = element('div', '', 'vocab-list');
    if (bulk) {
      var textarea = element('textarea'); textarea.id = 'vocab-bulk-text'; textarea.rows = 12;
      textarea.placeholder = '原词 => 新词\n多余句式 ->';
      textarea.value = draft.map(function (r) { return r.from + ' => ' + r.to; }).join('\n');
      list.appendChild(textarea);
      list.appendChild(element('p', '每行一条，支持 => 或 ->；保存后批量规则全部启用。', 'field-hint'));
    } else {
      draft.forEach(function (r, index) {
        var row = element('div', '', 'vocab-rule-row');
        var enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = r.enabled; enabled.title = '启用此规则'; enabled.onchange = function () { r.enabled = enabled.checked; };
        var from = element('input'); from.value = r.from; from.placeholder = '原词汇 / 高频 AI 句式'; from.oninput = function () { r.from = from.value; };
        var to = element('input'); to.value = r.to; to.placeholder = '替换为（留空即删除）'; to.oninput = function () { r.to = to.value; };
        var label = element('label', '', 'local-tools-row'); var match = element('input'); match.type = 'checkbox'; match.checked = r.matchCase; match.onchange = function () { r.matchCase = match.checked; }; label.append(match, document.createTextNode('区分大小写'));
        row.append(enabled, from, element('span', '→'), to, label, button('删除', function () { draft.splice(index, 1); render(); })); list.appendChild(row);
      });
    }
    card.appendChild(list);
    var footer = element('div', '', 'local-tools-row');
    footer.appendChild(button('保存规则', function () {
      if (bulk && !parseBulk()) return;
      try { M.saveVocabRules(normalize(draft)); reload(); M.refreshChatUI(); close(); } catch (err) { void window.showAppAlert('保存失败：' + err.message); }
    }));
    footer.appendChild(button('取消', close)); card.appendChild(footer);
    card.appendChild(button('立即清洗当前会话历史 AI 回复', function () { cleanHistory(); }));
    card.appendChild(element('p', '历史清洗使用已保存的规则；请先保存编辑内容。', 'field-hint'));
  }
  function parseBulk() {
    var text = modal.querySelector('#vocab-bulk-text').value;
    var next = [], invalid = [];
    text.split(/\r?\n/).forEach(function (line, i) {
      if (!line.trim()) return;
      var m = /^(.*?)\s*(?:=>|->)\s*(.*)$/.exec(line);
      if (!m || !m[1].trim()) { invalid.push(i + 1); return; }
      var from = m[1].trim(), to = m[2];
      var old = draft.find(function (r) { return r.from === from; });
      next.push({ id: old ? old.id : uid(), from: from, to: to, enabled: true, matchCase: old ? old.matchCase : false });
    });
    if (invalid.length) { void window.showAppAlert('无效行：' + invalid.join('、'), { title: '格式错误' }); return false; }
    draft = next; return true;
  }
  function open() {
    if (modal) return;
    previousFocus = document.activeElement;
    draft = normalize(rules); bulk = false;
    modal = element('div', '', 'local-tools-overlay');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', '词汇映射管理');
    var card = element('div', '', 'local-tools-card'); card.tabIndex = -1; modal.appendChild(card);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        var nodes = card.querySelectorAll('button,input,textarea'); var first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    document.body.appendChild(modal); render(); card.focus();
  }
  document.getElementById('toolbox-vocab-btn').addEventListener('click', function () { M.closeComposerPanels(); open(); });
  M.registerHook('onReceive', function (text) { return applyVocabMapping(text); });
  M.registerHook('onRender', function (text, ctx) { if (ctx.role === 'assistant') return applyVocabMapping(text); });
  window.MyChatVocab = { reload: reload, applyVocabMapping: applyVocabMapping };
  reload();
})();
