/* 多 AI 独立会话会议室：第 1 步仅管理会议与配置，不启动自动接力。 */
(function () {
  'use strict';
  var host = window.MyChat;
  if (!host) return;

  var DEFAULT_CONFERENCE_PROMPT = '当前处于多 AI 协作会议室。每条发言前均带有前端内置身份标签，例如 [发言者：用户]、[发言者：对方名称]。请根据标签识别身份，直接与参会者展开讨论，不要替其他参会者发言。\n\n内置双边暂停协议：若你认为讨论已达成结论、进入瓶颈或需要用户拍板，请先写明需要用户确认的事项，并在回复最末尾单独一行输出 [提议暂停确认]。若对方在上一轮已输出 [提议暂停确认]，且你也同意暂停，请先总结待用户拍板的清单，并在回复最末尾单独一行输出 [同意暂停确认]。系统将自动暂停，等待用户指示。';
  var icons = {
    down: '<path d="m6 9 6 6 6-6"/>',
    edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.1 2.1 0 0 0-3-3L5 16z"/>',
    remove: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    save: '<path d="m5 12 4 4L19 6"/>'
  };
  var records = [], collapsed = false, expanded = new Set();
  var wrap, modal, form, picker, nameInput, promptInput, turnsInput, heading;
  var editingId = null, editingSnapshot = null, selected = new Set(), returnFocus = null;
  var refreshTimer = null;

  function svg(name) {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(icon, title, fn, cls) {
    var node = el('button', cls || 'conference-icon');
    node.type = 'button';
    node.title = title;
    node.setAttribute('aria-label', title);
    node.innerHTML = svg(icon);
    node.addEventListener('click', fn);
    return node;
  }
  function notify(text) { host.showToast(text); }
  function sessions() {
    return host.getSessionIds().map(function (id) { return host.getSessionById(id); }).filter(Boolean);
  }
  function sessionName(session) { return session.title || session.charName || '新对话'; }
  function badge(session) {
    var node = el('span', 'conference-avatar', sessionName(session).slice(0, 1));
    if (typeof session.avatar === 'string' && /^(data:image\/|https?:\/\/|blob:)/i.test(session.avatar)) {
      var image = el('img');
      image.alt = '';
      image.src = session.avatar;
      image.addEventListener('error', function () { image.remove(); });
      node.appendChild(image);
    }
    return node;
  }
  function read() { return host.getConferences(); }
  function valid(record) { return record && typeof record.id === 'string' && Array.isArray(record.participantSessionIds); }
  function commit(next) {
    if (!host.saveConferences(next)) { notify('保存失败，请重试'); return false; }
    records = next;
    render();
    return true;
  }
  function reloadFromStorage() {
    records = read();
    // 云恢复和事务回滚都会使编辑基线失效，禁止旧草稿覆盖恢复结果。
    if (modal && !modal.hidden) close();
    render();
  }
  async function removeRecord(id) {
    var original = read().find(function (item) { return item && item.id === id; });
    if (!original) return;
    var snapshot = JSON.stringify(original);
    var accepted = await window.showAppConfirm('删除此会议？', { title: '删除会议', danger: true });
    if (!accepted) return;
    var current = read();
    var live = current.find(function (item) { return item && item.id === id; });
    if (!live || JSON.stringify(live) !== snapshot) { notify('会议已更新，请重试'); return; }
    if (commit(current.filter(function (item) { return !item || item.id !== id; }))) {
      expanded.delete(id);
      if (editingId === id && modal && !modal.hidden) close();
      notify('已删除会议');
    }
  }
  function render() {
    if (!wrap) return;
    wrap.replaceChildren();
    var list = records.filter(valid);
    var head = el('button', 'session-group-head is-collapsible conference-group-head');
    head.type = 'button';
    head.title = collapsed ? '展开会议收录夹' : '收起会议收录夹';
    head.setAttribute('aria-expanded', String(!collapsed));
    head.innerHTML = svg('down');
    head.firstChild.classList.add('session-group-caret');
    head.firstChild.classList.toggle('is-collapsed', collapsed);
    head.append(el('span', 'session-group-label', '会议收录夹'), el('span', 'session-group-count', String(list.length)));
    head.addEventListener('click', function () { collapsed = !collapsed; render(); });
    wrap.appendChild(head);
    if (collapsed) return;
    if (!list.length) { wrap.appendChild(el('div', 'conference-empty', '暂无会议')); return; }
    list.forEach(function (record) {
      var item = el('div', 'conference-item');
      var row = el('div', 'conference-row');
      var title = el('button', 'conference-title', record.title || '未命名会议');
      title.type = 'button';
      title.title = record.title || '编辑会议';
      title.addEventListener('click', function () { open(record.id); });
      var down = button('down', '展开参会 AI', function () {
        if (expanded.has(record.id)) expanded.delete(record.id); else expanded.add(record.id);
        render();
      });
      down.setAttribute('aria-expanded', String(expanded.has(record.id)));
      down.title = expanded.has(record.id) ? '收起参会 AI' : '展开参会 AI';
      down.setAttribute('aria-label', down.title);
      down.classList.toggle('is-expanded', expanded.has(record.id));
      row.append(title, button('edit', '编辑会议', function () { open(record.id); }),
        button('remove', '删除会议', function () { void removeRecord(record.id); }), down);
      item.appendChild(row);
      if (expanded.has(record.id)) {
        var members = el('div', 'conference-members');
        record.participantSessionIds.forEach(function (id) {
          var session = host.getSessionById(id);
          if (!session) { members.appendChild(el('div', 'conference-empty', '对话已删除')); return; }
          var member = el('button', 'conference-member');
          member.type = 'button';
          member.title = '打开原对话：' + sessionName(session);
          member.append(badge(session), el('span', 'conference-member-name', sessionName(session)));
          member.addEventListener('click', function () { host.selectSession(id); });
          members.appendChild(member);
        });
        item.appendChild(members);
      }
      wrap.appendChild(item);
    });
  }
  function renderPicker() {
    picker.replaceChildren();
    sessions().forEach(function (session) {
      var row = el('label', 'conference-choice');
      var toggle = el('span', 'ui-switch ui-switch-sm');
      var input = el('input');
      input.type = 'checkbox';
      input.checked = selected.has(session.id);
      input.setAttribute('aria-label', sessionName(session));
      input.addEventListener('change', function () {
        if (input.checked) selected.add(session.id); else selected.delete(session.id);
      });
      toggle.append(input, el('span', 'ui-switch-track'));
      row.append(badge(session), el('span', 'conference-member-name', sessionName(session)), toggle);
      picker.appendChild(row);
    });
    if (!picker.childElementCount) picker.appendChild(el('div', 'conference-empty', '暂无对话'));
  }
  function close() {
    if (!modal) return;
    modal.hidden = true;
    modal.classList.remove('show');
    editingId = null;
    editingSnapshot = null;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }
  function ensureModal() {
    if (modal) return;
    modal = el('div', 'modal modal-overlay ui-modal-overlay conference-modal');
    modal.id = 'conference-modal';
    modal.hidden = true;
    var card = el('section', 'modal-card ui-modal-card conference-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'conference-modal-title');
    var header = el('header', 'ui-modal-header');
    heading = el('strong', '', '新建会议');
    heading.id = 'conference-modal-title';
    header.append(heading, button('close', '关闭', close, 'ui-modal-close'));
    form = el('form', 'conference-form');
    nameInput = el('input', 'input');
    nameInput.id = 'conference-name';
    nameInput.required = true;
    nameInput.maxLength = 100;
    var nameLabel = el('label', 'conference-field', '会议名称');
    nameLabel.htmlFor = nameInput.id;
    nameLabel.appendChild(nameInput);
    var memberHead = el('div', 'conference-section-head');
    memberHead.appendChild(el('span', '', '参会 AI（至少 2 个）'));
    memberHead.appendChild(button('plus', '新建空白 AI 对话并加入', function () {
      try {
        var session = host.createEmptySession('空白 AI');
        if (!session) { notify('新建失败，请重试'); return; }
        selected.add(session.id);
        renderPicker();
        notify('已加入空白 AI');
      } catch (err) { notify('新建失败，请重试'); }
    }));
    picker = el('div', 'conference-picker');
    picker.id = 'conference-participant-picker';
    var promptHead = el('div', 'conference-section-head');
    var promptLabel = el('label', '', '会议提示词');
    promptLabel.htmlFor = 'conference-prompt';
    promptHead.append(promptLabel, button('reset', '恢复默认', function () { promptInput.value = DEFAULT_CONFERENCE_PROMPT; }));
    promptInput = el('textarea', 'input');
    promptInput.id = 'conference-prompt';
    promptInput.rows = 7;
    turnsInput = el('input', 'input');
    turnsInput.id = 'conference-max-turns';
    turnsInput.type = 'number';
    turnsInput.min = '1';
    turnsInput.max = '20';
    turnsInput.step = '1';
    turnsInput.required = true;
    var turnsLabel = el('label', 'conference-turns', '接力轮数');
    turnsLabel.htmlFor = turnsInput.id;
    turnsLabel.appendChild(turnsInput);
    var footer = el('div', 'conference-footer');
    var save = button('save', '保存会议', function () { form.requestSubmit(); });
    footer.append(turnsLabel, button('close', '取消', close), save);
    form.append(nameLabel, memberHead, picker, promptHead, promptInput, footer);
    form.addEventListener('submit', saveForm);
    card.append(header, form);
    modal.appendChild(card);
    document.body.appendChild(modal);
    var backdropPressed = false;
    modal.addEventListener('pointerdown', function (event) { backdropPressed = event.target === modal; });
    modal.addEventListener('click', function (event) { if (event.target === modal && backdropPressed) close(); backdropPressed = false; });
    modal.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      var nodes = Array.from(card.querySelectorAll('button, input, textarea')).filter(function (node) { return !node.disabled; });
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }
  function open(id) {
    ensureModal();
    var record = id ? read().find(function (item) { return item && item.id === id; }) : null;
    if (id && !valid(record)) { notify('会议不存在'); return; }
    editingId = record ? record.id : null;
    editingSnapshot = record ? JSON.stringify(record) : null;
    selected = new Set(record ? record.participantSessionIds : []);
    heading.textContent = record ? '编辑会议' : '新建会议';
    nameInput.value = record ? record.title || '' : '';
    promptInput.value = record && typeof record.systemPrompt === 'string' ? record.systemPrompt : DEFAULT_CONFERENCE_PROMPT;
    turnsInput.value = record ? record.maxTurns || 4 : 4;
    renderPicker();
    returnFocus = document.activeElement;
    modal.hidden = false;
    modal.classList.add('show');
    nameInput.focus();
  }
  function saveForm(event) {
    event.preventDefault();
    var title = nameInput.value.trim();
    var ids = Array.from(selected).filter(function (id) { return !!host.getSessionById(id); });
    var turns = Number(turnsInput.value);
    if (!title) { notify('请输入会议名称'); nameInput.focus(); return; }
    if (ids.length < 2) { notify('至少选择 2 个 AI'); return; }
    if (!Number.isInteger(turns) || turns < 1 || turns > 20) { notify('轮数范围为 1～20'); return; }
    var current = read();
    var old = editingId ? current.find(function (item) { return item && item.id === editingId; }) : null;
    if (editingId && (!old || JSON.stringify(old) !== editingSnapshot)) { notify('会议已更新，请重开'); return; }
    var now = Date.now();
    var record = Object.assign({}, old || {
      id: 'conference_' + now + '_' + Math.random().toString(36).slice(2, 10),
      messages: [], pendingRetry: null, createdAt: now
    }, { title: title, participantSessionIds: ids, systemPrompt: promptInput.value, maxTurns: turns, updatedAt: now });
    if (old) current[current.indexOf(old)] = record; else current.unshift(record);
    if (commit(current)) { close(); notify(old ? '会议已更新' : '会议已创建'); }
  }
  function init() {
    wrap = document.getElementById('conference-list-wrap');
    var entry = document.getElementById('btn-new-conference');
    if (!wrap || !entry) return;
    entry.addEventListener('click', function () { open(); });
    reloadFromStorage();
    window.addEventListener('mychat-context-changed', function () {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function () { render(); }, 120);
    });
  }
  window.MyChatConference = { open: open, reloadFromStorage: reloadFromStorage, DEFAULT_CONFERENCE_PROMPT: DEFAULT_CONFERENCE_PROMPT };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
