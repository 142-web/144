/* HTML 沙盒与酒馆兼容桥：由宿主注入围栏扫描、会话读取及发送动作。 */
(function () {
  'use strict';

  var scanMarkdownFences;
  var getCurrentSession;
  var submitText;

  function init(deps) {
    scanMarkdownFences = deps.scanMarkdownFences;
    getCurrentSession = deps.getCurrentSession;
    submitText = deps.submitText;
  }

  /* ================= 酒馆级 HTML 沙盒渲染（状态栏 / MVU 兼容） ================= */

  // 待挂载的沙盒 HTML：key 为自增序号，与 %%MYCHAT_HTML_SANDBOX_i%% 占位符一一对应
  var sandboxRegistry = {};
  var sandboxSeq = 0;

  /**
   * 判断某个 ```html 围栏是否需要走沙盒渲染：
   *  1) 该代码块在 onRender 之前不存在（说明是正则新产出的状态栏 / 美化面板）；
   *  2) 或当前会话绑定了角色卡正则 / 世界书，且内容含完整文档特征。
   * 普通技术聊天里的 ```html 代码块一律保持原样（代码高亮 + 复制按钮）。
   */
  function shouldSandboxFence(code, beforeRegexText, session) {
    var body = String(code || '');
    var existed = !!beforeRegexText && beforeRegexText.indexOf(body.trim()) !== -1;
    if (!existed) return true;

    var boundRegex = !!(session && Array.isArray(session.regexRules) && session.regexRules.length);
    var boundWorldbook = !!(
      session && Array.isArray(session.worldbookIds) && session.worldbookIds.length
    );
    if (!boundRegex && !boundWorldbook) return false;

    return /<!DOCTYPE\s+html|<html[\s>]|<script[\s>]/i.test(body);
  }

  /**
   * 把需要沙盒渲染的 ```html 围栏替换为 %%MYCHAT_HTML_SANDBOX_i%% 占位符，
   * 交由渲染后的 DOM 阶段还原成自适应高度 iframe。
   */
  function hoistSandboxFences(text, beforeRegexText, session) {
    var src = String(text || '');
    if (src.indexOf('```') === -1) return src;

    var result = '';
    var last = 0;
    scanMarkdownFences(src).forEach(function (block) {
      if (!block.closed || !/^(?:html|htm)$/i.test(block.info) ||
          !shouldSandboxFence(block.code, beforeRegexText, session)) return;
      sandboxSeq += 1;
      var id = sandboxSeq;
      sandboxRegistry[id] = { id: String(id), code: block.code, session: session || null };
      result += src.slice(last, block.start) + '\n%%MYCHAT_HTML_SANDBOX_' + id + '%%\n';
      last = block.end;
    });
    return result + src.slice(last);
  }

  /**
   * 清理 onRender 产出的「裸 HTML」缩进与空行：
   * CommonMark 遇到 HTML 块内的空行会提前结束 HTML block，
   * 之后的 4 空格缩进子标签就会被当成 indented code block 塞进 <pre>。
   * 这里把 HTML 结构块内的空行删除、行首缩进去掉，代码围栏内部完全跳过。
   */
  function stripBareHtmlIndent(text) {
    var src = String(text || '');
    if (!src) return src;

    var lines = src.split(/\r?\n/);
    var out = [];
    var inFence = false;
    var inHtml = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();

      // 三反引号围栏（含未闭合）内部一律原样保留
      if (/^```/.test(trimmed)) {
        inFence = !inFence;
        out.push(line);
        continue;
      }
      if (inFence) {
        out.push(line);
        continue;
      }

      // 纯空白行：位于 HTML 结构块内则删除，避免 HTML block 被提前截断
      if (!trimmed) {
        if (inHtml) {
          var nextTrim = '';
          for (var k = i + 1; k < lines.length; k++) {
            if (lines[k].trim()) {
              nextTrim = lines[k].trim();
              break;
            }
          }
          // 下一行是代码围栏 / 沙盒占位符时必须保留空行，否则会被吞进原始 HTML
          if (/^```/.test(nextTrim) || /^%%MYCHAT_HTML_SANDBOX_/.test(nextTrim)) {
            inHtml = false;
            out.push(line);
          }
          continue;
        }
        out.push(line);
        continue;
      }

      // 行首为标签：判定进入 HTML 结构块，并去掉可有可无的缩进
      if (/^<[a-zA-Z!\/]/.test(trimmed)) {
        inHtml = true;
        out.push(trimmed);
        continue;
      }

      // HTML 结构块内被缩进的子行（属性续行、<style> 内容、注释等）同样去缩进
      if (inHtml && /^[ \t]{2,}\S/.test(line)) {
        out.push(trimmed);
        continue;
      }

      if (!/^\s/.test(line)) inHtml = false;
      out.push(line);
    }

    return out.join('\n');
  }

  /**
   * 生成沙盒垫片脚本：MVU 变量 / lodash 风格 _ / Mvu 事件 / 酒馆工具函数 / 轻量 jQuery
   */
  function buildTavernSandboxShim(sandboxId, varsJson) {
    var idLiteral = JSON.stringify(String(sandboxId || ''));
    return `<script>
(function () {
  'use strict';
  var SANDBOX_ID = ${idLiteral};
  var VARS = ${varsJson};

  window.__MYCHAT_MVU_VARS__ = VARS;

  /* ---------- 路径读写：支持 a.b.c 与 中文键 / 斜杠分隔 ---------- */
  function splitPath(path) {
    return String(path == null ? '' : path).split(/[.\\/]/).filter(function (s) { return s !== ''; });
  }
  function getPath(root, path) {
    if (path === undefined || path === null || path === '') return root;
    var parts = splitPath(path);
    var cursor = root;
    for (var i = 0; i < parts.length; i++) {
      if (cursor === null || cursor === undefined) return undefined;
      cursor = cursor[parts[i]];
    }
    return cursor;
  }
  function setPath(root, path, value) {
    var parts = splitPath(path);
    if (!parts.length) return root;
    var cursor = root;
    for (var i = 0; i < parts.length - 1; i++) {
      var key = parts[i];
      if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[parts[parts.length - 1]] = value;
    return root;
  }

  window.getAllVariables = function () { return VARS; };
  window.getVariables = window.getAllVariables;

  window._ = {
    get: function (obj, path, def) { var v = getPath(obj, path); return v === undefined ? def : v; },
    set: function (obj, path, value) { return setPath(obj, path, value); },
    has: function (obj, path) { return getPath(obj, path) !== undefined; },
    unset: function (obj, path) {
      var parts = splitPath(path);
      if (!parts.length) return obj;
      var cursor = obj;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!cursor || typeof cursor !== 'object') return obj;
        cursor = cursor[parts[i]];
      }
      if (cursor && typeof cursor === 'object') delete cursor[parts[parts.length - 1]];
      return obj;
    },
    cloneDeep: function (o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } },
    merge: function (a, b) { return Object.assign(a || {}, b || {}); },
    isEmpty: function (o) {
      if (o === null || o === undefined) return true;
      if (Array.isArray(o)) return o.length === 0;
      if (typeof o === 'object') return Object.keys(o).length === 0;
      return false;
    }
  };

  /* ---------- MVU 事件对象 ---------- */
  window.Mvu = {
    events: {
      VARIABLE_UPDATE_STARTED: 'mvu_variable_update_started',
      VARIABLE_UPDATE_ENDED: 'mvu_variable_update_ended'
    },
    getMvuData: function () {
      return { stat_data: VARS && VARS.stat_data ? VARS.stat_data : {} };
    },
    replaceMvuData: function (data) {
      if (data && data.stat_data) VARS.stat_data = data.stat_data;
      window.__MYCHAT_MVU_VARS__ = VARS;
    }
  };

  /* ---------- 事件总线（eventOn / eventEmit / waitGlobalInitialized） ---------- */
  var listeners = {};
  window.eventOn = function (ev, fn) {
    if (typeof fn !== 'function') return;
    (listeners[ev] = listeners[ev] || []).push(fn);
    if (ev === 'js-loaded' || ev === 'magic_variable_ready') {
      try { fn(); } catch (e) { console.warn('[sandbox]', e); }
    }
  };
  window.eventEmit = function (ev, data) {
    (listeners[ev] || []).forEach(function (fn) {
      try { fn(data); } catch (e) { console.warn('[sandbox]', e); }
    });
  };
  window.waitGlobalInitialized = function (name) {
    // 必须返回已解决的 Promise，兼容状态栏里的 waitGlobalInitialized(x).then(...)
    try {
      var fn = window[name];
      if (typeof fn === 'function') {
        var ret = fn();
        if (ret && typeof ret.then === 'function') return ret;
      }
    } catch (e) { /* 忽略 */ }
    return Promise.resolve(window[name] || window.Mvu || true);
  };
  window.errorCatched = function (fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { console.warn('[sandbox] 脚本异常：', e); }
    };
  };

  /* ---------- 轻量 jQuery 替代（状态栏常用子集） ---------- */
  function Wrapper(nodes) {
    this.nodes = nodes || [];
    this.length = this.nodes.length;
  }
  Wrapper.prototype.each = function (fn) {
    this.nodes.forEach(function (n, i) { fn.call(n, i, n); });
    return this;
  };
  Wrapper.prototype.text = function (v) {
    if (v === undefined) return this.nodes[0] ? this.nodes[0].textContent : '';
    return this.each(function () { this.textContent = v; });
  };
  Wrapper.prototype.html = function (v) {
    if (v === undefined) return this.nodes[0] ? this.nodes[0].innerHTML : '';
    return this.each(function () { this.innerHTML = v; });
  };
  Wrapper.prototype.val = function (v) {
    if (v === undefined) return this.nodes[0] ? this.nodes[0].value : undefined;
    return this.each(function () { this.value = v; });
  };
  Wrapper.prototype.addClass = function (c) {
    return this.each(function () { this.classList.add(c); });
  };
  Wrapper.prototype.removeClass = function (c) {
    return this.each(function () { this.classList.remove(c); });
  };
  Wrapper.prototype.toggleClass = function (c, force) {
    return this.each(function () { this.classList.toggle(c, force); });
  };
  Wrapper.prototype.hasClass = function (c) {
    return !!(this.nodes[0] && this.nodes[0].classList.contains(c));
  };
  Wrapper.prototype.on = function (ev, fn) {
    String(ev).split(/\\s+/).forEach(function (name) {
      this.each(function () { this.addEventListener(name, fn); });
    }, this);
    return this;
  };
  Wrapper.prototype.off = function (ev, fn) {
    return this.each(function () { this.removeEventListener(ev, fn); });
  };
  Wrapper.prototype.css = function (prop, value) {
    if (typeof prop === 'object' && prop !== null) {
      var self = this;
      Object.keys(prop).forEach(function (k) { self.css(k, prop[k]); });
      return this;
    }
    if (value === undefined) {
      return this.nodes[0] ? window.getComputedStyle(this.nodes[0])[prop] : undefined;
    }
    return this.each(function () { this.style[prop] = value; });
  };
  Wrapper.prototype.attr = function (name, value) {
    if (value === undefined) return this.nodes[0] ? this.nodes[0].getAttribute(name) : undefined;
    return this.each(function () { this.setAttribute(name, value); });
  };
  Wrapper.prototype.removeAttr = function (name) {
    return this.each(function () { this.removeAttribute(name); });
  };
  Wrapper.prototype.find = function (sel) {
    var found = [];
    this.nodes.forEach(function (n) {
      if (n && n.querySelectorAll) {
        Array.prototype.push.apply(found, Array.prototype.slice.call(n.querySelectorAll(sel)));
      }
    });
    return new Wrapper(found);
  };
  Wrapper.prototype.show = function () { return this.each(function () { this.style.display = ''; }); };
  Wrapper.prototype.hide = function () { return this.each(function () { this.style.display = 'none'; }); };
  Wrapper.prototype.append = function (child) {
    return this.each(function () {
      if (typeof child === 'string') this.insertAdjacentHTML('beforeend', child);
      else if (child && child.nodeType) this.appendChild(child);
    });
  };

  function $(selector) {
    if (typeof selector === 'function') {
      // 兼容状态栏的 $(errorCatched(init)) 写法：执行完回调后再上报一次高度
      var runOnce = function () {
        try { selector(); } catch (e) { console.warn('[sandbox] 脚本异常：', e); }
        scheduleReport();
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runOnce);
      else setTimeout(runOnce, 0);
      return undefined;
    }
    var nodes = [];
    if (typeof selector === 'string') {
      nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    } else if (selector && selector.nodeType) {
      nodes = [selector];
    } else if (selector && typeof selector.length === 'number') {
      nodes = Array.prototype.slice.call(selector);
    }
    return new Wrapper(nodes);
  }
  window.$ = window.jQuery = $;

  /* ---------- 自适应高度：仅测量 body 真实子元素边界（彻底切断高度死循环） ---------- */
  var lastReportedHeight = 0;
  var heightTimer = null;
  function measureContentHeight() {
    if (!document.body) return 0;
    var body = document.body;
    var children = body.children;
    // 先还原测量，再按窄屏可用宽度缩放，避免重复测量累计缩小。
    if (body.style.zoom !== '1') body.style.zoom = '1';
    var viewport = document.documentElement.clientWidth || window.innerWidth;
    var contentWidth = viewport;
    // 只沿前两层直系单子节点包装剥白壳，多卡片分支不遍历。
    function stripWhiteShell(parent, depth) {
      if (depth > 2) return;
      var roots = Array.prototype.filter.call(parent.children, function (el) {
        return !/^(STYLE|SCRIPT|LINK|META|TEMPLATE|NOSCRIPT)$/.test(el.tagName);
      });
      if (roots.length !== 1) return;
      var root = roots[0];
      var css = window.getComputedStyle(root);
      var rect = root.getBoundingClientRect();
      var noBorder = ['Top','Right','Bottom','Left'].every(function (side) {
        return !(parseFloat(css['border' + side + 'Width']) || 0) ||
          css['border' + side + 'Style'] === 'none' || css['border' + side + 'Color'] === 'transparent' ||
          /rgba\\([^)]*,\\s*0\\)$/.test(css['border' + side + 'Color']);
      });
      if (noBorder && css.boxShadow === 'none' && css.backgroundImage === 'none' &&
          (css.backgroundColor === 'rgb(255, 255, 255)' || css.backgroundColor === 'rgba(255, 255, 255, 1)') &&
          rect.width >= viewport * 0.92) {
        root.style.setProperty('background-color', 'transparent', 'important');
      }
      stripWhiteShell(root, depth + 1);
    }
    stripWhiteShell(body, 1);
    for (var j = 0; j < children.length; j++) {
      var root = children[j];
      if (root.tagName === 'SCRIPT' || root.tagName === 'STYLE') continue;
      var rect = root.getBoundingClientRect();
      contentWidth = Math.max(contentWidth, rect.right, root.scrollWidth + rect.left);
    }
    var scale = viewport < 640 && contentWidth > viewport ? viewport / contentWidth : 1;
    if (body.style.zoom !== String(scale)) body.style.zoom = String(scale);
    var maxBottom = 0;
    var bodyRect = document.body.getBoundingClientRect();
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      var r = el.getBoundingClientRect();
      var bottom = r.bottom - bodyRect.top;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    var padBottom = parseFloat(window.getComputedStyle(document.body).paddingBottom) || 0;
    return Math.ceil(maxBottom + padBottom);
  }
  function reportHeight() {
    var h = measureContentHeight();
    if (h <= 2) return;
    if (h === lastReportedHeight) return;
    var shrinking = h < lastReportedHeight;
    lastReportedHeight = h;
    try {
      if (window.frameElement) {
        if (shrinking) window.frameElement.style.height = '0px';
        window.frameElement.style.height = h + 'px';
      }
    } catch (e) { /* 跨域时忽略 */ }
    try {
      window.parent.postMessage({ type: 'mychat-sandbox-resize', id: SANDBOX_ID, height: h }, '*');
    } catch (e) { /* 忽略 */ }
  }
  function scheduleReport() {
    if (heightTimer) clearTimeout(heightTimer);
    heightTimer = setTimeout(reportHeight, 40);
  }

  // 仅观察 body 子树的内容变化，绝不观察 documentElement 自身尺寸，避免死循环
  function startHeightObserver() {
    if (!document.body) return;
    var resizeObserver = window.ResizeObserver ? new ResizeObserver(scheduleReport) : null;
    function observeRoots() {
      if (!resizeObserver) return;
      resizeObserver.disconnect();
      resizeObserver.observe(document.body);
      Array.prototype.forEach.call(document.body.children, function (el) {
        if (el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') resizeObserver.observe(el);
      });
    }
    observeRoots();
    if (window.MutationObserver) {
      new MutationObserver(function (records) {
        // 忽略测量器自己写入的 zoom，防止观察回环。
        var meaningful = records.some(function (record) {
          return !(record.type === 'attributes' && record.target === document.body && record.attributeName === 'style');
        });
        if (meaningful) { observeRoots(); scheduleReport(); }
      }).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    window.addEventListener('resize', scheduleReport);
    if (document.fonts) {
      document.fonts.ready.then(scheduleReport);
      if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', scheduleReport);
    }
    document.addEventListener('load', scheduleReport, true);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      startHeightObserver();
      scheduleReport();
    });
  } else {
    startHeightObserver();
    scheduleReport();
  }
  window.addEventListener('load', scheduleReport);
  // 捕获 <details> 等折叠抽屉的展开/收起
  document.addEventListener('toggle', scheduleReport, true);
  // 等待 Tailwind CDN 渲染稳定后再补测两次
  setTimeout(reportHeight, 150);
  setTimeout(reportHeight, 600);
})();
</script>`;
  }

  /**
   * 计算沙盒内可用的 MVU 变量快照（JSON 字符串，已做 < 转义防注入）
   */
  function getSandboxVarsJson(session) {
    var state = null;
    try {
      var api = window.MyChat;
      if (api && typeof api.computeSessionMvuState === 'function') {
        state = api.computeSessionMvuState(session || getCurrentSession());
      }
    } catch (err) {
      console.warn('[MyChat] 沙盒变量快照失败：', err);
    }
    try {
      return JSON.stringify(state && typeof state === 'object' ? state : {})
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    } catch (err2) {
      return '{}';
    }
  }

  /**
   * 组装沙盒 document：完整文档直接注入垫片，片段则包一层标准 HTML 骨架
   */
  function buildTavernSandboxDocument(sandboxId, code, session) {
    var raw = String(code || '');
    var headExtra =
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<style>html,body{margin:0!important;padding:0!important;min-height:0!important;height:auto!important;background:transparent!important;background-color:transparent!important;-webkit-text-size-adjust:100%;font-family:inherit;overflow-x:hidden;}body > *:first-child{margin-top:0!important;margin-bottom:0!important;margin-left:0!important;min-height:0!important;}img{max-width:100%;}body > *:last-child{margin-bottom:0!important;}</style>' +
      buildTavernSandboxShim(sandboxId, getSandboxVarsJson(session));

    if (/<head[^>]*>/i.test(raw)) {
      return raw.replace(/<head([^>]*)>/i, function (m, attrs) {
        return '<head' + attrs + '>' + headExtra;
      });
    }
    if (/<html[\s>]/i.test(raw)) {
      return raw.replace(/<html([^>]*)>/i, function (m, attrs) {
        return '<html' + attrs + '><head>' + headExtra + '</head>';
      });
    }

    var body = raw.replace(/<!DOCTYPE[^>]*>/i, '');
    return (
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      headExtra +
      '</head><body>' +
      body +
      '</body></html>'
    );
  }

  /**
   * 创建单个沙盒节点（外层包裹 div + 自适应高度 iframe）
   */
  function createTavernSandboxNode(entry) {
    // 空白源码（trim 后为空）直接跳过，避免生成无意义的空白沙盒容器
    if (!entry || !String(entry.code || '').trim()) return document.createDocumentFragment();

    var wrap = document.createElement('div');
    wrap.className = 'tavern-sandbox-wrap';

    var frame = document.createElement('iframe');
    frame.className = 'tavern-html-sandbox';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('allowtransparency', 'true');
    frame.style.background = 'transparent';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('data-sandbox-id', entry.id);
    frame.setAttribute('title', '角色卡状态栏');
    frame.style.width = '100%';
    frame.style.border = '0';
    frame.style.display = 'block';
    frame.style.height = '0px'; /* 初始不占高，等待沙盒内 reportHeight() 回传真实高度 */
    frame.srcdoc = buildTavernSandboxDocument(entry.id, entry.code, entry.session);

    wrap.appendChild(frame);
    return wrap;
  }

  /**
   * 渲染完成后，把容器里的 %%MYCHAT_HTML_SANDBOX_i%% 占位文本替换为真实 iframe
   */
  function mountTavernSandboxes(container) {
    if (!container) return;
    if (!container.innerHTML || container.innerHTML.indexOf('%%MYCHAT_HTML_SANDBOX_') === -1) return;

    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    var hits = [];
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.indexOf('%%MYCHAT_HTML_SANDBOX_') !== -1) {
        hits.push(node);
      }
    }

    hits.forEach(function (textNode) {
      var parent = textNode.parentNode;
      if (!parent) return;

      var parts = textNode.nodeValue.split(/(%%MYCHAT_HTML_SANDBOX_\d+%%)/);
      var frag = document.createDocumentFragment();
      var replaced = false;

      parts.forEach(function (part) {
        var matched = /^%%MYCHAT_HTML_SANDBOX_(\d+)%%$/.exec(part);
        if (!matched) {
          if (part) frag.appendChild(document.createTextNode(part));
          return;
        }
        var entry = sandboxRegistry[matched[1]];
        if (!entry) return;
        frag.appendChild(createTavernSandboxNode(entry));
        delete sandboxRegistry[matched[1]];
        replaced = true;
      });

      if (!replaced) return;

      // 占位符独占一个段落时，连 <p> 一起替换，避免 <div> 嵌在 <p> 里
      if (
        parent.tagName === 'P' &&
        parent.parentNode &&
        parent.childNodes.length === 1
      ) {
        parent.parentNode.replaceChild(frag, parent);
      } else {
        parent.replaceChild(frag, textNode);
      }
    });
  }

  // 沙盒高度回传（兼容不支持 frameElement 的场景）
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data || (data.type !== 'mychat-sandbox-resize' && data.type !== 'mychat-sandbox-height')) return;
    var id = String(data.id || '');
    if (!id) return;
    var frames = document.querySelectorAll(
      'iframe.tavern-html-sandbox[data-sandbox-id="' + id + '"]'
    );
    Array.prototype.forEach.call(frames, function (frame) {
      var h = parseInt(data.height, 10);
      if (event.source !== frame.contentWindow) return;
      if (isFinite(h) && h > 2) {
        if (h < parseFloat(frame.style.height)) frame.style.height = '0px';
        frame.style.height = h + 'px';
      }
    });
  });

  /* ================= 酒馆兼容发送桥接器（状态栏 directSend 按钮） ================= */

  /**
   * 把文本写入真实聊天输入框并触发真实发送流程
   * 说明：本项目的输入框真实 ID 为 #input，发送按钮真实 ID 为 #btn-send
   */
  function tavernSubmitText(text) {
    var value = typeof text === 'string' ? text : String(text == null ? '' : text);
    if (!value.trim()) return false;
    return submitText(value);
  }

  /**
   * 安装 window.SillyTavern 兼容对象 + 隐藏的 #send_textarea / #send_but
   * 供角色卡状态栏里的 directSend 按钮 / 脚本直接调用
   */
  function setupSillyTavernBridge() {
    if (window.SillyTavern && window.SillyTavern.app && window.SillyTavern.app.chat) {
      return;
    }

    var sendTextarea = document.getElementById('send_textarea');
    if (!sendTextarea) {
      sendTextarea = document.createElement('textarea');
      sendTextarea.id = 'send_textarea';
      sendTextarea.setAttribute('aria-hidden', 'true');
      sendTextarea.setAttribute('tabindex', '-1');
      sendTextarea.style.cssText =
        'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(sendTextarea);
    }

    var sendBut = document.getElementById('send_but');
    if (!sendBut) {
      sendBut = document.createElement('button');
      sendBut.id = 'send_but';
      sendBut.type = 'button';
      sendBut.setAttribute('aria-hidden', 'true');
      sendBut.setAttribute('tabindex', '-1');
      sendBut.style.cssText =
        'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(sendBut);
    }

    // 点击隐藏发送按钮 → 读取隐藏输入框 → 走真实聊天发送
    sendBut.addEventListener('click', function () {
      var text = sendTextarea.value || '';
      if (!text.trim()) return;
      sendTextarea.value = '';
      tavernSubmitText(text);
    });

    window.SillyTavern = window.SillyTavern || {};
    window.SillyTavern.app = window.SillyTavern.app || {};
    window.SillyTavern.app.chat = window.SillyTavern.app.chat || {};
    window.SillyTavern.app.chat.sendMessage = function (message) {
      return tavernSubmitText(String(message == null ? '' : message));
    };
    // 部分状态栏脚本直接调用 generate() / sendMessage()
    window.SillyTavern.app.chat.generate = function () {
      return submitText();
    };
    window.sendMessage = function (message, options) {
      if (typeof message === 'string' && message.trim()) return tavernSubmitText(message);
      if (options && typeof options.mes === 'string') return tavernSubmitText(options.mes);
      return false;
    };
  }

  /**
   * 为代码块「预览」按钮临时创建一个沙盒节点（不进入全局注册表）
   */
  function buildPreviewSandbox(codeText) {
    sandboxSeq += 1;
    return createTavernSandboxNode({
      id: 'preview-' + sandboxSeq,
      code: String(codeText || ''),
      session: getCurrentSession()
    });
  }

  window.MyChatHtmlSandbox = {
    init: init,
    hoistSandboxFences: hoistSandboxFences,
    stripBareHtmlIndent: stripBareHtmlIndent,
    mountTavernSandboxes: mountTavernSandboxes,
    setupSillyTavernBridge: setupSillyTavernBridge,
    buildPreviewSandbox: buildPreviewSandbox
  };
})();
