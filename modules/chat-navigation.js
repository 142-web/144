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
    button('chat-prev-floor', '上一楼', 'm15 18-6-6 6-6M9 18l-6-6 6-6') +
    button('chat-jump-floor', '跳转到指定楼层', 'M10 3 8 21M16 3l-2 18M4 9h16M3 15h16') +
    button('chat-next-floor', '下一楼', 'm9 6 6 6-6 6m6-12 6 6-6 6') +
    button('chat-go-bottom', '直达底部 (最新楼层)', 'M5 20h14M12 4v12m-5-5 5 5 5-5');
  composer.appendChild(nav);
  var pop = document.createElement('form');
  pop.className = 'chat-floor-popover';
  pop.hidden = true;
  pop.setAttribute('aria-label', '跳转楼层');
  pop.innerHTML = '<input type="number" min="1" step="1" aria-label="目标楼层" required>' + button('chat-floor-confirm', '确认跳转', 'm5 12 4 4L19 6') + '<div class="chat-floor-summary" role="list" aria-label="楼层摘要"></div>';
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
  var summary = pop.querySelector('.chat-floor-summary');
  function cleanSummary(value) {
    return String(value || '').replace(/```[\s\S]*?```/g, '[代码]').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 58) || '（空消息）';
  }
  function currentFloor() {
    var rows = area.querySelectorAll('.msg[data-index], .msg[data-msg-index]'), best = 1, center = area.getBoundingClientRect().top + area.clientHeight / 2, distance = Infinity;
    Array.prototype.forEach.call(rows, function (row) {
      var rect = row.getBoundingClientRect(), value = Number(row.dataset.floor || Number(row.dataset.index || row.dataset.msgIndex) + 1);
      var d = rect.top <= center && rect.bottom >= center ? 0 : Math.min(Math.abs(rect.top - center), Math.abs(rect.bottom - center));
      if (d < distance) { distance = d; best = value; }
    });
    return Math.max(1, Math.min(totalFloors() || 1, best));
  }
  function renderSummary() {
    var session = window.MyChat.getCurrentSession(), list = session && session.messages || [], current = currentFloor();
    summary.innerHTML = '';
    list.forEach(function (msg, index) {
      var item = document.createElement('button');
      item.type = 'button'; item.className = 'chat-floor-summary-item'; item.dataset.floor = String(index + 1);
      item.setAttribute('role', 'listitem'); item.title = '定位到第' + (index + 1) + '楼';
      item.innerHTML = '<b>#' + (index + 1) + '</b><span></span>';
      item.querySelector('span').textContent = cleanSummary(msg && (msg.content || msg.text || msg.reasoning));
      item.classList.toggle('is-current', index + 1 === current);
      item.addEventListener('click', function () { locateFloor(index + 1); });
      summary.appendChild(item);
    });
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
  function locateFloor(value) {
    var node = Number.isInteger(value) && value > 0 && value <= totalFloors() && window.MyChat.ensureMessageRendered(value - 1);
    if (!node) return;
    close(true);
    area._holdScroll = true;
    function locate() {
      var target = node.getBoundingClientRect(), bounds = area.getBoundingClientRect();
      area.scrollTop += target.top - bounds.top - area.clientTop - (area.clientHeight - Math.min(target.height, area.clientHeight)) / 2;
    }
    locate();
    requestAnimationFrame(function () {
      if (!node.isConnected) return;
      locate();
      if (highlighted) highlighted.classList.remove('floor-flash-highlight');
      clearTimeout(flashTimer); highlighted = node;
      requestAnimationFrame(function () {
        node.classList.add('floor-flash-highlight');
        flashTimer = setTimeout(function () { node.classList.remove('floor-flash-highlight'); }, 1800);
      });
    });
  }
  function stepFloor(delta) {
    var total = totalFloors();
    if (!total) return;
    var floor = currentFloor(), target = Math.max(1, Math.min(total, floor + delta));
    if (delta > 0 && target === total) { close(false); exactScroll('bottom'); return; }
    if (target === floor && delta < 0 && floor === 1) window.MyChat.ensureMessageRendered(0);
    if (target === floor && delta > 0 && floor >= totalFloors()) { exactScroll('bottom'); return; }
    locateFloor(target);
  }
  nav.querySelector('#chat-prev-floor').addEventListener('click', function () { stepFloor(-1); });
  nav.querySelector('#chat-next-floor').addEventListener('click', function () { stepFloor(1); });
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
    renderSummary();
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    position();
    var current = summary.querySelector('.is-current');
    if (current) summary.scrollTop = current.offsetTop - summary.offsetTop - (summary.clientHeight - current.offsetHeight) / 2;
    input.setCustomValidity('');
    input.focus({ preventScroll: true });
  });
  var flashTimer = 0, highlighted = null;
  pop.addEventListener('submit', function (event) {
    event.preventDefault();
    var value = Number(input.value);
    if (!Number.isInteger(value) || value < 1 || value > totalFloors()) { input.setCustomValidity('请输入有效楼层'); input.reportValidity(); return; }
    locateFloor(value);
  });
  input.addEventListener('input', function () { input.setCustomValidity(''); });
  document.addEventListener('pointerdown', function (event) { if (!pop.hidden && !pop.contains(event.target) && !nav.contains(event.target)) close(false); });
  document.addEventListener('keydown', function (event) { if (!pop.hidden && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); } }, true);
  window.addEventListener('resize', function () { if (!pop.hidden) position(); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', function () { if (!pop.hidden) position(); });
  new MutationObserver(function () { if (!pop.hidden) close(false); }).observe(area, { childList: true });
}());
