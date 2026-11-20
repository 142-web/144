/* 插件库：仅修饰正文 DOM，不改消息原文、发送管道或云端数据。 */
(function () {
  'use strict';
  var bridge = window.MyChat;
  if (!bridge) return;
  var registry = new Map();
  var config = readConfig();
  var modal, search, list, status, previousFocus;
  var chat, observer, timer = 0, active = false, dialogueActive = false, periodActive = false;
  var pending = new Set();
  var bodySelector = '.bubble .md-body, .bubble .msg-text';
  var excluded = 'pre,code,a,textarea,input,script,style,details,summary,.cot-box,.cot-content,.plugin-dialogue-quote,button,svg,iframe,.tavern-sandbox-wrap,[contenteditable="true"]';
  var quotePattern = /“[^”\n]+”|"[^"\n]+"/g;

  function readConfig() {
    var value = bridge.getPluginsConfig();
    var result = Object.create(null);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.keys(value).forEach(function (id) { result[id] = value[id] === true; });
    }
    return result;
  }
  function svg(paths) {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var quoteIcon = svg('<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z"/><path d="M8 8h2v3H8l-1 2m7-5h2v3h-2l-1 2"/>');

  // 注册项仅接受受信任的本地代码，iconSvg 不是外部导入内容。
  function register(plugin) {
    if (!plugin || !/^[a-z][a-z0-9_-]*$/.test(plugin.id) || registry.has(plugin.id) ||
        typeof plugin.name !== 'string' || typeof plugin.description !== 'string' ||
        typeof plugin.iconSvg !== 'string' || typeof plugin.onEnable !== 'function' ||
        typeof plugin.onDisable !== 'function') throw new Error('插件注册无效');
    var entry = Object.freeze(Object.assign({}, plugin));
    registry.set(entry.id, entry);
    if (config[entry.id] === true) entry.onEnable();
    if (list) renderList();
    return entry;
  }
  function setEnabled(id, enabled) {
    var plugin = registry.get(id);
    if (!plugin) return false;
    enabled = enabled === true;
    if ((config[id] === true) === enabled) return true;
    var next = Object.assign(Object.create(null), config);
    next[id] = enabled;
    if (!bridge.savePluginsConfig(next)) {
      if (status) status.textContent = '保存失败，请重试';
      return false;
    }
    try {
      (enabled ? plugin.onEnable : plugin.onDisable)();
      config = next;
      if (status) status.textContent = '';
      return true;
    } catch (err) {
      bridge.savePluginsConfig(config);
      try { (enabled ? plugin.onDisable : plugin.onEnable)(); } catch (ignore) { /* 尽力复原 */ }
      if (status) status.textContent = '切换失败，请重试';
      console.warn('插件切换失败：', err);
      return false;
    }
  }

  function unwrap(scope) {
    var parents = new Set();
    scope.querySelectorAll('.plugin-dialogue-quote').forEach(function (span) {
      var parent = span.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(span.textContent), span);
      parents.add(parent);
    });
    parents.forEach(function (parent) { parent.normalize(); });
  }
  function processBody(body) {
    if (!chat.contains(body) || body.closest(excluded)) return;
    if (periodActive) removePeriodBreaks(body);
    if (dialogueActive) processDialogueBody(body);
    if (periodActive) processPeriodBody(body);
  }
  function processDialogueBody(body) {
    var nodes = [];
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return node.parentElement && !node.parentElement.closest(excluded) && /[“"]/.test(node.data)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var text = node.data, match, offset = 0;
      var fragment = document.createDocumentFragment();
      quotePattern.lastIndex = 0;
      while ((match = quotePattern.exec(text))) {
        fragment.appendChild(document.createTextNode(text.slice(offset, match.index)));
        var span = document.createElement('span');
        span.className = 'plugin-dialogue-quote';
        span.textContent = match[0];
        fragment.appendChild(span);
        offset = match.index + match[0].length;
      }
      if (!offset) return;
      fragment.appendChild(document.createTextNode(text.slice(offset)));
      node.parentNode.replaceChild(fragment, node);
    });
  }
  function collect(node) {
    var element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || !chat.contains(element)) return;
    var body = element.closest(bodySelector);
    if (body) pending.add(body);
    element.querySelectorAll(bodySelector).forEach(function (item) { pending.add(item); });
  }
  function receive(records) {
    records.forEach(function (record) {
      collect(record.target);
      record.addedNodes && record.addedNodes.forEach(collect);
    });
    if (pending.size && !timer) timer = setTimeout(flush, 50);
  }
  function observe() {
    observer.observe(chat, { childList: true, characterData: true, subtree: true });
  }
  function flush() {
    clearTimeout(timer); timer = 0;
    if (!active) return;
    // 纳入尚未回调的外部更新，再断开监听，避免自身包裹触发循环。
    receive(observer.takeRecords());
    clearTimeout(timer); timer = 0;
    observer.disconnect();
    try { pending.forEach(processBody); }
    finally { pending.clear(); if (active) observe(); }
  }
  function removePeriodBreaks(scope) {
    var parents = new Set();
    scope.querySelectorAll('.plugin-period-break').forEach(function (span) {
      var parent = span.parentNode;
      if (parent) { span.remove(); parents.add(parent); }
    });
    parents.forEach(function (parent) { parent.normalize(); });
  }
  function processPeriodBody(body) {
    // 只接受明确的 AI 楼层；现宿主使用 .msg-ai，用户及未知角色一律跳过。
    if (!body.closest('.msg-ai, .msg.assistant, .message.assistant, [data-role="assistant"]') ||
        body.closest('.msg-user, .msg.user, .message.user, [data-role="user"]')) return;
    var skip = excluded.replace(', .plugin-dialogue-quote', '').replace('.plugin-dialogue-quote,', '') + ',h1,h2,h3,h4,h5,h6,table';
    var blocks = 'p,div,li,blockquote,td,th,dd';
    var groups = new Map();
    function hasBreakAfter(node, block) {
      // Range 在文本末尾或行内父级之外都可能留下标记，逐层检查紧邻节点。
      while (node && node !== block) {
        var next = node.nextSibling;
        while (next && next.nodeType === 3 && !next.data) next = next.nextSibling;
        if (next) return next.nodeType === 1 && next.classList.contains('plugin-period-break');
        node = node.parentNode;
      }
      return false;
    }
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.parentElement || node.parentElement.closest(skip)) return NodeFilter.FILTER_REJECT;
        // 隐藏文本不能被当作段尾后的正文，避免凭空增加段尾间距。
        var parent = node.parentElement;
        while (parent && body.contains(parent)) {
          var style = getComputedStyle(parent);
          if (parent.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return NodeFilter.FILTER_REJECT;
          if (parent === body) break;
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var block = node.parentElement.closest(blocks) || body;
      if (!body.contains(block)) block = body;
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(node);
    }
    groups.forEach(function (nodes, block) {
      var text = '', offsets = [];
      nodes.forEach(function (node) { offsets.push(text.length); text += node.data; });
      var pattern = /。+[”"’'」』）)\]】》>〕}]*/g, match, points = [];
      while ((match = pattern.exec(text))) {
        var at = match.index + match[0].length, rest = text.slice(at);
        if (!rest.trim() || /^\s*\n/.test(rest)) continue;
        var index = nodes.length - 1;
        while (index > 0 && offsets[index] >= at) index--;
        var target = nodes[index], offset = at - offsets[index];
        // 跨行内闭合标点已由整段匹配吞并；边界仍有闭合标点时宁可不换行。
        if (offset === target.data.length) {
          if (nodes[index + 1] && /^[”"’'」』）)\]】》>〕}]/.test(nodes[index + 1].data)) continue;
          if (hasBreakAfter(target, block)) continue;
        }
        // BR、嵌套块或禁区之间不是同一连续正文，不跨越这些边界换行。
        var range = document.createRange(); range.setStart(target, offset);
        var next = index;
        while (next < nodes.length && !nodes[next].data.slice(next === index ? offset : 0).trim()) next++;
        if (next >= nodes.length) continue;
        range.setEnd(nodes[next], nodes[next].data.length);
        var fragment = range.cloneContents();
        if (fragment.querySelector(skip + ',br,' + blocks + ',.plugin-period-break')) continue;
        points.push({ node: target, offset: offset });
      }
      points.reverse().forEach(function (point) {
        if (point.offset === point.node.data.length && hasBreakAfter(point.node, block)) return;
        var range = document.createRange(); range.setStart(point.node, point.offset); range.collapse(true);
        var span = document.createElement('span'); span.className = 'plugin-period-break'; span.setAttribute('aria-hidden', 'true');
        range.insertNode(span);
      });
    });
  }
  function startObserver() {
    if (active) return;
    // 兼容标准 chat-box；现有宿主正文容器实际命名为 chat-area。
    chat = document.getElementById('chat-box') || document.getElementById('chat-area');
    if (!chat) throw new Error('聊天区域未就绪');
    active = true;
    observer = new MutationObserver(receive);
    collect(chat);
    flush();
  }
  function updateEffects() {
    if (observer) observer.disconnect();
    clearTimeout(timer); timer = 0; pending.clear();
    removePeriodBreaks(document);
    if (!dialogueActive) unwrap(document);
    active = false;
    if (dialogueActive || periodActive) startObserver();
  }
  function enableDialogue() { dialogueActive = true; updateEffects(); }
  function disableDialogue() { dialogueActive = false; updateEffects(); }
  function enablePeriod() { periodActive = true; updateEffects(); }
  function disablePeriod() { periodActive = false; updateEffects(); }

  function renderList() {
    list.replaceChildren();
    var keyword = search.value.trim().toLocaleLowerCase();
    registry.forEach(function (plugin) {
      if (!(plugin.name + ' ' + plugin.description).toLocaleLowerCase().includes(keyword)) return;
      var card = document.createElement('article');
      card.className = 'plugin-hub-item';
      var icon = document.createElement('div');
      icon.className = 'plugin-hub-icon'; icon.innerHTML = plugin.iconSvg;
      var text = document.createElement('div'); text.className = 'plugin-hub-copy';
      var name = document.createElement('strong'); name.textContent = plugin.name;
      var description = document.createElement('p');
      description.textContent = plugin.summary || plugin.description;
      description.title = plugin.description;
      text.append(name, description);
      var toggle = document.createElement('input');
      toggle.type = 'checkbox'; toggle.className = 'plugin-hub-toggle';
      toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', plugin.name);
      toggle.title = '启用 / 关闭' + plugin.name; toggle.checked = config[plugin.id] === true;
      toggle.addEventListener('change', function () {
        if (!setEnabled(plugin.id, toggle.checked)) toggle.checked = config[plugin.id] === true;
      });
      card.append(icon, text, toggle); list.appendChild(card);
    });
    if (!list.childElementCount) {
      var empty = document.createElement('p'); empty.className = 'plugin-hub-empty';
      empty.textContent = '没有找到匹配的插件'; list.appendChild(empty);
    }
  }
  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div');
    // 同时使用 modal，接入宿主侧滑返回；modal-overlay 接入全局浮层门禁。
    modal.id = 'plugin-hub-modal'; modal.className = 'modal modal-overlay plugin-hub-modal hidden';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = '<section class="modal-card plugin-hub-card" role="dialog" aria-modal="true" aria-labelledby="plugin-hub-title">' +
      '<header><h2 id="plugin-hub-title">插件库</h2><button type="button" data-action="close" title="关闭" aria-label="关闭">' +
      svg('<path d="m6 6 12 12M18 6 6 18"/>') + '</button></header>' +
      '<label class="plugin-hub-search">' + svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>') +
      '<input type="search" placeholder="搜索插件" aria-label="搜索插件" autocomplete="off"></label>' +
      '<div class="plugin-hub-list"></div><p class="plugin-hub-status" role="status"></p></section>';
    search = modal.querySelector('input'); list = modal.querySelector('.plugin-hub-list');
    status = modal.querySelector('.plugin-hub-status');
    modal.querySelector('[data-action="close"]').addEventListener('click', closeModal);
    modal.addEventListener('click', function (event) { if (event.target === modal) closeModal(); });
    search.addEventListener('input', renderList);
    modal.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeModal(); }
      if (event.key !== 'Tab') return;
      var controls = Array.from(modal.querySelectorAll('button,input'));
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.body.appendChild(modal);
  }
  function openModal() {
    ensureModal();
    if (modal.classList.contains('show')) return;
    previousFocus = document.activeElement;
    if (bridge.closeComposerPanels) bridge.closeComposerPanels();
    search.value = ''; status.textContent = ''; renderList();
    modal.classList.remove('hidden'); modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false'); search.focus();
  }
  function closeModal() {
    if (!modal) return;
    modal.classList.remove('show'); modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  }

  window.MyChatPlugins = Object.freeze({ register: register, setEnabled: setEnabled,
    isEnabled: function (id) { return config[id] === true; }, openModal: openModal, closeModal: closeModal });
  register({ id: 'dialogue_highlight', name: '人物对话美化',
    description: '将聊天正文里双引号（“...”和"..."）内的角色对话变为醒目护眼的橙色字体，方便区分对话与旁白。',
    summary: '双引号对话显示为橙色', iconSvg: quoteIcon, onEnable: enableDialogue, onDisable: disableDialogue });
  register({ id: 'period_auto_newline', name: '句号自动换行',
    description: '仅在前端显示时于AI回复的句号后自动换行并增加轻微间距，不修改实际保存的文本，也不影响发给AI的上下文。',
    summary: 'AI句号换行，轻微间距',
    iconSvg: svg('<path d="M20 5v6a4 4 0 0 1-4 4H4m4-4-4 4 4 4M4 5h10"/>'),
    onEnable: enablePeriod, onDisable: disablePeriod });
  // 纯 DOM 插件不注册空字符串钩子，由共享观察器覆盖会话、历史及流式重绘。
  var entryButton = document.getElementById('toolbox-plugins-btn');
  if (entryButton) entryButton.addEventListener('click', function () { window.MyChatPlugins.openModal(); });
})();
