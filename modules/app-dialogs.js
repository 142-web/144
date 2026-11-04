/* 应用内异步弹窗与全局遮罩守卫：无存储、无外部依赖。 */
(function () {
  'use strict';

  // === [ANCHOR: MODAL_GESTURE_GUARD] 动态遮罩统一手势校验 ===
  var pressed = null;
  var released = null;
  var touchPending = false;
  // 仅将遮罩本身视作目标，不拦截卡片、输入框或内部按钮。
  function mask(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target.matches('.modal, .local-tools-overlay, .local-tools-modal, .app-dialog-overlay, [data-modal-overlay]')) return target;
    if (target.querySelector(':scope > [role="dialog"], :scope > [role="alertdialog"]')) return target;
    return null;
  }
  function reset() { pressed = null; released = null; touchPending = false; }
  window.addEventListener('mousedown', function (event) {
    if (touchPending && event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents) return;
    touchPending = false;
    pressed = event.button === 0 ? mask(event.target) : null;
    released = null;
  }, true);
  window.addEventListener('mouseup', function (event) {
    if (touchPending) return;
    released = event.button === 0 && pressed === mask(event.target) ? pressed : null;
  }, true);
  window.addEventListener('touchstart', function (event) {
    reset();
    touchPending = true;
    pressed = event.touches.length === 1 ? mask(event.target) : null;
  }, { capture: true, passive: true });
  window.addEventListener('touchend', function (event) {
    var point = event.changedTouches[0];
    var target = point && document.elementFromPoint(point.clientX, point.clientY);
    released = event.touches.length === 0 && pressed === mask(target) ? pressed : null;
  }, { capture: true, passive: true });
  window.addEventListener('click', function (event) {
    var target = mask(event.target);
    var valid = target && target === pressed && target === released;
    reset();
    if (target && !valid) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener('blur', reset);
  window.addEventListener('dragstart', reset, true);
  window.addEventListener('touchcancel', reset, true);
  document.addEventListener('visibilitychange', function () { if (document.hidden) reset(); });

  // === [ANCHOR: APP_DIALOGS] Promise 队列与键盘 / 焦点管理 ===
  var queue = [];
  var active = null;
  var root = null;
  var title;
  var message;
  var input;
  var accept;
  var cancel;
  var serial = 0;

  function iconButton(label, path) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-dialog-button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"></path></svg>';
    return button;
  }
  function ensureRoot() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'app-dialog-overlay';
    root.hidden = true;
    var card = document.createElement('div');
    card.className = 'app-dialog-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'app-dialog-title');
    card.setAttribute('aria-describedby', 'app-dialog-message');
    title = document.createElement('h2');
    title.id = 'app-dialog-title';
    message = document.createElement('p');
    message.id = 'app-dialog-message';
    input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('aria-label', '输入内容');
    input.autocomplete = 'off';
    var actions = document.createElement('div');
    actions.className = 'app-dialog-actions';
    cancel = iconButton('取消', 'M6 6l12 12M18 6L6 18');
    accept = iconButton('确定', 'M5 12l4 4L19 6');
    accept.classList.add('app-dialog-accept');
    actions.append(cancel, accept);
    card.append(title, message, input, actions);
    root.appendChild(card);
    document.body.appendChild(root);
    cancel.addEventListener('click', function () { finish(false); });
    accept.addEventListener('click', function () { finish(true); });
    root.addEventListener('click', function (event) { if (event.target === root) finish(false); });
  }
  function focus(element) {
    if (element && element.isConnected && !element.disabled && !element.closest('[hidden], [inert], [aria-hidden="true"]')) {
      try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
    }
  }
  function next() {
    if (active || !queue.length || !document.body) return;
    ensureRoot();
    active = queue.shift();
    active.previousFocus = document.activeElement;
    title.textContent = active.options.title || (active.kind === 'confirm' ? '确认操作' : active.kind === 'prompt' ? '输入内容' : '提示');
    message.textContent = active.message;
    input.hidden = active.kind !== 'prompt';
    input.value = active.value;
    input.placeholder = active.options.placeholder || '';
    cancel.hidden = active.kind === 'alert';
    accept.title = active.options.confirmText || '确定';
    accept.setAttribute('aria-label', accept.title);
    cancel.title = active.options.cancelText || '取消';
    cancel.setAttribute('aria-label', cancel.title);
    // 复用主题危险色，每次显示都重置，避免队列样式泄漏。
    accept.style.color = active.options.danger ? 'var(--danger, #d14343)' : '';
    root.hidden = false;
    reset();
    focus(input.hidden ? accept : input);
    if (!input.hidden) input.select();
  }
  function finish(ok) {
    if (!active) return;
    var item = active;
    active = null;
    root.hidden = true;
    reset();
    focus(item.previousFocus);
    item.resolve(item.kind === 'prompt' ? (ok ? input.value : null) : item.kind === 'confirm' ? ok : undefined);
    // 先让调用方的 await 继续，再显示后续排队弹窗。
    Promise.resolve().then(next);
  }
  function enqueue(kind, text, value, options) {
    if (text && typeof text === 'object' && !Array.isArray(text)) {
      options = Object.assign({}, text);
      text = options.message;
      if (kind === 'prompt') value = options.defaultValue;
    } else {
      options = Object.assign({}, options || {});
    }
    return new Promise(function (resolve) {
      queue.push({ id: ++serial, kind: kind, message: String(text == null ? '' : text), value: String(value == null ? '' : value), options: options || {}, resolve: resolve });
      next();
    });
  }
  window.showAppConfirm = function (text, options) { return enqueue('confirm', text, '', options); };
  window.showAppPrompt = function (text, defaultValue, options) { return enqueue('prompt', text, defaultValue, options); };
  window.showAppAlert = function (text, options) { return enqueue('alert', text, '', options); };

  // 捕获阶段阻止 Esc / Enter 穿透到底层模态与宿主快捷键。
  window.addEventListener('keydown', function (event) {
    if (!active) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); finish(false);
    } else if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); event.stopImmediatePropagation(); finish(event.target !== cancel);
    } else if (event.key === 'Tab') {
      var items = [input, cancel, accept].filter(function (node) { return !node.hidden && !node.disabled; });
      var at = items.indexOf(document.activeElement);
      event.preventDefault(); event.stopImmediatePropagation();
      focus(items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]);
    } else {
      event.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener('focusin', function (event) {
    if (active && !root.contains(event.target)) focus(input.hidden ? accept : input);
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', next, { once: true });
})();
