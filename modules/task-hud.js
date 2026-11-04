/* 既有记忆任务 HUD 的报文跳转适配，不复制任务生命周期。 */
(function () {
  'use strict';
  function linkTrace(task, traceId) {
    if (!task || !task.card || !traceId) return;
    task.traceId = traceId; task.card.dataset.traceId = traceId;
    var actions = task.card.querySelector('.ms-task-actions');
    if (!actions || actions.querySelector('.task-trace-button')) return;
    var button = document.createElement('button'); button.type = 'button'; button.className = 'ms-icon-btn task-trace-button';
    button.title = '查看报文'; button.setAttribute('aria-label', '查看报文');
    // Lucide FileSearch 矢量图形，沿用 ISC 开源图标几何。
    button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="m13.3 16.3 2.2 2.2"/></svg>';
    button.onclick = function () { if (window.DebugInspector) window.DebugInspector.open(task.traceId); };
    actions.prepend(button);
  }
  window.TaskHUD = Object.assign(window.TaskHUD || {}, {linkTrace:linkTrace});
})();
