/* 报错日志基础设施：前置加载，仅内存保留，不落盘或同步。 */
(function () {
  'use strict';
  if (window.MyChatErrorConsole) return;
  var capacity = 200, buffer = new Array(capacity), start = 0, size = 0, sequence = 0;
  var unreadCount = 0, capturing = false, pendingRender = false;
  var modal, list, previousFocus, filter = 'all';
  var expanded = new Set();
  var labels = { error: '运行报错', rejection: 'Promise异常', console: 'Console报错' };
  var originalError = window.console.error;

  // 异常对象可能带有抛错 getter、循环引用或 BigInt，采集失败不得影响业务。
  function get(value, key) {
    try { return value == null ? undefined : value[key]; } catch (ignore) { return undefined; }
  }
  function text(value) {
    try { return String(value); } catch (ignore) { return '[无法读取]'; }
  }
  function format(value) {
    if (typeof value === 'string') return value;
    var message = get(value, 'message');
    if (message !== undefined) return text(message);
    if (value && typeof value === 'object') {
      try {
        var seen = new WeakSet();
        return JSON.stringify(value, function (key, item) {
          if (typeof item === 'bigint') return text(item) + 'n';
          if (item && typeof item === 'object') {
            if (seen.has(item)) return '[循环引用]';
            seen.add(item);
          }
          return item;
        }) || text(value);
      } catch (ignore) { return text(value); }
    }
    return text(value);
  }
  function records() {
    var result = [];
    for (var i = size - 1; i >= 0; i--) result.push(buffer[(start + i) % capacity]);
    return result;
  }
  function updateBadge() {
    var badge = document.getElementById('error-console-unread');
    var button = document.getElementById('toolbox-error-console-btn');
    if (badge) { badge.hidden = unreadCount === 0; badge.textContent = text(unreadCount); }
    if (button) button.setAttribute('aria-label', '报错日志' + (unreadCount ? '，未读' + unreadCount + '条' : ''));
  }
  function scheduleRender() {
    if (!modal || !modal.classList.contains('show') || pendingRender) return;
    pendingRender = true;
    window.setTimeout(function () {
      pendingRender = false;
      try { if (modal.classList.contains('show')) render(); } catch (ignore) { /* 不递归记录界面内部失败 */ }
    }, 0);
  }
  function capture(type, message, source, stack) {
    if (capturing) return;
    capturing = true;
    try {
      var now = new Date();
      var time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(function (n) { return text(n).padStart(2, '0'); }).join(':');
      var entry = Object.freeze({ id: ++sequence, time: time, type: type, message: text(message), source: text(source || ''), stack: text(stack || '') });
      if (size === capacity) { expanded.delete(buffer[start].id); buffer[start] = entry; start = (start + 1) % capacity; }
      else { buffer[(start + size) % capacity] = entry; size++; }
      unreadCount++;
      updateBadge(); scheduleRender();
    } catch (ignore) { /* 静默采集，不遮断原错误处理 */ }
    finally { capturing = false; }
  }
  window.addEventListener('error', function (event) {
    // 只记录运行时错误，不把图片等资源加载失败误当作 JS 异常。
    if (!('message' in event)) return;
    var source = event.filename ? event.filename + ':' + (event.lineno || 0) + ':' + (event.colno || 0) : '';
    capture('error', event.message || format(event.error), source, get(event.error, 'stack'));
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    var stack = get(reason, 'stack');
    capture('rejection', format(reason), sourceFromStack(stack), stack);
  });
  window.console.error = function () {
    var args = arguments;
    try {
      if (!capturing) {
        capturing = true;
        var messages = [], stacks = [];
        try {
          for (var i = 0; i < args.length; i++) {
            messages.push(format(args[i]));
            var stack = get(args[i], 'stack');
            if (stack) stacks.push(text(stack));
          }
        } finally { capturing = false; }
        // 无 Error 参数时仍记录调用位置，剔除包装器自身的栈帧。
        if (!stacks.length) {
          var callStack = text(new Error().stack || '').split('\n');
          stacks.push(callStack.slice(2).join('\n'));
        }
        capture('console', messages.join(' '), sourceFromStack(stacks[0]), stacks.join('\n\n'));
      }
    } catch (ignore) { /* 原生控制台输出始终保留 */ }
    finally { originalError.apply(window.console, args); }
  };
  function sourceFromStack(stack) {
    var match = text(stack || '').match(/(?:https?:\/\/|file:\/\/\/)[^\s)]+:\d+(?::\d+)?/);
    return match ? match[0] : '';
  }
  function notify(message) {
    if (typeof window.showToast === 'function') window.showToast(message);
    else if (window.MyChat && typeof window.MyChat.showToast === 'function') window.MyChat.showToast(message);
  }
  function serialize(entries) {
    return entries.map(function (entry) {
      return '[' + entry.time + '] [' + labels[entry.type] + '] ' + entry.message +
        (entry.source ? '\n源码：' + entry.source : '') + (entry.stack ? '\n' + entry.stack : '');
    }).join('\n\n');
  }
  async function copy(entries) {
    if (!entries.length) return;
    var value = serialize(entries), done = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(value); done = true; } } catch (ignore) { /* file 协议回退 */ }
    if (!done) {
      var field = document.createElement('textarea'), focus = document.activeElement;
      field.className = 'error-console-copy-field'; field.value = value; field.readOnly = true;
      modal.querySelector('.error-console-card').appendChild(field);
      try { field.select(); done = document.execCommand('copy'); } catch (ignore) { /* 由提示反馈 */ }
      finally { field.remove(); if (focus && focus.isConnected) focus.focus({ preventScroll: true }); }
    }
    notify(done ? '已复制报错日志' : '复制失败，请重试');
  }
  function svg(path) {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }
  function iconButton(title, path, action) {
    var button = document.createElement('button');
    button.type = 'button'; button.className = 'ui-modal-close'; button.title = title;
    button.setAttribute('aria-label', title); button.innerHTML = svg(path);
    button.addEventListener('click', action); return button;
  }
  var copyIcon = '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>';
  function render() {
    var scrollTop = list.scrollTop, fragment = document.createDocumentFragment();
    var entries = records().filter(function (entry) { return filter === 'all' || entry.type === filter; });
    entries.forEach(function (entry) {
      var row = document.createElement('article'); row.className = 'error-console-entry';
      var details = document.createElement('details'); details.open = expanded.has(entry.id);
      var summary = document.createElement('summary');
      var meta = document.createElement('span'); meta.className = 'error-console-meta';
      var time = document.createElement('time'); time.textContent = entry.time;
      var tag = document.createElement('span'); tag.className = 'error-console-type'; tag.textContent = labels[entry.type];
      meta.append(time, tag);
      var message = document.createElement('span'); message.className = 'error-console-message'; message.textContent = entry.message;
      var source = document.createElement('span'); source.className = 'error-console-source'; source.textContent = entry.source || '来源未知';
      summary.append(meta, message, source);
      var stack = document.createElement('pre'); stack.textContent = entry.stack || '暂无堆栈详情';
      details.append(summary, stack);
      details.addEventListener('toggle', function () { if (details.open) expanded.add(entry.id); else expanded.delete(entry.id); });
      var button = iconButton('复制', copyIcon, function () { copy([entry]); });
      button.classList.add('error-console-entry-copy'); row.append(details, button); fragment.appendChild(row);
    });
    if (!entries.length) {
      var empty = document.createElement('p'); empty.className = 'error-console-empty';
      empty.textContent = size ? '该分类暂无报错' : '当前暂无报错记录'; fragment.appendChild(empty);
    }
    list.replaceChildren(fragment); list.scrollTop = scrollTop;
  }
  function close() {
    if (!modal) return;
    modal.classList.remove('show'); modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true');
    if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
  }
  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div'); modal.id = 'error-console-modal';
    modal.className = 'modal modal-overlay ui-modal-overlay error-console-modal hidden';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = '<section class="modal-card ui-modal-card error-console-card" role="dialog" aria-modal="true" aria-labelledby="error-console-title"><header class="ui-modal-header"><h2 id="error-console-title">报错日志</h2><div class="error-console-actions"></div></header><div class="error-console-filters" role="group" aria-label="报错分类"></div><div class="error-console-list"></div></section>';
    var actions = modal.querySelector('.error-console-actions');
    actions.append(iconButton('复制全部', copyIcon, function () { copy(records()); }),
      iconButton('清空日志', '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>', function () {
        if (!size) return;
        buffer = new Array(capacity); start = 0; size = 0; unreadCount = 0; expanded.clear();
        updateBadge(); render(); notify('已清空日志');
      }), iconButton('关闭', '<path d="m6 6 12 12M18 6 6 18"/>', close));
    var filters = modal.querySelector('.error-console-filters');
    ['all', 'error', 'rejection', 'console'].forEach(function (type) {
      var button = document.createElement('button'); button.type = 'button';
      button.textContent = type === 'all' ? '全部' : labels[type]; button.setAttribute('aria-pressed', text(type === filter));
      button.addEventListener('click', function () {
        filter = type;
        Array.from(filters.children).forEach(function (child) { child.setAttribute('aria-pressed', text(child === button)); });
        render(); list.scrollTop = 0;
      }); filters.appendChild(button);
    });
    list = modal.querySelector('.error-console-list');
    modal.addEventListener('click', function (event) { if (event.target === modal) close(); });
    modal.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      var controls = Array.from(modal.querySelectorAll('button,summary'));
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.body.appendChild(modal);
  }
  function open() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', open, { once: true }); return; }
    ensureModal();
    if (!modal.classList.contains('show')) previousFocus = document.activeElement;
    if (window.MyChat && window.MyChat.closeComposerPanels) window.MyChat.closeComposerPanels();
    unreadCount = 0; updateBadge(); render();
    modal.classList.remove('hidden'); modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false');
    modal.querySelector('button').focus();
  }
  function bindEntry() {
    var button = document.getElementById('toolbox-error-console-btn');
    if (button) button.addEventListener('click', open);
    updateBadge();
  }
  window.MyChatErrorConsole = Object.freeze({ open: open,
    get unreadCount() { return unreadCount; },
    getLogs: function () { return records(); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindEntry, { once: true });
  else bindEntry();
})();
