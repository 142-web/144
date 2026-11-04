/* 多模态附件：本地读取、会话隔离队列、兼容检测与协议载荷。 */
(function () {
  'use strict';
  var bridge = window.MyChat;
  if (!bridge) return;
  var queues = new Map(), serial = 0, bar, errorBar, overlay;
  var MAX = 20 * 1024 * 1024;
  var textExt = /^(txt|md|markdown|json|jsonl|csv|tsv|js|jsx|ts|tsx|py|html|htm|css|scss|xml|yaml|yml|ini|log|sh|bash|c|h|cpp|hpp|cs|java|sql|rs|go|rb|php|vue|svelte|toml|conf|cfg|bat|ps1)$/i;
  var binaryExt = /^(exe|zip|rar|7z|mp4|mp3|dll|bin|doc|docx|xls|xlsx|ppt|pptx|wav|avi|tar|gz)$/i;
  var paths = {
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"/>',
    code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    ok: '<circle cx="12" cy="12" r="10"/><path d="m7 12 3 3 7-7"/>',
    bad: '<circle cx="12" cy="12" r="10"/><path d="m8 8 8 8m0-8-8 8"/>',
    warning: '<path d="m12 3 10 18H2zM12 9v5m0 3v1"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>'
  };
  function svg(name) { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>'; }
  function key() { var s = bridge.getCurrentSession(); return s ? s.id + '/' + (s.activeSubChatId || '') : 'new'; }
  function queue() { var k = key(); if (!queues.has(k)) queues.set(k, []); return queues.get(k); }
  function target() { return bridge.resolveTarget(); }
  function kind(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (binaryExt.test(ext)) return 'binary';
    if (/^(png|jpg|jpeg|webp|gif)$/.test(ext)) return 'image';
    if (ext === 'pdf') return 'pdf';
    if (textExt.test(ext) || /^text\//i.test(file.type)) return 'text';
    return 'binary';
  }
  function reason(a, t) {
    if (a.size > MAX) return '文件体积超出限制（20 MB）';
    if (a.error) return a.error;
    if (a.loading) return '文件读取中';
    if (a.kind === 'text') return '';
    var id = t && t.model.id || '未选择';
    if (a.kind === 'image') {
      if (t && (t.provider.visionSupport === true || /gpt-4o|gpt-4-turbo|gpt-4\.[15]|(?:^|[/_-])o[134](?:[-_]|$)|claude-(?:3|4)|claude-(?:sonnet|opus|haiku)-4|gemini|vl|vision|qvq|glm-4v|pixtral|grok-(?:2-vision|3|4)|minicpm-v|internvl|step-1v/i.test(id))) return '';
      return '当前模型「' + id + '」不支持直接识别图片，请切换支持视觉的模型或移除该图片';
    }
    if (a.kind === 'pdf' && /gemini|claude-(?:3[.-][57]|[4-9])|claude-(?:sonnet|opus|haiku)-[4-9]/i.test(id)) return '';
    return a.kind === 'pdf' ? '当前模型「' + id + '」不支持 PDF 直传' : '不支持上传「' + a.name.split('.').pop() + '」二进制/压缩格式文件，AI 无法读取';
  }
  function formatSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function textBlock(a) { return '<attachment name="' + a.name.replace(/[&<>"\r\n]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }) + '">\n' + a.text + '\n</attachment>'; }
  function marker(a) { return '[附件' + (a.kind === 'image' ? '图片' : '文档') + '：' + a.name + ' · ' + a.id + ']'; }
  function messageText(msg) {
    var parts = [msg.content || ''];
    (msg.attachments || []).forEach(function (a) { parts.push(a.kind === 'text' ? textBlock(a) : marker(a)); });
    return parts.filter(Boolean).join('\n\n');
  }
  function draftText(text) { return messageText({content:text, attachments:queue().filter(function (a) { return !a.loading && !a.error && a.kind !== 'binary' && a.size <= MAX; })}); }
  function refreshTokens() { if (window.MemorySummaryModule) window.MemorySummaryModule.onContextChanged(); }
  function validateAttachmentsForCurrentModel() {
    var list = queue(), t = target(), first = '';
    list.forEach(function (a) { a.reason = reason(a, t); if (!first && a.reason) first = '「' + a.name + '」：' + a.reason; });
    if (bar) {
      bar.replaceChildren(); bar.hidden = !list.length;
      list.forEach(function (a) { bar.appendChild(card(a, true)); });
      errorBar.hidden = !first;
      errorBar.replaceChildren();
      if (first) { var icon = document.createElement('span'); icon.innerHTML = svg('warning'); var label = document.createElement('span'); label.textContent = first; errorBar.append(icon, label); }
    }
    return !first;
  }
  function changed() { validateAttachmentsForCurrentModel(); refreshTokens(); }
  function card(a, pending) {
    var node = document.createElement('div'); node.className = 'attachment-card' + (pending && a.reason ? ' attachment-invalid' : '');
    var icon = document.createElement('span'); icon.className = 'attachment-icon';
    if (a.kind === 'image' && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(a.dataUrl || '')) { var image = document.createElement('img'); image.src = a.dataUrl; image.alt = a.name; icon.appendChild(image); }
    else icon.innerHTML = svg(a.kind === 'text' && !/\.(txt|md|markdown)$/i.test(a.name) ? 'code' : 'file');
    var info = document.createElement('span'); info.className = 'attachment-info';
    var name = document.createElement('strong'); name.textContent = a.name; name.title = a.name;
    var size = document.createElement('small'); size.textContent = formatSize(a.size); info.append(name, size); node.append(icon, info);
    if (pending) {
      var status = document.createElement('span'); status.className = 'attachment-status ' + (a.reason ? 'is-bad' : 'is-ok'); status.innerHTML = svg(a.reason ? 'bad' : 'ok'); status.title = a.reason || '支持此文件'; node.appendChild(status);
      var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.title = '移除此文件'; remove.setAttribute('aria-label', remove.title); remove.innerHTML = svg('trash');
      remove.onclick = function () { var list = queue(), i = list.indexOf(a); if (i >= 0) list.splice(i, 1); changed(); }; node.appendChild(remove);
    } else if (a.kind === 'text') {
      var details = document.createElement('details'); details.className = 'attachment-text';
      var summary = document.createElement('summary'); summary.append(icon, info);
      var pre = document.createElement('pre'); details.append(summary, pre);
      details.addEventListener('toggle', function () { pre.textContent = details.open ? a.text : ''; }); return details;
    } else if (a.kind === 'image') {
      node.tabIndex = 0; node.setAttribute('role', 'button'); node.title = '放大图片';
      node.onclick = function () { previewImage(a); }; node.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); previewImage(a); } };
    }
    return node;
  }
  function previewImage(a) {
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(a.dataUrl || '')) return;
    var dialog = document.createElement('dialog'); dialog.className = 'attachment-lightbox';
    var close = document.createElement('button'); close.type = 'button'; close.title = '关闭'; close.setAttribute('aria-label', '关闭'); close.innerHTML = svg('close'); close.onclick = function () { dialog.close(); };
    var image = document.createElement('img'); image.src = a.dataUrl; image.alt = a.name; dialog.append(close, image); document.body.appendChild(dialog); dialog.addEventListener('close', function () { dialog.remove(); }); dialog.showModal();
  }
  async function addFiles(files) {
    var list = queue();
    var jobs = Array.from(files).map(function (file) {
      var a = {id:'att_' + Date.now() + '_' + (++serial), name:file.name, size:file.size, mime:file.type, kind:kind(file), loading:true};
      list.push(a);
      if (a.kind === 'binary' || a.size > MAX) { a.loading = false; return Promise.resolve(); }
      return new Promise(function (resolve) {
        var reader = new FileReader();
        reader.onload = function () {
          if (a.kind === 'text') a.text = String(reader.result || '');
          else {
            var mime = a.kind === 'pdf' ? 'application/pdf' : ({jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif'}[file.name.split('.').pop().toLowerCase()]);
            a.mime = mime; a.dataUrl = String(reader.result).replace(/^data:[^;]*;/, 'data:' + mime + ';');
          }
          a.loading = false; changed(); resolve();
        };
        reader.onerror = reader.onabort = function () { a.loading = false; a.error = '文件读取失败'; changed(); resolve(); };
        if (a.kind === 'text') reader.readAsText(file); else reader.readAsDataURL(file);
      });
    });
    changed(); await Promise.all(jobs); changed();
  }
  function beforeCommit() {
    if (validateAttachmentsForCurrentModel()) return true;
    errorBar.classList.remove('shake-error'); void errorBar.offsetWidth; errorBar.classList.add('shake-error'); return false;
  }
  function take() {
    var list = queue(); var result = list.map(function (a) { return {id:a.id, name:a.name, size:a.size, mime:a.mime, kind:a.kind, text:a.text, dataUrl:a.dataUrl}; });
    list.length = 0; changed(); return result;
  }
  function renderSent(bubble, msg) {
    var old = bubble.querySelector('.sent-attachments'); if (old) old.remove();
    if (!msg.attachments || !msg.attachments.length) return;
    var wrap = document.createElement('div'); wrap.className = 'sent-attachments'; msg.attachments.forEach(function (a) { wrap.appendChild(card(a, false)); }); bubble.appendChild(wrap);
  }
  // 仅在传输边界转成数组，正则、宏、世界书与 Token 预览始终处理文本。
  function toWire(messages, source, t) {
    var media = [];
    (source || []).forEach(function (msg) { (msg.attachments || []).forEach(function (a) { if (a.kind !== 'text') media.push(a); }); });
    return messages.map(function (msg) {
      if (typeof msg.content !== 'string') return msg;
      var text = msg.content, selected = media.filter(function (a) { return text.indexOf(marker(a)) >= 0; });
      if (!selected.length) return msg;
      var parts = [];
      selected.forEach(function (a) {
        var failure = reason(a, t); if (failure) throw new Error('「' + a.name + '」：' + failure);
        text = text.split(marker(a)).join('');
        if (a.kind === 'image') parts.push({type:'image_url', image_url:{url:a.dataUrl}});
        else parts.push({type:'file', file:{filename:a.name, file_data:a.dataUrl}});
      });
      return {role:msg.role, content:[{type:'text', text:text.trim() || '请分析附件'}].concat(parts)};
    });
  }
  function init() {
    var composer = document.querySelector('.composer'), panel = document.getElementById('input-toolbox-panel');
    if (!composer || !panel) return;
    var picker = document.createElement('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true; picker.id = 'attachment-file-input'; composer.appendChild(picker);
    var button = document.createElement('button'); button.type = 'button'; button.className = 'toolbox-item'; button.title = '上传文件'; button.setAttribute('role', 'menuitem'); button.innerHTML = svg('upload') + '<span>上传文件</span>'; panel.prepend(button);
    button.onclick = function () { picker.click(); if (bridge.closeToolbox) bridge.closeToolbox(); };
    picker.onchange = function () { void addFiles(picker.files); picker.value = ''; };
    bar = document.createElement('div'); bar.id = 'attachment-bar'; bar.className = 'attachment-bar'; bar.hidden = true; bar.setAttribute('aria-label', '待发送文件');
    errorBar = document.createElement('div'); errorBar.className = 'attachment-error'; errorBar.hidden = true; errorBar.setAttribute('role', 'alert'); composer.prepend(bar, errorBar);
    overlay = document.createElement('div'); overlay.className = 'attachment-drop-overlay'; overlay.hidden = true; overlay.innerHTML = svg('upload') + '<span>松开鼠标即可上传文件到当前对话</span>'; document.body.appendChild(overlay);
    var depth = 0;
    function hasFiles(e) { return e.dataTransfer && Array.from(e.dataTransfer.types).indexOf('Files') >= 0; }
    function reset() { depth = 0; overlay.hidden = true; }
    [document.getElementById('chat-area'), composer].forEach(function (zone) {
      zone.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
      zone.addEventListener('dragover', function (e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
      zone.addEventListener('dragleave', function (e) { if (hasFiles(e) && --depth <= 0) reset(); });
      zone.addEventListener('drop', function (e) { if (!hasFiles(e)) return; e.preventDefault(); reset(); void addFiles(e.dataTransfer.files); });
    });
    document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', function (e) { if (hasFiles(e)) { e.preventDefault(); reset(); } });
    window.addEventListener('blur', reset); document.addEventListener('dragend', reset);
    window.addEventListener('mychat-context-changed', validateAttachmentsForCurrentModel);
    changed();
  }
  window.MyChatAttachments = {addFiles:addFiles, validateAttachmentsForCurrentModel:validateAttachmentsForCurrentModel, beforeCommit:beforeCommit, take:take, hasPending:function () { return queue().length > 0; }, messageText:messageText, draftText:draftText, renderSent:renderSent, toWire:toWire, reason:reason};
  // 文本载荷已由宿主统一组装；钩子用于插件时序兼容，不改写媒体数组。
  bridge.registerHook('beforeSend', function (messages) { return messages; });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
