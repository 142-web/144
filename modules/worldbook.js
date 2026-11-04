/**
 * modules/worldbook.js —— 世界书扩展模块（SillyTavern 风格）
 *
 * 设计铁律：
 *  1. 全模块包在 IIFE 内，只通过 window.MyChat 桥接器与核心通信，绝不读写 app.js 私有变量；
 *  2. 不依赖任何外部库 / ES Module，双击 index.html（file://）即可运行；
 *  3. 词条注入只作用于「本轮发往 API 的临时 messages 数组」，绝不污染 session.messages 本地聊天记录；
 *  4. 数据统一存放于 localStorage: mychat_worldbooks（由核心负责云同步打包 / 恢复）。
 *
 * 数据结构：
 *   mychat_worldbooks = [
 *     {
 *       id: 'wb_xxx',
 *       name: '世界书名称',
 *       entries: [
 *         {
 *           id: 'wbe_xxx',
 *           name: '词条名称 / 备注',
 *           constant: false,           // true = 常驻（每轮必注入），false = 关键词触发
 *           keys: ['关键词1', '关键词2'],
 *           content: '注入给 AI 的设定内容',
 *           scanDepth: 4,              // 关键词模式下扫描最近多少条消息
 *           position: 'before_system' | 'after_system' | 'at_depth',
 *           depth: 1,                  // position 为 at_depth 时的深度值（0 = 最底部）
 *           enabled: true
 *         }
 *       ]
 *     }
 *   ]
 *
 *   session.worldbookIds = ['wb_xxx']  —— 当前窗口启用的世界书（所有子对话共享）
 */
