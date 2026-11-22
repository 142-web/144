/* 对话搜索与跳转高亮：仅经宿主注入读取数据及执行动作。 */
(function () {
  'use strict';

  var searchScope = 'current';
  var currentResults = [];
  var currentIndex = -1;
  var resultKey = null;
  var cancelPositionCheck = null;
  var els;
  var getSessions, getCurrentSession, getCurrentId, getDefaultTitle, getPresetById, isDraggingToolbar, escapeHtml, cancelToolbarHolds, closeSidebar, ensureMessageRendered, openTopPresetDropdown, switchSession, renderMessages;

  function init(deps) {
    els = deps.els;
    getSessions = deps.getSessions;
    getCurrentSession = deps.getCurrentSession;
    getCurrentId = deps.getCurrentId;
    getDefaultTitle = deps.getDefaultTitle;
    getPresetById = deps.getPresetById;
    isDraggingToolbar = deps.isDraggingToolbar;
    escapeHtml = deps.escapeHtml;
    cancelToolbarHolds = deps.cancelToolbarHolds;
    closeSidebar = deps.closeSidebar;
    ensureMessageRendered = deps.ensureMessageRendered;
    openTopPresetDropdown = deps.openTopPresetDropdown;
    switchSession = deps.switchSession;
    renderMessages = deps.renderMessages;
  }

  // === [ANCHOR: CHAT_SEARCH] 右上角对话搜索（含 #0 系统提示词层）与跳转高亮 ===
  /* ===================================================================
     搜索模块
     -------------------------------------------------------------------
     覆盖范围：
     1. #0 系统提示词层：会话绑定预设下「已启用」模块的拼接文本与模块名称；
     2. #1、#2... 对话楼层：session.messages 的正文内容。
     结果点击后自动切换会话、滚动到目标楼层并闪烁高亮 1.8 秒。
     =================================================================== */

  /**
   * 取范围胶囊的显示文字
   */
  function getSearchScopeLabel(scope) {
    return scope === 'all' ? '全部' : '当前';
  }

  /**
   * 收集某个会话中 #0 系统提示词层的可搜索文本
   * @return {{text: string, presetName: string, enabledCount: number}|null}
   */
  function collectSystemFloorText(session) {
    if (!session) return null;
    var preset = getPresetById(session.presetId);
    if (!preset) return null;

    var modules = Array.isArray(preset.modules) ? preset.modules : [];
    var enabledNames = [];
    var enabledContents = [];
    modules.forEach(function (mod) {
      if (!mod || mod.enabled !== true) return;
      var content = typeof mod.content === 'string' ? mod.content.trim() : '';
      var name = typeof mod.name === 'string' ? mod.name.trim() : '';
      if (name) enabledNames.push(name);
      if (content) enabledContents.push(content);
    });

    // 模块名称 + 正文一起参与检索，便于用模块名快速定位
    var text = enabledNames.join(' ') + '\n' + enabledContents.join('\n\n');
    if (!text.trim()) return null;

    return {
      text: text,
      presetName: preset.name || '未命名预设',
      enabledCount: enabledContents.length
    };
  }

  /**
   * 截取关键词前后的上下文片段
   */
  function buildSearchSnippet(text, keyword) {
    var src = String(text == null ? '' : text);
    var lowerSrc = src.toLowerCase();
    var lowerKey = keyword.toLowerCase();
    var hit = lowerSrc.indexOf(lowerKey);
    if (hit === -1) {
      return src.slice(0, 90);
    }
    var start = Math.max(0, hit - 34);
    var end = Math.min(src.length, hit + keyword.length + 64);
    return (start > 0 ? '…' : '') + src.slice(start, end) + (end < src.length ? '…' : '');
  }

  /**
   * 把命中关键词包裹为 <mark class="search-highlight">
   * 其余文本全部 HTML 转义，避免注入
   */
  function highlightKeyword(text, keyword) {
    var src = String(text == null ? '' : text);
    if (!keyword) return escapeHtml(src);

    var lowerSrc = src.toLowerCase();
    var lowerKey = keyword.toLowerCase();
    var out = '';
    var cursor = 0;
    var pos = lowerSrc.indexOf(lowerKey);

    while (pos !== -1) {
      out += escapeHtml(src.slice(cursor, pos));
      out +=
        '<mark class="search-highlight">' +
        escapeHtml(src.slice(pos, pos + keyword.length)) +
        '</mark>';
      cursor = pos + keyword.length;
      pos = lowerSrc.indexOf(lowerKey, cursor);
    }
    out += escapeHtml(src.slice(cursor));
    return out;
  }

  /**
   * 按当前范围收集搜索结果
   * @return {Array<{sessionId, sessionTitle, floor, role, snippet, presetName}>}
   */
  function collectSearchResults(keyword, scope) {
    var results = [];
    var key = String(keyword || '').trim();
    if (!key) return results;

    var lowerKey = key.toLowerCase();
    var list = scope === 'all' ? getSessions() : (getCurrentSession() ? [getCurrentSession()] : []);

    list.forEach(function (session) {
      if (!session) return;
      var sessionTitle = session.title || getDefaultTitle();

      // 1) #0 系统提示词层
      var sysInfo = collectSystemFloorText(session);
      if (sysInfo && sysInfo.text.toLowerCase().indexOf(lowerKey) !== -1) {
        results.push({
          sessionId: session.id,
          sessionTitle: sessionTitle,
          floor: 0,
          role: 'system',
          roleLabel: '#0 系统提示词',
          presetName: sysInfo.presetName,
          snippet: buildSearchSnippet(sysInfo.text, key)
        });
      }

      // 2) #1、#2... 对话楼层
      var messages = Array.isArray(session.messages) ? session.messages : [];
      messages.forEach(function (msg, index) {
        if (!msg) return;
        var content = typeof msg.content === 'string' ? msg.content : '';
        if (!content) return;
        if (content.toLowerCase().indexOf(lowerKey) === -1) return;

        var floorNum = index + 1;
        results.push({
          sessionId: session.id,
          sessionTitle: sessionTitle,
          floor: floorNum,
          role: msg.role,
          roleLabel: '#' + floorNum + ' ' + (msg.role === 'user' ? '用户' : 'AI'),
          snippet: buildSearchSnippet(content, key)
        });
      });
    });

    // 上限保护：避免超长会话产生过多 DOM 节点（仅展示前 60 条）
    return results.slice(0, 60);
  }

  /**
   * 收起搜索结果浮层
   */
  function closeSearchDropdown() {
    if (!els.chatSearchDropdown) return;
    els.chatSearchDropdown.hidden = true;
    els.chatSearchDropdown.innerHTML = '';
  }

  // 移动端仅展开搜索组件，不另建检索入口或存储状态。
  function openSearch() {
    cancelToolbarHolds();
    if (isDraggingToolbar()) return;
    if (els.headerSearchWrap) els.headerSearchWrap.classList.add('search-expanded');
    if (els.chatSearchToggle) els.chatSearchToggle.setAttribute('aria-expanded', 'true');
    closeSidebar();
    if (els.chatSearchInput) els.chatSearchInput.focus();
    renderSearchDropdown();
  }

  function closeSearch(restoreFocus) {
    if (cancelPositionCheck) cancelPositionCheck();
    currentResults = [];
    currentIndex = -1;
    resultKey = null;
    updateSearchNav();
    closeSearchDropdown();
    if (els.headerSearchWrap) els.headerSearchWrap.classList.remove('search-expanded');
    if (els.chatSearchInput) els.chatSearchInput.value = '';
    if (els.chatSearchClear) els.chatSearchClear.hidden = true;
    if (els.chatSearchToggle) els.chatSearchToggle.setAttribute('aria-expanded', 'false');
    if (els.chatSearchInput) els.chatSearchInput.blur();
    if (restoreFocus && els.chatSearchToggle && window.matchMedia('(max-width: 768px)').matches) {
      els.chatSearchToggle.focus();
    }
  }

  function updateSearchNav() {
    var total = currentResults.length;
    if (els.chatSearchNav) els.chatSearchNav.hidden = !total;
    if (els.chatSearchCount) els.chatSearchCount.textContent = (currentIndex + 1) + '/' + total;
    if (els.chatSearchPrev) els.chatSearchPrev.disabled = !total;
    if (els.chatSearchNext) els.chatSearchNext.disabled = !total;
    if (els.chatSearchDropdown) {
      Array.prototype.forEach.call(els.chatSearchDropdown.querySelectorAll('.search-result-item'), function (item) {
        var active = Number(item.getAttribute('data-result-index')) === currentIndex;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-current', active ? 'true' : 'false');
      });
    }
  }

  function selectSearchResult(index, keepDropdownOpen) {
    var item = currentResults[index];
    if (!item) return;
    currentIndex = index;
    updateSearchNav();
    jumpToSearchResult(item.sessionId, item.floor);
    if (!keepDropdownOpen) {
      closeSearchDropdown();
    } else if (els.chatSearchDropdown && !els.chatSearchDropdown.hidden) {
      // 只调整结果容器，避免连带滚动主聊天区。
      var list = els.chatSearchDropdown;
      var active = list.querySelector('.search-result-item.is-active');
      if (active) {
        var listTop = list.getBoundingClientRect().top + list.clientTop;
        var activeRect = active.getBoundingClientRect();
        if (activeRect.top < listTop) list.scrollTop += activeRect.top - listTop;
        else if (activeRect.bottom > listTop + list.clientHeight) {
          list.scrollTop += Math.min(activeRect.bottom - listTop - list.clientHeight, activeRect.top - listTop);
        }
      }
    }
  }

  function stepSearchResult(delta) {
    var total = currentResults.length;
    if (!total) return;
    var index = currentIndex < 0 ? (delta < 0 ? total - 1 : 0) : (currentIndex + delta + total) % total;
    selectSearchResult(index, true);
  }

  /**
   * 重检才重置游标；聚焦或重新展开仅重绘已有结果。
   */
  function renderSearchDropdown(forceSearch) {
    if (!els.chatSearchDropdown || !els.chatSearchInput) return;

    var keyword = els.chatSearchInput.value.trim();
    if (els.chatSearchClear) els.chatSearchClear.hidden = !keyword;
    var key = JSON.stringify([keyword, searchScope, searchScope === 'current' ? getCurrentId() : null]);
    if (forceSearch === true || resultKey !== key) {
      if (cancelPositionCheck) cancelPositionCheck();
      currentResults = collectSearchResults(keyword, searchScope);
      currentIndex = -1;
      resultKey = key;
    }
    updateSearchNav();
    if (!keyword) {
      closeSearchDropdown();
      return;
    }

    var results = currentResults;
    var box = els.chatSearchDropdown;
    box.innerHTML = '';

    if (!results.length) {
      var empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = '未找到匹配内容';
      box.appendChild(empty);
      box.hidden = false;
      return;
    }

    results.forEach(function (item, index) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-result-item' + (index === currentIndex ? ' is-active' : '');
      btn.setAttribute('data-result-index', String(index));
      btn.setAttribute('aria-current', index === currentIndex ? 'true' : 'false');
      btn.setAttribute('data-session-id', item.sessionId);
      btn.setAttribute('data-floor', String(item.floor));

      var head = document.createElement('div');
      head.className = 'search-result-head';

      var badge = document.createElement('span');
      badge.className = 'msg-floor-badge';
      badge.textContent = '#' + item.floor;
      head.appendChild(badge);

      // 「所有对话」模式下额外显示所属会话标题
      if (searchScope === 'all') {
        var sessionTag = document.createElement('span');
        sessionTag.className = 'search-result-session';
        sessionTag.textContent = item.sessionTitle;
        sessionTag.title = item.sessionTitle;
        head.appendChild(sessionTag);
      }

      var roleTag = document.createElement('span');
      roleTag.className = 'search-result-role';
      roleTag.textContent = item.floor === 0 ? '系统提示词' : (item.role === 'user' ? '用户' : 'AI');
      head.appendChild(roleTag);

      var snippet = document.createElement('span');
      snippet.className = 'search-result-snippet';
      snippet.innerHTML = highlightKeyword(item.snippet, keyword);

      btn.appendChild(head);
      btn.appendChild(snippet);
      box.appendChild(btn);
    });

    box.hidden = false;
  }

  /**
   * 为指定楼层节点添加 1.8 秒的柔和呼吸高亮
   */
  function flashFloorNode(node) {
    if (!node) return;
    node.classList.remove('floor-flash-highlight');
    // 强制重排，确保动画可以重复触发
    void node.offsetWidth;
    node.classList.add('floor-flash-highlight');
    window.setTimeout(function () {
      node.classList.remove('floor-flash-highlight');
    }, 1800);
  }

  function flashSearchKeyword(node) {
    var root = node.querySelector('.bubble') || node;
    var keyword = els.chatSearchInput ? els.chatSearchInput.value.trim() : '';
    if (!keyword) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (text) {
        return text.parentElement.closest('script, style, button, iframe, .msg-actions, .msg-floor-badge, mark')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var texts = [], text;
    while ((text = walker.nextNode())) texts.push(text);
    var marks = [];
    texts.forEach(function (text) {
      var value = text.nodeValue, lower = value.toLowerCase(), needle = keyword.toLowerCase();
      var start = 0, at = lower.indexOf(needle);
      if (at < 0) return;
      var fragment = document.createDocumentFragment();
      while (at >= 0) {
        fragment.appendChild(document.createTextNode(value.slice(start, at)));
        var mark = document.createElement('mark');
        mark.className = 'search-highlight-flash';
        mark.textContent = value.slice(at, at + keyword.length);
        fragment.appendChild(mark);
        marks.push(mark);
        start = at + keyword.length;
        at = lower.indexOf(needle, start);
      }
      fragment.appendChild(document.createTextNode(value.slice(start)));
      text.replaceWith(fragment);
    });
    function cleanup(mark) {
      if (!mark.parentNode) return;
      var parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent.normalize();
    }
    marks.forEach(function (mark) {
      mark.addEventListener('animationend', function () { cleanup(mark); }, {once:true});
    });
    // 跨内联节点命中时不重建正文结构，退化为正文容器闪烁。
    if (!marks.length) root.classList.add('search-highlight-flash');
    window.setTimeout(function () {
      marks.forEach(cleanup);
      root.classList.remove('search-highlight-flash');
    }, 2450);
  }

  /**
   * 跳转到搜索结果：跨会话切换 + 滚动到楼层中央 + 闪烁高亮
   * - 命中 #1+ 楼层：滚动定位到对应消息气泡
   * - 命中 #0 系统提示词层：展开顶部一站式预设下拉面板，并高亮命中的小模块行
   * @param {string} sessionId 目标会话 id
   * @param {number} targetFloor 目标楼层号（0 = 系统提示词层）
   */
  function jumpToSearchResult(sessionId, targetFloor) {
    if (cancelPositionCheck) cancelPositionCheck();
    var isSame = getCurrentId() === sessionId;

    if (!isSame) {
      if (switchSession(sessionId) === false) return;
      // 不复用上一会话的滚动位置，避免定位前出现无意义的跳动
      els.chatArea.scrollTop = 0;
    }

    // 重绘及补齐目标后，只滚动聊天容器，避免触发平滑滚动懒加载冲突。
    renderMessages({ noScroll: true });

    // #0 系统提示词层已迁到顶部控制台：展开下拉并高亮命中的小模块行
    if (targetFloor === 0) {
      jumpToSystemPromptModule();
      return;
    }

    var node = ensureMessageRendered(targetFloor - 1);
    if (!node) return;

    var area = els.chatArea;
    var stopped = false, frame = null, timer = null;
    var events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    function cleanup() {
      stopped = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
      events.forEach(function (type) { area.removeEventListener(type, cleanup, true); });
      if (cancelPositionCheck === cleanup) cancelPositionCheck = null;
    }
    function centerTarget() {
      if (stopped || getCurrentId() !== sessionId || !area.contains(node)) return;
      var targetEl = node.querySelector('mark.search-highlight-flash, span.search-highlight-flash') || node;
      var targetTop = targetEl.getBoundingClientRect().top - area.getBoundingClientRect().top - area.clientTop + area.scrollTop;
      // 优先定位关键词；超长消息未命中高亮时顶部对齐，避免居中偏离命中位置。
      var desired = targetEl.offsetHeight <= area.clientHeight * 0.8
        ? Math.max(0, targetTop - (area.clientHeight - targetEl.offsetHeight) / 2)
        : Math.max(0, targetTop - 24);
      desired = Math.min(desired, Math.max(0, area.scrollHeight - area.clientHeight));
      if (Math.abs(area.scrollTop - desired) > 3) area.scrollTop = desired;
    }
    cancelPositionCheck = cleanup;
    events.forEach(function (type) { area.addEventListener(type, cleanup, { capture: true, passive: true }); });
    flashSearchKeyword(node);
    centerTarget();
    frame = window.requestAnimationFrame(function () { frame = null; centerTarget(); });
    timer = window.setTimeout(function () { timer = null; centerTarget(); cleanup(); }, 120);
  }

  /**
   * 搜索命中 #0 时的定位：展开顶部 #0 下拉，定位并高亮包含关键词的小模块行
   */
  function jumpToSystemPromptModule() {
    openTopPresetDropdown();

    var keyword = els.chatSearchInput ? (els.chatSearchInput.value || '').trim() : '';
    var rows = els.tpModuleList ? els.tpModuleList.querySelectorAll('.preset-module-item') : [];
    var hitRow = null;

    if (keyword) {
      var lower = keyword.toLowerCase();
      Array.prototype.forEach.call(rows, function (row) {
        if (hitRow) return;
        var nameEl = row.querySelector('.module-name');
        var previewEl = row.querySelector('.module-preview');
        var text = ((nameEl ? nameEl.textContent : '') + ' ' + (previewEl ? previewEl.textContent : '')).toLowerCase();
        if (text.indexOf(lower) !== -1) hitRow = row;
      });
    }

    if (!hitRow && rows.length) hitRow = rows[0];
    if (!hitRow) return;

    if (els.tpModuleList) {
      var list = els.tpModuleList;
      var top = hitRow.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop + list.scrollTop;
      list.scrollTop = Math.max(0, top - (list.clientHeight - hitRow.offsetHeight) / 2);
    }
    flashFloorNode(hitRow);
  }

  /**
   * 绑定搜索组件事件（由 INIT_EVENTS 的 bindEvents 调用）
   */
  function bindSearchEvents() {
    if (!els.chatSearchInput) return;
    if (els.chatSearchToggle) els.chatSearchToggle.addEventListener('click', function () {
      if (els.headerSearchWrap.classList.contains('search-expanded')) closeSearch(true);
      else openSearch();
    });
    if (els.chatSearchClose) els.chatSearchClose.addEventListener('click', function () {
      closeSearch(true);
    });

    // 输入即搜索
    els.chatSearchInput.addEventListener('input', function () {
      renderSearchDropdown(true);
    });

    // 聚焦时若有内容则重新展开
    els.chatSearchInput.addEventListener('focus', function () {
      if (els.chatSearchInput.value.trim()) renderSearchDropdown();
    });

    // 输入法确认不触发跳转；回车与上下按钮共用循环游标。
    els.chatSearchInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      stepSearchResult(e.shiftKey ? -1 : 1);
    });
    if (els.chatSearchPrev) els.chatSearchPrev.addEventListener('click', function () { stepSearchResult(-1); });
    if (els.chatSearchNext) els.chatSearchNext.addEventListener('click', function () { stepSearchResult(1); });

    // 清空按钮
    if (els.chatSearchClear) {
      els.chatSearchClear.addEventListener('click', function () {
        els.chatSearchInput.value = '';
        els.chatSearchClear.hidden = true;
        renderSearchDropdown(true);
        els.chatSearchInput.focus();
      });
    }

    // 范围切换胶囊：当前对话 ↔ 所有对话
    if (els.chatSearchScope) {
      els.chatSearchScope.addEventListener('click', function () {
        searchScope = searchScope === 'current' ? 'all' : 'current';
        els.chatSearchScope.setAttribute('data-scope', searchScope);
        els.chatSearchScope.textContent = getSearchScopeLabel(searchScope);
        renderSearchDropdown(true);
      });
    }

    // 点击结果项：保留浮层并更新激活项。
    if (els.chatSearchDropdown) {
      els.chatSearchDropdown.addEventListener('click', function (e) {
        var item = e.target.closest ? e.target.closest('.search-result-item') : null;
        if (!item) return;
        var index = Number(item.getAttribute('data-result-index'));
        if (!Number.isInteger(index)) return;
        selectSearchResult(index, true);
      });
    }

    // 点击搜索区域外部时自动收起浮层
    document.addEventListener('click', function (e) {
      if (!els.headerSearchWrap) return;
      if (els.headerSearchWrap.contains(e.target)) return;
      closeSearchDropdown();
      if (!els.chatSearchInput.value.trim()) closeSearch(false);
    });

    // Esc 同时关闭空输入状态，焦点退回移动端入口。
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!els.headerSearchWrap || (!els.headerSearchWrap.classList.contains('search-expanded') &&
          els.chatSearchDropdown.hidden && document.activeElement !== els.chatSearchInput)) return;
      closeSearch(true);
    });
  }

  window.MyChatSearch = {
    init: init,
    bindSearchEvents: bindSearchEvents,
    openSearch: openSearch,
    closeSearch: closeSearch,
    closeSearchDropdown: closeSearchDropdown,
    renderSearchDropdown: renderSearchDropdown
  };
})();
