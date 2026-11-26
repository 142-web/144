/* 多 AI 独立会话会议室：独立视图、顺序同步与可恢复接力。 */
(function () {
  'use strict';
  var host = window.MyChat;
  if (!host) return;

  var DEFAULT_CONFERENCE_PROMPT = '当前处于多 AI 协作会议室。每条发言前均带有前端内置身份标签，例如 [发言者：用户]、[发言者：对方名称]。请根据标签识别身份，直接与参会者展开讨论，不要替其他参会者发言。\n\n内置双边暂停协议：若你认为讨论已达成结论、进入瓶颈或需要用户拍板，请先写明需要用户确认的事项，并在回复最末尾单独一行输出 [提议暂停确认]。若对方在上一轮已输出 [提议暂停确认]，且你也同意暂停，请先总结待用户拍板的清单，并在回复最末尾单独一行输出 [同意暂停确认]。系统将自动暂停，等待用户指示。';
  DEFAULT_CONFERENCE_PROMPT += '\n\n参会 AI 在进入会议室前的记忆彼此并不互通。允许并鼓励你在开场或需要时主动询问对方“之前在聊什么 / 当前的目标与背景是什么”，先对齐信息，再展开讨论。';
  var icons = {
    send: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
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
  var activeId = null, stage, timeline, statusBar, stageTitle, stageMembers, receiver, relayTurns, draft, sendButton, pauseButton, retryButton;
  var jobs = new Map(), drafts = new Map();

  function currentRecord(id) { return read().find(function (r) { return valid(r) && r.id === id; }); }
  function normalize(record) {
    if (!Array.isArray(record.messages)) record.messages = [];
    if (!record.syncState || typeof record.syncState !== 'object') record.syncState = {};
    return record;
  }
  function contextKey(session) { return session.id + ':' + (session.activeSubChatId || ''); }
  function lastUser(session) {
    var list = session && session.messages || [];
    for (var i = list.length - 1; i >= 0; i--) if (list[i].role === 'user') return list[i];
    return null;
  }
  function persist(record) {
    var list = read(), index = list.findIndex(function (r) { return r && r.id === record.id; });
    if (index < 0) return false;
    // 配置允许在等待回复时修改，调度器只覆盖自身运行字段。
    var next = Object.assign({}, list[index]);
    ['messages', 'syncState', 'pendingRetry', 'proposePause', 'status', 'statusText'].forEach(function (key) { next[key] = record[key]; });
    next.updatedAt = Date.now();
    list[index] = next;
    if (!commit(list)) return false;
    Object.assign(record, next);
    renderStage();
    return true;
  }
  function leaveStage() {
    if (draft && activeId) drafts.set(activeId, draft.value);
    activeId = null;
    if (stage) { stage.hidden = true; stage.parentElement.classList.remove('is-conference-view'); }
  }
  function jump(id) { leaveStage(); host.selectSession(id); }
  function showStage(id) {
    var record = currentRecord(id);
    if (!record) { notify('会议不存在'); return; }
    if (draft && activeId) drafts.set(activeId, draft.value);
    activeId = id;
    stage.hidden = false;
    stage.parentElement.classList.add('is-conference-view');
    draft.value = drafts.get(id) || '';
    relayTurns.value = record.maxTurns || 4;
    receiver.dataset.conference = '';
    renderStage();
    var mask = document.getElementById('sidebar-mask');
    if (mask) mask.click();
  }
  function ensureStage() {
    stage = document.getElementById('conference-stage');
    if (!stage) return;
    var head = el('header', 'conference-stage-head');
    stageTitle = el('strong', 'conference-stage-title');
    stageMembers = el('div', 'conference-stage-members');
    head.append(stageTitle, button('settings', '会议设置', function () { open(activeId); }), stageMembers);
    timeline = el('div', 'conference-timeline');
    timeline.setAttribute('role', 'log');
    statusBar = el('div', 'conference-status');
    statusBar.setAttribute('role', 'status');
    var composer = el('form', 'conference-composer');
    var controls = el('div', 'conference-controls');
    receiver = el('select'); receiver.id = 'conference-receiver';
    var who = el('label', '', '发给谁'); who.appendChild(receiver);
    relayTurns = el('input'); relayTurns.id = 'conference-relay-turns';
    relayTurns.type = 'number'; relayTurns.min = '1'; relayTurns.max = '20'; relayTurns.value = '4';
    var count = el('label', '', '接力轮数'); count.appendChild(relayTurns);
    controls.append(who, count);
    draft = el('textarea'); draft.id = 'conference-input'; draft.rows = 2;
    draft.placeholder = '输入会议消息'; draft.setAttribute('aria-label', '会议消息');
    var row = el('div', 'conference-input-row');
    retryButton = button('reset', '恢复会议', function () { void resume(activeId); });
    retryButton.id = 'conference-resume';
    sendButton = button('send', '发送', function () { composer.requestSubmit(); }); sendButton.id = 'conference-send';
    pauseButton = button('pause', '暂停', function () { requestPause(activeId); }); pauseButton.id = 'conference-pause';
    row.append(draft, retryButton, sendButton, pauseButton);
    composer.append(controls, row);
    composer.addEventListener('submit', function (event) { event.preventDefault(); void send(activeId); });
    draft.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
    });
    stage.append(head, timeline, statusBar, composer);
  }
  function renderStage() {
    if (!activeId || !stage) return;
    var record = currentRecord(activeId);
    if (!record) { leaveStage(); return; }
    normalize(record);
    stageTitle.textContent = record.title || '未命名会议';
    stageMembers.replaceChildren();
    record.participantSessionIds.forEach(function (id) {
      var session = host.getSessionById(id);
      if (!session) return;
      var member = el('button', 'conference-member'); member.type = 'button';
      member.title = '打开原对话：' + sessionName(session);
      member.append(badge(session), el('span', 'conference-member-name', sessionName(session)));
      member.addEventListener('click', function () { jump(id); }); stageMembers.appendChild(member);
    });
    var oldValue = receiver.value;
    receiver.replaceChildren();
    record.participantSessionIds.forEach(function (id) {
      var session = host.getSessionById(id);
      if (session) { var option = el('option', '', sessionName(session)); option.value = id; receiver.appendChild(option); }
    });
    if (receiver.dataset.conference === activeId && record.participantSessionIds.includes(oldValue)) receiver.value = oldValue;
    receiver.dataset.conference = activeId;
    var previousTop = timeline.scrollTop;
    var nearBottom = timeline.scrollHeight - previousTop - timeline.clientHeight < 70;
    timeline.replaceChildren();
    record.messages.forEach(function (message) {
      var row = el('article', 'conference-message');
      var session = message.sessionId && host.getSessionById(message.sessionId);
      var name = message.role === 'user' ? '用户' : message.name || (session && sessionName(session)) || 'AI';
      var avatar = el(message.sessionId ? 'button' : 'span', 'conference-speaker');
      avatar.appendChild(badge(session || { title: name }));
      if (message.sessionId) { avatar.type = 'button'; avatar.title = '打开原对话：' + name; avatar.addEventListener('click', function () { jump(message.sessionId); }); }
      var body = el('div', 'conference-message-main'), content = el('div', 'md-body');
      content.innerHTML = host.renderMarkdown(String(message.content || ''), message.role, session || undefined);
      body.append(el('strong', 'conference-speaker-name', name), content); row.append(avatar, body); timeline.appendChild(row);
    });
    if (!record.messages.length) timeline.appendChild(el('div', 'conference-empty', '开始会议讨论'));
    timeline.scrollTop = nearBottom ? timeline.scrollHeight : previousTop;
    statusBar.textContent = record.statusText || '';
    statusBar.hidden = !record.statusText;
    statusBar.classList.toggle('is-error', record.status === 'error');
    statusBar.classList.toggle('is-agreed', record.status === 'agreed');
    var running = jobs.has(activeId);
    retryButton.disabled = running || !record.pendingRetry;
    retryButton.classList.toggle('is-ready', !retryButton.disabled);
    sendButton.hidden = running; pauseButton.hidden = !running;
    sendButton.disabled = !!record.pendingRetry;
    receiver.disabled = relayTurns.disabled = draft.disabled = running;
  }
  function identity(message) { return '[发言者：' + (message.role === 'user' ? '用户' : message.name || 'AI') + '] ' + message.content; }
  function checkpoint(record, targetId, remaining, total, turn) {
    var session = host.getSessionById(targetId);
    if (!session) throw new Error('参会对话已删除');
    var key = contextKey(session), sync = record.syncState[key] || { cursor: 0, prompt: false };
    var unseen = record.messages.slice(sync.cursor);
    var parts = unseen.map(identity);
    if (!sync.prompt) parts.unshift(record.systemPrompt || DEFAULT_CONFERENCE_PROMPT);
    return { targetSessionId: targetId, remainingTurns: remaining, totalTurns: total, turn: turn,
      mode: 'send', text: parts.join('\n'), syncKey: key, cursor: record.messages.length,
      subChatId: session.activeSubChatId || '', userId: null, userContent: null };
  }
  function requestPause(id) {
    var job = jobs.get(id); if (!job) return;
    job.stop = true;
    var record = job.record;
    record.status = 'pausing'; record.statusText = '已请求暂停，当前轮结束后停止';
    persist(record); notify('已请求暂停');
  }
  async function send(id) {
    if (jobs.has(id)) return;
    var record = currentRecord(id), text = draft.value.trim(), turns = Number(relayTurns.value);
    if (!record || !text) return;
    normalize(record);
    if (record.pendingRetry) { notify('请先恢复会议'); return; }
    if (!Number.isInteger(turns) || turns < 1 || turns > 20) { notify('轮数范围为 1～20'); return; }
    var target = receiver.value;
    if (record.participantSessionIds.filter(function (sid) { return !!host.getSessionById(sid); }).length < 2) { notify('至少需要 2 个 AI'); return; }
    record.messages.push({ role: 'user', name: '用户', content: text, createdAt: Date.now() });
    record.proposePause = false;
    try { record.pendingRetry = checkpoint(record, target, turns, turns, 1); }
    catch (err) { notify(err.message); return; }
    record.status = 'ready'; record.statusText = '';
    if (!persist(record)) return;
    draft.value = ''; drafts.set(id, '');
    await execute(record);
  }
  async function resume(id) {
    if (jobs.has(id)) return;
    var record = currentRecord(id);
    if (!record || !record.pendingRetry) return;
    normalize(record);
    await execute(record);
  }
  async function execute(record) {
    var job = { stop: false, record: record }; jobs.set(record.id, job);
    try {
      while (record.pendingRetry && jobs.get(record.id) === job) {
        var pending = record.pendingRetry, session = host.getSessionById(pending.targetSessionId);
        if (!session || (session.activeSubChatId || '') !== pending.subChatId) throw new Error('原对话分区已变更，请切回后恢复');
        if (pending.mode === 'retry') {
          var user = lastUser(session);
          if (!user || user.id !== pending.userId || user.content !== pending.userContent) throw new Error('原对话已更新，无法安全重试');
        }
        record.status = 'running';
        record.statusText = '正在等待 ' + sessionName(session) + ' 回复…（第 ' + pending.turn + '/' + pending.totalTurns + ' 轮）';
        if (!persist(record)) return;
        var promise;
        if (pending.mode === 'retry') promise = host.retryLastInSessionAndWait(pending.targetSessionId);
        else {
          var previous = lastUser(session);
          promise = host.sendToSessionAndWait(pending.targetSessionId, pending.text);
          // 等待式桥同步追加 user；先固化重试身份，刷新页面也不会重复发送。
          var appended = lastUser(session);
          if (appended && appended !== previous) {
            pending.mode = 'retry'; pending.userId = appended.id; pending.userContent = appended.content;
            record.syncState[pending.syncKey] = { cursor: pending.cursor, prompt: true };
          }
        }
        var checkpointSaved = persist(record);
        var result = await promise;
        if (jobs.get(record.id) !== job || !currentRecord(record.id)) return;
        if (!checkpointSaved) throw new Error('存储失败，请恢复会议');
        if (!result || result.error || result.aborted || !String(result.content || '').trim()) {
          var reason = result && result.error;
          throw new Error(reason === 'CHANNEL_BUSY' ? '参会对话正在生成，请稍后恢复' : result && result.aborted ? '回复已中断，可恢复会议' : '回复失败，可恢复会议' + (reason ? '：' + String(reason).slice(0, 160) : ''));
        }
        record.messages.push({ role: 'assistant', sessionId: session.id, name: sessionName(session), content: result.content, createdAt: Date.now() });
        // 自己生成的回复已在原对话中，不应在下一棒再回灌自身。
        record.syncState[pending.syncKey] = { cursor: record.messages.length, prompt: true };
        var agreed = record.proposePause === true && /\[同意暂停确认\]\s*$/.test(result.content);
        record.proposePause = !agreed && /\[提议暂停确认\]\s*$/.test(result.content);
        var remaining = pending.remainingTurns - 1;
        record.pendingRetry = null;
        if (!agreed && remaining > 0) {
          var participants = record.participantSessionIds;
          var nextId = participants[(participants.indexOf(session.id) + 1) % participants.length];
          record.pendingRetry = checkpoint(record, nextId, remaining, pending.totalTurns, pending.turn + 1);
        }
        if (agreed) {
          record.status = 'agreed'; record.statusText = '双方已达成一致并暂停，请确认上述事项后继续指示';
          notify(record.statusText);
        } else if (job.stop) {
          record.status = 'paused'; record.statusText = '会议已暂停';
        } else if (!record.pendingRetry) {
          record.status = 'done'; record.statusText = '本次接力已完成';
        }
        if (!persist(record) || agreed || job.stop) break;
      }
    } catch (err) {
      if (jobs.get(record.id) === job) {
        record.status = 'error'; record.statusText = err.message || '会议中断，可恢复会议';
        persist(record); notify(record.statusText);
      }
    } finally {
      if (jobs.get(record.id) === job) jobs.delete(record.id);
      renderStage();
    }
  }

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
    jobs.clear();
    records = read();
    var interrupted = false;
    records.forEach(function (record) {
      if (valid(record) && record.pendingRetry && (record.status === 'running' || record.status === 'pausing')) {
        record.status = 'error'; record.statusText = '会议已中断，可恢复会议'; interrupted = true;
      }
    });
    if (interrupted && !host.saveConferences(records)) notify('保存失败，请重试');
    // 云恢复和事务回滚都会使编辑基线失效，禁止旧草稿覆盖恢复结果。
    if (modal && !modal.hidden) close();
    render();
    renderStage();
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
      jobs.delete(id);
      if (activeId === id) leaveStage();
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
      title.addEventListener('click', function () { showStage(record.id); });
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
          member.addEventListener('click', function () { jump(id); });
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
    if (commit(current)) {
      close();
      if (activeId === record.id && !jobs.has(record.id)) relayTurns.value = turns;
      renderStage(); notify(old ? '会议已更新' : '会议已创建');
    }
  }
  function init() {
    wrap = document.getElementById('conference-list-wrap');
    var entry = document.getElementById('btn-new-conference');
    if (!wrap || !entry) return;
    ensureStage();
    window.addEventListener('mychat-session-selected', leaveStage);
    var sessionList = document.getElementById('session-list');
    if (sessionList) sessionList.addEventListener('click', function (event) { if (event.target.closest('.session-item')) leaveStage(); }, true);
    entry.addEventListener('click', function () { open(); });
    reloadFromStorage();
    window.addEventListener('mychat-context-changed', function () {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function () { render(); }, 120);
    });
  }
  window.MyChatConference = { open: open, show: showStage, reloadFromStorage: reloadFromStorage, DEFAULT_CONFERENCE_PROMPT: DEFAULT_CONFERENCE_PROMPT };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
