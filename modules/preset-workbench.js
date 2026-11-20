/* 超级预设工作台：独立 UI，只经公共桥读取和提交预设。 */
(function () {
  'use strict';
  var host = window.MyChat;
  if (!host) return;
  var dialog, panels = [], diffBox, diffRows, status, collapseInput;
  var sides = [{ presetId: '', moduleId: '', afterId: '' }, { presetId: '', moduleId: '', afterId: '' }];
  var review = null, opener = null, undoButton, redoButton, saveAllButton, drag = null;
  var undoStack = [], redoStack = [], expanded = new Set();
  var selectedLeftIds = [], selectedRightIds = [], workbenchMode = 'iterate';
  var columns, iterationPane, pasteBox, fusionBar, fusionLeft, fusionRight, compareButton, modeButtons = [];
  var activeSnippetSelection = null, snippetBar, snippetLabel;
  var search = { hits: [], current: -1, timer: null, presetId: '' };
  var textDrafts = new Map(), opening = false, renderFrame = 0;
  function draftKey(side, presetId, moduleId) { return JSON.stringify([side, presetId, moduleId]); }
  function collectTextDrafts() {
    panels.forEach(function (panel) {
      panel.list.querySelectorAll('textarea.pw-content').forEach(function (editor) {
        var key = draftKey(Number(editor.dataset.side), editor.dataset.presetId, editor.dataset.moduleId);
        if (editor.value !== editor.dataset.savedText) textDrafts.set(key, {
          side: Number(editor.dataset.side), presetId: editor.dataset.presetId, moduleId: editor.dataset.moduleId, text: editor.value
        });
        else textDrafts.delete(key);
      });
    });
    var list = presets();
    textDrafts.forEach(function (draft, key) {
      var p = list.find(function (item) { return item.id === draft.presetId; });
      var m = p && p.modules.find(function (item) { return item.id === draft.moduleId; });
      if (!m || draft.text === String(m.content || '').replace(/\r\n?/g, '\n')) textDrafts.delete(key);
    });
  }
  function saveExitDraft() {
    collectTextDrafts();
    var tasks = (review || []).filter(function (task) {
      var p = presets().find(function (item) { return item.id === task.presetId; });
      var m = p && p.modules.find(function (item) { return item.id === task.moduleId; });
      return m && task.editor && task.editor.isConnected &&
        extractMergedText(task.editor) !== (task.snippet ? task.snippet.selectedText : m.content);
    }).map(function (task) {
      return { presetId: task.presetId, moduleId: task.moduleId, text: extractMergedText(task.editor), snippet: task.snippet || null };
    });
    var external = panels[0].external.value;
    if (review && review.length && !tasks.length) external = '';
    var snapshot = textDrafts.size || external || tasks.length ? {
      version: 1, timestamp: Date.now(), presetId: sides[0].presetId, sides: clone(sides), mode: workbenchMode,
      drafts: Array.from(textDrafts.values()), external: external, tasks: tasks
    } : null;
    if (host.savePresetWorkbenchDraft && !host.savePresetWorkbenchDraft(snapshot)) notify('草稿保存失败');
  }
  var searchResizeObserver = window.ResizeObserver ? new ResizeObserver(function (entries) {
    entries.forEach(function (entry) {
      var editor = entry.target, mirror = editor.previousElementSibling;
      if (editor.isConnected && mirror && !mirror.hidden) syncSearchMirror(editor, mirror);
    });
  }) : null;
  function moduleCard(id) {
    return Array.from(panels[0].list.querySelectorAll('.pw-module')).find(function (card) { return card.dataset.moduleId === id; });
  }
  function scrollModule(card, target) {
    if (!card) return;
    var list = panels[0].list, a = (target || card).getBoundingClientRect(), b = list.getBoundingClientRect();
    var gap = target ? Math.max(8, (list.clientHeight - a.height) / 2) : 8;
    list.scrollTo({ top: Math.max(0, list.scrollTop + a.top - b.top - gap), behavior: 'smooth' });
  }
  // 用原文节点构建标记，不拼接用户 HTML；索引均为原文 UTF-16 偏移。
  function searchMarks(node, text, hits) {
    node.replaceChildren(); var at = 0;
    hits.forEach(function (hit) {
      node.appendChild(document.createTextNode(text.slice(at, hit.start)));
      var mark = el('mark', 'pw-search-hit' + (search.hits[search.current] === hit ? ' is-current' : ''), text.slice(hit.start, hit.end));
      node.appendChild(mark); at = hit.end;
    });
    node.appendChild(document.createTextNode(text.slice(at)));
  }
  function clearSearchMarks() {
    if (!panels[0]) return;
    panels[0].list.querySelectorAll('.pw-pick strong').forEach(function (title) { title.textContent = title.textContent; });
    panels[0].list.querySelectorAll('.pw-search-backdrop').forEach(function (mirror) { mirror.hidden = true; mirror.replaceChildren(); });
    panels[0].list.querySelectorAll('.pw-content').forEach(function (editor) { editor.classList.remove('pw-search-transparent'); });
  }
  function resetSearch() {
    clearTimeout(search.timer); search.timer = null; search.hits = []; search.current = -1;
    clearSearchMarks();
    if (search.count) { search.count.textContent = '0 / 0'; search.previous.disabled = search.next.disabled = true; }
  }
  function closeSearch(focus) {
    resetSearch(); if (!search.bar) return;
    search.input.value = ''; search.bar.hidden = true; search.button.setAttribute('aria-expanded', 'false');
    if (focus) search.button.focus();
  }
  function syncSearchMirror(editor, mirror) {
    var style = getComputedStyle(editor);
    ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textIndent', 'textAlign', 'tabSize',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].forEach(function (name) { mirror.style[name] = style[name]; });
    mirror.style.width = (editor.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)) + 'px';
    mirror.style.height = editor.offsetHeight + 'px';
    mirror.scrollTop = editor.scrollTop; mirror.scrollLeft = editor.scrollLeft;
  }
  function paintSearch() {
    clearSearchMarks();
    search.count.textContent = (search.current < 0 ? 0 : search.current + 1) + ' / ' + search.hits.length;
    search.previous.disabled = search.next.disabled = !search.hits.length;
    panels[0].list.querySelectorAll('.pw-module').forEach(function (card) {
      var hits = search.hits.filter(function (hit) { return hit.moduleId === card.dataset.moduleId; });
      var title = card.querySelector('.pw-pick strong');
      searchMarks(title, title.textContent, hits.filter(function (hit) { return hit.type === 'title'; }));
      var editor = card.querySelector('textarea.pw-content'), mirror = card.querySelector('.pw-search-backdrop');
      var contentHits = hits.filter(function (hit) { return hit.type === 'content'; });
      if (editor && mirror && contentHits.length) {
        searchMarks(mirror, editor.value, contentHits);
        // 末尾空行也需要占位，保证滚动高度与 textarea 一致。
        mirror.appendChild(document.createTextNode('\n'));
        mirror.hidden = false; editor.classList.add('pw-search-transparent'); syncSearchMirror(editor, mirror);
      }
    });
  }
  function jumpSearch(delta) {
    if (search.timer) { runSearch(); return; }
    if (!search.hits.length) return;
    search.current = (search.current + delta + search.hits.length) % search.hits.length;
    var hit = search.hits[search.current], card = moduleCard(hit.moduleId);
    if (!card) return;
    var body = card.querySelector('.pw-module-body');
    if (body.hidden) card.querySelector('.pw-body-toggle').click();
    paintSearch(); scrollModule(card, hit.type === 'content' ? card.querySelector('textarea.pw-content') : null);
    if (hit.type === 'title') {
      var title = card.querySelector('.pw-pick strong'), titleHit = title.querySelector('.is-current');
      if (titleHit) title.scrollLeft = Math.max(0, titleHit.offsetLeft - title.offsetLeft - title.clientWidth / 2);
    }
    var editor = card.querySelector('textarea.pw-content'), mirror = card.querySelector('.pw-search-backdrop');
    if (hit.type === 'content' && editor && mirror) {
      var current = mirror.querySelector('.is-current');
      if (current) {
        // offsetTop 相对镜像滚动内容原点，不依赖焦点或原生选区。
        var top = current.offsetTop - mirror.offsetTop;
        editor.scrollTop = Math.max(0, top - editor.clientHeight / 2 + current.offsetHeight / 2);
        mirror.scrollTop = editor.scrollTop;
      }
    }
  }
  function runSearch() {
    resetSearch(); if (!search.bar || search.bar.hidden || !search.input.value) return;
    var p = presetAt(presets(), 0), keyword = search.input.value;
    search.presetId = p ? p.id : '';
    if (p) p.modules.forEach(function (m) {
      var card = moduleCard(m.id), editor = card && card.querySelector('textarea.pw-content');
      [['title', m.name || '未命名模块'], ['content', editor ? editor.value : String(m.content || '').replace(/\r\n?/g, '\n')]].forEach(function (entry) {
        // 正则只用于字面量、不区分大小写匹配，避免大小写转换改变字符下标。
        var pattern = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), match;
        while ((match = pattern.exec(entry[1]))) search.hits.push({ moduleId: m.id, type: entry[0], start: match.index, end: match.index + match[0].length });
      });
    });
    if (search.hits.length) jumpSearch(1); else paintSearch();
  }
  function buildSearch(bar, section) {
    search.button = iconButton('search', '搜索模块', function () {
      if (!search.bar.hidden) return closeSearch(true);
      search.bar.hidden = false; search.button.setAttribute('aria-expanded', 'true'); search.input.focus();
    });
    search.button.classList.add('pw-search-toggle'); search.button.setAttribute('aria-expanded', 'false'); bar.appendChild(search.button);
    search.bar = el('div', 'pw-search-bar'); search.bar.hidden = true;
    search.input = el('input'); search.input.type = 'text'; search.input.placeholder = '搜索模块'; search.input.setAttribute('aria-label', '搜索模块');
    search.count = el('span', 'pw-search-count', '0 / 0'); search.count.setAttribute('aria-live', 'polite');
    search.previous = iconButton('up', '上一个', function () { jumpSearch(-1); });
    search.next = iconButton('down', '下一个', function () { jumpSearch(1); });
    search.previous.disabled = search.next.disabled = true;
    search.input.addEventListener('input', function (e) {
      resetSearch(); if (!e.isComposing && search.input.value) search.timer = setTimeout(runSearch, 160);
    });
    search.input.addEventListener('compositionend', function () { clearTimeout(search.timer); search.timer = setTimeout(runSearch, 160); });
    search.bar.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(true); }
      else if (e.key === 'Enter' && e.target === search.input) { e.preventDefault(); jumpSearch(e.shiftKey ? -1 : 1); }
    });
    search.bar.append(search.input, search.count, search.previous, search.next, iconButton('close', '关闭搜索', function () { closeSearch(true); }));
    section.appendChild(search.bar);
  }
  function clearSnippet() {
    activeSnippetSelection = null;
    if (snippetBar) snippetBar.hidden = true;
  }
  function captureSnippet(event, presetId, moduleId, editor, originalText) {
    if (workbenchMode !== 'iterate') return;
    var start, end, text;
    if (editor.matches('textarea, input')) {
      start = editor.selectionStart; end = editor.selectionEnd; text = editor.value;
    } else {
      var selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;
      var range = selection.getRangeAt(0);
      if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
      var prefix = range.cloneRange(); prefix.selectNodeContents(editor); prefix.setEnd(range.startContainer, range.startOffset);
      start = prefix.toString().length; end = start + range.toString().length; text = editor.textContent;
    }
    var selectedText = text.slice(start, end);
    if (!selectedText.trim()) return;
    // textarea 会规范化 CRLF；偏移必须映射回存储原文，未保存草稿不能锁定。
    var normalized = originalText.replace(/\r\n?/g, '\n');
    if (text !== normalized) return notify('请先保存正文修改');
    function originalOffset(offset) {
      var i = 0, n = 0;
      while (i < originalText.length && n < offset) {
        if (originalText[i] === '\r' && originalText[i + 1] === '\n') i++;
        i++; n++;
      }
      return i;
    }
    start = originalOffset(start); end = originalOffset(end);
    selectedText = originalText.slice(start, end);
    activeSnippetSelection = { presetId: presetId, moduleId: moduleId, startOffset: start, endOffset: end, selectedText: selectedText };
    invalidate();
    snippetLabel.textContent = '已锁定片段 · ' + Array.from(selectedText).length + ' 字';
    snippetBar.hidden = false;
  }
  // 偏移优先；全文变化后只接受唯一原片段，歧义时拒绝覆盖。
  function locateSnippet(fullText, snippet) {
    if (fullText.slice(snippet.startOffset, snippet.endOffset) === snippet.selectedText) return snippet.startOffset;
    var at = fullText.indexOf(snippet.selectedText);
    return at >= 0 && fullText.indexOf(snippet.selectedText, at + 1) < 0 ? at : -1;
  }
  function selectedIds(side) { return side ? selectedRightIds : selectedLeftIds; }
  function clearSelection(side) { selectedIds(side).length = 0; }
  var paths = {
    close: 'M6 6l12 12M6 18L18 6', copy: 'M9 9h12v12H9zM5 15H3V3h12v2',
    copyRight: 'M3 5h10v14H3zM8 9h5m4-1 4 4-4 4m-4-4h8',
    copyLeft: 'M11 5h10v14H11zM11 9h5M7 8l-4 4 4 4m-4-4h8',
    undo: 'm8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14',
    redo: 'm16 4 5 5-5 5M21 9H11a7 7 0 0 0 0 14',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    grip: 'M8 5h1m6 0h1M8 12h1m6 0h1M8 19h1m6 0h1',
    expand: 'm6 9 6 6 6-6', compare: 'M8 3v18M16 3v18M3 8h18M3 16h18',
    paste: 'M9 5H5v16h14V5h-4M9 3h6v4H9z', check: 'm4 12 5 5L20 6',
    snapshot: 'M12 8v5l3 2M3 11a9 9 0 1 1 2 7M3 4v7h7',
    plus: 'M12 5v14M5 12h14',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6',
    up: 'm6 10 6-6 6 6M12 4v16', down: 'm6 14 6 6 6-6M12 4v16',
    pencil: 'm15 4 5 5M4 16 16 4a2 2 0 0 1 4 4L8 20H4z',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    selectAll: 'M9 4h11v16H4V9m-1-5 3 3 5-5M8 12h8M8 16h8',
    enabled: 'M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7M17 10v4',
    disabled: 'M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7M7 10v4',
    export: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12'
  };
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function iconButton(icon, title, fn) {
    var b = el('button', 'pw-icon'); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
    b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + paths[icon] + '"/></svg>';
    b.addEventListener('click', fn); return b;
  }
  function notify(text) { status.textContent = text; }
  function presets() { return host.getPromptPresets() || []; }
  function presetAt(list, side) { return list.find(function (p) { return p.id === sides[side].presetId; }); }
  function invalidate() {
    if (review) review.forEach(clearDiffSelection);
    review = null;
    if (saveAllButton) saveAllButton.disabled = true;
    if (diffRows) diffRows.querySelectorAll('.pw-save-diff').forEach(function (button) { button.disabled = true; });
  }
  function historySnapshot() {
    var bindings = {};
    if (host.getSessionIds && host.getSessionById) host.getSessionIds().forEach(function (id) {
      var session = host.getSessionById(id); if (session) bindings[id] = session.presetId || null;
    });
    return { presets: clone(presets()), bindings: bindings, sides: clone(sides) };
  }
  function commit(list, preserveReview) {
    // list 只改公共桥返回的副本；重新读取宿主旧库，绝不把修改稿当作撤销快照。
    var previous = historySnapshot(), history = undoStack.slice();
    undoStack.push(previous);
    if (undoStack.length > 30) undoStack.shift();
    try {
      if (!host.applyPresetWorkbenchChanges(list)) throw new Error('保存失败');
    } catch (_) { undoStack = history; notify('保存失败，未应用'); return false; }
    redoStack.length = 0;
    if (!preserveReview) invalidate();
    render(); notify('已保存'); return true;
  }
  function restoreHistory(redo) {
    var source = redo ? redoStack : undoStack, target = redo ? undoStack : redoStack;
    if (!source.length) return;
    var current = historySnapshot(), previous = clone(source[source.length - 1]);
    try {
      if (!host.applyPresetWorkbenchChanges(previous.presets, { sessionPresetBindings: previous.bindings })) throw new Error('恢复失败');
    } catch (_) { notify('恢复失败，请重试'); return; }
    source.pop(); target.push(current); if (target.length > 30) target.shift();
    sides.forEach(function (s, i) { Object.assign(s, previous.sides[i]); });
    clearSnippet(); invalidate(); render(); notify(redo ? '已恢复下一步' : '已返回上一步');
  }
  function undo() { restoreHistory(false); }
  function syncSelection(side) {
    var panel = panels[side], ids = selectedIds(side);
    panel.selection.hidden = false;
    var p = presetAt(presets(), side), all = !!(p && p.modules.length && p.modules.every(function (m) { return ids.indexOf(m.id) >= 0; }));
    panel.selectAll.title = all ? '取消全选' : '全选'; panel.selectAll.setAttribute('aria-label', panel.selectAll.title);
    panel.selectAll.setAttribute('aria-pressed', String(all));
    panel.batchButtons.forEach(function (b) { b.disabled = !ids.length; });
    panel.selectionCount.textContent = '已选 ' + ids.length + ' 项';
    panel.list.querySelectorAll('.pw-module').forEach(function (card) {
      var selected = ids.indexOf(card.dataset.moduleId) >= 0;
      card.classList.toggle('selected', selected);
      card.querySelector('.pw-pick').setAttribute('aria-pressed', String(selected));
    });
    fusionLeft.hidden = !selectedLeftIds.length;
    fusionRight.hidden = !selectedRightIds.length;
    compareButton.hidden = !selectedLeftIds.length || !selectedRightIds.length;
  }
  function setMode(mode) {
    workbenchMode = mode; clearSnippet(); invalidate(); diffRows.replaceChildren();
    panels.forEach(function (p) { p.snapshots.hidden = true; p.snapshotButton.setAttribute('aria-expanded', 'false'); });
    render();
  }
  function syncLayout() {
    var iterate = workbenchMode === 'iterate';
    dialog.dataset.mode = workbenchMode;
    panels[1].section.hidden = iterate; fusionBar.hidden = iterate; pasteBox.hidden = !iterate;
    iterationPane.hidden = !iterate && !review;
    if (iterate) columns.appendChild(iterationPane); else columns.after(iterationPane);
    modeButtons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.mode === workbenchMode)); });
    panels.forEach(function (panel) { panel.after.hidden = iterate; });
  }
  function fuseSelected(from) {
    var list = presets(), src = presetAt(list, from), dst = presetAt(list, 1 - from);
    if (!src || !dst || src === dst) return notify('请选择不同预设');
    var modules = selectedIds(from).map(function (id) { return src.modules.find(function (m) { return m.id === id; }); }).filter(Boolean);
    if (!modules.length) return;
    modules.forEach(function (m) {
      var at = dst.modules.findIndex(function (other) { return other.name === m.name; });
      var copy = clone(m); copy.id = at < 0 ? newId(list) : dst.modules[at].id;
      if (at < 0) dst.modules.push(copy); else dst.modules[at] = copy;
    });
    commit(list);
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function wordGroups(m) {
    return Array.isArray(m.wordGroups) ? m.wordGroups : [{ prefix: m.content || '', items: Array.isArray(m.items) ? m.items : [] }];
  }
  function groupId() { return 'group_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
  function ensureGroups(m) {
    if (!Array.isArray(m.wordGroups)) m.wordGroups = clone(wordGroups(m));
    m.wordGroups.forEach(function (g) { if (g && !g.id) g.id = groupId(); });
    return m.wordGroups;
  }
  function moduleText(m) {
    if (m.contentType !== 'wordlist') return (m.content || '').trim();
    return wordGroups(m).map(function (g) {
      if (!g || typeof g !== 'object') return '';
      var prefix = typeof g.prefix === 'string' ? g.prefix.trim() : '';
      var items = (Array.isArray(g.items) ? g.items : []).filter(function (v) { return typeof v === 'string' && v.trim(); })
        .map(function (v) { return v.trim(); }).join('、');
      return prefix ? prefix + (items ? (/[：:]$/.test(prefix) ? '' : '\n') + items : '') : items;
    }).filter(Boolean).join('\n\n');
  }
  // 仅估算文本，不计协议开销；汉字约 1.5 字一 Token，其余约 4 字符。
  function estimateTokens(text) {
    var chinese = 0, other = 0;
    for (var ch of text) { if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch) || ch.codePointAt(0) >= 0x20000 && ch.codePointAt(0) <= 0x323af) chinese++; else other++; }
    return Math.ceil(chinese / 1.5 + other / 4);
  }
  function refreshTokenStats(presetId, moduleId, text) {
    var data = presets();
    panels.forEach(function (panel, side) {
      var p = presetAt(data, side); if (!p || p.id !== presetId) return;
      var counts = p.modules.map(function (m) { return estimateTokens(m.id === moduleId ? text : moduleText(m)); });
      var total = p.modules.reduce(function (sum, m, i) { return sum + (m.enabled === true ? counts[i] : 0); }, 0);
      panel.total.textContent = '已启用: ~' + total.toLocaleString('en-US') + ' tokens';
      panel.list.querySelectorAll('.pw-module').forEach(function (card) {
        var i = p.modules.findIndex(function (m) { return m.id === card.dataset.moduleId; }); if (i < 0) return;
        var enabled = p.modules[i].enabled === true, percent = enabled && total ? counts[i] / total * 100 : 0;
        card.querySelector('.pw-token-meta').textContent = '~' + counts[i].toLocaleString('en-US') + ' tokens · ' + (enabled ? percent.toFixed(1) + '%' : '未启用');
        card.querySelector('.pw-token-track > span').style.width = Math.min(100, percent) + '%';
      });
    });
  }
  function renderQuickModes(side, p) {
    var panel = panels[side]; panel.quickModes.replaceChildren();
    panel.quickAdd.disabled = !p;
    (p && Array.isArray(p.quickModes) ? p.quickModes : []).forEach(function (mode) {
      if (!mode || typeof mode !== 'object') return;
      var chip = el('span', 'pw-chip pw-mode-chip'), button = el('button', 'pw-mode-pick', mode.name || '未命名模式');
      button.type = 'button'; button.title = mode.name || '未命名模式';
      var ids = new Set(Array.isArray(mode.enabledModuleIds) ? mode.enabledModuleIds : []);
      button.setAttribute('aria-pressed', String(p.modules.every(function (m) { return m.enabled === ids.has(m.id); })));
      function change(remove) {
        var list = presets(), target = presetAt(list, side);
        if (!target || target.id !== p.id) return notify('预设已变化');
        var modes = Array.isArray(target.quickModes) ? target.quickModes : [];
        var at = modes.findIndex(function (item) { return item && item.id === mode.id; });
        if (at < 0 || JSON.stringify(modes[at]) !== JSON.stringify(mode)) return notify('模式已变化');
        if (remove) modes.splice(at, 1);
        else target.modules.forEach(function (m) { m.enabled = ids.has(m.id); });
        commit(list);
      }
      button.addEventListener('click', function () { change(false); });
      chip.append(button, iconButton('close', '删除快捷模式', function () { change(true); })); panel.quickModes.appendChild(chip);
    });
  }
  function editModule(side, presetId, original, change, preserveReview) {
    var list = presets(), p = presetAt(list, side);
    var m = p && p.id === presetId && p.modules.find(function (item) { return item.id === original.id; });
    if (!m || JSON.stringify(m) !== JSON.stringify(original)) return notify('模块已变化，请重新展开');
    if (change(m) === false) return false;
    return commit(list, preserveReview);
  }
  function snapshotName() {
    var d = new Date(), pad = function (n) { return String(n).padStart(2, '0'); };
    return '快照 ' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function snapshotAction(side, action, id) {
    var list = presets(), p = presetAt(list, side);
    if (!p) return notify('预设已失效');
    var snapshots = Array.isArray(p.snapshots) ? p.snapshots : [];
    if (action === 'save') {
      var modules = clone(p.modules);
      modules.forEach(function (m) { delete m.snapshots; });
      snapshots = snapshots.concat({ id: 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10),
        name: panels[side].snapshotName.value.trim() || snapshotName(), createdAt: Date.now(), modules: modules }).slice(-10);
      p.snapshots = snapshots;
    } else {
      var at = snapshots.findIndex(function (s) { return s.id === id; });
      if (at < 0) return notify('快照已失效');
      if (action === 'restore') {
        if (!Array.isArray(snapshots[at].modules)) return notify('快照不可用');
        p.modules = clone(snapshots[at].modules);
      } else { snapshots.splice(at, 1); p.snapshots = snapshots; }
    }
    if (commit(list) && action === 'save') panels[side].snapshotName.value = snapshotName();
  }
  function positionSnapshots(side) {
    var panel = panels[side], box = panel.snapshots;
    if (box.hidden) return;
    var r = panel.snapshotButton.getBoundingClientRect();
    box.style.left = Math.max(12, Math.min(r.right - box.offsetWidth, window.innerWidth - box.offsetWidth - 12)) + 'px';
    box.style.top = Math.max(12, Math.min(r.bottom + 6, window.innerHeight - box.offsetHeight - 12)) + 'px';
  }
  function renderSnapshots(side, p) {
    var panel = panels[side], entries = p && Array.isArray(p.snapshots) ? p.snapshots : [];
    panel.snapshotButton.disabled = !p;
    panel.badge.textContent = entries.length;
    panel.snapshotList.replaceChildren();
    entries.slice().reverse().forEach(function (s) {
      var row = el('div', 'pw-snapshot-row'), label = el('div', 'pw-snapshot-label');
      label.append(el('strong', '', s.name || '未命名快照'), el('time', '', s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间'));
      row.append(label, iconButton('undo', '回滚到此版本', function () { snapshotAction(side, 'restore', s.id); }),
        iconButton('trash', '删除快照', function () { snapshotAction(side, 'delete', s.id); }));
      panel.snapshotList.appendChild(row);
    });
    if (!entries.length) panel.snapshotList.appendChild(el('p', 'pw-empty', '暂无快照'));
    positionSnapshots(side);
  }
  function focusName(side, id) {
    var card = Array.from(panels[side].list.querySelectorAll('.pw-module')).find(function (n) { return n.dataset.moduleId === id; });
    var input = card && card.querySelector('.pw-module-name');
    if (input) { input.focus(); input.select(); }
  }
  function addModule(side) {
    var list = presets(), p = presetAt(list, side); if (!p) return notify('请先选择预设');
    var m = { id: newId(list), name: '新模块', enabled: true, roleType: 'system', content: '', contentType: 'text' };
    var at = p.modules.findIndex(function (item) { return item.id === sides[side].afterId; });
    p.modules.splice(at < 0 ? p.modules.length : at + 1, 0, m);
    expanded.add(side + ':' + p.id + ':' + m.id);
    if (commit(list)) focusName(side, m.id);
  }
  async function batchModules(side, action) {
    var presetId = sides[side].presetId, ids = selectedIds(side).slice();
    if (!ids.length) return;
    if (action === 'delete' && !await window.confirm('删除所选模块？')) return;
    var list = presets(), p = list.find(function (item) { return item.id === presetId; });
    if (!p) return notify('预设已失效');
    if (action === 'delete') p.modules = p.modules.filter(function (m) { return ids.indexOf(m.id) < 0; });
    else p.modules.forEach(function (m) { if (ids.indexOf(m.id) >= 0) m.enabled = action === 'enable'; });
    commit(list);
  }
  async function deletePreset(side) {
    var id = sides[side].presetId;
    if (presets().length <= 1) return notify('至少保留一个预设');
    if (!await window.confirm('删除当前预设？')) return;
    var list = presets();
    if (list.length <= 1) return notify('至少保留一个预设');
    if (!list.some(function (p) { return p.id === id; })) return notify('预设已失效');
    // 提交前保留旧栏位供撤销；render 对失效预设统一回退第一项。
    commit(list.filter(function (p) { return p.id !== id; }));
  }
  function previewPreset(side) {
    var p = presetAt(presets(), side); if (!p) return notify('请先选择预设');
    var enabled = p.modules.filter(function (m) { return m.enabled === true; });
    var text = enabled.map(function (m) {
      var content = moduleText(m), tag = m.xmlTag;
      if (content && m.contentType !== 'wordlist' && tag && /^[a-zA-Z0-9_\u3400-\u9fff-]+$/.test(tag) &&
          !new RegExp('^<' + tag + '>\\s*[\\s\\S]*</' + tag + '>$', 'i').test(content)) content = '<' + tag + '>\n' + content + '\n</' + tag + '>';
      return content;
    }).filter(Boolean).join('\n\n');
    var popup = el('dialog', 'pw-preview'), top = el('div', 'pw-bar');
    top.append(el('strong', '', '合并预览'), el('span', 'pw-preview-stats', enabled.length + ' 模块 · ' + Array.from(text).length + ' 字符 · ~' + estimateTokens(text) + ' tokens'));
    var area = el('textarea', 'pw-preview-text'); area.readOnly = true; area.value = text; area.setAttribute('aria-label', '合并全文');
    top.append(iconButton('copy', '复制全文', async function () {
      try {
        try { await navigator.clipboard.writeText(text); }
        catch (_) { area.focus(); area.select(); if (!document.execCommand('copy')) throw new Error('复制失败'); }
        notify('已复制全文');
      } catch (_) { notify('请划选复制'); }
    }), iconButton('close', '关闭预览', function () { popup.close(); }));
    popup.append(top, area); dialog.appendChild(popup);
    popup.addEventListener('close', function () { popup.remove(); }); popup.showModal();
  }
  function buildEditor(body, side, p, m) {
    var fields = el('div', 'pw-metadata');
    [['模块名称', 'pw-module-name', m.name || ''], ['XML 标签名（可选）', 'pw-module-tag', m.xmlTag || '']].forEach(function (entry, index) {
      var label = el('label', '', entry[0]), input = el('input', entry[1]); input.value = entry[2]; input.type = 'text'; input.setAttribute('aria-label', entry[0]);
      input.addEventListener('change', function () {
        var value = input.value.trim();
        if (!index && !value) { input.value = m.name || ''; return notify('名称不能为空'); }
        if (index && value && !/^[a-zA-Z0-9_\u3400-\u9fff-]+$/.test(value)) return notify('标签名无效');
        editModule(side, p.id, m, function (target) { if (index) { if (value) target.xmlTag = value.toLowerCase(); else delete target.xmlTag; } else target.name = value; });
      });
      label.appendChild(input); fields.appendChild(label);
    });
    body.appendChild(fields);
    var mode = el('select', 'pw-content-mode'); mode.setAttribute('aria-label', '编辑模式');
    ['text', 'wordlist'].forEach(function (value) { var o = el('option', '', value === 'text' ? '普通文本' : '词库胶囊'); o.value = value; mode.appendChild(o); });
    mode.value = m.contentType === 'wordlist' ? 'wordlist' : 'text';
    mode.addEventListener('change', function () {
      editModule(side, p.id, m, function (target) { target.contentType = mode.value; if (mode.value === 'wordlist') ensureGroups(target); });
    });
    body.appendChild(mode);
    if (m.contentType !== 'wordlist') {
      var editor = el('textarea', 'pw-content'); editor.value = m.content; editor.setAttribute('aria-label', '模块正文');
      editor.dataset.side = side; editor.dataset.presetId = p.id; editor.dataset.moduleId = m.id;
      editor.dataset.savedText = editor.value;
      var draft = textDrafts.get(draftKey(side, p.id, m.id));
      if (draft) editor.value = draft.text;
      editor.addEventListener('input', function () {
        if (side === 0) resetSearch();
        if (activeSnippetSelection && activeSnippetSelection.moduleId === m.id) { clearSnippet(); invalidate(); }
        refreshTokenStats(p.id, m.id, editor.value.trim());
      });
      if (side === 0) ['mouseup', 'keyup'].forEach(function (type) {
        editor.addEventListener(type, function (event) { captureSnippet(event, p.id, m.id, editor, m.content || ''); });
      });
      editor.addEventListener('dragstart', function (e) { e.stopPropagation(); e.preventDefault(); });
      var bar = el('div', 'pw-actions');
      var saveText = iconButton('check', '保存文本框修改', function () {
        var activeTask = review && review.find(function (task) {
          return task.presetId === p.id && task.moduleId === m.id && task.editor && task.editor.isConnected;
        });
        var text = editor.value;
        // 左框只提交本框正文，绝不读取右侧编辑器；成功后仅推进比对原文基线。
        if (editModule(side, p.id, m, function (target) {
          if (String(target.content || '').replace(/\r\n?/g, '\n') === text) { notify('正文未修改'); return false; }
          target.content = text;
        }, true) && activeTask) {
          activeTask.original = JSON.stringify(presets().find(function (item) { return item.id === p.id; }).modules.find(function (item) { return item.id === m.id; }));
          activeTask.left = text; // 实际 before 字段为 left。
          if (activeTask.snippet) { activeTask.snippet = null; clearSnippet(); }
          clearDiffSelection(activeTask); refreshDiffEditor(activeTask);
          activeTask.save.disabled = activeTask.left === activeTask.right;
        }
      });
      saveText.classList.add('pw-save-text'); saveText.appendChild(el('span', '', '保存文本框修改'));
      bar.appendChild(saveText);
      var wrap = el('div', 'pw-content-wrap'), mirror = el('div', 'pw-search-backdrop');
      mirror.hidden = true; mirror.setAttribute('aria-hidden', 'true'); wrap.append(mirror, editor);
      editor.addEventListener('scroll', function () { mirror.scrollTop = editor.scrollTop; mirror.scrollLeft = editor.scrollLeft; });
      if (searchResizeObserver) searchResizeObserver.observe(editor);
      body.append(wrap, bar); return;
    }
    wordGroups(m).forEach(function (group, groupIndex) {
    if (!group || typeof group !== 'object') return;
    var box = el('section', 'pw-word-group'), top = el('div', 'pw-word-bar');
    function changeGroup(change) { return editModule(side, p.id, m, function (target) { return change(ensureGroups(target)[groupIndex]); }); }
    function focusGroup(selector, start, end) {
      Array.from(panels[side].list.querySelectorAll('.pw-module')).some(function (card) {
        if (card.dataset.moduleId !== m.id) return false;
        var groupBox = card.querySelectorAll('.pw-word-group')[groupIndex], input = groupBox && groupBox.querySelector(selector);
        if (input) { input.focus(); if (start !== undefined) input.setSelectionRange(start, end); }
        return true;
      });
    }
    var prefix = el('input', 'pw-prefix'); prefix.type = 'text'; prefix.value = group.prefix || '';
    prefix.placeholder = '情景说明'; prefix.setAttribute('aria-label', '前缀引导语');
    prefix.addEventListener('input', function (e) {
      if (e.isComposing) return;
      var start = prefix.selectionStart, end = prefix.selectionEnd;
      if (changeGroup(function (g) { if (g.prefix === prefix.value) return false; g.prefix = prefix.value; })) focusGroup('.pw-prefix', start, end);
    });
    prefix.addEventListener('compositionend', function () { prefix.dispatchEvent(new Event('input')); });
    var chips = el('div', 'pw-chips');
    (Array.isArray(group.items) ? group.items : []).forEach(function (item, index) {
      var chip = el('span', 'pw-chip'); chip.appendChild(el('span', '', String(item)));
      chip.appendChild(iconButton('close', '删除词条', function () { changeGroup(function (g) { g.items.splice(index, 1); }); })); chips.appendChild(chip);
    });
    var entry = el('input', 'pw-word-input'); entry.type = 'text'; entry.placeholder = '输入词条'; entry.setAttribute('aria-label', '新增词条');
    function add(text) {
      if (changeGroup(function (target) {
        var items = (Array.isArray(target.items) ? target.items : []).filter(function (v) { return typeof v === 'string' && v.trim(); }).map(function (v) { return v.trim(); }), seen = new Set(items);
        var extra = text.split(/[、,\r\n]+/).map(function (v) { return v.trim(); }).filter(function (v) { if (!v || seen.has(v)) return false; seen.add(v); return true; });
        if (!extra.length) return false;
        target.items = Array.from(new Set(items.concat(extra)));
      })) focusGroup('.pw-word-input');
    }
    entry.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); add(entry.value); } });
    entry.addEventListener('paste', function (e) {
      var text = e.clipboardData && e.clipboardData.getData('text');
      if (text && /[、,\r\n]/.test(text)) { e.preventDefault(); add(entry.value.slice(0, entry.selectionStart) + text + entry.value.slice(entry.selectionEnd)); }
    });
    var addBar = el('div', 'pw-word-bar'); addBar.append(entry, iconButton('plus', '添加词条', function () { add(entry.value); }));
    top.append(prefix, iconButton('trash', '删除情景分组', function () {
      editModule(side, p.id, m, function (target) { ensureGroups(target).splice(groupIndex, 1); });
    }));
    box.append(top, chips, addBar); body.appendChild(box);
    });
    var addGroup = iconButton('plus', '新增情景分组', function () {
      editModule(side, p.id, m, function (target) { ensureGroups(target).push({ id: groupId(), prefix: '', items: [] }); });
    });
    addGroup.classList.add('pw-add-group'); body.appendChild(addGroup);
  }
  function removeModule(side, id) {
    var list = presets(), p = presetAt(list, side);
    var at = p ? p.modules.findIndex(function (m) { return m.id === id; }) : -1;
    if (at < 0) return notify('模块已失效');
    p.modules.splice(at, 1); commit(list);
  }
  function clearDrag() {
    drag = null;
    panels.forEach(function (p) {
      p.list.classList.remove('pw-drop-end');
      p.list.querySelectorAll('.dragging, .pw-drop-before, .pw-drop-after').forEach(function (n) {
        n.classList.remove('dragging', 'pw-drop-before', 'pw-drop-after');
      });
    });
  }
  function dropPosition(event, side) {
    var card = event.target.closest('.pw-module');
    if (!card || !panels[side].list.contains(card)) return { id: '', after: false };
    var rect = card.getBoundingClientRect();
    return { id: card.dataset.moduleId, after: event.clientY >= rect.top + rect.height / 2, card: card };
  }
  function moveModule(to, position) {
    var list = presets(), src = list.find(function (p) { return p.id === drag.presetId; }), dst = presetAt(list, to);
    var at = src ? src.modules.findIndex(function (m) { return m.id === drag.moduleId; }) : -1;
    if (at < 0 || !dst || JSON.stringify(src.modules[at]) !== drag.original) return notify('源模块已变化');
    var target = position.id ? dst.modules.findIndex(function (m) { return m.id === position.id; }) : dst.modules.length;
    if (target < 0) return notify('插入位置已失效');
    if (position.id && position.after) target++;
    if (!drag.copy && src === dst && at < target) target--;
    if (!drag.copy && src === dst && at === target) return;
    var module = drag.copy ? clone(src.modules[at]) : src.modules.splice(at, 1)[0];
    if (drag.copy) module.id = newId(list);
    dst.modules.splice(target, 0, module);
    if (commit(list)) { sides[to].moduleId = module.id; render(); }
  }
  function newId(list) {
    var used = new Set(); list.forEach(function (p) { p.modules.forEach(function (m) { used.add(m.id); }); });
    var id; do { id = 'mod_pw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); } while (used.has(id));
    return id;
  }
  function transfer(from, moduleId) {
    var list = presets(), to = 1 - from, src = presetAt(list, from), dst = presetAt(list, to);
    if (!src || !dst) return notify('请先选择两侧预设');
    var index = src.modules.findIndex(function (m) { return m.id === moduleId; });
    if (index < 0) return notify('源模块已失效');
    var copy = JSON.parse(JSON.stringify(src.modules[index]));
    copy.id = newId(list);
    var after = sides[to].afterId;
    var at = after ? dst.modules.findIndex(function (m) { return m.id === after; }) : -1;
    if (after && at < 0) return notify('插入位置已失效');
    dst.modules.splice(after ? at + 1 : dst.modules.length, 0, copy);
    if (commit(list)) { sides[to].moduleId = copy.id; render(); }
  }
  // 字符多重集 Dice 重合度；不构造逐字编辑矩阵。
  function profile(text) {
    var counts = new Map(), length = 0;
    for (var ch of text) { if (/\s/.test(ch)) continue; counts.set(ch, (counts.get(ch) || 0) + 1); length++; }
    return { counts: counts, length: length };
  }
  function similarity(a, b) {
    if (!a.length || !b.length) return 0;
    var common = 0;
    a.counts.forEach(function (n, ch) { common += Math.min(n, b.counts.get(ch) || 0); });
    return 2 * common / (a.length + b.length);
  }
  // 保留原始空行及换行，拼接输出可逐字还原输入。
  function paragraphs(text) { return text.match(/[^\n]*\n|[^\n]+$/g) || []; }
  function tokens(text) {
    // 汉字及标点逐个独立，连续英文数字成词；不依赖分词器的词组边界。
    return text.match(/[a-zA-Z0-9]+|\s+|[^\s]/gu) || [];
  }
  function lcsOps(a, b, limit) {
    if ((a.length + 1) * (b.length + 1) > limit) return null;
    var width = b.length + 1, matrix = new Uint32Array((a.length + 1) * width), i, j;
    for (i = a.length - 1; i >= 0; i--) for (j = b.length - 1; j >= 0; j--) {
      matrix[i * width + j] = a[i] === b[j] ? matrix[(i + 1) * width + j + 1] + 1 : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
    }
    var ops = []; i = 0; j = 0;
    function push(type, value) { var last = ops[ops.length - 1]; if (last && last.type === type) last.text += value; else ops.push({ type: type, text: value }); }
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { push('same', a[i++]); j++; }
      else if (j < b.length && (i === a.length || matrix[i * width + j + 1] >= matrix[(i + 1) * width + j])) push('add', b[j++]);
      else push('del', a[i++]);
    }
    return ops;
  }
  // Hirschberg 分治：窗口只限制矩阵内存，不截断匹配范围，不丢失窗口边界的公共词句。
  function lcsLengths(a, b) {
    var prev = new Uint32Array(b.length + 1), next = new Uint32Array(b.length + 1);
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < b.length; j++) next[j + 1] = a[i] === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], next[j]);
      var swap = prev; prev = next; next = swap; next.fill(0);
    }
    return prev;
  }
  function fineTokenOps(a, b) {
    var direct = lcsOps(a, b, 160801);
    if (direct) return direct;
    var middle = Math.floor(a.length / 2);
    // 单边极短时直接使用窄矩阵，避免分治不能继续缩小。
    if (a.length < 2 || b.length < 2) return lcsOps(a, b, Infinity);
    var front = lcsLengths(a.slice(0, middle), b);
    var back = lcsLengths(a.slice(middle).reverse(), b.slice().reverse()), split = 0, best = -1;
    for (var j = 0; j <= b.length; j++) {
      var score = front[j] + back[b.length - j];
      if (score > best) { best = score; split = j; }
    }
    return fineTokenOps(a.slice(0, middle), b.slice(0, split)).concat(fineTokenOps(a.slice(middle), b.slice(split)));
  }
  function clauseOps(a, b) {
    var ca = a.match(/[^\n。；！？]*[\n。；！？]|[^\n。；！？]+$/gu) || [];
    var cb = b.match(/[^\n。；！？]*[\n。；！？]|[^\n。；！？]+$/gu) || [];
    // 无句界、句界太密或只有一侧有句界时，仍完整精细对齐，绝不整块降级。
    if (ca.length < 2 || cb.length < 2 || ca.length * cb.length > 90000) return fineTokenOps(tokens(a), tokens(b));
    var width = cb.length + 1, dp = new Float64Array((ca.length + 1) * width);
    var scores = new Float64Array(ca.length * cb.length), pa = ca.map(profile), pb = cb.map(profile), i, j;
    for (i = ca.length - 1; i >= 0; i--) for (j = cb.length - 1; j >= 0; j--) {
      var s = ca[i] === cb[j] ? 2 : calculateSim(ca[i], cb[j], pa[i], pb[j]);
      scores[i * cb.length + j] = s;
      dp[i * width + j] = Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1], s >= 0.20 ? s + dp[(i + 1) * width + j + 1] : -1);
    }
    var ops = [], pendingA = '', pendingB = '';
    function flush() {
      if (pendingA || pendingB) ops = ops.concat(fineTokenOps(tokens(pendingA), tokens(pendingB)));
      pendingA = ''; pendingB = '';
    }
    i = 0; j = 0;
    while (i < ca.length || j < cb.length) {
      var score = i < ca.length && j < cb.length ? scores[i * cb.length + j] : 0;
      if (score >= 0.20 && Math.abs(dp[i * width + j] - score - dp[(i + 1) * width + j + 1]) < 0.000001) {
        // 修改子句暂存到下一个完全相同的锚点，允许句号增删造成的一对多重切分。
        // 不在修改句边界强行截断，否则“必须写”等跨新旧句界骨架仍会丢失。
        if (ca[i] === cb[j]) { flush(); ops.push({ type: 'same', text: ca[i] }); }
        else { pendingA += ca[i]; pendingB += cb[j]; }
        i++; j++;
      } else if (j < cb.length && (i === ca.length || dp[i * width + j + 1] >= dp[(i + 1) * width + j])) pendingB += cb[j++];
      else pendingA += ca[i++];
    }
    flush(); return ops;
  }
  function inlineDiff(a, b) {
    // 纯分段/空白变化走线性对齐，超长粘合段也不会因 LCS 限额退化为整段红绿。
    if (a !== b && a.replace(/\s/g, '') === b.replace(/\s/g, '')) {
      var aligned = [], x = 0, y = 0;
      function append(type, left, right) {
        if (!left && !right) return;
        var last = aligned[aligned.length - 1];
        if (last && last.type === type) { last.left += left; last.right += right; }
        else aligned.push({ type: type, left: left, right: right });
      }
      while (x < a.length || y < b.length) {
        var sx = x, sy = y;
        while (x < a.length && /\s/.test(a[x])) x++;
        while (y < b.length && /\s/.test(b[y])) y++;
        var wa = a.slice(sx, x), wb = b.slice(sy, y);
        append(wa === wb ? 'same' : 'change', wa, wb);
        sx = x; sy = y;
        while (x < a.length && y < b.length && !/\s/.test(a[x]) && a[x] === b[y]) { x++; y++; }
        append('same', a.slice(sx, x), b.slice(sy, y));
      }
      return aligned;
    }
    var ta = tokens(a), tb = tokens(b), start = 0, endA = ta.length, endB = tb.length;
    // 公共首尾先直通，长句删短也不受中间编辑矩阵上限影响。
    while (start < endA && start < endB && ta[start] === tb[start]) start++;
    while (endA > start && endB > start && ta[endA - 1] === tb[endB - 1]) { endA--; endB--; }
    var midA = ta.slice(start, endA), midB = tb.slice(start, endB);
    var ops = midA.length <= 400 && midB.length <= 400 ? fineTokenOps(midA, midB) : clauseOps(midA.join(''), midB.join(''));
    if (start) ops.unshift({ type: 'same', text: ta.slice(0, start).join('') });
    if (endA < ta.length) ops.push({ type: 'same', text: ta.slice(endA).join('') });
    // 即使仅一个公共字符也保留为 same，不把公共骨架染进红绿块。
    var groups = [];
    ops.forEach(function (op) {
      var same = op.type === 'same', last = groups[groups.length - 1];
      if (!last || (last.type === 'same') !== same) { last = { type: same ? 'same' : 'change', left: '', right: '' }; groups.push(last); }
      if (op.type !== 'add') last.left += op.text;
      if (op.type !== 'del') last.right += op.text;
    });
    return groups;
  }
  // 只有无独立后续匹配且新增匹配字符超过该行六成，才允许跨行粘合。
  function gluedParagraphCount(parts, at, opposite, targetAt) {
    var compact = function (text) { return Array.from(text.replace(/\s+/g, '')); };
    var target = compact(opposite[targetAt]), joined = compact(parts[at]), count = 1;
    if (!target.length || !joined.length || joined.join('').includes(target.join('')) || at + 1 >= parts.length) return count;
    var matched = target.join('').includes(joined.join('')) ? joined.length : lcsLengths(joined, target)[target.length];
    for (var k = at + 1; k < parts.length; k++) {
      var next = compact(parts[k]);
      if (!next.length) continue;
      if (opposite.some(function (line, index) { return index > targetAt && calculateSim(parts[k], line) >= 0.35; })) break;
      var candidate = joined.concat(next), increased = lcsLengths(candidate, target)[target.length];
      if (increased - matched <= next.length * 0.60) break;
      joined = candidate; matched = increased; count = k - at + 1;
    }
    return count;
  }
  function redundantDiffText(a, b) {
    a = a.trim(); b = b.trim();
    if (!a || !b) return false;
    if (a === b) return true;
    var n = Math.min(a.length, b.length), prefix = 0, suffix = 0;
    while (prefix < n && a[prefix] === b[prefix]) prefix++;
    while (suffix < n && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    if (prefix > 15 || suffix > 15) return true;
    function overlap(x, y) {
      var at = x.indexOf(y.slice(0, 16));
      while (at >= 0) {
        var tail = x.slice(at);
        if (tail.length > 15 && y.indexOf(tail) === 0) return true;
        at = x.indexOf(y.slice(0, 16), at + 1);
      }
      return false;
    }
    return overlap(a, b) || overlap(b, a);
  }
  // 渲染前消融相邻红绿同文；重新对齐而非直接丢字符，两侧投影（含空白）均不变。
  function healDiffRows(rows) {
    function parts(r) { return r.parts || [{ type: r.kind === 'same' ? 'same' : 'change', left: r.left, right: r.right }]; }
    function edge(r, reverse) {
      var list = parts(r), k = reverse ? list.length - 1 : 0, step = reverse ? -1 : 1;
      while (k >= 0 && k < list.length) {
        var p = list[k];
        if (p.left.trim() || p.right.trim()) return p;
        k += step;
      }
      return null;
    }
    var result = [];
    rows.forEach(function (r) {
      result.push(r);
      while (result.length > 1) {
        var last = result[result.length - 1], start = result.length - 2;
        while (start > 0 && !result[start].left.trim() && !result[start].right.trim()) start--;
        var prev = result[start], tail = edge(prev, true), head = edge(last, false);
        if ((prev.left.trim() && prev.right.trim() && last.left.trim() && last.right.trim()) ||
            !tail || !head || tail.type === 'same' || head.type === 'same' ||
            !(redundantDiffText(tail.right, head.left) || redundantDiffText(tail.left, head.right))) break;
        var merged = result.slice(start), left = merged.map(function (p) { return p.left; }).join('');
        var right = merged.map(function (p) { return p.right; }).join('');
        result.splice(start, merged.length, { left: left, right: right, kind: left === right ? 'same' : 'rewrite', parts: inlineDiff(left, right) });
      }
    });
    return result;
  }
  function diffTexts(left, right) {
    left = String(left); right = String(right);
    var a = paragraphs(left), b = paragraphs(right), fast = Math.max(left.length, right.length) > 15000 || a.length * b.length > 90000;
    var rows = [], i = 0, j = 0;
    function row(x, y, kind) {
      rows.push({ left: x, right: y, kind: kind, parts: kind === 'rewrite' ? inlineDiff(x, y) : null });
    }
    function glueCurrent() {
      if (i >= a.length || j >= b.length || a[i] === b[j]) return false;
      var countA = gluedParagraphCount(a, i, b, j), countB = gluedParagraphCount(b, j, a, i);
      if (countA < 2 && countB < 2) return false;
      if (countA > 1) { row(a.slice(i, i + countA).join(''), b[j++], 'rewrite'); i += countA; }
      else { row(a[i++], b.slice(j, j + countB).join(''), 'rewrite'); j += countB; }
      return true;
    }
    // 单个非空段落（含局部选区）无条件进入段内比对，空白仍逐字保留。
    if (a.filter(function (p) { return p.trim(); }).length === 1 && b.filter(function (p) { return p.trim(); }).length === 1) {
      rows.push({ left: left, right: right, kind: left === right ? 'same' : 'rewrite', parts: left === right ? null : inlineDiff(left, right) });
      return { rows: rows, fast: fast };
    }
    if (!fast) {
      var pa = a.map(function (p) { return profile(p.trim()); }), pb = b.map(function (p) { return profile(p.trim()); }), width = b.length + 1;
      var dp = new Float64Array((a.length + 1) * width), scores = new Float64Array(a.length * b.length);
      for (i = a.length - 1; i >= 0; i--) for (j = b.length - 1; j >= 0; j--) {
        var score = a[i] === b[j] ? 2 : calculateSim(a[i], b[j], pa[i], pb[j]); scores[i * b.length + j] = score;
        dp[i * width + j] = Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1], score >= 0.4 ? score + dp[(i + 1) * width + j + 1] : -1);
      }
      i = 0; j = 0;
      while (i < a.length || j < b.length) {
        if (glueCurrent()) continue;
        var s = i < a.length && j < b.length ? scores[i * b.length + j] : 0;
        if (s >= 0.4 && Math.abs(dp[i * width + j] - s - dp[(i + 1) * width + j + 1]) < 0.000001) { row(a[i], b[j], a[i] === b[j] ? 'same' : 'rewrite'); i++; j++; }
        else if (j < b.length && (i === a.length || dp[i * width + j + 1] >= dp[(i + 1) * width + j])) row('', b[j++], 'add');
        else row(a[i++], '', 'del');
      }
    } else {
      // 超长输入有限前瞻对齐；命中段落仍走有界逐字比对。
      while (i < a.length || j < b.length) {
        if (glueCurrent()) continue;
        if (i >= a.length) { row('', b[j++], 'add'); continue; }
        if (j >= b.length) { row(a[i++], '', 'del'); continue; }
        if (a[i] === b[j]) { row(a[i++], b[j++], 'same'); continue; }
        var lookB = b.slice(j + 1, j + 9).indexOf(a[i]), lookA = a.slice(i + 1, i + 9).indexOf(b[j]);
        var nextB = lookB < 0 ? -1 : j + 1 + lookB, nextA = lookA < 0 ? -1 : i + 1 + lookA;
        if (nextB >= 0 && nextB - j <= 8 && (nextA < 0 || nextB - j <= nextA - i)) { while (j < nextB) row('', b[j++], 'add'); }
        else if (nextA >= 0 && nextA - i <= 8) { while (i < nextA) row(a[i++], '', 'del'); }
        else if (calculateSim(a[i], b[j]) >= 0.4) row(a[i++], b[j++], 'rewrite');
        else { row(a[i++], '', 'del'); row('', b[j++], 'add'); }
      }
    }
    return { rows: healDiffRows(rows), fast: fast };
  }
  function render() {
    collectTextDrafts();
    var scrolls = panels.map(function (panel) { return panel.list.scrollTop; });
    cancelAnimationFrame(renderFrame);
    resetSearch();
    if (searchResizeObserver) searchResizeObserver.disconnect();
    var list = presets();
    undoButton.disabled = !undoStack.length; redoButton.disabled = !redoStack.length;
    [[undoButton, undoStack, '上一步'], [redoButton, redoStack, '下一步']].forEach(function (entry) {
      entry[0].querySelector('.pw-history-badge').textContent = entry[1].length;
      entry[0].title = entry[2] + '（' + entry[1].length + ' 步）';
    });
    sides.forEach(function (s, side) {
      var p = presetAt(list, side), panel = panels[side];
      if (!p) { s.presetId = list.length ? list[s.presetId ? 0 : Math.min(side, list.length - 1)].id : ''; s.moduleId = ''; clearSelection(side); p = presetAt(list, side); }
      var ids = selectedIds(side);
      for (var i = ids.length - 1; i >= 0; i--) if (!p || !p.modules.some(function (m) { return m.id === ids[i]; })) ids.splice(i, 1);
      panel.select.replaceChildren();
      list.forEach(function (item) { var o = el('option', '', item.name); o.value = item.id; panel.select.appendChild(o); });
      panel.select.value = s.presetId;
      renderSnapshots(side, p); renderQuickModes(side, p);
      var total = p ? p.modules.reduce(function (sum, m) { return sum + (m.enabled === true ? estimateTokens(moduleText(m)) : 0); }, 0) : 0;
      panel.total.textContent = '已启用: ~' + total.toLocaleString('en-US') + ' tokens';
      panel.list.replaceChildren(); panel.after.replaceChildren();
      var end = el('option', '', '插入末尾'); end.value = ''; panel.after.appendChild(end);
      if (p) p.modules.forEach(function (m) {
        var option = el('option', '', '在「' + (m.name || '未命名模块') + '」之后'); option.value = m.id; panel.after.appendChild(option);
        var card = el('article', 'pw-module' + (ids.indexOf(m.id) >= 0 ? ' selected' : ''));
        card.draggable = false; card.dataset.moduleId = m.id;
        var dragArmed = false;
        card.addEventListener('mousedown', function (e) {
          dragArmed = e.button === 0 && (e.target === card || !!e.target.closest('.pw-grip, .pw-pick strong, .pw-state')) &&
            !e.target.closest('textarea, input, select, [contenteditable="true"], .module-content, .wb-editor, .pw-module-body');
          if (dragArmed && window.getSelection()) window.getSelection().removeAllRanges();
          card.draggable = dragArmed;
        });
        function disarm() { dragArmed = false; card.draggable = false; }
        card.addEventListener('mouseup', disarm);
        card.addEventListener('dragstart', function (e) {
          e.stopPropagation();
          if (!dragArmed || !e.dataTransfer || e.target.closest('textarea, input, select, [contenteditable="true"], .pw-module-body')) {
            e.preventDefault(); e.stopPropagation(); return;
          }
          drag = { presetId: p.id, moduleId: m.id, original: JSON.stringify(m), copy: e.ctrlKey || e.altKey };
          e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', m.id);
          card.classList.add('dragging');
        });
        card.addEventListener('dragend', function (e) { e.stopPropagation(); disarm(); clearDrag(); });
        var handle = el('span', 'pw-grip'); handle.title = '拖拽移动或排序';
        handle.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="' + paths.grip + '"/></svg>';
        card.appendChild(handle);
        var pick = el('button', 'pw-pick'); pick.type = 'button'; pick.setAttribute('aria-pressed', String(ids.indexOf(m.id) >= 0));
        pick.appendChild(el('span', 'pw-state' + (m.enabled ? ' enabled' : ''), m.enabled ? '已启用' : '已关闭'));
        pick.appendChild(el('strong', '', m.name || '未命名模块'));
        pick.appendChild(el('span', 'pw-summary', moduleText(m).slice(0, 100) || '空模块'));
        var count = estimateTokens(moduleText(m)), percent = m.enabled === true && total ? count / total * 100 : 0;
        var meta = el('span', 'pw-token-meta', '~' + count.toLocaleString('en-US') + ' tokens · ' + (m.enabled === true ? percent.toFixed(1) + '%' : '未启用'));
        pick.appendChild(meta);
        card.addEventListener('click', function (e) {
          if (e.target.closest('input, textarea, select, .pw-module-body, .pw-actions, button:not(.pw-pick)')) return;
          var at = ids.indexOf(m.id); if (at < 0) ids.push(m.id); else ids.splice(at, 1);
          s.moduleId = ids.length ? ids[ids.length - 1] : ''; invalidate(); syncSelection(side); syncLayout();
        });
        card.appendChild(pick);
        var actions = el('div', 'pw-actions');
        var enabledButton = iconButton(m.enabled === true ? 'enabled' : 'disabled', m.enabled === true ? '禁用模块' : '启用模块', function () {
          editModule(side, p.id, m, function (target) { target.enabled = target.enabled !== true; });
        });
        enabledButton.classList.add('pw-enabled'); enabledButton.setAttribute('role', 'switch'); enabledButton.setAttribute('aria-checked', String(m.enabled === true));
        actions.appendChild(enabledButton);
        actions.appendChild(iconButton('pencil', '重命名模块', function () {
          expanded.add(side + ':' + p.id + ':' + m.id); render(); focusName(side, m.id);
        }));
        if (workbenchMode === 'merge') actions.appendChild(iconButton(side ? 'copyLeft' : 'copyRight', side ? '复制到左栏' : '复制到右栏', function () { transfer(side, m.id); }));
        actions.appendChild(iconButton('trash', '删除模块', function () { removeModule(side, m.id); }));
        var key = side + ':' + p.id + ':' + m.id, body = el('div', 'pw-module-body');
        var toggle = iconButton('expand', '展开正文', function () {
          body.hidden = !body.hidden;
          if (body.hidden) expanded.delete(key); else expanded.add(key);
          syncToggle();
        });
        function syncToggle() {
          toggle.setAttribute('aria-expanded', String(!body.hidden));
          toggle.title = body.hidden ? '展开正文' : '收起正文'; toggle.setAttribute('aria-label', toggle.title);
        }
        toggle.classList.add('pw-body-toggle');
        body.hidden = !expanded.has(key); syncToggle(); actions.appendChild(toggle);
        buildEditor(body, side, p, m); card.append(actions, body);
        var progress = el('div', 'pw-token-track'), fill = el('span'); fill.style.width = Math.min(100, percent) + '%';
        progress.setAttribute('aria-hidden', 'true'); progress.appendChild(fill); card.appendChild(progress); panel.list.appendChild(card);
      });
      if (!p || !p.modules.length) panel.list.appendChild(el('p', 'pw-empty', '暂无模块'));
      if (!p || !p.modules.some(function (m) { return m.id === s.afterId; })) s.afterId = '';
      panel.after.value = s.afterId;
      syncSelection(side);
    });
    syncLayout();
    if (search.bar && !search.bar.hidden) runSearch();
    function restoreScroll() { panels.forEach(function (panel, i) { panel.list.scrollTop = scrolls[i]; }); }
    restoreScroll(); renderFrame = requestAnimationFrame(restoreScroll);
  }
  function calculateSim(a, b, pa, pb) {
    a = a.trim(); b = b.trim();
    var shortStr = a.length <= b.length ? a : b, longStr = a.length <= b.length ? b : a;
    if (shortStr.length >= 2 && longStr.includes(shortStr)) return 0.9;
    var cleanA = a.replace(/[\p{P}\s]/gu, ''), cleanB = b.replace(/[\p{P}\s]/gu, '');
    shortStr = cleanA.length <= cleanB.length ? cleanA : cleanB;
    longStr = cleanA.length <= cleanB.length ? cleanB : cleanA;
    if (Array.from(shortStr).length >= 2 && longStr.includes(shortStr)) return 0.9;
    pa = pa || profile(a); pb = pb || profile(b);
    var dice = similarity(pa, pb), overlap = pa.length && pb.length ? dice * (pa.length + pb.length) / (2 * Math.min(pa.length, pb.length)) : 0;
    if (overlap >= 0.6) return Math.max(0.5, dice);
    // 任意三个连续汉字相同即命中，等价覆盖更长公共前后缀/子串，线性扫描。
    var triples = new Set(), chars = Array.from(a), run = 0;
    chars.forEach(function (ch, i) {
      run = /\p{Script=Han}/u.test(ch) ? run + 1 : 0;
      if (run >= 3) triples.add(chars.slice(i - 2, i + 1).join(''));
    });
    chars = Array.from(b); run = 0;
    for (var i = 0; i < chars.length; i++) {
      run = /\p{Script=Han}/u.test(chars[i]) ? run + 1 : 0;
      if (run >= 3 && triples.has(chars.slice(i - 2, i + 1).join(''))) return Math.max(0.5, dice);
    }
    return dice;
  }
  function normalizeMetadataHeads(text, left) {
    var names = { author: '作者', version: '版本', language: '语言', description: '核心描述', name: '名称', gender: '性别', age: '年龄', personality: '性格特征' };
    return text.replace(/^([\t ]*[-*+][\t ]+)(Author|Version|Language|Description|Name|Gender|Age|Personality)[\t ]*[:：][\t ]*/gim, function (all, prefix, key) {
      var name = names[key.toLowerCase()];
      return new RegExp('^[\\t ]*[-*+][\\t ]+' + name + '[\\t ]*[:：]', 'm').test(left) ? prefix + name + '：' : all;
    });
  }
  // 只按自然段和 Markdown 标题切分；每个字符（包括分隔空行）均保留。
  function contentBlocks(text) {
    var blocks = [], buffer = '';
    (text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || []).forEach(function (line) {
      if (/^[\t ]*#{1,3}[\t ]+/.test(line) && buffer.trim()) {
        blocks.push(buffer); buffer = '';
      }
      buffer += line;
      if (!line.trim()) { blocks.push(buffer); buffer = ''; }
    });
    if (buffer) blocks.push(buffer);
    return blocks;
  }
  function effectiveLines(text) {
    return new Set(text.split(/\r\n|\r|\n/).map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length >= 4; }));
  }
  // 有序双字组避免仅由零散同字触发高分；不识别任何标签语法。
  function contentSimilarity(a, b) {
    a = a.trim(); b = b.trim();
    if (!a || !b) return 0;
    if (a === b) return 1;
    function pairs(text) {
      var chars = Array.from(text), counts = new Map();
      for (var i = 1; i < chars.length; i++) {
        var key = chars[i - 1] + chars[i]; counts.set(key, (counts.get(key) || 0) + 1);
      }
      return { counts: counts, length: Math.max(0, chars.length - 1) };
    }
    return similarity(pairs(a), pairs(b));
  }
  // 忽略空白，以有序双字组多重集交集衡量实际贴合量，不按短模块长度放大。
  function matchedCharCount(a, b) {
    function pairs(text) {
      var chars = Array.from(text.replace(/\s/gu, '')), counts = new Map();
      for (var i = 1; i < chars.length; i++) {
        var key = chars[i - 1] + chars[i]; counts.set(key, (counts.get(key) || 0) + 1);
      }
      return counts;
    }
    var left = pairs(a), right = pairs(b), common = 0;
    left.forEach(function (n, key) { common += Math.min(n, right.get(key) || 0); });
    return common;
  }
  function localContentScore(source, text, parts, lines) {
    var input = text.trim(), sourceLength = source.trim().length;
    if (!input || !sourceLength) return 0;
    var score = contentSimilarity(source, input);
    if (input.length >= 6 && source.includes(input)) {
      score = Math.max(score, input.length >= 30 ? 0.9 : Math.min(0.9, 0.4 + input.length / 60));
    }
    function containScore(hit) {
      var hitLen = hit.length, inputCover = hitLen / Math.max(1, input.length), sourceCover = hitLen / Math.max(1, sourceLength);
      // 孤立短标签只有在两侧均占主体时才能提分，标签仍作为普通文本参与相似度。
      if (hitLen < 30 && /^<\/?[^<>\r\n]+\/?>$/.test(hit) && !(inputCover >= 0.6 && sourceCover >= 0.6)) return 0;
      return 0.9 * Math.min(1, (inputCover * 0.7 + sourceCover * 0.3) * 1.4);
    }
    effectiveLines(input).forEach(function (line) {
      if (lines.has(line) || (line.length >= 6 && source.includes(line))) score = Math.max(score, containScore(line));
    });
    parts.forEach(function (part) {
      part = part.trim();
      var balance = Math.min(1, Math.min(part.length, input.length) / Math.max(30, Math.max(part.length, input.length) * 0.5));
      score = Math.max(score, contentSimilarity(part, input) * balance);
      if (part.length >= 6 && input.includes(part)) score = Math.max(score, containScore(part));
    });
    return score;
  }
  function matchPasted(preset, pasted) {
    pasted = String(pasted || '');
    // 仅完整首尾围栏可移除，不 trim 正文，也不改写换行。
    var fence = pasted.match(/^(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n\1[\t ]*(?:\r?\n)?$/);
    if (fence) pasted = fence[2];
    var modules = preset.modules.filter(function (m) { return m.contentType !== 'wordlist'; });
    var blocks = contentBlocks(pasted), inputLines = effectiveLines(pasted);
    var candidates = modules.map(function (m) {
      var source = m.content || '', parts = Array.from(new Set(contentBlocks(source).map(function (part) { return part.trim(); }).filter(Boolean)));
      var lines = effectiveLines(source), shared = 0, weighted = 0, total = 0, cache = new Map();
      var matchedChars = matchedCharCount(source, pasted), blockMatchedChars = 0, blockCharFits = [];
      inputLines.forEach(function (line) { if (lines.has(line)) shared++; });
      var scores = blocks.map(function (block) {
        var key = block.trim();
        if (!cache.has(key)) cache.set(key, localContentScore(source, block, parts, lines));
        var score = cache.get(key), weight = key.length;
        weighted += score * weight; total += weight;
        var blockFit = matchedCharCount(source, block);
        blockMatchedChars += blockFit; blockCharFits.push(blockFit);
        return score;
      });
      var lineRatio = shared / Math.max(1, inputLines.size);
      // 按整篇覆盖度加权，防止某一相似段落把多个模块的混合稿全部抢走。
      return { module: m, scores: scores, lineRatio: lineRatio,
        charFit: Math.max(matchedChars, blockMatchedChars), blockCharFits: blockCharFits,
        score: Math.max(contentSimilarity(source, pasted), lineRatio, weighted / Math.max(1, total)) };
    }).sort(function (a, b) {
      var higher = a.charFit >= b.charFit ? a : b;
      if (Math.abs(a.charFit - b.charFit) > 40 && higher.score >= 0.25) return b.charFit - a.charFit;
      return b.score - a.score;
    });
    function task(m, text) {
      return { presetId: preset.id, moduleId: m.id, original: JSON.stringify(m),
        left: m.content, right: normalizeMetadataHeads(text, m.content), name: m.name || '未命名模块' };
    }
    var best = candidates[0], second = candidates[1];
    var dominant = best && best.charFit >= 60 && (best.charFit >= (second ? second.charFit : 0) * 1.8 ||
      best.charFit - (second ? second.charFit : 0) >= 80);
    // 主体贴合量明确领先时，短引用不得拆稿；其他模块须有独立长段显著胜出。
    var mixed = best && blocks.some(function (block, index) {
      return block.trim() && candidates.some(function (candidate) {
        if (candidate === best) return false;
        if (dominant) {
          var otherFit = candidate.blockCharFits[index], bestFit = best.blockCharFits[index];
          return otherFit > 50 && otherFit - bestFit > 20 && otherFit >= bestFit * 1.5;
        }
        return candidate.scores[index] >= 0.45 && candidate.scores[index] - best.scores[index] >= 0.15;
      });
    });
    if (best && dominant && !mixed) return [task(best.module, pasted)];
    if (best && !mixed && ((best.score >= 0.45 && best.score - (second ? second.score : 0) >= 0.15) ||
        (best.lineRatio > 0.3 && best.lineRatio - (second ? second.lineRatio : 0) >= 0.15))) {
      return [task(best.module, pasted)];
    }
    var groups = new Map(), pending = '', previous = null;
    blocks.forEach(function (block, index) {
      var ranked = candidates.slice().sort(function (a, b) { return b.scores[index] - a.scores[index]; });
      var owner = ranked.length && ranked[0].scores[index] >= 0.45 ? ranked[0].module : previous;
      if (!owner) { pending += block; return; }
      groups.set(owner.id, (groups.get(owner.id) || '') + pending + block);
      pending = ''; previous = owner;
    });
    var tasks = modules.filter(function (m) { return groups.has(m.id); }).map(function (m) { return task(m, groups.get(m.id)); });
    if (!tasks.length) tasks.matchError = '未能从正文内容自动识别归属模块，请在左侧点击选中目标模块后再对比';
    return tasks;
  }
  function compare() {
    var list = presets(), leftPreset = presetAt(list, 0), rightPreset = presetAt(list, 1), tasks = [], smartMatched = false;
    invalidate();
    if (workbenchMode === 'iterate') {
      var pasted = panels[0].external.value;
      if (!pasted.trim()) return notify('请粘贴修改稿');
      var chosen = leftPreset && selectedLeftIds.map(function (id) { return leftPreset.modules.find(function (m) { return m.id === id; }); }).filter(Boolean);
      if (activeSnippetSelection) {
        var snippet = clone(activeSnippetSelection);
        var owner = leftPreset && leftPreset.id === snippet.presetId && leftPreset.modules.find(function (m) { return m.id === snippet.moduleId; });
        if (!owner || owner.contentType === 'wordlist' || locateSnippet(owner.content || '', snippet) < 0) return notify('片段已变化，请重新划选');
        tasks = [{ presetId: leftPreset.id, moduleId: owner.id, original: JSON.stringify(owner), snippet: snippet,
          left: snippet.selectedText, right: pasted, name: owner.name || '未命名模块' }];
      } else if (chosen && chosen.length === 1) {
        // 明确单选直接比对原文，保留尖括号、空白和换行。
        tasks = chosen.filter(function (m) { return m.contentType !== 'wordlist'; }).map(function (m) {
          return { presetId: leftPreset.id, moduleId: m.id, original: JSON.stringify(m), left: m.content,
            right: normalizeMetadataHeads(pasted, m.content), name: m.name || '未命名模块' };
        });
      } else {
        tasks = leftPreset ? matchPasted(chosen && chosen.length ? { id: leftPreset.id, modules: chosen } : leftPreset, pasted) : [];
        smartMatched = true;
      }
    } else if (leftPreset && rightPreset) {
      var right = selectedRightIds.map(function (id) { return rightPreset.modules.find(function (m) { return m.id === id; }); }).filter(Boolean);
      selectedLeftIds.forEach(function (id, index) {
        var left = leftPreset.modules.find(function (m) { return m.id === id; });
        var target = left && (right.find(function (m) { return m.name === left.name; }) || right[index]);
        if (!left || !target || left.contentType === 'wordlist' || target.contentType === 'wordlist') return;
        tasks.push({ presetId: rightPreset.id, moduleId: target.id, original: JSON.stringify(target), left: left.content || '', right: target.content || '', name: target.name || '未命名模块' });
      });
    }
    if (!tasks.length) return notify(tasks.matchError || '暂无可匹配文本模块');
    diffRows.replaceChildren(); review = tasks; saveAllButton.disabled = false;
    tasks.forEach(function (task) { renderDiffTask(task); }); diffBox.hidden = false;
    if (smartMatched) {
      var matched = new Set(tasks.map(function (task) { return task.moduleId; }));
      leftPreset.modules.forEach(function (m) { if (matched.has(m.id) && selectedLeftIds.indexOf(m.id) < 0) selectedLeftIds.push(m.id); });
      sides[0].moduleId = selectedLeftIds.length ? selectedLeftIds[selectedLeftIds.length - 1] : '';
      syncSelection(0);
    }
    syncLayout();
    if (smartMatched) {
      var first = leftPreset.modules.find(function (m) { return matched.has(m.id); });
      if (first) scrollModule(moduleCard(first.id));
    }
    notify(tasks.length > 1 ? '多模块对比已就绪' : '对比已就绪');
  }
  function validDiffRange(editor, range) {
    return !!(range && !range.collapsed && editor.contains(range.commonAncestorContainer) && range.toString().length);
  }
  function syncDiffSaveMode(task) {
    var partial = !!task.activeDiffRange, label = partial ? '仅替换框选区域' : '保存此模块';
    task.save.classList.toggle('is-partial-mode', partial);
    task.save.title = label; task.save.setAttribute('aria-label', label);
    task.saveLabel.textContent = label;
    task.selectionLabel.hidden = !partial;
  }
  function clearDiffSelection(task) {
    task.activeDiffRange = null;
    if (task.saveLabel) syncDiffSaveMode(task);
  }
  function captureDiffSelection(task) {
    if (!task.editor || !task.editor.isConnected || task.save.disabled) return clearDiffSelection(task);
    var selection = window.getSelection(), range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!validDiffRange(task.editor, range)) return clearDiffSelection(task);
    task.activeDiffRange = range.cloneRange();
    task.selectionLabel.textContent = '已框选局部 (' + Array.from(range.toString()).length + ' 字)';
    syncDiffSaveMode(task);
  }
  // 只在原 DOM 计算字符边界；克隆逐叶投影，不以整个红绿块的交集替代字符交集。
  function extractPartialDiffText(diffBox, selectedRange) {
    if (!validDiffRange(diffBox, selectedRange)) throw new Error('请重新框选');
    var clone = diffBox.cloneNode(true), source = [], targets = [], retainedEmptyBlocks = new Set();
    function leaves(root, list) {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        var node = walker.currentNode;
        if (node.nodeType === 3 || node.tagName === 'BR' ||
            (!node.firstChild && /^(DIV|P|LI|PRE|BLOCKQUOTE|H[1-6]|UL|OL|SECTION|ARTICLE)$/.test(node.tagName))) list.push(node);
      }
    }
    leaves(diffBox, source); leaves(clone, targets);
    // 撤销祖先的整块裁决，去留改由各叶子的三段结果决定。
    clone.querySelectorAll('[data-keep]').forEach(function (node) { node.removeAttribute('data-keep'); });
    source.forEach(function (node, index) {
      var diff = node.parentElement.closest('.diff-del, .diff-add');
      if (diff && !diffBox.contains(diff)) diff = null;
      var outside = !diff || diff.classList.contains('diff-del');
      var inside = !diff || (diff.dataset.keep === undefined ? diff.classList.contains('diff-add') : diff.dataset.keep === 'true');
      if (node.nodeType === 3) {
        var text = node.nodeValue, length = text.length;
        // 边界在本叶内时直接使用 UTF-16 偏移；元素边界按 DOM 顺序投影到叶首/尾。
        var start = selectedRange.startContainer === node ? selectedRange.startOffset :
          selectedRange.comparePoint(node, 0) < 0 ? length : 0;
        var end = selectedRange.endContainer === node ? selectedRange.endOffset :
          selectedRange.comparePoint(node, length) > 0 ? 0 : length;
        if (end < start) end = start;
        targets[index].nodeValue = (outside ? text.slice(0, start) : '') +
          (inside ? text.slice(start, end) : '') + (outside ? text.slice(end) : '');
      } else {
        var parent = node.parentNode, at = Array.prototype.indexOf.call(parent.childNodes, node);
        // BR 与原生空块没有字符；用前后 DOM 边界判断，不把仅贴边算入。
        var selected = selectedRange.comparePoint(parent, at) !== 1 && selectedRange.comparePoint(parent, at + 1) !== -1;
        var brRange = document.createRange(); brRange.selectNode(node);
        selected = selected && selectedRange.compareBoundaryPoints(Range.END_TO_START, brRange) < 0 &&
          selectedRange.compareBoundaryPoints(Range.START_TO_END, brRange) > 0;
        if (!(selected ? inside : outside)) targets[index].remove();
        else if (node.tagName !== 'BR') retainedEmptyBlocks.add(targets[index]);
      }
    });
    // 整块被淘汰时连同内部空段落移除，避免空块规范化产生幽灵换行。
    Array.from(clone.querySelectorAll('.diff-del, .diff-add')).reverse().forEach(function (node) {
      var hasEmptyLine = Array.from(retainedEmptyBlocks).some(function (block) { return node.contains(block); });
      if (!node.textContent && !node.querySelector('br') && !hasEmptyLine) node.remove();
    });
    return extractMergedText(clone);
  }
  function renderDiffTask(task, previousCard) {
    var result = diffTexts(task.left, task.right), card = el('article', 'pw-diff-card');
    var head = el('header', 'pw-bar'), title = el('strong', '', task.snippet ? '[局部片段] 保存至：' + task.name : '保存至模块：' + task.name);
    var save = iconButton('check', '保存此模块', function () {
      if (task.activeDiffRange) saveReviewTasks([task], false, task.activeDiffRange);
      else saveEdited(task);
    });
    var saveLabel = el('span', '', '保存此模块'); save.appendChild(saveLabel);
    save.addEventListener('mousedown', function (e) { if (e.button === 0) e.preventDefault(); });
    var copy = iconButton('copy', '复制比对结果（含红绿标记）', function () { copyDiffResult(task.editor); });
    copy.classList.add('pw-copy-diff');
    var count = el('span', 'pw-diff-selection-count'); count.setAttribute('role', 'status'); count.hidden = true;
    save.classList.add('pw-save-diff'); head.append(title, copy, count, save);
    var editor = createDiffEditor();
    task.editor = editor; task.save = save; task.card = card;
    task.activeDiffRange = null; task.saveLabel = saveLabel; task.selectionLabel = count;
    editor.addEventListener('mouseup', function () { captureDiffSelection(task); });
    editor.addEventListener('keyup', function () { captureDiffSelection(task); });
    editor.addEventListener('input', function () { clearDiffSelection(task); });
    card.append(head, editor);
    if (previousCard) previousCard.replaceWith(card); else diffRows.appendChild(card);
    refreshDiffEditor(task, result);
  }
  function refreshDiffEditor(task, result) {
    result = result || diffTexts(task.left, task.right);
    var editor = task.editor;
    editor.replaceChildren();
    function appendPart(row, type, text) {
      if (!text) return;
      var node = el('span', type === 'same' ? '' : 'diff-' + type, text);
      if (type !== 'same') { node.dataset.keep = String(type === 'add'); node.title = '点击选择保留'; }
      row.appendChild(node);
    }
    function appendChange(row, oldPart, newPart) {
      var group = oldPart && newPart ? el('span', 'diff-pair') : row;
      appendPart(group, 'del', oldPart); appendPart(group, 'add', newPart);
      if (group !== row) row.appendChild(group);
    }
    result.rows.forEach(function (r, index) {
      // 连续的纯增删段也属于同一冲突，兼容低相似度与快速兜底。
      if ((r.kind === 'del' || r.kind === 'add') && index > 0 && /^(del|add)$/.test(result.rows[index - 1].kind)) return;
      if (r.kind === 'del' || r.kind === 'add') {
        var oldParts = '', newParts = '', cursor = index;
        while (cursor < result.rows.length && /^(del|add)$/.test(result.rows[cursor].kind)) {
          oldParts += result.rows[cursor].left; newParts += result.rows[cursor].right; cursor++;
        }
        var changedRow = el('span', 'pw-diff-row pw-change');
        appendChange(changedRow, oldParts, newParts); editor.appendChild(changedRow); return;
      }
      var row = el('span', 'pw-diff-row pw-' + r.kind);
      if (r.kind === 'same') appendPart(row, 'same', r.right);
      else if (r.parts) r.parts.forEach(function (part) {
        if (part.type === 'same') appendPart(row, 'same', part.right);
        else appendChange(row, part.left, part.right);
      });
      else appendChange(row, r.left, r.right);
      editor.appendChild(row);
    });
    editor.classList.toggle('pw-collapse', collapseInput.checked);
  }
  // 只读取当前编辑区的深克隆，物理剔除淘汰内容，不依赖缓存或可见性。
  function extractMergedText(editorEl) {
    const clone = editorEl.cloneNode(true);
    clone.querySelectorAll('[data-keep="false"]').forEach(node => node.remove());
    clone.querySelectorAll('script, style').forEach(node => node.remove());
    function normalize(parent) {
      var previousBlock = false;
      Array.from(parent.childNodes).forEach(function (node) {
        if (node.nodeType === 3) {
          if (previousBlock && node.nodeValue && node.previousSibling && !node.previousSibling.textContent.endsWith('\n')) {
            parent.insertBefore(document.createTextNode('\n'), node);
          }
          previousBlock = false; return;
        }
        if (node.nodeType !== 1) return;
        if (node.tagName === 'BR') { node.replaceWith(document.createTextNode('\n')); previousBlock = false; return; }
        var block = /^(DIV|P|LI|PRE|BLOCKQUOTE|H[1-6]|UL|OL|SECTION|ARTICLE)$/.test(node.tagName);
        normalize(node);
        var before = node.previousSibling;
        if ((block || previousBlock) && before && !before.textContent.endsWith('\n')) parent.insertBefore(document.createTextNode('\n'), node);
        var value = node.textContent;
        // 空块也表示用户键入的一行，不在最终结果上做 trim。
        if (block && !value) value = '\n';
        node.replaceWith(document.createTextNode(value)); previousBlock = block;
      });
    }
    normalize(clone);
    return clone.textContent;
  }
  function saveEdited(task) { return saveReviewTasks([task], false); }
  function saveAllEdited() { return saveReviewTasks(review ? review.slice() : [], true); }
  // 锁定编辑区与所有祖先滚动层；重绘后同步恢复，再于下一帧补偿布局/滚动锚定。
  function captureReviewViewport(task, range) {
    var editor = task.editor, ancestors = [], node = editor.parentElement;
    while (node) {
      ancestors.push({ node: node, top: node.scrollTop, left: node.scrollLeft });
      node = node.parentElement;
    }
    var scrollTop = editor.scrollTop, scrollLeft = editor.scrollLeft;
    var rect = range.getBoundingClientRect(), cardTop = task.card.getBoundingClientRect().top;
    var selectionTop = rect.top;
    function restore() {
      if (!editor.isConnected) return;
      ancestors.slice().reverse().forEach(function (entry) { entry.node.scrollTop = entry.top; entry.node.scrollLeft = entry.left; });
      editor.scrollTop = scrollTop; editor.scrollLeft = scrollLeft;
      var drift = task.card.getBoundingClientRect().top - cardTop;
      if (Math.abs(drift) > 0.5) {
        var scroller = ancestors.find(function (entry) { return entry.node.scrollHeight > entry.node.clientHeight && /auto|scroll/.test(getComputedStyle(entry.node).overflowY); });
        if (scroller) scroller.node.scrollTop += drift;
      }
    }
    return { restore: restore, selectionTop: selectionTop };
  }
  function saveReviewTasks(tasks, all, selectedRange) {
    if (!review || !tasks.length) return false;
    if (selectedRange && (tasks.length !== 1 || !validDiffRange(tasks[0].editor, selectedRange))) return false;
    // 局部按钮绝不因选区失效而降级成整卡保存。
    if (arguments.length > 2 && !selectedRange) return false;
    var viewport = selectedRange ? captureReviewViewport(tasks[0], selectedRange) : null;
    var list = presets(), updates = [];
    // 先在独立副本中完成全部校验和裁决；任一目标失效时不提交任何模块。
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      if (review.indexOf(task) < 0 || task.save.disabled || !task.editor || !task.editor.isConnected) return false;
      var p = list.find(function (item) { return item.id === task.presetId; });
      var m = p && p.modules.find(function (item) { return item.id === task.moduleId; });
      if (!m || m.contentType === 'wordlist' || (!task.snippet && JSON.stringify(m) !== task.original)) {
        task.save.disabled = true; notify('目标已变化，请重新对比'); return false;
      }
      var resolved = selectedRange ? extractPartialDiffText(task.editor, selectedRange) : extractMergedText(task.editor), nextSnippet = null;
      if (task.snippet) {
        var fullText = m.content || '', at = locateSnippet(fullText, task.snippet);
        if (at < 0) { task.save.disabled = true; notify('片段已变化，请重新划选'); return false; }
        m.content = fullText.slice(0, at) + resolved + fullText.slice(at + task.snippet.selectedText.length);
        nextSnippet = Object.assign({}, task.snippet, { startOffset: at, endOffset: at + resolved.length, selectedText: resolved });
      } else m.content = resolved;
      updates.push({ task: task, module: m, snippet: nextSnippet });
    }
    if (!commit(list, true)) return false;
    updates.forEach(function (update) {
      var task = update.task;
      task.original = JSON.stringify(update.module);
      if (update.snippet) {
        var active = activeSnippetSelection;
        if (active && active.presetId === task.presetId && active.moduleId === task.moduleId &&
            active.startOffset === task.snippet.startOffset && active.selectedText === task.snippet.selectedText) {
          Object.assign(active, update.snippet);
          snippetLabel.textContent = '已锁定局部片段（' + Array.from(active.selectedText).length + ' 字）';
        }
        Object.assign(task.snippet, update.snippet);
      }
      clearDiffSelection(task);
      if (selectedRange) {
        // left/right 即本模块的 before/after；仅推进基线，原修改稿始终保留。
        task.left = update.snippet ? update.snippet.selectedText : update.module.content;
        refreshDiffEditor(task);
        task.save.disabled = task.left === task.right;
      }
    });
    if (selectedRange) {
      window.getSelection().removeAllRanges();
      viewport.restore();
      requestAnimationFrame(viewport.restore);
    }
    // 常规保存保留手调；局部保存原位重新比对，未合入差异继续保留。
    notify(selectedRange ? '已局部保存，框外原文保留' : all ? '已将对比结果全部保存到对应模块' : '已保存到目标模块');
    return true;
  }
  function build() {
    dialog = el('dialog', 'pw-dialog'); dialog.id = 'preset-workbench-modal'; dialog.setAttribute('aria-labelledby', 'pw-title');
    var head = el('header', 'pw-head'), title = el('h2', '', '预设工作台'); title.id = 'pw-title';
    var titleIcon = el('span', 'pw-title-icon');
    titleIcon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 3h18v18H3zM3 9h18M10 9v12"/></svg>';
    title.prepend(titleIcon); head.appendChild(title);
    var modes = el('div', 'pw-mode-switch'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '工作台模式');
    ['iterate', 'merge'].forEach(function (mode, index) {
      var button = el('button', '', index ? '双预设融合' : '单预设迭代'); button.type = 'button'; button.dataset.mode = mode;
      button.addEventListener('click', function () { if (workbenchMode !== mode) setMode(mode); });
      modeButtons.push(button); modes.appendChild(button);
    });
    var headActions = el('div', 'pw-actions');
    undoButton = iconButton('undo', '上一步', undo);
    redoButton = iconButton('redo', '下一步', function () { restoreHistory(true); });
    [undoButton, redoButton].forEach(function (button, index) {
      button.classList.add('pw-history'); button.append(el('span', '', index ? '下一步' : '上一步'), el('span', 'pw-history-badge', '0')); button.disabled = true;
    });
    var exportButton = iconButton('export', '导出当前预设', function () {
      var preset = presetAt(presets(), 0), tavern = window.MyChatTavern;
      if (!preset) return notify('请先选择预设');
      if (!tavern || typeof tavern.exportPreset !== 'function') return notify('导出暂不可用');
      try { tavern.exportPreset(preset.id); } catch (err) { notify('预设导出失败'); }
    });
    exportButton.classList.add('pw-export-preset');
    exportButton.appendChild(el('span', '', '导出预设'));
    headActions.append(exportButton, undoButton, redoButton, iconButton('close', '关闭', function () { dialog.close(); }));
    head.append(modes, headActions); dialog.appendChild(head);
    fusionBar = el('div', 'pw-bar pw-fusion-bar');
    fusionLeft = iconButton('copyRight', '将左栏已选融合至右栏 →', function () { fuseSelected(0); });
    fusionLeft.appendChild(el('span', '', '融合至右栏'));
    fusionRight = iconButton('copyLeft', '← 将右栏已选融合至左栏', function () { fuseSelected(1); });
    fusionRight.appendChild(el('span', '', '融合至左栏'));
    compareButton = iconButton('compare', '对比已选模块差异', compare); compareButton.appendChild(el('span', '', '对比差异'));
    fusionBar.append(fusionLeft, fusionRight, compareButton); dialog.appendChild(fusionBar);
    columns = el('div', 'pw-columns pw-workspace');
    sides.forEach(function (s, side) {
      var section = el('section', 'pw-column'), bar = el('div', 'pw-bar');
      var label = el('label'), heading = el('span', 'pw-preset-heading'), total = el('span', 'pw-token-total');
      heading.append(el('span', '', side ? '目标预设 B' : '当前预设 A'), total); label.appendChild(heading);
      var select = el('select'); select.setAttribute('aria-label', side ? '右栏预设' : '左栏预设'); label.appendChild(select); bar.appendChild(label);
      bar.append(iconButton('trash', '删除预设', function () { deletePreset(side); }), iconButton('plus', '新增模块', function () { addModule(side); }), iconButton('eye', '预览合并', function () { previewPreset(side); }));
      var after = el('select'); after.setAttribute('aria-label', side ? '右栏插入位置' : '左栏插入位置');
      after.addEventListener('change', function () { s.afterId = after.value; });
      select.addEventListener('change', function () { if (side === 0) clearSnippet(); s.presetId = select.value; s.moduleId = ''; s.afterId = ''; clearSelection(side); panels[side].quickForm.hidden = true; invalidate(); render(); });
      var snapshotButton = iconButton('snapshot', '版本快照', function () {
        var panel = panels[side], opening = panel.snapshots.hidden;
        panels.forEach(function (other) { other.snapshots.hidden = true; other.snapshotButton.setAttribute('aria-expanded', 'false'); });
        panel.snapshots.hidden = !opening; snapshotButton.setAttribute('aria-expanded', String(opening));
        if (opening) { panel.snapshotName.value = snapshotName(); renderSnapshots(side, presetAt(presets(), side)); panel.snapshotName.focus(); }
      });
      snapshotButton.classList.add('pw-snapshot-button'); snapshotButton.setAttribute('aria-expanded', 'false');
      var badge = el('span', 'pw-snapshot-badge', '0'); snapshotButton.appendChild(badge); bar.appendChild(snapshotButton);
      var snapshots = el('section', 'pw-snapshots'); snapshots.hidden = true; snapshots.setAttribute('aria-label', '版本快照');
      var snapshotInput = el('input'); snapshotInput.type = 'text'; snapshotInput.setAttribute('aria-label', '快照名称');
      var snapshotTop = el('div', 'pw-word-bar'); snapshotTop.append(snapshotInput, iconButton('plus', '保存当前快照', function () { snapshotAction(side, 'save'); }));
      var snapshotList = el('div', 'pw-snapshot-list'); snapshots.append(snapshotTop, snapshotList);
      var quickBar = el('div', 'pw-quick-bar'), quickModes = el('div', 'pw-quick-modes');
      var quickForm = el('div', 'pw-word-bar pw-quick-form'); quickForm.hidden = true;
      var quickName = el('input'); quickName.type = 'text'; quickName.placeholder = '模式名称'; quickName.setAttribute('aria-label', '快捷模式名称');
      var quickPresetId = '';
      function saveQuickMode() {
        var name = quickName.value.trim(); if (!name) { quickName.focus(); return; }
        var data = presets(), target = presetAt(data, side);
        if (!target || target.id !== quickPresetId) return notify('预设已变化');
        if (!Array.isArray(target.quickModes)) target.quickModes = [];
        target.quickModes.push({ id: 'mode_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10), name: name,
          enabledModuleIds: target.modules.filter(function (m) { return m.enabled === true; }).map(function (m) { return m.id; }) });
        if (commit(data)) { quickForm.hidden = true; quickName.value = ''; }
      }
      var quickAdd = iconButton('plus', '存为快捷模式', function () { quickPresetId = s.presetId; quickForm.hidden = false; quickName.focus(); });
      quickName.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); saveQuickMode(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); quickForm.hidden = true; }
      });
      quickForm.append(quickName, iconButton('check', '保存快捷模式', saveQuickMode), iconButton('close', '取消', function () { quickForm.hidden = true; }));
      quickBar.append(quickModes, quickAdd);
      var selection = el('div', 'pw-selection'), selectionCount = el('span');
      var selectAll = iconButton('selectAll', '全选', function () {
        var p = presetAt(presets(), side), ids = selectedIds(side); if (!p) return;
        var all = p.modules.every(function (m) { return ids.indexOf(m.id) >= 0; });
        ids.length = 0; if (!all) p.modules.forEach(function (m) { ids.push(m.id); });
        sides[side].moduleId = ids.length ? ids[ids.length - 1] : ''; invalidate(); syncSelection(side); syncLayout();
      });
      var batchButtons = [iconButton('enabled', '批量启用', function () { batchModules(side, 'enable'); }), iconButton('disabled', '批量禁用', function () { batchModules(side, 'disable'); }), iconButton('trash', '批量删除', function () { batchModules(side, 'delete'); })];
      selection.append(selectionCount, selectAll); batchButtons.forEach(function (b) { selection.appendChild(b); });
      selection.appendChild(iconButton('close', '清空选择', function () {
        clearSelection(side); sides[side].moduleId = ''; invalidate(); syncSelection(side); syncLayout();
      }));
      section.append(bar, snapshots, quickBar, quickForm, after, selection);
      if (side === 0) buildSearch(bar, section);
      var list = el('div', 'pw-list'); section.appendChild(list); columns.appendChild(section);
      list.addEventListener('dragover', function (e) {
        if (!drag) return;
        e.preventDefault(); drag.copy = e.ctrlKey || e.altKey; e.dataTransfer.dropEffect = drag.copy ? 'copy' : 'move';
        var position = dropPosition(e, side), active = drag;
        clearDrag(); drag = active;
        var source = panels.find(function (panel) { return panel.select.value === active.presetId; });
        if (source) source.list.querySelectorAll('.pw-module').forEach(function (n) { n.classList.toggle('dragging', n.dataset.moduleId === active.moduleId); });
        if (position.card) position.card.classList.add(position.after ? 'pw-drop-after' : 'pw-drop-before');
        else list.classList.add('pw-drop-end');
      });
      list.addEventListener('dragleave', function (e) {
        if (e.relatedTarget && list.contains(e.relatedTarget)) return;
        list.classList.remove('pw-drop-end');
        list.querySelectorAll('.pw-drop-before, .pw-drop-after').forEach(function (n) { n.classList.remove('pw-drop-before', 'pw-drop-after'); });
      });
      list.addEventListener('drop', function (e) {
        if (!drag) return;
        e.preventDefault();
        drag.copy = e.ctrlKey || e.altKey;
        try { moveModule(side, dropPosition(e, side)); } finally { clearDrag(); }
      });
      panels.push({ section: section, selection: selection, selectionCount: selectionCount, selectAll: selectAll, batchButtons: batchButtons, select: select, after: after, list: list, total: total, quickModes: quickModes, quickAdd: quickAdd, quickForm: quickForm, snapshotButton: snapshotButton, badge: badge, snapshots: snapshots, snapshotName: snapshotInput, snapshotList: snapshotList });
    });
    dialog.appendChild(columns);
    iterationPane = el('section', 'pw-iteration'); iterationPane.setAttribute('aria-label', '智能比对工作台');
    pasteBox = el('section', 'pw-paste-box');
    var pasteTitle = el('div', 'pw-bar'); pasteTitle.appendChild(el('strong', '', '修改稿'));
    var identify = iconButton('compare', '智能识别并比对', compare); identify.classList.add('pw-identify'); identify.appendChild(el('span', '', '智能识别并比对')); pasteTitle.appendChild(identify);
    var area = el('textarea', 'pw-external'); area.placeholder = '粘贴修改稿'; area.setAttribute('aria-label', '修改稿输入');
    area.title = '已选模块优先，未选时自动匹配'; area.addEventListener('input', invalidate);
    panels[0].external = area;
    snippetBar = el('div', 'pw-snippet-lock'); snippetBar.hidden = true; snippetBar.setAttribute('role', 'status');
    snippetLabel = el('span');
    snippetBar.append(snippetLabel, iconButton('close', '取消局部锁定（恢复全模块对比）', function () { clearSnippet(); invalidate(); }));
    pasteBox.append(pasteTitle, snippetBar, area); iterationPane.appendChild(pasteBox);
    var toolbar = el('div', 'pw-bar pw-review-bar'); toolbar.appendChild(el('strong', '', '修改比对'));
    var collapseLabel = el('label', 'pw-check'); collapseInput = el('input'); collapseInput.type = 'checkbox';
    collapseInput.addEventListener('change', function () { diffRows.querySelectorAll('.pw-diff-rows').forEach(function (editor) { editor.classList.toggle('pw-collapse', collapseInput.checked); }); });
    collapseLabel.append(collapseInput, document.createTextNode('折叠未修改')); toolbar.appendChild(collapseLabel);
    saveAllButton = iconButton('check', '保存全部对比结果', saveAllEdited);
    saveAllButton.classList.add('pw-save-all'); saveAllButton.appendChild(el('span', '', '保存全部对比结果')); saveAllButton.disabled = true;
    toolbar.appendChild(saveAllButton);
    var closeReview = iconButton('close', '收起对比', function () { invalidate(); diffRows.replaceChildren(); syncLayout(); });
    closeReview.classList.add('pw-close-review'); toolbar.appendChild(closeReview);
    diffBox = el('section', 'pw-diff'); diffRows = el('div', 'pw-diff-results');
    diffBox.append(toolbar, diffRows); iterationPane.appendChild(diffBox); columns.appendChild(iterationPane);
    var footer = el('footer', 'pw-foot'); status = el('span', 'pw-status'); status.setAttribute('role', 'status');
    footer.appendChild(status); dialog.appendChild(footer);
    function hideSnapshots() { panels.forEach(function (p) { p.snapshots.hidden = true; p.snapshotButton.setAttribute('aria-expanded', 'false'); }); }
    dialog.addEventListener('click', function (e) { if (!e.target.closest('.pw-snapshots, .pw-snapshot-button')) hideSnapshots(); });
    dialog.addEventListener('cancel', function (e) { if (panels.some(function (p) { return !p.snapshots.hidden; })) { e.preventDefault(); hideSnapshots(); } });
    window.addEventListener('resize', function () { panels.forEach(function (_, side) { positionSnapshots(side); }); });
    dialog.addEventListener('scroll', function () { panels.forEach(function (_, side) { positionSnapshots(side); }); });
    // 所有关闭路径（含原生 Escape、宿主返回及直接 close）在清理前统一捕获。
    dialog.addEventListener('close', function () { saveExitDraft(); closeSearch(false); clearSnippet(); hideSnapshots(); clearDrag(); invalidate(); if (opener && opener.isConnected) opener.focus(); });
    dialog.addEventListener('click', function (e) { if (e.target === dialog) { var r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
    document.body.appendChild(dialog);
  }
  // 复制导出与保存提取严格分离：这里保留全部红绿块并附可读标记。
  function serializeDiffCopy(root) {
    function read(node, activeMark) {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1 && node.nodeType !== 11) return '';
      if (node.nodeType === 1 && /^(SCRIPT|STYLE)$/.test(node.tagName)) return '';
      if (node.nodeType === 1 && node.tagName === 'BR') return '\n';
      var mark = node.nodeType === 1 && (node.classList.contains('diff-del') ? 'del' :
        node.classList.contains('diff-add') ? 'add' : null);
      var text = Array.from(node.childNodes).map(function (child) { return read(child, activeMark || mark); }).join('');
      if (node.nodeType === 1) {
        if (mark === 'del' && activeMark !== 'del') return '【-删除：' + text + '-】';
        if (mark === 'add' && activeMark !== 'add') return '【+新增：' + text + '+】';
        if (/^(DIV|P|LI|PRE|BLOCKQUOTE|H[1-6])$/.test(node.tagName) && node.nextSibling && !text.endsWith('\n')) text += '\n';
      }
      return text;
    }
    return read(root, null);
  }
  function selectedDiffCopy(editor) {
    var selection = window.getSelection(), output = [];
    if (!selection || selection.isCollapsed) return null;
    for (var i = 0; i < selection.rangeCount; i++) {
      var range = selection.getRangeAt(i);
      if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
      var fragment = range.cloneContents(), ancestor = range.commonAncestorContainer;
      if (ancestor.nodeType === 3) ancestor = ancestor.parentNode;
      // cloneContents 不含公共祖先：补回选区所在的红/绿外壳，兼容只选半个删除词。
      while (ancestor && ancestor !== editor) {
        var wrapper = ancestor.cloneNode(false); wrapper.appendChild(fragment); fragment = wrapper; ancestor = ancestor.parentNode;
      }
      output.push(serializeDiffCopy(fragment));
    }
    return output.join('\n');
  }
  async function copyDiffResult(editor) {
    var text = serializeDiffCopy(editor), selection = window.getSelection(), ranges = [];
    if (selection) for (var i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); notify('已复制比对'); return; } catch (_) { /* file 协议或权限受限时走原生降级。 */ }
      }
      var area = el('textarea'); area.value = text; area.setAttribute('aria-label', '复制比对');
      area.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;'; dialog.appendChild(area);
      var active = document.activeElement;
      try { area.focus(); area.select(); if (!document.execCommand('copy')) throw new Error('复制失败'); }
      finally { area.remove(); if (active && active.isConnected) active.focus(); if (selection) { selection.removeAllRanges(); ranges.forEach(function (r) { selection.addRange(r); }); } }
      notify('已复制比对');
    } catch (_) { notify('复制失败，请划选复制'); }
  }
  function createDiffEditor() {
    var diffRows = el('div', 'pw-diff-rows pw-diff-box');
    diffRows.setAttribute('contenteditable', 'true'); diffRows.setAttribute('role', 'textbox');
    diffRows.setAttribute('aria-label', '编辑对比结果'); diffRows.setAttribute('aria-multiline', 'true');
    diffRows.addEventListener('copy', function (e) {
      if (!e.clipboardData) return;
      var text = selectedDiffCopy(diffRows);
      if (text === null) return;
      e.clipboardData.setData('text/plain', text); e.preventDefault();
    });
    diffRows.addEventListener('click', function (e) {
      if (window.getSelection() && !window.getSelection().isCollapsed) return;
      var block = e.target.closest('.diff-del, .diff-add');
      if (!block || !diffRows.contains(block)) return;
      var pair = block.closest('.diff-pair');
      var opposite = pair && pair.querySelector(block.classList.contains('diff-del') ? '.diff-add' : '.diff-del');
      if (opposite) {
        if (block.dataset.keep === 'true') return;
        pair.querySelectorAll('.diff-del, .diff-add').forEach(function (part) { part.dataset.keep = String(part === block); });
      } else block.dataset.keep = String(block.dataset.keep !== 'true');
    });
    // 外部富文本只粘贴纯文本，避免引入可执行标签和无关排版。
    diffRows.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    return diffRows;
  }
  async function open() {
    if (opening) return;
    opening = true;
    try {
      if (!dialog) build();
      opener = document.activeElement;
      var snapshot = host.getPresetWorkbenchDraft ? host.getPresetWorkbenchDraft() : null;
      var valid = snapshot && snapshot.version === 1 && Number.isFinite(snapshot.timestamp) &&
        typeof snapshot.presetId === 'string' && Array.isArray(snapshot.drafts) && typeof snapshot.external === 'string';
      var restore = false;
      if (valid) {
        var message = '检测到上次退出时有未保存的工作台进度，是否恢复？';
        restore = await (window.showAppConfirm ? window.showAppConfirm(message, {
          title: '恢复进度', confirmText: '恢复', cancelText: '放弃'
        }) : window.confirm(message));
      }
      textDrafts.clear();
      panels.forEach(function (p, side) { p.list.replaceChildren(); clearSelection(side); p.quickForm.hidden = true; });
      clearSnippet(); invalidate(); workbenchMode = restore && snapshot.mode === 'merge' ? 'merge' : 'iterate';
      panels[0].external.value = restore ? snapshot.external : '';
      if (restore) {
        if (Array.isArray(snapshot.sides)) snapshot.sides.slice(0, 2).forEach(function (s, i) {
          if (s && typeof s.presetId === 'string') sides[i].presetId = s.presetId;
        });
        sides[0].presetId = snapshot.presetId;
        snapshot.drafts.forEach(function (draft) {
          if (!draft || (draft.side !== 0 && draft.side !== 1) || typeof draft.presetId !== 'string' ||
              typeof draft.moduleId !== 'string' || typeof draft.text !== 'string') return;
          textDrafts.set(draftKey(draft.side, draft.presetId, draft.moduleId), draft);
          expanded.add(draft.side + ':' + draft.presetId + ':' + draft.moduleId);
        });
      }
      diffBox.hidden = false; diffRows.replaceChildren(); render();
      if (restore && Array.isArray(snapshot.tasks)) {
        review = [];
        snapshot.tasks.forEach(function (saved) {
          if (!saved || typeof saved.text !== 'string') return;
          var p = presets().find(function (item) { return item.id === saved.presetId; });
          var m = p && p.modules.find(function (item) { return item.id === saved.moduleId; });
          if (!m) return;
          var task = { presetId: p.id, moduleId: m.id, name: m.name || '未命名模块', original: JSON.stringify(m), left: m.content || '', right: saved.text };
          if (saved.snippet && typeof saved.snippet.selectedText === 'string' && locateSnippet(task.left, saved.snippet) >= 0) {
            task.snippet = saved.snippet; task.left = saved.snippet.selectedText;
          } else if (saved.snippet) return;
          review.push(task); renderDiffTask(task);
        });
        saveAllButton.disabled = !review.length; syncLayout();
      }
      if (host.savePresetWorkbenchDraft) host.savePresetWorkbenchDraft(null);
      notify(restore ? '已恢复草稿' : '就绪');
      if (host.closeInputToolbox) host.closeInputToolbox();
      if (!dialog.open) dialog.showModal();
    } finally { opening = false; }
  }
  // 全局监听只注册一次；仅巡检当前 review，不为每张卡片遗留 document 监听器。
  document.addEventListener('selectionchange', function () {
    if (dialog && dialog.open && review) review.forEach(captureDiffSelection);
  });
  document.addEventListener('mousedown', function (e) {
    if (!review) return;
    review.forEach(function (task) {
      if (!task.editor.contains(e.target) && !task.save.contains(e.target)) clearDiffSelection(task);
    });
  }, true);
  document.addEventListener('mychat-preset-imported', function () {
    if (dialog && dialog.open) { invalidate(); render(); }
  });
  window.MyChatPresetWorkbench = { open: open, close: function () { if (dialog) dialog.close(); }, diffTexts: diffTexts };
  var trigger = document.getElementById('open-preset-workbench-btn');
  if (trigger) trigger.addEventListener('click', open);
})();
