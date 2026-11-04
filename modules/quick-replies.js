/* 快速回复：本地短语管理；复用真实输入框与标准发送流程，不直接调用 API。 */
(function () {
  'use strict';
  var M = window.MyChat;
  if (!M) return;
  var wrap = document.getElementById('quick-reply-wrap');
  var btn = document.getElementById('quick-reply-btn');
  var panel = document.getElementById('quick-reply-panel');
  var input = document.getElementById('input');
  var data;
  function uid() { return 'quick_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9); }
  function normalize(raw) {
    var items = Array.isArray(raw) ? raw : raw && raw.items;
    if (!Array.isArray(items)) items = ['继续推进剧情', '展开描写环境与心理细节', '总结当前进度与待办'];
    return { mode: raw && raw.mode === 'append' ? 'append' : 'send', items: items.map(function (item) {
      return typeof item === 'string' ? { id: uid(), text: item } : item;
    }).filter(function (item) { return item && typeof item.text === 'string' && item.text.trim(); }).map(function (item) { return { id: item.id || uid(), text: item.text }; }) };
  }
  function reload() { data = normalize(M.getQuickReplies()); render(); }
  function save() {
    try { M.saveQuickReplies(data); render(); return true; }
    catch (err) { void window.showAppAlert('保存失败：' + err.message); reload(); return false; }
  }
  function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  var draggedId = null;
  function positionPanel() {
    if (panel.hidden) return;
    panel.style.left = '0px';
    var rect = panel.getBoundingClientRect();
    var chat = wrap.closest('.chat-main') || document.getElementById('chat-area');
    var bounds = chat ? chat.getBoundingClientRect() : { left: 0, right: window.innerWidth };
    var left = Math.max(12, bounds.left + 12);
    var right = Math.min(document.documentElement.clientWidth - 12, bounds.right - 12);
    panel.style.maxWidth = Math.max(0, Math.min(window.innerWidth - 24, right - left)) + 'px';
    rect = panel.getBoundingClientRect();
    panel.style.left = (Math.max(left, Math.min(rect.left, right - rect.width)) - rect.left) + 'px';
  }
  function icon(name) {
    var paths = {
      add: '<path d="M8 3v10M3 8h10"/>',
      edit: '<path d="m10 2 4 4-8 8H2v-4zM8.5 3.5l4 4"/>',
      remove: '<path d="M2 4h12M6 2h4M4 4l1 10h6l1-10M6.5 6v5M9.5 6v5"/>',
      ok: '<path d="m3 8 3 3 7-7"/>',
      cancel: '<path d="m4 4 8 8M12 4l-8 8"/>',
      grip: '<g fill="currentColor" stroke="none"><circle cx="6" cy="3" r="1"/><circle cx="10" cy="3" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="13" r="1"/><circle cx="10" cy="13" r="1"/></g>'
    };
    return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
  }
  function iconButton(name, title, action) {
    var b = button('', title, action); b.className = 'qr-icon-btn'; b.innerHTML = icon(name); return b;
  }
  function button(text, title, action) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title || text;
    b.setAttribute('aria-label', title || text); b.className = 'btn-secondary'; b.onclick = action; return b;
  }
  async function fire(text) {
    var send = document.getElementById('btn-send');
    if (data.mode === 'send' && (send.disabled || send.textContent.trim() === '停止')) { M.showToast('请先等待当前回复完成'); return; }
    if (data.mode === 'send' && input.value.trim() && !await window.showAppConfirm('替换草稿并发送？')) return;
    if (data.mode === 'send' && (send.disabled || send.textContent.trim() === '停止')) return;
    var expanded = M.replaceMacros(text, M.getCurrentSession());
    input.value = data.mode === 'append' ? input.value + expanded : expanded;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close(); input.focus();
    if (data.mode === 'send') send.click();
  }
  function render() {
    panel.replaceChildren();
    var head = document.createElement('div'); head.className = 'quick-reply-head';
    var mode = document.createElement('select'); mode.setAttribute('aria-label', '快捷短语触发动作');
    [['send', '点击直发'], ['append', '追加输入']].forEach(function (entry) {
      var o = document.createElement('option'); o.value = entry[0]; o.textContent = entry[1]; mode.appendChild(o);
    });
    mode.value = data.mode; mode.onchange = function () { data.mode = mode.value; save(); };
    head.append(mode, iconButton('add', '新增快速回复', function () {
      editor(null);
    })); panel.appendChild(head);
    var list = document.createElement('div'); list.className = 'quick-reply-list';
    if (!data.items.length) { var empty = document.createElement('p'); empty.textContent = '暂无短语'; list.appendChild(empty); }
    data.items.forEach(function (item, index) {
      var row = document.createElement('div'); row.className = 'quick-reply-row qr-item';
      row.draggable = true; row.dataset.id = item.id; row.dataset.index = index;
      var grip = document.createElement('span'); grip.className = 'qr-grip'; grip.title = '拖动排序'; grip.innerHTML = icon('grip');
      row.addEventListener('dragstart', function (e) {
        draggedId = item.id; row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id);
      });
      row.addEventListener('dragover', function (e) {
        if (!draggedId || draggedId === item.id) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        var after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
        row.classList.toggle('drop-after', after); row.classList.toggle('drop-before', !after);
      });
      row.addEventListener('dragleave', function () { row.classList.remove('drop-before', 'drop-after'); });
      row.addEventListener('drop', function (e) {
        if (!draggedId || draggedId === item.id) return;
        e.preventDefault(); e.stopPropagation();
        var from = data.items.findIndex(function (entry) { return entry.id === draggedId; });
        var to = data.items.indexOf(item);
        if (from < 0 || to < 0) return;
        if (e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2) to++;
        var moved = data.items.splice(from, 1)[0];
        if (from < to) to--;
        data.items.splice(to, 0, moved); draggedId = null; save();
      });
      row.addEventListener('dragend', function () {
        draggedId = null;
        list.querySelectorAll('.qr-item').forEach(function (node) { node.classList.remove('is-dragging', 'drop-before', 'drop-after'); });
      });
      var trigger = button(item.text, '触发：' + item.text, function () { fire(item.text); }); trigger.className = 'quick-reply-text';
      row.append(grip, trigger, iconButton('edit', '编辑', function () { editor(item); }), iconButton('remove', '删除', async function () {
        if (await window.showAppConfirm('删除这条快捷短语？')) {
          var currentIndex = data.items.findIndex(function (entry) { return entry.id === item.id; });
          if (currentIndex >= 0) { data.items.splice(currentIndex, 1); save(); }
        }
      })); list.appendChild(row);
    }); panel.appendChild(list);
  }
  function editor(item) {
    render();
    var form = document.createElement('form'); form.className = 'quick-reply-editor';
    var text = document.createElement('textarea'); text.rows = 3; text.placeholder = '输入快捷短语'; text.setAttribute('aria-label', '快捷短语内容'); text.value = item ? item.text : '';
    var ok = iconButton('ok', '保存', function () {
      if (!text.value.trim()) { text.focus(); return; }
      if (item) item.text = text.value; else data.items.push({ id: uid(), text: text.value });
      save();
    });
    form.onsubmit = function (e) { e.preventDefault(); ok.click(); };
    text.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ok.click(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); render(); }
    });
    form.append(text, ok, iconButton('cancel', '取消', render)); panel.prepend(form); positionPanel(); text.focus();
  }
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!panel.hidden) { close(); return; }
    M.closeComposerPanels(); render(); panel.hidden = false; positionPanel(); btn.setAttribute('aria-expanded', 'true');
  });
  window.addEventListener('resize', positionPanel);
  // 捕获其他底部入口，兼容宿主在冒泡阶段 stopPropagation 的工具箱按钮。
  document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) { close(); btn.focus(); } });
  window.MyChatQuickReplies = { reload: reload, close: close };
  reload();
  // 首次预置只持久化一次，不在云端恢复时覆盖显式空列表。
  if (M.getQuickReplies() === null) save();
})();