(function () {
  'use strict';

  var bridge = window.MyChat;
  if (!bridge || typeof bridge.registerHook !== 'function') {
    console.warn('[世界书] 未检测到 window.MyChat 桥接器，模块跳过加载（请确认 app.js 已先加载）');
    return;
  }

  /* ================= 常量与状态 ================= */

  var POSITIONS = ['before_system', 'after_system', 'at_depth'];

  // 界面状态（只在模块内部使用）
  var uiState = {
    activeBookId: '',   // 当前正在查看 / 编辑的世界书
    keyword: '',        // 词条搜索关键词
    editingEntryId: '', // 空字符串 = 正在新建词条
    dragEntryId: ''     // 拖拽排序中的词条 ID
  };

  /* ================= 通用小工具 ================= */

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * HTML 转义：避免词条名称 / 关键词里的尖括号破坏行结构
   * 实体全部用 String.fromCharCode 拼装，规避编辑器 / 转码工具把实体字符二次解码的问题
   */
  var AMP = '&' + 'amp;';
  var LT = '&' + 'lt;';
  var GT = '&' + 'gt;';
  var QUOT = '&' + 'quot;';
  // 单引号实体：& # 3 9 ;
  var APOS = '&#' + String.fromCharCode(51) + String.fromCharCode(57) + ';';

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (ch) {
      if (ch === '&') return AMP;
      if (ch === '<') return LT;
      if (ch === '>') return GT;
      if (ch === '"') return QUOT;
      if (ch === "'") return APOS;
      return ch;
    });
  }

  /**
   * 关键词输入框拆分：中英文逗号、分号、竖线、换行都视为分隔符
   */
  function splitKeys(text) {
    var list = [];
    String(text == null ? '' : text)
      .split(/[,，;；|\n]/)
      .forEach(function (item) {
        var key = item.trim();
        if (key && list.indexOf(key) === -1) list.push(key);
      });
    return list;
  }

  function clampInt(value, min, max, fallback) {
    var num = parseInt(value, 10);
    if (!isFinite(num)) return fallback;
    if (num < min) return min;
    if (num > max) return max;
    return num;
  }

  /* ================= 数据规范化 ================= */

  function normalizeEntry(raw, idx) {
    var src = raw && typeof raw === 'object' ? raw : {};

    var keys = [];
    if (Array.isArray(src.keys)) {
      src.keys.forEach(function (key) {
        if (typeof key === 'string' && key.trim() && keys.indexOf(key.trim()) === -1) {
          keys.push(key.trim());
        }
      });
    } else if (typeof src.keys === 'string') {
      keys = splitKeys(src.keys);
    }

    var position = POSITIONS.indexOf(src.position) !== -1 ? src.position : 'at_depth';

    return {
      id: typeof src.id === 'string' && src.id ? src.id : uid('wbe') + '_' + idx,
      name:
        typeof src.name === 'string' && src.name.trim()
          ? src.name.trim()
          : '词条 ' + (idx + 1),
      // 原始备注：MVU 变量初始化条目（[initvar]…勿开）靠它识别，必须保留
      comment: typeof src.comment === 'string' ? src.comment : '',
      constant: src.constant === true,
      keys: keys,
      content: typeof src.content === 'string' ? src.content : '',
      scanDepth: clampInt(src.scanDepth, 1, 99, 4),
      position: position,
      depth: clampInt(src.depth, 0, 99, 1),
      enabled: src.enabled !== false
    };
  }

  /**
   * 判断条目是否为 MVU 变量初始化条目
   * 作者惯例：名称 / 备注含 initvar 或「变量初始化」，且常带「勿开」提示
   * 这类条目只参与变量计算，绝不注入提示词
   */
  function isInitVarEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    var label = String(entry.name || '') + ' ' + String(entry.comment || '');
    return /initvar|变量初始化/i.test(label);
  }

  function normalizeBook(raw, idx) {
    var src = raw && typeof raw === 'object' ? raw : {};
    var entries = [];
    if (Array.isArray(src.entries)) {
      src.entries.forEach(function (item, i) {
        if (!item || typeof item !== 'object') return;
        entries.push(normalizeEntry(item, i));
      });
    }
    return {
      id: typeof src.id === 'string' && src.id ? src.id : uid('wb') + '_' + idx,
      name:
        typeof src.name === 'string' && src.name.trim()
          ? src.name.trim()
          : '世界书 ' + (idx + 1),
      entries: entries
    };
  }

  /**
   * 从核心读取世界书库并做内存规范化（不写库，避免无意义的云端上传）
   */
  function loadBooks() {
    var raw = typeof bridge.getWorldbooks === 'function' ? bridge.getWorldbooks() : [];
    var list = [];
    if (Array.isArray(raw)) {
      raw.forEach(function (item, idx) {
        if (!item || typeof item !== 'object' || item.comment === 'mychat_memory_book') return;
        list.push(normalizeBook(item, idx));
      });
    }
    return list;
  }

  /**
   * 写回核心（核心内部会刷新时间戳并触发云端静默上传）
   */
  function saveBooks(list) {
    if (typeof bridge.saveWorldbooks === 'function') {
      // 隐藏的旧记忆库留作备份，不因普通世界书编辑而丢失。
      var legacy = bridge.getWorldbooks().filter(function (book) { return book.comment === 'mychat_memory_book'; });
      bridge.saveWorldbooks(list.concat(legacy));
    }
    updateToolboxLabel();
  }

  function getSessionBookIds() {
    return typeof bridge.getSessionWorldbookIds === 'function'
      ? bridge.getSessionWorldbookIds() || []
      : [];
  }

  function saveSessionBookIds(ids) {
    if (typeof bridge.setSessionWorldbookIds === 'function') {
      bridge.setSessionWorldbookIds(ids);
    }
    updateToolboxLabel();
  }

  function getActiveBook(list) {
    var books = list || loadBooks();
    if (!books.length) return null;
    for (var i = 0; i < books.length; i++) {
      if (books[i].id === uiState.activeBookId) return books[i];
    }
    // 当前选中项已失效（被删除 / 云端覆盖）：自动回落到第一本
    uiState.activeBookId = books[0].id;
    return books[0];
  }


  /* ================= DOM 引用 ================= */

  var els = {};

  function bindEls() {
    els.modal = document.getElementById('worldbook-modal');
    els.close = document.getElementById('wb-close');
    els.pills = document.getElementById('wb-session-pills');
    els.select = document.getElementById('wb-select');
    els.newBtn = document.getElementById('wb-new-btn');
    els.renameBtn = document.getElementById('wb-rename-btn');
    els.deleteBtn = document.getElementById('wb-delete-btn');
    els.importBtn = document.getElementById('wb-import-btn');
    els.exportBtn = document.getElementById('wb-export-btn');
    els.importFile = document.getElementById('wb-import-file');
    els.search = document.getElementById('wb-search');
    els.addEntryBtn = document.getElementById('wb-add-entry-btn');
    els.entryList = document.getElementById('wb-entry-list');
    els.entryEmpty = document.getElementById('wb-entry-empty');

    els.editor = document.getElementById('wb-entry-editor');
    els.edClose = document.getElementById('wb-ed-close');
    els.edName = document.getElementById('wb-ed-name');
    els.edMode = document.getElementById('wb-ed-mode');
    els.edKeys = document.getElementById('wb-ed-keys');
    els.edKeysField = document.getElementById('wb-ed-keys-field');
    els.edScan = document.getElementById('wb-ed-scan');
    els.edScanField = document.getElementById('wb-ed-scan-field');
    els.edPosition = document.getElementById('wb-ed-position');
    els.edDepth = document.getElementById('wb-ed-depth');
    els.edDepthField = document.getElementById('wb-ed-depth-field');
    els.edContent = document.getElementById('wb-ed-content');
    els.edFoot = document.getElementById('wb-ed-foot');
    els.edCancel = document.getElementById('wb-ed-cancel');
    els.edSave = document.getElementById('wb-ed-save');
    els.toolboxBtn = document.getElementById('input-toolbox-btn');
    els.worldbookToolBtn = document.getElementById('toolbox-worldbook-btn');
    els.toolboxLabel = document.getElementById('toolbox-worldbook-label');
  }

  /* ================= 工具箱按钮 ================= */

  /**
   * 刷新工具箱按钮：本窗口已启用世界书时显示「世界书 (n)」
   */
  function updateToolboxLabel() {
    if (!els.toolboxLabel) return;
    var books = loadBooks();
    var enabled = getSessionBookIds();
    var count = 0;
    books.forEach(function (book) {
      if (enabled.indexOf(book.id) !== -1) count++;
    });
    els.toolboxLabel.textContent = count > 0 ? '世界书 (' + count + ')' : '世界书';
  }

  /* ================= 弹窗渲染 ================= */

  /**
   * 顶部左侧：当前会话启用的世界书勾选胶囊（多选）
   */
  function renderPills(books) {
    if (!els.pills) return;
    var enabled = getSessionBookIds();
    els.pills.innerHTML = '';

    if (!books.length) {
      var tip = document.createElement('span');
      tip.className = 'wb-pills-empty';
      tip.textContent = '暂无世界书，请先新建';
      els.pills.appendChild(tip);
      return;
    }

    books.forEach(function (book) {
      var on = enabled.indexOf(book.id) !== -1;
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'wb-pill' + (on ? ' on' : '');
      pill.setAttribute('data-book-id', book.id);
      pill.setAttribute('aria-pressed', on ? 'true' : 'false');
      pill.title = on ? '点击关闭该世界书（本窗口）' : '点击启用该世界书（本窗口）';
      pill.innerHTML =
        '<span class="wb-pill-dot"></span><span class="wb-pill-text">' +
        escapeHtml(book.name) +
        '</span>';
      els.pills.appendChild(pill);
    });
  }

  /**
   * 顶部右侧：当前正在查看 / 编辑的世界书下拉框
   */
  function renderSelect(books) {
    if (!els.select) return;
    els.select.innerHTML = '';
    if (!books.length) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（暂无世界书）';
      els.select.appendChild(opt);
      els.select.disabled = true;
      return;
    }
    els.select.disabled = false;
    books.forEach(function (book) {
      var option = document.createElement('option');
      option.value = book.id;
      option.textContent = book.name + '（' + book.entries.length + ' 条）';
      if (book.id === uiState.activeBookId) option.selected = true;
      els.select.appendChild(option);
    });
  }

  /**
   * 词条行的位置描述：只显示简短标签（#0 之前 / #0 之后 / @Depth n）
   */
  function entryPositionLabel(entry) {
    if (entry.position === 'before_system') return '#0 之前';
    if (entry.position === 'after_system') return '#0 之后';
    return '@Depth ' + entry.depth;
  }

  var ICON_EDIT =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 20h4.2L19 9.2 14.8 5 4 15.8z"/><path d="M13.6 6.2 17.8 10.4"/></svg>';

  /**
   * 词条列表（支持搜索过滤 / 拖拽排序 / 开关 / 编辑 / 删除）
   */
  function renderEntries(books) {
    if (!els.entryList) return;
    var book = getActiveBook(books);
    els.entryList.innerHTML = '';

    if (!book) {
      if (els.entryEmpty) {
        els.entryEmpty.hidden = false;
        els.entryEmpty.textContent = '还没有任何世界书，点击「+ 新建世界书」创建第一本。';
      }
      return;
    }

    var keyword = uiState.keyword.trim().toLowerCase();
    var visible = book.entries.filter(function (entry) {
      if (!keyword) return true;
      var haystack = (entry.name + ' ' + entry.keys.join(' ') + ' ' + entry.content).toLowerCase();
      return haystack.indexOf(keyword) !== -1;
    });

    if (els.entryEmpty) {
      els.entryEmpty.hidden = visible.length > 0;
      els.entryEmpty.textContent = keyword
        ? '没有匹配「' + uiState.keyword + '」的词条。'
        : '当前世界书还没有词条，点击「+ 新增条目」开始编写。';
    }

    visible.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'wb-entry' + (entry.enabled ? '' : ' off');
      row.setAttribute('data-entry-id', entry.id);

      var modeText = entry.constant ? '常驻' : '关键词';
      var metaText = entry.constant
        ? '每轮必注入'
        : '关键词：' + (entry.keys.length ? entry.keys.join(' / ') : '（未设置）');

      row.innerHTML =
        '<span class="wb-drag" title="按住拖动排序">⠿</span>' +
        '<button type="button" class="wb-mode-btn" data-act="mode" title="点击切换激活方式">' +
        '<span class="wb-dot ' + (entry.constant ? 'constant' : 'keyword') + '"></span>' +
        escapeHtml(modeText) +
        '</button>' +
        '<div class="wb-entry-main">' +
        '<div class="wb-entry-name">' + escapeHtml(entry.name) + '</div>' +
        '<div class="wb-entry-meta"><span class="wb-entry-meta-text">' + escapeHtml(metaText) +
        '</span><span class="wb-pos-tag">' + escapeHtml(entryPositionLabel(entry)) + '</span></div>' +
        '</div>' +
        '<button type="button" class="wb-icon-btn" data-act="edit" title="编辑词条">' + ICON_EDIT + '</button>' +
        '<button type="button" class="wb-icon-btn wb-icon-danger" data-act="del" title="删除词条">×</button>' +
        '<button type="button" class="wb-switch' + (entry.enabled ? ' on' : '') +
        '" data-act="toggle" aria-pressed="' + (entry.enabled ? 'true' : 'false') +
        '" title="启用 / 停用该词条"><span class="wb-switch-knob"></span></button>';

      els.entryList.appendChild(row);
    });
  }

  /**
   * 整体重绘（弹窗打开 / 数据变更时调用）
   */
  function renderAll() {
    var books = loadBooks();
    renderPills(books);
    renderSelect(books);
    renderEntries(books);
    updateToolboxLabel();
  }

  /* ================= 世界书弹窗开关 ================= */

  function openModal() {
    if (!els.modal) return;
    uiState.keyword = '';
    if (els.search) els.search.value = '';
    renderAll();
    els.modal.classList.add('show');
    els.modal.setAttribute('aria-hidden', 'false');
  }

  // 关闭弹窗前移走焦点，避免 Chrome 打印 aria-hidden 焦点保留警告
  function blurInside(modal) {
    if (!modal) return;
    var active = document.activeElement;
    if (active && active !== document.body && modal.contains(active)) {
      try {
        active.blur();
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  function closeModal() {
    if (!els.modal) return;
    blurInside(els.modal);
    els.modal.classList.remove('show');
    els.modal.setAttribute('aria-hidden', 'true');
  }

  /* ================= 词条编辑器 ================= */

  /**
   * 根据激活方式 / 插入位置显示相应的条件字段
   */
  function syncEditorVisibility() {
    var constant = els.edMode ? els.edMode.value === 'constant' : false;
    if (els.edKeysField) els.edKeysField.hidden = constant;
    if (els.edScanField) els.edScanField.hidden = constant;
    var atDepth = els.edPosition ? els.edPosition.value === 'at_depth' : false;
    if (els.edDepthField) els.edDepthField.hidden = !atDepth;
  }

  /**
   * 打开词条编辑器：entry 为空 = 新建
   */
  function openEntryEditor(entry) {
    if (!els.editor) return;
    var target = entry || null;
    uiState.editingEntryId = target ? target.id : '';

    if (els.edName) els.edName.value = target ? target.name : '';
    if (els.edMode) els.edMode.value = target && target.constant ? 'constant' : 'keyword';
    if (els.edKeys) els.edKeys.value = target ? target.keys.join(', ') : '';
    if (els.edScan) els.edScan.value = target ? target.scanDepth : 4;
    if (els.edPosition) els.edPosition.value = target ? target.position : 'at_depth';
    if (els.edDepth) els.edDepth.value = target ? target.depth : 1;
    if (els.edContent) els.edContent.value = target ? target.content : '';
    if (els.edFoot) {
      els.edFoot.textContent = target ? '正在编辑已有词条' : '正在新增词条';
    }

    syncEditorVisibility();
    els.editor.classList.add('show');
    els.editor.setAttribute('aria-hidden', 'false');
  }

  function closeEntryEditor() {
    if (!els.editor) return;
    blurInside(els.editor);
    els.editor.classList.remove('show');
    els.editor.setAttribute('aria-hidden', 'true');
    uiState.editingEntryId = '';
  }

  /**
   * 保存词条：只有点击「保存」才会写入存储
   */
  async function saveEntryEditor() {
    var books = loadBooks();
    var book = getActiveBook(books);
    if (!book) {
      await window.showAppAlert('请先新建世界书');
      return;
    }

    var constant = els.edMode ? els.edMode.value === 'constant' : false;
    var keys = els.edKeys ? splitKeys(els.edKeys.value) : [];
    if (!constant && keys.length === 0) {
      await window.showAppAlert('请填写触发关键词');
      if (els.edKeys) els.edKeys.focus();
      return;
    }

    var content = els.edContent ? els.edContent.value.trim() : '';
    if (!content) {
      await window.showAppAlert('词条内容不能为空');
      if (els.edContent) els.edContent.focus();
      return;
    }

    var name = els.edName ? els.edName.value.trim() : '';
    if (!name) name = keys.length ? keys[0] : '未命名词条';

    var position = els.edPosition ? els.edPosition.value : 'at_depth';
    if (POSITIONS.indexOf(position) === -1) position = 'at_depth';

    var payload = {
      name: name,
      constant: constant,
      keys: keys,
      content: content,
      scanDepth: clampInt(els.edScan ? els.edScan.value : 4, 1, 99, 4),
      position: position,
      depth: clampInt(els.edDepth ? els.edDepth.value : 1, 0, 99, 1),
      enabled: true
    };

    var editing = null;
    if (uiState.editingEntryId) {
      editing = book.entries.filter(function (item) {
        return item.id === uiState.editingEntryId;
      })[0];
      if (editing) payload.enabled = editing.enabled;
    }

    if (editing) {
      Object.keys(payload).forEach(function (key) {
        editing[key] = payload[key];
      });
    } else {
      payload.id = uid('wbe');
      book.entries.push(payload);
    }

    saveBooks(books);
    closeEntryEditor();
    renderAll();
  }

  /* ================= 世界书增删改 / 导入导出 ================= */

  async function createBookFlow() {
    var name = await window.showAppPrompt('世界书名称', '新的世界书');
    if (name === null) return;
    var title = String(name).trim() || '新的世界书';
    var books = loadBooks();
    var book = { id: uid('wb'), name: title, entries: [] };
    books.push(book);
    uiState.activeBookId = book.id;
    saveBooks(books);
    renderAll();
  }

  async function renameBookFlow() {
    var books = loadBooks();
    var book = getActiveBook(books);
    if (!book) return;
    var snapshot = JSON.stringify(books);
    var name = await window.showAppPrompt('世界书名称', book.name);
    if (name === null || JSON.stringify(loadBooks()) !== snapshot) return;
    var title = String(name).trim();
    if (!title) return;
    book.name = title;
    saveBooks(books);
    renderAll();
  }

  async function deleteBookFlow() {
    var books = loadBooks();
    var book = getActiveBook(books);
    if (!book) return;
    var snapshot = JSON.stringify(books);
    if (!await window.showAppConfirm('删除世界书及词条「' + book.name + '」？')) return;
    if (JSON.stringify(loadBooks()) !== snapshot) return;

    var next = books.filter(function (item) {
      return item.id !== book.id;
    });
    // 同步把该世界书从当前会话的启用列表中移除
    var enabled = getSessionBookIds().filter(function (id) {
      return id !== book.id;
    });
    saveSessionBookIds(enabled);
    uiState.activeBookId = next.length ? next[0].id : '';
    saveBooks(next);
    renderAll();
  }

  function exportBook() {
    var books = loadBooks();
    var book = getActiveBook(books);
    if (!book) {
      void window.showAppAlert('没有可导出的世界书');
      return;
    }
    // 导出时额外带上酒馆兼容字段，方便在 SillyTavern 中重新导入
    var entries = {};
    book.entries.forEach(function (entry, idx) {
      entries[String(idx)] = {
        uid: idx,
        comment: entry.name,
        key: entry.constant ? [] : entry.keys.slice(),
        keysecondary: [],
        content: entry.content,
        constant: entry.constant === true,
        disable: entry.enabled === false,
        scanDepth: entry.scanDepth,
        depth: entry.depth,
        position: entry.position === 'before_system' ? 0 : entry.position === 'after_system' ? 1 : 4,
        selective: true
      };
    });
    var data = {
      name: book.name,
      entries: entries,
      // 同时保留一份本应用的原始结构，二次导入时不丢信息
      mychat: { id: book.id, name: book.name, entries: book.entries }
    };
    var text = JSON.stringify(data, null, 2);
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = book.name + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);
  }

  /**
   * 读取酒馆 V3 排序字段（insertion_order / order），缺失时返回极大值保证排在最后
   */
  function readInsertionOrder(src) {
    if (!src || typeof src !== 'object') return Number.MAX_SAFE_INTEGER;
    var ext = src.extensions && typeof src.extensions === 'object' ? src.extensions : {};
    var candidates = [src.insertion_order, src.order, ext.insertion_order, ext.order];
    for (var i = 0; i < candidates.length; i++) {
      var num = candidates[i];
      if (typeof num === 'number' && isFinite(num)) return num;
      if (typeof num === 'string' && num.trim() && isFinite(parseFloat(num))) {
        return parseFloat(num);
      }
    }
    return Number.MAX_SAFE_INTEGER;
  }

  /**
   * 把任意形态的 entries（数组 / 对象）整理成数组，并按 insertion_order 升序稳定排序
   */
  function collectTavernEntries(entriesRaw) {
    var list = [];
    if (Array.isArray(entriesRaw)) {
      entriesRaw.forEach(function (item) {
        if (item && typeof item === 'object') list.push(item);
      });
    } else if (entriesRaw && typeof entriesRaw === 'object') {
      Object.keys(entriesRaw).forEach(function (key) {
        var item = entriesRaw[key];
        if (item && typeof item === 'object') list.push(item);
      });
    }
    // 稳定排序：order 相同时保持文件中的原始先后顺序
    return list
      .map(function (item, i) {
        return { item: item, order: readInsertionOrder(item), idx: i };
      })
      .sort(function (a, b) {
        return a.order === b.order ? a.idx - b.idx : a.order - b.order;
      })
      .map(function (wrap) {
        return wrap.item;
      });
  }

  /**
   * 把酒馆世界书条目映射为本模块词条结构（兼容 V1 / V2 / V3 三种字段写法）
   */
  function mapTavernEntry(raw, idx) {
    var src = raw && typeof raw === 'object' ? raw : {};
    var ext = src.extensions && typeof src.extensions === 'object' ? src.extensions : {};

    // 触发键：V3 使用 keys，旧版 / 部分卡使用 key（数组或逗号分隔字符串）
    var keysSrc = src.keys != null ? src.keys : src.key;
    if (keysSrc == null && ext.keys != null) keysSrc = ext.keys;
    var keys = [];
    if (Array.isArray(keysSrc)) {
      keysSrc.forEach(function (key) {
        if (typeof key === 'string' && key.trim() && keys.indexOf(key.trim()) === -1) {
          keys.push(key.trim());
        }
      });
    } else if (typeof keysSrc === 'string') {
      keys = splitKeys(keysSrc);
    }

    // 位置映射：V3 主要写在 extensions.position，旧版直接写在 position 上
    // 0 / 'before_char' = #0 之前；1 / 'after_char' = #0 之后；4 / 'at_depth' = 按深度插入
    var rawPosition = ext.position != null ? ext.position : src.position;
    var position = 'at_depth';
    if (rawPosition === 0 || rawPosition === 'before_char' || rawPosition === 'before_system') {
      position = 'before_system';
    } else if (rawPosition === 1 || rawPosition === 'after_char' || rawPosition === 'after_system') {
      position = 'after_system';
    } else if (rawPosition === 4 || rawPosition === 'at_depth') {
      position = 'at_depth';
    } else if (typeof rawPosition === 'string' && POSITIONS.indexOf(rawPosition) !== -1) {
      position = rawPosition;
    } else if (typeof ext.depth === 'number' || typeof src.depth === 'number') {
      position = 'at_depth';
    }

    // 深度：extensions.depth ?? depth ?? 4（@Depth 生效时缺省 4，其余位置深度无意义）
    var depthSrc = ext.depth != null ? ext.depth : src.depth;
    var depth = typeof depthSrc === 'number' && isFinite(depthSrc) ? depthSrc : 1;
    if (position === 'at_depth' && !(depth > 0)) depth = 4;

    // 扫描深度：旧版 scanDepth，V3 为 extensions.scan_depth
    var scanSrc = src.scanDepth != null ? src.scanDepth : ext.scan_depth;

    var content = typeof src.content === 'string' ? src.content : '';
    var name =
      (typeof src.comment === 'string' && src.comment.trim()) ||
      (typeof src.name === 'string' && src.name.trim()) ||
      (keys.length ? keys[0] : '') ||
      (content ? content.slice(0, 16) : '词条 ' + (idx + 1));

    // 停用标记：酒馆用 disable = true，部分卡写在 extensions.enabled = false
    var disabled =
      src.disable === true || ext.disable === true || src.enabled === false || ext.enabled === false;

    return normalizeEntry(
      {
        name: name,
        // 酒馆的 comment 就是词条标题，保留下来供 MVU initvar 识别
        comment: typeof src.comment === 'string' ? src.comment : name,
        constant: src.constant === true || ext.constant === true,
        keys: keys,
        content: content,
        scanDepth: scanSrc,
        position: position,
        depth: depth,
        enabled: !disabled
      },
      idx
    );
  }

  /**
   * 解析任意酒馆世界书 JSON：{ entries: { "0": {...} } } 或 entries 为数组
   */
  function parseTavernJson(text) {
    var data = JSON.parse(text);
    var entriesRaw = data && typeof data === 'object' ? data.entries : null;
    if (!entriesRaw && Array.isArray(data)) entriesRaw = data;

    var rawList = collectTavernEntries(entriesRaw);
    if (!rawList.length) {
      throw new Error('未找到 entries 字段，可能不是世界书文件');
    }
    var list = rawList.map(function (item, idx) {
      return mapTavernEntry(item, idx);
    });

    var name =
      (data && typeof data.name === 'string' && data.name.trim()) ||
      (data && typeof data.originalData === 'string' && data.originalData.trim()) ||
      '导入的世界书';
    return { name: name, entries: list };
  }

  function importBookFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      try {
        var parsed = parseTavernJson(String(reader.result || ''));
        if (!parsed.entries.length) {
          await window.showAppAlert('文件中没有词条');
          return;
        }
        var books = loadBooks();
        var book = { id: uid('wb'), name: parsed.name, entries: parsed.entries };
        books.push(book);
        uiState.activeBookId = book.id;
        saveBooks(books);
        renderAll();
        await window.showAppAlert('已导入 ' + book.entries.length + ' 条词条');
      } catch (err) {
        await window.showAppAlert('导入失败：' + (err && err.message ? err.message : '文件格式不正确'));
      }
    };
    reader.onerror = function () {
      void window.showAppAlert('读取文件失败');
    };
    reader.readAsText(file, 'utf-8');
  }

  /**
   * 对外公共方法：把酒馆角色卡里的 character_book 直接导成一本世界书
   * @param {Object} bookData 角色卡 data.character_book
   * @param {String} defaultBookName 缺名字时的兜底书名
   * @returns {String} 新世界书 id（失败返回空字符串）
   */
  function importCharacterBook(bookData, defaultBookName) {
    try {
      var src = bookData && typeof bookData === 'object' ? bookData : null;
      if (!src) return '';
      var rawList = collectTavernEntries(src.entries);
      if (!rawList.length) {
        console.warn('[世界书] 角色书没有可导入的词条');
        return '';
      }
      var entries = rawList.map(function (item, idx) {
        return mapTavernEntry(item, idx);
      });
      if (!entries.length) return '';

      var name =
        (typeof src.name === 'string' && src.name.trim()) ||
        (typeof defaultBookName === 'string' && defaultBookName.trim()) ||
        '角色书';

      var books = loadBooks();
      var exist = null;
      books.forEach(function (book) {
        if (book && book.name === name) exist = book;
      });
      var book = exist || { id: uid('wb'), name: name, entries: [] };
      book.entries = entries;
      if (!exist) books.push(book);

      uiState.activeBookId = book.id;
      saveBooks(books);
      renderAll();
      return book.id;
    } catch (err) {
      console.warn('[世界书] 角色书导入失败', err);
      return '';
    }
  }

  /* ================= 拖拽排序 ================= */

  function bindDragSort() {
    if (!els.entryList) return;

    els.entryList.addEventListener('mousedown', function (e) {
      var handle = e.target.closest ? e.target.closest('.wb-drag') : null;
      if (!handle) return;
      var row = handle.closest('.wb-entry');
      if (row) row.setAttribute('draggable', 'true');
    });

    els.entryList.addEventListener('dragstart', function (e) {
      var row = e.target.closest ? e.target.closest('.wb-entry') : null;
      if (!row || row.getAttribute('draggable') !== 'true') {
        e.preventDefault();
        return;
      }
      uiState.dragEntryId = row.getAttribute('data-entry-id') || '';
      row.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', uiState.dragEntryId);
        } catch (err) {
          /* 部分浏览器对 setData 有限制，忽略即可 */
        }
      }
    });

    els.entryList.addEventListener('dragover', function (e) {
      if (!uiState.dragEntryId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      var dragging = els.entryList.querySelector('.wb-entry.dragging');
      if (!dragging) return;
      var after = getDragAfterElement(els.entryList, e.clientY);
      if (!after) els.entryList.appendChild(dragging);
      else els.entryList.insertBefore(dragging, after);
    });

    els.entryList.addEventListener('drop', function (e) {
      if (uiState.dragEntryId) e.preventDefault();
    });

    els.entryList.addEventListener('dragend', function () {
      var dragging = els.entryList.querySelector('.wb-entry.dragging');
      if (dragging) {
        dragging.classList.remove('dragging');
        dragging.removeAttribute('draggable');
      }
      if (!uiState.dragEntryId) return;
      commitEntryOrder();
      uiState.dragEntryId = '';
    });
  }

  function getDragAfterElement(container, y) {
    var rows = Array.prototype.slice.call(
      container.querySelectorAll('.wb-entry:not(.dragging)')
    );
    var closest = null;
    var closestOffset = Number.NEGATIVE_INFINITY;
    rows.forEach(function (row) {
      var box = row.getBoundingClientRect();
      var offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closestOffset) {
        closestOffset = offset;
        closest = row;
      }
    });
    return closest;
  }

  /**
   * 把界面上的行顺序写回词条数组（含被搜索过滤掉的行，保持其原有相对顺序）
   */
  function commitEntryOrder() {
    if (!els.entryList) return;
    var books = loadBooks();
    var book = getActiveBook(books);
    if (!book) return;

    var ordered = [];
    Array.prototype.slice.call(els.entryList.querySelectorAll('.wb-entry')).forEach(function (row) {
      var id = row.getAttribute('data-entry-id');
      var entry = book.entries.filter(function (item) {
        return item.id === id;
      })[0];
      if (entry) ordered.push(entry);
    });

    // 搜索过滤状态下，未显示的词条原顺序追加在末尾，避免丢词条
    book.entries.forEach(function (entry) {
      var found = ordered.filter(function (item) {
        return item.id === entry.id;
      }).length;
      if (!found) ordered.push(entry);
    });

    book.entries = ordered;
    saveBooks(books);
  }

  /* ================= 词条列表交互（事件委托） ================= */

  function bindEntryEvents() {
    if (!els.entryList) return;

    els.entryList.addEventListener('click', async function (e) {
      var target = e.target;
      if (!target || !target.closest) return;
      var row = target.closest('.wb-entry');
      if (!row) return;
      var entryId = row.getAttribute('data-entry-id');
      var action = target.closest('[data-act]');
      var act = action ? action.getAttribute('data-act') : '';

      var books = loadBooks();
      var book = getActiveBook(books);
      if (!book) return;
      var entry = book.entries.filter(function (item) {
        return item.id === entryId;
      })[0];
      if (!entry) return;

      if (act === 'toggle') {
        entry.enabled = !entry.enabled;
        saveBooks(books);
        renderEntries(books);
        return;
      }
      if (act === 'mode') {
        // 切换为常驻时保留原关键词，切回关键词模式可直接复用
        if (!entry.constant && entry.keys.length === 0) {
          openEntryEditor(entry);
          return;
        }
        entry.constant = !entry.constant;
        saveBooks(books);
        renderEntries(books);
        return;
      }
      if (act === 'edit') {
        openEntryEditor(entry);
        return;
      }
      if (act === 'del') {
        var snapshot = JSON.stringify(books);
        if (!await window.showAppConfirm('删除词条「' + entry.name + '」？')) return;
        if (JSON.stringify(loadBooks()) !== snapshot) return;
        book.entries = book.entries.filter(function (item) {
          return item.id !== entryId;
        });
        saveBooks(books);
        renderAll();
      }
    });
  }

  /* ================= 弹窗内其它事件 ================= */

  function bindModalEvents() {
    if (els.close) els.close.addEventListener('click', closeModal);

    // 点击遮罩空白处关闭（编辑器优先处理，避免两层同时关闭）
    if (els.modal) {
      els.modal.addEventListener('click', function (e) {
        if (e.target === els.modal) closeModal();
      });
    }
    if (els.editor) {
      els.editor.addEventListener('click', function (e) {
        if (e.target === els.editor) closeEntryEditor();
      });
    }

    // 顶部胶囊：切换当前会话启用状态
    if (els.pills) {
      els.pills.addEventListener('click', function (e) {
        var pill = e.target.closest ? e.target.closest('.wb-pill') : null;
        if (!pill) return;
        var bookId = pill.getAttribute('data-book-id');
        if (!bookId) return;
        var enabled = getSessionBookIds();
        var pos = enabled.indexOf(bookId);
        if (pos === -1) enabled.push(bookId);
        else enabled.splice(pos, 1);
        saveSessionBookIds(enabled);
        renderPills(loadBooks());
      });
    }

    if (els.select) {
      els.select.addEventListener('change', function () {
        uiState.activeBookId = els.select.value || '';
        uiState.keyword = '';
        if (els.search) els.search.value = '';
        renderEntries(loadBooks());
      });
    }

    if (els.newBtn) els.newBtn.addEventListener('click', createBookFlow);
    if (els.renameBtn) els.renameBtn.addEventListener('click', renameBookFlow);
    if (els.deleteBtn) els.deleteBtn.addEventListener('click', deleteBookFlow);
    if (els.exportBtn) els.exportBtn.addEventListener('click', exportBook);

    if (els.importBtn && els.importFile) {
      els.importBtn.addEventListener('click', function () {
        els.importFile.value = '';
        els.importFile.click();
      });
      els.importFile.addEventListener('change', function () {
        var file = els.importFile.files && els.importFile.files[0];
        if (file) importBookFile(file);
      });
    }

    if (els.search) {
      els.search.addEventListener('input', function () {
        uiState.keyword = els.search.value || '';
        renderEntries(loadBooks());
      });
    }

    if (els.addEntryBtn) {
      els.addEntryBtn.addEventListener('click', function () {
        var book = getActiveBook(loadBooks());
        if (!book) {
          void window.showAppAlert('请先新建世界书');
          return;
        }
        openEntryEditor(null);
      });
    }

    // 编辑器
    if (els.edClose) els.edClose.addEventListener('click', closeEntryEditor);
    if (els.edCancel) els.edCancel.addEventListener('click', closeEntryEditor);
    if (els.edSave) els.edSave.addEventListener('click', saveEntryEditor);
    if (els.edMode) els.edMode.addEventListener('change', syncEditorVisibility);
    if (els.edPosition) els.edPosition.addEventListener('change', syncEditorVisibility);

    // 工具箱入口：点击「世界书」打开管理弹窗（app.js 只负责关闭工具箱）
    if (els.worldbookToolBtn) {
      els.worldbookToolBtn.addEventListener('click', function () {
        openModal();
      });
    }
    // 展开工具箱前刷新按钮计数，保证切换会话后显示的是最新启用数量
    if (els.toolboxBtn) {
      els.toolboxBtn.addEventListener('click', updateToolboxLabel);
    }

    // Esc 逐层关闭：先关词条编辑器，再关世界书弹窗
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (els.editor && els.editor.classList.contains('show')) {
        closeEntryEditor();
        return;
      }
      if (els.modal && els.modal.classList.contains('show')) closeModal();
    });
  }

  /* ================= 核心：词条触发与注入 ================= */

  /**
   * 收集本轮命中的词条
   *  - 蓝灯常驻（entry.constant === true）：照常注入 apiMessages，但【绝不】计入统计明细
   *  - 绿灯关键词：扫描最近 scanDepth 条历史消息，命中后计入统计明细
   * 返回 { hits, details }
   *  hits    : [{ entry, bookName, matchedKey }] 需要注入的全部词条（含常驻）
   *  details : [{ bookName, entryName, matchedKey, position, depth, content }] 仅关键词命中的明细
   */
  function collectTriggeredEntries(apiMessages, session, retrievalTriggers, retrievalBookId, subChatId) {
    // 检索结果只能精确触发本轮指定记忆库，不能越权激活其他世界书。
    var forcedKeys = Array.isArray(retrievalTriggers) ? retrievalTriggers.filter(function (key) {
      return typeof key === 'string' && /^EVT_\d{3,}$/.test(key);
    }) : [];
    var enabledIds = session && Array.isArray(session.worldbookIds) ? session.worldbookIds : [];
    var memoryModule = window.MemorySummaryModule;
    var targetOwner = subChatId && session && Array.isArray(session.subChats)
      ? session.subChats.find(function (sub) { return sub.id === subChatId; }) : null;
    var virtualBook = memoryModule && typeof memoryModule.getVirtualMemoryBook === 'function' && (!subChatId || targetOwner)
      ? memoryModule.getVirtualMemoryBook(session, targetOwner) : null;
    if (!enabledIds.length && !virtualBook) return { hits: [], details: [] };

    var books = loadBooks().filter(function (book) { return enabledIds.indexOf(book.id) !== -1; });
    if (virtualBook) books.push(virtualBook);
    var hits = [];
    var details = [];

    // 只扫描对话历史，跳过 system 消息（#0 预设提示词不应反过来触发词条）
    var history = apiMessages.filter(function (msg) {
      return msg && msg.role !== 'system';
    });

    books.forEach(function (book) {
      book.entries.forEach(function (entry) {
        if (entry.enabled === false) return;
        // MVU 变量初始化条目只供变量引擎读取，绝不注入提示词
        if (isInitVarEntry(entry)) return;
        if (!entry.content || !entry.content.trim()) return;

        if (entry.constant) {
          // 常驻（蓝灯）条目：只负责注入，不进入 triggeredEntries 统计列表
          hits.push({ entry: entry, bookName: book.name, bookId:book.id, matchedKey: '' });
          return;
        }
        if (!entry.keys.length) return;

        // 虚拟记忆只接受本轮召回命中，不扫描自然对话中的内部编号。
        var forcedOnly = book.id === '__session_memory_vault__';
        var depth = clampInt(entry.scanDepth, 1, 99, 4);
        var scope = forcedOnly ? [] : history.slice(Math.max(0, history.length - depth));
        var haystack = scope
          .map(function (msg) {
            return String(msg && msg.content != null ? msg.content : '');
          })
          .join('\n')
          .toLowerCase();
        var matchedKey = '';
        var matched = entry.keys.some(function (key) {
          var forced = book.id === retrievalBookId && forcedKeys.indexOf(String(key)) !== -1;
          if (forcedOnly ? forced === true : (forced || haystack.indexOf(String(key).toLowerCase()) !== -1)) {
            matchedKey = String(key);
            return true;
          }
          return false;
        });
        if (!matched) return;

        hits.push({ entry: entry, bookName: book.name, bookId:book.id, matchedKey: matchedKey });
        details.push({
          bookName: book.name,
          entryName: entry.name,
          matchedKey: matchedKey,
          position: entry.position,
          depth: clampInt(entry.depth, 0, 99, 1),
          content: String(entry.content).trim()
        });
      });
    });

    return { hits: hits, details: details };
  }

  /**
   * 世界书注入主算法（beforesendContext 阶段调用）
   *  - before_system：拼到 #0 系统消息内容之前（无则新建）
   *  - after_system ：拼到 #0 系统消息内容之后（无则新建）
   *  - at_depth     ：按深度插入独立 system 消息
   */
  function virtualMemoryId(hit) {
    return String(hit.bookId || '').indexOf('memory') !== -1 && hit.bookName === '当前对话记忆库';
  }

  function applyWorldbooksToMessages(apiMessages, session, retrievalTriggers, retrievalBookId, subChatId) {
    var collected = collectTriggeredEntries(apiMessages, session, retrievalTriggers, retrievalBookId, subChatId);
    var hits = collected.hits;
    var details = collected.details;
    if (!hits.length) {
      return { apiMessages: apiMessages, triggeredEntryNames: [], triggeredEntries: [] };
    }

    var next = apiMessages.slice();
    var beforeParts = [];
    var afterParts = [];
    var depthItems = [];
    var names = [];
    var injectedEntries = [];

    // 统计名只取“关键词命中”的明细，常驻（蓝灯）条目不参与统计
    details.forEach(function (detail) {
      if (names.indexOf(detail.entryName) === -1) names.push(detail.entryName);
    });

    hits.forEach(function (hit) {
      var entry = hit.entry;
      var text = String(entry.content).trim();
      // 展开 {{char}} / {{user}} / MVU 变量宏，保证注入内容里的占位符被真实值替换
      if (text && typeof bridge.replaceMacros === 'function') {
        try {
          text = bridge.replaceMacros(text, session);
        } catch (macroErr) {
          console.warn('[世界书] 词条宏变量替换失败，已使用原文：', macroErr);
        }
      }
      if (!text) return;
      injectedEntries.push({bookName:hit.bookName, entryName:entry.name, content:text, constant:entry.constant === true,
        memory:virtualMemoryId(hit), position:entry.position, depth:entry.depth});
      if (entry.position === 'before_system') {
        beforeParts.push(text);
      } else if (entry.position === 'after_system') {
        afterParts.push(text);
      } else {
        depthItems.push({ text: text, depth: clampInt(entry.depth, 0, 99, 1) });
      }
    });

    // ---- 1. 处理 #0 系统消息（之前 / 之后） ----
    if (beforeParts.length || afterParts.length) {
      var sysIdx = -1;
      for (var i = 0; i < next.length; i++) {
        if (next[i] && next[i].role === 'system') {
          sysIdx = i;
          break;
        }
      }
      if (sysIdx === -1) {
        next.unshift({ role: 'system', content: '' });
        sysIdx = 0;
      }
      var sysMsg = next[sysIdx];
      var sysContent = typeof sysMsg.content === 'string' ? sysMsg.content : '';
      var pieces = [];
      if (beforeParts.length) pieces.push(beforeParts.join('\n\n'));
      if (sysContent.trim()) pieces.push(sysContent);
      if (afterParts.length) pieces.push(afterParts.join('\n\n'));
      next[sysIdx] = {
        role: 'system',
        content: pieces.join('\n\n')
      };
    }

    // ---- 2. 处理 @Depth 深度注入 ----
    if (depthItems.length) {
      // 跳过开头连续的 system 消息，找到真正的对话历史起点
      var startIdx = 0;
      while (startIdx < next.length && next[startIdx] && next[startIdx].role === 'system') {
        startIdx++;
      }
      var convoLen = Math.max(0, next.length - startIdx);
      var insertions = depthItems.map(function (item, order) {
        // depth 0 = 数组末尾（紧贴最新消息之后）；depth 1 = 倒数第 1 条消息上方
        var idx = startIdx + Math.max(0, convoLen - item.depth);
        return { idx: idx, text: item.text, order: order };
      });
      // 从后往前插入，保证前面计算出的下标依然有效
      insertions.sort(function (a, b) {
        if (b.idx !== a.idx) return b.idx - a.idx;
        return b.order - a.order;
      });
      insertions.forEach(function (ins) {
        next.splice(ins.idx, 0, { role: 'system', content: ins.text });
      });
    }

    return { apiMessages: next, triggeredEntryNames: names, triggeredEntries: details, injectedEntries: injectedEntries };
  }

  /**
   * 注册上下文级管道钩子：只改写本轮发往 API 的临时数组
   */
  bridge.registerHook('beforeSendContext', function (payload) {
    if (!payload || !Array.isArray(payload.apiMessages)) return undefined;
    var session = payload.session;
    if (!session) return undefined;
    var result = applyWorldbooksToMessages(
      payload.apiMessages, session, payload.retrievalTriggers, payload.retrievalBookId, payload.subChatId
    );
    return {
      apiMessages: result.apiMessages,
      triggeredEntryNames: result.triggeredEntryNames || [],
      triggeredEntries: result.triggeredEntries || [],
      injectedEntries: result.injectedEntries || []
    };
  });

  /* ================= 初始化 ================= */

  /**
   * 供核心（云同步恢复后）调用：重新从存储拉取数据并刷新界面
   */
  function reload() {
    renderAll();
  }

  function init() {
    bindEls();
    if (!els.modal) {
      console.warn('[世界书] 未找到 #worldbook-modal 节点，界面功能不可用');
    }
    bindModalEvents();
    bindEntryEvents();
    bindDragSort();
    updateToolboxLabel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 对外暴露最小接口（核心云同步恢复后会调用 reload）
  window.MyChatWorldbook = {
    reload: reload,
    applyWorldbooksToMessages: applyWorldbooksToMessages,
    // 供角色卡导入器（modules/tavern-importer.js）一键写入角色书，返回新世界书 id
    importCharacterBook: importCharacterBook
  };
})();
