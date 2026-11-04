/* 聊天楼层导航：通过宿主补齐显示窗口，不保存数据，不改变消息管道。 */
(function () {
  'use strict';
  var area = document.getElementById('chat-area');
  var composer = document.querySelector('.composer');
  if (!area || !composer) return;
  function svg(path) {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';
  }
  function button(id, title, path) {
    return '<button type="button" id="' + id + '" title="' + title + '" aria-label="' + title + '">' + svg(path) + '</button>';
  }
  var nav = document.createElement('div');
  nav.className = 'chat-floor-nav';
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', '楼层导航');
  nav.innerHTML = button('chat-go-top', '回到顶部 (第1楼)', 'M5 4h14M12 20V8m-5 5 5-5 5 5') +
    button('chat-jump-floor', '跳转到指定楼层', 'M10 3 8 21M16 3l-2 18M4 9h16M3 15h16') +
    button('chat-go-bottom', '直达底部 (最新楼层)', 'M5 20h14M12 4v12m-5-5 5 5 5-5');
  composer.appendChild(nav);
  var pop = document.createElement('form');
  pop.className = 'chat-floor-popover';
  pop.hidden = true;
  pop.setAttribute('aria-label', '跳转楼层');
  pop.innerHTML = '<input type="number" min="1" step="1" aria-label="目标楼层" required>' + button('chat-floor-confirm', '确认跳转', 'm5 12 4 4L19 6');
  pop.querySelector('button').type = 'submit';
  document.body.appendChild(pop);
  var input = pop.querySelector('input');
  var trigger = nav.querySelector('#chat-jump-floor');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'chat-floor-popover');
  pop.id = 'chat-floor-popover';
  function totalFloors() {
    var session = window.MyChat.getCurrentSession();
    return session && session.messages ? session.messages.length : 0;
  }
  function close(restore) {
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restore) trigger.focus({ preventScroll: true });
  }
  function position() {
    var rect = trigger.getBoundingClientRect();
    var viewport = window.visualViewport;
    var left = viewport ? viewport.offsetLeft : 0, top = viewport ? viewport.offsetTop : 0;
    var width = viewport ? viewport.width : window.innerWidth, height = viewport ? viewport.height : window.innerHeight;
    pop.style.left = Math.max(left + 12, Math.min(rect.left - pop.offsetWidth - 8, left + width - pop.offsetWidth - 12)) + 'px';
    pop.style.top = Math.max(top + 12, Math.min(rect.top, top + height - pop.offsetHeight - 12)) + 'px';
  }
  function exactScroll(top) {
    if (top !== 'bottom' && totalFloors()) window.MyChat.ensureMessageRendered(0);
    area._holdScroll = top !== 'bottom';
    area.scrollTop = top === 'bottom' ? area.scrollHeight : 0;
    var channel = area._renderChannel;
    requestAnimationFrame(function () {
      if (area._renderChannel === channel) area.scrollTop = top === 'bottom' ? area.scrollHeight : 0;
    });
  }
  nav.querySelector('#chat-go-top').addEventListener('click', function () { close(false); exactScroll('top'); });
  nav.querySelector('#chat-go-bottom').addEventListener('click', function () {
    close(false);
    exactScroll('bottom');
  });
  trigger.addEventListener('click', function () {
    if (!pop.hidden) { close(true); return; }
    var total = totalFloors();
    if (!total) return;
    input.max = String(total);
    input.placeholder = '1 ~ ' + total + ' 楼';
    input.value = '';
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    position();
    input.focus({ preventScroll: true });
  });
  var flashTimer = 0, highlighted = null;
  pop.addEventListener('submit', function (event) {
    event.preventDefault();
    var value = Number(input.value);
    var node = Number.isInteger(value) && window.MyChat.ensureMessageRendered(value - 1);
    if (!node || value < 1) { input.setCustomValidity('请输入有效楼层'); input.reportValidity(); return; }
    close(true);
    area._holdScroll = true;
    function locate() {
      var target = node.getBoundingClientRect(), bounds = area.getBoundingClientRect();
      area.scrollTop += target.top - bounds.top - area.clientTop - (area.clientHeight - Math.min(target.height, area.clientHeight)) / 2;
    }
    locate();
    // 布局提交后只校准聊天容器，不滚动页面或输入区。
    requestAnimationFrame(function () {
      if (!node.isConnected) return;
      locate();
      if (highlighted) highlighted.classList.remove('floor-flash-highlight');
      clearTimeout(flashTimer);
      highlighted = node;
      node.classList.remove('floor-flash-highlight');
      requestAnimationFrame(function () {
        node.classList.add('floor-flash-highlight');
        flashTimer = setTimeout(function () { node.classList.remove('floor-flash-highlight'); }, 1800);
      });
    });
  });
  input.addEventListener('input', function () { input.setCustomValidity(''); });
  document.addEventListener('pointerdown', function (event) { if (!pop.hidden && !pop.contains(event.target) && !nav.contains(event.target)) close(false); });
  document.addEventListener('keydown', function (event) { if (!pop.hidden && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); } }, true);
  window.addEventListener('resize', function () { if (!pop.hidden) position(); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', function () { if (!pop.hidden) position(); });
  new MutationObserver(function () { if (!pop.hidden) close(false); }).observe(area, { childList: true });
}());
