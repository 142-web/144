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
    snippetLabel.textContent = '🎯 已锁定局部片段（' + Array.from(selectedText).length + ' 字）— 粘贴新内容将仅对比并替换该选中段落';
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
    review = null;
    if (saveAllButton) saveAllButton.disabled = true;
    if (diffRows) diffRows.querySelectorAll('.pw-save-diff').forEach(function (button) { button.disabled = true; });
  }
  function commit(list, preserveReview) {
    // list 只改公共桥返回的副本；重新读取宿主旧库，绝不把修改稿当作撤销快照。
    var previous = clone(presets()), history = undoStack.slice();
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
    var current = clone(presets()), previous = clone(source[source.length - 1]);
    try {
      if (!host.applyPresetWorkbenchChanges(previous)) throw new Error('恢复失败');
    } catch (_) { notify('恢复失败，请重试'); return; }
    source.pop(); target.push(current); if (target.length > 30) target.shift();
    clearSnippet(); invalidate(); render(); notify(redo ? '已恢复下一步' : '已返回上一步');
  }
  function undo() { restoreHistory(false); }
  function syncSelection(side) {
    var panel = panels[side], ids = selectedIds(side);
    panel.selection.hidden = !ids.length;
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
  function editModule(side, presetId, original, change) {
    var list = presets(), p = presetAt(list, side);
    var m = p && p.id === presetId && p.modules.find(function (item) { return item.id === original.id; });
    if (!m || JSON.stringify(m) !== JSON.stringify(original)) return notify('模块已变化，请重新展开');
    if (change(m) === false) return false;
    return commit(list);
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
  function buildEditor(body, side, p, m) {
    var mode = el('select', 'pw-content-mode'); mode.setAttribute('aria-label', '编辑模式');
    ['text', 'wordlist'].forEach(function (value) { var o = el('option', '', value === 'text' ? '普通文本' : '词库胶囊'); o.value = value; mode.appendChild(o); });
    mode.value = m.contentType === 'wordlist' ? 'wordlist' : 'text';
    mode.addEventListener('change', function () {
      editModule(side, p.id, m, function (target) { target.contentType = mode.value; if (mode.value === 'wordlist') ensureGroups(target); });
    });
    body.appendChild(mode);
    if (m.contentType !== 'wordlist') {
      var editor = el('textarea', 'pw-content'); editor.value = m.content; editor.setAttribute('aria-label', '模块正文');
      editor.addEventListener('input', function () {
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
        if (activeTask) {
          if (saveEdited(activeTask)) {
            var latest = presets().find(function (item) { return item.id === p.id; });
            var saved = latest && latest.modules.find(function (item) { return item.id === m.id; });
            if (saved) editor.value = saved.content;
          }
          return;
        }
        editModule(side, p.id, m, function (target) { if (target.content === editor.value) { notify('正文未修改'); return false; } target.content = editor.value; });
      });
      saveText.classList.add('pw-save-text'); saveText.appendChild(el('span', '', '保存文本框修改'));
      bar.appendChild(saveText);
      body.append(editor, bar); return;
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
  function paragraphs(text) { return text.match(/[^\r\n]+(?:\r?\n(?![\t ]*\r?\n)[^\r\n]+)*(?:\r?\n[\t ]*)*|[\r\n]+/g) || []; }
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
  function inlineDiff(a, b) {
    var ta = tokens(a), tb = tokens(b), start = 0, endA = ta.length, endB = tb.length;
    // 公共首尾先直通，长句删短也不受中间编辑矩阵上限影响。
    while (start < endA && start < endB && ta[start] === tb[start]) start++;
    while (endA > start && endB > start && ta[endA - 1] === tb[endB - 1]) { endA--; endB--; }
    var ops = lcsOps(ta.slice(start, endA), tb.slice(start, endB), 180000);
    if (!ops) ops = [{ type: 'del', text: ta.slice(start, endA).join('') }, { type: 'add', text: tb.slice(start, endB).join('') }];
    if (start) ops.unshift({ type: 'same', text: ta.slice(0, start).join('') });
    if (endA < ta.length) ops.push({ type: 'same', text: ta.slice(endA).join('') });
    // 两处变化之间仅一两个未改字符时，连为一个局部高亮区。
    for (var i = 1; i < ops.length - 1; i++) {
      if (ops[i].type === 'same' && Array.from(ops[i].text).length <= 2 && ops[i - 1].type !== 'same' && ops[i + 1].type !== 'same') ops[i].type = 'bridge';
    }
    var groups = [];
    ops.forEach(function (op) {
      var same = op.type === 'same', last = groups[groups.length - 1];
      if (!last || (last.type === 'same') !== same) { last = { type: same ? 'same' : 'change', left: '', right: '' }; groups.push(last); }
      if (op.type !== 'add') last.left += op.text;
      if (op.type !== 'del') last.right += op.text;
    });
    return groups;
  }
  function diffTexts(left, right) {
    left = String(left); right = String(right);
    var a = paragraphs(left), b = paragraphs(right), fast = Math.max(left.length, right.length) > 15000 || a.length * b.length > 90000;
    var rows = [], i = 0, j = 0;
    function row(x, y, kind) {
      rows.push({ left: x, right: y, kind: kind, parts: kind === 'rewrite' ? inlineDiff(x, y) : null });
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
        var s = i < a.length && j < b.length ? scores[i * b.length + j] : 0;
        if (s >= 0.4 && Math.abs(dp[i * width + j] - s - dp[(i + 1) * width + j + 1]) < 0.000001) { row(a[i], b[j], a[i] === b[j] ? 'same' : 'rewrite'); i++; j++; }
        else if (j < b.length && (i === a.length || dp[i * width + j + 1] >= dp[(i + 1) * width + j])) row('', b[j++], 'add');
        else row(a[i++], '', 'del');
      }
    } else {
      // 超长输入有限前瞻对齐；命中段落仍走有界逐字比对。
      while (i < a.length || j < b.length) {
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
    return { rows: rows, fast: fast };
  }
  function render() {
    var list = presets();
    undoButton.disabled = !undoStack.length; redoButton.disabled = !redoStack.length;
    [[undoButton, undoStack, '上一步'], [redoButton, redoStack, '下一步']].forEach(function (entry) {
      entry[0].querySelector('.pw-history-badge').textContent = entry[1].length;
      entry[0].title = entry[2] + '（' + entry[1].length + ' 步）';
    });
    sides.forEach(function (s, side) {
      var p = presetAt(list, side), panel = panels[side];
      if (!p) { s.presetId = list.length ? list[Math.min(side, list.length - 1)].id : ''; s.moduleId = ''; clearSelection(side); p = presetAt(list, side); }
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
          dragArmed = e.button === 0 && !!e.target.closest('.pw-grip, .pw-pick strong') &&
            !e.target.closest('textarea, input, select, [contenteditable="true"], .module-content, .wb-editor, .pw-module-body');
          card.draggable = dragArmed;
        });
        function disarm() { dragArmed = false; card.draggable = false; }
        card.addEventListener('mouseup', disarm); card.addEventListener('mouseleave', disarm);
        card.addEventListener('dragstart', function (e) {
          if (!dragArmed || !e.dataTransfer || String(window.getSelection()).length > 0 || e.target.closest('textarea, input, select, [contenteditable="true"], .pw-module-body')) {
            e.preventDefault(); e.stopPropagation(); return;
          }
          drag = { presetId: p.id, moduleId: m.id, original: JSON.stringify(m), copy: e.ctrlKey || e.altKey };
          e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', m.id);
          card.classList.add('dragging');
        });
        card.addEventListener('dragend', clearDrag);
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
    var list = presets(), leftPreset = presetAt(list, 0), rightPreset = presetAt(list, 1), tasks = [];
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
      } else tasks = leftPreset ? matchPasted(chosen && chosen.length ? { id: leftPreset.id, modules: chosen } : leftPreset, pasted) : [];
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
    tasks.forEach(renderDiffTask); diffBox.hidden = false; syncLayout();
    notify(tasks.length > 1 ? '多模块对比已就绪' : '对比已就绪');
  }
  function renderDiffTask(task) {
    var result = diffTexts(task.left, task.right), card = el('article', 'pw-diff-card');
    var head = el('header', 'pw-bar'), title = el('strong', '', task.snippet ? '[局部片段] 保存至：' + task.name : '保存至模块：' + task.name);
    var save = iconButton('check', '保存此模块', function () { saveEdited(task); });
    save.appendChild(el('span', '', '保存此模块'));
    var copy = iconButton('copy', '复制比对结果（含红绿标记）', function () { copyDiffResult(task.editor); });
    copy.classList.add('pw-copy-diff');
    save.classList.add('pw-save-diff'); head.append(title, copy, save);
    var editor = createDiffEditor(); task.editor = editor; task.save = save;
    card.append(head, editor); diffRows.appendChild(card);
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
  function saveReviewTasks(tasks, all) {
    if (!review || !tasks.length) return false;
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
      var resolved = extractMergedText(task.editor), nextSnippet = null;
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
    });
    // commit 的 render 已用最新库重建上方文本框；下方编辑器不重建，保留手调和红绿裁决。
    notify(all ? '已将对比结果全部保存到对应模块' : '已保存到目标模块');
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
      selection.append(selectionCount, iconButton('close', '清空选择', function () {
        clearSelection(side); s.moduleId = ''; invalidate(); syncSelection(side); syncLayout();
      })); selection.hidden = true;
      section.append(bar, snapshots, quickBar, quickForm, after, selection);
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
      panels.push({ section: section, selection: selection, selectionCount: selectionCount, select: select, after: after, list: list, total: total, quickModes: quickModes, quickAdd: quickAdd, quickForm: quickForm, snapshotButton: snapshotButton, badge: badge, snapshots: snapshots, snapshotName: snapshotInput, snapshotList: snapshotList });
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
    dialog.addEventListener('close', function () { clearSnippet(); hideSnapshots(); clearDrag(); invalidate(); if (opener && opener.isConnected) opener.focus(); });
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
    var diffRows = el('div', 'pw-diff-rows');
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
  function open() {
    if (!dialog) build();
    opener = document.activeElement; clearSnippet(); invalidate(); render();
    panels.forEach(function (p, side) { clearSelection(side); p.quickForm.hidden = true; });
    workbenchMode = 'iterate'; panels[0].external.value = '';
    diffBox.hidden = false; diffRows.replaceChildren(); render(); notify('就绪');
    if (host.closeInputToolbox) host.closeInputToolbox();
    if (!dialog.open) dialog.showModal();
  }
  document.addEventListener('mychat-preset-imported', function () {
    if (dialog && dialog.open) { invalidate(); render(); }
  });
  window.MyChatPresetWorkbench = { open: open, close: function () { if (dialog) dialog.close(); }, diffTexts: diffTexts };
  var trigger = document.getElementById('open-preset-workbench-btn');
  if (trigger) trigger.addEventListener('click', open);
})();
