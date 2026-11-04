/* 自动重新回复：策略、校验和界面独立封装，仅通过公共桥接接入宿主。 */
(function () {
  'use strict';
  var bridge = window.MyChat;
  if (!bridge) return;
  var jobs = new Map(), settings, toolbar, status, modal, rulesBox, toggle;
  function number(value, fallback, min, max) {
    var n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }
  function normalize(value) {
    var v = value && typeof value === 'object' ? value : {};
    return { enabled: v.enabled === true, maxRetries: Math.round(number(v.maxRetries, 3, 1, 20)),
      minTokens: number(v.minTokens, 0, 0, 1000000), timeout: number(v.timeout, 60, 0, 86400),
      delay: number(v.delay, 3, 0, 86400), formatEnabled: v.formatEnabled === true,
      rules: (Array.isArray(v.rules) ? v.rules : []).map(function (r) {
        r = r || {};
        return { enabled: r.enabled !== false, type: ['include', 'pair', 'exclude'].includes(r.type) ? r.type : 'include',
          text: String(r.text || ''), start: String(r.start || ''), end: String(r.end || '') };
      }) };
  }
  // 统一全半角、常见括号、标点和空白，文字按普通子串匹配，不执行用户正则。
  function fold(text) {
    return String(text || '').normalize('NFKC').toLowerCase()
      .replace(/[【〔「『［]/g, '[').replace(/[】〕」』］]/g, ']')
      .replace(/[（]/g, '(').replace(/[）]/g, ')')
      .replace(/[，、]/g, ',').replace(/[。]/g, '.').replace(/[：]/g, ':')
      .replace(/[；]/g, ';').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, '');
  }
  function words(text) { return String(text || '').split(/[,，\n\r]+/).map(function (w) { return w.trim(); }).filter(Boolean); }
  function tokens(text) {
    var t = String(text || ''), cjk = (t.match(/[\u3400-\u9fff]/g) || []).length;
    return Math.ceil(cjk * 1.5 + (Array.from(t).length - cjk) / 4);
  }
  function validate(text, config) {
    var c = normalize(config), raw = String(text || ''), body = fold(raw);
    if (tokens(raw) < c.minTokens) return '回复过短（低于 ' + c.minTokens + ' Token）';
    if (!c.formatEnabled) return '';
    for (var i = 0; i < c.rules.length; i++) {
      var rule = c.rules[i];
      if (!rule.enabled) continue;
      if (rule.type === 'pair') {
        var start = fold(rule.start), end = fold(rule.end);
        if (!start || !end) return '请补全成对标记';
        var from = 0, found = false, at;
        while ((at = body.indexOf(start, from)) !== -1) {
          var contentAt = at + start.length, close = body.indexOf(end, contentAt);
          if (close > contentAt) { found = true; break; }
          from = contentAt;
        }
        if (!found) return '缺少完整标记「' + rule.start.trim() + ' … ' + rule.end.trim() + '」';
      } else {
        var list = words(rule.text);
        if (!list.length) return '请填写检测内容';
        for (var w = 0; w < list.length; w++) {
          var has = body.includes(fold(list[w]));
          if (rule.type === 'include' && !has) return '回复未包含「' + list[w] + '」';
          if (rule.type === 'exclude' && has) return '回复包含「' + list[w] + '」';
        }
      }
    }
    return '';
  }
  function currentKey() {
    var s = bridge.getCurrentSession();
    return s ? s.id + '::' + s.activeSubChatId : '';
  }
  function paint() {
    if (!toolbar) return;
    toggle.classList.toggle('is-on', settings.enabled);
    toggle.setAttribute('aria-pressed', String(settings.enabled));
    toggle.querySelector('span').textContent = '自动重试: ' + (settings.enabled ? '开' : '关');
    var job = jobs.get(currentKey());
    status.textContent = job ? job.status || '' : '';
    status.title = status.textContent;
  }
  function say(job, text) { job.status = text; paint(); }
  function clearJob(job) {
    clearTimeout(job.timeoutTimer); clearInterval(job.waitTimer);
    job.timeoutTimer = null; job.waitTimer = null;
    if (job.wake) { var wake = job.wake; job.wake = null; wake(false); }
  }
  function cancelRetries(abort) {
    jobs.forEach(function (job) {
      job.cancelled = true;
      clearJob(job);
      if (abort && job.controller) job.controller.abort();
      say(job, '自动重试已停止');
    });
  }
  function stop() {
    cancelRetries(true);
    bridge.stopAllGenerations();
    bridge.showToast('已强制停止生成与自动重试');
  }
  function persist() {
    try { bridge.saveAutoRetrySettings(normalize(settings)); }
    catch (err) { bridge.showToast('重试配置保存失败'); }
    paint();
  }
  function wait(job, seconds, reason, count, max) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + seconds * 1000;
      job.wake = resolve;
      function tick() {
        if (job.cancelled) { clearJob(job); return; }
        var remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        say(job, reason + '；等待重试 (' + remaining + 's)，第 ' + count + '/' + max + ' 次');
        if (Date.now() >= deadline) {
          clearInterval(job.waitTimer); job.waitTimer = null; job.wake = null; resolve(true);
        }
      }
      job.waitTimer = setInterval(tick, 100);
      tick();
    });
  }
  async function run(key, attempt) {
    var c = normalize(settings);
    var job = { cancelled: false, controller: null, status: '' }, previous;
    jobs.set(key, job);
    try {
      for (var retry = 0; retry <= c.maxRetries; retry++) {
        if (job.cancelled) break;
        job.controller = new AbortController();
        var timedOut = false;
        say(job, retry ? '正在重试，第 ' + retry + '/' + c.maxRetries + ' 次' : '正在生成');
        if (c.enabled && c.timeout > 0) job.timeoutTimer = setTimeout(function () {
          timedOut = true; job.controller.abort();
        }, c.timeout * 1000);
        var result;
        try { result = await attempt(job.controller.signal, previous); }
        catch (err) { result = { error: err.message || String(err) }; }
        clearTimeout(job.timeoutTimer); job.timeoutTimer = null;
        if (job.cancelled || !result) break;
        previous = result;
        if (!c.enabled || !settings.enabled) break;
        var reason = timedOut ? '请求超时' : result.error || validate(result.content, c);
        if (!reason) { say(job, '回复已达标'); break; }
        if (retry === c.maxRetries) {
          say(job, '已达重试上限：' + reason);
          bridge.showToast('已达重试上限：' + reason);
          break;
        }
        if (!await wait(job, c.delay, reason, retry + 1, c.maxRetries)) break;
      }
    } finally {
      clearJob(job);
      if (jobs.get(key) === job) jobs.delete(key);
      paint();
    }
  }
  function svg(path) {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';
  }
  function button(title, path) {
    var b = document.createElement('button'); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.innerHTML = svg(path); return b;
  }
  function drawRules() {
    rulesBox.replaceChildren();
    settings.rules.forEach(function (r, index) {
      var card = document.createElement('div'); card.className = 'retry-rule';
      var head = document.createElement('div'); head.className = 'retry-rule-head';
      var check = document.createElement('input'); check.type = 'checkbox'; check.checked = r.enabled; check.setAttribute('aria-label', '启用规则');
      check.onchange = function () { r.enabled = check.checked; persist(); };
      var select = document.createElement('select'); select.setAttribute('aria-label', '检测类型');
      [['include', '必须包含内容'], ['pair', '成对包裹标记'], ['exclude', '不能出现内容']].forEach(function (item) {
        var option = document.createElement('option'); option.value = item[0]; option.textContent = item[1]; select.appendChild(option);
      });
      select.value = r.type;
      select.onchange = function () { r.type = select.value; persist(); drawRules(); };
      var remove = button('删除规则', 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6');
      remove.onclick = function () { settings.rules.splice(index, 1); persist(); drawRules(); };
      head.append(check, select, remove); card.appendChild(head);
      (r.type === 'pair' ? [['start', '开头标记'], ['end', '结尾标记']] : [['text', '关键词，逗号或换行分隔']]).forEach(function (item) {
        var input = document.createElement('textarea'); input.rows = 2; input.placeholder = item[1]; input.setAttribute('aria-label', item[1]); input.value = r[item[0]];
        input.oninput = function () { r[item[0]] = input.value; persist(); };
        card.appendChild(input);
      });
      rulesBox.appendChild(card);
    });
  }
  function open() {
    if (modal) modal.remove();
    modal = document.createElement('dialog'); modal.className = 'auto-retry-dialog'; modal.setAttribute('aria-labelledby', 'retry-dialog-title');
    var head = document.createElement('div'); head.className = 'retry-dialog-head';
    var title = document.createElement('h3'); title.id = 'retry-dialog-title'; title.textContent = '自动重新回复设置';
    var close = button('关闭设置', 'm6 6 12 12M6 18 18 6'); close.onclick = function () { modal.close(); };
    head.append(title, close); modal.appendChild(head);
    [['maxRetries', '最大重试次数', 1, 20, 1], ['minTokens', '最小回复 Token', 0, 1000000, 1],
      ['timeout', '超时（秒）', 0, 86400, 1], ['delay', '重试延迟（秒）', 0, 86400, 0.1]].forEach(function (item) {
      var label = document.createElement('label'); label.className = 'retry-field'; label.textContent = item[1];
      var input = document.createElement('input'); input.type = 'number'; input.min = item[2]; input.max = item[3]; input.step = item[4]; input.value = settings[item[0]];
      input.title = item[0] === 'maxRetries' ? '首次请求之外的重试次数' : item[0] === 'minTokens' ? '按正文估算 Token；0 为不限' : item[0] === 'timeout' ? '0 为不启用超时' : '支持小数秒';
      input.onchange = function () { settings[item[0]] = number(input.value, settings[item[0]], item[2], item[3]); persist(); input.value = settings[item[0]]; };
      label.appendChild(input); modal.appendChild(label);
    });
    var format = document.createElement('label'); format.className = 'retry-format-toggle';
    var check = document.createElement('input'); check.type = 'checkbox'; check.checked = settings.formatEnabled;
    check.onchange = function () { settings.formatEnabled = check.checked; persist(); };
    format.append(check, document.createTextNode('格式检测')); modal.appendChild(format);
    var presets = document.createElement('div'); presets.className = 'retry-presets';
    [['检测状态栏未输出', '状态栏', 'include'], ['检测必填关键词', '', 'include'], ['拦截道歉拒答', '抱歉，我无法\n作为AI语言模型', 'exclude']].forEach(function (item) {
      var b = button(item[0], 'M12 5v14M5 12h14'); var text = document.createElement('span'); text.textContent = item[0]; b.appendChild(text);
      b.onclick = function () { settings.formatEnabled = true; check.checked = true; settings.rules.push({ enabled: true, type: item[2], text: item[1], start: '', end: '' }); persist(); drawRules(); };
      presets.appendChild(b);
    });
    modal.appendChild(presets); rulesBox = document.createElement('div'); modal.appendChild(rulesBox); drawRules();
    document.body.appendChild(modal); modal.showModal();
    modal.addEventListener('close', function () { toggle.focus({ preventScroll: true }); });
  }
  window.addEventListener('mychat-stop-channel', function (event) {
    var key = event.detail.key, job = jobs.get(key);
    if (!job) return;
    job.cancelled = true; clearJob(job);
    if (job.controller) job.controller.abort();
    if (jobs.get(key) === job) jobs.delete(key);
    paint();
  });
  function reload() { cancelRetries(true); settings = normalize(bridge.getAutoRetrySettings()); paint(); }
  settings = normalize(bridge.getAutoRetrySettings());
  // 策略钩子只返回执行器；异步等待不放入同步文本管道。
  bridge.registerHook('replyPolicy', function (policy, context) {
    return Object.assign({}, policy, { run: function (attempt) { return run(context.key, attempt); } });
  });
  var composer = document.querySelector('.composer');
  if (composer) {
    toolbar = document.createElement('div'); toolbar.className = 'auto-retry-toolbar';
    var group = document.createElement('div'); group.className = 'auto-retry-group'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', '自动重新回复');
    toggle = button('切换自动重试', 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1'); toggle.id = 'auto-retry-toggle'; toggle.appendChild(document.createElement('span'));
    toggle.onclick = function () { settings.enabled = !settings.enabled; if (!settings.enabled) cancelRetries(false); persist(); };
    var config = button('重试设置', 'M4 7h16M4 17h16M9 4v6m6 4v6'); config.id = 'auto-retry-settings'; config.onclick = open;
    var force = button('强制停止', 'M6 6h12v12H6z'); force.id = 'auto-retry-stop'; force.onclick = stop;
    group.append(toggle, config, force); status = document.createElement('span'); status.className = 'auto-retry-status'; status.setAttribute('role', 'status');
    toolbar.append(group, status); composer.insertBefore(toolbar, composer.firstChild); paint();
    window.addEventListener('mychat-context-changed', paint);
  }
  window.MyChatAutoRetry = { reload: reload, stop: stop, validate: validate, normalize: normalize, estimateTokens: tokens };
}());
