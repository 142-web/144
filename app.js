/* ===================================================================
   MyChat 核心逻辑（纯原生 JavaScript，无需构建工具，浏览器直接运行）
   第 5 步范围：多渠道多模型管理 / 自动拉取模型 / 连通性检测 /
                智能跟随滚动 / 消息删除二次确认 / 底部快捷模型切换
   =================================================================== */
(function () {
  'use strict';

  // === [ANCHOR: STATE_STORAGE] 全局状态与本地存储键名定义 ===
  /* ================= 常量与状态 ================= */

  // 本地存储键名（API Key 只保存在本机，绝不出现在源码里）
  var CONFIG_KEY = 'mychat_config';          // 旧版单 API 配置 + 云同步配置
  var PROVIDERS_KEY = 'mychat_providers';    // 多渠道数组（新版）
  var ACTIVE_TARGET_KEY = 'mychat_active_target'; // 当前选中的 { providerId, modelId }
  var SESSIONS_KEY = 'mychat_sessions';      // 全部会话（数组）
  var CURRENT_ID_KEY = 'mychat_current_id';  // 当前选中会话的 id
  var LAST_MODIFIED_KEY = 'mychat_last_modified'; // 全局最后修改时间戳（毫秒）
  var LAST_SYNCED_CLOUD_STAMP_KEY = 'mychat_last_synced_cloud_stamp'; // 本设备云端一致性基准，不云同步
  var LAST_BACKUP_MAINT_AT_KEY = 'mychat_last_backup_maint_at'; // 本设备快照维护冷却，不云同步
  var THEME_KEY = 'mychat_theme';            // 主题偏好：light | dark
  var VIEW_KEY = 'mychat_view';              // 视图偏好：bubble | wide
  var CHAT_PARAMS_KEY = 'mychat_chat_params';        // 对话参数（云端同步预留槽位）
  var PROMPT_PRESETS_KEY = 'mychat_prompt_presets';  // 模块化系统提示词预设（云端同步预留槽位）
  var REGEX_RULES_KEY = 'mychat_regex_rules';        // 正则脚本与输入 / 输出预处理规则库（云端同步预留槽位）
  var WORLDBOOKS_KEY = 'mychat_worldbooks';          // 全局世界书库（数组，已接入云同步）
  var VOCAB_RULES_KEY = 'mychat_vocab_rules';
  var QUICK_REPLIES_KEY = 'mychat_quick_replies';
  var GLOBAL_TAVERN_VARS_KEY = 'mychat_global_tavern_vars';
  var AUTO_RETRY_KEY = 'mychat_auto_retry';
  var CLOUD_MIRROR_KEY = 'mychat_cloud_raw_mirror'; // 云端未知顶层字段底板，仅本地保存
  var TOKEN_CALIBRATION_KEY = 'mychat_token_calibration'; // 设备本地模型估算系数，不云同步
  var STORAGE_TIMESTAMP_SUFFIX = '__ts'; // 大键写入时间，仅本地诊断
  var tokenCalibration = {};
  var pendingIdbWrites = 0;
  var CLOUD_SCHEMA_VERSION = 3;
  var IDB_DATABASE = 'mychat_idb_store';
  var IDB_TABLE = 'kv';
  var IDB_MARKER = '__IDB_BACKED__';
  var storageCache = new Map();
  var idbDatabase = null;
  var idbOpening = null;

  // 正在用云端数据覆盖本地：期间禁止刷新时间戳 / 触发自动上传
  var applyingCloudData = false;

  // 初始化尚未完成：期间不因渠道 / 模型兜底写入而刷新时间戳
  var isBooting = true;
  var isStartupSyncSettled = false; // 首次云端对表结束前冻结时间戳与自动上传

  // 快捷选择器 option 值的分隔符（渠道 id 与模型 id 之间）
  var MODEL_SEP = '||';

  var DEFAULT_TITLE = '新对话';
  var SAVE_THROTTLE_MS = 300; // 流式输出时合并写入，避免每个字都读写一次存储

  // ===== 云同步常量 =====
  var SYNC_FILE_NAME = 'mychat_latest.json';     // Gist 中的核心同步文件
  var SYNC_GIST_DESC = 'MyChat_Cloud_Sync_Data'; // 用于自动查找已存在的同步 Gist
  var BACKUP_PREFIX = 'backup_';                 // 每日快照前缀 backup_YYYY-MM-DD.json
  var UPLOAD_DELAY_MS = 1000;                    // 静默上传延迟：1 秒

  // 各平台的 Gist API 基础路径
  var SYNC_API_BASE = {
    gitee: 'https://gitee.com/api/v5/gists',
    github: 'https://api.github.com/gists'
  };

  var DEFAULTS = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  };

  // 云同步 + 旧版 API 配置（页面加载时从 localStorage 回填）
  var config = {
    // 旧版单 API 配置：仅用于首次迁移到多渠道结构
    baseUrl: DEFAULTS.baseUrl,
    apiKey: DEFAULTS.apiKey,
    model: DEFAULTS.model,
    // 云同步配置（同样只保存在本机 localStorage）
    syncPlatform: 'gitee',
    syncToken: '',
    gistId: '',
    autoSync: false
  };

  // 多渠道列表：每项 { id, name, baseUrl, apiKey, models: [{ id, alias }] }
  var providers = [];

  // 当前选中的目标 { providerId, modelId }
  var activeTarget = { providerId: '', modelId: '' };

  // 设置弹窗中当前正在编辑的渠道 ID
  var editingProviderId = '';

  // 最近一次自动拉取到的模型 ID 列表（供拉取面板渲染）
  var fetchedModels = [];

  // 全部会话：每项形如 { id, title, updatedAt, messages }
  var sessions = [];

  // 当前选中的会话 ID
  var currentId = null;

  // 主聊天任务仅驻留内存；准备、网络与收尾全程按会话 + 子对话独立占锁。
  var activeGenerationMap = new Map();

  // 流式输出时的延迟保存计时器
  var saveTimer = null;
  var inputDraftTimer = null; // 输入草稿独立防抖，不干扰流式保存
  var inputDraftDirty = false;

  // 用户是否主动向上滚动查看上文（true 时流式输出不再自动跟随到底部）
  var userScrolledUp = false;

  // 顶部搜索范围：current（当前对话） | all（所有对话）
  var searchScope = 'current';

  // #0 系统提示词层的折叠状态（会话切换时重置为折叠）
  var systemFloorExpanded = false;

  // 系统提示词预设：全局大预设库内存镜像（具体实现见下方 PROMPT_PRESETS 锚点区块）
  // 每项形如 { id, name, modules: [{ id, name, content, enabled }] }
  var promptPresets = [];

  // 顶部 #0 下拉面板当前是否展开
  var topPresetOpen = false;

  // 内部对话（子对话 / 分支）管理弹窗是否展开
  var subchatModalOpen = false;

  // 左侧会话列表「收藏夹」分组是否折叠
  var pinnedCollapsed = false;

  // 当前正在编辑的小模块引用：{ presetId, moduleId }（moduleId 为 null 表示新建）
  var editingModuleRef = null;

  // 角色与对话设置弹窗当前编辑的会话 ID，以及头像草稿（仅点击保存才写回）
  var charModalSessionId = null;
  var charAvatarDraft = '';
  var userAvatarDraft = '';

  /* ================= DOM 元素引用 ================= */

  var els = {
    // 侧边栏相关
    sidebar: document.getElementById('sidebar'),
    sidebarMask: document.getElementById('sidebar-mask'),
    menuBtn: document.getElementById('btn-menu'),
    newChatBtn: document.getElementById('btn-new-chat'),
    sessionList: document.getElementById('session-list'),

    // 聊天区相关
    chatArea: document.getElementById('chat-area'),
    input: document.getElementById('input'),
    sendBtn: document.getElementById('btn-send'),

    // 底部快捷模型切换器（自定义面板：按钮 + 上弹列表）
    quickModelPicker: document.getElementById('quick-model-picker'),
    quickModelBtn: document.getElementById('quick-model-btn'),
    quickModelLabel: document.getElementById('quick-model-label'),
    quickModelPanel: document.getElementById('quick-model-panel'),

    // 当前对话参数（底部上弹面板，仅对本会话生效）
    quickParams: document.getElementById('quick-params'),
    quickParamsBtn: document.getElementById('quick-params-btn'),
    quickParamsLabel: document.getElementById('quick-params-label'),
    quickParamsDot: document.getElementById('quick-params-dot'),
    quickParamsPanel: document.getElementById('quick-params-panel'),
    qpResetBtn: document.getElementById('qp-reset-btn'),
    qpStream: document.getElementById('qp-stream'),
    qpRealTime: document.getElementById('qp-real-time'),
    qpContextLimit: document.getElementById('qp-context-limit'),
    qpTemperature: document.getElementById('qp-temperature'),
    qpTopP: document.getElementById('qp-top-p'),
    qpMaxTokens: document.getElementById('qp-max-tokens'),

    // 设置弹窗：全局默认对话参数
    cfgStream: document.getElementById('cfg-stream'),
    cfgContextLimit: document.getElementById('cfg-context-limit'),
    cfgTemperature: document.getElementById('cfg-temperature'),
    cfgTopP: document.getElementById('cfg-top-p'),
    cfgMaxTokens: document.getElementById('cfg-max-tokens'),
    resetChatParamsBtn: document.getElementById('btn-reset-chat-params'),

    // 设置弹窗相关
    settingsBtn: document.getElementById('btn-settings'),
    modal: document.getElementById('modal'),
    settingsNav: document.getElementById('settings-nav'),
    cfgBaseUrl: document.getElementById('cfg-baseurl'),
    cfgApiKey: document.getElementById('cfg-apikey'),
    cfgSyncPlatform: document.getElementById('cfg-sync-platform'),
    cfgSyncToken: document.getElementById('cfg-sync-token'),
    cfgGistId: document.getElementById('cfg-gist-id'),
    saveBtn: document.getElementById('btn-save'),
    cancelBtn: document.getElementById('btn-cancel'),

    // 渠道与模型管理
    providerSelect: document.getElementById('cfg-provider-select'),
    providerName: document.getElementById('cfg-provider-name'),
    addProviderBtn: document.getElementById('btn-add-provider'),
    delProviderBtn: document.getElementById('btn-del-provider'),
    testConnBtn: document.getElementById('btn-test-conn'),
    connResult: document.getElementById('conn-result'),
    modelList: document.getElementById('model-list'),
    newModelId: document.getElementById('cfg-new-model-id'),
    addModelBtn: document.getElementById('btn-add-model'),
    fetchModelsBtn: document.getElementById('btn-fetch-models'),
    fetchPanel: document.getElementById('fetch-panel'),
    fetchSearch: document.getElementById('fetch-search'),
    fetchList: document.getElementById('fetch-list'),
    fetchCloseBtn: document.getElementById('btn-fetch-close'),

    // 顶部快捷切换按钮
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    chatSearchToggle: document.getElementById('chat-search-toggle'),
    chatSearchClose: document.getElementById('chat-search-close'),

    // 顶部右上角对话搜索（当前对话 / 所有对话，含 #0 系统提示词层）
    headerSearchWrap: document.getElementById('header-search-wrap'),
    chatSearchInput: document.getElementById('chat-search-input'),
    chatSearchClear: document.getElementById('chat-search-clear'),
    chatSearchScope: document.getElementById('chat-search-scope'),
    chatSearchDropdown: document.getElementById('chat-search-dropdown'),

    // 顶部云同步状态按钮（图标固定，仅文字部分动态更新）
    syncStatusBtn: document.getElementById('sync-status-btn'),
    syncStatusText: document.getElementById('sync-status-text'),

    // 密码框显隐按钮（API Key / 云同步 Token）
    passwordToggles: document.querySelectorAll('.btn-toggle-pwd'),

    // 顶部 #0 一站式预设控制台（常驻入口 + 下拉面板）
    topPresetWrap: document.getElementById('top-preset-wrap'),
    topPresetTrigger: document.getElementById('top-preset-trigger'),
    topPresetLabel: document.getElementById('top-preset-label'),
    topPresetDropdown: document.getElementById('top-preset-dropdown'),
    topPresetSelect: document.getElementById('top-preset-select'),
    tpNewBtn: document.getElementById('tp-new-btn'),
    tpRenameBtn: document.getElementById('tp-rename-btn'),
    tpDeleteBtn: document.getElementById('tp-delete-btn'),
    tpModuleList: document.getElementById('top-preset-modules-list'),
    tpAddModuleBtn: document.getElementById('tp-add-module-btn'),
    tpPreviewBtn: document.getElementById('tp-preview-btn'),

    // #0 预设合并效果预览弹窗
    presetMergedModal: document.getElementById('preset-merged-preview-modal'),
    presetMergedTitle: document.getElementById('preset-merged-title'),
    presetMergedMeta: document.getElementById('preset-merged-meta'),
    presetMergedContent: document.getElementById('preset-merged-content'),
    presetMergedFoot: document.getElementById('preset-merged-foot'),
    presetMergedClose: document.getElementById('preset-merged-close'),
    presetMergedCopy: document.getElementById('preset-merged-copy'),
    presetMergedDone: document.getElementById('preset-merged-done'),

    // 输入区左侧自适应工具箱 + 内部对话管理弹窗
    inputToolboxBtn: document.getElementById('input-toolbox-btn'),
    inputToolboxPanel: document.getElementById('input-toolbox-panel'),
    subchatModal: document.getElementById('subchat-manager-modal'),
    subchatList: document.getElementById('subchat-list'),
    subchatNewBtn: document.getElementById('subchat-new-btn'),
    subchatClose: document.getElementById('subchat-close'),

    // 系统提示词预设：原独立弹窗与小模块编辑窗口（保留以供复用）
    presetBtn: document.getElementById('preset-btn'),
    presetModal: document.getElementById('preset-modal'),
    presetCloseBtn: document.getElementById('preset-close-btn'),
    presetSelect: document.getElementById('preset-select'),
    presetNewBtn: document.getElementById('preset-new-btn'),
    presetRenameBtn: document.getElementById('preset-rename-btn'),
    presetDeleteBtn: document.getElementById('preset-delete-btn'),
    presetAddModuleBtn: document.getElementById('preset-add-module-btn'),
    presetModuleList: document.getElementById('preset-module-list'),
    moduleEditModal: document.getElementById('module-edit-modal'),
    moduleEditClose: document.getElementById('module-edit-close'),
    moduleNameInput: document.getElementById('module-name-input'),
    moduleRoleSelect: document.getElementById('module-role-select'),
    modulePrefillOption: document.getElementById('module-prefill-option'),
    moduleKeepPrefillInput: document.getElementById('module-keep-prefill-input'),
    moduleContentInput: document.getElementById('module-content-input'),
    moduleSaveBtn: document.getElementById('module-save-btn'),
    moduleCancelBtn: document.getElementById('module-cancel-btn'),
    moduleDeleteBtn: document.getElementById('module-delete-btn'),

    // 左侧会话：导入角色卡按钮 + 世界书触发明细弹窗 + 角色与对话设置弹窗
    btnImportCharcard: document.getElementById('btn-import-charcard'),
    wbDetailModal: document.getElementById('wb-triggered-detail-modal'),
    wbDetailTitle: document.getElementById('wb-detail-title'),
    wbDetailSub: document.getElementById('wb-detail-sub'),
    wbDetailList: document.getElementById('wb-detail-list'),
    wbDetailFoot: document.getElementById('wb-detail-foot'),
    wbDetailClose: document.getElementById('wb-detail-close'),
    wbDetailDone: document.getElementById('wb-detail-done'),
    sessionCharModal: document.getElementById('session-char-modal'),
    sessionCharClose: document.getElementById('session-char-close'),
    sessionCharCancel: document.getElementById('session-char-cancel'),
    sessionCharSave: document.getElementById('session-char-save'),
    scCharAvatarPreview: document.getElementById('sc-char-avatar-preview'),
    scUserAvatarPreview: document.getElementById('sc-user-avatar-preview'),
    scCharAvatarFile: document.getElementById('sc-char-avatar-file'),
    scUserAvatarFile: document.getElementById('sc-user-avatar-file'),
    scCharAvatarClear: document.getElementById('sc-char-avatar-clear'),
    scUserAvatarClear: document.getElementById('sc-user-avatar-clear'),
    scCharAvatarUrl: document.getElementById('sc-char-avatar-url'),
    scUserAvatarUrl: document.getElementById('sc-user-avatar-url'),
    scCharNameInput: document.getElementById('sc-char-name-input'),
    scUserNameInput: document.getElementById('sc-user-name-input'),
    scTitleInput: document.getElementById('sc-title-input'),
    scFirstMessageInput: document.getElementById('sc-first-message-input'),
    scApplyFirstMessage: document.getElementById('sc-apply-first-message')
  };

  /* ================= 通用工具函数 ================= */

  /**
   * 安全地解析 JSON 字符串，失败时返回 null（避免抛异常打断流程）
   */
  function safeJsonParse(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      return null;
    }
  }

  /**
   * 读取 localStorage 中的值：优先按 JSON 解析，解析失败则原样返回字符串
   * 键不存在或为空时返回 null（供云端打包判断「本地是否存在」）
   */
  // IndexedDB 保存完整原串；大键在排队前同步安装索引并释放本地配额。
  function openLargeStorage() {
    if (idbOpening) return idbOpening;
    idbOpening = new Promise(function (resolve) {
      try {
        var request = window.indexedDB.open(IDB_DATABASE, 1);
        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains(IDB_TABLE)) request.result.createObjectStore(IDB_TABLE);
        };
        request.onsuccess = function () {
          idbDatabase = request.result;
          idbDatabase.onversionchange = function () { idbDatabase.close(); idbDatabase = null; };
          resolve(idbDatabase);
        };
        request.onerror = request.onblocked = function () { resolve(null); };
      } catch (error) { resolve(null); }
    });
    return idbOpening;
  }

  function queueLargeStorageWrite(key, raw) {
    if (!idbDatabase) return false;
    var tx, settled = false;
    function finish(failed) {
      if (settled) return;
      settled = true;
      pendingIdbWrites--;
      if (failed) {
        console.error('大容量存储写入失败：', tx.error);
        showToast('大容量保存失败，请立即导出备份');
      }
    }
    try {
      tx = idbDatabase.transaction(IDB_TABLE, 'readwrite');
      pendingIdbWrites++;
      tx.oncomplete = function () { finish(false); };
      tx.onabort = tx.onerror = function () { finish(true); };
      tx.objectStore(IDB_TABLE).put(raw, key);
      return true;
    } catch (error) {
      if (tx) { try { tx.abort(); } catch (ignore) {} finish(true); }
      return false;
    }
  }

  function pickNewerSessionsRaw(idbRaw, lsRaw) {
    function measure(raw) {
      var list = safeJsonParse(raw);
      if (!Array.isArray(list)) return null;
      var count = 0, updatedAt = 0;
      list.forEach(function (session) {
        if (!session) return;
        var subs = Array.isArray(session.subChats) ? session.subChats : [];
        // 顶层消息可为活跃分支镜像；双源统一按全部实际分支计数。
        (subs.length ? subs : [session]).forEach(function (owner) {
          if (!owner) return;
          count += Array.isArray(owner.messages) ? owner.messages.length : 0;
          updatedAt = Math.max(updatedAt, Number(owner.updatedAt) || Date.parse(owner.updatedAt) || 0);
        });
        updatedAt = Math.max(updatedAt, Number(session.updatedAt) || Date.parse(session.updatedAt) || 0);
      });
      return { count: count, updatedAt: updatedAt };
    }
    var idb = measure(idbRaw), ls = measure(lsRaw);
    if (!idb) return lsRaw;
    if (!ls) return idbRaw;
    return ls.count > idb.count || (ls.count === idb.count && ls.updatedAt > idb.updatedAt) ? lsRaw : idbRaw;
  }

  async function preloadLargeStorage() {
    var db = await openLargeStorage();
    var keys = [SESSIONS_KEY, CONFIG_KEY, PROVIDERS_KEY, ACTIVE_TARGET_KEY, CURRENT_ID_KEY,
      LAST_MODIFIED_KEY, THEME_KEY, VIEW_KEY, CHAT_PARAMS_KEY, PROMPT_PRESETS_KEY, REGEX_RULES_KEY,
      WORLDBOOKS_KEY, VOCAB_RULES_KEY, QUICK_REPLIES_KEY, GLOBAL_TAVERN_VARS_KEY, AUTO_RETRY_KEY, CLOUD_MIRROR_KEY];
    await Promise.all(keys.map(async function (key) {
      var local, disk = null;
      try { local = localStorage.getItem(key); } catch (error) { local = null; }
      if (db) {
        try {
          disk = await new Promise(function (resolve, reject) {
            var tx = db.transaction(IDB_TABLE, 'readonly');
            var request = tx.objectStore(IDB_TABLE).get(key);
            request.onsuccess = function () { resolve(typeof request.result === 'string' ? request.result : null); };
            request.onerror = function () { reject(request.error); };
            tx.onabort = function () { reject(tx.error); };
          });
        } catch (error) {
          if (local === IDB_MARKER) throw new Error('大容量历史数据读取失败，已停止加载');
        }
      }
      if (local === IDB_MARKER && disk === null) throw new Error('大容量历史数据不可用，已停止加载以保护历史数据');
      var raw = local === IDB_MARKER ? disk : local;
      if (key === SESSIONS_KEY && disk !== null) raw = local && local !== IDB_MARKER ? pickNewerSessionsRaw(disk, local) : disk;
      if (raw !== null) storageCache.set(key, raw);
    }));
  }

  function readStorageRaw(key) {
    // 会话在启动选优后始终以缓存为准，其他小键仍读取模块的同步写入。
    if (key === SESSIONS_KEY && storageCache.has(key)) return storageCache.get(key);
    var raw = localStorage.getItem(key);
    return raw === IDB_MARKER ? (storageCache.get(key) || null) :
      (raw === null && key === CLOUD_MIRROR_KEY ? (storageCache.get(key) || null) : raw);
  }

  function readStorageValue(key) {
    var raw = null;
    try {
      raw = readStorageRaw(key);
    } catch (err) {
      return null;
    }
    if (raw === null || raw === '') return null;
    var parsed = safeJsonParse(raw);
    return parsed === null ? raw : parsed;
  }

  /**
   * 把任意数据写回 localStorage：对象 / 数组按 JSON 序列化，字符串原样写入
   * null / undefined 跳过；空字符串正常写入；返回明确的成功状态
   */
  function writeStorageValue(key, value) {
    if (value === null || value === undefined) return true;
    var raw = typeof value === 'string' ? value : JSON.stringify(value);
    var useIdb = idbDatabase && (key === SESSIONS_KEY || raw.length > 512 * 1024);
    if (useIdb) storageCache.set(key, raw);
    try {
      localStorage.setItem(key, useIdb ? IDB_MARKER : raw);
      if (useIdb) localStorage.setItem(key + STORAGE_TIMESTAMP_SUFFIX, String(Date.now()));
    } catch (err) {
      if (err.name !== 'QuotaExceededError' && err.code !== 22) {
        showToast('本地保存失败，请立即导出数据备份');
        return false;
      }
      try {
        var mirror = readStorageRaw(CLOUD_MIRROR_KEY);
        if (mirror !== null) storageCache.set(CLOUD_MIRROR_KEY, mirror);
        localStorage.removeItem(CLOUD_MIRROR_KEY);
        localStorage.setItem(key, useIdb ? IDB_MARKER : raw);
        if (useIdb) localStorage.setItem(key + STORAGE_TIMESTAMP_SUFFIX, String(Date.now()));
      } catch (retryError) {
        showToast('本地存储空间已满，请立即点击导出数据备份！');
        return false;
      }
    }
    storageCache.set(key, raw);
    if (useIdb && !queueLargeStorageWrite(key, raw)) {
      showToast('大容量保存失败，请立即导出备份');
      return false;
    }
    if (!useIdb) queueLargeStorageWrite(key, raw);
    return true;
  }

  // === [ANCHOR: PLUGIN_PIPELINE] 模块桥接与正则管道 ===
  /* ================= 模块桥接与正则管道（供 modules/*.js 扩展） ================= */
  /*
     设计目标：核心宿主引擎（app.js）保持稳定，后续正则引擎 / 预输入 Prefill /
     宏替换 / 世界书等独立扩展，统一放在 modules/*.js，通过 window.MyChat 注册，
     绝不直接修改本文件的核心链路。

     三个标准阀门（阶段）：
       beforeSend —— 组装好发往 API 的 messages 数组之后、正式发送请求之前
       onReceive  —— 流式 / 非流式回复结束、写入会话历史之前
       onRender   —— 把消息正文交给 Markdown 渲染之前（仅影响显示）
  */

  var REGEX_STAGES = ['beforeSend', 'onReceive', 'onRender'];

  // 钩子队列：外部模块通过 MyChat.registerHook(stage, fn) 注册处理器
  // beforeSendContext —— 上下文级阀门：payload 为 { apiMessages, session }，
  // 允许模块整体改写发往 API 的临时消息数组（世界书 #0 / @Depth 注入即走这里），
  // 并返回 { apiMessages, triggeredEntryNames } 供核心记录本轮命中词条。
  var pipelineHooks = { beforeSend: [], onReceive: [], onRender: [], beforeSendContext: [], replyPolicy: [] };

  /**
   * 按顺序执行某个阶段的全部处理器
   * 处理器签名：function (payload, context) => 新 payload | undefined
   * 返回 undefined 表示「不修改」；单个处理器异常只告警，绝不阻塞主流程
   */
  function runPipeline(stage, payload, context) {
    var list = pipelineHooks[stage];
    if (!list || list.length === 0) return payload;

    var value = payload;
    for (var i = 0; i < list.length; i++) {
      var fn = list[i];
      if (typeof fn !== 'function') continue;
      try {
        var next = fn(value, context || {});
        if (next !== undefined) value = next;
      } catch (err) {
        console.warn('[管道] ' + stage + ' 阶段处理器执行异常，已跳过：', err);
      }
    }
    return value;
  }

  /**
   * 注册管道钩子；stage 非法或 fn 不是函数时返回 false
   */
  function registerHook(stage, fn) {
    if (!Object.prototype.hasOwnProperty.call(pipelineHooks, stage)) {
      console.warn(
        '[管道] 未知阶段：' + stage + '（可选 beforeSend / onReceive / onRender / beforeSendContext）'
      );
      return false;
    }
    if (typeof fn !== 'function') {
      console.warn('[管道] 钩子必须是函数');
      return false;
    }
    pipelineHooks[stage].push(fn);
    return true;
  }

  /**
   * 规范化单条规则的作用阶段：
   * 新版优先读 stages 数组（可同时作用于多个阶段），
   * 旧版单 stage 字段自动包裹为只含一个阶段的数组，保证向下兼容。
   * @return {string[]} 去重后的合法阶段数组（至少含一个阶段）
   */
  function normalizeRuleStages(item) {
    var out = [];
    var push = function (stage) {
      if (REGEX_STAGES.indexOf(stage) !== -1 && out.indexOf(stage) === -1) out.push(stage);
    };
    if (Array.isArray(item.stages)) {
      item.stages.forEach(push);
    } else if (typeof item.stages === 'string') {
      push(item.stages);
    }
    // 旧数据 / 单阶段写法
    if (out.length === 0 && typeof item.stage === 'string') push(item.stage);
    if (out.length === 0) out.push('onRender');
    return out;
  }

  /**
   * 规范化正则规则数组：字段一律补全，非法阶段回落到 onRender
   * 单条结构 { id, name, pattern, flags, replacement, stages, targets, enabled }
   * stages 为阶段数组（beforeSend / onReceive / onRender 可多选），
   * 同时保留 stage 字段（取 stages[0]）兼容仍只读单阶段的旧代码。
   */
  function normalizeRegexRules(raw) {
    if (!Array.isArray(raw)) return [];
    var list = [];
    raw.forEach(function (item, idx) {
      if (!item || typeof item !== 'object') return;
      var stages = normalizeRuleStages(item);
      var targets = Array.isArray(item.targets)
        ? item.targets.filter(function (t) {
            return t === 'user' || t === 'assistant' || t === 'system';
          })
        : ['assistant'];
      list.push({
        id: typeof item.id === 'string' && item.id
          ? item.id
          : 'rule_' + Date.now() + '_' + idx,
        name: typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : '规则 ' + (idx + 1),
        pattern: typeof item.pattern === 'string' ? item.pattern : '',
        flags: typeof item.flags === 'string' ? item.flags : '',
        replacement: typeof item.replacement === 'string' ? item.replacement : '',
        stages: stages,
        // 兼容旧字段：单阶段读写（管理器 UI 用 stages，持久化两者并存）
        stage: stages[0],
        targets: targets.length > 0 ? targets : ['assistant'],
        enabled: item.enabled !== false
      });
    });
    return list;
  }

  /**
   * 只读浅拷贝：用于对外暴露状态摘要，避免外部模块反向污染核心数据
   */
  function safeClone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (err) {
      return Array.isArray(value) ? [] : null;
    }
  }

  /**
   * 读取正则规则库（不存在时返回空数组）
   */
  function getRegexRules() {
    return normalizeRegexRules(readStorageValue(REGEX_RULES_KEY));
  }

  /**
   * 保存正则规则库：写库 + 刷新全局时间戳 + 触发云端静默上传
   */
  function saveRegexRules(rules) {
    var list = normalizeRegexRules(rules);
    writeStorageValue(REGEX_RULES_KEY, list);
    touchLastModified();
    if (!isBooting && !applyingCloudData) scheduleCloudUpload();
    return list;
  }

  /**
   * 读取全局世界书库（mychat_worldbooks）：结构规范化由 modules/worldbook.js 负责，
   * 核心只做「读原始数组 / 写原始数组」，避免宿主耦合业务细节
   */
  function getWorldbooks() {
    var data = readStorageValue(WORLDBOOKS_KEY);
    return Array.isArray(data) ? data : [];
  }

  /**
   * 保存全局世界书库：写库 + 刷新全局时间戳 + 触发云端静默上传
   */
  function saveWorldbooks(list) {
    var data = Array.isArray(list) ? list : [];
    writeStorageValue(WORLDBOOKS_KEY, data);
    refreshMemoryContext();
    touchLastModified();
    if (!isBooting && !applyingCloudData) scheduleCloudUpload();
    return data;
  }

  /**
   * 把当前会话启用的世界书 ID 列表写回会话对象并落盘
   * 会话级共享：本窗口内全部 subChats 共用同一份 worldbookIds
   */
  function setCurrentSessionWorldbookIds(ids) {
    var session = getCurrentSession();
    if (!session) return [];
    var list = [];
    if (Array.isArray(ids)) {
      ids.forEach(function (id) {
        if (typeof id === 'string' && id && list.indexOf(id) === -1) list.push(id);
      });
    }
    session.worldbookIds = list;
    session.updatedAt = Date.now();
    persistSessions();
    refreshMemoryContext();
    touchLastModified();
    if (!isBooting && !applyingCloudData) scheduleCloudUpload();
    return list;
  }

  /**
   * 按「点号 / 斜杠」路径读取对象深层属性
   * 例如 '系统/日期'、'stat_data.系统.日期'、列表索引 '0'
   */
  function readMvuPath(root, pathText) {
    var path = String(pathText == null ? '' : pathText).trim();
    if (!path) return root;
    var parts = path.split(/[.\/]/);
    var cursor = root;
    for (var i = 0; i < parts.length; i++) {
      var key = parts[i];
      if (key === '') continue;
      if (cursor === null || cursor === undefined) return undefined;
      if (Array.isArray(cursor) && /^\d+$/.test(key)) {
        cursor = cursor[Number(key)];
      } else if (typeof cursor === 'object') {
        cursor = cursor[key];
      } else {
        return undefined;
      }
    }
    return cursor;
  }

  /**
   * 把 MVU 变量值序列化为「人类可读」的 YAML 风格文本
   * 标量直接输出，数组 / 对象按两空格缩进递归展开
   */
  function formatMvuValue(value, depth) {
    var level = typeof depth === 'number' ? depth : 0;
    var pad = new Array(level + 1).join('  ');

    if (value === null || value === undefined) return '';
    if (typeof value !== 'object') return String(value);

    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      return value
        .map(function (item) {
          if (item && typeof item === 'object') {
            return pad + '- ' + formatMvuValue(item, level + 1).replace(/^\s+/, '');
          }
          return pad + '- ' + String(item);
        })
        .join('\n');
    }

    var keys = Object.keys(value);
    if (!keys.length) return '{}';
    return keys
      .map(function (key) {
        var item = value[key];
        if (item && typeof item === 'object') {
          return pad + key + ':\n' + formatMvuValue(item, level + 1);
        }
        return pad + key + ': ' + (item === null || item === undefined ? '' : String(item));
      })
      .join('\n');
  }

  /**
   * MVU 变量宏替换（酒馆 MagVarUpdate 兼容）
   * 支持 {{get_message_variable::stat_data}} 与 {{format_message_variable::stat_data.系统}}
   * 变量来源：modules/regex-engine.js 挂载的 MyChat.computeSessionMvuState(session)
   * 解析器缺失或取值失败时安全清空，绝不把原始宏写进气泡。
   */
  function replaceMvuMacros(text, session) {
    if (typeof text !== 'string' || !text) return text;
    if (!/\{\{\s*(?:format|get)_message_variable\s*::/i.test(text)) return text;

    var state = null;
    try {
      var api = window.MyChat;
      if (api && typeof api.computeSessionMvuState === 'function') {
        state = api.computeSessionMvuState(session || getCurrentSession());
      }
    } catch (err) {
      console.warn('[MyChat] MVU 变量状态计算失败：', err);
    }

    if (!state || typeof state !== 'object') {
      return text.replace(/\{\{\s*(?:format|get)_message_variable\s*::[^}]*\}\}/gi, '');
    }

    return text.replace(
      /\{\{\s*(format|get)_message_variable\s*::\s*([^}]*?)\s*\}\}/gi,
      function (whole, kind, pathText) {
        var value = readMvuPath(state, pathText);
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') return formatMvuValue(value, 0);
        return String(value);
      }
    );
  }

  var WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  /**
   * 取当前现实时间的结构化快照（本地时区）
   * @return {{date:string, time:string, weekday:string, datetime:string, offset:string, ymdhm:string}}
   */
  function getRealTimeSnapshot() {
    var d = new Date();
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    var y = d.getFullYear();
    var mo = pad(d.getMonth() + 1);
    var da = pad(d.getDate());
    var hh = pad(d.getHours());
    var mi = pad(d.getMinutes());
    // 时区偏移：getTimezoneOffset 返回「本地落后 UTC 的分钟数」，需取反
    var offMin = -d.getTimezoneOffset();
    var sign = offMin >= 0 ? '+' : '-';
    var absOff = Math.abs(offMin);
    var offset = 'UTC' + sign + pad(Math.floor(absOff / 60)) + ':' + pad(absOff % 60);
    var dateStr = y + '-' + mo + '-' + da;
    var timeStr = hh + ':' + mi;
    return {
      date: dateStr,
      time: timeStr,
      weekday: WEEKDAY_CN[d.getDay()],
      datetime: dateStr + ' ' + timeStr,
      offset: offset,
      ymdhm: dateStr + ' ' + timeStr
    };
  }

  /**
   * 构建静默现实时间背景板（<env_context>）
   * 仅在本次请求的临时快照中附带，绝不污染用户可见的 #0 预设输入框
   */
  function buildRealTimeEnvContext() {
    var t = getRealTimeSnapshot();
    return [
      '<env_context>',
      '[Current Real-World Local Time: ' + t.ymdhm + ' (' + t.weekday + ', ' + t.offset + ')]',
      'Directive: This is passive background metadata ONLY.',
      '1. Reference it ONLY when the user explicitly asks about real-world date/time/schedule or when real-world temporal context is directly required.',
      '2. If this conversation involves Role-Play, fiction, or a character card with its own in-story timeline/status bar (e.g., MVU stat_data), strictly obey the in-story timeline and NEVER let real-world time leak into the narrative.',
      '3. Do NOT proactively mention the time or remind the user to rest unless asked.',
      '</env_context>'
    ].join('\n');
  }

  /**
   * 全局宏变量替换（纯文本级，绝不解析 HTML）
   * 支持酒馆常用写法：{{char}} / <BOT> → 角色名，{{user}} / <USER> → 用户名
   * 大小写不敏感；session 为空或字段为空时回落到「AI」「用户」。
   * 另支持 MVU 变量宏：{{get_message_variable::路径}} / {{format_message_variable::路径}}
   * 以及现实时间宏：{{time}} / {{date}} / {{weekday}} / {{datetime}}
   *
   * @param {string} text 待替换文本（非字符串原样返回空串）
   * @param {object} [session] 会话对象，读取 charName / userName
   * @return {string}
   */
  function replaceMacros(text, session) {
    if (typeof text !== 'string' || !text) return '';
    var s = session && typeof session === 'object' ? session : null;
    if (window.MyChatTavernMacros) text = window.MyChatTavernMacros.expand(text, s);
    var charName = (s && typeof s.charName === 'string' && s.charName.trim()) || 'AI';
    var userName = (s && typeof s.userName === 'string' && s.userName.trim()) || '用户';

    // 先替换 {{char}} / {{user}}，再替换 <BOT> / <USER> 标签写法
    var out = text
      .replace(/\{\{\s*char\s*\}\}/gi, charName)
      .replace(/\{\{\s*user\s*\}\}/gi, userName)
      .replace(/<\s*BOT\s*>/gi, charName)
      .replace(/<\s*USER\s*>/gi, userName);

    // 现实时间宏：同一次替换内共用一份时间快照，避免跨越零点产生不一致
    if (/\{\{\s*(time|date|weekday|datetime)\s*\}\}/i.test(out)) {
      var snap = getRealTimeSnapshot();
      out = out
        .replace(/\{\{\s*datetime\s*\}\}/gi, snap.datetime)
        .replace(/\{\{\s*weekday\s*\}\}/gi, snap.weekday)
        .replace(/\{\{\s*date\s*\}\}/gi, snap.date)
        .replace(/\{\{\s*time\s*\}\}/gi, snap.time);
    }

    // 最后处理 MVU 变量宏（依赖正则引擎模块注册的计算器）
    return replaceMvuMacros(out, s);
  }

  /**
   * 全局桥接对象：modules/*.js 只允许通过它与核心通信
   */
  var MyChatBridge = {
    version: '1.2.0',
    registerHook: registerHook,
    runPipeline: runPipeline,
    // 宏变量替换（{{char}} / {{user}} / <BOT> / <USER>）
    replaceMacros: replaceMacros,
    getGlobalTavernVars: function () {
      var vars = readStorageValue(GLOBAL_TAVERN_VARS_KEY);
      return vars && typeof vars === 'object' && !Array.isArray(vars) ? vars : {};
    },
    saveGlobalTavernVars: function (vars) {
      localStorage.setItem(GLOBAL_TAVERN_VARS_KEY, JSON.stringify(vars));
      touchLastModified();
      if (!isBooting && !applyingCloudData) scheduleCloudUpload();
    },
    getRegexRules: getRegexRules,
    saveRegexRules: saveRegexRules,
    // 独立轻量工具的数据读写：键名只由宿主统一管理
    getVocabRules: function () { return readStorageValue(VOCAB_RULES_KEY) || []; },
    saveVocabRules: function (list) {
      localStorage.setItem(VOCAB_RULES_KEY, JSON.stringify(list));
      touchLastModified();
      if (!isBooting && !applyingCloudData) scheduleCloudUpload();
    },
    getQuickReplies: function () { return readStorageValue(QUICK_REPLIES_KEY); },
    saveQuickReplies: function (data, options) {
      localStorage.setItem(QUICK_REPLIES_KEY, JSON.stringify(data));
      if (options && options.silent === true) return;
      touchLastModified();
      if (!isBooting && !applyingCloudData) scheduleCloudUpload();
    },
    getAutoRetrySettings: function () { return readStorageValue(AUTO_RETRY_KEY); },
    saveAutoRetrySettings: function (data) {
      localStorage.setItem(AUTO_RETRY_KEY, JSON.stringify(data));
      touchLastModified();
      if (!isBooting && !applyingCloudData) scheduleCloudUpload();
    },
    stopAllGenerations: function () {
      activeGenerationMap.forEach(function (task) {
        if (task.controller) task.controller.abort();
      });
    },
    showToast: showToast,
    closeComposerPanels: function () {
      closeQuickModelPanel();
      closeQuickParamsPanel();
      closeInputToolbox();
    },
    // 世界书库读写（供 modules/worldbook.js 使用）
    getWorldbooks: getWorldbooks,
    saveWorldbooks: saveWorldbooks,
    // 当前会话启用的世界书 ID（会话级，所有子对话共享）
    getSessionWorldbookIds: function () {
      var session = getCurrentSession();
      return session && Array.isArray(session.worldbookIds) ? session.worldbookIds.slice() : [];
    },
    setSessionWorldbookIds: setCurrentSessionWorldbookIds,

    /* ---------- 三层正则：会话层 / 预设层读写（模块 UI 使用） ---------- */

    // 会话层正则（当前会话专属）
    getSessionRegexRules: function () {
      var session = getCurrentSession();
      return session && Array.isArray(session.regexRules)
        ? safeClone(session.regexRules)
        : [];
    },
    saveSessionRegexRules: function (rules) {
      var session = getCurrentSession();
      if (!session) return [];
      session.regexRules = normalizeRegexRules(rules);
      session.updatedAt = Date.now();
      persistSessions();
      touchLastModified();
      if (!isBooting && !applyingCloudData) scheduleCloudUpload();
      return session.regexRules;
    },

    // 预设层正则（绑定在当前会话上的大预设专属）
    getPresetRegexRules: function () {
      var preset = getCurrentSessionPreset();
      return preset && Array.isArray(preset.regexRules) ? safeClone(preset.regexRules) : [];
    },
    savePresetRegexRules: function (rules) {
      var preset = getCurrentSessionPreset();
      if (!preset) return [];
      preset.regexRules = normalizeRegexRules(rules);
      persistPromptPresets();
      return preset.regexRules;
    },

    /* ---------- 预设库 / 会话操作（酒馆导入器等模块使用） ---------- */

    getPromptPresets: function () {
      return safeClone(promptPresets);
    },
    // 直接提交整个预设库（导入酒馆预设后整表写回）
    savePromptPresets: function (list) {
      promptPresets = normalizePromptPresets(list);
      return persistPromptPresets();
    },
    setCurrentPreset: function (presetId) {
      var session = getCurrentSession();
      if (!session) return false;
      session.presetId = presetId && getPresetById(presetId) ? presetId : null;
      session.updatedAt = Date.now();
      persistSessions();
      touchLastModified();
      try {
        refreshTopPresetUI();
        refreshPresetButtonState();
        renderTopPresetSelect();
        renderTopPresetModules();
      } catch (err) {
        console.warn('[MyChat] 预设界面刷新失败：', err);
      }
      return true;
    },

    // 外部对话只新增：先构建全部新对象，再落盘；失败回滚，不接收外部配置或 ID。
    appendExternalChats: function (drafts) {
      if (activeGenerationMap.size > 0) throw new Error('生成中不可导入');
      if (!Array.isArray(drafts) || !drafts.length) throw new Error('未找到对话');
      var used = new Set();
      sessions.forEach(function (s) {
        used.add(s.id);
        (s.subChats || []).forEach(function (sub) { used.add(sub.id); });
      });
      promptPresets.forEach(function (p) {
        used.add(p.id);
        (p.modules || []).forEach(function (m) { used.add(m.id); });
      });
      function fresh(kind) {
        var id;
        do { id = kind === 'sub' ? genSubChatId() : kind + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12); }
        while (used.has(id));
        used.add(id);
        return id;
      }
      function messages(list) {
        if (!Array.isArray(list)) throw new Error('消息格式错误');
        return normalizeMessageArray(list.map(function (m) {
          if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new Error('消息格式错误');
          var out = { role: m.role, content: m.content };
          if (typeof m.reasoning === 'string') out.reasoning = m.reasoning;
          if (Number.isFinite(m.timestamp)) out.timestamp = m.timestamp;
          if (Array.isArray(m.swipes)) {
            out.swipes = m.swipes.map(function (b) {
              if (!b || typeof b.content !== 'string') throw new Error('分支格式错误');
              return { content: b.content, reasoning: typeof b.reasoning === 'string' ? b.reasoning : '', timestamp: Number.isFinite(b.timestamp) ? b.timestamp : undefined };
            });
            out.swipeIndex = m.swipeIndex;
          }
          return out;
        }));
      }
      var addedPresets = [];
      var added = drafts.map(function (d) {
        if (!d || typeof d.title !== 'string' || !Array.isArray(d.subChats) || !d.subChats.length) throw new Error('对话格式错误');
        var title = d.title.trim() || '导入对话';
        var presetId = null;
        if (typeof d.system === 'string' && d.system.trim()) {
          presetId = fresh('preset');
          addedPresets.push({ id: presetId, name: title + ' - 导入预设', regexRules: [], modules: [{ id: fresh('mod'), name: '系统提示', content: d.system, enabled: true, roleType: 'system', keepPrefillInReply: false }] });
        }
        var subs = d.subChats.map(function (sub) {
          return { id: fresh('sub'), title: typeof sub.title === 'string' ? sub.title : '主对话', updatedAt: Number.isFinite(sub.updatedAt) ? sub.updatedAt : Date.now(), messages: messages(sub.messages) };
        });
        return normalizeSession({ id: fresh('session'), title: title, presetId: presetId,
          updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : Date.now(),
          params: cloneChatParams(globalChatParams), subChats: subs, activeSubChatId: subs[0].id, messages: subs[0].messages });
      });
      var nextSessions = sessions.concat(added);
      var nextPresets = promptPresets.concat(addedPresets);
      // 复用恢复快照与大容量存储通道，失败时补偿内存和存储。
      var snapshot = createStorageSnapshot();
      try {
        sessions = nextSessions;
        promptPresets = nextPresets;
        requireStorageWrite(writeStorageValue(PROMPT_PRESETS_KEY, promptPresets));
        requireStorageWrite(persistSessions());
        requireStorageWrite(writeStorageValue(LAST_MODIFIED_KEY, String(Date.now())));
      } catch (err) {
        restoreStorageSnapshot(snapshot);
        throw new Error('存储写入失败，导入已回滚：' + (err && err.message ? err.message : err));
      }
      try {
        renderSessionList();
        renderPresetSelect();
        renderTopPresetSelect();
        refreshPresetButtonState();
      } catch (err) { console.warn('[MyChat] 导入列表刷新失败', err); }
      if (!isBooting && !applyingCloudData) scheduleCloudUpload();
      return { sessions: added.length, presets: addedPresets.length, ids: added.map(function (s) { return s.id; }) };
    },

    // 新建会话并返回会话对象（供角色卡导入器使用）
    createSession: function (switchView) {
      return createSession(switchView !== false);
    },
    // 切换当前会话
    selectSession: function (sessionId) {
      try {
        selectSession(sessionId);
        return true;
      } catch (err) {
        console.warn('[MyChat] 切换会话失败：', err);
        return false;
      }
    },
    // 获取指定会话（可直接修改字段后调用 saveSession）
    getSessionById: function (sessionId) {
      return getSession(sessionId);
    },
    // 落盘会话改动并刷新界面
    saveSession: function (session, options) {
      if (!session || getSession(session.id) !== session) return false;
      var background = options && options.background === true;
      var quiet = (options && options.silent === true) || isBooting || applyingCloudData || !isStartupSyncSettled;
      if (!quiet) session.updatedAt = Date.now();
      if (Array.isArray(session.subChats) && session.subChats.length) {
        syncActiveSubMessages(session, !background && !quiet);
      }
      if ((quiet ? persistSessions() : flushSave()) === false) return false;
      if (!quiet) {
        touchLastModified();
        scheduleCloudUpload();
      }
      try {
        renderSessionList();
        // 后台元数据落盘不重绘聊天，避免打断当前流式回复与输入。
        if (!background && isCurrentSession(session, getActiveSubChatId(session))) renderMessages();
      } catch (err) {
        console.warn('[MyChat] 会话界面刷新失败：', err);
      }
      return true;
    },
    // 全局轻提示（模块内统一使用）
    showToast: showToast,

    /* ---------- 供 modules/memory-summary.js 使用的运行时接口 ---------- */

    // 当前会话的「活引用」（模块可改写 memoryMeta 后调用 saveCurrentSession 落盘）
    getCurrentSession: getCurrentSession,
    // 仅扩展显示窗口，不裁剪内存消息或请求上下文。
    ensureMessageRendered: ensureMessageRendered,
    // 仅返回 ID；模块通过既有 getSessionById / saveSession 迁移历史数据。
    getSessionIds: function () { return sessions.map(function (session) { return session.id; }); },
    // 当前会话 ID
    getCurrentSessionId: function () {
      return currentId;
    },
    // 当前会话的有效参数（含 realTime 开关）与全局默认参数
    getSessionParams: function (session) {
      return getSessionParams(session || getCurrentSession());
    },
    getGlobalChatParams: getGlobalChatParams,
    previewMainChatPayload: function () {
      var debug = window.DebugInspector, session = getCurrentSession();
      if (!debug || !session) throw new Error('当前没有会话');
      var draft = MyChatBridge.getDraftText() || '请继续当前对话';
      var preview = MyChatBridge.buildRequestPreview(session, draft);
      var target = resolveActiveTarget(), params = getSessionParams(session);
      var wire = window.MyChatAttachments && target ? window.MyChatAttachments.toWire(preview.apiMessages, session.messages, target) : preview.apiMessages;
      var meta = debug.mainMeta(preview); meta.note = '只读快照；总结与检索未执行';
      var id = debug.start({category:'dry_run', status:'dry_run', title:'[干跑预演] 当前主对话拼装', sessionId:session.id,
        sessionTitle:session.title || '', subChatId:getActiveSubChatId(session), inspectorMeta:meta,
        request:debug.request(target, wire, params.maxTokens, params.temperature)});
      debug.open(id); return id;
    },
    // 完整预览使用副本，不运行总结或检索，不修改持久化数据。
    buildRequestPreview: function (session, draft) {
      var original = session || getCurrentSession();
      if (!original) return {apiMessages:[], history:[], injectedEntries:[], presetModules:[]};
      var snapshot = safeClone(original);
      snapshot.params = getSessionParams(original);
      var sourceCount = snapshot.messages.length;
      if (String(draft || '').trim()) snapshot.messages.push({role:'user', content:String(draft).trim()});
      var subId = snapshot.activeSubChatId || '';
      var owner = snapshot.subChats && snapshot.subChats.find(function (sub) { return sub.id === subId; }) || snapshot;
      owner.messages = snapshot.messages;
      var cursor = owner.memoryData && owner.memoryData.summarizedFloorCursor || 0;
      var macros = window.MyChatTavernMacros;
      function build() {
        var preset = getPresetById(snapshot.presetId);
        var prepared = macros ? macros.preparePreset(preset, snapshot) : preset;
        var triggerIndex = snapshot.messages.length > sourceCount ? sourceCount : null;
        var result = assembleRequestContext(snapshot, snapshot.messages, snapshot.params, triggerIndex, cursor, prepared, [], '', subId);
        result.history = result.history.filter(function (msg) { return msg.floor <= sourceCount; });
        result.cursor = cursor;
        result.presetModules = prepared && prepared.modules ? prepared.modules.filter(function (mod) { return mod.enabled === true && mod.content.trim(); }).map(function (mod) {
          return {name:mod.name, role:mod.roleType === 'prefill' ? 'assistant' : 'system', content:mod.content};
        }) : [];
        return result;
      }
      return macros && macros.withPreview ? macros.withPreview(build) : build();
    },
    // 供记忆检索与看板复用唯一的历史条数裁剪和思维链清理规则。
    buildDialogueContext: function (session) {
      var current = session || getCurrentSession();
      if (!current) return [];
      return buildApiMessages(current.messages, getSessionParams(current).contextLimit, null, current)
        .filter(function (msg) { return msg.role === 'user' || msg.role === 'assistant'; });
    },
    // 保存当前会话（落盘 + 重绘 + 云同步）
    saveCurrentSession: function () {
      var session = getCurrentSession();
      if (!session) return false;
      return MyChatBridge.saveSession(session);
    },
    // 渠道 / 模型列表与当前选中目标（供总结模型选择器使用）
    getProviders: function () {
      return safeClone(providers.filter(isProviderAvailable));
    },
    getActiveTarget: function () {
      return {
        providerId: activeTarget.providerId || '',
        modelId: activeTarget.modelId || ''
      };
    },
    // 解析指定渠道 / 模型的真实对象（含 apiKey / baseUrl），用于模块直发请求
    resolveTarget: function (providerId, modelId) {
      var pid = providerId || activeTarget.providerId;
      var mid = modelId || activeTarget.modelId;
      var provider = getProviderById(pid);
      if (!provider) return null;
      var model = findProviderModel(provider, mid);
      if (!model) return null;
      return { provider: provider, model: model };
    },
    // 聊天补全接口地址（模块发起总结 / 检索请求时复用同一套拼接规则）
    buildChatUrl: buildChatUrl,
    // #0 系统提示词（会话绑定预设拼接结果）
    buildSessionSystemPrompt: function (session) {
      return buildSessionSystemPrompt(session || getCurrentSession());
    },
    // Token 估算（与核心统计口径一致）
    estimateTokens: estimateTokens,
    estimateRawTokens: estimateRawTokens,
    estimateMessageTokens: estimateMessageTokens,
    getTokenCalibrationRatio: getTokenCalibrationRatio,
    // 输入框草稿纯文本（Token 实时估算使用）
    getDraftText: function () {
      var text = els.input ? String(els.input.value || '') : '';
      return window.MyChatAttachments ? window.MyChatAttachments.draftText(text) : text;
    },
    // 现实时间快照（供模块展示 / 宏替换）
    getRealTimeSnapshot: getRealTimeSnapshot,

    // 只读获取当前核心状态摘要
    getState: function () {
      var session = getCurrentSession();
      return {
        currentId: currentId,
        session: session ? safeClone(session) : null,
        sessionsCount: sessions.length,
        activeTarget: {
          providerId: activeTarget.providerId || '',
          modelId: activeTarget.modelId || ''
        },
        chatParams: cloneChatParams(globalChatParams),
        promptPresets: safeClone(promptPresets),
        regexRules: getRegexRules(),
        worldbooks: safeClone(getWorldbooks())
      };
    },
    // 安全重绘当前会话；生成中不替换气泡，避免流式输出失去挂载点。
    refreshChatUI: function () {
      if (activeGenerationMap.size > 0) return false;
      try {
        renderMessages({ refreshRows: true });
        return true;
      } catch (err) {
        console.warn('[MyChat] 消息列表重绘失败：', err);
        return false;
      }
    }
  };

  window.MyChat = MyChatBridge;

  /* ================= 消息统计信息工具 ================= */

  /**
   * 把当前时间格式化为 24 小时制补零字符串，例如 04:35
   */
  function formatClockTime() {
    var d = new Date();
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  /** 文本基础估算与真实输入用量校准；消息格式开销单独计入。 */
  function estimateRawTokens(text) {
    var str = String(text == null ? '' : text);
    var cjkCount = (str.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) || []).length;
    var remaining = str.replace(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g, '');
    var wordTokens = 0;
    remaining = remaining.replace(/[a-zA-Z0-9_]+/g, function (word) {
      wordTokens += word.length <= 4 ? 1 : Math.ceil(word.length / 3.8);
      return '';
    });
    return cjkCount * 0.65 + wordTokens + remaining.length * 0.35;
  }

  function getTokenCalibrationRatio(modelId) {
    var saved = readStorageValue(TOKEN_CALIBRATION_KEY);
    tokenCalibration = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    var ratio = Number(tokenCalibration[modelId || activeTarget.modelId]);
    return isFinite(ratio) && ratio >= 0.45 && ratio <= 2.2 ? ratio : 1;
  }

  function estimateTokens(text, modelId) {
    return Math.round(estimateRawTokens(text) * getTokenCalibrationRatio(modelId));
  }

  function estimateMessageTokens(text, modelId) {
    return Math.round((estimateRawTokens(text) + 4) * getTokenCalibrationRatio(modelId));
  }

  function estimateRawPromptTokens(messages) {
    return messages.reduce(function (total, msg) {
      var content = Array.isArray(msg.content) ? msg.content.map(function (part) {
        return part.type === 'text' ? part.text || '' : '';
      }).join('\n') : msg.content;
      return total + estimateRawTokens(content) + 4;
    }, 0);
  }

  function calibratePromptTokens(modelId, actualPromptTokens, rawEstimatedPromptTokens) {
    if (!(actualPromptTokens > 0 && rawEstimatedPromptTokens > 50)) return;
    var observedRatio = actualPromptTokens / rawEstimatedPromptTokens;
    if (observedRatio < 0.45 || observedRatio > 2.2) return;
    getTokenCalibrationRatio(modelId);
    var oldRatio = Number(tokenCalibration[modelId]);
    var newRatio = isFinite(oldRatio) && oldRatio >= 0.45 && oldRatio <= 2.2 ? oldRatio * 0.3 + observedRatio * 0.7 : observedRatio;
    Object.defineProperty(tokenCalibration, modelId, {value:newRatio, enumerable:true, configurable:true, writable:true});
    writeStorageValue(TOKEN_CALIBRATION_KEY, tokenCalibration);
    refreshMemoryContext();
  }

  /**
   * 从响应体 / 流式 chunk 中提取 Token 用量
   * 兼容 prompt_tokens_details.cached_tokens 与 DeepSeek 官方 prompt_cache_hit_tokens
   * @return {{totalTokens:number, cachedTokens:number, outputTokens:number}|null}
   */
  function extractUsageObject(data) {
    if (!data || typeof data !== 'object') return null;
    var u = data.usage;
    if (!u || typeof u !== 'object') return null;

    var total = Number(u.total_tokens);
    var prompt = Number(u.prompt_tokens !== undefined ? u.prompt_tokens : u.input_tokens);
    var completion = Number(u.completion_tokens);

    var hasTotal = isFinite(total) && total >= 0;
    var hasPrompt = (u.prompt_tokens != null || u.input_tokens != null) && isFinite(prompt) && prompt >= 0;
    var hasCompletion = isFinite(completion) && completion >= 0;

    if (!hasTotal && !hasPrompt && !hasCompletion) return null;

    var cached = 0;
    if (
      u.prompt_tokens_details &&
      typeof u.prompt_tokens_details.cached_tokens === 'number' &&
      isFinite(u.prompt_tokens_details.cached_tokens)
    ) {
      cached = u.prompt_tokens_details.cached_tokens;
    } else if (typeof u.prompt_cache_hit_tokens === 'number') {
      cached = u.prompt_cache_hit_tokens;
    }
    if (!isFinite(cached) || cached < 0) cached = 0;

    return {
      totalTokens: hasTotal
        ? Math.round(total)
        : Math.round((hasPrompt ? prompt : 0) + (hasCompletion ? completion : 0)),
      inputTokens: Math.round(hasPrompt ? prompt : Math.max(0, (hasTotal ? total : 0) - (hasCompletion ? completion : 0))),
      actualPromptTokens: hasPrompt ? prompt : 0,
      cachedTokens: Math.round(cached),
      outputTokens: hasCompletion ? Math.round(completion) : 0
    };
  }

  /**
   * 规范化消息 meta 字段（读取历史数据时丢弃异常内容，避免渲染报错）
   */
  function normalizeMessageMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;

    var meta = Object.assign({}, raw);
    if (typeof raw.timeStr === 'string' && raw.timeStr.trim()) {
      meta.timeStr = raw.timeStr.trim();
    }
    if (typeof raw.modelId === 'string' && raw.modelId.trim()) {
      meta.modelId = raw.modelId.trim();
    }
    if (typeof raw.modelAlias === 'string' && raw.modelAlias.trim()) {
      meta.modelAlias = raw.modelAlias.trim();
    }
    // 已计算好的人民币花费文本（如 ¥0.0245），历史消息恢复时原样保留
    if (typeof raw.costText === 'string' && raw.costText.trim()) {
      meta.costText = raw.costText.trim();
    }

    ['totalTokens', 'inputTokens', 'cachedTokens', 'outputTokens'].forEach(function (key) {
      var num = Number(raw[key]);
      if (isFinite(num) && num >= 0) meta[key] = Math.round(num);
    });

    if (typeof raw.durationSec === 'number' && isFinite(raw.durationSec)) {
      meta.durationSec = raw.durationSec.toFixed(1);
    } else if (typeof raw.durationSec === 'string' && raw.durationSec.trim()) {
      meta.durationSec = raw.durationSec.trim();
    }

    // 本轮命中的世界书词条（历史消息恢复时原样保留，仅展示用）
    // 兼容两种历史结构：旧版纯字符串数组 / 新版明细对象数组
    if (Array.isArray(raw.triggeredWorldbooks)) {
      var wbList = [];
      raw.triggeredWorldbooks.forEach(function (item) {
        if (typeof item === 'string') {
          if (item.trim()) {
            wbList.push({
              bookName: '',
              entryName: item.trim(),
              matchedKey: '',
              position: '',
              depth: 0,
              content: ''
            });
          }
          return;
        }
        if (item && typeof item === 'object') {
          wbList.push({
            bookName: typeof item.bookName === 'string' ? item.bookName : '',
            entryName: typeof item.entryName === 'string' ? item.entryName : '',
            matchedKey: typeof item.matchedKey === 'string' ? item.matchedKey : '',
            position: typeof item.position === 'string' ? item.position : '',
            depth: Number(item.depth) >= 0 ? Math.round(Number(item.depth)) : 0,
            content: typeof item.content === 'string' ? item.content : ''
          });
        }
      });
      if (wbList.length > 0) meta.triggeredWorldbooks = wbList;
    }

    return Object.keys(meta).length > 0 ? meta : null;
  }

  // === [ANCHOR: CHAT_PARAMS] 双层对话参数（全局默认 + 单会话独立） ===
  /* ================= 对话参数：全局默认与单会话独立 ================= */

  // 标准参数字段：null 表示「留空不发送 / 不截断」，stream / realTime 默认开启
  var DEFAULT_CHAT_PARAMS = {
    contextLimit: 20,
    temperature: 1,
    topP: 1,
    maxTokens: null,
    stream: true,
    realTime: true
  };

  // 内存中的全局默认参数（页面加载时从 localStorage 回填）
  var globalChatParams = cloneChatParams(DEFAULT_CHAT_PARAMS);

  /**
   * 把任意输入规范化为「正整数或 null」（上下文上限 / 最大输出 Token 用）
   */
  function normalizePositiveInt(value) {
    if (value === null || value === undefined || value === '') return null;
    var num = parseInt(value, 10);
    if (!isFinite(num) || num <= 0) return null;
    return num;
  }

  /**
   * 把任意输入规范化为「限定范围内的浮点数或 null」（温度 / Top P 用）
   */
  function normalizeFloatInRange(value, min, max) {
    if (value === null || value === undefined || value === '') return null;
    var num = Number(value);
    if (!isFinite(num)) return null;
    if (num < min) num = min;
    if (num > max) num = max;
    return num;
  }

  /**
   * 深拷贝并规范化一组对话参数，保证结构永远是完整的 5 个字段
   */
  function cloneChatParams(source) {
    var src = source && typeof source === 'object' ? source : {};
    return {
      contextLimit: normalizePositiveInt(src.contextLimit),
      temperature: normalizeFloatInRange(src.temperature, 0, 2),
      topP: normalizeFloatInRange(src.topP, 0, 1),
      maxTokens: normalizePositiveInt(src.maxTokens),
      stream: src.stream !== false,
      // 静默现实时间背景板开关（仅控制本次请求是否附带 <env_context>）
      realTime: src.realTime !== false
    };
  }

  /**
   * 页面加载时读取全局默认参数（mychat_chat_params）
   */
  function loadChatParams() {
    var saved = readStorageValue(CHAT_PARAMS_KEY);
    globalChatParams = cloneChatParams(saved || DEFAULT_CHAT_PARAMS);
  }

  /**
   * 取全局默认参数的副本（避免外部误改内存对象）
   */
  function getGlobalChatParams() {
    return cloneChatParams(globalChatParams);
  }

  /**
   * 保存全局默认参数：写入 localStorage、刷新全局时间戳并触发静默云同步
   */
  function persistChatParams(params) {
    globalChatParams = cloneChatParams(params);
    try {
      localStorage.setItem(CHAT_PARAMS_KEY, JSON.stringify(globalChatParams));
    } catch (err) {
      console.warn('默认对话参数保存失败：浏览器存储不可用', err);
      return false;
    }
    if (!applyingCloudData && !isBooting) {
      touchLastModified();
      scheduleCloudUpload();
    }
    return true;
  }

  /**
   * 固化会话的独立参数：历史会话若缺少 params 对象，
   * 立即把当前的全局默认参数深拷贝一份挂载上去（此后互不影响）
   * @param {Array} list 会话数组
   * @return {boolean} 是否有会话被补齐（需要写回存储）
   */
  function freezeMissingSessionParams(list) {
    var changed = false;
    (list || []).forEach(function (session) {
      if (!session || typeof session !== 'object') return;
      if (session.params && typeof session.params === 'object') return;
      session.params = getGlobalChatParams();
      changed = true;
    });
    return changed;
  }

  /**
   * 取某个会话的独立参数（彻底固化，绝不被全局默认参数覆盖）：
   * 1. 传入有效会话但尚无 params 时：当场深拷贝全局默认并持久化；
   * 2. params 已存在时：直接返回会话自身的值（null 就保持 null）。
   */
  function getSessionParams(session) {
    if (!session || typeof session !== 'object') return getGlobalChatParams();

    if (!session.params || typeof session.params !== 'object') {
      session.params = getGlobalChatParams();
      persistSessions();
      if (!applyingCloudData && !isBooting) {
        touchLastModified();
        scheduleCloudUpload();
      }
    }

    return cloneChatParams(session.params);
  }

  /**
   * 把参数写入当前会话的独立 params（绝不反向污染全局默认参数）
   */
  function saveSessionParams(session, params) {
    if (!session) return;
    session.params = cloneChatParams(params);
    session.updatedAt = Date.now();
    persistSessions();
    refreshMemoryContext();
    if (!applyingCloudData && !isBooting) {
      touchLastModified();
      scheduleCloudUpload();
    }
  }

  /**
   * 判断会话参数是否已偏离全局默认（用于按钮上的「已定制」提示）
   */
  function isSessionParamsCustomized(session) {
    if (!session || !session.params || typeof session.params !== 'object') return false;
    var current = getSessionParams(session);
    var base = getGlobalChatParams();
    return (
      current.contextLimit !== base.contextLimit ||
      current.temperature !== base.temperature ||
      current.topP !== base.topP ||
      current.maxTokens !== base.maxTokens ||
      current.stream !== base.stream
    );
  }

  /* ================= 人民币花费计算（元 / 百万 Tokens） ================= */

  /**
   * 把金额格式化为人民币字符串
   * - 常规保留 4 位小数并去掉末尾多余的 0（¥0.0245 / ¥0.02）
   * - 大于 0 但小于 0.0001 时退回有效数字展示，避免显示成 ¥0.0000
   */
  function formatRmbCost(cost) {
    var num = Number(cost);
    if (!isFinite(num) || num <= 0) return '';

    // 去掉末尾多余的 0 与孤立的小数点
    var trimZeros = function (text) {
      return String(text).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    };

    // 至少保留 2 位小数（如 ¥0.02 / ¥12.50 显示为 ¥12.5，而 ¥3 补成 ¥3.00）
    var padTwo = function (text) {
      var dot = text.indexOf('.');
      if (dot === -1) return text + '.00';
      var decimals = text.length - dot - 1;
      if (decimals === 0) return text + '00';
      if (decimals === 1) return text + '0';
      return text;
    };

    if (num < 0.0001) {
      // 极小额：按量级放大保留位数，避免显示成 ¥0.0000（如 1.2e-5 显示为 ¥0.000012）
      var precision = Math.min(12, Math.max(4, -Math.floor(Math.log10(num)) + 1));
      var small = trimZeros(num.toFixed(precision));
      return '¥' + small;
    }

    // 常规金额：固定四位小数后去掉末尾多余的 0，至少保留两位
    return '¥' + padTwo(trimZeros(num.toFixed(4)));
  }

  /**
   * 根据模型单价与 Token 用量计算本轮人民币花费文本
   * 未填写任何有效单价时返回空字符串（即不展示费用）
   * @param {Object} model 模型对象（含 inputPrice / cachePrice / outputPrice）
   * @param {number} totalTokens 总 Token
   * @param {number} cachedTokens 命中缓存的输入 Token
   * @param {number} outputTokens 输出 Token
   */
  function computeCostText(model, totalTokens, cachedTokens, outputTokens) {
    if (!model) return '';

    var toNum = function (value) {
      var num = Number(normalizePriceValue(value));
      return isFinite(num) && num >= 0 ? num : 0;
    };

    // 三个单价都没填（或全是非法值）时不计费
    if (!hasAnyPrice(model)) return '';

    var inputPrice = toNum(model.inputPrice);
    var cachePrice = toNum(model.cachePrice);
    var outputPrice = toNum(model.outputPrice);

    var total = isFinite(Number(totalTokens)) && Number(totalTokens) > 0 ? Number(totalTokens) : 0;
    var output = isFinite(Number(outputTokens)) && Number(outputTokens) > 0 ? Number(outputTokens) : 0;
    var cached = isFinite(Number(cachedTokens)) && Number(cachedTokens) > 0 ? Number(cachedTokens) : 0;

    // 输入 Token = 总量 - 输出，且不能为负
    var promptTokens = Math.max(0, total - output);
    // 未命中缓存的输入 Token
    var uncachedInput = Math.max(0, promptTokens - cached);

    var cost =
      (uncachedInput * inputPrice + cached * cachePrice + output * outputPrice) / 1000000;

    return formatRmbCost(cost);
  }

  // === [ANCHOR: COT_MARKDOWN] 思维链分离与 Markdown 渲染兜底 ===
  /* ================= 思维链（CoT）解析工具 ================= */

  // 标签拆分拼接，避免在源码中出现完整的思维链标签
  var THINK_OPEN_TAG = '<' + 'think' + '>';
  var THINK_CLOSE_TAG = '<' + '/' + 'think' + '>';

  /**
   * 智能防误伤解析：只识别「消息最开头（去除前导空白后）」的第一对思维链标签
   * - 开头标签未闭合（流式输出中途）：全部内容都算思考中
   * - 开头标签已闭合：其后所有内容都是正式正文，正文/代码中再次出现标签也原样保留
   * @param {string} raw 原始消息内容
   * @return {{reasoning: string, answer: string, inThink: boolean, hasThink: boolean}}
   */
  function splitLeadingThink(raw) {
    var text = typeof raw === 'string' ? raw : '';
    var trimmed = text.replace(/^\s+/, '');

    // 不是以开头标签起始：整段都是正文，绝不转化
    if (trimmed.slice(0, THINK_OPEN_TAG.length).toLowerCase() !== THINK_OPEN_TAG) {
      return { reasoning: '', answer: text, inThink: false, hasThink: false };
    }

    var closeIndex = trimmed.toLowerCase().indexOf(THINK_CLOSE_TAG, THINK_OPEN_TAG.length);
    if (closeIndex === -1) {
      // 标签尚未闭合：视为仍在输出思考过程
      return {
        reasoning: trimmed.slice(THINK_OPEN_TAG.length),
        answer: '',
        inThink: true,
        hasThink: true
      };
    }

    var reasoning = trimmed.slice(THINK_OPEN_TAG.length, closeIndex);
    var answer = trimmed.slice(closeIndex + THINK_CLOSE_TAG.length).replace(/^[ \t]*\r?\n?/, '');
    return { reasoning: reasoning, answer: answer, inThink: false, hasThink: true };
  }

  /**
   * 剔除开头思维链，仅保留正式正文（用于构建 API 上下文，节省 Token）
   */
  function stripLeadingThink(raw) {
    return splitLeadingThink(raw).answer;
  }

  /**
   * 内容是否只是开头标签的一部分（流式刚输出 "<thi" 等片段时先不显示，避免闪标签）
   */
  function isThinkOpenPrefix(raw) {
    var trimmed = String(raw || '').replace(/^\s+/, '');
    if (!trimmed || trimmed.length >= THINK_OPEN_TAG.length) return false;
    return THINK_OPEN_TAG.slice(0, trimmed.length).toLowerCase() === trimmed.toLowerCase();
  }

  /* ================= Markdown 渲染与代码块工具 ================= */

  /**
   * HTML 转义（Markdown 库缺失时的降级方案）
   */
  function escapeHtml(text) {
    // 用字符码构造实体，避免源码中出现裸标签干扰解析
    var AMP = '&' + 'amp;';
    var LT = '&' + 'lt;';
    var GT = '&' + 'gt;';
    var QUOT = '&' + 'quot;';
    var APOS = '&' + '#39;';
    return String(text == null ? '' : text)
      .replace(/&/g, AMP)
      .replace(/</g, LT)
      .replace(/>/g, GT)
      .replace(/"/g, QUOT)
      .replace(/'/g, APOS);
  }

  /**
   * 原生行内解析：行内代码（`代码`）与加粗（**文字**）
   * 先转义 HTML，再用占位符保护行内代码，避免其中的星号被误当加粗
   */
  // 原生兜底渲染时允许保留的 HTML 标签白名单
  // （酒馆 onRender 美化正则常产出 <div> / <span> / <details> / 状态栏等结构，
  //  降级渲染时若整体转义，会把结构打成一堆纯文本，因此必须精确放行安全标签）
  var NATIVE_SAFE_TAGS = [
    'div', 'span', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
    'mark', 'small', 'sub', 'sup', 'code', 'pre', 'blockquote', 'q', 'cite',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'details', 'summary', 'section', 'article', 'header', 'footer', 'aside', 'nav',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'style', 'font', 'center', 'figure', 'figcaption'
  ];

  // 标签内允许保留的属性（其余一律丢弃，on* 事件属性天然被排除）
  var NATIVE_SAFE_ATTRS = [
    'class', 'id', 'style', 'title', 'align', 'valign', 'width', 'height', 'color',
    'size', 'face', 'colspan', 'rowspan', 'bgcolor', 'border', 'cellpadding',
    'cellspacing', 'open', 'type', 'start', 'lang', 'dir'
  ];

  /**
   * 清洗单个 HTML 标签：
   * 白名单内的标签重建为「只保留安全属性」的标准标签；
   * 白名单外（script / iframe / object / embed / form 等）一律返回 null，
   * 由调用方走转义路径按纯文本显示，绝不执行。
   */
  function sanitizeHtmlTagString(raw) {
    var m = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)([\s\S]*?)\/?\s*>$/.exec(String(raw || ''));
    if (!m) return null;
    var closing = m[1] === '/';
    var tag = m[2].toLowerCase();
    if (NATIVE_SAFE_TAGS.indexOf(tag) === -1) return null;
    if (closing) return '</' + tag + '>';

    var out = '<' + tag;
    var attrRe = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    var found;
    while ((found = attrRe.exec(m[3])) !== null) {
      var name = found[1].toLowerCase();
      if (NATIVE_SAFE_ATTRS.indexOf(name) === -1) continue;
      var value = found[2] != null ? found[2] : found[3] != null ? found[3] : found[4] || '';
      // 拦截 javascript: 伪协议
      if (/^\s*javascript:/i.test(value)) continue;
      out += ' ' + name + '="' + String(value).replace(/"/g, '"') + '"';
    }
    // 自闭合标签（<br> <hr> <col>）保持原样输出
    out += '>';
    return out;
  }

  /**
   * 原生行内解析：安全 HTML 标签 + 行内代码（`代码`）+ 加粗（**文字**）
   * 处理顺序：先抽出安全 HTML 标签占位 → 再抽出行内代码占位 → 其余文本整体转义
   * → 处理加粗 → 还原代码与标签。这样既保留了 onRender 生成的 HTML 结构，
   * 又保证普通文本中的尖括号不会被浏览器当作标签吞掉。
   */
  function renderNativeInline(text) {
    var HOLDER = '\u0002';
    var TAG_HOLDER = '\u0003';
    var codes = [];
    var tags = [];
    var src = String(text == null ? '' : text);

    // 1. 抽出安全 HTML 标签（危险标签不抽，后续会被转义成可见文本）
    src = src.replace(/<\/?[a-zA-Z][^>]*>/g, function (m) {
      var safe = sanitizeHtmlTagString(m);
      if (safe === null) return m;
      tags.push(safe);
      return TAG_HOLDER + (tags.length - 1) + TAG_HOLDER;
    });

    // 2. 抽出行内代码
    src = src.replace(/`([^`\n]+)`/g, function (m, code) {
      codes.push(code);
      return HOLDER + (codes.length - 1) + HOLDER;
    });

    // 3. 剩余文本转义
    var out = escapeHtml(src);

    // 4. 加粗
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    // 5. 还原行内代码（内容转义，标签不会被解析）
    out = out.replace(new RegExp(HOLDER + '(\\d+)' + HOLDER, 'g'), function (m, idx) {
      return '<code>' + escapeHtml(codes[Number(idx)]) + '</code>';
    });

    // 6. 还原安全 HTML 标签
    out = out.replace(new RegExp(TAG_HOLDER + '(\\d+)' + TAG_HOLDER, 'g'), function (m, idx) {
      var tag = tags[Number(idx)];
      return typeof tag === 'string' ? tag : '';
    });

    return out;
  }

  /**
   * 原生普通文本块解析：标题（# ~ ######）、段落与换行
   * 空行分段，连续非空行合并为一个段落并用 <br /> 保留换行
   */
  function renderNativeTextBlock(block) {
    var lines = String(block || '').split(/\r?\n/);
    var html = [];
    var buffer = [];

    var flush = function () {
      if (!buffer.length) return;
      var merged = buffer.join('\n');
      buffer = [];
      html.push('<p>' + renderNativeInline(merged).replace(/\n/g, '<br />') + '</p>');
    };

    lines.forEach(function (line) {
      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flush();
        var level = heading[1].length;
        html.push(
          '<h' + level + '>' + renderNativeInline(heading[2].trim()) + '</h' + level + '>'
        );
        return;
      }
      if (!line.trim()) {
        flush();
        return;
      }
      buffer.push(line);
    });

    flush();
    return html.join('');
  }

  /**
   * 原生 Markdown 解析器（不依赖任何外部库的兜底实现）
   * 关键：先精准提取所有三反引号代码块（包含流式输出中尚未闭合的结尾代码块），
   * 一律转换为标准 <pre><code class="language-xxx"> 结构，
   * 保证 enhanceCodeBlocks() 能 100% 挂载语言栏与「复制」按钮。
   */
  function nativeMarkdown(src) {
    var text = typeof src === 'string' ? src : '';
    if (!text) return '';

    var html = [];
    // 允许代码块未闭合（流式输出中途）：结尾用 $ 兜底匹配到文本末尾
    var fence = /```([^\n`]*)\r?\n?([\s\S]*?)(?:```|$)/g;
    var last = 0;
    var matched;

    while ((matched = fence.exec(text)) !== null) {
      if (matched.index > last) {
        html.push(renderNativeTextBlock(text.slice(last, matched.index)));
      }

      // 语言标识：只保留安全字符，避免污染 class 属性
      var lang = String(matched[1] || '').trim().split(/\s+/)[0] || '';
      lang = lang.replace(/[^\w+#.\-]/g, '');

      // 去掉代码块末尾多余的一个换行，保持内容整洁
      var code = String(matched[2] || '').replace(/\r?\n$/, '');

      html.push(
        '<pre><code class="language-' +
          (lang || 'text') +
          '">' +
          escapeHtml(code) +
          '</code></pre>'
      );

      last = fence.lastIndex;
      // 零宽匹配保护，避免正则死循环
      if (fence.lastIndex === matched.index) fence.lastIndex++;
    }

    if (last < text.length) {
      html.push(renderNativeTextBlock(text.slice(last)));
    }

    return html.join('');
  }

  // === [ANCHOR: HTML_SANDBOX] onRender HTML 沙盒渲染 + MVU 垫片 + 酒馆发送桥接 ===

  /* ================= Markdown 引擎配置（禁用缩进代码块） ================= */

  var markdownEngineReady = false;

  /**
   * 初始化 marked：开启 gfm + breaks，
   * 并通过 tokenizer 覆写彻底禁用「4 空格缩进」触发的 indented code block。
   * 三反引号围栏代码块由独立的 fences 分词器处理，完全不受影响。
   */
  function setupMarkdownEngine() {
    if (markdownEngineReady) return;
    markdownEngineReady = true;

    if (typeof window.marked === 'undefined' || typeof window.marked.use !== 'function') {
      return;
    }
    try {
      window.marked.use({ gfm: true, breaks: true });
      window.marked.use({
        tokenizer: {
          // 返回 false 表示「本分词器不认领该片段」，
          // 于是缩进块会退回段落解析，不再产出 <pre><code>
          code: function () {
            return false;
          }
        }
      });
    } catch (err) {
      console.warn('[MyChat] marked 缩进代码块禁用失败（不影响围栏代码块）：', err);
    }
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

    return src.replace(
      /(^|\n)[ \t]*```+[ \t]*(?:html|htm)[ \t]*\r?\n([\s\S]*?)```/gi,
      function (whole, lead, code) {
        if (!shouldSandboxFence(code, beforeRegexText, session)) return whole;
        sandboxSeq += 1;
        var id = sandboxSeq;
        sandboxRegistry[id] = {
          id: String(id),
          code: code,
          session: session || null
        };
        return (lead || '') + '\n%%MYCHAT_HTML_SANDBOX_' + id + '%%\n';
      }
    );
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
    if (!els.input || !els.sendBtn) return false;

    els.input.value = value;
    try {
      autoGrowInput();
    } catch (err) {
      /* 高度同步失败不影响发送 */
    }
    els.input.dispatchEvent(new Event('input', { bubbles: true }));
    els.sendBtn.click();
    return true;
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
      if (!els.sendBtn) return false;
      els.sendBtn.click();
      return true;
    };
    window.sendMessage = function (message, options) {
      if (typeof message === 'string' && message.trim()) return tavernSubmitText(message);
      if (options && typeof options.mes === 'string') return tavernSubmitText(options.mes);
      return false;
    };
  }

  /**
   * 把消息正文渲染为 HTML
   * 处理链路（顺序不可调换）：
   *   1) 宏变量替换（{{char}} / {{user}} / <BOT> / <USER> / MVU 变量宏）
   *   2) 记录 beforeRegexText → onRender 阀门（三层正则，仅影响显示）
   *   3) 裸 HTML 缩进清理 + 状态栏 ```html 围栏提取为沙盒占位符
   *   4) 思维链标签占位保护
   *   5) marked 渲染；CDN 缺失时走内置原生解析
   *
   * @param {string} text  原始正文
   * @param {string} [role] 消息角色 user / assistant（决定正则 targets 是否命中）
   * @param {object} [session] 当前会话（提供宏变量取值与「会话层」正则）
   */
  function renderMarkdown(text, role, session) {
    var src = typeof text === 'string' ? text : '';
    if (!src) return '';

    setupMarkdownEngine();

    // 1. 宏变量替换（显示层）：{{char}} 等占位符绝不能原样出现在气泡里
    var ctxSession = session || getCurrentSession();
    src = replaceMacros(src, ctxSession);
    if (!src) return '';

    // 2. onRender 阀门：仅改变界面显示效果的正则替换在此拦截（绝不影响入库内容）
    var beforeRegexText = src;
    var renderRole = role === 'user' ? 'user' : 'assistant';
    var renderPiped = runPipeline('onRender', src, {
      role: renderRole,
      session: ctxSession,
      rawText: text
    });
    if (typeof renderPiped === 'string') src = renderPiped;
    if (!src) return '';

    // 3. 仅当正则确实改写了内容时才做 HTML 裸块清理，普通 Markdown 原样保留
    if (src !== beforeRegexText) {
      src = stripBareHtmlIndent(src);
    }
    // 状态栏 / 美化面板：提取为占位符，渲染后换成自适应 iframe
    src = hoistSandboxFences(src, beforeRegexText, ctxSession);
    if (!src) return '';

    // 4. 正文 / 代码中残留的思维链标签不能被当作 HTML 吞掉：
    // 先用占位符替换，渲染后再还原为转义文本，保证用户能看到原始标签
    var PLACEHOLDER = '\u0001';
    src = src.replace(/<(\/?)think>/gi, PLACEHOLDER + '$1' + PLACEHOLDER);

    // 还原为「可见的转义文本」，绝不重新生成真实标签，避免被 HTML 解析吞掉
    var toText = function (html) {
      return String(html || '').replace(
        new RegExp(PLACEHOLDER + '(/?)' + PLACEHOLDER, 'gi'),
        function (m, slash) {
          return '&' + 'lt;' + slash + 'think' + '&' + 'gt;';
        }
      );
    };

    if (typeof window.marked === 'undefined' || !window.marked.parse) {
      // 外部 CDN 加载失败：走内置原生解析，代码块 / 标题 / 加粗 / 行内代码全部可用
      return toText(nativeMarkdown(src));
    }
    try {
      if (typeof marked.use === 'function') {
        // 用 use 而非 setOptions，避免冲掉 tokenizer 的缩进代码块禁用配置
        marked.use({ gfm: true, breaks: true });
      } else {
        marked.setOptions({ gfm: true, breaks: true });
      }
      return toText(marked.parse(src));
    } catch (err) {
      console.warn('Markdown 渲染失败，已启用内置原生解析器兜底：', err);
      return toText(nativeMarkdown(src));
    }
  }

  /**
   * 兜底复制：旧浏览器 / 非安全上下文使用 textarea + execCommand
   */
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }

  /**
   * 复制文本到剪贴板，完成后回调 true / false
   */
  function copyText(text, done) {
    var finish = typeof done === 'function' ? done : function () {};
    var value = String(text == null ? '' : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(
        function () {
          finish(true);
        },
        function () {
          finish(legacyCopy(value));
        }
      );
    } else {
      finish(legacyCopy(value));
    }
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

  /**
   * 为消息中的每个代码块补上工具条：左侧语言名 + 右侧「预览」/「复制」按钮
   * HTML 代码块额外提供沙盒预览，可在「源码 / 渲染效果」之间切换
   */
  function enhanceCodeBlocks(container) {
    if (!container) return;
    var pres = container.querySelectorAll('pre');

    Array.prototype.forEach.call(pres, function (pre) {
      if (pre.getAttribute('data-enhanced') === '1') return;
      var code = pre.querySelector('code');
      if (!code) return;
      pre.setAttribute('data-enhanced', '1');

      // 读取 language-xxx / lang-xxx 类名作为语言标识
      var lang = '';
      var cls = code.className || '';
      var matched = cls.match(/language-([\w+#.-]+)/i) || cls.match(/lang-([\w+#.-]+)/i);
      if (matched && matched[1]) lang = matched[1];

      // 语法高亮（失败不影响内容展示）
      if (typeof window.hljs !== 'undefined' && window.hljs.highlightElement) {
        try {
          hljs.highlightElement(code);
        } catch (hlErr) {
          console.warn('代码高亮失败：', hlErr);
        }
      }

      var bar = document.createElement('div');
      bar.className = 'code-toolbar';

      var label = document.createElement('span');
      label.className = 'code-lang';
      label.textContent = lang || '代码';

      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn-copy-code';
      copyBtn.textContent = '复制';

      copyBtn.addEventListener('click', function () {
        copyText(code.textContent || '', function (ok) {
          copyBtn.textContent = ok ? '✓ 已复制' : '复制失败';
          if (copyBtn._copyTimer) clearTimeout(copyBtn._copyTimer);
          copyBtn._copyTimer = setTimeout(function () {
            copyBtn.textContent = '复制';
          }, 1500);
        });
      });

      bar.appendChild(label);

      // 右侧按钮组：预览（仅 HTML）+ 复制
      var actions = document.createElement('div');
      actions.className = 'code-toolbar-actions';

      // HTML 代码块：在复制按钮左侧追加「预览」按钮（沙盒渲染，避免破坏聊天布局）
      var rawCodeText = code.textContent || '';
      var isHtmlLike =
        /^(html|htm|xml|xhtml)$/i.test(lang) ||
        /<html[\s>]|<div[\s>]|<style[\s>]/i.test(rawCodeText);

      if (isHtmlLike) {
        var previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'btn-preview-code';
        previewBtn.textContent = '预览';

        previewBtn.addEventListener('click', function () {
          var host = previewBtn._previewHost;
          if (!host) {
            host = buildPreviewSandbox(rawCodeText);
            host.classList.add('code-preview-host');
            host.style.display = 'none';
            previewBtn._previewHost = host;
            if (pre.parentNode) pre.parentNode.appendChild(host);
          }
          var showing = host.style.display !== 'none';
          var block = host.closest('.code-block');
          if (block) block.classList.toggle('is-previewing', !showing);
          var bubble = host.closest('.bubble, .msg-bubble');
          if (bubble) {
            bubble.classList.add('has-sandbox');
            var textBody = host.closest('.msg-text-body');
            if (textBody) {
              var remainder = textBody.cloneNode(true);
              Array.prototype.forEach.call(remainder.querySelectorAll('.code-block, .tavern-sandbox-wrap'), function (el) { el.remove(); });
              textBody.classList.toggle('sandbox-preview-only', !showing && !remainder.textContent.trim());
            }
          }
          if (showing) {
            host.style.display = 'none';
            pre.style.display = '';
            previewBtn.textContent = '预览';
            previewBtn.classList.remove('is-active');
          } else {
            host.style.display = '';
            pre.style.display = 'none';
            previewBtn.textContent = '源码';
            previewBtn.classList.add('is-active');
          }
        });

        actions.appendChild(previewBtn);
      }

      actions.appendChild(copyBtn);
      bar.appendChild(actions);

      // 用外层容器包住工具条与代码块，保证顶部圆角与滚动一致
      var wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      if (pre.parentNode) {
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(bar);
        wrapper.appendChild(pre);
      }
    });
  }

  /**
   * 生成会话唯一标识：毫秒时间戳 + 随机串
   */
  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * 把用户填写的 Base URL 拼接为完整的 /chat/completions 端点
   * 兼容三种写法：
   *   1. https://api.openai.com/v1            -> 补 /chat/completions
   *   2. https://api.openai.com/v1/           -> 去掉多余斜杠后补
   *   3. https://api.openai.com/v1/chat/completions -> 原样使用
   */
  function buildChatUrl(baseUrl) {
    var url = (baseUrl || '').trim().replace(/\s+/g, '');
    if (!url) url = DEFAULTS.baseUrl;
    url = url.replace(/\/+$/, ''); // 去掉结尾所有多余的斜杠
    if (/\/chat\/completions$/i.test(url)) return url;
    return url + '/chat/completions';
  }

  /**
   * 把 Base URL 拼接为 /models 端点（自动拉取模型与连通性检测共用）
   */
  function buildModelsUrl(baseUrl) {
    var url = (baseUrl || '').trim().replace(/\s+/g, '');
    if (!url) url = DEFAULTS.baseUrl;
    url = url.replace(/\/+$/, '');
    if (/\/models$/i.test(url)) return url;
    if (/\/chat\/completions$/i.test(url)) {
      url = url.replace(/\/chat\/completions$/i, '');
    }
    return url + '/models';
  }

  /**
   * 强制滚动到底部（发送 / 重新回复时调用，同时恢复自动跟随）
   */
  function forceScrollToBottom() {
    if (!els.chatArea) return;
    els.chatArea._holdScroll = false;
    userScrolledUp = false;
    els.chatArea.scrollTop = els.chatArea.scrollHeight;
    var key = els.chatArea._renderChannel;
    requestAnimationFrame(function () {
      if (key === els.chatArea._renderChannel && !userScrolledUp) els.chatArea.scrollTop = els.chatArea.scrollHeight;
    });
  }

  /**
   * 智能跟随滚动：只有用户没有主动上滑时才自动拉到底部
   * 流式输出每个 chunk 都会调用，用户上滑阅读时保持视口不动
   */
  function scrollToBottom() {
    if (!els.chatArea) return;
    if (userScrolledUp || els.chatArea._holdScroll) return;
    els.chatArea.scrollTop = els.chatArea.scrollHeight;
  }

  /**
   * 监听消息区滚动，判断用户是否主动离开底部：
   * - 距底 > 60px：视为主动上滑，暂停自动跟随
   * - 滑回距底 <= 50px：恢复自动跟随
   */
  function handleChatScroll() {
    if (!els.chatArea) return;
    var container = els.chatArea;
    var distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    if (distanceToBottom > 60) {
      userScrolledUp = true;
    } else if (distanceToBottom <= 50) {
      userScrolledUp = false;
      container._holdScroll = false;
    }
    var previousTop = container._lastScrollTop;
    if (container.scrollTop <= 180 && renderedStartIndex > 0 &&
        typeof previousTop === 'number' && container.scrollTop < previousTop) {
      prependMessageRows(Math.max(0, renderedStartIndex - 15));
    }
    container._lastScrollTop = container.scrollTop;
  }

  /**
   * 移除空会话提示
   */
  function hideEmptyTip() {
    var tip = els.chatArea.querySelector('#empty-tip');
    if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
  }

  /**
   * 由用户的第一条消息生成会话标题（最多 12 个字符）
   * 使用 Array.from 按真实字符切分，避免把 emoji 等截成半个
   */
  function makeTitle(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    var chars = Array.from(t).slice(0, 12).join('');
    return chars || DEFAULT_TITLE;
  }

  /* ================= 全局时间戳与日期工具 ================= */

  /**
   * 读取本地全局最后修改时间戳（不存在时返回 0）
   */
  function getLocalLastModified() {
    try {
      var raw = localStorage.getItem(LAST_MODIFIED_KEY);
      var num = parseInt(raw, 10);
      return isFinite(num) && num > 0 ? num : 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * 刷新全局最后修改时间戳：
   * 新建会话 / 删除会话 / 发送消息 / AI 回复完成时都必须调用
   */
  function touchLastModified() {
    if (isBooting || applyingCloudData || !isStartupSyncSettled) return getLocalLastModified();
    var now = Date.now();
    try {
      localStorage.setItem(LAST_MODIFIED_KEY, String(now));
    } catch (err) {
      console.warn('全局时间戳写入失败：', err);
    }
    return now;
  }

  /**
   * 兜底：旧版本升级上来的数据可能没有 mychat_last_modified，
   * 此时用历史会话中最大的 updatedAt 作为初始时间戳，
   * 避免本地已有聊天记录却被云端数据直接覆盖。
   */
  function ensureLocalLastModified() {
    if (isBooting || applyingCloudData || !isStartupSyncSettled || getLocalLastModified() > 0) return;

    var maxStamp = 0;
    var hasMessage = false;
    sessions.forEach(function (s) {
      if (!s) return;
      if (s.messages && s.messages.length > 0) hasMessage = true;
      if (typeof s.updatedAt === 'number' && s.updatedAt > maxStamp) {
        maxStamp = s.updatedAt;
      }
    });

    // 本机没有任何聊天内容时不写入时间戳（保持 0）：
    // 这样首次打开时云端时间戳必然更大，会优先采用云端数据
    if (!hasMessage) return;

    try {
      localStorage.setItem(LAST_MODIFIED_KEY, String(maxStamp));
    } catch (err) {
      console.warn('全局时间戳写入失败：', err);
    }
  }

  /**
   * 把时间戳格式化为本地日期 YYYY-MM-DD（用于生成每日备份文件名）
   */
  function formatDateKey(timestamp) {
    var d = new Date(timestamp);
    var month = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + month + '-' + day;
  }

  /* ================= 会话数据层（本地持久化） ================= */

  /**
   * 规范化消息数组，丢弃结构异常的数据与流式残留占位，避免渲染报错
   * 会话主消息与各内部对话（subChats）的消息共用同一套清洗规则
   */
  function normalizeMessageArray(rawMessages) {
    var messages = [];
    if (!Array.isArray(rawMessages)) return messages;

    rawMessages.forEach(function (msg) {
      if (!msg || typeof msg !== 'object') return;
      if (typeof msg.content !== 'string') return;
      if (msg.role !== 'user' && msg.role !== 'assistant') return;

      // 保留思维链（本地完整存储，供用户随时展开查看）
      var reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';

      // 丢弃刷新页面时可能残留的空 AI 占位，避免污染下一轮上下文
      if (msg.role === 'assistant' && !msg.content && !reasoning && !(Array.isArray(msg.swipes) && msg.swipes.some(function (branch) { return branch && (branch.content || branch.reasoning); }))) return;

      var item = Object.assign({}, msg, { role: msg.role, content: msg.content });
      if (msg.role === 'assistant' && reasoning) item.reasoning = reasoning;

      // 统计信息（时间 / Token / 缓存 / 耗时）随会话一起持久化与云同步
      var meta = normalizeMessageMeta(msg.meta);
      if (meta) item.meta = meta;

      // ---- 多分支（swipes）持久化：刷新 / 云同步后绝不能丢失旧回复 ----
      // 结构：[{ content, reasoning?, timestamp? }]，顶层 content / reasoning 恒等于当前分支
      if (msg.role === 'assistant' && Array.isArray(msg.swipes) && msg.swipes.length) {
        var swipes = [];
        msg.swipes.forEach(function (branch) {
          if (!branch || typeof branch !== 'object') return;
          if (typeof branch.content !== 'string') return;
          var branchItem = Object.assign({}, branch, { content: branch.content });
          if (typeof branch.reasoning === 'string' && branch.reasoning) {
            branchItem.reasoning = branch.reasoning;
          }
          if (typeof branch.timestamp === 'number' && isFinite(branch.timestamp)) {
            branchItem.timestamp = branch.timestamp;
          }
          swipes.push(branchItem);
        });
        if (swipes.length) {
          item.swipes = swipes;
          var swipeIdx =
            typeof msg.swipeIndex === 'number' && isFinite(msg.swipeIndex)
              ? Math.round(msg.swipeIndex)
              : swipes.length - 1;
          if (swipeIdx < 0) swipeIdx = 0;
          if (swipeIdx > swipes.length - 1) swipeIdx = swipes.length - 1;
          item.swipeIndex = swipeIdx;
          // 顶层正文强制与当前分支对齐，保证渲染 / 导出 / 正则完全兼容
          item.content = swipes[swipeIdx].content;
          if (swipes[swipeIdx].reasoning) {
            item.reasoning = swipes[swipeIdx].reasoning;
          } else {
            delete item.reasoning;
          }
        }
      }

      messages.push(item);
    });

    return messages;
  }

  /**
   * 规范化单个会话对象，丢弃结构异常的数据，避免渲染报错
   */
  function normalizeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;

    var messages = normalizeMessageArray(raw.messages);

    var session = Object.assign({}, raw, {
      id: typeof raw.id === 'string' && raw.id ? raw.id : genId(),
      title:
        typeof raw.title === 'string' && raw.title.trim()
          ? raw.title.trim()
          : DEFAULT_TITLE,
      updatedAt:
        typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt)
          ? raw.updatedAt
          : Date.now(),
      inputDraft: typeof raw.inputDraft === 'string' ? raw.inputDraft : '',
      messages: messages
    });

    // 单条会话的独立对话参数：历史旧数据没有该字段时保持缺失，
    // 读取有效参数时会自动以全局默认补齐（绝不污染全局默认参数）
    if (raw.params && typeof raw.params === 'object') {
      session.params = Object.assign({}, raw.params, cloneChatParams(raw.params));
    } else if (raw.chatParams && typeof raw.chatParams === 'object') {
      session.params = cloneChatParams(raw.chatParams);
    }
    // 兼容携带别名字段的备份，不能在规范化时静默丢弃
    if (raw.chatParams && typeof raw.chatParams === 'object') session.chatParams = safeClone(raw.chatParams);
    if (Array.isArray(raw.regexRuleIds)) session.regexRuleIds = raw.regexRuleIds.filter(function (id) { return typeof id === 'string'; });

    // 单条会话绑定的大预设：默认一律为 null（历史数据未设置同样保持 null）
    session.presetId = typeof raw.presetId === 'string' && raw.presetId ? raw.presetId : null;

    // 当前会话窗口启用的世界书 ID 列表（本窗口全部子对话共享）；历史数据默认空数组
    session.worldbookIds = Array.isArray(raw.worldbookIds)
      ? raw.worldbookIds.filter(function (wid) {
          return typeof wid === 'string' && wid;
        })
      : [];

    // 记忆总结元数据（由 modules/memory-summary.js 维护）：绑定世界书 / 总结游标 / 开关
    session.memoryMeta =
      raw.memoryMeta && typeof raw.memoryMeta === 'object' ? raw.memoryMeta : {};

    // ---- 角色卡底座字段（历史数据全部走幂等兜底，随 sessions 一起云同步） ----
    // 收藏夹标记：true 时置顶到「收藏夹」分组
    session.pinned = raw.pinned === true;
    // AI 角色头像 / 用户头像（图片直链或 Base64，空字符串表示使用首字徽章）
    session.avatar = typeof raw.avatar === 'string' ? raw.avatar : '';
    session.userAvatar = typeof raw.userAvatar === 'string' ? raw.userAvatar : '';
    // AI 角色名称 / 用户名称（消息气泡旁显示）
    session.charName = typeof raw.charName === 'string' ? raw.charName : '';
    session.userName = typeof raw.userName === 'string' ? raw.userName : '';
    // 角色开场白（新建空对话时自动写入 #1 楼）
    session.firstMessage = typeof raw.firstMessage === 'string' ? raw.firstMessage : '';
    // 角色卡正则规则（三层正则之「会话层」，供 modules/regex-engine.js 使用）
    session.regexRules = Array.isArray(raw.regexRules)
      ? normalizeRegexRules(raw.regexRules)
      : [];

    // ---- 角色卡基础设定（酒馆角色卡导入后的原始设定字段，历史数据一律幂等兜底） ----
    // 这些字段会在发送请求时按需合并进系统提示词 / 后置强指令，也支持 {{char}} / {{user}} 宏替换
    session.charDescription = typeof raw.charDescription === 'string' ? raw.charDescription : '';
    session.charPersonality = typeof raw.charPersonality === 'string' ? raw.charPersonality : '';
    session.charScenario = typeof raw.charScenario === 'string' ? raw.charScenario : '';
    session.charMesExample = typeof raw.charMesExample === 'string' ? raw.charMesExample : '';
    session.charSystemPrompt =
      typeof raw.charSystemPrompt === 'string' ? raw.charSystemPrompt : '';
    session.charPostHistory =
      typeof raw.charPostHistory === 'string' ? raw.charPostHistory : '';
    // 备选开场白：酒馆 alternate_greetings，可在「角色与对话设置」中切换 #1 楼
    session.alternateGreetings = Array.isArray(raw.alternateGreetings)
      ? raw.alternateGreetings.filter(function (g) {
          return typeof g === 'string' && g.trim();
        })
      : [];
    // 当前采用的备选开场白索引：-1 表示使用 first_mes
    session.greetingIndex =
      typeof raw.greetingIndex === 'number' && isFinite(raw.greetingIndex)
        ? Math.round(raw.greetingIndex)
        : -1;

    // 内部对话（子对话 / 分支）：必须完整还原，否则刷新 / 云同步后分支会全部丢失
    if (Array.isArray(raw.subChats) && raw.subChats.length > 0) {
      session.subChats = raw.subChats
        .map(function (sub) {
          if (!sub || typeof sub !== 'object') return null;
          var item = Object.assign({}, sub, {
            id:
              typeof sub.id === 'string' && sub.id
                ? sub.id
                : 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            title:
              typeof sub.title === 'string' && sub.title.trim() ? sub.title.trim() : '未命名对话',
            updatedAt:
              typeof sub.updatedAt === 'number' && isFinite(sub.updatedAt)
                ? sub.updatedAt
                : Date.now(),
            messages: normalizeMessageArray(sub.messages)
          });
          // 仅「建立分支」产生的子对话才带分支起点楼层
          if (typeof sub.branchFloor === 'number' && isFinite(sub.branchFloor)) {
            item.branchFloor = sub.branchFloor;
          }
          return item;
        })
        .filter(function (sub) {
          return !!sub;
        });

      if (session.subChats.length > 0 && typeof raw.activeSubChatId === 'string') {
        session.activeSubChatId = raw.activeSubChatId;
      }
    }

    // 内部对话（子对话 / 分支）结构：历史数据自动补建「主对话」，向下兼容
    ensureSessionSubChats(session);

    return session;
  }

  /**
   * 生成内部对话唯一 ID：毫秒时间戳 + 随机后缀
   * 纯 Date.now() 在同一毫秒内连续新建 / 建立分支时会撞 ID，
   * 导致「当前」标记与真实数据错位，因此必须补随机后缀
   */
  function genSubChatId() {
    return 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  /**
   * 内部对话（子对话 / 分支）结构兜底与同步（幂等）
   * - 会话缺少 subChats 时自动补建一个「主对话」，并把原 messages 收进去
   * - 始终把当前激活子对话的 messages 暴露为 session.messages（渲染 / 发送逻辑无需改动）
   * 注意：窗口参数（params）与预设（presetId）由全部子对话共享，不在这里复制
   * @param {object} session 会话对象
   * @returns {array} 该会话的 subChats 列表
   */
  function createEmptyMemoryData() {
    return { summarizedFloorCursor: 0, lastSummaryAt: null,
      overviewEntry: { id: 'overview', name: '【00_全局最新状态与事件总目录】', content: '',
        enabled: true, constant: true, keys: [], position: 'after_system', depth: 1 },
      eventEntries: [], snapshots: [] };
  }

  function refreshMemoryContext() {
    window.dispatchEvent(new Event('mychat-context-changed'));
    if (window.MemorySummaryModule && typeof window.MemorySummaryModule.onContextChanged === 'function') {
      window.MemorySummaryModule.onContextChanged();
    }
  }

  function ensureSessionSubChats(session) {
    if (!session || typeof session !== 'object') return [];

    if (!Array.isArray(session.subChats) || session.subChats.length === 0) {
      session.subChats = [
        {
          id: genSubChatId(),
          title: '主对话',
          updatedAt:
            typeof session.updatedAt === 'number' && isFinite(session.updatedAt)
              ? session.updatedAt
              : Date.now(),
          memoryData: session.memoryData || createEmptyMemoryData(),
          messages: Array.isArray(session.messages) ? session.messages : []
        }
      ];
      session.activeSubChatId = session.subChats[0].id;
      return session.subChats;
    }

    // 清理结构异常的子对话条目（保持顺序，绝不丢消息）
    // 铁律：严禁用 filter 替换 session.subChats 的数组引用！
    // 外部若提前缓存了该数组（例如 createSubChatFlow 中的 list），
    // 一旦引用被替换，后续 push 就写到废弃数组里，导致新建子对话「凭空消失」。
    // 这里改为原地逆序遍历 + splice，数组引用绝对稳定。
    for (var ci = session.subChats.length - 1; ci >= 0; ci--) {
      var cur = session.subChats[ci];
      if (!cur || typeof cur !== 'object') session.subChats.splice(ci, 1);
    }

    if (session.subChats.length === 0) {
      // 同样保持引用稳定：清空后原地 push，绝不新建数组
      session.subChats.push({
        id: genSubChatId(),
        title: '主对话',
        updatedAt: Date.now(),
        memoryData: session.memoryData || createEmptyMemoryData(),
        messages: Array.isArray(session.messages) ? session.messages : []
      });
      session.activeSubChatId = session.subChats[0].id;
      return session.subChats;
    }

    session.subChats.forEach(function (sub, idx) {
      if (typeof sub.id !== 'string' || !sub.id) sub.id = genSubChatId();
      if (typeof sub.title !== 'string' || !sub.title.trim()) sub.title = '对话 ' + (idx + 1);
      if (!Array.isArray(sub.messages)) sub.messages = [];
      if (!sub.memoryData || typeof sub.memoryData !== 'object') sub.memoryData = createEmptyMemoryData();
      if (typeof sub.updatedAt !== 'number' || !isFinite(sub.updatedAt)) sub.updatedAt = Date.now();
    });

    // 激活子对话兜底：ID 失效时回退到第一个
    var activeSub = null;
    for (var i = 0; i < session.subChats.length; i++) {
      if (session.subChats[i].id === session.activeSubChatId) {
        activeSub = session.subChats[i];
        break;
      }
    }
    if (!activeSub) activeSub = session.subChats[0];
    session.activeSubChatId = activeSub.id;

    // 关键：始终让 session.messages 指向激活子对话的消息数组（保持引用一致）
    session.messages = activeSub.messages;

    return session.subChats;
  }

  /**
   * 取当前激活的内部对话
   */
  function getActiveSubChat(session) {
    if (!session) return null;
    var list = ensureSessionSubChats(session);
    if (!list.length) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === session.activeSubChatId) return list[i];
    }
    return list[0];
  }

  /**
   * 把 session.messages 的最新内容同步回激活子对话
   * 任何消息增删改（发送 / 编辑 / 重答 / 删除 / 分支）后调用
   *
   * @param {object} session 会话对象
   * @param {boolean} [touchTime] 是否同时刷新该子对话的 updatedAt
   *        只有在「当前会话真正发生消息变更」时才传 true；
   *        persistSessions() 每次落盘都会遍历全部会话调用本函数，
   *        若此处无条件刷新时间戳，会把所有历史子对话的「最后修改时间」
   *        篡改成「此刻」，导致列表时间语义彻底失真。
   */
  function syncActiveSubMessages(session, touchTime) {
    if (!session) return;
    var activeSub = getActiveSubChat(session);
    if (!activeSub) return;
    activeSub.messages = Array.isArray(session.messages) ? session.messages : [];
    if (touchTime === true) activeSub.updatedAt = Date.now();
  }

  /**
   * 按 id 查找会话
   */
  function getSession(id) {
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === id) return sessions[i];
    }
    return null;
  }

  /**
   * 取当前选中的会话对象
   */
  function getCurrentSession() {
    return currentId ? getSession(currentId) : null;
  }

  /**
   * 当前视图是否仍停留在指定会话（流式输出期间用户可能切换会话）
   */
  function getActiveSubChatId(session) {
    var sub = getActiveSubChat(session);
    return sub ? sub.id : '';
  }

  function getSubChatMessages(session, subChatId) {
    var sub = session && Array.isArray(session.subChats) && session.subChats.find(function (item) {
      return item.id === subChatId;
    });
    return sub && Array.isArray(sub.messages) ? sub.messages : null;
  }

  function generationKey(sessionId, subChatId) {
    return sessionId + '::' + subChatId;
  }

  function isChannelGenerating(sessionId, subChatId) {
    return activeGenerationMap.has(generationKey(sessionId, subChatId));
  }

  function isCurrentActiveChannelGenerating() {
    var session = getCurrentSession();
    return !!session && (isChannelGenerating(session.id, getActiveSubChatId(session)) ||
      (pendingReplyPolicies && pendingReplyPolicies.has(generationKey(session.id, getActiveSubChatId(session)))));
  }

  function isCurrentSession(session, subChatId) {
    var activeSession = getCurrentSession();
    return !!session && !!activeSession && session.id === activeSession.id &&
      subChatId === getActiveSubChatId(activeSession);
  }

  // 会话级草稿由全部子对话共享；保留原始空白，不进入消息管道。
  function captureInputDraft() {
    var session = getCurrentSession();
    if (!session || !els.input) return;
    var text = String(els.input.value || '');
    if (session.inputDraft === text) return;
    session.inputDraft = text;
    inputDraftDirty = true;
  }

  function saveInputDraft() {
    captureInputDraft();
    if (!inputDraftDirty) return;
    if (inputDraftTimer) clearTimeout(inputDraftTimer);
    inputDraftTimer = setTimeout(function () {
      inputDraftTimer = null;
      flushSave();
    }, SAVE_THROTTLE_MS);
  }

  function restoreInputDraft() {
    if (!els.input) return;
    var session = getCurrentSession();
    els.input.value = session && typeof session.inputDraft === 'string' ? session.inputDraft : '';
    autoGrowInput();
  }

  /**
   * 把所有会话与当前选中 ID 写入 localStorage
   */
  function serializeSessions() {
    return sessions.map(function (session) {
      if (session.subChats && session.subChats.length) syncActiveSubMessages(session, false);
      (session.subChats && session.subChats.length ? session.subChats : [session]).forEach(function (owner) {
        if (owner.memoryData && window.MemorySummaryModule && typeof window.MemorySummaryModule.compactMemorySnapshots === 'function') window.MemorySummaryModule.compactMemorySnapshots(owner.memoryData);
      });
      return session.subChats && session.subChats.length ? Object.assign({}, session, { messages: [], memoryData: undefined }) : session;
    });
  }

  function persistSessions() {
    try {
      // 落盘前先把激活子对话的消息同步回去，保证 subChats 与 messages 永远一致
      // 第二个参数传 false：这里只同步数组引用，绝不篡改各历史子对话的 updatedAt
      sessions.forEach(function (s) {
        if (s && Array.isArray(s.subChats) && s.subChats.length) {
          syncActiveSubMessages(s, false);
        }
      });
      if (!writeStorageValue(SESSIONS_KEY, serializeSessions())) return false;
      if (!writeStorageValue(CURRENT_ID_KEY, currentId || '')) return false;
      // 所有删楼入口统一在成功落盘后巡检；模块后台保存会再次落盘，用守卫防递归。
      if (!applyingCloudData && !persistSessions.reconciling && window.MemorySummaryModule) {
        persistSessions.reconciling = true;
        try {
          sessions.forEach(function (s) {
            (s.subChats && s.subChats.length ? s.subChats : [s]).forEach(function (sub) {
              window.MemorySummaryModule.reconcileMemoryAfterFloorChange(s, sub.id);
            });
          });
        } finally { persistSessions.reconciling = false; }
      }
      return true;
    } catch (err) {
      // 存储不可用（隐私模式 / 配额已满）时静默降级，避免打断输入
      console.warn('会话保存失败，可能是浏览器存储不可用或空间不足：', err);
      return false;
    }
  }

  /**
   * 延迟保存（流式逐字输出时合并写入，保证内容不丢且不卡顿）
   */
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      persistSessions();
    }, SAVE_THROTTLE_MS);
  }

  /**
   * 立即保存并清理待执行的延迟保存
   */
  function flushSave() {
    if (inputDraftTimer) {
      clearTimeout(inputDraftTimer);
      inputDraftTimer = null;
    }
    if (inputDraftDirty) {
      inputDraftDirty = false;
      touchLastModified();
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return persistSessions();
  }

  /**
    * 页面加载时恢复全部历史会话，并选中上一次打开的会话
   * 若不存在任何会话，则自动创建一个默认的「新对话」
   */
  function loadSessions() {
    var raw = null;
    try {
      raw = readStorageRaw(SESSIONS_KEY);
    } catch (err) {
      console.warn('浏览器存储不可用，历史会话将无法读取：', err);
    }

    var list = safeJsonParse(raw);
    sessions = [];

    if (Array.isArray(list)) {
      list.forEach(function (item) {
        var normalized = normalizeSession(item);
        if (normalized) sessions.push(normalized);
      });
    }

    // 固化历史会话的独立参数：缺少 params 的会话当场继承当前全局默认并写回
    freezeMissingSessionParams(sessions);

    if (sessions.length === 0) {
      // 自动创建默认会话：不算用户操作，不刷新全局时间戳
      createSession(false, true);
      return;
    }

    var savedId = null;
    try {
      savedId = readStorageRaw(CURRENT_ID_KEY);
    } catch (err) {
      savedId = null;
    }

    currentId = savedId && getSession(savedId) ? savedId : sessions[0].id;

    // 规范化后的数据回写一次，同时记录当前选中 ID
    persistSessions();
  }

  /**
   * 新建会话。switchView 为 true 时立即切换视图
   * @param {boolean} switchView 是否立即切换视图
   * @param {boolean} skipTouch 是否跳过全局时间戳刷新（启动时自动补建会话用，
   *                            避免本地时间戳被刷新后无限覆盖云端数据）
   */
  function createSession(switchView, skipTouch) {
    captureInputDraft();
    flushSave();
    var session = {
      id: genId(),
      title: DEFAULT_TITLE,
      updatedAt: Date.now(),
      messages: [],
      inputDraft: '',
      // 新建会话时深拷贝当前全局默认参数（此后互不影响）
      params: getGlobalChatParams(),
      // 新建会话默认不绑定任何系统提示词预设，由用户自行选择
      presetId: null,
      // 新建会话默认不启用任何世界书（会话窗口级设置，全部子对话共享）
      worldbookIds: [],
      // 记忆总结元数据：由 modules/memory-summary.js 按需填充
      memoryMeta: {},
      // 角色卡底座字段（收藏 / 头像 / 角色名 / 开场白 / 预埋正则）
      pinned: false,
      avatar: '',
      userAvatar: '',
      charName: '',
      userName: '',
      firstMessage: '',
      regexRules: [],
      // 内部对话（子对话 / 分支）：新建会话默认只含一个空「主对话」
      subChats: [],
      activeSubChatId: null
    };

    // 补建默认「主对话」，并把 messages 指向它的消息数组
    ensureSessionSubChats(session);

    // 最新的会话排在最前面
    sessions.unshift(session);
    currentId = session.id;
    restoreInputDraft();
    persistSessions();
    // 用户主动新建会话才刷新全局时间戳；启动时自动补建不算用户操作
    if (skipTouch !== true) touchLastModified();

    if (switchView !== false) {
      renderSessionList();
      renderMessages();
      refreshQuickParamsPanel(); // 新会话继承了全局默认参数，同步底部按钮状态
      refreshPresetButtonState(); // 新会话默认无预设，同步顶部入口高亮状态
    }
    refreshMemoryContext();
    return session;
  }

  /**
   * 删除会话：弹窗确认，删空后自动补一个空会话
   */
  async function deleteSession(id) {
    var target = getSession(id);
    if (!target) return;

    var ok = await window.showAppConfirm('删除对话「' + (target.title || DEFAULT_TITLE) + '」？');
    if (!ok || getSession(id) !== target || activeGenerationMap.size > 0) return;

    // 记录删除前是否为当前会话，决定是否需要重绘聊天区
    var deletingCurrent = currentId === id;

    sessions = sessions.filter(function (s) {
      return s.id !== id;
    });

    if (sessions.length === 0) {
      // 列表被删空，自动新建一个空会话
      createSession(false);
      deletingCurrent = true;
    } else if (deletingCurrent) {
      // 删除的是当前会话，自动切换到第一个
      currentId = sessions[0].id;
    }

    persistSessions();
    touchLastModified(); // 删除会话属于全局修改，刷新同步时间戳
    renderSessionList();

    // 仅当被删除的是当前会话时才需要重绘聊天区；
    // 否则保留正在进行的流式气泡，避免打断输出展示
    if (deletingCurrent) {
      restoreInputDraft();
      renderMessages();
    }

    // 删除会话后延迟 1 秒静默上传云端
    scheduleCloudUpload();
  }

  /**
   * 切换到指定会话：重绘消息区并滚动到底部
   */
  function selectSession(id) {
    if (id === currentId) {
      refreshMemoryContext();
      closeSidebar();
      return;
    }
    var target = getSession(id);
    if (!target) return;

    captureInputDraft();
    flushSave();
    currentId = id;
    restoreInputDraft();
    // 切换会话前先保证目标会话的子对话结构完好，并让 messages 指向激活子对话
    ensureSessionSubChats(target);
    persistSessions();
    renderSessionList();
    // 切换会话时重置 #0 系统提示词层的折叠状态，避免残留上一会话的展开态
    systemFloorExpanded = false;
    renderMessages();
    // 切换会话时刷新底部参数面板的数值显示
    refreshQuickParamsPanel();
    // 切换会话时同步顶部预设入口的高亮状态
    refreshPresetButtonState();
    closeSidebar();

    if (!isCurrentActiveChannelGenerating() && els.input) els.input.focus();
  }

  /* ================= 侧边栏渲染与抽屉控制 ================= */

  // === [ANCHOR: AVATAR_HELPER] 头像渲染辅助（图片 / 首字莫兰迪色徽章） ===

  // 6 组莫兰迪低饱和配色：深海蓝 / 鼠尾草绿 / 暮光紫 / 暖砂棕 / 岩石灰 / 暗玫红
  var AVATAR_PALETTES = [
    { bg: '#3f5b78', fg: '#f2f6fa' },
    { bg: '#6f8b74', fg: '#f3f8f3' },
    { bg: '#6b5b7b', fg: '#f6f2f9' },
    { bg: '#9a7b5f', fg: '#fbf6f0' },
    { bg: '#6d7480', fg: '#f4f6f8' },
    { bg: '#8c5d63', fg: '#fbf2f3' }
  ];

  var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  var LETTER_RE = /[A-Za-z0-9]/;

  /**
   * 取用于首字徽章的第一个「有效字符」：优先中文，其次英文字母 / 数字
   */
  function pickAvatarInitial(name) {
    var text = typeof name === 'string' ? name.trim() : '';
    if (!text) return '?';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (CJK_RE.test(ch) || LETTER_RE.test(ch)) return ch.toUpperCase();
    }
    return text.charAt(0).toUpperCase();
  }

  /**
   * 依据名称字符串做稳定哈希，映射到 6 套莫兰迪配色之一
   */
  function pickAvatarPalette(name) {
    var text = String(name || '');
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) % 100000;
    }
    return AVATAR_PALETTES[hash % AVATAR_PALETTES.length];
  }

  /**
   * 生成头像 HTML：有图片直链渲染 <img>，否则渲染首字莫兰迪徽章
   * @param {string} avatarUrl 图片地址（可为空）
   * @param {string} titleOrName 用于取首字与配色的名称
   * @param {string} sizeClass 尺寸样式类，如 'avatar-sm' / 'avatar-md'
   */
  function renderAvatarHtml(avatarUrl, titleOrName, sizeClass) {
    var base = 'chat-avatar' + (sizeClass ? ' ' + sizeClass : '');
    var url = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
    if (url) {
      return (
        '<img class="' + base + '" src="' + escapeHtml(url) + '" alt="" loading="lazy" />'
      );
    }
    var name = titleOrName || '';
    var palette = pickAvatarPalette(name);
    return (
      '<div class="' + base + ' avatar-fallback" style="background:' +
      palette.bg + ';color:' + palette.fg + ';">' +
      escapeHtml(pickAvatarInitial(name)) +
      '</div>'
    );
  }

  // === [ANCHOR: SESSION_LIST_RENDER] 左侧会话列表渲染（收藏夹 + 头像 + 操作按钮） ===

  var sessionDragId = '';
  var sessionDragClickUntil = 0;

  function clearSessionDragStyles() {
    els.sessionList.querySelectorAll('.dragging, .drag-over-top, .drag-over-bottom').forEach(function (row) {
      row.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
    });
  }

  function bindSessionDrag(item, session) {
    item.draggable = true;
    item.addEventListener('dragstart', function (e) {
      if (e.target.closest('button')) { e.preventDefault(); return; }
      sessionDragId = session.id;
      item.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', session.id);
      }
    });
    item.addEventListener('dragover', function (e) {
      var source = getSession(sessionDragId);
      if (!source || source === session || (source.pinned === true) !== (session.pinned === true)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      els.sessionList.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(function (row) {
        row.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      var rect = item.getBoundingClientRect();
      item.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
    });
    item.addEventListener('dragleave', function (e) {
      if (!item.contains(e.relatedTarget)) item.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    item.addEventListener('drop', function (e) {
      var source = getSession(sessionDragId);
      if (!source || source === session || (source.pinned === true) !== (session.pinned === true)) return;
      e.preventDefault();
      e.stopPropagation();
      var rect = item.getBoundingClientRect();
      var after = e.clientY >= rect.top + rect.height / 2;
      // 只替换同分组的数组槽位，不改变收藏属性及另一分组的顺序。
      var group = sessions.filter(function (s) { return (s.pinned === true) === (session.pinned === true); });
      group.splice(group.indexOf(source), 1);
      group.splice(group.indexOf(session) + (after ? 1 : 0), 0, source);
      var cursor = 0;
      sessions.forEach(function (s, i) {
        if ((s.pinned === true) === (session.pinned === true)) sessions[i] = group[cursor++];
      });
      sessionDragId = '';
      sessionDragClickUntil = Date.now() + 350;
      clearSessionDragStyles();
      persistSessions();
      touchLastModified();
      scheduleCloudUpload();
      renderSessionList();
    });
    item.addEventListener('dragend', function () {
      sessionDragId = '';
      sessionDragClickUntil = Date.now() + 350;
      clearSessionDragStyles();
    });
  }

  /**
   * 创建单个会话列表行（含头像、收藏、角色设置、删除按钮）
   */
  function createSessionItem(session) {
    var item = document.createElement('div');
    item.className = 'session-item' + (session.id === currentId ? ' active' : '');
    item.setAttribute('data-id', session.id);
    item.title = session.title || DEFAULT_TITLE;
    bindSessionDrag(item, session);

    // 头像：优先角色头像，其次角色名 / 标题首字
    var avatarWrap = document.createElement('div');
    avatarWrap.className = 'session-avatar-wrap';
    avatarWrap.innerHTML = renderAvatarHtml(
      session.avatar,
      session.charName || session.title || DEFAULT_TITLE,
      'avatar-md'
    );
    item.appendChild(avatarWrap);

    var title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = session.title || DEFAULT_TITLE;
    item.appendChild(title);

    var actions = document.createElement('div');
    actions.className = 'session-item-actions';

    // ① 收藏（星标）切换
    var pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'btn-session-icon btn-pin-session' + (session.pinned ? ' is-pinned' : '');
    pinBtn.setAttribute('data-role', 'pin');
    pinBtn.setAttribute('aria-label', session.pinned ? '取消收藏' : '收藏该对话');
    pinBtn.title = session.pinned ? '取消收藏' : '收藏该对话';
    pinBtn.innerHTML = session.pinned
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.9l6-.8z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.9l6-.8z"/></svg>';

    // ② 角色与对话设置
    var charBtn = document.createElement('button');
    charBtn.type = 'button';
    charBtn.className = 'btn-session-icon btn-char-session';
    charBtn.setAttribute('data-role', 'char');
    charBtn.setAttribute('aria-label', '角色与对话设置');
    charBtn.title = '角色与对话设置';
    charBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.4"/><path d="M4.6 20.2c.7-3.5 3.6-5.6 7.4-5.6s6.7 2.1 7.4 5.6"/></svg>';

    // ③ 删除
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-session-icon btn-del-session';
    delBtn.setAttribute('data-role', 'delete');
    delBtn.setAttribute('aria-label', '删除该对话');
    delBtn.title = '删除该对话';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';

    actions.appendChild(pinBtn);
    actions.appendChild(charBtn);
    actions.appendChild(delBtn);
    item.appendChild(actions);

    return item;
  }

  /**
   * 创建分组标题（收藏夹 / 全部对话，收藏夹可折叠）
   */
  function createSessionGroupHeader(key, label, count, collapsible, collapsed) {
    var head = document.createElement('div');
    head.className = 'session-group-head' + (collapsible ? ' is-collapsible' : '');
    head.setAttribute('data-group', key);
    if (collapsible) head.setAttribute('data-role', 'toggle-group');

    var caret = '';
    if (collapsible) {
      caret =
        '<svg class="session-group-caret' + (collapsed ? ' is-collapsed' : '') +
        '" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M6 9l6 6 6-6"/></svg>';
    }
    head.innerHTML =
      caret +
      '<span class="session-group-label">' + escapeHtml(label) + '</span>' +
      '<span class="session-group-count">' + count + '</span>';
    return head;
  }

  /**
   * 重绘历史会话列表：置顶「收藏夹」分组 +「全部对话」分组
   */
  function renderSessionList() {
    els.sessionList.innerHTML = '';

    var pinnedList = [];
    var normalList = [];
    sessions.forEach(function (session) {
      if (session.pinned === true) pinnedList.push(session);
      else normalList.push(session);
    });

    // ---- 收藏夹分组（有收藏时才渲染） ----
    if (pinnedList.length > 0) {
      els.sessionList.appendChild(
        createSessionGroupHeader('pinned', '收藏夹', pinnedList.length, true, pinnedCollapsed)
      );
      if (!pinnedCollapsed) {
        var pinnedWrap = document.createElement('div');
        pinnedWrap.className = 'session-group-body';
        pinnedList.forEach(function (session) {
          pinnedWrap.appendChild(createSessionItem(session));
        });
        els.sessionList.appendChild(pinnedWrap);
      }
    }

    // ---- 全部对话分组 ----
    els.sessionList.appendChild(
      createSessionGroupHeader('all', '全部对话', normalList.length, false, false)
    );
    var allWrap = document.createElement('div');
    allWrap.className = 'session-group-body';
    normalList.forEach(function (session) {
      allWrap.appendChild(createSessionItem(session));
    });
    els.sessionList.appendChild(allWrap);
  }

  // === [ANCHOR: SESSION_CHAR_MODAL] 角色与对话设置（头像 / 名称 / 开场白 / 导入角色卡） ===
  /* ============ 角色与对话设置弹窗 ============ */

  /**
   * 把本地图片缩放裁切压缩为 128x128 的 Base64 字符串（控制 localStorage 体积）
   * @param {File} file 用户选择的图片文件
   * @param {(dataUrl: string|null) => void} done 回调，失败时传 null
   */
  function compressAvatarFile(file, done) {
    if (!file) {
      done(null);
      return;
    }
    if (!/^image\//.test(file.type || '')) {
      showToast('请选择图片文件');
      done(null);
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () {
      showToast('读取图片失败');
      done(null);
    };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () {
        showToast('图片解析失败，请换一张试试');
        done(null);
      };
      img.onload = function () {
        try {
          var SIZE = 128;
          var canvas = document.createElement('canvas');
          canvas.width = SIZE;
          canvas.height = SIZE;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, SIZE, SIZE);
          // 短边裁切为正方形，再等比缩放，避免头像被拉伸变形
          var srcW = img.naturalWidth || img.width;
          var srcH = img.naturalHeight || img.height;
          if (!srcW || !srcH) throw new Error('图片尺寸异常');
          var side = Math.min(srcW, srcH);
          var sx = (srcW - side) / 2;
          var sy = (srcH - side) / 2;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
          var dataUrl = canvas.toDataURL('image/webp', 0.82);
          if (!dataUrl || dataUrl.indexOf('data:image') !== 0) {
            dataUrl = canvas.toDataURL('image/jpeg', 0.86);
          }
          done(dataUrl);
        } catch (err) {
          showToast('图片压缩失败：' + (err && err.message ? err.message : err));
          done(null);
        }
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  }

  /**
   * 刷新弹窗内的头像预览（实时反映 URL 输入 / 上传草稿）
   */
  function refreshCharModalPreview() {
    var charName = els.scCharNameInput ? els.scCharNameInput.value.trim() : '';
    var userName = els.scUserNameInput ? els.scUserNameInput.value.trim() : '';
    if (els.scCharAvatarPreview) {
      els.scCharAvatarPreview.innerHTML = renderAvatarHtml(
        charAvatarDraft,
        charName || 'AI',
        'avatar-lg'
      );
    }
    if (els.scUserAvatarPreview) {
      els.scUserAvatarPreview.innerHTML = renderAvatarHtml(
        userAvatarDraft,
        userName || '我',
        'avatar-lg'
      );
    }
  }

  /**
   * 打开「角色与对话设置」弹窗，载入目标会话当前值
   * @param {string} sessionId 目标会话 id
   */
  function openSessionCharModal(sessionId) {
    var session = getSession(sessionId);
    if (!session || !els.sessionCharModal) return;
    charModalSessionId = session.id;
    charAvatarDraft = session.avatar || '';
    userAvatarDraft = session.userAvatar || '';

    if (els.scCharAvatarUrl) els.scCharAvatarUrl.value = session.avatar || '';
    if (els.scUserAvatarUrl) els.scUserAvatarUrl.value = session.userAvatar || '';
    if (els.scCharNameInput) els.scCharNameInput.value = session.charName || '';
    if (els.scUserNameInput) els.scUserNameInput.value = session.userName || '';
    if (els.scTitleInput) els.scTitleInput.value = session.title || '';
    if (els.scFirstMessageInput) els.scFirstMessageInput.value = session.firstMessage || '';
    if (els.scCharAvatarFile) els.scCharAvatarFile.value = '';
    if (els.scUserAvatarFile) els.scUserAvatarFile.value = '';

    refreshCharModalPreview();
    els.sessionCharModal.classList.add('show');
    els.sessionCharModal.setAttribute('aria-hidden', 'false');
  }

  /**
   * 关闭弹窗前必须先移走焦点：
   * 若 aria-hidden="true" 的元素内部仍持有焦点，Chrome 会打印
   * 「Blocked aria-hidden on an element because its descendant retained focus」警告
   */
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

  /**
   * 关闭「角色与对话设置」弹窗并丢弃未保存的草稿
   */
  function closeSessionCharModal() {
    if (!els.sessionCharModal) return;
    blurInside(els.sessionCharModal);
    els.sessionCharModal.classList.remove('show');
    els.sessionCharModal.setAttribute('aria-hidden', 'true');
    charModalSessionId = null;
    charAvatarDraft = '';
    userAvatarDraft = '';
  }

  /**
   * 判断会话是否为「尚无用户发言的空对话」（可安全写入开场白）
   */
  function isSessionEmpty(session) {
    if (!session || !Array.isArray(session.messages)) return true;
    return !session.messages.some(function (msg) {
      return msg && msg.role === 'user';
    });
  }

  /**
   * 把角色开场白写入会话 #1 楼（仅在会话无用户发言时允许，避免误删聊天记录）
   * @return {boolean} 是否写入成功
   */
  function applyFirstMessageToSession(session, text) {
    var content = typeof text === 'string' ? text.trim() : '';
    if (!session || !content) return false;
    if (!isSessionEmpty(session)) return false;
    session.messages = [{ role: 'assistant', content: content }];
    session.firstMessage = content;
    session.updatedAt = Date.now();
    return true;
  }

  /**
   * 保存「角色与对话设置」弹窗内容到目标会话
   */
  function saveSessionCharSettings() {
    var session = getSession(charModalSessionId);
    if (!session) {
      closeSessionCharModal();
      return;
    }
    session.avatar = charAvatarDraft || '';
    session.userAvatar = userAvatarDraft || '';
    session.charName = els.scCharNameInput ? els.scCharNameInput.value.trim() : '';
    session.userName = els.scUserNameInput ? els.scUserNameInput.value.trim() : '';

    var nextTitle = els.scTitleInput ? els.scTitleInput.value.trim() : '';
    session.title = nextTitle || session.title || '新对话';

    var firstMessage = els.scFirstMessageInput ? els.scFirstMessageInput.value.trim() : '';
    session.firstMessage = firstMessage;
    // 空对话：保存时自动把开场白写入 #1 楼，省去再点一次按钮
    if (firstMessage && isSessionEmpty(session)) {
      applyFirstMessageToSession(session, firstMessage);
    }

    session.updatedAt = Date.now();
    persistSessions();
    syncActiveSubMessages(session);
    flushSave();
    touchLastModified();

    renderSessionList();
    refreshSessionTitle();
    if (isCurrentSession(session, getActiveSubChatId(session))) renderMessages();
    closeSessionCharModal();
    showToast('角色与对话设置已保存');
  }

  /**
   * 把图片文件切成两段再解 Base64（PNG 角色卡体积较大，避免一次性字符串过长）
   */
  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return window.btoa(binary);
  }

  /**
   * 从 PNG 角色卡中提取内嵌的 JSON 数据（SillyTavern tEXt 块 chara / ccv3）
   * @param {ArrayBuffer} buffer PNG 原始字节
   * @return {object|null} 解析出的角色卡对象
   */
  function extractCharcardFromPng(buffer) {
    try {
      var bytes = new Uint8Array(buffer);
      var signature = [137, 80, 78, 71, 13, 10, 26, 10];
      for (var s = 0; s < signature.length; s++) {
        if (bytes[s] !== signature[s]) return null;
      }
      var pos = 8;
      var decoder = new TextDecoder('utf-8');
      while (pos + 8 <= bytes.length) {
        var length =
          (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
        length = length >>> 0;
        var type = String.fromCharCode(
          bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]
        );
        var dataStart = pos + 8;
        if (dataStart + length > bytes.length) break;
        if (type === 'tEXt') {
          var chunk = bytes.subarray(dataStart, dataStart + length);
          var zero = chunk.indexOf(0);
          if (zero > 0) {
            var keyword = decoder.decode(chunk.subarray(0, zero));
            if (keyword === 'chara' || keyword === 'ccv3') {
              var b64 = decoder.decode(chunk.subarray(zero + 1));
              var json = safeJsonParse(base64ToUtf8(b64));
              if (json && typeof json === 'object') return json;
            }
          }
        }
        if (type === 'IEND') break;
        pos = dataStart + length + 4; // 跳过内容与 CRC
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  /**
   * 把角色卡对象（Tavern / Character Card V2 结构）应用到当前会话
   */
  function applyCharcardToSession(card) {
    if (!card || typeof card !== 'object') return false;
    var session = getCurrentSession();
    if (!session) return false;

    // 兼容 V2 规范的 data 嵌套与旧版平铺结构
    var data = card.data && typeof card.data === 'object' ? card.data : card;
    var name = typeof data.name === 'string' ? data.name.trim() : '';
    var description = typeof data.description === 'string' ? data.description.trim() : '';
    var personality = typeof data.personality === 'string' ? data.personality.trim() : '';
    var scenario = typeof data.scenario === 'string' ? data.scenario.trim() : '';
    var firstMes =
      typeof data.first_mes === 'string'
        ? data.first_mes
        : typeof data.firstMessage === 'string'
          ? data.firstMessage
          : '';
    var userPersona = data.user_name || data.userName || '';

    if (!name && !description && !firstMes) {
      showToast('该角色卡没有可用的角色信息');
      return false;
    }

    if (name) {
      session.charName = name;
      session.title = name;
    }
    if (userPersona && typeof userPersona === 'string') session.userName = userPersona;

    var firstMessage = String(firstMes || '').trim();
    session.firstMessage = firstMessage;

    // 角色卡基础设定直接落到会话字段：
    // 发送请求时由宿主统一合并进系统提示词（不再塞进预设小模块，避免与预设重叠重复）
    session.charDescription = description;
    session.charPersonality = personality;
    session.charScenario = scenario;
    session.charSystemPrompt =
      typeof data.system_prompt === 'string' ? data.system_prompt.trim() : '';
    session.charPostHistory =
      typeof data.post_history_instructions === 'string'
        ? data.post_history_instructions.trim()
        : '';
    session.charMesExample =
      typeof data.mes_example === 'string' ? data.mes_example.trim() : '';
    session.alternateGreetings = Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.filter(function (g) {
          return typeof g === 'string' && g.trim();
        })
      : [];

    // 空对话时自动把开场白写入 #1 楼
    if (firstMessage && isSessionEmpty(session)) {
      applyFirstMessageToSession(session, firstMessage);
    }

    session.updatedAt = Date.now();
    persistSessions();
    syncActiveSubMessages(session);
    flushSave();
    touchLastModified();
    renderSessionList();
    refreshPresetButtonState();
    refreshTopPresetUI();
    renderMessages();
    showToast('角色卡已导入：' + (name || '未命名角色'));
    return true;
  }

  /**
   * 弹出文件选择框，导入角色卡（PNG 内嵌卡 / JSON 卡）
   */
  function importCharcardFlow() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.json,image/png,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) {
        document.body.removeChild(input);
        return;
      }
      var isJson = /\.json$/i.test(file.name) || /json/i.test(file.type || '');
      var reader = new FileReader();
      reader.onerror = function () {
        showToast('读取角色卡文件失败');
      };
      reader.onload = function () {
        try {
          if (isJson) {
            var text = String(reader.result || '');
            var json = safeJsonParse(text);
            applyCharcardToSession(json);
          } else {
            var card = extractCharcardFromPng(reader.result);
            if (!card) {
              showToast('未在该 PNG 中找到角色卡数据，请改用 JSON 格式角色卡');
            } else {
              applyCharcardToSession(card);
            }
          }
        } catch (err) {
          showToast('导入角色卡失败：' + (err && err.message ? err.message : err));
        }
      };
      if (isJson) reader.readAsText(file, 'utf-8');
      else reader.readAsArrayBuffer(file);
    });
    input.click();
  }

  /**
   * 是否为手机端（与 style.css 中的 768px 断点保持一致）
   */
  function isMobileView() {
    return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
  }

  /**
   * 展开抽屉式侧边栏（仅手机端有视觉效果）
   */
  function openSidebar() {
    els.sidebar.classList.add('open');
    els.sidebarMask.classList.add('show');
  }

  /**
   * 收起抽屉式侧边栏
   */
  function closeSidebar() {
    els.sidebar.classList.remove('open');
    els.sidebarMask.classList.remove('show');
  }

  // === [ANCHOR: MSG_ACTIONS_EDIT] 单条消息操作栏与原位编辑模式 ===
  /* ================= 消息渲染 ================= */

  /**
   * 创建空会话提示元素
   */
  function createEmptyTip() {
    var box = document.createElement('div');
    box.id = 'empty-tip';
    box.className = 'empty-tip';

    var title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = '开始新的对话';

    var desc = document.createElement('p');
    desc.className = 'empty-desc';
    desc.innerHTML =
      '先点击右上角【设置】填写 API 接口地址与 API Key，<br />然后在下方的输入框里提问吧。<br />点击左上角【+ 新建对话】可随时开启新话题。';

    box.appendChild(title);
    box.appendChild(desc);
    return box;
  }

  /**
   * 该消息是否需要出现在界面上（流式过程中的空 AI 占位不渲染）
   * 注意：只用于「是否渲染」判断，绝不改变数组中的真实索引
   */
  function isMessageVisible(msg) {
    if (!msg) return false;
    if (msg.role !== 'assistant') return true;
    // 请求进行中的占位气泡（非流式等待完整响应时）必须保持可见
    if (msg._pending === true) return true;
    var hasContent = typeof msg.content === 'string' && msg.content.length > 0;
    var hasReasoning = typeof msg.reasoning === 'string' && msg.reasoning.length > 0;
    return hasContent || hasReasoning;
  }

  /**
   * 当前设备是否支持鼠标悬浮（PC / 带触控板的设备）
   */
  function hasHoverDevice() {
    return !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
  }

  /**
   * 按真实索引在当前聊天区查找对应的消息行
   */
  function findMessageRow(index) {
    if (!els.chatArea) return null;
    return els.chatArea.querySelector('.msg[data-index="' + index + '"]');
  }

  /**
   * 操作栏纯矢量 SVG 图标库（14x14，描边风格，随按钮文字色变化）
   * 全部为内联字符串，严禁使用 Emoji 或文字
   */
  var ACTION_ICONS = {
    copy:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="9" y="9" width="12" height="12" rx="2"></rect>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
      '</svg>',
    copied:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="20 6 9 17 4 12"></polyline>' +
      '</svg>',
    edit:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 20h9"></path>' +
      '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"></path>' +
      '</svg>',
    regen:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="1 4 1 10 7 10"></polyline>' +
      '<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>' +
      '</svg>',
    'swipe-prev':
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="15 18 9 12 15 6"></polyline>' +
      '</svg>',
    'swipe-next':
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="9 18 15 12 9 6"></polyline>' +
      '</svg>',
    delete:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="3 6 5 6 21 6"></polyline>' +
      '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
      '</svg>'
  };

  /**
   * 构建气泡底部操作栏：复制 / 修改 / 重新回复 / 删除（纯 SVG 图标）
   * 若为带多分支的 assistant 消息，右侧追加 < 1/2 > 分支切换器
   * 索引与 session.messages 严格一一对应
   */
  function buildActionsBar(index) {
    var bar = document.createElement('div');
    bar.className = 'msg-actions';

    var defs = [
      { roleName: 'copy', title: '复制这条消息的正文' },
      { roleName: 'edit', title: '原位编辑这条消息' },
      { roleName: 'regen', title: '基于这条消息重新请求 AI 回答（保留旧回复为分支）' },
      { roleName: 'delete', title: '删除这条消息' }
    ];

    defs.forEach(function (def) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'msg-action-btn';
      btn.setAttribute('data-role', def.roleName);
      btn.setAttribute('data-index', String(index));
      btn.title = def.title;
      btn.setAttribute('aria-label', def.title);
      // 纯矢量 SVG：绝不使用文字或 Emoji
      btn.innerHTML = ACTION_ICONS[def.roleName] || '';
      // 流式输出进行中禁用「重新回复」，避免并发请求
      if (def.roleName === 'regen' && isCurrentActiveChannelGenerating()) btn.disabled = true;
      bar.appendChild(btn);
    });

    // ---- 多分支切换器 < 1/2 >（仅 assistant 且分支数 > 1） ----
    var session = getCurrentSession();
    var msg = session && Array.isArray(session.messages) ? session.messages[index] : null;
    if (msg && msg.role === 'assistant' && Array.isArray(msg.swipes) && msg.swipes.length > 1) {
      var swipeIndex = normalizeSwipeIndex(msg);
      var nav = document.createElement('div');
      nav.className = 'msg-swipe-nav';

      var prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'msg-swipe-btn';
      prevBtn.setAttribute('data-role', 'swipe-prev');
      prevBtn.setAttribute('data-index', String(index));
      prevBtn.title = '上一分支';
      prevBtn.setAttribute('aria-label', '上一分支');
      prevBtn.innerHTML = ACTION_ICONS['swipe-prev'];
      if (swipeIndex <= 0 || isCurrentActiveChannelGenerating()) prevBtn.disabled = true;

      var countEl = document.createElement('span');
      countEl.className = 'msg-swipe-count';
      countEl.textContent = (swipeIndex + 1) + ' / ' + msg.swipes.length;

      var nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'msg-swipe-btn';
      nextBtn.setAttribute('data-role', 'swipe-next');
      nextBtn.setAttribute('data-index', String(index));
      nextBtn.title = '下一分支';
      nextBtn.setAttribute('aria-label', '下一分支');
      nextBtn.innerHTML = ACTION_ICONS['swipe-next'];
      if (swipeIndex >= msg.swipes.length - 1 || isCurrentActiveChannelGenerating()) nextBtn.disabled = true;

      nav.appendChild(prevBtn);
      nav.appendChild(countEl);
      nav.appendChild(nextBtn);
      bar.appendChild(nav);
    }

    return bar;
  }

  /**
   * 规范化 swipeIndex：越界 / 非法值一律回落到 0
   */
  function normalizeSwipeIndex(msg) {
    if (!msg || !Array.isArray(msg.swipes) || !msg.swipes.length) return 0;
    var idx = typeof msg.swipeIndex === 'number' && isFinite(msg.swipeIndex) ? Math.round(msg.swipeIndex) : 0;
    if (idx < 0) idx = 0;
    if (idx > msg.swipes.length - 1) idx = msg.swipes.length - 1;
    return idx;
  }

  /**
   * 把「当前分支」写回顶层 content / reasoning，保证渲染 / 导出 / 正则 / buildApiMessages 全部 100% 兼容
   */
  function applySwipeToMessage(msg) {
    if (!msg || !Array.isArray(msg.swipes) || !msg.swipes.length) return;
    var idx = normalizeSwipeIndex(msg);
    msg.swipeIndex = idx;
    var branch = msg.swipes[idx] || {};
    msg.content = typeof branch.content === 'string' ? branch.content : '';
    var branchReasoning = typeof branch.reasoning === 'string' ? branch.reasoning : '';
    if (branchReasoning) {
      msg.reasoning = branchReasoning;
    } else {
      delete msg.reasoning;
    }
  }

  /**
   * 切换分支：更新 swipeIndex → 同步顶层字段 → 落盘 → 原位重绘该楼层 + 刷新 Token 计数
   */
  function switchMessageSwipe(index, delta) {
    var session = getCurrentSession();
    if (!session || isCurrentActiveChannelGenerating()) return;
    var msg = session.messages[index];
    if (!msg || !Array.isArray(msg.swipes) || msg.swipes.length < 2) return;

    var next = normalizeSwipeIndex(msg) + (delta < 0 ? -1 : 1);
    if (next < 0 || next > msg.swipes.length - 1) return;

    msg.swipeIndex = next;
    applySwipeToMessage(msg);
    session.updatedAt = Date.now();
    persistSessions();
    touchLastModified();
    scheduleCloudUpload();

    // 原位重绘该楼层气泡（重新执行 Markdown 渲染与 HTML 状态栏沙盒挂载）
    try {
      refreshMessageRow(index);
    } catch (err) {
      console.warn('[分支切换] 楼层重绘失败：', err);
    }
    // 分支切换会改变上下文 Token 占用，通知记忆模块刷新实时计数
    try {
      if (window.MemorySummaryModule && typeof window.MemorySummaryModule.refreshTokenMeter === 'function') {
        window.MemorySummaryModule.refreshTokenMeter();
      }
    } catch (ignoreErr) {
      /* 模块未加载时忽略 */
    }
  }

  /**
   * 构建消息气泡右上角扩展工具（单色 SVG 图标 + 自适应菜单）
   * 首个功能：从该楼层建立分支（深拷贝 #1 ~ #N 全部消息到新的内部对话）
   * 索引与 session.messages 严格一一对应，楼层号 = index + 1
   */
  function buildCornerTool(bubble, index) {
    var wrap = document.createElement('div');
    wrap.className = 'msg-corner';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'msg-corner-tool-btn';
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.title = '更多工具';

    // 单色 SVG：三点竖向省略号，随按钮文字色变化
    var dotSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    dotSvg.setAttribute('viewBox', '0 0 24 24');
    dotSvg.setAttribute('width', '14');
    dotSvg.setAttribute('height', '14');
    dotSvg.setAttribute('fill', 'none');
    dotSvg.setAttribute('stroke', 'currentColor');
    dotSvg.setAttribute('stroke-width', '2');
    dotSvg.setAttribute('stroke-linecap', 'round');
    dotSvg.setAttribute('aria-hidden', 'true');
    [
      ['line', { x1: '12', y1: '5', x2: '12', y2: '5.01' }],
      ['line', { x1: '12', y1: '12', x2: '12', y2: '12.01' }],
      ['line', { x1: '12', y1: '19', x2: '12', y2: '19.01' }]
    ].forEach(function (def) {
      var el = document.createElementNS('http://www.w3.org/2000/svg', def[0]);
      Object.keys(def[1]).forEach(function (key) {
        el.setAttribute(key, def[1][key]);
      });
      dotSvg.appendChild(el);
    });
    trigger.appendChild(dotSvg);

    var menu = document.createElement('div');
    menu.className = 'msg-corner-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    // 菜单项：建立分支（单色 SVG 分支图标 + 文字）
    var branchBtn = document.createElement('button');
    branchBtn.type = 'button';
    branchBtn.className = 'msg-corner-item';
    branchBtn.setAttribute('role', 'menuitem');
    branchBtn.setAttribute('data-corner-role', 'branch');
    branchBtn.setAttribute('data-index', String(index));
    branchBtn.title = '把 #1 到 #' + (index + 1) + ' 楼复制到一个新的内部对话';

    var branchSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    branchSvg.setAttribute('viewBox', '0 0 24 24');
    branchSvg.setAttribute('width', '15');
    branchSvg.setAttribute('height', '15');
    branchSvg.setAttribute('fill', 'none');
    branchSvg.setAttribute('stroke', 'currentColor');
    branchSvg.setAttribute('stroke-width', '1.8');
    branchSvg.setAttribute('stroke-linecap', 'round');
    branchSvg.setAttribute('stroke-linejoin', 'round');
    branchSvg.setAttribute('aria-hidden', 'true');
    [
      ['circle', { cx: '6.5', cy: '6', r: '2.2' }],
      ['circle', { cx: '6.5', cy: '18', r: '2.2' }],
      ['circle', { cx: '17.5', cy: '12', r: '2.2' }],
      ['path', { d: 'M6.5 8.2v7.6' }],
      ['path', { d: 'M8.7 6h4.3a2.3 2.3 0 0 1 2.3 2.3v1.5' }]
    ].forEach(function (def) {
      var el = document.createElementNS('http://www.w3.org/2000/svg', def[0]);
      Object.keys(def[1]).forEach(function (key) {
        el.setAttribute(key, def[1][key]);
      });
      branchSvg.appendChild(el);
    });

    var branchLabel = document.createElement('span');
    branchLabel.textContent = '建立分支';

    branchBtn.appendChild(branchSvg);
    branchBtn.appendChild(branchLabel);
    menu.appendChild(branchBtn);

    trigger.addEventListener('click', function (event) {
      event.stopPropagation();
      var willOpen = menu.hidden;
      closeAllCornerMenus();
      if (willOpen) {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
    });

    branchBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      closeAllCornerMenus();
      createBranchFromFloor(Number(branchBtn.getAttribute('data-index')));
    });

    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    bubble.appendChild(wrap);

    return wrap;
  }

  /**
   * 收起页面上所有消息角落菜单（点击外部 / 打开另一个菜单时调用）
   */
  function closeAllCornerMenus() {
    if (!els.chatArea) return;
    var menus = els.chatArea.querySelectorAll('.msg-corner-menu');
    for (var i = 0; i < menus.length; i++) {
      if (!menus[i].hidden) menus[i].hidden = true;
    }
    var triggers = els.chatArea.querySelectorAll('.msg-corner-tool-btn[aria-expanded="true"]');
    for (var j = 0; j < triggers.length; j++) {
      triggers[j].setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * 从指定楼层建立分支：深拷贝 #1 ~ #N 楼消息到新的内部对话并切换过去
   * @param {number} index 消息在 session.messages 中的真实索引（楼层号 = index + 1）
   */
  function createBranchFromFloor(index) {
    var session = getCurrentSession();
    if (!session) return;
    if (!Array.isArray(session.messages) || index < 0 || index >= session.messages.length) return;

    captureInputDraft();
    ensureSessionSubChats(session);

    var floorNum = index + 1;
    // 深拷贝，绝不与源子对话共享消息对象引用
    var copiedMessages = JSON.parse(JSON.stringify(session.messages.slice(0, index + 1)));
    var sourceSub = getActiveSubChat(session);
    var sourceMemory = sourceSub && sourceSub.memoryData;
    var snapshots = sourceMemory && Array.isArray(sourceMemory.snapshots) ? sourceMemory.snapshots : [];
    var snapshot = snapshots.filter(function (item) { return item.cursor <= floorNum; })
      .sort(function (a, b) { return b.cursor - a.cursor || b.timestamp - a.timestamp; })[0];
    var branchMemory = createEmptyMemoryData();
    if (snapshot) {
      branchMemory.summarizedFloorCursor = snapshot.cursor;
      branchMemory.lastSummaryAt = snapshot.timestamp;
      branchMemory.overviewEntry = JSON.parse(JSON.stringify(snapshot.overviewEntry || branchMemory.overviewEntry));
      branchMemory.overviewEntry.content = snapshot.overviewContent || '';
      branchMemory.eventEntries = JSON.parse(JSON.stringify(snapshot.eventEntries || []));
      branchMemory.snapshots = JSON.parse(JSON.stringify(snapshots.filter(function (item) { return item.cursor <= snapshot.cursor; })));
    }

    var newSub = {
      id: genSubChatId(),
      title: '分支 · 自 #' + floorNum + ' 楼',
      updatedAt: Date.now(),
      branchFloor: floorNum,
      memoryData: branchMemory,
      messages: copiedMessages
    };

    session.subChats.push(newSub);
    session.activeSubChatId = newSub.id;
    // session.messages 与激活子对话保持一致
    session.messages = newSub.messages;

    session.updatedAt = Date.now();
    flushSave();
    touchLastModified();
    renderSessionList();
    renderMessages();
    refreshQuickParamsPanel();
    refreshPresetButtonState();
    scheduleCloudUpload();

    refreshMemoryContext();
    if (subchatModalOpen) renderSubChatList();
    setSyncStatus('idle');
    showToast('已从 #' + floorNum + ' 楼建立新分支并切换');
  }

  /**
   * 轻量操作反馈提示（纯文字，不用彩色 Emoji）
   */
  var toastTimer = null;
  function showToast(text) {
    var node = document.getElementById('mychat-toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'mychat-toast';
      node.className = 'mychat-toast';
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.remove('show');
    }, 2000);
  }

  /**
   * 渲染用户消息正文（包一层 .msg-text，便于原位编辑时整体替换）
   * 显示前依次经过：宏变量替换 → onRender 阀门（正则 targets 含 user 时才命中）
   * 用户消息始终按纯文本显示，绝不解析 HTML，避免自伤
   */
  function renderUserBubble(bubble, msg, session) {
    if (!bubble._textBody) {
      var body = document.createElement('div');
      body.className = 'msg-text';
      bubble.appendChild(body);
      bubble._textBody = body;
    }
    var ctxSession = session || getCurrentSession();
    var text = (msg && msg.content) || '';
    // 宏替换：{{char}} / {{user}} / <BOT> / <USER>
    text = replaceMacros(text, ctxSession);
    // onRender 阀门：仅当规则 targets 命中 user 才会被改动
    var piped = runPipeline('onRender', text, { role: 'user', session: ctxSession });
    if (typeof piped === 'string') text = piped;
    bubble._textBody.textContent = text;
    if (window.MyChatAttachments) window.MyChatAttachments.renderSent(bubble, msg);
  }

  /**
   * 生成消息底部统计小字栏文本
   * - 用户消息：仅显示发送时刻 04:35
   * - AI 消息：模型标识 · 总 Token · 缓存 · 输出 · 耗时 · 时刻
   * 历史旧消息缺少 meta 时平滑降级，只显示已知字段，绝不报错
   */
  function buildMetaText(msg) {
    if (!msg) return '';
    var meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : null;

    if (msg.role === 'user') {
      return meta && meta.timeStr ? String(meta.timeStr) : '';
    }

    var parts = [];
    var modelId = meta && meta.modelId ? String(meta.modelId) : '';
    var alias = meta && meta.modelAlias ? String(meta.modelAlias) : '';

    if (modelId) {
      // 别名与真实 ID 不同时才额外展示真实 ID，避免重复啰嗦
      parts.push(alias && alias !== modelId ? alias + ' (' + modelId + ')' : modelId);
    } else if (alias) {
      parts.push(alias);
    }

    var hasNum = function (v) {
      return typeof v === 'number' && isFinite(v);
    };

    // 人民币花费固定插在 tokens 项的正前方
    if (meta && meta.costText) parts.push(String(meta.costText));
    if (meta && (hasNum(meta.inputTokens) || hasNum(meta.totalTokens))) {
      var inputTokens = hasNum(meta.inputTokens) ? meta.inputTokens : Math.max(0, meta.totalTokens - (Number(meta.outputTokens) || 0));
      parts.push(inputTokens + ' tokens');
    }
    if (meta && hasNum(meta.cachedTokens)) parts.push(meta.cachedTokens + ' cached');
    if (meta && hasNum(meta.outputTokens)) parts.push(meta.outputTokens + ' output');
    if (meta && meta.durationSec) parts.push(meta.durationSec + 's');
    if (meta && meta.timeStr) parts.push(String(meta.timeStr));

    return parts.join(' · ');
  }

  /**
   * 归一化世界书触发记录：兼容旧版「词条名字符串数组」与新版「明细对象数组」
   */
  function normalizeWbTriggeredList(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (item) {
      if (typeof item === 'string') {
        if (!item) return;
        out.push({
          bookName: '',
          entryName: item,
          matchedKey: '',
          position: '',
          depth: 0,
          content: ''
        });
        return;
      }
      if (item && typeof item === 'object') {
        out.push({
          bookName: typeof item.bookName === 'string' ? item.bookName : '',
          entryName: typeof item.entryName === 'string' ? item.entryName : '',
          matchedKey: typeof item.matchedKey === 'string' ? item.matchedKey : '',
          position: typeof item.position === 'string' ? item.position : '',
          depth: typeof item.depth === 'number' && isFinite(item.depth) ? item.depth : 0,
          content: typeof item.content === 'string' ? item.content : ''
        });
      }
    });
    return out;
  }

  /**
   * 世界书词条注入位置的中文描述
   */
  function wbPositionLabel(item) {
    if (!item || !item.position) return '未知位置';
    if (item.position === 'before_system') return '#0 之前';
    if (item.position === 'after_system') return '#0 之后';
    return '@Depth ' + item.depth;
  }

  /**
   * 构建消息底部统计小字栏元素；无可展示内容时返回 null
   * 若该条 AI 消息本轮触发了世界书词条，额外渲染可点击的「已触发世界书: N 条」标签
   * @param {object} msg 消息对象
   * @param {number} [msgIndex] 该消息在 session.messages 中的真实下标（用于打开明细弹窗）
   */
  function buildMetaBar(msg, msgIndex) {
    var text = buildMetaText(msg);
    var meta = msg && msg.meta && typeof msg.meta === 'object' ? msg.meta : null;
    var wbList = normalizeWbTriggeredList(meta ? meta.triggeredWorldbooks : null);

    if (!text && wbList.length === 0) return null;

    var bar = document.createElement('div');
    bar.className = 'msg-meta';

    if (text) {
      var textEl = document.createElement('span');
      textEl.className = 'msg-meta-text';
      textEl.textContent = text;
      textEl.title = text;
      bar.appendChild(textEl);
    }

    if (wbList.length > 0) {
      var wbBadge = document.createElement('button');
      wbBadge.type = 'button';
      wbBadge.className = 'wb-trigger-badge';
      wbBadge.textContent = '已触发世界书: ' + wbList.length + ' 条 ▾';
      wbBadge.title = '点击查看本轮命中的世界书词条明细';
      if (typeof msgIndex === 'number') wbBadge.setAttribute('data-msg-index', String(msgIndex));
      bar.appendChild(wbBadge);
    }

    return bar;
  }

  // === [ANCHOR: WB_TRIGGER_DETAIL] 世界书触发明细弹窗 ===

  /**
   * 打开世界书触发明细弹窗
   * @param {number} msgIndex 消息在 session.messages 中的真实下标
   */
  function openWbTriggeredDetail(msgIndex) {
    if (!els.wbDetailModal || !els.wbDetailList) return;
    var session = getCurrentSession();
    var msg = session && session.messages[msgIndex];
    var meta = msg && msg.meta && typeof msg.meta === 'object' ? msg.meta : null;
    var list = normalizeWbTriggeredList(meta ? meta.triggeredWorldbooks : null);

    els.wbDetailList.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'wb-detail-empty';
      empty.textContent = '本轮没有通过关键词命中的世界书词条（常驻条目不计入统计）。';
      els.wbDetailList.appendChild(empty);
    }

    list.forEach(function (item, idx) {
      var card = document.createElement('div');
      card.className = 'wb-detail-item';
      card.setAttribute('data-detail-index', String(idx));

      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'wb-detail-head';
      head.setAttribute('data-role', 'toggle-detail');

      var titleWrap = document.createElement('div');
      titleWrap.className = 'wb-detail-title-wrap';

      var title = document.createElement('span');
      title.className = 'wb-detail-title';
      title.textContent =
        (item.bookName ? '[' + item.bookName + '] ' : '') + (item.entryName || '未命名词条');
      titleWrap.appendChild(title);

      var subParts = [];
      if (item.matchedKey) subParts.push('命中词：' + item.matchedKey);
      subParts.push('注入位置：' + wbPositionLabel(item));
      var sub = document.createElement('span');
      sub.className = 'wb-detail-sub-line';
      sub.textContent = subParts.join(' · ');
      titleWrap.appendChild(sub);

      var caret = document.createElement('span');
      caret.className = 'wb-detail-caret';
      caret.textContent = '▾';

      head.appendChild(titleWrap);
      head.appendChild(caret);

      var body = document.createElement('div');
      body.className = 'wb-detail-content';
      body.textContent = item.content || '（该词条内容为空）';

      card.appendChild(head);
      card.appendChild(body);
      els.wbDetailList.appendChild(card);
    });

    if (els.wbDetailSub) {
      els.wbDetailSub.textContent = list.length
        ? '本轮共命中 ' + list.length + ' 条关键词词条，点击条目可展开注入内容（常驻条目不计入统计）'
        : '本轮没有通过关键词命中的词条（常驻条目不计入统计）';
    }
    if (els.wbDetailFoot) {
      els.wbDetailFoot.textContent = list.length ? '共 ' + list.length + ' 条' : '无命中词条';
    }

    els.wbDetailModal.classList.add('show');
    els.wbDetailModal.setAttribute('aria-hidden', 'false');
  }

  /**
   * 关闭世界书触发明细弹窗
   */
  function closeWbTriggeredDetail() {
    if (!els.wbDetailModal) return;
    blurInside(els.wbDetailModal);
    els.wbDetailModal.classList.remove('show');
    els.wbDetailModal.setAttribute('aria-hidden', 'true');
  }

  /**
   * 构建一整条消息行（含操作栏与统计栏），索引写入 data-index 供操作逻辑定位
   */
  function createMessageRow(msg, index) {
    var session = getCurrentSession();
    var row = document.createElement('div');
    row.className = 'msg ' + (msg.role === 'user' ? 'msg-user' : 'msg-ai');
    row._message = msg;
    row._renderStamp = messageRenderStamp(msg);
    row.setAttribute('data-index', String(index));
    row.setAttribute('data-role', msg.role);

    // 楼层标号：数组下标 + 1（#0 保留给系统提示词层）
    var floorNum = index + 1;
    row.setAttribute('data-floor', String(floorNum));
    row.setAttribute('data-msg-index', String(index));

    // 头像 + 气泡 + 名称的水平容器（用户消息头像在右侧）
    var line = document.createElement('div');
    line.className = 'msg-line';

    var avatarHtml = buildMessageAvatarHtml(session, msg);

    var avatarEl = document.createElement('div');
    avatarEl.className = 'msg-avatar';
    avatarEl.innerHTML = avatarHtml;

    var mainWrap = document.createElement('div');
    mainWrap.className = 'msg-main';

    // 气泡上方的发言人名称
    var nameText = buildMessageNameText(session, msg);
    if (nameText) {
      var nameEl = document.createElement('div');
      nameEl.className = 'msg-speaker';
      nameEl.textContent = nameText;
      mainWrap.appendChild(nameEl);
    }

    var bubble = document.createElement('div');
    bubble.className = 'bubble';

    // 楼层徽章置于气泡内容最顶部
    var floorBadge = document.createElement('span');
    floorBadge.className = 'msg-floor-badge';
    floorBadge.textContent = '#' + floorNum;
    floorBadge.title = '第 ' + floorNum + ' 层';
    bubble.appendChild(floorBadge);

    if (msg.role === 'user') {
      renderUserBubble(bubble, msg);
    } else {
      renderAssistantBubble(bubble, msg, false);
    }

    // 操作栏固定在气泡内容最底部
    bubble.appendChild(buildActionsBar(index));

    // 气泡右上角扩展工具（复制 / 编辑等原有操作栏保持完全不变）
    buildCornerTool(bubble, index);

    mainWrap.appendChild(bubble);

    if (msg.role === 'user') {
      line.appendChild(mainWrap);
      line.appendChild(avatarEl);
    } else {
      line.appendChild(avatarEl);
      line.appendChild(mainWrap);
    }
    row.appendChild(line);

    // 统计小字栏位于气泡下方，默认常驻显示（传入真实下标以支持世界书明细弹窗）
    var metaBar = buildMetaBar(msg, index);
    if (metaBar) row.appendChild(metaBar);

    return row;
  }

  /**
   * 消息头像 HTML（AI 用角色头像，用户用用户头像；缺省则为名称首字徽章）
   */
  function buildMessageAvatarHtml(session, msg) {
    if (!msg) return '';
    if (msg.role === 'user') {
      var userName = (session && session.userName) || '我';
      return renderAvatarHtml(session ? session.userAvatar : '', userName, 'avatar-md');
    }
    var charName = (session && session.charName) || 'AI';
    return renderAvatarHtml(session ? session.avatar : '', charName, 'avatar-md');
  }

  /**
   * 消息发言人名称文本（无角色设置时返回空字符串，保持界面极简）
   */
  function buildMessageNameText(session, msg) {
    if (!msg) return '';
    if (msg.role === 'user') return (session && session.userName) || '';
    return (session && session.charName) || '';
  }

  /**
   * 局部刷新单条消息：用最新数据重建该行（编辑保存 / 取消后调用）
   */
  function refreshMessageRow(index) {
    var session = getCurrentSession();
    var msg = session && session.messages[index];
    var row = findMessageRow(index);
    if (!msg || !row || !row.parentNode) return;
    var top = els.chatArea.scrollTop;
    els.chatArea._holdScroll = true;
    if (els.chatArea._messageResizeObserver) els.chatArea._messageResizeObserver.unobserve(row);
    var replacement = createMessageRow(msg, index);
    row.parentNode.replaceChild(replacement, row);
    bindRenderedMessage(replacement, session, msg);
    els.chatArea.scrollTop = top;
  }

  /**
   * 构建 #0 系统提示词层节点
   * - 始终位于聊天流最顶部，随内容自然滚动（绝不 sticky 吸顶）
   * - 内容来自当前会话绑定预设下「已开启且非空」的模块拼接结果
   */
  function createSystemFloorRow(session) {
    var preset = session ? getPresetById(session.presetId) : null;
    var enabledCount = 0;
    if (preset && Array.isArray(preset.modules)) {
      preset.modules.forEach(function (mod) {
        if (!mod || mod.enabled !== true) return;
        if (typeof mod.content !== 'string' || !mod.content.trim()) return;
        enabledCount++;
      });
    }
    var promptText = preset ? buildPresetSystemPrompt(preset) : '';

    var row = document.createElement('div');
    row.className = 'msg-row system-floor-row';
    row.setAttribute('data-floor', '0');

    var card = document.createElement('div');
    card.className = 'system-floor-card';

    var head = document.createElement('div');
    head.className = 'system-floor-head';

    var badge = document.createElement('span');
    badge.className = 'msg-floor-badge';
    badge.textContent = '#0';
    badge.title = '第 0 层：系统提示词';

    // 专属单色 SVG 图标（终端 / 指令芯片线条），严禁使用彩色 Emoji
    var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'system-floor-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '15');
    icon.setAttribute('height', '15');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.8');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    [
      ['rect', { x: '6.5', y: '6.5', width: '11', height: '11', rx: '2.4' }],
      ['rect', { x: '10', y: '10', width: '4', height: '4', rx: '1' }],
      ['line', { x1: '9.5', y1: '3.5', x2: '9.5', y2: '6.5' }],
      ['line', { x1: '14.5', y1: '3.5', x2: '14.5', y2: '6.5' }],
      ['line', { x1: '9.5', y1: '17.5', x2: '9.5', y2: '20.5' }],
      ['line', { x1: '14.5', y1: '17.5', x2: '14.5', y2: '20.5' }],
      ['line', { x1: '3.5', y1: '9.5', x2: '6.5', y2: '9.5' }],
      ['line', { x1: '3.5', y1: '14.5', x2: '6.5', y2: '14.5' }],
      ['line', { x1: '17.5', y1: '9.5', x2: '20.5', y2: '9.5' }],
      ['line', { x1: '17.5', y1: '14.5', x2: '20.5', y2: '14.5' }]
    ].forEach(function (def) {
      var el = document.createElementNS('http://www.w3.org/2000/svg', def[0]);
      Object.keys(def[1]).forEach(function (key) {
        el.setAttribute(key, def[1][key]);
      });
      icon.appendChild(el);
    });

    var title = document.createElement('span');
    title.className = 'system-floor-title';
    if (preset) {
      title.textContent =
        '系统提示词 · ' + (preset.name || '未命名预设') + '（已启用 ' + enabledCount + ' 个模块）';
    } else {
      title.textContent = '系统提示词 · 未启用预设';
    }

    var actions = document.createElement('div');
    actions.className = 'system-floor-actions';

    // 展开 / 收起内容：仅在「已启用预设且拼接结果非空」时出现
    var preview = null;
    if (preset && promptText) {
      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'system-floor-btn';
      toggleBtn.setAttribute('data-role', 'toggle-preview');
      preview = document.createElement('div');
      preview.className = 'system-floor-preview';
      preview.textContent = promptText;
      preview.hidden = !systemFloorExpanded;

      toggleBtn.textContent = systemFloorExpanded ? '收起内容' : '展开内容';
      toggleBtn.addEventListener('click', function () {
        systemFloorExpanded = !systemFloorExpanded;
        preview.hidden = !systemFloorExpanded;
        toggleBtn.textContent = systemFloorExpanded ? '收起内容' : '展开内容';
        // 展开后让用户能立刻看到预览内容
        if (systemFloorExpanded && preview.scrollIntoView) {
          preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
      actions.appendChild(toggleBtn);
    }

    // 配置预设：直接打开系统提示词预设管理弹窗
    var configBtn = document.createElement('button');
    configBtn.type = 'button';
    configBtn.className = 'system-floor-btn';
    configBtn.setAttribute('data-role', 'config-preset');
    configBtn.textContent = '配置预设';
    configBtn.addEventListener('click', function () {
      openPresetModal();
    });
    actions.appendChild(configBtn);

    head.appendChild(badge);
    head.appendChild(icon);
    head.appendChild(title);
    head.appendChild(actions);

    card.appendChild(head);
    if (preview) card.appendChild(preview);
    row.appendChild(card);

    return row;
  }

  /**
   * 根据当前会话重绘整个消息区（切换会话 / 删除消息后调用）
   * @param {object} [options] 可选配置
   * @param {boolean} [options.keepScroll] 为 true 时不强制滚到底部（中间楼层重答时使用）
   * @param {boolean} [options.noScroll] 为 true 时完全不做任何滚动处理（搜索跳转接管定位）
   * @param {number}  [options.focusIndex] 重绘后希望保持可见的消息真实索引
   */
  // 仅为显示窗口状态，绝不能用于上下文、世界书或 Token 的消息裁剪。
  var renderedStartIndex = 0;

  function messageRenderStamp(msg) {
    return JSON.stringify([msg.role, msg.content, msg.reasoning, msg.meta, msg.attachments, msg.swipeIndex, msg.swipes, msg._pending]);
  }

  function bindRenderedMessage(row, session, msg) {
    if (els.chatArea._messageResizeObserver) els.chatArea._messageResizeObserver.observe(row);
    var task = activeGenerationMap.get(generationKey(session.id, getActiveSubChatId(session)));
    if (!task || task.assistantMsg !== msg) return;
    var bubble = row.querySelector('.bubble');
    if (task.bubbleRefs === bubble) return;
    task.bubbleRefs = bubble;
    if (task.bindBubble) task.bindBubble(bubble);
    bubble._finalized = false;
    ensureBubbleParts(bubble);
    bubble.classList.toggle('streaming', task.isStreamMode);
    if (task.latestRender) renderAssistantBubble(bubble, task.latestRender, task.isStreamMode);
    else if (task.waitText) {
      bubble._mdBody.style.display = '';
      bubble._mdBody.textContent = task.waitText;
    }
  }

  function updateMessageRowIndex(row, index) {
    if (Number(row.dataset.index) === index) return;
    row.dataset.index = String(index);
    row.dataset.msgIndex = String(index);
    row.dataset.floor = String(index + 1);
    var badge = row.querySelector('.msg-floor-badge');
    if (badge) { badge.textContent = '#' + (index + 1); badge.title = '第 ' + (index + 1) + ' 层'; }
    row.querySelectorAll('[data-index]').forEach(function (node) { node.dataset.index = String(index); });
    row.querySelectorAll('[data-msg-index]').forEach(function (node) { node.dataset.msgIndex = String(index); });
    var branch = row.querySelector('[data-corner-role="branch"]');
    if (branch) branch.title = '把 #1 到 #' + (index + 1) + ' 楼复制到一个新的内部对话';
  }

  function prependMessageRows(newStartIndex) {
    var area = els.chatArea, session = getCurrentSession();
    if (!area || !session || newStartIndex >= renderedStartIndex ||
        area._renderChannel !== generationKey(session.id, getActiveSubChatId(session))) return;
    var prevScrollHeight = area.scrollHeight, prevScrollTop = area.scrollTop;
    var fragment = document.createDocumentFragment();
    for (var index = newStartIndex; index < renderedStartIndex; index++) {
      var msg = session.messages[index];
      if (!isMessageVisible(msg)) continue;
      var row = createMessageRow(msg, index);
      fragment.appendChild(row);
      bindRenderedMessage(row, session, msg);
    }
    area._holdScroll = true;
    userScrolledUp = true;
    area.insertBefore(fragment, area.firstChild);
    renderedStartIndex = newStartIndex;
    area.scrollTop = prevScrollTop + (area.scrollHeight - prevScrollHeight);
    area._lastScrollTop = area.scrollTop;
  }

  function ensureMessageRendered(index) {
    var session = getCurrentSession();
    if (!session || !Number.isInteger(index) || index < 0 || index >= session.messages.length) return null;
    if (index < renderedStartIndex) prependMessageRows(Math.max(0, index - 5));
    return findMessageRow(index);
  }

  function renderMessages(options) {
    if (!els.chatArea) return;
    var opts = options && typeof options === 'object' ? options : {};
    var currentSession = getCurrentSession();
    var channel = currentSession ? generationKey(currentSession.id, getActiveSubChatId(currentSession)) : '';
    var changedChannel = els.chatArea._renderChannel !== channel;
    var renderToken = {};
    els.chatArea._renderToken = renderToken;
    var wasAtBottom = !userScrolledUp;
    var keepScroll = opts.keepScroll === true || (!changedChannel && !wasAtBottom);
    els.chatArea._renderChannel = channel;
    els.chatArea._holdScroll = keepScroll || opts.noScroll === true;
    // 图片、字体与沙盒异步撑高后，仍按用户当前的跟随意愿校准真实底部。
    if (!els.chatArea._messageResizeObserver && window.ResizeObserver) {
      els.chatArea._messageResizeObserver = new ResizeObserver(function () {
        requestAnimationFrame(scrollToBottom);
      });
    }
    var noScroll = opts.noScroll === true;
    var prevScrollTop = els.chatArea.scrollTop;
    if (changedChannel) {
      if (els.chatArea._messageResizeObserver) els.chatArea._messageResizeObserver.disconnect();
      activeGenerationMap.forEach(function (task) {
        if (task.bubbleRefs) task.bubbleRefs._finalized = true;
        task.bubbleRefs = null;
      });
      // 仅切换通道时卸载旧窗口，同通道始终增量更新。
      els.chatArea.replaceChildren();
    }
    syncStreamingUiState();

    var session = getCurrentSession();
    // 渲染前确保子对话结构完好，messages 指向激活子对话（历史数据自动兼容）
    if (session) ensureSessionSubChats(session);
    // 所有重绘入口均同步当前上下文，空会话和提前返回也不能漏刷新。
    refreshMemoryContext();
    var messages = session ? session.messages : [];
    var rendered = 0;

    // #0 系统提示词层已迁移到顶部导航栏的一站式控制台，聊天流从 #1 开始

    var existing = new Map();
    var indices = new Map();
    messages.forEach(function (msg, index) { indices.set(msg, index); });
    var oldRows = Array.from(els.chatArea.querySelectorAll('.msg[data-index]'));
    if (changedChannel) renderedStartIndex = Math.max(0, messages.length - 10);
    else if (oldRows.length) {
      // 增删中间层时以首个仍存活对象为窗口边界，避免数组移位漏层。
      var firstSurvivor = oldRows.find(function (row) { return indices.has(row._message); });
      renderedStartIndex = firstSurvivor ? Math.min(renderedStartIndex, indices.get(firstSurvivor._message)) : Math.min(renderedStartIndex, messages.length);
    }
    oldRows.forEach(function (row) {
      var index = indices.get(row._message);
      if (index === undefined || index < renderedStartIndex || !isMessageVisible(row._message)) {
        if (els.chatArea._messageResizeObserver) els.chatArea._messageResizeObserver.unobserve(row);
        row.remove();
      } else existing.set(row._message, row);
    });
    hideEmptyTip();
    var cursor = els.chatArea.firstChild;
    for (var index = renderedStartIndex; index < messages.length; index++) {
      var msg = messages[index];
      if (!isMessageVisible(msg)) continue;
      rendered++;
      var row = existing.get(msg);
      if (row && (opts.refreshRows === true || row._renderStamp !== messageRenderStamp(msg))) {
        var replacement = createMessageRow(msg, index);
        if (els.chatArea._messageResizeObserver) els.chatArea._messageResizeObserver.unobserve(row);
        if (cursor === row) cursor = replacement;
        row.replaceWith(replacement);
        row = replacement;
      }
      if (!row) row = createMessageRow(msg, index);
      updateMessageRowIndex(row, index);
      if (row !== cursor) els.chatArea.insertBefore(row, cursor);
      cursor = row.nextSibling;
      bindRenderedMessage(row, session, msg);
    }

    if (!session || (rendered === 0 && renderedStartIndex === 0)) {
      els.chatArea.appendChild(createEmptyTip());
      return;
    }

    // 搜索跳转：由 jumpToSearchResult 自己负责平滑定位与高亮
    if (noScroll) return;

    // 中间楼层重答：保持当前位置，仅在目标楼层跑出视口时才把它带回视野中心
    if (keepScroll) {
      // innerHTML 清空会把 scrollTop 归零，先还原到重绘前的滚动位置再判断可见性
      els.chatArea.scrollTop = prevScrollTop;
      els.chatArea._lastScrollTop = els.chatArea.scrollTop;
      return;
    }

    // 首屏先挂载尾部十层，下一帧按实际高度补齐；令牌阻止旧帧干扰新渲染。
    if (changedChannel) requestAnimationFrame(ensureViewportFilled);

    function ensureViewportFilled() {
      var chatContainer = els.chatArea;
      if (chatContainer._renderToken !== renderToken || chatContainer._renderChannel !== channel ||
          getCurrentSession() !== session || session.messages !== messages) return;
      if (chatContainer.scrollHeight <= chatContainer.clientHeight + 120 && renderedStartIndex > 0) {
        prependMessageRows(Math.max(0, renderedStartIndex - 10));
        requestAnimationFrame(ensureViewportFilled);
        return;
      }
      // 自动补齐全部完成后统一置底，并恢复正常的滚动跟随。
      chatContainer._holdScroll = false;
      userScrolledUp = false;
      chatContainer.scrollTop = chatContainer.scrollHeight;
      chatContainer._lastScrollTop = chatContainer.scrollTop;
    }

    // 立即置底避免首帧闪动；自动补齐结束后再按最终高度校准。
    els.chatArea.style.scrollBehavior = 'auto';
    forceScrollToBottom();
    els.chatArea._lastScrollTop = els.chatArea.scrollTop;
    els.chatArea.style.scrollBehavior = '';
  }

  /**
   * 构建思维链折叠卡（<details>）
   */
  function buildCotBox() {
    var details = document.createElement('details');
    details.className = 'cot-box';

    var summary = document.createElement('summary');
    summary.className = 'cot-summary';
    summary.textContent = '💡 深度思考过程 (点击展开/收起)';

    var content = document.createElement('div');
    content.className = 'cot-content';

    details.appendChild(summary);
    details.appendChild(content);

    // 记录用户手动展开 / 收起的意愿，避免后续自动重绘覆盖
    summary.addEventListener('click', function () {
      details.setAttribute('data-user-toggled', '1');
    });

    details._content = content;
    return details;
  }

  /**
   * 确保气泡内部结构就绪：思维链折叠卡 + Markdown 正文容器
   */
  function ensureBubbleParts(bubble) {
    if (bubble._mdBody) return;

    var cot = buildCotBox();
    var mdBody = document.createElement('div');
    mdBody.className = 'md-body';

    bubble.appendChild(cot);
    bubble.appendChild(mdBody);

    bubble._cot = cot;
    bubble._cotContent = cot._content;
    bubble._mdBody = mdBody;
  }

  // 仅在克隆上排除非正文节点，原有样式不能因空正文检测而丢失。
  function hasVisibleProse(node) {
    var clone = node.cloneNode(true);
    var hidden = 'style,script,link,meta,template,noscript';
    if (clone.nodeType === 1) {
      if (clone.matches(hidden)) return false;
      Array.prototype.forEach.call(clone.querySelectorAll(hidden), function (el) { el.remove(); });
      var visible = 'img,video,audio,canvas,svg,table,hr,pre,code,input,button';
      if (clone.matches(visible) || clone.querySelector(visible)) return true;
    }
    return !!String(clone.textContent || '').replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '');
  }

  // 空底板不保留，但把样式移回透明正文容器，继续作用于混排内容。
  function retainProseStyles(node, target) {
    if (node.nodeType !== 1) return;
    if (node.matches('style,link')) target.appendChild(node);
    else Array.prototype.slice.call(node.querySelectorAll('style,link')).forEach(function (el) { target.appendChild(el); });
  }

  // 拆开混排节点，沙盒原节点保留，避免重建 iframe 或把状态栏包入正文底板。
  function separateSandboxProse(body) {
    function split(node) {
      if (node.nodeType !== 1 || node.classList.contains('tavern-sandbox-wrap') || !node.querySelector('.tavern-sandbox-wrap')) return [node];
      var parts = [], group = null;
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        split(child).forEach(function (part) {
          if (part.nodeType === 1 && part.classList.contains('tavern-sandbox-wrap')) {
            group = null; parts.push(part);
          } else {
            if (!group) { group = node.cloneNode(false); parts.push(group); }
            group.appendChild(part);
          }
        });
      });
      return parts;
    }
    var fragment = document.createDocumentFragment(), textBody = null;
    Array.prototype.slice.call(body.childNodes).forEach(function (node) {
      split(node).forEach(function (part) {
        if (part.nodeType === 1 && part.classList.contains('tavern-sandbox-wrap')) {
          textBody = null; fragment.appendChild(part);
        } else {
          if (!hasVisibleProse(part)) {
            retainProseStyles(part, fragment);
            return;
          }
          if (!textBody) {
            textBody = document.createElement('div'); textBody.className = 'msg-text-body'; fragment.appendChild(textBody);
          }
          textBody.appendChild(part);
        }
      });
    });
    body.replaceChildren(fragment);
  }

  /**
   * 渲染 AI 消息：思维链折叠卡 + Markdown 正式回复（含代码高亮与复制条）
   * @param {HTMLElement} bubble 气泡元素
   * @param {object} msg 消息对象 { content, reasoning }
   * @param {boolean} streaming 是否仍在流式输出中
   */
  function renderAssistantBubble(bubble, msg, streaming) {
    ensureBubbleParts(bubble);

    var rawContent = msg.content || '';
    var parsed = splitLeadingThink(rawContent);
    var fieldReasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
    var reasoningText = fieldReasoning.trim() ? fieldReasoning : parsed.reasoning;
    var answerText = parsed.answer;

    // 流式刚输出 "<thi" 之类的标签前缀时先不展示，避免标签碎片闪现
    if (answerText && isThinkOpenPrefix(answerText)) answerText = '';

    // 1. 思维链区域
    if (reasoningText) {
      bubble._cot.style.display = '';
      if (bubble._cotContent.textContent !== reasoningText) {
        bubble._cotContent.textContent = reasoningText;
      }

      // 流式思考中（尚未出现正文）默认展开；结束后若用户未手动操作则自动收起
      var thinkingActive = !!streaming && !answerText;
      if (thinkingActive) {
        bubble._cot.open = true;
      } else if (bubble._cot.getAttribute('data-user-toggled') !== '1') {
        bubble._cot.open = false;
      }
      bubble._cot.classList.toggle('cot-active', thinkingActive);
    } else {
      bubble._cot.style.display = 'none';
      bubble._cot.open = false;
      bubble._cot.classList.remove('cot-active');
    }

    // 2. Markdown 正文（宏变量 + 三层正则 onRender 在此统一生效）
    if (answerText) {
      var mdSession = getCurrentSession();
      var html = renderMarkdown(answerText, 'assistant', mdSession);
      if (bubble._mdBody._lastHtml !== html) {
        bubble._mdBody.innerHTML = html;
        bubble._mdBody._lastHtml = html;
        bubble._mdBody._sandboxProseSeparated = false;
        enhanceCodeBlocks(bubble._mdBody);
      }
      // 沙盒占位符 → 自适应高度 iframe（每次渲染后都要检查，流式输出会反复重绘）
      try {
        mountTavernSandboxes(bubble._mdBody, mdSession);
      } catch (sandboxErr) {
        console.warn('[MyChat] 状态栏沙盒挂载失败：', sandboxErr);
      }
      var hasSandbox = !!bubble._mdBody.querySelector('.tavern-sandbox-wrap');
      bubble.classList.toggle('has-sandbox', hasSandbox);
      if (hasSandbox && !bubble._mdBody._sandboxProseSeparated) {
        separateSandboxProse(bubble._mdBody);
        bubble._mdBody._sandboxProseSeparated = true;
      }
      // 最终兜底：重复渲染也清理空底板，样式仍留在透明层。
      Array.prototype.forEach.call(bubble._mdBody.querySelectorAll('.msg-text-body'), function (body) {
        if (hasVisibleProse(body)) return;
        retainProseStyles(body, bubble._mdBody);
        body.remove();
      });
      bubble.classList.toggle('sandbox-only-bubble', hasSandbox && !bubble._mdBody.querySelector('.msg-text-body') && !reasoningText);
      bubble._mdBody.style.display = '';
    } else {
      bubble.classList.remove('has-sandbox', 'sandbox-only-bubble');
      bubble._mdBody.innerHTML = '';
      bubble._mdBody._lastHtml = '';
      bubble._mdBody.style.display = 'none';
    }
  }

  /**
   * 流式高频更新时用 requestAnimationFrame 合并重绘，避免长文本反复解析卡顿
   */
  function scheduleAssistantRender(bubble, msg) {
    bubble._latestRender = msg;
    if (bubble._rafPending || bubble._finalized) return;
    bubble._rafPending = true;
    requestAnimationFrame(function () {
      bubble._rafPending = false;
      // 流式已结束（最终态已渲染）：丢弃迟到的帧回调，避免思维链被重新展开
      if (bubble._finalized || !bubble.isConnected) return;
      renderAssistantBubble(bubble, bubble._latestRender, true);
    });
  }

  /**
   * 在聊天区追加一条消息气泡，返回气泡元素（便于流式逐字更新）
   * @param {string} role 'user' | 'assistant'
   * @param {string} text 初始文本
   * @param {boolean} [noScroll] 为 true 时不强制滚动到聊天室底部
   */
  function appendMessage(role, text, noScroll) {
    hideEmptyTip();

    var session = getCurrentSession();

    var row = document.createElement('div');
    row.className = 'msg ' + (role === 'user' ? 'msg-user' : 'msg-ai');

    // 与正式消息行保持完全一致的结构：头像 + 名称/气泡
    var line = document.createElement('div');
    line.className = 'msg-line';

    var avatarEl = document.createElement('div');
    avatarEl.className = 'msg-avatar';
    avatarEl.innerHTML = buildMessageAvatarHtml(session, { role: role });

    var mainWrap = document.createElement('div');
    mainWrap.className = 'msg-main';

    var nameText = buildMessageNameText(session, { role: role });
    if (nameText) {
      var nameEl = document.createElement('div');
      nameEl.className = 'msg-speaker';
      nameEl.textContent = nameText;
      mainWrap.appendChild(nameEl);
    }

    var bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (role === 'user') {
      renderUserBubble(bubble, { content: text || '' });
    } else {
      renderAssistantBubble(bubble, { content: text || '' }, true);
    }

    mainWrap.appendChild(bubble);
    if (role === 'user') {
      line.appendChild(mainWrap);
      line.appendChild(avatarEl);
    } else {
      line.appendChild(avatarEl);
      line.appendChild(mainWrap);
    }
    row.appendChild(line);

    els.chatArea.appendChild(row);
    if (!noScroll) scrollToBottom();
    return bubble;
  }

  /**
   * 流式结束后，为临时气泡行补上真实索引与四大操作栏
   * （不重新解析 Markdown，避免重复开销与思维链展开状态丢失）
   */
  function replaceBubbleRowWithActions(bubble, session, msg) {
    if (!bubble || !session) return;
    var index = session.messages.indexOf(msg);
    if (index === -1) return;

    // 气泡现在嵌在 .msg-main 内，需向上查找真正的消息行
    var row = bubble.closest ? bubble.closest('.msg') : bubble.parentNode;
    if (!row) return;

    var floorNum = index + 1;
    row.setAttribute('data-index', String(index));
    row.setAttribute('data-floor', String(floorNum));
    row.setAttribute('data-msg-index', String(index));
    row.setAttribute('data-role', msg.role);

    // 临时流式气泡补上楼层徽章（置于气泡内容最顶部）
    var oldFloorBadge = bubble.querySelector('.msg-floor-badge');
    if (oldFloorBadge && oldFloorBadge.parentNode) oldFloorBadge.parentNode.removeChild(oldFloorBadge);
    var floorBadge = document.createElement('span');
    floorBadge.className = 'msg-floor-badge';
    floorBadge.textContent = '#' + floorNum;
    floorBadge.title = '第 ' + floorNum + ' 层';
    bubble.insertBefore(floorBadge, bubble.firstChild);

    var oldBar = bubble.querySelector('.msg-actions');
    if (oldBar && oldBar.parentNode) oldBar.parentNode.removeChild(oldBar);
    bubble.appendChild(buildActionsBar(index));

    // 补上气泡右上角扩展工具（建立分支等）
    var oldCorner = bubble.querySelector('.msg-corner');
    if (oldCorner && oldCorner.parentNode) oldCorner.parentNode.removeChild(oldCorner);
    buildCornerTool(bubble, index);

    // 流式结束后补上气泡下方的统计小字栏（时间 / Token / 缓存 / 耗时）
    var oldMeta = row.querySelector('.msg-meta');
    if (oldMeta && oldMeta.parentNode) oldMeta.parentNode.removeChild(oldMeta);
    var metaBar = buildMetaBar(msg, index);
    if (metaBar) row.appendChild(metaBar);
    row._message = msg;
    row._renderStamp = messageRenderStamp(msg);
  }

  /**
   * 以红色错误气泡展示具体报错信息
   * @param {string} message 错误描述
   * @param {boolean} [noScroll] 为 true 时不强制滚动到聊天室底部
   */
  function appendError(message, noScroll) {
    var bubble = appendMessage('assistant', '', noScroll);
    ensureBubbleParts(bubble);
    bubble._cot.style.display = 'none';
    bubble._mdBody.style.display = '';
    bubble._mdBody.textContent = '请求出错：' + message;
    bubble.classList.add('bubble-error');
    if (!noScroll) scrollToBottom();
    return bubble;
  }

  /**
   * 把请求失败的状态码与响应内容整理成可读的中文错误信息
   */
  function describeHttpError(status, statusText, bodyText) {
    var message = '';
    var parsed = safeJsonParse(bodyText);

    if (parsed && parsed.error) {
      message = parsed.error.message || parsed.error.code || JSON.stringify(parsed.error);
    } else if (parsed && parsed.message) {
      message = parsed.message;
    } else if (bodyText) {
      // 有些网关返回的是 HTML 错误页，去掉标签后截断展示
      message = bodyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    }

    var head = '请求失败（HTTP ' + status + (statusText ? ' ' + statusText : '') + '）';

    // 常见状态码给出额外排查提示
    if (status === 401) {
      head += '：API Key 无效或未授权，请检查【设置】中的密钥';
    } else if (status === 403) {
      head += '：当前密钥无权限访问该模型/接口';
    } else if (status === 404) {
      head += '：接口地址或模型名称不存在，请检查 Base URL 是否正确';
    } else if (status === 429) {
      head += '：请求过于频繁或额度已用尽';
    } else if (status >= 500) {
      head += '：服务端异常，请稍后重试或更换接口地址';
    }

    return head + (message ? '\n' + message : '');
  }

  /**
   * 从非流式 JSON 响应中提取完整的文本内容
   */
  function extractFullContent(data) {
    if (!data || !Array.isArray(data.choices)) return '';
    var text = '';
    for (var i = 0; i < data.choices.length; i++) {
      var choice = data.choices[i];
      if (!choice) continue;
      if (choice.message && typeof choice.message.content === 'string') {
        text += choice.message.content;
      } else if (choice.delta && typeof choice.delta.content === 'string') {
        text += choice.delta.content;
      } else if (typeof choice.text === 'string') {
        text += choice.text;
      }
    }
    return text;
  }

  /**
   * 从非流式 JSON 响应中提取思维链内容
   * 兼容 reasoning_content（DeepSeek-R1 等官方字段）与 reasoning
   */
  function extractFullReasoning(data) {
    if (!data || !Array.isArray(data.choices)) return '';
    var text = '';
    for (var i = 0; i < data.choices.length; i++) {
      var choice = data.choices[i];
      if (!choice) continue;
      var source = choice.message || choice.delta || null;
      if (!source) continue;
      if (typeof source.reasoning_content === 'string') {
        text += source.reasoning_content;
      } else if (typeof source.reasoning === 'string') {
        text += source.reasoning;
      }
    }
    return text;
  }

  /* ================= 旧版配置读写（云同步 + 向下兼容） ================= */

  // 旧版单 API 配置是否存在（决定是否需要自动迁移为多渠道结构）
  var hasLegacyConfig = false;

  /**
   * 页面加载时从 localStorage 读取旧版配置与云同步配置
   */
  function loadConfig() {
    var raw = null;
    try {
      raw = readStorageRaw(CONFIG_KEY);
    } catch (err) {
      console.warn('浏览器存储不可用，配置将无法保存：', err);
      return;
    }

    var saved = safeJsonParse(raw);
    if (!saved) return;

    hasLegacyConfig = true;
    config = Object.assign({}, saved, config); // 保留本机未来版本的未知偏好字段

    config.baseUrl =
      typeof saved.baseUrl === 'string' && saved.baseUrl.trim()
        ? saved.baseUrl.trim()
        : DEFAULTS.baseUrl;
    config.apiKey = typeof saved.apiKey === 'string' ? saved.apiKey.trim() : '';
    config.model =
      typeof saved.model === 'string' && saved.model.trim()
        ? saved.model.trim()
        : DEFAULTS.model;

    // 云同步配置回填
    config.syncPlatform = saved.syncPlatform === 'github' ? 'github' : 'gitee';
    config.syncToken = typeof saved.syncToken === 'string' ? saved.syncToken.trim() : '';
    config.gistId = typeof saved.gistId === 'string' ? saved.gistId.trim() : '';
    config.autoSync = saved.autoSync === true;
  }

  /**
   * 将旧版配置（含云同步）写入 localStorage
   * @param {boolean} silent 静默模式（后台同步时自动回填 Gist ID 用，不弹窗）
   */
  function persistConfig(silent) {
    try {
      return writeStorageValue(CONFIG_KEY, config);
    } catch (err) {
      if (silent === true) {
        console.warn('配置自动保存失败：浏览器存储不可用', err);
      } else {
        void window.showAppAlert('保存失败：' + (err && err.message ? err.message : err));
      }
      return false;
    }
  }

  // === [ANCHOR: PROVIDERS_MODELS] 多渠道、模型管理与计费计算 ===
  /* ===================================================================
     多渠道（Provider）与多模型数据层
     -------------------------------------------------------------------
     存储结构：
       mychat_providers     = [{ id, name, baseUrl, apiKey,
                                models: [{id, alias, inputPrice, cachePrice, outputPrice}] }]
       mychat_active_target = { providerId, modelId }
     单价单位：元 / 百万 Tokens，留空字符串表示不计费
     =================================================================== */

   // 设置弹窗打开期间的草稿副本：点击「保存」才正式写入，取消则丢弃
   var draftProviders = null;
   // 当前选中渠道+模型的草稿副本（同上，取消即丢弃）
   var draftActiveTarget = null;

   /**
    * 深拷贝当前选中目标，供设置弹窗内部使用（避免直接改到正式数据）
    */
   function cloneActiveTarget(target) {
     if (!target || typeof target !== 'object') {
       return { providerId: '', modelId: '' };
     }
     return {
       providerId: target.providerId || '',
       modelId: target.modelId || ''
     };
   }

   /**
    * 规范化单个模型的单价字段：只保留合法的非负数字，其余一律置空
    * 统一输出标准数字文本（如「12.」转为「12」、「0.50」转为「0.5」），
    * 避免 <input type="number"> 回填时被浏览器判定为非法值而清空
    */
   function normalizePriceValue(value) {
     if (value === null || value === undefined) return '';
     var text = String(value).trim();
     if (!text) return '';
     var num = Number(text);
     if (!isFinite(num) || num < 0) return '';
     return String(num);
   }

   /**
    * 判断模型是否填写了任意一个有效单价
    */
   function hasAnyPrice(model) {
     if (!model) return false;
     return ['inputPrice', 'cachePrice', 'outputPrice'].some(function (key) {
       var text = normalizePriceValue(model[key]);
       return text !== '';
     });
   }

  /**
   * 深拷贝渠道数组（避免草稿修改直接影响已保存数据）
   */
  function cloneProviders(list) {
    try {
      return JSON.parse(JSON.stringify(list || []));
    } catch (err) {
      return [];
    }
  }

  /**
   * 规范化单个渠道对象，丢弃异常数据并去重模型
   */
  function normalizeProvider(raw) {
    if (!raw || typeof raw !== 'object') return null;

    var models = [];
    if (Array.isArray(raw.models)) {
      raw.models.forEach(function (item) {
        var id = '';
        var alias = '';
        var inputPrice = '';
        var cachePrice = '';
        var outputPrice = '';
        if (typeof item === 'string') {
          id = item.trim();
        } else if (item && typeof item === 'object') {
          id = typeof item.id === 'string' ? item.id.trim() : '';
          alias = typeof item.alias === 'string' ? item.alias.trim() : '';
          inputPrice = normalizePriceValue(item.inputPrice);
          cachePrice = normalizePriceValue(item.cachePrice);
          outputPrice = normalizePriceValue(item.outputPrice);
        }
        if (!id) return;
        // 同一渠道内模型 ID 唯一
        for (var i = 0; i < models.length; i++) {
          if (models[i].id === id) return;
        }
        models.push({
          id: id,
          alias: alias,
          inputPrice: inputPrice,
          cachePrice: cachePrice,
          outputPrice: outputPrice
        });
      });
    }

    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : genId(),
      name:
        typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '默认渠道',
      baseUrl:
        typeof raw.baseUrl === 'string' && raw.baseUrl.trim()
          ? raw.baseUrl.trim()
          : DEFAULTS.baseUrl,
      builtinId: typeof raw.builtinId === 'string' ? raw.builtinId : '',
      apiType: ['anthropic', 'gemini'].indexOf(raw.apiType) >= 0 ? raw.apiType : 'openai',
      visionSupport: raw.visionSupport === true,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
      models: models
    };
  }

  /**
   * 读取全部渠道；为空时自动从旧版单 API 配置迁移
   */
  function loadProviders() {
    var raw = null;
    try {
      raw = readStorageRaw(PROVIDERS_KEY);
    } catch (err) {
      console.warn('浏览器存储不可用，渠道配置将无法读取：', err);
    }

    var list = safeJsonParse(raw);
    providers = [];

    if (Array.isArray(list)) {
      list.forEach(function (item) {
        var normalized = normalizeProvider(item);
        if (normalized) providers.push(normalized);
      });
    }

    // 向下兼容：旧版单 API 配置存在且尚无任何渠道时，自动迁移为第一个渠道
    if (providers.length === 0 && hasLegacyConfig) {
      var legacyModel = config.model || DEFAULTS.model;
      providers.push({
        id: genId(),
        name: '默认渠道',
        baseUrl: config.baseUrl || DEFAULTS.baseUrl,
        apiKey: config.apiKey || '',
        models: [{ id: legacyModel, alias: '' }]
      });
      persistProviders(true);
      console.log('[渠道迁移] 已将旧版单 API 配置迁移为「默认渠道」');
    } else if (providers.length === 0 && raw === null) {
      // 首次使用（从未保存过渠道）：给一个空白默认渠道，便于直接填写
      providers.push({
        id: genId(),
        name: '默认渠道',
        baseUrl: DEFAULTS.baseUrl,
        apiKey: '',
        models: []
      });
      persistProviders(true);
    }
    mergeBuiltinProviders(providers);
    persistProviders(true);
  }

  // 只补缺失渠道；同地址的历史配置沿用原 ID、密钥、模型和价格。
  function mergeBuiltinProviders(list) {
    (window.MyChatProviderDefaults || []).forEach(function (preset) {
      var found = list.find(function (p) { return p.builtinId === preset.builtinId; });
      if (!found) found = list.find(function (p) {
        return !p.builtinId && p.baseUrl.replace(/\/+$/, '') === preset.baseUrl.replace(/\/+$/, '') &&
          (p.apiType || 'openai') === preset.apiType;
      });
      if (found) found.builtinId = preset.builtinId;
      else list.push(Object.assign({ id: 'builtin_' + preset.builtinId, apiKey: '', models: [] }, preset));
    });
    return list;
  }

  function providerNeedsKey(provider) {
    return !(provider && provider.builtinId === 'ollama' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(provider.baseUrl));
  }

  function isProviderAvailable(provider) {
    return !!provider && (!provider.builtinId || !!provider.apiKey || !providerNeedsKey(provider)) &&
      Array.isArray(provider.models) && provider.models.length > 0;
  }

  /**
   * 保存渠道数组到 localStorage
   */
  function persistProviders(silent) {
    try {
      localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers));
      // 渠道 / 模型 / 别名 / 单价变更都属于需要同步的核心数据：
      // 同步刷新全局时间戳，并触发 1 秒防抖的静默自动上传
      if (!applyingCloudData && !isBooting) {
        touchLastModified();
        scheduleCloudUpload();
      }
      return true;
    } catch (err) {
      if (silent === true) {
        console.warn('渠道配置自动保存失败：浏览器存储不可用', err);
      } else {
        void window.showAppAlert('保存失败：' + (err && err.message ? err.message : err));
      }
      return false;
    }
  }

  /**
   * 按 ID 查找渠道
   * @param {string} id 渠道 ID
   * @param {Array} list 可选：在指定数组中查找（草稿）
   */
  function getProviderById(id, list) {
    var arr = list || providers;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === id) return arr[i];
    }
    return null;
  }

  /**
   * 在渠道内按真实模型 ID 查找模型项
   */
  function findProviderModel(provider, modelId) {
    if (!provider || !Array.isArray(provider.models)) return null;
    for (var i = 0; i < provider.models.length; i++) {
      if (provider.models[i].id === modelId) return provider.models[i];
    }
    return null;
  }

  /**
   * 解析当前生效的渠道与模型；无效时返回 null
   */
  function resolveActiveTarget() {
    var provider = getProviderById(activeTarget.providerId);
    if (!isProviderAvailable(provider)) return null;
    var model = findProviderModel(provider, activeTarget.modelId);
    if (!model) return null;
    return { provider: provider, model: model };
  }

  /**
   * 找到第一个可用的 { providerId, modelId }
   */
  function pickFirstTarget() {
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      if (isProviderAvailable(p)) {
        return { providerId: p.id, modelId: p.models[0].id };
      }
    }
    return null;
  }

  /**
   * 读取当前选中的渠道与模型
   */
  function loadActiveTarget() {
    var saved = null;
    try {
      saved = safeJsonParse(readStorageRaw(ACTIVE_TARGET_KEY));
    } catch (err) {
      saved = null;
    }

    activeTarget = {
      providerId:
        saved && typeof saved.providerId === 'string' ? saved.providerId : '',
      modelId: saved && typeof saved.modelId === 'string' ? saved.modelId : ''
    };

    ensureActiveTarget();
  }

  /**
   * 保证 activeTarget 始终指向真实存在的渠道与模型
   */
  function ensureActiveTarget() {
    if (resolveActiveTarget()) return;
    var first = pickFirstTarget();
    if (first) {
      activeTarget = first;
    } else {
      activeTarget = { providerId: '', modelId: '' };
    }
    if (applyingCloudData) requireStorageWrite(writeStorageValue(ACTIVE_TARGET_KEY, activeTarget));
    else persistActiveTarget(true);
  }

  /**
   * 保存当前选中的渠道与模型
   */
  function persistActiveTarget(silent) {
    try {
      localStorage.setItem(ACTIVE_TARGET_KEY, JSON.stringify(activeTarget));
      // 当前模型属于需要跨设备同步的核心数据：刷新时间戳并触发防抖自动上传
      if (!applyingCloudData && !isBooting) {
        touchLastModified();
        scheduleCloudUpload();
      }
    } catch (err) {
      if (silent !== true) console.warn('当前模型选择保存失败：', err);
    }
  }

  /**
   * 模型在界面上的展示名：有别名时用「别名 (真实ID)」，否则直接用真实 ID
   */
  function formatModelLabel(model) {
    if (!model) return '';
    var alias = model.alias ? String(model.alias).trim() : '';
    return alias ? alias + ' (' + model.id + ')' : model.id;
  }

  // === [ANCHOR: MODEL_PICKER_UI] 底部可折叠渠道模型切换器 ===
  /* ================= 底部快捷模型切换器 ================= */

  // 记录每个渠道分组当前是展开还是收拢：providerId -> true/false
  var quickModelExpanded = {};

  // 记录上一次渲染时的「当前模型」，用于在切换模型后自动展开其所属分组
  var quickModelActiveKey = '';

  /**
   * 模型在底部选择器里的简短名称：优先别名，没有别名就用真实 ID
   */
  function formatQuickModelName(model) {
    if (!model) return '';
    var alias = model.alias ? String(model.alias).trim() : '';
    return alias || String(model.id || '');
  }

  /**
   * 判断某个渠道分组是否展开；首次访问时默认展开当前选中模型所在渠道
   */
  function isQuickGroupExpanded(providerId) {
    if (!Object.prototype.hasOwnProperty.call(quickModelExpanded, providerId)) {
      quickModelExpanded[providerId] = providerId === activeTarget.providerId;
    }
    return quickModelExpanded[providerId] === true;
  }

  /**
   * 重绘底部模型选择器：按渠道名称分组，组内列出该渠道的模型
   * 面板默认展开当前选中模型所在的渠道，其余渠道收拢
   */
  function renderQuickModelSelect() {
    window.dispatchEvent(new Event('mychat-context-changed'));
    if (!els.quickModelLabel || !els.quickModelPanel || !els.quickModelBtn) return;

    // 先校正当前选中项（渠道或模型被删除时自动回退）
    ensureActiveTarget();

    // 当前模型发生变化时，自动展开它所在的渠道分组
    var activeKey = activeTarget.providerId + '|' + activeTarget.modelId;
    if (activeKey !== quickModelActiveKey) {
      quickModelActiveKey = activeKey;
      if (activeTarget.providerId) quickModelExpanded[activeTarget.providerId] = true;
    }

    var panel = els.quickModelPanel;
    panel.innerHTML = '';

    var total = 0;

    providers.forEach(function (provider) {
      if (!isProviderAvailable(provider)) return;

      var models = provider.models.filter(function (model) {
        return model && model.id;
      });
      if (models.length === 0) return;

      total += models.length;

      var expanded = isQuickGroupExpanded(provider.id);

      // 分组标题：点击可展开 / 收拢
      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'qm-group-head';
      head.setAttribute('data-qm-group', provider.id);
      head.setAttribute('aria-expanded', expanded ? 'true' : 'false');

      var arrow = document.createElement('span');
      arrow.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 5 7 7-7 7"/></svg>';
      arrow.className = 'qm-group-chevron' + (expanded ? ' is-open' : '');
      arrow.setAttribute('aria-hidden', 'true');
      head.appendChild(arrow);

      var nameEl = document.createElement('span');
      nameEl.className = 'qm-group-name';
      nameEl.textContent = provider.name || '未命名渠道';
      head.appendChild(nameEl);

      var countEl = document.createElement('span');
      countEl.className = 'qm-group-count';
      countEl.textContent = String(models.length);
      head.appendChild(countEl);

      panel.appendChild(head);

      if (!expanded) return;

      models.forEach(function (model) {
        var isActive =
          provider.id === activeTarget.providerId && model.id === activeTarget.modelId;

        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'qm-item' + (isActive ? ' active' : '');
        item.setAttribute('data-qm-provider', provider.id);
        item.setAttribute('data-qm-model', model.id);
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', isActive ? 'true' : 'false');

        var itemName = document.createElement('span');
        itemName.className = 'qm-item-name';
        itemName.textContent = formatQuickModelName(model);
        item.appendChild(itemName);

        // 有别名时把真实 ID 作为次级信息展示，方便辨认
        var aliasText = model.alias ? String(model.alias).trim() : '';
        if (aliasText && aliasText !== model.id) {
          var itemId = document.createElement('span');
          itemId.className = 'qm-item-id';
          itemId.textContent = model.id;
          item.appendChild(itemId);
        }

        if (isActive) {
          var check = document.createElement('span');
          check.className = 'qm-item-check';
          check.setAttribute('aria-hidden', 'true');
          check.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 12 4 4L19 6"/></svg>';
          item.appendChild(check);
        }

        panel.appendChild(item);
      });
    });

    if (total === 0) {
      var empty = document.createElement('div');
      empty.className = 'qm-empty';
      empty.textContent = '未配置模型，请先到设置中配置';
      panel.appendChild(empty);

      els.quickModelBtn.classList.add('is-empty');
      els.quickModelBtn.disabled = true;
      els.quickModelLabel.textContent = '未配置模型';
      els.quickModelBtn.title = '请先到设置中添加渠道与模型';
      closeQuickModelPanel();
      return;
    }

    els.quickModelBtn.classList.remove('is-empty');
    els.quickModelBtn.disabled = false;

    // 框面仅显示模型别名或 ID，渠道保留在选择列表分组中。
    var resolved = resolveActiveTarget();
    if (resolved) {
      var labelText = formatQuickModelName(resolved.model);
      els.quickModelLabel.textContent = labelText;
      els.quickModelBtn.title = '当前模型：' + labelText + '（点击切换）';
    } else {
      els.quickModelLabel.textContent = '未选择模型';
      els.quickModelBtn.title = '点击选择模型';
    }
  }

  /**
   * 展开底部模型列表面板
   */
  function openQuickModelPanel() {
    if (!els.quickModelPanel || !els.quickModelBtn) return;
    if (els.quickModelBtn.disabled) return;
    // 两个上弹面板互斥：打开模型切换框时自动收起参数面板
    closeQuickParamsPanel();
    els.quickModelPanel.hidden = false;
    els.quickModelBtn.setAttribute('aria-expanded', 'true');
  }

  /**
   * 收起底部模型列表面板
   */
  function closeQuickModelPanel() {
    if (!els.quickModelPanel || !els.quickModelBtn) return;
    els.quickModelPanel.hidden = true;
    els.quickModelBtn.setAttribute('aria-expanded', 'false');
  }

  /**
   * 切换底部模型列表面板的显示状态
   */
  function toggleQuickModelPanel() {
    if (!els.quickModelPanel) return;
    if (els.quickModelPanel.hidden) {
      // 每次打开都刷新，保证与设置中最新修改一致
      renderQuickModelSelect();
      openQuickModelPanel();
    } else {
      closeQuickModelPanel();
    }
  }

  /**
   * 展开 / 收拢某个渠道分组
   */
  function toggleQuickGroup(providerId) {
    if (!providerId) return;
    quickModelExpanded[providerId] = !isQuickGroupExpanded(providerId);
    renderQuickModelSelect();
    // 重绘后保持面板打开
    openQuickModelPanel();
  }

  /**
   * 底部选择器切换模型：立即更新 mychat_active_target
   */
  function selectQuickModel(providerId, modelId) {
    if (!providerId || !modelId) return;
    var provider = getProviderById(providerId);
    if (!findProviderModel(provider, modelId)) return;

    activeTarget = { providerId: providerId, modelId: modelId };
    persistActiveTarget(true);

    // 记住该渠道为展开状态，下次打开仍在当前位置
    quickModelExpanded[providerId] = true;

    renderQuickModelSelect();
    closeQuickModelPanel();
  }

  // === [ANCHOR: CHAT_PARAMS_UI] 当前对话参数上弹面板与全局默认参数表单 ===
  /* ================= 当前对话参数（底部上弹面板） ================= */

  /**
   * 把参数值渲染到输入框：null 一律显示为空字符串
   */
  function fillParamInputs(inputs, params) {
    if (!inputs) return;
    if (inputs.stream) inputs.stream.checked = params.stream !== false;
    if (inputs.realTime) inputs.realTime.checked = params.realTime !== false;
    if (inputs.contextLimit) {
      inputs.contextLimit.value = params.contextLimit === null ? '' : String(params.contextLimit);
    }
    if (inputs.temperature) {
      inputs.temperature.value = params.temperature === null ? '' : String(params.temperature);
    }
    if (inputs.topP) {
      inputs.topP.value = params.topP === null ? '' : String(params.topP);
    }
    if (inputs.maxTokens) {
      inputs.maxTokens.value = params.maxTokens === null ? '' : String(params.maxTokens);
    }
  }

  /**
   * 从输入框读取参数（不做规范化，交给 cloneChatParams）
   */
  function readParamInputs(inputs) {
    return {
      contextLimit: inputs.contextLimit ? inputs.contextLimit.value : '',
      temperature: inputs.temperature ? inputs.temperature.value : '',
      topP: inputs.topP ? inputs.topP.value : '',
      maxTokens: inputs.maxTokens ? inputs.maxTokens.value : '',
      stream: inputs.stream ? inputs.stream.checked !== false : true,
      realTime: inputs.realTime ? inputs.realTime.checked !== false : true
    };
  }

  /**
   * 底部「参数」输入框集合
   */
  function getQuickParamsInputs() {
    return {
      stream: els.qpStream,
      realTime: els.qpRealTime,
      contextLimit: els.qpContextLimit,
      temperature: els.qpTemperature,
      topP: els.qpTopP,
      maxTokens: els.qpMaxTokens
    };
  }

  /**
   * 刷新底部参数按钮的状态（是否已定制 + 圆点提示）
   */
  function refreshQuickParamsButton(session) {
    if (!els.quickParamsBtn) return;
    var customized = isSessionParamsCustomized(session);
    els.quickParamsBtn.classList.toggle('customized', customized);
    // 按钮内已改为纯 SVG 图标：绝不再写回文字，只用圆点 + 高亮态表达「已定制」
    if (els.quickParamsDot) els.quickParamsDot.hidden = !customized;
    els.quickParamsBtn.setAttribute(
      'aria-label',
      customized ? '调整当前对话参数（已定制，仅对本会话生效）' : '调整当前对话参数（仅对本会话生效）'
    );
    els.quickParamsBtn.title = customized
      ? '调整当前对话参数（已定制，仅对本会话生效）'
      : '调整当前对话参数（仅对本会话生效）';
  }

  /**
   * 按当前会话的有效参数刷新面板内控件与按钮状态
   */
  function refreshQuickParamsPanel() {
    var session = getCurrentSession();
    var params = getSessionParams(session);
    fillParamInputs(getQuickParamsInputs(), params);
    refreshQuickParamsButton(session);
  }

  /**
   * 展开当前对话参数面板（同时自动收起模型切换面板）
   */
  function openQuickParamsPanel() {
    if (!els.quickParamsPanel || !els.quickParamsBtn) return;
    closeQuickModelPanel();
    refreshQuickParamsPanel();
    els.quickParamsPanel.hidden = false;
    els.quickParamsBtn.setAttribute('aria-expanded', 'true');
  }

  /**
   * 收起当前对话参数面板
   */
  function closeQuickParamsPanel() {
    if (!els.quickParamsPanel || !els.quickParamsBtn) return;
    els.quickParamsPanel.hidden = true;
    els.quickParamsBtn.setAttribute('aria-expanded', 'false');
  }

  /**
   * 切换当前对话参数面板显示状态
   */
  function toggleQuickParamsPanel() {
    if (!els.quickParamsPanel) return;
    if (els.quickParamsPanel.hidden) {
      openQuickParamsPanel();
    } else {
      closeQuickParamsPanel();
    }
  }

  /**
   * 面板内任一控件变更：实时写入当前会话的独立 params（无需点击保存）
   */
  function handleQuickParamsInput() {
    var session = getCurrentSession();
    if (!session) return;
    saveSessionParams(session, readParamInputs(getQuickParamsInputs()));
    refreshQuickParamsButton(session);
  }

  /**
   * 把当前会话参数恢复为全局默认（仍然写入本会话，不修改全局）
   */
  function resetQuickParams() {
    var session = getCurrentSession();
    if (!session) return;
    saveSessionParams(session, getGlobalChatParams());
    refreshQuickParamsPanel();
  }

  /* ================= 全局默认对话参数（设置弹窗内） ================= */

  // 设置弹窗打开期间的默认参数草稿：点击右下角「保存」才正式生效
  var draftChatParams = null;

  /**
   * 设置弹窗中「默认对话参数」表单的四个参数输入框集合
   */
  function getChatParamsFormInputs() {
    return {
      stream: els.cfgStream,
      contextLimit: els.cfgContextLimit,
      temperature: els.cfgTemperature,
      topP: els.cfgTopP,
      maxTokens: els.cfgMaxTokens
    };
  }

  /**
   * 把默认参数回填到设置弹窗表单：
   * 弹窗打开期间优先使用内存草稿，未打开时回退到已保存的全局默认参数
   */
  function loadChatParamsForm() {
    var source = draftChatParams || getGlobalChatParams();
    fillParamInputs(getChatParamsFormInputs(), source);
  }

  /**
   * 从设置弹窗表单读取默认参数（仅返回内存值，不写库）
   */
  function readChatParamsForm() {
    return cloneChatParams(readParamInputs(getChatParamsFormInputs()));
  }

  /**
   * 恢复全空默认：仅清空表单输入框并把流式勾选恢复为 true，绝不直接写库
   */
  function resetChatParamsForm() {
    draftChatParams = cloneChatParams(DEFAULT_CHAT_PARAMS);
    fillParamInputs(getChatParamsFormInputs(), draftChatParams);
  }

  /* ================= 设置弹窗：渠道编辑与渲染 ================= */

  /**
   * 当前正在编辑的渠道数组（弹窗打开时用草稿，否则用正式数据）
   */
  function getEditingList() {
    return draftProviders || providers;
  }

  /**
   * 当前正在编辑的渠道对象
   */
  function getEditingProvider() {
    return getProviderById(editingProviderId, getEditingList());
  }

  /**
   * 重绘渠道下拉框
   */
  function renderProviderSelect() {
    if (!els.providerSelect) return;
    var list = getEditingList();

    els.providerSelect.innerHTML = '';
    list.forEach(function (provider) {
      var option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.name || '未命名渠道';
      els.providerSelect.appendChild(option);
    });

    if (getProviderById(editingProviderId, list)) {
      els.providerSelect.value = editingProviderId;
    } else if (list.length > 0) {
      editingProviderId = list[0].id;
      els.providerSelect.value = editingProviderId;
    } else {
      editingProviderId = '';
    }

    // 只剩一个渠道时禁用删除按钮，避免出现空列表
    if (els.delProviderBtn) els.delProviderBtn.disabled = list.length <= 1 || !!(getEditingProvider() || {}).builtinId;
  }

  /**
   * 把当前输入框内容写回草稿渠道
   */
  function syncEditingProviderFields() {
    var provider = getEditingProvider();
    if (!provider) return;

    if (els.providerName) {
      provider.name = els.providerName.value.trim() || '未命名渠道';
    }
    var protocol = document.getElementById('cfg-api-type');
    if (protocol) provider.apiType = protocol.value;
    var vision = document.getElementById('cfg-vision-support');
    if (vision) provider.visionSupport = vision.checked;
    if (els.cfgBaseUrl) {
      provider.baseUrl = els.cfgBaseUrl.value.trim() || DEFAULTS.baseUrl;
    }
    if (els.cfgApiKey) {
      provider.apiKey = els.cfgApiKey.value.trim();
    }
  }

  /**
   * 回填选中渠道的输入框内容
   */
  function renderProviderFields() {
    var provider = getEditingProvider();

    if (els.providerName) els.providerName.value = provider ? provider.name : '';
    if (els.cfgBaseUrl) els.cfgBaseUrl.value = provider ? provider.baseUrl : '';
    if (els.cfgApiKey) els.cfgApiKey.value = provider ? provider.apiKey : '';
    var protocol = document.getElementById('cfg-api-type');
    if (protocol) protocol.value = provider ? provider.apiType : 'openai';
    var vision = document.getElementById('cfg-vision-support');
    if (vision) vision.checked = !!(provider && provider.visionSupport);

    renderModelList();
    resetConnResult();

    // 切换渠道时上一轮的拉取结果失效
    fetchedModels = [];
    hideFetchPanel();
  }

  /**
   * 把某个模型的某个字段写入设置弹窗的内存草稿（draftProviders）
   * 关键：弹窗打开期间绝不写 localStorage、绝不触发云同步，
   *       只有点击右下角「保存」才会正式落库。
   */
  function persistModelFieldRealtime(providerId, modelId, key, value) {
    var draftProvider = getProviderById(providerId, getEditingList());
    if (!draftProvider) return;
    var draftModel = findProviderModel(draftProvider, modelId);
    if (!draftModel) return;

    if (draftModel[key] === value) return;
    draftModel[key] = value;
  }

  /**
   * 创建单个单价输入框（输入价 / 缓存价 / 输出价）
   * @param {string} providerId 渠道 ID
   * @param {Object} model 模型对象
   * @param {string} key 字段名：inputPrice / cachePrice / outputPrice
   * @param {string} labelText 界面上的短标签
   */
  function buildPriceField(providerId, model, key, labelText) {
    var wrap = document.createElement('label');
    wrap.className = 'model-price-field';

    var label = document.createElement('span');
    label.className = 'model-price-label';
    label.textContent = labelText;
    wrap.appendChild(label);

    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'model-item-price';
    input.min = '0';
    input.step = 'any';
    input.placeholder = '0';
    input.value = model[key] || '';
    input.title = labelText + '：元 / 百万 Tokens（留空则不计费）';
    input.setAttribute('data-model-id', model.id);
    input.setAttribute('data-price-key', key);

    // 输入即写回弹窗草稿（draftProviders），不落库、不触发云同步
    input.addEventListener('input', function () {
      var raw = input.value.trim();
      var clean = normalizePriceValue(raw);
      // 输入中间态（例如「12.」或「-」）先保留草稿原值，避免光标处被清空
      var editing = getEditingProvider();
      var target = findProviderModel(editing, model.id);
      if (target) target[key] = clean;

      persistModelFieldRealtime(providerId, model.id, key, clean);
    });

    wrap.appendChild(input);
    return wrap;
  }

  /**
   * 重绘已保存模型列表（真实 ID + 别名 + 三档单价 + 移除按钮）
   */
  function renderModelList() {
    if (!els.modelList) return;
    els.modelList.innerHTML = '';

    var priceList = document.getElementById('model-price-list');
    if (priceList) priceList.textContent = '';

    var provider = getEditingProvider();
    var models = provider && Array.isArray(provider.models) ? provider.models : [];

    if (models.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'model-list-empty';
      empty.textContent = '尚未添加任何模型，可手动添加或从接口拉取。';
      els.modelList.appendChild(empty);
      return;
    }

    var providerId = provider ? provider.id : '';

    models.forEach(function (model) {
      var row = document.createElement('div');
      row.className = 'model-item';

      // 第一行：真实 ID + 别名 + 移除
      var main = document.createElement('div');
      main.className = 'model-item-main';

      var idText = document.createElement('span');
      idText.className = 'model-item-id';
      idText.textContent = model.id;
      idText.title = model.id;

      var aliasInput = document.createElement('input');
      aliasInput.type = 'text';
      aliasInput.className = 'model-item-alias';
      aliasInput.placeholder = '别名（选填）';
      aliasInput.value = model.alias || '';
      aliasInput.setAttribute('data-model-id', model.id);

      // 别名实时写回弹窗草稿（draftProviders），不落库、不触发云同步
      aliasInput.addEventListener('input', function () {
        var value = aliasInput.value.trim();
        var editing = getEditingProvider();
        var target = findProviderModel(editing, model.id);
        if (target) target.alias = value;

        persistModelFieldRealtime(providerId, model.id, 'alias', value);
      });

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'model-item-remove';
      removeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M6 18 18 6"/></svg>';
      removeBtn.title = '从该渠道移除这个模型';
      removeBtn.setAttribute('data-model-id', model.id);

      main.appendChild(idText);
      main.appendChild(aliasInput);
      main.appendChild(removeBtn);

      // 第二行：三档单价（元 / 百万 Tokens）
      var prices = document.createElement('div');
      prices.className = 'model-item-prices';
      prices.appendChild(buildPriceField(providerId, model, 'inputPrice', '输入价'));
      prices.appendChild(buildPriceField(providerId, model, 'cachePrice', '缓存价'));
      prices.appendChild(buildPriceField(providerId, model, 'outputPrice', '输出价'));

      row.appendChild(main);
      els.modelList.appendChild(row);
      if (priceList) {
        var priceRow = document.createElement('div');
        priceRow.className = 'model-item';
        var priceName = document.createElement('span');
        priceName.textContent = model.alias || model.id;
        priceRow.appendChild(priceName);
        priceRow.appendChild(prices);
        priceList.appendChild(priceRow);
      }
    });
  }

  /**
   * 设置连通性检测结果文字
   */
  function setConnResult(state, text) {
    if (!els.connResult) return;
    els.connResult.classList.remove('state-ok', 'state-error', 'state-testing');
    if (state) els.connResult.classList.add('state-' + state);
    els.connResult.textContent = text || '';
  }

  function resetConnResult() {
    setConnResult('', '');
  }

  /**
   * 单行错误描述（多条换行合并为分号，便于在单行显示）
   */
  function describeConnectError(status, statusText, bodyText) {
    return describeHttpError(status, statusText, bodyText).replace(/\n+/g, '；');
  }

  /**
   * 极简探测 /chat/completions：当 /models 返回 404 时使用
   */
  async function probeChatEndpoint(baseUrl, apiKey) {
    var provider = getEditingProvider();
    var modelId =
      provider && provider.models.length > 0 ? provider.models[0].id : 'gpt-3.5-turbo';

    var res;
    try {
      res = await (window.MyChatProviders ? window.MyChatProviders.fetch.bind(null, provider) : fetch)(buildChatUrl(baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        }),
        cache: 'no-store'
      });
    } catch (netErr) {
      return {
        ok: false,
        message:
          '网络请求失败：' +
          (netErr && netErr.message ? netErr.message : netErr) +
          '（可能是地址错误或接口未允许跨域）'
      };
    }

    if (res.ok) return { ok: true };

    var body = '';
    try {
      body = await res.text();
    } catch (readErr) {
      body = '';
    }
    return {
      ok: false,
      message: describeConnectError(res.status, res.statusText, body)
    };
  }

  /**
   * 检测连通性：优先 GET /models，404 时退化为极简 chat 请求
   */
  async function testProviderConnection() {
    if (!els.cfgBaseUrl || !els.cfgApiKey) return;

    // 先把输入框内容写回草稿，保证检测用的就是这个渠道的最新配置
    syncEditingProviderFields();

    var baseUrl = els.cfgBaseUrl.value.trim() || DEFAULTS.baseUrl;
    var apiKey = els.cfgApiKey.value.trim();

    if (!apiKey && providerNeedsKey(getEditingProvider())) {
      setConnResult('error', '连接失败：请先填写 API Key');
      return;
    }

    setConnResult('testing', '正在检测…');
    if (els.testConnBtn) els.testConnBtn.disabled = true;

    var start = Date.now();

    try {
      var res;
      try {
        res = await (window.MyChatProviders ? window.MyChatProviders.fetch.bind(null, getEditingProvider()) : fetch)(buildModelsUrl(baseUrl), {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': 'Bearer ' + apiKey
          },
          cache: 'no-store'
        });
      } catch (netErr) {
        throw new Error(
          '网络请求失败：' +
            (netErr && netErr.message ? netErr.message : netErr) +
            '（可能是地址错误或接口未允许跨域访问）'
        );
      }

      if (res.ok) {
        var cost = Date.now() - start;
        var text = '';
        try {
          text = await res.text();
        } catch (readErr) {
          text = '';
        }
        var json = safeJsonParse(text);
        var count = json && Array.isArray(json.data) ? json.data.length : 0;
        setConnResult(
          'ok',
          '✓ 测试成功 (耗时 ' + cost + ' ms' + (count ? '，可用模型 ' + count + ' 个' : '') + ')'
        );
        return;
      }

      // /models 不被支持：退化为极简 chat 请求探测
      if (res.status === 404) {
        var probe = await probeChatEndpoint(baseUrl, apiKey);
        var total = Date.now() - start;
        if (probe.ok) {
          setConnResult('ok', '✓ 测试成功 (耗时 ' + total + ' ms，/models 不可用已改用对话接口探测)');
        } else {
          setConnResult('error', '连接失败：' + probe.message);
        }
        return;
      }

      var body = '';
      try {
        body = await res.text();
      } catch (readErr) {
        body = '';
      }
      var costFail = Date.now() - start;
      setConnResult(
        'error',
        '连接失败：' + describeConnectError(res.status, res.statusText, body) +
          '（耗时 ' + costFail + ' ms）'
      );
    } catch (err) {
      setConnResult(
        'error',
        '连接失败：' + (err && err.message ? err.message : String(err))
      );
    } finally {
      if (els.testConnBtn) els.testConnBtn.disabled = false;
    }
  }

  /* ================= 设置弹窗：模型添加 / 拉取 ================= */

  /**
   * 手动添加模型到当前编辑渠道
   */
  function addModelManually() {
    if (!els.newModelId) return;

    var provider = getEditingProvider();
    if (!provider) {
      void window.showAppAlert('请先选择渠道');
      return;
    }

    var modelId = els.newModelId.value.trim();

    if (!modelId) {
      void window.showAppAlert('请填写模型 ID');
      return;
    }

    if (findProviderModel(provider, modelId)) {
      void window.showAppAlert('模型已存在');
      return;
    }

    // 别名与单价统一在上方模型列表中直接编辑，此处只写入模型 ID
    provider.models.push({
      id: modelId,
      alias: '',
      inputPrice: '',
      cachePrice: '',
      outputPrice: ''
    });
    els.newModelId.value = '';

    renderModelList();
    // 拉取面板中该模型的按钮需同步置灰
    if (!els.fetchPanel.hidden) renderFetchedList();
  }

  /**
   * 从当前编辑渠道移除模型
   */
  function removeModelFromProvider(modelId) {
    var provider = getEditingProvider();
    if (!provider) return;

    provider.models = provider.models.filter(function (model) {
      return model.id !== modelId;
    });

    renderModelList();
    if (!els.fetchPanel.hidden) renderFetchedList();
  }

  /**
   * 隐藏自动拉取面板
   */
  function hideFetchPanel() {
    if (!els.fetchPanel) return;
    els.fetchPanel.hidden = true;
    if (els.fetchList) els.fetchList.innerHTML = '';
  }

  /**
   * 拉取面板内展示提示文字
   */
  function showFetchMessage(text) {
    if (!els.fetchPanel || !els.fetchList) return;
    els.fetchPanel.hidden = false;
    els.fetchList.innerHTML = '';
    var tip = document.createElement('div');
    tip.className = 'fetch-empty';
    tip.textContent = text;
    els.fetchList.appendChild(tip);
  }

  /**
   * 渲染拉取到的模型列表（支持搜索过滤，已在渠道中的置灰）
   */
  function renderFetchedList() {
    if (!els.fetchList) return;

    var keyword = els.fetchSearch ? els.fetchSearch.value.trim().toLowerCase() : '';
    var provider = getEditingProvider();
    var existing = {};

    if (provider && Array.isArray(provider.models)) {
      provider.models.forEach(function (model) {
        existing[model.id] = true;
      });
    }

    els.fetchList.innerHTML = '';

    var shown = 0;
    fetchedModels.forEach(function (modelId) {
      if (keyword && modelId.toLowerCase().indexOf(keyword) === -1) return;
      shown++;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fetch-item';
      btn.setAttribute('data-model-id', modelId);

      var name = document.createElement('span');
      name.textContent = modelId;

      var tip = document.createElement('span');
      tip.className = 'fetch-item-tip';

      if (existing[modelId]) {
        btn.disabled = true;
        tip.textContent = '✓ 已添加';
      } else {
        tip.textContent = '添加';
      }

      btn.appendChild(name);
      btn.appendChild(tip);
      els.fetchList.appendChild(btn);
    });

    if (shown === 0) {
      var empty = document.createElement('div');
      empty.className = 'fetch-empty';
      empty.textContent = fetchedModels.length === 0 ? '未拉取到模型' : '没有匹配的模型';
      els.fetchList.appendChild(empty);
    }
  }

  /**
   * 从接口拉取模型列表
   */
  async function fetchProviderModels() {
    if (!els.cfgBaseUrl || !els.cfgApiKey) return;

    // 先把输入框内容写回草稿，保证拉取用的是该渠道的最新地址与密钥
    syncEditingProviderFields();

    var baseUrl = els.cfgBaseUrl.value.trim() || DEFAULTS.baseUrl;
    var apiKey = els.cfgApiKey.value.trim();

    if (!apiKey && providerNeedsKey(getEditingProvider())) {
      showFetchMessage('请先填写 API Key 后再拉取模型。');
      return;
    }

    if (els.fetchModelsBtn) {
      els.fetchModelsBtn.disabled = true;
      els.fetchModelsBtn.textContent = '拉取中…';
    }

    try {
      var res;
      try {
        res = await (window.MyChatProviders ? window.MyChatProviders.fetch.bind(null, getEditingProvider()) : fetch)(buildModelsUrl(baseUrl), {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': 'Bearer ' + apiKey
          },
          cache: 'no-store'
        });
      } catch (netErr) {
        throw new Error(
          '网络请求失败：' +
            (netErr && netErr.message ? netErr.message : netErr) +
            '（可能是地址错误或接口未允许跨域访问）'
        );
      }

      var text = '';
      try {
        text = await res.text();
      } catch (readErr) {
        text = '';
      }

      if (!res.ok) {
        throw new Error(describeConnectError(res.status, res.statusText, text));
      }

      var json = safeJsonParse(text);
      var list = null;
      if (json && Array.isArray(json.data)) list = json.data;
      else if (Array.isArray(json)) list = json;

      if (!list) {
        throw new Error('接口返回格式无法识别，缺少 data 数组。');
      }

      var ids = [];
      list.forEach(function (item) {
        var id = '';
        if (typeof item === 'string') id = item.trim();
        else if (item && typeof item === 'object' && typeof item.id === 'string') {
          id = item.id.trim();
        }
        if (!id) return;
        if (ids.indexOf(id) === -1) ids.push(id);
      });

      if (ids.length === 0) {
        throw new Error('接口未返回任何可用模型（data 为空）。');
      }

      fetchedModels = ids;
      if (els.fetchSearch) els.fetchSearch.value = '';
      if (els.fetchPanel) els.fetchPanel.hidden = false;
      renderFetchedList();
    } catch (err) {
      fetchedModels = [];
      showFetchMessage(
        '拉取失败：' + (err && err.message ? err.message : String(err))
      );
    } finally {
      if (els.fetchModelsBtn) {
        els.fetchModelsBtn.disabled = false;
        els.fetchModelsBtn.textContent = '拉取模型';
      }
    }
  }

  // === [ANCHOR: SETTINGS_MODAL] 左右分栏设置弹窗交互 ===
  /* ================= 设置弹窗 ================= */

  // === [ANCHOR: PASSWORD_TOGGLE] 密码框「小眼睛」显隐切换（API Key / 云同步 Token） ===

  /**
   * 同步单个密码框与其小眼睛按钮的图标状态
   * - type="password"：显示带斜杠的闭眼图标，按钮提示「显示」
   * - type="text"：显示睁开的眼睛图标，按钮提示「隐藏」
   */
  function syncPasswordToggleState(btn, input) {
    if (!btn || !input) return;
    var visible = input.type === 'text';
    btn.classList.toggle('is-visible', visible);
    btn.setAttribute('aria-label', visible ? '隐藏密钥' : '显示密钥');
    btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
    btn.title = visible ? '隐藏密钥' : '显示密钥';
  }

  /**
   * 切换指定输入框的明文 / 密文显示
   */
  function togglePasswordVisibility(btn) {
    if (!btn) return;
    var targetId = btn.getAttribute('data-target');
    var input = targetId ? document.getElementById(targetId) : null;
    if (!input) return;

    input.type = input.type === 'password' ? 'text' : 'password';
    syncPasswordToggleState(btn, input);

    // 切换后保持输入焦点，光标回到末尾，避免用户重新点击
    try {
      input.focus();
      var len = input.value ? input.value.length : 0;
      if (input.setSelectionRange) input.setSelectionRange(len, len);
    } catch (focusErr) {
      /* 某些浏览器对 password 类型不支持 setSelectionRange，忽略即可 */
    }
  }

  /**
   * 把所有密码框恢复为隐藏态（打开 / 关闭设置弹窗时调用）
   */
  function resetPasswordToggles() {
    var btns = els.passwordToggles;
    if (!btns || !btns.length) return;
    Array.prototype.forEach.call(btns, function (btn) {
      var targetId = btn.getAttribute('data-target');
      var input = targetId ? document.getElementById(targetId) : null;
      if (!input) return;
      input.type = 'password';
      syncPasswordToggleState(btn, input);
    });
  }

  /**
   * 打开设置：基于已保存渠道创建草稿，避免取消时误改
   */
  function openSettings() {
    draftProviders = cloneProviders(providers);
    // 选中目标同样进入草稿态：保存时才正式落库
    draftActiveTarget = cloneActiveTarget(activeTarget);

    // 没有任何渠道时补一个空白渠道，保证弹窗可用
    if (draftProviders.length === 0) {
      draftProviders.push({
        id: genId(),
        name: '默认渠道',
        baseUrl: DEFAULTS.baseUrl,
        apiKey: '',
        models: []
      });
    }

    // 默认编辑当前生效渠道，否则编辑第一个
    editingProviderId =
      getProviderById(activeTarget.providerId, draftProviders)
        ? activeTarget.providerId
        : draftProviders[0].id;

    // 打开期间默认对话参数也进入草稿态：不点保存绝不写库
    draftChatParams = getGlobalChatParams();

    renderProviderSelect();
    renderProviderFields();

    // 每次打开都回到默认的「模型与渠道」选项卡
    switchSettingsTab('models');

    // 回填云同步配置
    if (els.cfgSyncPlatform) {
      els.cfgSyncPlatform.value = config.syncPlatform === 'github' ? 'github' : 'gitee';
    }
    if (els.cfgSyncToken) els.cfgSyncToken.value = config.syncToken;
    if (els.cfgGistId) els.cfgGistId.value = config.gistId;
    document.getElementById('cfg-auto-sync').checked = config.autoSync === true;

    // 打开设置前先收起底部浮层，避免层级遮挡
    closeQuickModelPanel();
    closeQuickParamsPanel();
    // 回填全局默认对话参数表单
    loadChatParamsForm();
    // 每次打开都把密钥输入框恢复为隐藏态，避免明文外露
    resetPasswordToggles();

    els.modal.classList.add('show');
    els.modal.setAttribute('aria-hidden', 'false');

    if (els.providerName) els.providerName.focus();
  }

  /**
   * 切换设置弹窗中的选项卡（左导航 + 右内容联动）
   * 采用 data-tab / data-pane 约定，后续新增选项卡只需补 HTML，无需改这里
   */
  function switchSettingsTab(tabKey) {
    var key = tabKey || 'models';
    var modal = els.modal;
    if (!modal) return;

    var tabs = modal.querySelectorAll('.settings-tab');
    var panes = modal.querySelectorAll('.settings-pane');
    var matched = false;

    Array.prototype.forEach.call(tabs, function (tab) {
      var isActive = tab.getAttribute('data-tab') === key;
      if (isActive) matched = true;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    // 传入的 key 不存在时回退到第一个选项卡
    if (!matched && tabs.length > 0) {
      var firstKey = tabs[0].getAttribute('data-tab');
      if (firstKey) {
        Array.prototype.forEach.call(tabs, function (tab) {
          var isActive = tab.getAttribute('data-tab') === firstKey;
          tab.classList.toggle('active', isActive);
          tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        key = firstKey;
      }
    }

    Array.prototype.forEach.call(panes, function (pane) {
      pane.classList.toggle('active', pane.getAttribute('data-pane') === key);
    });

    // 切到「默认对话参数」时重新回填，避免显示过期的表单值
    if (key === 'params') loadChatParamsForm();
  }

  /**
   * 关闭设置：直接丢弃内存草稿（draftProviders / draftActiveTarget / draftChatParams），
   * 所有未点击「保存」的改动都不会落库，界面恢复打开前的原状
   */
  function closeSettings() {
    blurInside(els.modal);
    els.modal.classList.remove('show');
    els.modal.setAttribute('aria-hidden', 'true');
    draftProviders = null;
    draftActiveTarget = null;
    draftChatParams = null;
    fetchedModels = [];
    hideFetchPanel();
    // 关闭后统一恢复为隐藏态，下次打开不会残留明文
    resetPasswordToggles();

    // 草稿已丢弃：按已保存数据校正选中项、底部选择器与参数表单
    ensureActiveTarget();
    renderQuickModelSelect();
    loadChatParamsForm();
  }

  /**
   * 保存设置（弹窗右下角唯一入口）：
   * 把「云端同步表单 + 渠道草稿 + 默认参数草稿」一次性正式写入 localStorage，
   * 刷新全局时间戳并触发一次云同步上传，最后关闭弹窗。
   */
  function saveSettings() {
    var list = getEditingList();

    // 保存前把输入框里尚未触发 input 的改动同步进草稿
    syncEditingProviderFields();

    // 规范化草稿：名称 / 地址兜底，模型去重
    var cleaned = [];
    list.forEach(function (provider) {
      var normalized = normalizeProvider(provider);
      if (normalized) cleaned.push(normalized);
    });

    var syncPlatform =
      els.cfgSyncPlatform && els.cfgSyncPlatform.value === 'github' ? 'github' : 'gitee';
    var syncToken = els.cfgSyncToken ? els.cfgSyncToken.value.trim() : '';
    var gistId = els.cfgGistId ? els.cfgGistId.value.trim() : '';

    // 平台或令牌变更后，原先自动获取的 Gist ID 往往失效；
    // 若用户没有手动改写该项，则自动清空，交由软件重新查找/创建
    var platformChanged = syncPlatform !== config.syncPlatform;
    var tokenChanged = syncToken !== config.syncToken;
    if ((platformChanged || tokenChanged) && gistId === config.gistId) {
      gistId = '';
    }

    config.syncPlatform = syncPlatform;
    config.syncToken = syncToken;
    config.gistId = gistId;
    config.autoSync = document.getElementById('cfg-auto-sync').checked;
    if (!config.autoSync && uploadTimer) {
      clearTimeout(uploadTimer);
      uploadTimer = null;
    }

    // 1. 渠道草稿正式生效
    providers = cleaned;

    // 1.1 选中目标草稿正式生效（渠道已被删除时交给 ensureActiveTarget 纠正）
    if (draftActiveTarget && getProviderById(draftActiveTarget.providerId, providers)) {
      activeTarget = cloneActiveTarget(draftActiveTarget);
    }
    // 模型可能已被删除：先纠正为有效目标，再做后续兼容处理
    ensureActiveTarget();

    // 2. 全局默认对话参数正式生效（仅影响之后新建的会话）
    var nextChatParams = readChatParamsForm();

    // 3. 旧版字段跟随当前生效渠道，保持向下兼容
    var current = resolveActiveTarget();
    if (current) {
      config.baseUrl = current.provider.baseUrl;
      config.apiKey = current.provider.apiKey;
      config.model = current.model.id;
    }

    if (!persistProviders() || !persistConfig()) return;
    if (!persistChatParams(nextChatParams)) {
      void window.showAppAlert('浏览器存储不可用');
      return;
    }

    // 保存成功后草稿与正式数据保持一致，避免关闭时再次改动
    draftChatParams = null;

    // 渠道变化后重新校验选中目标，并刷新底部选择器
    ensureActiveTarget();
    persistActiveTarget(true);
    renderQuickModelSelect();

    closeSettings();
    setSyncStatus('idle');

    // 配置好同步后立即静默比对一次：
    // 手机端只填 Token 即可自动连上电脑端已存在的数据
    if (isSyncConfigured()) syncWithCloud(true);
  }

  /**
   * 新增渠道（仅修改草稿）
   */
  function addProvider() {
    var list = getEditingList();
    var provider = {
      id: genId(),
      name: '渠道 ' + (list.length + 1),
      baseUrl: DEFAULTS.baseUrl,
      apiKey: '',
      models: []
    };
    list.push(provider);
    editingProviderId = provider.id;

    renderProviderSelect();
    renderProviderFields();
    if (els.providerName) els.providerName.focus();
  }

  /**
   * 删除当前渠道（仅修改草稿）
   */
  async function deleteProvider() {
    var list = getEditingList();
    if (list.length <= 1) {
      void window.showAppAlert('至少保留一个渠道');
      return;
    }

    var provider = getEditingProvider();
    if (!provider || provider.builtinId) return;

    var ok = await window.showAppConfirm('删除渠道及其模型「' + (provider.name || '未命名渠道') + '」？');
    if (!ok || getEditingList() !== list || list.length <= 1 || getEditingProvider() !== provider) return;

    draftProviders = list.filter(function (item) {
      return item.id !== provider.id;
    });
    editingProviderId = draftProviders[0].id;

    renderProviderSelect();
    renderProviderFields();
  }

  /**
   * 切换设置中正在编辑的渠道
   */
  function selectProvider(providerId) {
    if (!providerId) return;
    if (!getProviderById(providerId, getEditingList())) return;
    // 切换前先保存上一渠道的输入框内容
    syncEditingProviderFields();
    editingProviderId = providerId;
    renderProviderSelect();
    renderProviderFields();
  }

  /* ================= 输入与发送状态 ================= */

  /**
   * textarea 自适应高度（随内容增高，最高 160px）
   */
  function autoGrowInput() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
  }

  /**
   * 切换发送中的忙碌状态，避免重复发送
   */
  function updateSendButtonState() {
    var session = getCurrentSession();
    var busy = isCurrentActiveChannelGenerating() || !!(session && window.MyChat.hasActiveMemoryTask &&
      window.MyChat.hasActiveMemoryTask(session.id, getActiveSubChatId(session)));
    if (els.sendBtn) {
      els.sendBtn.disabled = false;
      els.sendBtn.classList.toggle('is-stopping', busy);
      els.sendBtn.title = busy ? '点击停止生成/总结/召回' : '发送';
      els.sendBtn.setAttribute('aria-label', busy ? '停止' : '发送');
      els.sendBtn.innerHTML = busy
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg><span>停止</span>'
        : '发送';
    }
    return busy;
  }

  function stopChannelGeneration(sessionId, subChatId) {
    var key = generationKey(sessionId, subChatId);
    var run = pendingReplyRuns.get(key);
    if (run) { run.cancelled = true; pendingReplyRuns.delete(key); }
    pendingReplyPolicies.delete(key);
    window.dispatchEvent(new CustomEvent('mychat-stop-channel', {detail:{key:key}}));
    var task = activeGenerationMap.get(key);
    if (task) { task.controller.abort(); activeGenerationMap.delete(key); }
    if (window.MyChat.abortMemoryTask) window.MyChat.abortMemoryTask(sessionId, subChatId);
    syncStreamingUiState();
  }

  function syncStreamingUiState() {
    var busy = updateSendButtonState();

    // 只按当前通道禁用重答；其他通道的生成不阻塞此视图。
    if (els.chatArea) {
      var regenBtns = els.chatArea.querySelectorAll('.msg-action-btn[data-role="regen"]');
      Array.prototype.forEach.call(regenBtns, function (btn) {
        btn.disabled = busy;
      });
      var session = getCurrentSession();
      Array.prototype.forEach.call(els.chatArea.querySelectorAll('[data-role="swipe-prev"], [data-role="swipe-next"]'), function (btn) {
        var row = btn.closest('.msg');
        var msg = session && row && session.messages[Number(row.getAttribute('data-index'))];
        if (!msg || !Array.isArray(msg.swipes)) return;
        var index = normalizeSwipeIndex(msg);
        btn.disabled = busy || (btn.getAttribute('data-role') === 'swipe-prev' ? index <= 0 : index >= msg.swipes.length - 1);
      });
    }
  }

  // === [ANCHOR: PROMPT_PRESETS] 系统提示词预设：全局大预设库 + 会话绑定 + 小模块管理 ===
  /* ================= 系统提示词预设（大预设 + 可拖拽滑块小模块） ================= */

  /**
   * 生成大预设 / 小模块的唯一 ID
   */
  function genPresetId() {
    return 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  function genModuleId() {
    return 'mod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  /**
   * 规范化单个小模块：丢弃结构异常项，字段一律补全
   * roleType: 'system'（默认，合并到 #0 系统提示词）
   *           'prefill'（转为底部 Assistant 预输入）
   *           'post_history'（插在最新一条用户消息正上方）
   * keepPrefillInReply: 仅 prefill 生效，是否在 AI 气泡开头保留显示预输入文字
   */
  function normalizePresetModule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var content = typeof raw.content === 'string' ? raw.content : '';
    var roleType =
      raw.roleType === 'prefill' || raw.roleType === 'post_history' ? raw.roleType : 'system';
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : genModuleId(),
      name: typeof raw.name === 'string' ? raw.name : '',
      content: content,
      enabled: raw.enabled !== false,
      roleType: roleType,
      keepPrefillInReply: raw.keepPrefillExplicit === true && raw.keepPrefillInReply === true,
      keepPrefillExplicit: raw.keepPrefillExplicit === true
    };
  }

  /**
   * 规范化整个预设库：仅接受数组，保证每项都含 id / name / modules / regexRules
   * regexRules 为该预设专属的正则规则（三层正则之「预设层」，随预设一起云同步）
   */
  function normalizePromptPresets(raw) {
    if (!Array.isArray(raw)) return [];
    var list = [];
    raw.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var modules = [];
      if (Array.isArray(item.modules)) {
        item.modules.forEach(function (mod) {
          var normalized = normalizePresetModule(mod);
          if (normalized) modules.push(normalized);
        });
      }
      list.push({
        id: typeof item.id === 'string' && item.id ? item.id : genPresetId(),
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '未命名预设',
        modules: modules,
        // 预设专属正则：历史数据无该字段时补空数组（幂等）
        regexRules: Array.isArray(item.regexRules) ? normalizeRegexRules(item.regexRules) : []
      });
    });
    return list;
  }

  /**
   * 从 localStorage 读取全局大预设库（启动时调用）
   */
  function loadPromptPresets() {
    var raw = null;
    try {
      raw = readStorageRaw(PROMPT_PRESETS_KEY);
    } catch (err) {
      raw = null;
    }
    promptPresets = normalizePromptPresets(safeJsonParse(raw));
  }

  /**
   * 保存全局大预设库：写库 + 刷新全局时间戳 + 触发云端静默上传
   * 所有增删改（新建 / 重命名 / 删除 / 模块编辑 / 排序 / 开关）都必须走这里
   */
  function persistPromptPresets() {
    var saved = writeStorageValue(PROMPT_PRESETS_KEY, promptPresets);
    touchLastModified(); // 预设库属于全局数据，参与双向同步的新旧判定
    if (!isBooting && !applyingCloudData) scheduleCloudUpload();
    return saved;
  }

  /**
   * 按 id 查找大预设
   */
  function getPresetById(presetId) {
    if (!presetId) return null;
    for (var i = 0; i < promptPresets.length; i++) {
      if (promptPresets[i].id === presetId) return promptPresets[i];
    }
    return null;
  }

  /**
   * 取当前会话绑定的大预设：未绑定或已失效时返回 null
   */
  function getCurrentSessionPreset() {
    var session = getCurrentSession();
    if (!session) return null;
    return getPresetById(session.presetId);
  }

  /**
   * 把某个大预设下「已开启、非空、且作用方式为常规系统指令」的小模块拼接为顶部 #0 系统提示词
   * 注意：prefill / post_history 模块不参与这里，由 collectPresetRoleParts 单独收集
   * @return {string} 无可发送内容时返回空字符串
   */
  function buildPresetSystemPrompt(preset) {
    if (!preset || !Array.isArray(preset.modules)) return '';
    var parts = [];
    preset.modules.forEach(function (mod) {
      if (!mod || mod.enabled !== true) return;
      // 仅常规系统指令合并到顶部 #0
      if (mod.roleType && mod.roleType !== 'system') return;
      var content = typeof mod.content === 'string' ? mod.content.trim() : '';
      if (!content) return;
      parts.push(content);
    });
    return parts.join('\n\n');
  }

  /**
   * 收集某个预设下「已开启且非空」的预输入 / 后置强指令模块
   * @return {{ prefillText: string, postHistoryText: string, keepPrefill: boolean }}
   *   prefillText    : 所有 prefill 模块拼接文本（作为最后一条 assistant 消息）
   *   postHistoryText: 所有 post_history 模块拼接文本（插在最新用户消息上方）
   *   keepPrefill    : 是否至少有一个 prefill 模块要求保留显示（多个模块时任一勾选即保留）
   */
  function collectPresetRoleParts(preset) {
    var prefillParts = [];
    var postParts = [];
    var keepPrefill = false;
    if (preset && Array.isArray(preset.modules)) {
      preset.modules.forEach(function (mod) {
        if (!mod || mod.enabled !== true) return;
        var content = typeof mod.content === 'string' ? mod.content.trim() : '';
        if (!content) return;
        if (mod.roleType === 'prefill') {
          prefillParts.push(content);
          if (mod.keepPrefillInReply === true) keepPrefill = true;
        } else if (mod.roleType === 'post_history') {
          postParts.push(content);
        }
      });
    }
    return {
      prefillText: prefillParts.join('\n\n'),
      postHistoryText: postParts.join('\n\n'),
      keepPrefill: keepPrefill
    };
  }

  /**
   * 按当前会话绑定的预设拼出要发送的系统提示词（供请求组装调用）
   */
  function buildSessionSystemPrompt(session) {
    if (!session || !session.presetId) return '';
    return buildPresetSystemPrompt(getPresetById(session.presetId));
  }

  /**
   * 同步顶部入口按钮的高亮状态：已绑定有效大预设时轻微高亮
   */
  function refreshPresetButtonState() {
    var active = !!getCurrentSessionPreset();
    if (els.presetBtn) {
      els.presetBtn.classList.toggle('has-active', active);
      els.presetBtn.title = active
        ? '系统提示词预设（当前已启用）'
        : '系统提示词预设';
    }
    // 顶部 #0 一站式控制台入口同步刷新
    refreshTopPresetUI();
  }

  /**
   * 打开预设管理弹窗并渲染
   */
  function openPresetModal() {
    if (!els.presetModal) return;
    renderPresetSelect();
    renderPresetModules();
    els.presetModal.classList.add('show');
    els.presetModal.setAttribute('aria-hidden', 'false');
  }

  /**
   * 关闭预设管理弹窗（同时关闭小模块编辑窗口，未保存的修改一律丢弃）
   */
  function closePresetModal() {
    closeModuleEditModal();
    if (!els.presetModal) return;
    blurInside(els.presetModal);
    els.presetModal.classList.remove('show');
    els.presetModal.setAttribute('aria-hidden', 'true');
  }

  /**
   * 渲染大预设下拉框：首项固定为「未选择预设」占位符，值与当前会话同步
   */
  function renderPresetSelect() {
    if (!els.presetSelect) return;
    var session = getCurrentSession();
    var selectedId = session && getPresetById(session.presetId) ? session.presetId : '';

    els.presetSelect.innerHTML = '';

    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '未选择预设（不使用系统提示词）';
    els.presetSelect.appendChild(placeholder);

    promptPresets.forEach(function (preset) {
      var opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.name;
      els.presetSelect.appendChild(opt);
    });

    els.presetSelect.value = selectedId;
    renderPresetPicker(els.presetSelect);
    updatePresetToolbarState(selectedId);
  }

  /**
   * 未选择大预设时禁用「重命名 / 删除预设 / + 新增小模块」
   */
  function updatePresetToolbarState(selectedId) {
    var disabled = !selectedId;
    if (els.presetRenameBtn) els.presetRenameBtn.disabled = disabled;
    if (els.presetDeleteBtn) els.presetDeleteBtn.disabled = disabled;
    if (els.presetAddModuleBtn) els.presetAddModuleBtn.disabled = disabled;
  }

  /**
   * 渲染小模块列表：支持拖拽排序 + 滑块开关
   */
  function renderPresetModules() {
    if (!els.presetModuleList) return;
    els.presetModuleList.innerHTML = '';

    var session = getCurrentSession();
    var preset = session && getPresetById(session.presetId) ? getPresetById(session.presetId) : null;

    if (!preset) {
      els.presetModuleList.appendChild(
        createPresetEmptyTip('当前对话未启用系统提示词预设，请从上方选择或新建预设')
      );
      return;
    }

    if (!Array.isArray(preset.modules) || preset.modules.length === 0) {
      els.presetModuleList.appendChild(
        createPresetEmptyTip('当前预设暂无小模块，请点击上方「+ 新增小模块」添加')
      );
      return;
    }

    preset.modules.forEach(function (mod) {
      els.presetModuleList.appendChild(createPresetModuleRow(preset, mod));
    });
  }

  /**
   * 构建列表空状态提示（干净的居中文字）
   */
  function createPresetEmptyTip(text) {
    var tip = document.createElement('div');
    tip.className = 'preset-empty';
    tip.textContent = text;
    return tip;
  }

  /**
   * 构建单个小模块条目：拖拽手柄 + 名称区 + 纯 CSS 滑块开关
   */
  function createPresetModuleRow(preset, mod) {
    var row = document.createElement('div');
    row.className = 'preset-module-item';
    row.setAttribute('data-module-id', mod.id);
    row.setAttribute('draggable', 'true');

    // 1. 左侧拖拽手柄
    var handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⋮⋮';
    handle.title = '按住拖动调整顺序';
    handle.setAttribute('aria-hidden', 'true');

    // 2. 中间小模块名称（点击打开独立编辑窗口）
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'module-name-trigger';
    trigger.title = '点击编辑该小模块';

    var nameEl = document.createElement('span');
    nameEl.className = 'module-name';
    nameEl.textContent = mod.name || '未命名模块';

    var previewEl = document.createElement('span');
    previewEl.className = 'module-preview';
    previewEl.textContent = (mod.content || '').replace(/\s+/g, ' ').trim() || '（暂无内容）';

    trigger.appendChild(nameEl);
    trigger.appendChild(previewEl);
    trigger.addEventListener('click', function () {
      // 触摸拖拽松手后浏览器可能补发 click，这里跳过以免误开编辑窗口
      if (row._dragMoved) {
        row._dragMoved = false;
        return;
      }
      openModuleEditModal(preset.id, mod.id);
    });

    // 3. 右侧纯 CSS 胶囊滑块开关
    var switchLabel = document.createElement('label');
    switchLabel.className = 'switch';
    switchLabel.title = mod.enabled === true ? '点击关闭该模块' : '点击开启该模块';

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = mod.enabled === true;
    checkbox.addEventListener('change', function () {
      mod.enabled = checkbox.checked;
      switchLabel.title = mod.enabled ? '点击关闭该模块' : '点击开启该模块';
      persistPromptPresets();
    });

    var slider = document.createElement('span');
    slider.className = 'slider';

    switchLabel.appendChild(checkbox);
    switchLabel.appendChild(slider);

    row.appendChild(handle);
    row.appendChild(trigger);
    row.appendChild(switchLabel);

    bindModuleDragSort(row, handle);

    return row;
  }

  /**
   * 把 DOM 中的实际顺序回写到对应大预设的 modules 数组并持久化
   */
  function commitModuleOrder(preset) {
    if (!els.presetModuleList) return;
    var rows = els.presetModuleList.querySelectorAll('.preset-module-item');
    var map = {};
    preset.modules.forEach(function (mod) {
      map[mod.id] = mod;
    });

    var ordered = [];
    Array.prototype.forEach.call(rows, function (row) {
      var id = row.getAttribute('data-module-id');
      if (id && map[id]) {
        ordered.push(map[id]);
        delete map[id];
      }
    });
    // 兜底：极端情况下未被渲染的模块追加到末尾，避免数据丢失
    preset.modules.forEach(function (mod) {
      if (map[mod.id]) ordered.push(mod);
    });

    preset.modules = ordered;
    persistPromptPresets();
  }

  /**
   * 原生 HTML5 拖拽 + 移动端触摸拖拽排序（无「上移 / 下移」按钮）
   */
  function bindModuleDragSort(row, handle) {
    row.addEventListener('dragstart', function (e) {
      if (!e.dataTransfer) return;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', row.getAttribute('data-module-id') || '');
      } catch (err) {
        /* 部分浏览器禁止写入自定义数据，忽略即可 */
      }
    });

    row.addEventListener('dragend', function () {
      row.classList.remove('dragging');
      var preset = getCurrentSessionPreset();
      if (preset) commitModuleOrder(preset);
    });

    if (!els.presetModuleList) return;

    // 触摸拖动：以 elementFromPoint 定位目标行后实时换位
    var touchStartY = 0;
    handle.addEventListener('touchstart', function (e) {
      if (!e.touches || !e.touches.length) return;
      touchStartY = e.touches[0].clientY;
      row.classList.add('dragging');
    }, { passive: true });

    handle.addEventListener('touchmove', function (e) {
      if (!row.classList.contains('dragging') || !e.touches || !e.touches.length) return;
      if (Math.abs(e.touches[0].clientY - touchStartY) < 6) return;
      e.preventDefault();
      row._dragMoved = true;

      var point = e.touches[0];
      var overEl = document.elementFromPoint(point.clientX, point.clientY);
      var targetRow = overEl && overEl.closest ? overEl.closest('.preset-module-item') : null;
      if (!targetRow || targetRow === row) return;

      var rect = targetRow.getBoundingClientRect();
      if (point.clientY < rect.top + rect.height / 2) {
        els.presetModuleList.insertBefore(row, targetRow);
      } else {
        els.presetModuleList.insertBefore(row, targetRow.nextSibling);
      }
    }, { passive: false });

    handle.addEventListener('touchend', function () {
      if (!row.classList.contains('dragging')) return;
      row.classList.remove('dragging');
      var preset = getCurrentSessionPreset();
      if (preset) commitModuleOrder(preset);
    });

    handle.addEventListener('touchcancel', function () {
      row.classList.remove('dragging');
      var preset = getCurrentSessionPreset();
      if (preset) commitModuleOrder(preset);
    });
  }

  /**
   * 列表容器上的 dragover：实时把拖拽行移动到光标位置
   * （仅在 bindEvents 中绑定一次，避免每个条目重复绑定造成排序抖动）
   */
  function handleModuleDragOver(e) {
    if (!els.presetModuleList) return;
    var dragging = els.presetModuleList.querySelector('.preset-module-item.dragging');
    if (!dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    var afterEl = getDragAfterElement(els.presetModuleList, e.clientY);
    if (afterEl === null) {
      els.presetModuleList.appendChild(dragging);
    } else if (afterEl !== dragging) {
      els.presetModuleList.insertBefore(dragging, afterEl);
    }
  }

  /**
   * 找到拖拽时应插入到其前面的行（依据鼠标纵坐标）
   */
  function getDragAfterElement(container, y) {
    var rows = Array.prototype.slice.call(
      container.querySelectorAll('.preset-module-item:not(.dragging)')
    );
    var closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    rows.forEach(function (row) {
      var rect = row.getBoundingClientRect();
      var offset = y - rect.top - rect.height / 2;
      if (offset < 0 && offset > closest.offset) {
        closest = { offset: offset, element: row };
      }
    });
    return closest.element;
  }

  /**
   * 切换当前对话绑定的大预设：仅更新当前会话的 presetId（占位符 => null）
   */
  function handlePresetSelectChange(value) {
    var session = getCurrentSession();
    if (!session) return;

    var presetId = value && getPresetById(value) ? value : null;
    session.presetId = presetId;
    session.updatedAt = Date.now();
    persistSessions();
    touchLastModified();
    if (!isBooting && !applyingCloudData) scheduleCloudUpload();

    updatePresetToolbarState(presetId || '');
    renderPresetModules();
    refreshPresetButtonState();
    refreshMemoryContext();

    // 顶部 #0 下拉面板同步（若正展开则立即重绘）
    if (topPresetOpen) {
      renderTopPresetSelect();
      renderTopPresetModules();
    }
  }

  /**
   * 新建大预设：输入名称后自动切换到该新预设
   */
  async function createPresetFlow() {
    var name = await window.showAppPrompt('预设名称', '新预设');
    if (name === null) return;
    name = name.trim();
    if (!name) {
      void window.showAppAlert('预设名称不能为空');
      return;
    }

    var preset = {
      id: genPresetId(),
      name: name,
      modules: [],
      // 预设专属正则规则（三层正则之「预设层」）
      regexRules: []
    };
    promptPresets.push(preset);

    // 创建后自动把当前对话切换到该新大预设
    var session = getCurrentSession();
    if (session) {
      session.presetId = preset.id;
      session.updatedAt = Date.now();
      persistSessions();
    }

    persistPromptPresets();
    renderPresetSelect();
    renderPresetModules();
    refreshPresetButtonState();
    if (topPresetOpen) {
      renderTopPresetSelect();
      renderTopPresetModules();
    }
  }

  /**
   * 重命名当前选中大预设
   */
  async function renamePresetFlow() {
    var preset = getCurrentSessionPreset();
    if (!preset) return;

    var name = await window.showAppPrompt('预设名称', preset.name);
    if (name === null || getPresetById(preset.id) !== preset) return;
    name = name.trim();
    if (!name) {
      void window.showAppAlert('预设名称不能为空');
      return;
    }

    preset.name = name;
    persistPromptPresets();
    renderPresetSelect();
    renderPresetModules();
    refreshTopPresetUI();
    if (topPresetOpen) {
      renderTopPresetSelect();
      renderTopPresetModules();
    }
  }

  /**
   * 删除指定或当前预设：确认后绑定首个剩余项，至少保留一个。
   */
  async function deletePresetFlow(presetId) {
    var preset = typeof presetId === 'string' ? getPresetById(presetId) : getCurrentSessionPreset();
    if (!preset) return;
    if (promptPresets.length <= 1) { showToast('至少保留一个预设'); return; }

    var ok = await window.showAppConfirm('删除预设「' + preset.name + '」？');
    if (!ok || getPresetById(preset.id) !== preset || promptPresets.length <= 1) return;

    promptPresets = promptPresets.filter(function (item) {
      return item.id !== preset.id;
    });

    // 所有绑定了该预设的会话回退到首项，避免留下失效引用。
    sessions.forEach(function (session) {
      if (session.presetId === preset.id) session.presetId = promptPresets[0].id;
    });

    persistSessions();
    persistPromptPresets();
    renderPresetSelect();
    renderPresetModules();
    refreshPresetButtonState();
    refreshMemoryContext();
    if (topPresetOpen) {
      renderTopPresetSelect();
      renderTopPresetModules();
    }
  }

  /**
   * 打开小模块独立编辑窗口
   * @param {string} presetId 所属大预设
   * @param {string|null} moduleId 传 null 表示新增模块
   */
  function openModuleEditModal(presetId, moduleId) {
    var preset = getPresetById(presetId);
    if (!preset || !els.moduleEditModal) return;

    var mod = null;
    if (moduleId) {
      preset.modules.forEach(function (item) {
        if (item.id === moduleId) mod = item;
      });
      if (!mod) return;
    }

    editingModuleRef = { presetId: presetId, moduleId: moduleId || null };

    els.moduleNameInput.value = mod ? mod.name : '';
    els.moduleContentInput.value = mod ? mod.content : '';

    // 模块作用方式：老数据没有 roleType 一律按常规系统指令处理
    var roleType = mod && mod.roleType ? mod.roleType : 'system';
    if (els.moduleRoleSelect) els.moduleRoleSelect.value = roleType;
    if (els.moduleKeepPrefillInput) {
      els.moduleKeepPrefillInput.checked = !!(mod && mod.keepPrefillInReply === true);
    }
    syncPrefillOptionVisibility(roleType);

    if (els.moduleDeleteBtn) els.moduleDeleteBtn.hidden = !mod;

    els.moduleEditModal.classList.add('show');
    els.moduleEditModal.setAttribute('aria-hidden', 'false');
    els.moduleNameInput.focus();
  }

  /**
   * 按当前所选作用方式显示 / 隐藏「保留预输入显示」勾选项（仅 prefill 需要）
   */
  function syncPrefillOptionVisibility(roleType) {
    if (!els.modulePrefillOption) return;
    els.modulePrefillOption.hidden = roleType !== 'prefill';
  }

  /**
   * 关闭小模块编辑窗口：不做任何保存（严格保存门禁）
   */
  function closeModuleEditModal() {
    editingModuleRef = null;
    if (!els.moduleEditModal) return;
    blurInside(els.moduleEditModal);
    els.moduleEditModal.classList.remove('show');
    els.moduleEditModal.setAttribute('aria-hidden', 'true');
  }

  /**
   * 保存小模块：只有点击「保存」才写入所属大预设并刷新列表
   */
  function saveModuleFromEditor() {
    if (!editingModuleRef) return;
    var preset = getPresetById(editingModuleRef.presetId);
    if (!preset) {
      closeModuleEditModal();
      return;
    }

    var name = (els.moduleNameInput.value || '').trim();
    if (!name) {
      window.showAppAlert('请填写模块名称').then(function () { els.moduleNameInput.focus(); });
      return;
    }
    var content = els.moduleContentInput.value || '';
    var roleType = els.moduleRoleSelect ? els.moduleRoleSelect.value : 'system';
    if (roleType !== 'prefill' && roleType !== 'post_history') roleType = 'system';
    // 勾选项仅对 prefill 生效，避免切换作用方式后残留脏数据
    var keepPrefill =
      roleType === 'prefill' && els.moduleKeepPrefillInput
        ? els.moduleKeepPrefillInput.checked === true
        : false;

    if (editingModuleRef.moduleId) {
      // 编辑已有模块
      var found = null;
      preset.modules.forEach(function (item) {
        if (item.id === editingModuleRef.moduleId) found = item;
      });
      if (!found) {
        closeModuleEditModal();
        return;
      }
      found.name = name;
      found.content = content;
      found.roleType = roleType;
      found.keepPrefillInReply = keepPrefill;
      found.keepPrefillExplicit = true;
    } else {
      // 新增模块
      preset.modules.push({
        id: genModuleId(),
        name: name,
        content: content,
        enabled: true,
        roleType: roleType,
        keepPrefillInReply: keepPrefill,
        keepPrefillExplicit: true
      });
    }

    persistPromptPresets();
    closeModuleEditModal();
    renderPresetModules();
    // 顶部 #0 下拉内的模块列表同步刷新（弹窗关闭后仍保持展开状态）
    renderTopPresetModules();
  }

  /**
   * 删除当前编辑中的小模块（二次确认）
   */
  async function deleteModuleFromEditor() {
    if (!editingModuleRef || !editingModuleRef.moduleId) return;
    var preset = getPresetById(editingModuleRef.presetId);
    if (!preset) return;

    var ref = editingModuleRef;
    var ok = await window.showAppConfirm('删除该小模块？');
    if (!ok || editingModuleRef !== ref || getPresetById(preset.id) !== preset) return;

    var targetId = editingModuleRef.moduleId;
    preset.modules = preset.modules.filter(function (item) {
      return item.id !== targetId;
    });

    persistPromptPresets();
    closeModuleEditModal();
    renderPresetModules();
    renderTopPresetModules();
  }

  // === [ANCHOR: TOP_PRESET_CONSOLE] 顶部 #0 一站式预设控制台 ===
  /* ============ 顶部 #0 常驻入口 + 下拉面板 ============ */

  /**
   * 刷新顶部 #0 入口文案与高亮状态（每次会话切换 / 预设变更后调用）
   */
  function refreshTopPresetUI() {
    var preset = getCurrentSessionPreset();
    if (els.topPresetLabel) {
      els.topPresetLabel.textContent = preset ? preset.name : '未启用预设';
    }
    if (els.topPresetTrigger) {
      els.topPresetTrigger.classList.toggle('has-active', !!preset);
      els.topPresetTrigger.title = preset
        ? '#0 系统提示词：# ' + preset.name + '（点击管理）'
        : '#0 系统提示词：未启用预设（点击管理）';
    }
  }

  /**
   * 打开顶部 #0 下拉面板（同时渲染预设下拉框与模块列表）
   */
  function openTopPresetDropdown() {
    if (!els.topPresetDropdown) return;
    renderTopPresetSelect();
    renderTopPresetModules();
    els.topPresetDropdown.hidden = false;
    topPresetOpen = true;
    if (els.topPresetTrigger) els.topPresetTrigger.setAttribute('aria-expanded', 'true');
    if (els.tpPreviewBtn) els.tpPreviewBtn.disabled = !getCurrentSessionPreset();
  }

  /**
   * 收起顶部 #0 下拉面板
   */
  function closeTopPresetDropdown() {
    if (!els.topPresetDropdown) return;
    els.topPresetDropdown.hidden = true;
    document.querySelectorAll('.preset-picker-menu').forEach(function (menu) {
      menu.hidden = true;
      if (menu._presetOwner) menu._presetOwner.firstElementChild.setAttribute('aria-expanded', 'false');
    });
    topPresetOpen = false;
    if (els.topPresetTrigger) els.topPresetTrigger.setAttribute('aria-expanded', 'false');
  }

  /**
   * 切换顶部 #0 下拉面板展开 / 收起
   */
  function toggleTopPresetDropdown() {
    if (topPresetOpen) {
      closeTopPresetDropdown();
    } else {
      openTopPresetDropdown();
    }
  }

  /**
   * 渲染顶部下拉的大预设选择框（首项为「不启用预设」）
   */
  function renderTopPresetSelect() {
    if (!els.topPresetSelect) return;
    var session = getCurrentSession();
    var selectedId = session && getPresetById(session.presetId) ? session.presetId : '';

    els.topPresetSelect.innerHTML = '';

    var none = document.createElement('option');
    none.value = '';
    none.textContent = '不启用预设（无系统提示词）';
    els.topPresetSelect.appendChild(none);

    promptPresets.forEach(function (preset) {
      var opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.name;
      els.topPresetSelect.appendChild(opt);
    });

    els.topPresetSelect.value = selectedId;
    renderPresetPicker(els.topPresetSelect);
    updateTopPresetToolbarState(selectedId);
  }

  // 保留原生选择器作为同步源；可见选项支持独立删除，不触发选择切换。
  function renderPresetPicker(select) {
    var wrap = select.parentElement.querySelector('.preset-picker');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'preset-picker';
      select.insertAdjacentElement('afterend', wrap);
      select.hidden = true;
      wrap.innerHTML = '<button type="button" class="tp-select preset-picker-trigger" aria-expanded="false" title="切换预设"></button><div class="preset-picker-menu" hidden></div>';
      var floatingMenu = wrap.lastElementChild;
      wrap._menu = floatingMenu;
      floatingMenu._presetOwner = wrap;
      document.body.appendChild(floatingMenu);
      function closePicker() {
        floatingMenu.hidden = true;
        wrap.firstElementChild.setAttribute('aria-expanded', 'false');
      }
      function positionPicker() {
        if (floatingMenu.hidden) return;
        if (!wrap.getClientRects().length) { closePicker(); return; }
        var rect = wrap.firstElementChild.getBoundingClientRect();
        var width = Math.min(240, window.innerWidth - 24);
        var below = window.innerHeight - rect.bottom - 16;
        var above = rect.top - 16;
        var up = below < 160 && above > below;
        floatingMenu.style.position = 'fixed';
        floatingMenu.style.zIndex = '110';
        floatingMenu.style.width = width + 'px';
        floatingMenu.style.maxHeight = Math.max(0, Math.min(280, up ? above : below)) + 'px';
        floatingMenu.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
        floatingMenu.style.top = (up ? Math.max(12, rect.top - floatingMenu.offsetHeight - 4) : rect.bottom + 4) + 'px';
      }
      wrap._positionMenu = positionPicker;
      wrap.firstElementChild.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var opening = floatingMenu.hidden;
        document.querySelectorAll('.preset-picker-menu').forEach(function (other) {
          other.hidden = true;
          if (other._presetOwner) other._presetOwner.firstElementChild.setAttribute('aria-expanded', 'false');
        });
        floatingMenu.hidden = !opening;
        wrap.firstElementChild.setAttribute('aria-expanded', String(opening));
        positionPicker();
      });
      // 在重绘移除选项之前截断冒泡，不让外部关闭逻辑误判旧节点。
      floatingMenu.addEventListener('click', function (e) { e.stopPropagation(); });
      document.addEventListener('click', function (e) {
        var path = e.composedPath ? e.composedPath() : [];
        if (path.indexOf(wrap) < 0 && path.indexOf(floatingMenu) < 0 &&
            !wrap.contains(e.target) && !floatingMenu.contains(e.target) &&
            !e.target.closest('.app-dialog-overlay, .feature-help-overlay')) closePicker();
      });
      window.addEventListener('resize', positionPicker);
      window.addEventListener('scroll', positionPicker, true);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !floatingMenu.hidden && !document.querySelector('.app-dialog-overlay:not([hidden])')) {
          closePicker(); e.stopPropagation();
        }
      }, true);
    }
    wrap.firstElementChild.textContent = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : '不启用预设';
    var menu = wrap._menu;
    menu.innerHTML = '';
    Array.from(select.options).forEach(function (option) {
      var row = document.createElement('div');
      row.className = 'preset-picker-option';
      var choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'preset-picker-name';
      choose.textContent = option.textContent;
      choose.title = option.textContent;
      choose.setAttribute('aria-pressed', String(option.value === select.value));
      choose.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        select.value = option.value;
        select.dispatchEvent(new Event('change', {bubbles:true}));
        renderPresetPicker(select);
        menu.hidden = true;
        wrap.firstElementChild.setAttribute('aria-expanded', 'false');
      });
      row.appendChild(choose);
      if (option.value) {
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'preset-picker-delete';
        remove.title = promptPresets.length <= 1 ? '至少保留一个预设' : '删除此预设';
        remove.setAttribute('aria-label', remove.title);
        remove.disabled = promptPresets.length <= 1;
        remove.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
        remove.addEventListener('click', async function (e) {
          e.preventDefault();
          e.stopPropagation();
          await deletePresetFlow(option.value);
          renderPresetPicker(select);
          menu.hidden = false;
          wrap.firstElementChild.setAttribute('aria-expanded', 'true');
          wrap._positionMenu();
        });
        row.appendChild(remove);
      }
      menu.appendChild(row);
    });
    wrap._positionMenu();
  }

  /**
   * 未选择预设时禁用重命名 / 删除 / 新增模块 / 预览
   */
  function updateTopPresetToolbarState(selectedId) {
    var disabled = !selectedId;
    if (els.tpRenameBtn) els.tpRenameBtn.disabled = disabled;
    if (els.tpDeleteBtn) els.tpDeleteBtn.disabled = disabled;
    if (els.tpAddModuleBtn) els.tpAddModuleBtn.disabled = disabled;
    if (els.tpPreviewBtn) els.tpPreviewBtn.disabled = disabled;
  }

  /**
   * 渲染顶部下拉的小模块列表（自动展开，无需再点开内容）
   */
  function renderTopPresetModules() {
    if (!els.tpModuleList) return;
    els.tpModuleList.innerHTML = '';

    var preset = getCurrentSessionPreset();
    if (!preset) {
      els.tpModuleList.appendChild(
        createPresetEmptyTip('当前对话未启用系统提示词预设，请在上方选择或新建预设')
      );
      return;
    }

    if (!Array.isArray(preset.modules) || preset.modules.length === 0) {
      els.tpModuleList.appendChild(
        createPresetEmptyTip('当前预设暂无小模块，请点击底部「+ 新增小模块」添加')
      );
      return;
    }

    preset.modules.forEach(function (mod) {
      els.tpModuleList.appendChild(createTopModuleRow(preset, mod));
    });
  }

  /**
   * 构建模块作用方式胶囊元素（system 返回 null，不渲染）
   */
  function buildModuleRolePill(roleType) {
    if (roleType !== 'prefill' && roleType !== 'post_history') return null;
    var pill = document.createElement('span');
    pill.className = 'module-role-pill module-role-' + roleType;
    pill.textContent = roleType === 'prefill' ? '[预输入]' : '[后置]';
    pill.title =
      roleType === 'prefill'
        ? '该模块作为 Assistant 预输入，置于发送消息最末尾引导 AI 续写'
        : '该模块作为后置强指令，插在最新一条用户消息正上方';
    return pill;
  }

  /**
   * 构建顶部下拉内的小模块行：
   * 拖拽手柄 ⠿ + 名称 + 铅笔编辑 + 删除 × + 纯 CSS 胶囊开关
   */
  function createTopModuleRow(preset, mod) {
    var row = document.createElement('div');
    row.className = 'preset-module-item';
    row.setAttribute('data-module-id', mod.id);
    row.setAttribute('data-floor', mod.id);
    row.setAttribute('draggable', 'true');

    // 1. 拖拽手柄
    var handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = '按住拖动调整顺序';
    handle.setAttribute('aria-hidden', 'true');

    // 2. 名称 + 内容预览（点击整块也可编辑）
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'module-name-trigger';
    trigger.title = '点击编辑该小模块';

    var nameEl = document.createElement('span');
    nameEl.className = 'module-name';
    nameEl.textContent = mod.name || '未命名模块';

    // 作用方式胶囊：预输入 / 后置（常规系统指令不显示标签，保持列表清爽）
    var rolePill = buildModuleRolePill(mod.roleType);

    var previewEl = document.createElement('span');
    previewEl.className = 'module-preview';
    previewEl.textContent = (mod.content || '').replace(/\s+/g, ' ').trim() || '（暂无内容）';

    trigger.appendChild(nameEl);
    if (rolePill) trigger.appendChild(rolePill);
    trigger.appendChild(previewEl);
    trigger.addEventListener('click', function () {
      if (row._dragMoved) {
        row._dragMoved = false;
        return;
      }
      openModuleEditModal(preset.id, mod.id);
    });

    // 3. 操作组：铅笔编辑 + 删除 ×
    var actions = document.createElement('div');
    actions.className = 'module-row-actions';

    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'module-icon-btn';
    editBtn.title = '编辑该模块';
    editBtn.setAttribute('aria-label', '编辑该模块');
    var pencil = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    pencil.setAttribute('viewBox', '0 0 24 24');
    pencil.setAttribute('width', '14');
    pencil.setAttribute('height', '14');
    pencil.setAttribute('fill', 'none');
    pencil.setAttribute('stroke', 'currentColor');
    pencil.setAttribute('stroke-width', '1.8');
    pencil.setAttribute('stroke-linecap', 'round');
    pencil.setAttribute('stroke-linejoin', 'round');
    pencil.setAttribute('aria-hidden', 'true');
    [
      ['path', { d: 'M4.5 19.5h4l10-10a2.3 2.3 0 0 0-3.2-3.2l-10 10z' }],
      ['path', { d: 'M14.2 7.2l2.6 2.6' }]
    ].forEach(function (def) {
      var el = document.createElementNS('http://www.w3.org/2000/svg', def[0]);
      Object.keys(def[1]).forEach(function (key) {
        el.setAttribute(key, def[1][key]);
      });
      pencil.appendChild(el);
    });
    editBtn.appendChild(pencil);
    editBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      openModuleEditModal(preset.id, mod.id);
    });

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'module-icon-btn module-delete-x';
    delBtn.title = '删除该模块';
    delBtn.setAttribute('aria-label', '删除该模块');
    var cross = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    cross.setAttribute('viewBox', '0 0 24 24');
    cross.setAttribute('width', '14');
    cross.setAttribute('height', '14');
    cross.setAttribute('fill', 'none');
    cross.setAttribute('stroke', 'currentColor');
    cross.setAttribute('stroke-width', '2');
    cross.setAttribute('stroke-linecap', 'round');
    cross.setAttribute('aria-hidden', 'true');
    [
      ['line', { x1: '6', y1: '6', x2: '18', y2: '18' }],
      ['line', { x1: '18', y1: '6', x2: '6', y2: '18' }]
    ].forEach(function (def) {
      var el = document.createElementNS('http://www.w3.org/2000/svg', def[0]);
      Object.keys(def[1]).forEach(function (key) {
        el.setAttribute(key, def[1][key]);
      });
      cross.appendChild(el);
    });
    delBtn.appendChild(cross);
    delBtn.addEventListener('click', async function (event) {
      event.stopPropagation();
      var ok = await window.showAppConfirm('删除模块「' + (mod.name || '未命名模块') + '」？');
      if (!ok || getPresetById(preset.id) !== preset) return;
      preset.modules = preset.modules.filter(function (item) {
        return item.id !== mod.id;
      });
      persistPromptPresets();
      renderTopPresetModules();
      renderPresetModules();
    });

    // 4. 纯 CSS 胶囊开关：切换即时保存
    var switchLabel = document.createElement('label');
    switchLabel.className = 'switch';
    switchLabel.title = mod.enabled === true ? '点击关闭该模块' : '点击开启该模块';

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = mod.enabled === true;
    checkbox.addEventListener('change', function () {
      mod.enabled = checkbox.checked;
      switchLabel.title = mod.enabled ? '点击关闭该模块' : '点击开启该模块';
      persistPromptPresets();
    });

    var slider = document.createElement('span');
    slider.className = 'slider';

    switchLabel.appendChild(checkbox);
    switchLabel.appendChild(slider);

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    row.appendChild(handle);
    row.appendChild(trigger);
    row.appendChild(actions);
    row.appendChild(switchLabel);

    bindTopModuleDragSort(row, handle, preset);

    return row;
  }

  /**
   * 把顶部下拉 DOM 中的实际顺序回写到预设 modules 并持久化
   */
  function commitTopModuleOrder(preset) {
    if (!preset || !els.tpModuleList) return;
    var rows = els.tpModuleList.querySelectorAll('.preset-module-item');
    var map = {};
    preset.modules.forEach(function (mod) {
      map[mod.id] = mod;
    });

    var ordered = [];
    Array.prototype.forEach.call(rows, function (row) {
      var id = row.getAttribute('data-module-id');
      if (id && map[id]) {
        ordered.push(map[id]);
        delete map[id];
      }
    });
    preset.modules.forEach(function (mod) {
      if (map[mod.id]) ordered.push(mod);
    });

    preset.modules = ordered;
    persistPromptPresets();
    renderPresetModules();
  }

  /**
   * 顶部下拉内模块行的拖拽排序（HTML5 拖拽 + 触摸拖动）
   */
  function bindTopModuleDragSort(row, handle, preset) {
    row.addEventListener('dragstart', function (e) {
      if (!e.dataTransfer) return;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', row.getAttribute('data-module-id') || '');
      } catch (err) {
        /* 部分浏览器禁止写入自定义数据，忽略 */
      }
    });

    row.addEventListener('dragend', function () {
      row.classList.remove('dragging');
      commitTopModuleOrder(preset);
    });

    var touchStartY = 0;
    handle.addEventListener('touchstart', function (e) {
      if (!e.touches || !e.touches.length) return;
      touchStartY = e.touches[0].clientY;
      row.classList.add('dragging');
    }, { passive: true });

    handle.addEventListener('touchmove', function (e) {
      if (!row.classList.contains('dragging') || !e.touches || !e.touches.length) return;
      if (Math.abs(e.touches[0].clientY - touchStartY) < 6) return;
      e.preventDefault();
      row._dragMoved = true;

      var point = e.touches[0];
      var overEl = document.elementFromPoint(point.clientX, point.clientY);
      var targetRow = overEl && overEl.closest ? overEl.closest('.preset-module-item') : null;
      if (!targetRow || targetRow === row || !els.tpModuleList) return;

      var rect = targetRow.getBoundingClientRect();
      if (point.clientY < rect.top + rect.height / 2) {
        els.tpModuleList.insertBefore(row, targetRow);
      } else {
        els.tpModuleList.insertBefore(row, targetRow.nextSibling);
      }
    }, { passive: false });

    handle.addEventListener('touchend', function () {
      if (!row.classList.contains('dragging')) return;
      row.classList.remove('dragging');
      commitTopModuleOrder(preset);
    });

    handle.addEventListener('touchcancel', function () {
      row.classList.remove('dragging');
      commitTopModuleOrder(preset);
    });
  }

  /**
   * 顶部下拉容器上的 dragover：实时把拖拽行移动到光标位置
   */
  function handleTopModuleDragOver(e) {
    if (!els.tpModuleList) return;
    var dragging = els.tpModuleList.querySelector('.preset-module-item.dragging');
    if (!dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    var rows = Array.prototype.slice.call(
      els.tpModuleList.querySelectorAll('.preset-module-item:not(.dragging)')
    );
    var closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    rows.forEach(function (item) {
      var rect = item.getBoundingClientRect();
      var offset = e.clientY - rect.top - rect.height / 2;
      if (offset < 0 && offset > closest.offset) {
        closest = { offset: offset, element: item };
      }
    });

    if (closest.element === null) {
      els.tpModuleList.appendChild(dragging);
    } else if (closest.element !== dragging) {
      els.tpModuleList.insertBefore(dragging, closest.element);
    }
  }

  /**
   * 按 roleType 把当前预设「已启用且非空」的模块分成三组（供预览与计数）
   * @return {{
   *   systemText: string, systemCount: number,
   *   postHistoryText: string, postCount: number,
   *   prefillText: string, prefillCount: number,
   *   totalCount: number, totalChars: number
   * }}
   */
  function collectEnabledPromptParts(preset) {
    var systemParts = [];
    var postParts = [];
    var prefillParts = [];
    var systemCount = 0;
    var postCount = 0;
    var prefillCount = 0;
    if (preset && Array.isArray(preset.modules)) {
      preset.modules.forEach(function (mod) {
        if (!mod || mod.enabled !== true) return;
        var content = typeof mod.content === 'string' ? mod.content.trim() : '';
        if (!content) return;
        var roleType = mod.roleType || 'system';
        if (roleType === 'prefill') {
          prefillParts.push(content);
          prefillCount++;
        } else if (roleType === 'post_history') {
          postParts.push(content);
          postCount++;
        } else {
          systemParts.push(content);
          systemCount++;
        }
      });
    }
    var systemText = systemParts.join('\n\n');
    var postHistoryText = postParts.join('\n\n');
    var prefillText = prefillParts.join('\n\n');
    return {
      systemText: systemText,
      systemCount: systemCount,
      postHistoryText: postHistoryText,
      postCount: postCount,
      prefillText: prefillText,
      prefillCount: prefillCount,
      totalCount: systemCount + postCount + prefillCount,
      totalChars: systemText.length + postHistoryText.length + prefillText.length
    };
  }

  /**
   * 打开「预览合并效果」只读弹窗
   */
  function openMergedPreview() {
    if (!els.presetMergedModal) return;
    var preset = getCurrentSessionPreset();
    var data = collectEnabledPromptParts(preset);

    if (els.presetMergedTitle) {
      els.presetMergedTitle.textContent = preset
        ? '合并效果预览 · ' + preset.name
        : '合并效果预览';
    }
    if (els.presetMergedMeta) {
      els.presetMergedMeta.textContent =
        '已启用 ' + data.totalCount + ' 个小模块 · 常规 ' + data.systemCount +
        ' / 后置 ' + data.postCount + ' / 预输入 ' + data.prefillCount +
        ' · 合计 ' + data.totalChars + ' 个字符';
    }
    if (els.presetMergedContent) {
      var buildSection = function (title, text, emptyTip) {
        var body = text ? text : emptyTip;
        return '<div class="merged-section">' +
          '<div class="merged-section-title">' + escapeHtml(title) + '</div>' +
          '<pre class="merged-section-body' + (text ? '' : ' is-empty') + '">' +
          escapeHtml(body) + '</pre></div>';
      };
      var html = '';
      html += buildSection('一、顶部 #0 系统提示词合并预览', data.systemText,
        '（当前没有已启用的常规系统指令模块）');
      html += buildSection('二、后置强指令预览（置于最新用户消息正上方）', data.postHistoryText,
        '（当前没有已启用的后置强指令模块）');
      html += buildSection('三、底部 Assistant 预输入预览（置于消息最末尾引导续写）', data.prefillText,
        '（当前没有已启用的预输入模块）');
      els.presetMergedContent.innerHTML = html;
    }
    if (els.presetMergedFoot) {
      els.presetMergedFoot.textContent = preset ? '预设：' + preset.name : '未启用预设';
    }

    els.presetMergedModal.classList.add('show');
    els.presetMergedModal.setAttribute('aria-hidden', 'false');
  }

  /**
   * 关闭合并效果预览弹窗（同时把焦点交还顶部入口，避免弹窗层叠残留）
   */
  function closeMergedPreview() {
    if (!els.presetMergedModal) return;
    blurInside(els.presetMergedModal);
    els.presetMergedModal.classList.remove('show');
    els.presetMergedModal.setAttribute('aria-hidden', 'true');
  }

  // === [ANCHOR: SUBCHAT_MANAGER] 内部对话（子对话 / 分支）管理 ===
  /* ============ 输入区左侧工具箱 + 内部对话管理 ============ */

  /**
   * 展开 / 收起输入区左侧自适应工具箱
   */
  function toggleInputToolbox(forceOpen) {
    if (!els.inputToolboxPanel || !els.inputToolboxBtn) return;
    var willOpen =
      typeof forceOpen === 'boolean' ? forceOpen : els.inputToolboxPanel.hidden === true;
    els.inputToolboxPanel.hidden = !willOpen;
    els.inputToolboxBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  /**
   * 收起工具箱（点击外部或选中工具后调用）
   */
  function closeInputToolbox() {
    toggleInputToolbox(false);
  }

  /**
   * 内部对话时间格式化：同年 MM-DD HH:mm，跨年 YYYY-MM-DD HH:mm
   */
  function formatSubChatTime(timestamp) {
    var ts = typeof timestamp === 'number' && isFinite(timestamp) ? timestamp : Date.now();
    var d = new Date(ts);
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    var timePart = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var datePart = pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (d.getFullYear() !== new Date().getFullYear()) {
      return d.getFullYear() + '-' + datePart + ' ' + timePart;
    }
    return datePart + ' ' + timePart;
  }

  /**
   * 打开内部对话管理弹窗
   */
  function openSubChatModal() {
    if (!els.subchatModal) return;
    var session = getCurrentSession();
    if (session) ensureSessionSubChats(session);
    renderSubChatList();
    els.subchatModal.classList.add('show');
    els.subchatModal.setAttribute('aria-hidden', 'false');
    subchatModalOpen = true;
  }

  /**
   * 关闭内部对话管理弹窗
   */
  function closeSubChatModal() {
    if (!els.subchatModal) return;
    blurInside(els.subchatModal);
    els.subchatModal.classList.remove('show');
    els.subchatModal.setAttribute('aria-hidden', 'true');
    subchatModalOpen = false;
  }

  /**
   * 渲染内部对话列表：标题 + 当前标记 + 层数 / 更新时间 + 切换 / 重命名 / 删除
   */
  function renderSubChatList() {
    if (!els.subchatList) return;
    els.subchatList.innerHTML = '';

    var session = getCurrentSession();
    if (!session) return;
    var list = ensureSessionSubChats(session);

    list.forEach(function (sub) {
      var active = sub.id === session.activeSubChatId;
      var item = document.createElement('div');
      item.className = 'subchat-item' + (active ? ' active' : '');
      item.setAttribute('data-sub-id', sub.id);

      var info = document.createElement('div');
      info.className = 'subchat-info';

      var nameRow = document.createElement('div');
      nameRow.className = 'subchat-name-row';

      var nameEl = document.createElement('span');
      nameEl.className = 'subchat-name';
      nameEl.textContent = sub.title || '未命名对话';
      nameEl.title = sub.title || '';
      nameRow.appendChild(nameEl);

      if (active) {
        var badge = document.createElement('span');
        badge.className = 'subchat-badge';
        badge.textContent = '当前';
        nameRow.appendChild(badge);
      }

      var metaEl = document.createElement('span');
      metaEl.className = 'subchat-meta';
      var msgCount = Array.isArray(sub.messages) ? sub.messages.length : 0;
      var metaText = '共 ' + msgCount + ' 层 · ' + formatSubChatTime(sub.updatedAt);
      if (typeof sub.branchFloor === 'number' && isFinite(sub.branchFloor)) {
        metaText = '源自 #' + sub.branchFloor + ' 楼 · ' + metaText;
      }
      metaEl.textContent = metaText;

      info.appendChild(nameRow);
      info.appendChild(metaEl);

      var actions = document.createElement('div');
      actions.className = 'subchat-actions';

      var switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'btn-mini';
      switchBtn.textContent = '切换';
      switchBtn.disabled = active;
      switchBtn.addEventListener('click', function () {
        switchSubChat(sub.id);
      });

      var renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'btn-mini';
      renameBtn.textContent = '重命名';
      renameBtn.addEventListener('click', function () {
        renameSubChat(sub.id);
      });

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-mini btn-mini-danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', function () {
        deleteSubChat(sub.id);
      });

      actions.appendChild(switchBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(delBtn);

      item.appendChild(info);
      item.appendChild(actions);
      els.subchatList.appendChild(item);
    });
  }

  /**
   * 新建内部对话：共享当前窗口参数与预设，消息为空
   */
  function createSubChatFlow() {
    var session = getCurrentSession();
    if (!session) return;

    // 在途任务已冻结原子对话，新建空白子对话不影响其归属。

    captureInputDraft();
    var list = ensureSessionSubChats(session);

    // 防重名：扫描已有「新对话 N」标题，取最大编号 + 1
    // 直接使用 list.length + 1 在删除中间项后会产生重复标题
    var maxNum = 0;
    list.forEach(function (item) {
      if (!item || typeof item.title !== 'string') return;
      var matched = item.title.match(/^新对话\s*(\d+)$/);
      if (!matched) return;
      var num = parseInt(matched[1], 10);
      if (isFinite(num) && num > maxNum) maxNum = num;
    });

    var newSub = {
      id: genSubChatId(),
      title: '新对话 ' + (maxNum + 1),
      updatedAt: Date.now(),
      memoryData: createEmptyMemoryData(),
      messages: []
    };

    // 关键顺序：此时 activeSubChatId 仍指向【旧】子对话，
    // 先把它的最新消息同步回去（并刷新其时间），再执行切换，避免旧内容丢失
    syncActiveSubMessages(session, true);

    // 铁律：必须 push 到 session.subChats 本身！
    // syncActiveSubMessages() 内部会调用 getActiveSubChat() → ensureSessionSubChats()，
    // 后者可能对 subChats 做结构兜底；提前缓存的 list 变量一旦与真实数组引用脱钩，
    // push 就会写进废弃数组，表现为「新建的内部对话看不到」。
    session.subChats.push(newSub);
    session.activeSubChatId = newSub.id;
    // 运行时镜像重绑到新子对话的空数组（同一引用），主聊天区随即被清空
    session.messages = newSub.messages;
    session.updatedAt = Date.now();

    flushSave();
    touchLastModified();
    renderSessionList();
    renderMessages(); // 主聊天区清空为新对话状态（显示空提示）
    refreshQuickParamsPanel();
    refreshPresetButtonState();
    scheduleCloudUpload();
    // 弹窗保持打开，仅重绘列表并把「当前」高亮移到新项
    renderSubChatList();
    refreshMemoryContext();
    showToast('已新建并切换至「' + newSub.title + '」');
  }

  /**
   * 切换到指定内部对话
   */
  function switchSubChat(subId) {
    var session = getCurrentSession();
    if (!session) return;
    var list = ensureSessionSubChats(session);

    var found = null;
    list.forEach(function (sub) {
      if (sub.id === subId) found = sub;
    });
    if (!found) return;
    if (found.id === session.activeSubChatId) {
      renderSubChatList();
      return;
    }

    captureInputDraft();
    // 先把当前子对话的消息同步回去（并刷新其时间），再切换
    syncActiveSubMessages(session, true);
    session.activeSubChatId = found.id;
    session.messages = found.messages;
    session.updatedAt = Date.now();

    flushSave();
    touchLastModified();
    renderSessionList();
    renderMessages();
    refreshQuickParamsPanel();
    refreshPresetButtonState();
    scheduleCloudUpload();
    renderSubChatList();
    refreshMemoryContext();
    showToast('已切换到「' + (found.title || '未命名对话') + '」');
  }

  /**
   * 重命名内部对话
   */
  async function renameSubChat(subId) {
    var session = getCurrentSession();
    if (!session) return;
    var list = ensureSessionSubChats(session);

    var target = null;
    list.forEach(function (sub) {
      if (sub.id === subId) target = sub;
    });
    if (!target) return;

    var name = await window.showAppPrompt('内部对话名称', target.title || '');
    if (name === null || getCurrentSession() !== session || session.subChats !== list || list.indexOf(target) < 0) return;
    name = name.trim();
    if (!name) {
      void window.showAppAlert('名称不能为空');
      return;
    }

    target.title = name;
    target.updatedAt = Date.now();
    session.updatedAt = Date.now();
    flushSave();
    touchLastModified();
    renderSubChatList();
    scheduleCloudUpload();
  }

  /**
   * 删除内部对话：至少保留一个；删除当前激活项时自动切到第一个
   */
  async function deleteSubChat(subId) {
    var session = getCurrentSession();
    if (!session) return;
    var list = ensureSessionSubChats(session);

    if (list.length <= 1) {
      void window.showAppAlert('至少保留一个内部对话');
      return;
    }

    var target = null;
    list.forEach(function (sub) {
      if (sub.id === subId) target = sub;
    });
    if (!target) return;

    var ok = await window.showAppConfirm('删除内部对话「' + (target.title || '未命名对话') + '」？');
    if (!ok || activeGenerationMap.size > 0 || getCurrentSession() !== session || session.subChats !== list || list.length <= 1 || list.indexOf(target) < 0) return;

    var wasActive = session.activeSubChatId === subId;
    session.subChats = list.filter(function (sub) {
      return sub.id !== subId;
    });

    if (wasActive) {
      var next = session.subChats[0];
      session.activeSubChatId = next.id;
      session.messages = next.messages;
    } else {
      // 未删除激活项：保持 messages 指向原激活子对话
      var activeSub = getActiveSubChat(session);
      session.messages = activeSub ? activeSub.messages : [];
    }

    session.updatedAt = Date.now();
    flushSave();
    touchLastModified();
    renderSessionList();
    renderMessages();
    refreshQuickParamsPanel();
    refreshPresetButtonState();
    scheduleCloudUpload();
    renderSubChatList();

    if (wasActive) showToast('已删除并切换到剩余内部对话');
  }

  // === [ANCHOR: STREAM_CHAT] 流式对话请求与上下文组装 ===
  /* ================= 核心：流式对话 ================= */

  /**
   * 构建发送给 API 的上下文消息数组：
   * 1. 绝不携带 reasoning / reasoning_content 字段（省 Token 且防止干扰）；
   * 2. 历史 AI 消息若以思维链标签开头，则剔除整段思考内容，只发送纯净正式回答；
   * 3. 剔除后内容为空的 AI 消息直接丢弃，避免空消息导致接口报错。
   * 注意：仅作用于本次请求的临时数组，localStorage 中依旧完整保留思考过程。
   *
   * @param {Array} messages 会话完整消息数组
   * @param {number|null} contextLimit 只保留最近 N 条对话消息；留空（null）表示不截断
   * @param {number|null} cutoffIndex 仅取 [0, cutoffIndex] 区间的消息（中间楼层重答时截断后续楼层）
   * @param {object} [session] 当前会话（用于 {{char}} / {{user}} 宏变量替换）
   */
  function buildApiMessages(messages, contextLimit, cutoffIndex, session, summarizedFloorCursor, includeFloors) {
    var source = messages || [];
    var macroSession = session || getCurrentSession();
    // 重答目标楼层截断：绝不把目标楼层之后的后续楼层发给 API
    if (typeof cutoffIndex === 'number' && isFinite(cutoffIndex) && cutoffIndex >= 0) {
      source = source.slice(0, Math.floor(cutoffIndex) + 1);
    }

    // 归档游标不裁剪正文；有效历史条数仅由 contextLimit 决定。

    var result = [];
    source.forEach(function (msg) {
      if (!msg) return;
      if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') return;

      var content = window.MyChatAttachments ? window.MyChatAttachments.messageText(msg) : (typeof msg.content === 'string' ? msg.content : '');

      if (msg.role === 'assistant') {
        content = stripLeadingThink(content);
        if (!content) return; // 空正式回答不参与上下文
      } else if (!content) {
        return; // 空用户消息 / 空系统消息同样丢弃
      }

      // 外发前落地宏变量：{{char}} / {{user}} / <BOT> / <USER>
      // 本地聊天记录保持原始占位符不变，仅本次请求的快照被替换
      content = replaceMacros(content, macroSession);

      // 只保留 role 与 content 两个字段
      var entry = { role: msg.role, content: content };
      if (includeFloors) entry.floor = messages.indexOf(msg) + 1;
      result.push(entry);
    });

    // 上下文上限：仅截断「对话消息」，系统提示词永远保留在最前面
    var limit = normalizePositiveInt(contextLimit);
    if (limit) {
      var systemMsgs = [];
      var dialogMsgs = [];
      result.forEach(function (item) {
        if (item.role === 'system') {
          systemMsgs.push(item);
        } else {
          dialogMsgs.push(item);
        }
      });
      // 有明确触发楼层时，当前用户消息不占历史 N 条配额。
      var current = typeof cutoffIndex === 'number' && source[source.length - 1] &&
        source[source.length - 1].role === 'user' && dialogMsgs.length &&
        dialogMsgs[dialogMsgs.length - 1].role === 'user' ? dialogMsgs.pop() : null;
      dialogMsgs = dialogMsgs.slice(-limit);
      if (current) dialogMsgs.push(current);
      return systemMsgs.concat(dialogMsgs);
    }

    return result;
  }

  // 正文与只读预览共用同一套组装顺序；调用者负责发送前总结 / 检索。
  function assembleRequestContext(session, targetMessages, params, cutoffUserIndex, summarizedFloorCursor, preparedPreset, retrievalTriggers, retrievalBookId, targetSubChatId) {
    // 上下文快照：剥离历史思维链，绝不外发 reasoning 字段；按楼层 + 上下文上限双重截断
    // 传入 session 使 {{char}} / {{user}} 宏变量在发往 API 前落地为真实名称
    // 先按原模块顺序赋值，再展开预设和历史读取，禁止按角色分组后重复执行赋值。
    var requestMessages = buildApiMessages(
      targetMessages,
      params.contextLimit,
      cutoffUserIndex,
      session,
      summarizedFloorCursor,
      true
    );
    var includedHistory = requestMessages.slice();
    requestMessages = requestMessages.map(function (msg) { return {role:msg.role, content:msg.content}; });

    // 系统提示词预设：仅 roleType === 'system'（未设置视为 system）的小模块，
    // 按序拼接后作为 messages[0] 的 system 消息插入
    // （必须在截取历史消息之后，确保不被上限裁掉）
    var presetSystemPrompt = buildPresetSystemPrompt(preparedPreset);

    // ===== 角色卡基础设定合并：与预设并行，缺一不可 =====
    // 设定卡（无世界书）与空设定卡（全靠世界书）两种角色卡都能 100% 生效：
    //   charSystemPrompt → 最优先的独立系统指令
    //   charDescription / charPersonality / charScenario → 描述段
    //   charMesExample → 对话示例段
    var charParts = [];
    if (typeof session.charSystemPrompt === 'string' && session.charSystemPrompt.trim()) {
      charParts.push(session.charSystemPrompt.trim());
    }
    var charProfileParts = [];
    if (typeof session.charDescription === 'string' && session.charDescription.trim()) {
      charProfileParts.push(session.charDescription.trim());
    }
    if (typeof session.charPersonality === 'string' && session.charPersonality.trim()) {
      charProfileParts.push('性格：' + session.charPersonality.trim());
    }
    if (typeof session.charScenario === 'string' && session.charScenario.trim()) {
      charProfileParts.push('场景：' + session.charScenario.trim());
    }
    if (charProfileParts.length > 0) {
      charParts.push(
        '（以下是你的角色设定，请始终严格遵守）\n' + charProfileParts.join('\n\n')
      );
    }
    if (typeof session.charMesExample === 'string' && session.charMesExample.trim()) {
      charParts.push('（以下是对话示例，仅供模仿语气，不必复述）\n' + session.charMesExample.trim());
    }

    var systemPromptParts = [];
    if (presetSystemPrompt) systemPromptParts.push(presetSystemPrompt);
    if (charParts.length > 0) systemPromptParts.push(charParts.join('\n\n'));
    var mergedSystemPrompt = systemPromptParts.join('\n\n');

    // ===== 静默现实时间背景板 <env_context>（仅本次请求的临时快照） =====
    // 绝不写入 targetMessages，也绝不改变用户可见的 #0 预设输入框
    if (params.realTime !== false) {
      var envBlock = buildRealTimeEnvContext();
      mergedSystemPrompt = mergedSystemPrompt
        ? mergedSystemPrompt + '\n\n' + envBlock
        : envBlock;
    }

    if (mergedSystemPrompt) {
      // 宏替换：{{char}} / {{user}} 在系统提示词中必须落地为真实名称
      requestMessages.unshift({
        role: 'system',
        content: replaceMacros(mergedSystemPrompt, session)
      });
    }

    // 预输入 Prefill / 后置强指令：从当前会话绑定的预设中取出对应分组
    var roleParts = collectPresetRoleParts(preparedPreset);
    var postHistoryText = roleParts.postHistoryText;
    var prefillText = roleParts.prefillText;

    // 角色卡后置强指令（charPostHistory）：与预设的 post_history 模块合并
    if (typeof session.charPostHistory === 'string' && session.charPostHistory.trim()) {
      postHistoryText = postHistoryText
        ? postHistoryText + '\n\n' + session.charPostHistory.trim()
        : session.charPostHistory.trim();
    }
    // 发送前统一做宏替换（历史消息在 beforeSend 管道里也会被模块处理，这里先兜住基础设定部分）
    if (postHistoryText) postHistoryText = replaceMacros(postHistoryText, session);
    if (prefillText) prefillText = replaceMacros(prefillText, session);
    // 仅在勾选「保留显示」时才把预输入回显到 AI 气泡开头
    var prefillPrefix = roleParts.keepPrefill && prefillText ? prefillText : '';

    // beforeSend 阀门：正则发送预处理 / 宏变量替换 / 预输入 Prefill 的统一拦截点
    var pipedMessages = runPipeline('beforeSend', requestMessages, {
      session: session,
      params: params,
      subChatId: targetSubChatId,
      targetMessages: targetMessages
    });
    if (Array.isArray(pipedMessages)) requestMessages = pipedMessages;

    // 检索已在构造上下文前完成；此处直接用本轮编号注入最新虚拟记忆库。
    // ===== 上下文级阀门（beforeSendContext）：世界书 #0 / @Depth 深度注入 =====
    // payload 携带完整的 { apiMessages, session }，允许模块整体改写本轮发往 API 的临时载荷，
    // 并回传本轮命中的世界书词条名称，供 AI 消息 meta.triggeredWorldbooks 记录。
    // 注意：只作用于本次请求的 apiMessages，绝不回写 targetMessages 本地聊天记录。
    var ctxResult = runPipeline(
      'beforeSendContext',
      {
        apiMessages: requestMessages,
        session: session,
        retrievalTriggers: retrievalTriggers,
        subChatId: targetSubChatId,
        retrievalBookId: retrievalBookId
      },
      { session: session, params: params }
    );
    var triggeredEntryNames = [];
    var triggeredEntryDetails = [];
    if (ctxResult && typeof ctxResult === 'object') {
      if (Array.isArray(ctxResult.apiMessages)) requestMessages = ctxResult.apiMessages;
      if (Array.isArray(ctxResult.triggeredEntryNames)) {
        triggeredEntryNames = ctxResult.triggeredEntryNames.filter(function (name) {
          return typeof name === 'string' && name.trim();
        });
      }
      // 新版世界书模块回传的触发明细（常驻条目已在上游排除，不计入此处）
      if (Array.isArray(ctxResult.triggeredEntries)) {
        triggeredEntryDetails = ctxResult.triggeredEntries.filter(function (item) {
          return item && typeof item === 'object';
        });
      }
    }

    // ===== 后置强指令：插在「最新一条用户消息」正上方 =====
    if (postHistoryText) {
      var lastUserIdx = -1;
      for (var ui = requestMessages.length - 1; ui >= 0; ui--) {
        if (requestMessages[ui] && requestMessages[ui].role === 'user') {
          lastUserIdx = ui;
          break;
        }
      }
      var postMsg = { role: 'system', content: postHistoryText };
      if (lastUserIdx >= 0) {
        requestMessages.splice(lastUserIdx, 0, postMsg);
      } else {
        requestMessages.push(postMsg);
      }
    }

    // ===== Assistant 预输入：作为最后一条 assistant 消息（世界书注入之后追加） =====
    if (prefillText) {
      requestMessages.push({ role: 'assistant', content: prefillText });
    }

    return {apiMessages:requestMessages, history:includedHistory, systemPromptChars:mergedSystemPrompt.length, prefillPrefix:prefillPrefix, triggeredEntryNames:triggeredEntryNames, triggeredEntries:triggeredEntryDetails, injectedEntries:ctxResult && ctxResult.injectedEntries || []};
  }

  /**
   * 发送消息并接收 AI 的流式回复
   */
  async function sendMessage() {
    var targetSession = getCurrentSession() || createSession(true);
    var session = targetSession;
    var targetSubChatId = getActiveSubChatId(targetSession);
    var targetMessages = getSubChatMessages(targetSession, targetSubChatId);
    if (!targetMessages || isChannelGenerating(session.id, targetSubChatId) ||
        pendingReplyPolicies.has(generationKey(session.id, targetSubChatId))) return;

    var text = els.input.value.trim();
    var attachmentsModule = window.MyChatAttachments;
    if (attachmentsModule && !attachmentsModule.beforeCommit()) return;
    if (!text && !(attachmentsModule && attachmentsModule.hasPending())) return;

    // 校验当前选中的渠道与模型是否可用（不发送任何请求）
    var target = resolveActiveTarget();
    if (!target) {
      void window.showAppAlert('请先配置渠道与模型');
      return;
    }
    if (!target.provider.apiKey && providerNeedsKey(target.provider)) {
      void window.showAppAlert('请补全当前渠道 API Key');
      return;
    }

    // 兜底：理论上初始化后一定存在当前会话
    // 目标子对话与数组已在入口冻结。

    // 1. 记录用户消息（渲染统一交给 renderMessages，保证每行都带操作栏与真实索引）
    var hadUserMessage = targetMessages.some(function (msg) {
      return msg.role === 'user';
    });

    // 用户消息记录发送时间，用于底部常驻统计小字栏
    var attachments = attachmentsModule ? attachmentsModule.take() : [];
    targetMessages.push({ role: 'user', content: text, attachments: attachments, timestamp: Date.now(), meta: { timeStr: formatClockTime() } });

    // 首条用户消息 -> 自动生成会话标题（前 12 个字符）
    if (!hadUserMessage && session.subChats[0] && session.subChats[0].id === targetSubChatId &&
        (!session.title || session.title === DEFAULT_TITLE)) {
      session.title = makeTitle(text || (attachments[0] && attachments[0].name) || '附件');
    }

    // 正式入库后清空会话草稿；配置校验失败时保留。
    session.inputDraft = '';
    // 2. 刷新会话时间戳与全局时间戳，并立即落盘，防止刷新丢消息
    session.updatedAt = Date.now();
    flushSave();
    touchLastModified(); // 发送消息属于全局修改，刷新同步时间戳
    // 自动总结由统一请求入口等待，禁止在此启动并行后台任务。
    renderSessionList();
    renderMessages();
    forceScrollToBottom(); // 发送后强制回到底部并恢复自动跟随

    // 3. 清空输入框
    els.input.value = '';
    autoGrowInput();

    // 4. 请求并流式接收 AI 回复
    await requestAssistantReply(targetSession, { subChatId: targetSubChatId, targetMessages: targetMessages });
  }

  /**
   * 请求 AI 回复并写入当前视图
   *
   * @param {object} session 当前会话对象
   * @param {object} [options] 可选参数（用于中间楼层原位重答）
   * @param {number} [options.cutoffUserIndex] 本次触发的目标用户消息索引；
   *        构建 API 上下文时只发送 targetMessages[0..cutoffUserIndex]，绝不外发后续楼层
   * @param {number} [options.reuseIndex] 需要原位覆盖的 AI 消息索引
   *        （存在且该位置是 assistant 时直接复用该条消息，避免新增楼层）
   * @param {boolean} [options.keepScroll] true 表示流式过程中不强行滚动到聊天室最底部
   */
  async function requestAssistantReply(session, options) {
    if (!session) return;
    var opts = Object.assign({}, options || {});
    var subId = opts.subChatId || getActiveSubChatId(session);
    var messages = getSubChatMessages(session, subId);
    var key = generationKey(session.id, subId);
    if (!messages || isChannelGenerating(session.id, subId) || pendingReplyPolicies.has(key)) return;
    if (typeof opts.cutoffUserIndex !== 'number') {
      for (var u = messages.length - 1; u >= 0; u--) {
        if (messages[u].role === 'user') { opts.cutoffUserIndex = u; break; }
      }
    }
    var sourceUser = typeof opts.cutoffUserIndex === 'number' ? messages[opts.cutoffUserIndex] : null;
    var run = { cancelled:false };
    pendingReplyRuns.set(key, run);
    var policy = runPipeline('replyPolicy', {}, { session: session, subChatId: subId, key: key });
    var attempt = async function (signal, previous) {
      if (run.cancelled || getSession(session.id) !== session || getSubChatMessages(session, subId) !== messages ||
          (sourceUser && messages[opts.cutoffUserIndex] !== sourceUser)) return;
      var next = Object.assign({}, opts, { subChatId: subId, targetMessages: messages, signal: signal });
      if (previous && previous.msg) {
        var index = messages.indexOf(previous.msg);
        if (index >= 0) { next.reuseIndex = index; next.swipeBranch = false; }
      }
      return requestAssistantAttempt(session, next);
    };
    pendingReplyPolicies.add(key);
    try {
      if (policy && typeof policy.run === 'function') await policy.run(attempt);
      else await attempt();
    } finally {
      if (pendingReplyRuns.get(key) === run) {
        pendingReplyRuns.delete(key); pendingReplyPolicies.delete(key);
      }
      syncStreamingUiState();
    }
  }

  var pendingReplyPolicies = new Set();
  var pendingReplyRuns = new Map();

  async function requestAssistantAttempt(session, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var targetSession = session;
    if (!targetSession) return;
    var targetSubChatId = opts.subChatId || getActiveSubChatId(targetSession);
    var targetMessages = getSubChatMessages(targetSession, targetSubChatId);
    if (!targetMessages || (opts.targetMessages && opts.targetMessages !== targetMessages) ||
        isChannelGenerating(session.id, targetSubChatId)) return;
    var taskKey = generationKey(session.id, targetSubChatId);
    var task = { isStreaming: true, session: targetSession, subChatId: targetSubChatId,
      messages: targetMessages, assistantMsgId: null, bubbleRefs: null, latestRender: null };

    task.controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) task.controller.abort();
      else opts.signal.addEventListener('abort', function () { task.controller.abort(); }, { once: true });
    }

    // 请求前锁定当前渠道与模型，避免流式过程中用户切换导致参数错乱
    var target = resolveActiveTarget();
    if (!target) {
      void window.showAppAlert('请先配置渠道与模型');
      return;
    }
    var activeProvider = target.provider;
    var activeModel = target.model;

    // 取本会话的有效参数（未定制的会话自动继承全局默认）
    var params = getSessionParams(session);
    var isStreamMode = params.stream !== false;

    // 本次请求的上下文截止楼层：中间楼层重答时绝不把后续楼层发给 API
    var cutoffUserIndex =
      typeof opts.cutoffUserIndex === 'number' && isFinite(opts.cutoffUserIndex) && opts.cutoffUserIndex >= 0
        ? Math.floor(opts.cutoffUserIndex)
        : null;

    // 是否在流式过程中保持当前可视区域（中间楼层重答时使用）
    var keepScroll = opts.keepScroll === true;

    // 预设先按原顺序执行赋值，保证检索与正文读取相同宏变量；不构造正文快照。
    var activePreset = session && session.presetId ? getPresetById(session.presetId) : null;
    var preparedPreset = window.MyChatTavernMacros ? window.MyChatTavernMacros.preparePreset(activePreset, session) : activePreset;

    // 严格串行：总结全部落盘 → 检索最新索引 → 构造正文与世界书。
    // 重答和继续生成共用此入口，截止楼层之前才是本轮定稿历史。
    var retrievalTriggers = [];
    var retrievalBookId = '';
    var summarizedFloorCursor = 0;
    var memModule = window.MemorySummaryModule;
    task.isStreamMode = isStreamMode;
    activeGenerationMap.set(taskKey, task);
    syncStreamingUiState();
    try {
    try {
      if (memModule && typeof memModule.prepareBeforeSend === 'function') {
        var preparedMemory = await memModule.prepareBeforeSend(session, {
          subChatId: targetSubChatId,
          targetMessages: targetMessages,
          cutoffUserIndex: cutoffUserIndex,
          signal: task.controller.signal,
          contextLimit: params.contextLimit,
          params: params
        });
        retrievalTriggers = preparedMemory.activeRecalledEventIds || [];
        retrievalBookId = preparedMemory.retrievalBookId || '';
        summarizedFloorCursor = preparedMemory.summarizedFloorCursor || 0;
      }
    } catch (prepareError) {
      console.warn('[记忆总结] 发送准备已取消：', prepareError);
      return { ok: false, error: prepareError.message || String(prepareError), aborted:task.controller.signal.aborted || prepareError.isUserAborted === true };
    }
    if (task.controller.signal.aborted) return;
    if (getSession(session.id) !== targetSession ||
        getSubChatMessages(targetSession, targetSubChatId) !== targetMessages) return;

    var assembled = assembleRequestContext(session, targetMessages, params, cutoffUserIndex, summarizedFloorCursor, preparedPreset, retrievalTriggers, retrievalBookId, targetSubChatId);
    var requestMessages = assembled.apiMessages;
    var prefillPrefix = assembled.prefillPrefix;
    var triggeredEntryNames = assembled.triggeredEntryNames;
    var triggeredEntryDetails = assembled.triggeredEntries;
    /**
     * 把预输入前缀合并进 AI 正文（流式与非流式渲染共用）
     * 若 AI 正文本身已以预输入开头（接口复述了预输入），则只保留一份，避免重复
     */
    var withPrefill = function (text) {
      var t = typeof text === 'string' ? text : '';
      if (!prefillPrefix) return t;
      return t.indexOf(prefillPrefix) === 0 ? t : prefillPrefix + t;
    };

    /* ---------- 写入 AI 回复载体：优先原位覆盖，否则按楼层插入 ---------- */
    var reuseIndex =
      typeof opts.reuseIndex === 'number' && isFinite(opts.reuseIndex) && opts.reuseIndex >= 0
        ? Math.floor(opts.reuseIndex)
        : -1;

    var assistantMsg = null;
    // 记录被原位覆盖的原消息快照：请求彻底失败时用于恢复，避免误删既有楼层
    var reusedBackup = null;
    // 是否走 swipes 多分支路径：旧回复移入历史分支槽位，绝不丢失
    var swipeBranchMode = opts.swipeBranch === true;
    if (
      reuseIndex >= 0 &&
      targetMessages[reuseIndex] &&
      targetMessages[reuseIndex].role === 'assistant'
    ) {
      // 规则 A / B：复用目标 AI 消息（后续楼层全部原样保留）
      assistantMsg = targetMessages[reuseIndex];
      reusedBackup = {
        content: assistantMsg.content,
        reasoning: assistantMsg.reasoning,
        meta: assistantMsg.meta
      };

      if (swipeBranchMode) {
        // ---- 多分支保留：旧正文先固化为分支，再追加新空槽位并指向它 ----
        if (!Array.isArray(assistantMsg.swipes) || !assistantMsg.swipes.length) {
          var seedBranch = { content: assistantMsg.content || '' };
          var seedReasoning =
            typeof assistantMsg.reasoning === 'string' ? assistantMsg.reasoning : '';
          if (seedReasoning) seedBranch.reasoning = seedReasoning;
          seedBranch.timestamp = Date.now();
          assistantMsg.swipes = [seedBranch];
        } else {
          // 已有多分支：把顶层最新正文同步回当前槽位，避免编辑后丢失
          var curIdx = normalizeSwipeIndex(assistantMsg);
          if (assistantMsg.swipes[curIdx]) {
            assistantMsg.swipes[curIdx].content =
              typeof assistantMsg.content === 'string' ? assistantMsg.content : assistantMsg.swipes[curIdx].content;
            if (typeof assistantMsg.reasoning === 'string' && assistantMsg.reasoning) {
              assistantMsg.swipes[curIdx].reasoning = assistantMsg.reasoning;
            }
          }
        }
        // 追加新分支空槽位，并把当前分支指向它
        assistantMsg.swipes.push({ content: '', timestamp: Date.now() });
        assistantMsg.swipeIndex = assistantMsg.swipes.length - 1;
      }

      assistantMsg.content = '';
      delete assistantMsg.reasoning;
      delete assistantMsg.meta;
      assistantMsg._pending = true;
    } else {
      // 目标位置没有 AI 消息：插入新的占位消息，后续楼层自动顺延
      assistantMsg = { role: 'assistant', content: '', reasoning: '' };
      assistantMsg._pending = true;
      var insertAt =
        cutoffUserIndex !== null ? Math.min(cutoffUserIndex + 1, targetMessages.length) : targetMessages.length;
      targetMessages.splice(insertAt, 0, assistantMsg);
    }

    if (!assistantMsg.id) assistantMsg.id = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    task.assistantMsg = assistantMsg;
    task.assistantMsgId = assistantMsg.id;
    var targetIndex = targetMessages.indexOf(assistantMsg);

    // 重绘消息区：后续楼层保持原位显示，楼层号按最新数组顺序自动重算
    // 中间楼层重答时保持当前滚动位置，不强行把视口拉到整个聊天室最底部
    // 后台使用脱离文档的兜底节点；切回重绘时同步更新闭包目标。
    var bubble = document.createElement('div');
    ensureBubbleParts(bubble);
    task.bindBubble = function (node) { bubble = node; };
    if (isCurrentSession(targetSession, targetSubChatId)) {
      renderMessages({ keepScroll: keepScroll, focusIndex: targetIndex });
    }

    if (isStreamMode) bubble.classList.add('streaming');
    var answer = '';
    var reasoning = '';

    // 非流式读秒计时器（收到响应或报错后必须清除）
    var nonStreamTimer = null;

    // 非流式：请求期间没有逐字输出，展示动态读秒提示避免界面看似无反应
    if (!isStreamMode) {
      ensureBubbleParts(bubble);
      bubble._cot.style.display = 'none';
      bubble._mdBody.style.display = '';
      bubble._mdBody._lastHtml = '';

      var waitedSec = 0;
      bubble._mdBody.textContent = '等待响应… (0s)';
      task.waitText = bubble._mdBody.textContent;
      nonStreamTimer = setInterval(function () {
        waitedSec++;
        task.waitText = '等待响应… (' + waitedSec + 's)';
        if (isCurrentSession(targetSession, targetSubChatId) && bubble.isConnected) {
          bubble._mdBody.style.display = '';
          bubble._mdBody.textContent = task.waitText;
        }
      }, 1000);

      if (!keepScroll && isCurrentSession(targetSession, targetSubChatId)) scrollToBottom();
    }

    // 统计信息收集：Token 用量与请求耗时
    var usageInfo = null;
    var rawEstimatedPromptTokens = 0;
    var startTime = (window.performance && performance.now) ? performance.now() : Date.now();

    // 记录本轮所属会话，避免用户中途切换会话时把内容写错地方
    var activeId = session.id;

    // 通道锁从准备期持续持有至收尾结束。

    var debug = window.DebugInspector, traceId = '', debugRawText = '', debugParsed = null;
    try {
      // 严格使用当前选中渠道的 baseUrl / apiKey 与模型的真实 id
      var endpoint = buildChatUrl(activeProvider.baseUrl);

      var res;

      // 组装请求体：数值参数仅在用户填写时下发，留空绝不发送该字段
      var buildRequestBody = function (withUsage) {
        var body = {
          model: activeModel.id,
          messages: window.MyChatAttachments ? window.MyChatAttachments.toWire(requestMessages, targetMessages, {provider:activeProvider, model:activeModel}) : requestMessages,
          stream: isStreamMode
        };

        if (params.temperature !== null) {
          body.temperature = Number(params.temperature);
        }
        if (params.topP !== null) {
          body.top_p = Number(params.topP);
        }
        if (params.maxTokens !== null) {
          body.max_tokens = parseInt(params.maxTokens, 10);
        }

        // stream_options 只在流式请求时附带，非流式接口带上会被判为非法参数
        if (withUsage && isStreamMode) {
          body.stream_options = { include_usage: true };
        }

        return JSON.stringify(body);
      };

      var sendChatRequest = function (withUsage) {
        var bodyText = buildRequestBody(withUsage);
        var sentApiMessages = JSON.parse(bodyText).messages;
        rawEstimatedPromptTokens = estimateRawPromptTokens(sentApiMessages);
        if (debug) {
          if (traceId) debug.finish(traceId, {status:'error',response:{httpStatus:400,errorMsg:'接口不支持 stream_options，已重试'}});
          var wireBody = JSON.parse(bodyText);
          traceId = debug.start({category:'main_chat',title:'主对话请求',sessionId:session.id,sessionTitle:session.title || '',subChatId:targetSubChatId,
            inspectorMeta:debug.mainMeta(assembled),request:Object.assign(debug.request({provider:activeProvider,model:activeModel},wireBody.messages,params.maxTokens,params.temperature),{body:wireBody})});
        }
        return (window.MyChatProviders ? window.MyChatProviders.fetch.bind(null, activeProvider) : fetch)(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + activeProvider.apiKey,
            'Accept': isStreamMode ? 'text/event-stream' : 'application/json'
          },
          signal: task.controller.signal,
          body: bodyText
        });
      };

      try {
        res = await sendChatRequest(true);
        // 部分中转站不支持 stream_options，会直接返回 400：去掉该参数自动重试一次
        if (res.status === 400 && isStreamMode) {
          // 先释放第一次的响应体，避免连接长时间挂起
          try {
            if (res.body && res.body.cancel) await res.body.cancel();
          } catch (ignoreErr) {
            /* 忽略取消失败 */
          }
          res = await sendChatRequest(false);
        }
      } catch (netErr) {
        // fetch 本身抛错：通常是网络中断、地址写错或跨域（CORS）被拦截
        throw new Error(
          '网络请求失败：' +
            (netErr && netErr.message ? netErr.message : netErr) +
            '\n可能原因：网络不可用、接口地址填写错误，或该接口未允许浏览器跨域访问（CORS）。'
        );
      }

      // 7. HTTP 状态异常：读取响应体并抛出具体错误
      if (!res.ok) {
        var errBody = '';
        try {
          errBody = await res.text();
        } catch (readErr) {
          errBody = '';
        }
        debugRawText = errBody;
        throw new Error(describeHttpError(res.status, res.statusText, errBody));
      }

      if (task.controller.signal.aborted) throw new Error('请求已中止');
      var contentType = (res.headers.get('content-type') || '').toLowerCase();

      // 8. 非流式模式 / 兜底：中转站忽略 stream 参数直接返回完整 JSON
      var looksLikeSse = contentType.indexOf('text/event-stream') !== -1;
      if (
        contentType.indexOf('application/json') !== -1 ||
        !res.body ||
        (!isStreamMode && !looksLikeSse)
      ) {
        var rawText = '';
        try {
          rawText = await res.text();
        } catch (readErr) {
          throw new Error('读取响应内容失败：' + (readErr && readErr.message ? readErr.message : readErr));
        }

        if (task.controller.signal.aborted) throw new Error('请求已中止');
        debugRawText = rawText;
        var json = safeJsonParse(rawText);
        debugParsed = json;
        if (!json) {
          throw new Error('接口返回内容无法解析：' + rawText.slice(0, 300));
        }
        if (json.error) {
          throw new Error(
            '接口返回错误：' + (json.error.message || JSON.stringify(json.error))
          );
        }

        answer = extractFullContent(json);
        reasoning = extractFullReasoning(json);
        // 非流式返回：直接从响应体读取 Token 用量
        usageInfo = extractUsageObject(json);

        // 已拿到完整响应：立刻停掉读秒计时器，避免覆盖即将渲染的正文
        if (nonStreamTimer) {
          clearInterval(nonStreamTimer);
          nonStreamTimer = null;
        }

        if (!answer && !reasoning) {
          throw new Error('接口未返回任何文本内容，请检查【设置】中的模型名称是否正确。');
        }

        bubble.classList.remove('streaming');

        // 非流式整体返回时同步写入会话数据（按保留设置回显预输入）
        assistantMsg.content = withPrefill(answer);
        if (reasoning) assistantMsg.reasoning = reasoning;
        session.updatedAt = Date.now();
        scheduleSave();

        // 渲染前清空「上次渲染缓存」标记，确保正文 100% 重新渲染
        bubble._mdBody._lastHtml = null;
        task.latestRender = { content: assistantMsg.content, reasoning: reasoning };
        if (isCurrentSession(targetSession, targetSubChatId) && bubble.isConnected) {
          renderAssistantBubble(bubble, task.latestRender, false);
        }
      } else {
        // 9. 标准 SSE 流式解析（ReadableStream + TextDecoder）
        // 若本意是非流式但服务端仍返回 SSE，必须先停掉读秒提示，避免覆盖正文
        if (nonStreamTimer) {
          clearInterval(nonStreamTimer);
          nonStreamTimer = null;
        }
        if (bubble._mdBody) {
          bubble._mdBody._lastHtml = '';
          bubble._mdBody.textContent = '';
        }

        var reader = res.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        var streamDone = false;

        /**
         * 处理单行 SSE 数据：
         * 返回 true 表示收到 [DONE]，应结束读取
         */
        var consumeLine = function (rawLine) {
          var line = rawLine.replace(/\r$/, '');
          if (!line) return false;
          if (line.charAt(0) === ':') return false; // 心跳注释行，忽略
          if (line.indexOf('data:') !== 0) return false; // 只处理 data: 行

          var payload = line.slice(5).trim();
          if (!payload) return false;
          if (payload === '[DONE]') return true;

          var chunkJson = safeJsonParse(payload);
          if (!chunkJson) return false; // 非标准片段，跳过即可

          if (chunkJson.error) {
            throw new Error(
              '接口返回错误：' + (chunkJson.error.message || JSON.stringify(chunkJson.error))
            );
          }

          // 部分接口只在末尾 chunk 中返回 usage（配合 stream_options 使用）
          var chunkUsage = extractUsageObject(chunkJson);
          if (chunkUsage) usageInfo = chunkUsage;

          var piece = '';
          var reasonPiece = '';
          var choice = chunkJson.choices && chunkJson.choices[0];
          if (choice) {
            var delta = choice.delta || choice.message || null;

            // 思维链字段：DeepSeek-R1 等官方接口使用 reasoning_content
            if (delta) {
              if (typeof delta.reasoning_content === 'string') {
                reasonPiece = delta.reasoning_content;
              } else if (typeof delta.reasoning === 'string') {
                reasonPiece = delta.reasoning;
              }
            }

            if (choice.delta && typeof choice.delta.content === 'string') {
              piece = choice.delta.content;
            } else if (choice.message && typeof choice.message.content === 'string') {
              piece = choice.message.content;
            } else if (typeof choice.text === 'string') {
              piece = choice.text;
            }
          }

          if (reasonPiece) {
            reasoning += reasonPiece;
            assistantMsg.reasoning = reasoning;
          }

          if (piece || reasonPiece) {
            if (piece) answer += piece;

            // 关键：流式进行中就把最新内容与时间戳同步写入 localStorage
            // 勾选保留预输入时，气泡开头立刻显示预输入文本，后续内容在其后逐字追加
            var streamContent = withPrefill(answer);
            assistantMsg.content = streamContent;
            session.updatedAt = Date.now();
            scheduleSave();

            // 合并到下一帧渲染，避免长文本每个字都重新解析 Markdown
            task.latestRender = { content: streamContent, reasoning: reasoning };
            if (isCurrentSession(targetSession, targetSubChatId) && bubble.isConnected) {
              scheduleAssistantRender(bubble, task.latestRender);
            }

            // 中间楼层重答时不强行把滚动条拉到整个聊天室最底部
            if (!keepScroll && isCurrentSession(targetSession, targetSubChatId)) scrollToBottom();
          }
          return false;
        };

        while (!streamDone) {
          var chunk = await reader.read();
          if (task.controller.signal.aborted) throw new Error('请求已中止');
          if (chunk.done) break;

          var decoded = decoder.decode(chunk.value, { stream: true });
          debugRawText += decoded;
          buffer += decoded;
          var lines = buffer.split('\n');
          buffer = lines.pop(); // 最后一段可能是半行，留到下次拼接

          for (var i = 0; i < lines.length; i++) {
            if (consumeLine(lines[i])) {
              streamDone = true;
              break;
            }
          }
        }

        // 处理流结束后缓冲区里残留的最后一段
        if (!streamDone) {
          buffer += decoder.decode();
          if (buffer.trim()) consumeLine(buffer);
        }

        // 主动释放读取锁
        try {
          await reader.cancel();
        } catch (cancelErr) {
          /* 忽略取消时的异常 */
        }

        bubble.classList.remove('streaming');

        if (!answer && !reasoning) {
          throw new Error('接口未返回任何文本内容，请检查【设置】中的模型名称是否正确。');
        }
      }
    } catch (err) {
      task.error = err && err.message ? err.message : String(err);
      var errorText = task.error;
      bubble.classList.remove('streaming');

      // 报错时同样停掉读秒计时器，避免继续覆盖错误提示
      if (nonStreamTimer) {
        clearInterval(nonStreamTimer);
        nonStreamTimer = null;
      }

      if (!answer && !reasoning) {
        if (reusedBackup) {
          // 多分支模式下失败：丢弃本次追加的空分支槽位，回退到原分支
          if (swipeBranchMode && Array.isArray(assistantMsg.swipes) && assistantMsg.swipes.length > 1) {
            assistantMsg.swipes.pop();
            assistantMsg.swipeIndex = assistantMsg.swipes.length - 1;
          }
          // 原位覆盖失败：恢复被覆盖的原始 AI 楼层，绝不删除任何楼层
          assistantMsg.content = reusedBackup.content || '';
          if (typeof reusedBackup.reasoning === 'string') {
            assistantMsg.reasoning = reusedBackup.reasoning;
          } else {
            delete assistantMsg.reasoning;
          }
          if (reusedBackup.meta) {
            assistantMsg.meta = reusedBackup.meta;
          } else {
            delete assistantMsg.meta;
          }
          // 单分支时退回普通消息结构，避免留下只有 1 个分支的冗余 swipes
          if (Array.isArray(assistantMsg.swipes) && assistantMsg.swipes.length <= 1) {
            delete assistantMsg.swipes;
            delete assistantMsg.swipeIndex;
          }
        } else {
          // 没有任何内容：移除本轮临时插入的空占位，避免留下空消息记录
          var placeholderIndex = targetMessages.indexOf(assistantMsg);
          if (placeholderIndex !== -1) targetMessages.splice(placeholderIndex, 1);
        }

        // 只把错误展示在当前视图上，不写入历史记录
        if (!task.controller.signal.aborted && isCurrentSession(targetSession, targetSubChatId)) {
          ensureBubbleParts(bubble);
          bubble._cot.style.display = 'none';
          bubble._mdBody.style.display = '';
          bubble._mdBody._lastHtml = '';
          bubble._mdBody.textContent = '请求出错：' + errorText;
          bubble.classList.add('bubble-error');
          if (!keepScroll) scrollToBottom();
        }
      } else if (!task.controller.signal.aborted && isCurrentSession(targetSession, targetSubChatId)) {
        // 已有部分内容：保留内容，另起一条错误气泡（中间楼层重答时不强制滚底）
        appendError(errorText, keepScroll);
      }
    } finally {
      if (debug && traceId) debug.finish(traceId, {status:task.error ? 'error' : 'success', response:{
        rawText:answer || debugRawText, parsedData:debugParsed || {content:answer,reasoning:reasoning},
        wireText:debugRawText, httpStatus:res ? res.status : null, errorMsg:task.error || '', validationResult:{valid:!task.error}}});
      // 请求已结束：移除等待标记，读秒计时器一并清理
      delete assistantMsg._pending;
      if (nonStreamTimer) {
        clearInterval(nonStreamTimer);
        nonStreamTimer = null;
      }

      // 收尾：先让 onReceive 阀门做入库前清洗，再确保最终内容立即落盘
      if (answer) {
        var receivedText = runPipeline('onReceive', answer, {
          session: session,
          msg: assistantMsg
        });
        if (typeof receivedText === 'string') answer = receivedText;
        assistantMsg.content = answer;
      }

      // 预输入回显与去重：
      // - 勾选「保留显示」时，若 AI 正文未以预输入开头则补到气泡开头
      // - 若接口已把预输入原样复述（正文以它开头）则只保留一份，避免重复
      if (prefillPrefix) {
        var currentAnswer = typeof assistantMsg.content === 'string' ? assistantMsg.content : '';
        var mappedPrefix = window.MyChatVocab ? window.MyChatVocab.applyVocabMapping(prefillPrefix) : prefillPrefix;
        if (currentAnswer.indexOf(mappedPrefix) !== 0) {
          assistantMsg.content = mappedPrefix + currentAnswer;
        }
        answer = assistantMsg.content;
      }
      if (reasoning) {
        assistantMsg.reasoning = reasoning;
      } else if ('reasoning' in assistantMsg) {
        // 没有思考内容时不保留空字段，保持数据结构干净
        delete assistantMsg.reasoning;
      }

      // ---- 多分支收尾：把最终正文 / 思维链同步写入当前分支槽位 ----
      // 流式完成、中断、失败恢复三种情况都走这里，保证 swipes 与顶层字段永不脱节
      if (Array.isArray(assistantMsg.swipes) && assistantMsg.swipes.length) {
        var finalIdx = normalizeSwipeIndex(assistantMsg);
        var finalContent = typeof assistantMsg.content === 'string' ? assistantMsg.content : '';
        var finalReasoning =
          typeof assistantMsg.reasoning === 'string' ? assistantMsg.reasoning : '';
        // 空分支槽位（新槽位且未产生内容）直接剔除，避免留下「1/2 空白分支」
        if (!finalContent && assistantMsg.swipes.length > 1 && !assistantMsg.swipes[finalIdx].content) {
          assistantMsg.swipes.splice(finalIdx, 1);
          if (!assistantMsg.swipes.length) {
            delete assistantMsg.swipes;
            delete assistantMsg.swipeIndex;
          } else {
            assistantMsg.swipeIndex = Math.min(finalIdx, assistantMsg.swipes.length - 1);
            applySwipeToMessage(assistantMsg);
          }
        } else if (assistantMsg.swipes[finalIdx]) {
          assistantMsg.swipes[finalIdx].content = finalContent;
          if (finalReasoning) {
            assistantMsg.swipes[finalIdx].reasoning = finalReasoning;
          } else {
            delete assistantMsg.swipes[finalIdx].reasoning;
          }
          assistantMsg.swipes[finalIdx].timestamp = Date.now();
          // 单分支时不必保留 swipes 结构，保持旧数据形态整洁
          if (assistantMsg.swipes.length <= 1) {
            delete assistantMsg.swipes;
            delete assistantMsg.swipeIndex;
          }
        }
      }

      // 写入本轮的统计信息（模型 / Token / 缓存 / 耗时 / 时间）
      var endTime = (window.performance && performance.now) ? performance.now() : Date.now();
      var durationSec = Math.max(0, (endTime - startTime) / 1000).toFixed(1);

      var totalTokens = 0;
      var cachedTokens = 0;
      var outputTokens = 0;

      if (usageInfo) {
        calibratePromptTokens(activeModel.id, usageInfo.actualPromptTokens, rawEstimatedPromptTokens);
        totalTokens = usageInfo.totalTokens;
        cachedTokens = usageInfo.cachedTokens;
        outputTokens = usageInfo.outputTokens;
      } else if (answer || reasoning) {
        // 接口未返回 usage 时按字符数粗略估算，保证统计栏不出现 undefined
        outputTokens = estimateTokens(answer, activeModel.id);
        totalTokens = Math.round(rawEstimatedPromptTokens * getTokenCalibrationRatio(activeModel.id)) + outputTokens;
        cachedTokens = 0;
      }

      if (answer || reasoning) {
        // 按当前模型单价计算本轮人民币花费（未填写单价时不展示）
        var roundCostText = computeCostText(
          activeModel,
          totalTokens,
          cachedTokens,
          outputTokens
        );

        assistantMsg.meta = {
          modelId: activeModel.id,
          modelAlias: activeModel.alias || '',
          totalTokens: totalTokens,
          inputTokens: usageInfo ? usageInfo.inputTokens : Math.max(0, totalTokens - outputTokens),
          cachedTokens: cachedTokens,
          outputTokens: outputTokens,
          durationSec: durationSec,
          timeStr: formatClockTime()
        };
        if (roundCostText) assistantMsg.meta.costText = roundCostText;
        // 本轮命中的世界书词条：优先写入明细（书名/条目/命中词/位置/内容），
        // 旧版世界书模块只回传名称数组时退化为名称列表，保证弹窗仍可展示
        if (triggeredEntryDetails.length > 0) {
          assistantMsg.meta.triggeredWorldbooks = triggeredEntryDetails.map(function (item) {
            return {
              bookName: typeof item.bookName === 'string' ? item.bookName : '',
              entryName: typeof item.entryName === 'string' ? item.entryName : '',
              matchedKey: typeof item.matchedKey === 'string' ? item.matchedKey : '',
              position: typeof item.position === 'string' ? item.position : '',
              depth: Number(item.depth) >= 0 ? Math.round(Number(item.depth)) : 0,
              content: typeof item.content === 'string' ? item.content : ''
            };
          });
        } else if (triggeredEntryNames.length > 0) {
          assistantMsg.meta.triggeredWorldbooks = triggeredEntryNames.slice();
        }

      }
      session.updatedAt = Date.now();
      var targetSub = session.subChats.find(function (sub) { return sub.id === targetSubChatId; });
      if (targetSub) targetSub.updatedAt = session.updatedAt;
      flushSave();
      touchLastModified(); // AI 回复完成属于全局修改，刷新同步时间戳

      // 最外层 finally 统一释放本通道。

      // 通知记忆总结模块：新楼层已落库，刷新 Token 计数并按需触发自动增量总结
      try {
        if (window.MemorySummaryModule && typeof window.MemorySummaryModule.onMessageCommitted === 'function') {
          window.MemorySummaryModule.onMessageCommitted(session);
        }
      } catch (memErr) {
        console.warn('[记忆总结] 提交后回调执行失败：', memErr);
      }

      // AI 回复结束后延迟 1 秒静默上传云端（未配置同步时内部自动跳过）
      scheduleCloudUpload();

      if (!isCurrentSession(targetSession, targetSubChatId)) {
        // 后台完成只保存原通道，不操作当前视图。
      } else if (!bubble.isConnected) {
        // 流式期间用户切换过会话：若已切回本会话，按最终数据重绘一次
        if (isCurrentSession(targetSession, targetSubChatId)) renderMessages();
      } else if (bubble.classList.contains('bubble-error')) {
        // 错误气泡保持原样
      } else if (!answer && !reasoning) {
        // 极端情况下（例如直接抛错且气泡被清空）移除整条空气泡行，避免留下空壳占位
        var emptyRow = bubble.closest ? bubble.closest('.msg') : bubble.parentNode;
        if (emptyRow && emptyRow.parentNode) emptyRow.parentNode.removeChild(emptyRow);
      } else {
        // 最终态重绘：思维链自动收起，代码块补齐高亮与复制条
        bubble._finalized = true;
        renderAssistantBubble(
          bubble,
          { content: withPrefill(answer), reasoning: reasoning },
          false
        );
        // 用带操作栏的标准行替换临时流式气泡行，保证索引与数组严格对应
        replaceBubbleRowWithActions(bubble, session, assistantMsg);
        if (!keepScroll) scrollToBottom();
      }
    }
    } finally {
      if (task.bubbleRefs) task.bubbleRefs._finalized = true;
      if (activeGenerationMap.get(taskKey) === task) activeGenerationMap.delete(taskKey);
      syncStreamingUiState();
    }
    return { error: task.error || '', content: answer, msg: assistantMsg, aborted: task.controller.signal.aborted };
  }

  /* ===================================================================
     单条消息操作：复制 / 修改 / 重新回复 / 删除
     -------------------------------------------------------------------
     索引规范：data-index 与 session.messages 的下标严格一一对应，
     所有操作都按真实索引处理，过滤空占位不会打乱对应关系。
     =================================================================== */

  /**
   * 消息的可编辑完整文本（AI 消息包含思维链）
   */
  function getEditableText(msg) {
    if (!msg) return '';
    if (msg.role === 'user') return msg.content || '';

    var content = msg.content || '';
    var reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
    if (!reasoning) return content;
    // 正文里已经内嵌思维链标签：原样返回，避免重复包裹
    if (splitLeadingThink(content).hasThink) return content;
    return THINK_OPEN_TAG + reasoning + THINK_CLOSE_TAG + '\n' + content;
  }

  /**
   * 消息用于复制的纯文本：AI 消息只复制剥离思维链后的正式正文
   */
  function getCopyableText(msg) {
    if (!msg) return '';
    var content = msg.content || '';
    if (msg.role === 'user') return content;
    var answer = stripLeadingThink(content);
    // 极端情况：正文为空但存在独立思维链字段时，退化为思维链内容
    return answer || (typeof msg.reasoning === 'string' ? msg.reasoning : '');
  }

  /**
   * 一次数据变更后的统一收尾：落盘 + 刷新时间戳 + 重绘 + 云端同步
   * @param {boolean} rerender 是否整体重绘消息区
   */
  function commitMessagesChange(rerender) {
    var session = getCurrentSession();
    if (session) {
      session.updatedAt = Date.now();
      // 消息增删改后，把最新 messages 同步回当前激活的内部对话（并刷新其时间）
      syncActiveSubMessages(session, true);
    }
    flushSave();
    touchLastModified();
    renderSessionList();
    if (rerender !== false) renderMessages({ keepScroll: true });
    scheduleCloudUpload();
  }

  /**
   * 会话标题兜底：标题仍是自动生成结果时，跟随最新内容更新
   */
  function refreshSessionTitle() {
    var session = getCurrentSession();
    if (!session || (session.title && session.title !== DEFAULT_TITLE) ||
        !session.subChats[0] || session.subChats[0].id !== getActiveSubChatId(session)) return;
    var firstUser = null;
    for (var i = 0; i < session.messages.length; i++) {
      if (session.messages[i] && session.messages[i].role === 'user') {
        firstUser = session.messages[i];
        break;
      }
    }
    session.title = firstUser ? makeTitle(firstUser.content) : DEFAULT_TITLE;
  }

  /**
   * 复制：复制正文纯文本，按钮文字短暂变为「✓ 已复制」
   */
  function copyMessageAt(index, btn) {
    var session = getCurrentSession();
    var msg = session && session.messages[index];
    if (!msg) return;

    copyText(getCopyableText(msg), function (ok) {
      if (!btn) return;
      // 按钮内是纯 SVG 图标：复制成功时短暂替换为对勾 SVG，1200ms 后恢复，绝不写回文字
      var original = btn.getAttribute('data-icon-html');
      if (original === null) {
        original = btn.innerHTML;
        btn.setAttribute('data-icon-html', original);
      }
      if (ok) {
        btn.innerHTML = ACTION_ICONS.copied;
        btn.classList.add('is-copied');
      } else {
        btn.classList.add('is-copy-failed');
      }
      if (btn._copyTimer) clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(function () {
        btn.innerHTML = original;
        btn.classList.remove('is-copied', 'is-copy-failed');
      }, 1200);
    });
  }

  /**
   * 修改：把气泡正文替换为可编辑的多行文本框（原位编辑模式）
   */
  function startEditMessage(index) {
    var session = getCurrentSession();
    if (!session || isCurrentActiveChannelGenerating()) return;

    var msg = session.messages[index];
    var row = findMessageRow(index);
    if (!msg || !row) return;

    var bubble = row.querySelector('.bubble');
    if (!bubble || bubble.querySelector('.msg-edit')) return;

    bubble.classList.add('editing');

    var editor = document.createElement('div');
    editor.className = 'msg-edit';

    var textarea = document.createElement('textarea');
    textarea.className = 'msg-edit-textarea';
    textarea.rows = 4;
    textarea.value = getEditableText(msg);

    var actions = document.createElement('div');
    actions.className = 'msg-edit-actions';

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'msg-edit-btn btn-save';
    saveBtn.setAttribute('data-act', 'save');
    saveBtn.textContent = '保存修改';

    actions.appendChild(saveBtn);

    // 「保存并重答」仅对用户消息提供
    if (msg.role === 'user') {
      var regenBtn = document.createElement('button');
      regenBtn.type = 'button';
      regenBtn.className = 'msg-edit-btn btn-save-regen';
      regenBtn.setAttribute('data-act', 'save-regen');
      regenBtn.textContent = '保存并重答';
      actions.appendChild(regenBtn);
    }

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'msg-edit-btn btn-cancel';
    cancelBtn.setAttribute('data-act', 'cancel');
    cancelBtn.textContent = '取消';
    actions.appendChild(cancelBtn);

    editor.appendChild(textarea);
    editor.appendChild(actions);
    bubble.appendChild(editor);

    // 按钮事件：保存 / 保存并重答 / 取消
    actions.addEventListener('click', function (e) {
      var target = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!target) return;
      var act = target.getAttribute('data-act');

      if (act === 'cancel') {
        exitEditMessage(index);
        return;
      }
      if (act === 'save') {
        applyMessageEdit(index, textarea.value, false);
        return;
      }
      if (act === 'save-regen') {
        applyMessageEdit(index, textarea.value, true);
      }
    });

    textarea.focus();
    // 光标定位到末尾，便于继续补充内容
    try {
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    } catch (err) {
      /* 忽略浏览器差异 */
    }
  }

  /**
   * 退出编辑模式并恢复原渲染
   */
  function exitEditMessage(index) {
    var row = findMessageRow(index);
    if (!row) return;
    var bubble = row.querySelector('.bubble');
    if (bubble) bubble.classList.remove('editing');
    var editor = bubble ? bubble.querySelector('.msg-edit') : null;
    if (editor && editor.parentNode) editor.parentNode.removeChild(editor);
    refreshMessageRow(index);
  }

  /**
   * 保存编辑结果
   * @param {number} index 消息索引
   * @param {string} text 编辑后的文本
   * @param {boolean} alsoRegen 是否保存后立即重新请求 AI 回复（仅用户消息）
   */
  function applyMessageEdit(index, text, alsoRegen) {
    var session = getCurrentSession();
    if (!session || isCurrentActiveChannelGenerating()) return;

    var msg = session.messages[index];
    if (!msg) return;

    var value = String(text == null ? '' : text);
    if (!value.trim()) {
      void window.showAppAlert('消息内容不能为空');
      return;
    }

    // 「保存并重答」需要请求接口：先校验渠道配置，通过后再改动消息内容
    if (alsoRegen && msg.role === 'user') {
      var target = resolveActiveTarget();
      if (!target || (!target.provider.apiKey && providerNeedsKey(target.provider))) {
        void window.showAppAlert('请先配置渠道与模型');
        return;
      }
    }

    // 仅更新当前消息的 content；AI 消息的独立思维链字段由新文本取代
    msg.content = value;
    if (msg.role === 'assistant') delete msg.reasoning;

    if (alsoRegen && msg.role === 'user') {
      // 【楼层保护】严禁删除该条用户消息之后的后续楼层，
      // 只把「该用户楼层的下一条 assistant」原位覆盖重写；
      // 若下一条不是 assistant，则在该用户楼层之后插入新的 assistant 楼层。
      var nextMsg = session.messages[index + 1];
      var reuseIndex = nextMsg && nextMsg.role === 'assistant' ? index + 1 : -1;
      // 目标回复楼层之后还有消息 => 属于中间楼层重答，不要强行滚到底部
      var keepScroll = reuseIndex >= 0
        ? reuseIndex < session.messages.length - 1
        : index + 1 < session.messages.length;

      refreshSessionTitle();
      session.updatedAt = Date.now();
      persistSessions();
      touchLastModified();
      renderSessionList();
      // 中间楼层重答时保持当前滚动位置，不强行拉到底部
      renderMessages({ keepScroll: keepScroll, focusIndex: index });
      if (!keepScroll) forceScrollToBottom(); // 仅在重答最后一层时回到底部
      scheduleCloudUpload();
      requestAssistantReply(session, {
        cutoffUserIndex: index,
        reuseIndex: reuseIndex,
        keepScroll: keepScroll
      });
      return;
    }

    // 普通保存：不触发 AI 重新回答，只刷新该气泡
    refreshSessionTitle();
    refreshMessageRow(index);
    commitMessagesChange(false);
    refreshMemoryContext();
  }

  /**
   * 重新回复（楼层保护版：绝不删除后续楼层）
   * - AI 消息：定位其对应的用户楼层 uIndex = 上一条 user 消息，
   *   原位覆盖重写该条 AI 消息（后续楼层全部保留）
   * - 用户消息：以该条为 cutoffUserIndex，若下一条是 assistant 则原位覆盖，
   *   否则插入一条新的 assistant 楼层（后续楼层全部保留）
   */
  function regenerateMessageAt(index) {
    var session = getCurrentSession();
    if (!session || isCurrentActiveChannelGenerating()) return;
    var target = resolveActiveTarget();
    if (!target || (!target.provider.apiKey && providerNeedsKey(target.provider))) {
      void window.showAppAlert('请先配置渠道与模型');
      return;
    }

    var msg = session.messages[index];
    if (!msg) return;

    var cutoffUserIndex = -1;
    var reuseIndex = -1;

    // 是否走「多分支（swipe）保留」路径：原 AI 回复绝不丢失，而是作为历史分支保留
    var pushSwipeBranch = false;

    if (msg.role === 'assistant') {
      // 规则 B：向上寻找最近的一条用户消息作为请求上下文末尾
      for (var i = index - 1; i >= 0; i--) {
        if (session.messages[i] && session.messages[i].role === 'user') {
          cutoffUserIndex = i;
          break;
        }
      }
      reuseIndex = index; // 复用当前 AI 楼层（内容改走 swipes 分支槽位）
      pushSwipeBranch = true;
    } else if (msg.role === 'user') {
      // 规则 A：用户楼层之后的 assistant 复用为新分支，否则插入
      cutoffUserIndex = index;
      var nextMsg = session.messages[index + 1];
      if (nextMsg && nextMsg.role === 'assistant') {
        reuseIndex = index + 1;
        pushSwipeBranch = true;
      } else {
        reuseIndex = -1;
      }
    }

    if (cutoffUserIndex < 0) {
      void window.showAppAlert('此前没有用户提问');
      return;
    }

    // 目标回复楼层之后还有后续楼层 => 属于中间楼层重答，不要强行滚到底部
    var keepScroll = reuseIndex >= 0
      ? reuseIndex < session.messages.length - 1
      : cutoffUserIndex + 1 < session.messages.length;

    refreshSessionTitle();
    session.updatedAt = Date.now();
    persistSessions();
    touchLastModified();
    renderSessionList();
    // 中间楼层重答时保持当前滚动位置，不强行拉到底部
    renderMessages({ keepScroll: keepScroll, focusIndex: reuseIndex >= 0 ? reuseIndex : cutoffUserIndex });
    if (!keepScroll) forceScrollToBottom(); // 仅在重答最后一层时回到底部
    scheduleCloudUpload();

    requestAssistantReply(session, {
      cutoffUserIndex: cutoffUserIndex,
      reuseIndex: reuseIndex,
      keepScroll: keepScroll,
      // 重新回复：旧回复移入 swipes 历史分支，新回复写入新分支槽位
      swipeBranch: pushSwipeBranch
    });
  }

  /**
   * 删除：从会话中彻底移除该条消息
   */
  async function deleteMessageAt(index) {
    var session = getCurrentSession();
    if (!session) return;

    var msg = session.messages[index];
    if (!msg) return;

    // 删除属于不可撤销操作：必须先二次确认
    if (!await window.showAppConfirm('删除这条消息？')) return;
    if (isCurrentActiveChannelGenerating() || getCurrentSession() !== session || session.messages[index] !== msg) return;

    session.messages.splice(index, 1);
    refreshSessionTitle();
    commitMessagesChange(true);
  }

  /**
   * 统一的操作入口（事件委托）
   */
  function handleMessageAction(event) {
    var btn = event.target.closest
      ? event.target.closest('.msg-action-btn, .msg-swipe-btn')
      : null;
    if (!btn) return;

    event.preventDefault();
    event.stopPropagation();

    var index = parseInt(btn.getAttribute('data-index'), 10);
    if (!isFinite(index) || index < 0) return;

    var action = btn.getAttribute('data-role');

    if (action === 'copy') {
      copyMessageAt(index, btn);
      return;
    }

    if (activeGenerationMap.size > 0) {
      void window.showAppAlert('请等待回复结束');
      return;
    }

    // 多分支切换：上一条 / 下一条，原位换内容后重绘该楼层
    if (action === 'swipe-prev') {
      switchMessageSwipe(index, -1);
      return;
    }
    if (action === 'swipe-next') {
      switchMessageSwipe(index, 1);
      return;
    }

    if (action === 'edit') {
      startEditMessage(index);
    } else if (action === 'regen') {
      regenerateMessageAt(index);
    } else if (action === 'delete') {
      deleteMessageAt(index);
    }
  }

  /**
   * 触摸屏（无悬浮能力）下点击气泡切换操作栏显示
   */
  function toggleActionsOnTouch(event) {
    if (hasHoverDevice()) return;
    // 点到按钮或编辑区时不处理
    if (event.target.closest && event.target.closest('.msg-action-btn, .msg-edit')) return;

    var bubble = event.target.closest ? event.target.closest('.bubble') : null;
    if (!bubble) return;
    var row = bubble.closest('.msg');
    if (!row) return;

    var opened = row.classList.contains('actions-open');
    var rows = els.chatArea.querySelectorAll('.msg');
    Array.prototype.forEach.call(rows, function (item) {
      item.classList.remove('actions-open');
    });
    if (!opened) row.classList.add('actions-open');
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
    return scope === 'all' ? '所有对话' : '当前对话';
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
    var list = scope === 'all' ? sessions : (getCurrentSession() ? [getCurrentSession()] : []);

    list.forEach(function (session) {
      if (!session) return;
      var sessionTitle = session.title || DEFAULT_TITLE;

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
    if (els.headerSearchWrap) els.headerSearchWrap.classList.add('is-open');
    if (els.chatSearchToggle) els.chatSearchToggle.setAttribute('aria-expanded', 'true');
    closeSidebar();
    if (els.chatSearchInput) els.chatSearchInput.focus();
    renderSearchDropdown();
  }

  function closeSearch(restoreFocus) {
    closeSearchDropdown();
    if (els.headerSearchWrap) els.headerSearchWrap.classList.remove('is-open');
    if (els.chatSearchToggle) els.chatSearchToggle.setAttribute('aria-expanded', 'false');
    if (els.chatSearchInput) els.chatSearchInput.blur();
    if (restoreFocus && els.chatSearchToggle && window.matchMedia('(max-width: 768px)').matches) {
      els.chatSearchToggle.focus();
    }
  }

  /**
   * 渲染搜索结果浮层
   */
  function renderSearchDropdown() {
    if (!els.chatSearchDropdown || !els.chatSearchInput) return;

    var keyword = els.chatSearchInput.value.trim();
    if (els.chatSearchClear) els.chatSearchClear.hidden = !keyword;
    if (!keyword) {
      closeSearchDropdown();
      return;
    }

    var results = collectSearchResults(keyword, searchScope);
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

    results.forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-result-item';
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
    var isSame = currentId === sessionId;

    if (!isSame) {
      if (!getSession(sessionId)) return;
      captureInputDraft();
      flushSave();
      currentId = sessionId;
      restoreInputDraft();
      var target = getSession(sessionId);
      if (target) ensureSessionSubChats(target);
      persistSessions();
      renderSessionList();
      refreshQuickParamsPanel();
      refreshPresetButtonState();
      // 不复用上一会话的滚动位置，避免定位前出现无意义的跳动
      els.chatArea.scrollTop = 0;
    }

    // 重绘时不做任何滚动，由下方的 scrollIntoView 统一接管定位
    renderMessages({ noScroll: true });

    // #0 系统提示词层已迁到顶部控制台：展开下拉并高亮命中的小模块行
    if (targetFloor === 0) {
      jumpToSystemPromptModule();
      return;
    }

    var node = ensureMessageRendered(targetFloor - 1);
    if (!node) return;

    if (node.scrollIntoView) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    flashSearchKeyword(node);
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

    if (hitRow.scrollIntoView) {
      hitRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    flashFloorNode(hitRow);
  }

  /**
   * 绑定搜索组件事件（由 INIT_EVENTS 的 bindEvents 调用）
   */
  function bindSearchEvents() {
    if (!els.chatSearchInput) return;
    if (els.chatSearchToggle) els.chatSearchToggle.addEventListener('click', function () {
      if (els.headerSearchWrap.classList.contains('is-open')) closeSearch(true);
      else openSearch();
    });
    if (els.chatSearchClose) els.chatSearchClose.addEventListener('click', function () {
      closeSearch(true);
    });

    // 输入即搜索
    els.chatSearchInput.addEventListener('input', function () {
      renderSearchDropdown();
    });

    // 聚焦时若有内容则重新展开
    els.chatSearchInput.addEventListener('focus', function () {
      if (els.chatSearchInput.value.trim()) renderSearchDropdown();
    });

    // 回车：直接跳转到第一条结果
    els.chatSearchInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var first = els.chatSearchDropdown.querySelector('.search-result-item');
      if (!first) return;
      jumpToSearchResult(
        first.getAttribute('data-session-id'),
        parseInt(first.getAttribute('data-floor'), 10)
      );
      closeSearch(true);
    });

    // 清空按钮
    if (els.chatSearchClear) {
      els.chatSearchClear.addEventListener('click', function () {
        els.chatSearchInput.value = '';
        els.chatSearchClear.hidden = true;
        closeSearchDropdown();
        els.chatSearchInput.focus();
      });
    }

    // 范围切换胶囊：当前对话 ↔ 所有对话
    if (els.chatSearchScope) {
      els.chatSearchScope.addEventListener('click', function () {
        searchScope = searchScope === 'current' ? 'all' : 'current';
        els.chatSearchScope.setAttribute('data-scope', searchScope);
        els.chatSearchScope.textContent = getSearchScopeLabel(searchScope);
        renderSearchDropdown();
      });
    }

    // 点击结果项：跳转并收起浮层
    if (els.chatSearchDropdown) {
      els.chatSearchDropdown.addEventListener('click', function (e) {
        var item = e.target.closest ? e.target.closest('.search-result-item') : null;
        if (!item) return;
        var sid = item.getAttribute('data-session-id');
        var floor = parseInt(item.getAttribute('data-floor'), 10);
        if (!sid || !isFinite(floor)) return;
        jumpToSearchResult(sid, floor);
        closeSearch(true);
      });
    }

    // 点击搜索区域外部时自动收起浮层
    document.addEventListener('click', function (e) {
      if (!els.headerSearchWrap) return;
      if (els.headerSearchWrap.contains(e.target)) return;
      closeSearch(false);
    });

    // Esc 同时关闭空输入状态，焦点退回移动端入口。
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!els.headerSearchWrap || (!els.headerSearchWrap.classList.contains('is-open') &&
          els.chatSearchDropdown.hidden && document.activeElement !== els.chatSearchInput)) return;
      closeSearch(true);
    });
  }

  // === [ANCHOR: CLOUD_SYNC] Gitee/GitHub Gist 云端同步与混淆加密 ===
  /* ===================================================================
     云同步模块（Gitee / GitHub Gist 全自动双向同步）
     -------------------------------------------------------------------
     安全原则：
     1. 所有云端请求都包裹在 try...catch 中，失败只在顶部按钮提示并在控制台
        打印详情，绝不阻塞或影响本地 AI 聊天功能。
     2. 以 lastModified 时间戳判定新旧：云端更新则覆盖本地，本地更新则上传云端。
     3. 主数据压缩、分片后优先提交；当日快照与 7 天旧快照清理独立提交，
        备份失败不影响主同步成功状态。
     =================================================================== */

  // 顶部同步按钮的状态：idle | syncing | ok | error
  var syncState = 'idle';
  var lastSyncAt = 0;       // 最近一次同步成功的时间
  var syncInFlight = false;   // 是否有同步请求正在进行，避免重复请求
  var uploadInFlight = false; // 是否有上传请求正在进行，避免并发覆盖
  var uploadTimer = null;     // 1 秒延迟上传计时器
  var pendingCloudSync = false; // 前台同步被生成或锁阻挡时合并补跑
  var pendingCloudSyncSilent = true;
  var cloudSyncRetryTimer = null;

  function queueCloudSync(silent) {
    pendingCloudSync = true;
    if (silent === false) pendingCloudSyncSilent = false;
    if (cloudSyncRetryTimer) return;
    cloudSyncRetryTimer = setTimeout(function retry() {
      cloudSyncRetryTimer = null;
      if (!pendingCloudSync) return;
      if (!isSyncConfigured() || (pendingCloudSyncSilent && !config.autoSync)) {
        pendingCloudSync = false;
        pendingCloudSyncSilent = true;
        return;
      }
      if (activeGenerationMap.size > 0 || isSyncing || syncInFlight || uploadInFlight || applyingCloudData) {
        cloudSyncRetryTimer = setTimeout(retry, 250);
        return;
      }
      var silentRun = pendingCloudSyncSilent;
      pendingCloudSync = false;
      pendingCloudSyncSilent = true;
      syncWithCloud(silentRun);
    }, 250);
  }

  function requestForegroundCloudSync() {
    if (!isSyncConfigured() || !config.autoSync) return;
    if (lastSyncAt && Date.now() - lastSyncAt < 5000) return;
    if (activeGenerationMap.size > 0 || isSyncing || syncInFlight || uploadInFlight || applyingCloudData) {
      queueCloudSync(true);
      return;
    }
    syncWithCloud(true);
  }

  var cachedGistFiles = null; // 已知云端文件字典，仅驻留内存
  var lastBackupUploadAt = 0; // 最近一次快照维护成功时间，刷新后沿用本地冷却
  try { lastBackupUploadAt = Number(localStorage.getItem(LAST_BACKUP_MAINT_AT_KEY) || 0) || 0; } catch (e) {}
  var cachedGistIdentity = ''; // 切换平台、令牌或 Gist 时隔离缓存
  var cachedGistIdentityInitialized = false;

  // 全局同步互斥锁：上传 / 拉取期间忽略重复点击，防止接口限流
  var isSyncing = false;

  var CLOUD_CHUNK_MAX = 750 * 1024;
  var SYNC_CHUNK_PREFIX = 'mychat_latest_part_';

  /* ---------- 云端混淆加密 / 解密（UTF-8 安全的 Base64 + 字符反转） ---------- */

  /**
   * 把字符串编码为 UTF-8 安全的 Base64（兼容中文与 emoji）
   */
  function utf8ToBase64(text) {
    var str = String(text == null ? '' : text);
    try {
      // 优先使用浏览器原生编码：先转 UTF-8 字节，再转 Latin1 字符串
      var bytes = new TextEncoder().encode(str);
      var latin = '';
      for (var i = 0; i < bytes.length; i++) {
        latin += String.fromCharCode(bytes[i]);
      }
      return btoa(latin);
    } catch (err) {
      try {
        return btoa(unescape(encodeURIComponent(str)));
      } catch (e2) {
        console.warn('[云同步] Base64 编码失败，将以明文上传：', e2);
        return '';
      }
    }
  }

  /**
   * 把 Base64 字符串解码还原为原始 UTF-8 文本
   */
  function base64ToUtf8(b64) {
    try {
      var latin = atob(b64);
      var bytes = new Uint8Array(latin.length);
      for (var i = 0; i < latin.length; i++) {
        bytes[i] = latin.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch (err) {
      try {
        return decodeURIComponent(escape(atob(b64)));
      } catch (e2) {
        throw new Error('云端加密数据解码失败，可能是数据已损坏');
      }
    }
  }

  /**
   * 混淆：明文 JSON -> { _encrypted: true, payload: "<Base64 反转>" }
   */
  function encryptCloudContent(jsonText) {
    var b64 = utf8ToBase64(jsonText);
    if (!b64) return jsonText; // 编码不可用时降级为明文，保证同步不中断
    var reversed = b64.split('').reverse().join('');
    return JSON.stringify({ _encrypted: true, payload: reversed });
  }

  /**
   * 解混淆：兼容加密格式与历史明文格式（向下 100% 兼容）
   * @return {string|null} 还原后的 JSON 字符串
   */
  function decryptCloudContent(rawContent) {
    var text = typeof rawContent === 'string' ? rawContent.trim() : '';
    if (!text) return null;

    var wrapper = safeJsonParse(text);
    if (
      wrapper &&
      typeof wrapper === 'object' &&
      wrapper._encrypted === true &&
      typeof wrapper.payload === 'string'
    ) {
      var reversed = wrapper.payload.split('').reverse().join('');
      return base64ToUtf8(reversed);
    }

    // 旧版本明文记录：原样返回
    return text;
  }

  // 32KB 分块转换，避免逐字节拼接与超大参数列表。
  function uint8ToBase64Fast(bytes) {
    var chunks = [];
    for (var i = 0; i < bytes.length; i += 32768) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)));
    }
    return btoa(chunks.join(''));
  }

  function swapBase64Halves(b64) {
    var mid = Math.floor(b64.length / 2);
    return b64.slice(mid) + b64.slice(0, mid);
  }

  function unswapBase64Halves(swapped) {
    var mid = Math.ceil(swapped.length / 2);
    return swapped.slice(mid) + swapped.slice(0, mid);
  }

  // 压缩失败明确报错并终止上传，禁止降级为未压缩的巨型请求。
  async function encryptCloudContentAsync(jsonText, metaObj) {
    try {
      var rawStr = String(jsonText || '');
      var compressedStream = new Blob([rawStr]).stream().pipeThrough(new CompressionStream('gzip'));
      var compressedBuffer = await new Response(compressedStream).arrayBuffer();
      var compressedBytes = new Uint8Array(compressedBuffer);
      var b64 = uint8ToBase64Fast(compressedBytes);
      var obfuscated = swapBase64Halves(b64);
      console.log('[云同步] Gzip 压缩生效：原始 ' + Math.round(rawStr.length / 1024) + 'KB -> 压缩后 ' + Math.round(obfuscated.length / 1024) + 'KB');
      return JSON.stringify({ _encrypted: true, _compressed: 'gzip_v2', payload: obfuscated, _meta: metaObj || null });
    } catch (err) {
      console.error('[云同步] Gzip 压缩异常降级：', err);
      throw err;
    }
  }

  async function decryptCloudContentAsync(rawContent) {
    var wrapper = safeJsonParse(typeof rawContent === 'string' ? rawContent.trim() : '');
    if (wrapper && wrapper._encrypted === true &&
        (wrapper._compressed === 'gzip_v2' || wrapper._compressed === 'gzip') &&
        typeof wrapper.payload === 'string') {
      if (typeof DecompressionStream !== 'function') {
        throw new Error('当前浏览器不支持 Gzip 解压');
      }
      var b64 = wrapper._compressed === 'gzip_v2'
        ? unswapBase64Halves(wrapper.payload)
        : wrapper.payload.split('').reverse().join('');
      var latin = atob(b64);
      var bytes = new Uint8Array(latin.length);
      for (var i = 0; i < latin.length; i++) bytes[i] = latin.charCodeAt(i);
      var decompressedStream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(decompressedStream).text();
    }
    return decryptCloudContent(rawContent);
  }

  // 主文件只保存完整密文或分片清单，旧分片在同一次提交中清理。
  function buildSyncedFileMap(encryptedStr, existingFiles) {
    var files = {};
    var chunks = [];
    if (encryptedStr.length <= CLOUD_CHUNK_MAX) {
      files[SYNC_FILE_NAME] = { content: encryptedStr };
    } else {
      for (var offset = 0; offset < encryptedStr.length; offset += CLOUD_CHUNK_MAX) {
        chunks.push(encryptedStr.slice(offset, offset + CLOUD_CHUNK_MAX));
      }
      chunks.forEach(function (chunk, i) {
        files[SYNC_CHUNK_PREFIX + i + '.dat'] = { content: chunk };
      });
      var wrapper = safeJsonParse(encryptedStr);
      var meta = wrapper && wrapper._meta || null;
      var stamp = meta ? meta.lastModified : getLocalLastModified() || Date.now();
      files[SYNC_FILE_NAME] = { content: JSON.stringify({
        _chunked: true, totalChunks: chunks.length, lastModified: stamp, _meta: meta
      }) };
    }
    Object.keys(existingFiles || {}).forEach(function (name) {
      if (name.indexOf(SYNC_CHUNK_PREFIX) === 0 &&
          !Object.prototype.hasOwnProperty.call(files, name)) files[name] = null;
    });
    return files;
  }

  /**
   * 是否已填写同步令牌（令牌为空即视为未配置）
   */
  function isSyncConfigured() {
    return !!(config.syncToken && config.syncToken.trim());
  }

  /**
   * 本地是否已有真实聊天内容（至少一条消息）
   */
  function hasMeaningfulLocalData() {
    return computeLocalDataStats().totalMessages > 0;
  }

  // 子对话是完整数据源；顶层消息只是活跃分支镜像，不重复计数。
  function computeCloudDataStats(data) {
    data = data || {};
    var list = Array.isArray(data.sessions) ? data.sessions : [];
    var totalMsgs = 0;
    list.forEach(function (session) {
      if (!session) return;
      var branches = Array.isArray(session.subChats) && session.subChats.length > 0
        ? session.subChats : [session];
      branches.forEach(function (subChat) {
        if (subChat && Array.isArray(subChat.messages)) totalMsgs += subChat.messages.length;
      });
    });
    return { lastModified: Number(data.lastModified) || 0, sessionCount: list.length, totalMessages: totalMsgs };
  }

  function computeLocalDataStats() {
    return computeCloudDataStats({ lastModified: getLocalLastModified(), sessions: sessions });
  }

  function createCloudMeta(payload) {
    return Object.assign(computeCloudDataStats(payload), { updatedAt: Date.now() });
  }

  /**
   * 云端数据中是否已有真实聊天内容
   */
  function remoteHasMeaningfulData(payload) {
    if (!payload) return false;
    return computeCloudDataStats(payload).totalMessages > 0 ||
      ['promptPresets', 'worldbooks', 'regexRules'].some(function (key) {
        return Array.isArray(payload[key]) && payload[key].length > 0;
      });
  }

  /**
   * 把最近同步时间格式化为「刚刚 / x 分钟前」
   */
  function formatSyncAgo(ts) {
    if (!ts) return '刚刚';
    var diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚';
    var minutes = Math.floor(diff / 60000);
    if (minutes < 60) return minutes + ' 分钟前';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' 小时前';
    return Math.floor(hours / 24) + ' 天前';
  }

  /**
   * 根据当前配置与状态刷新顶部同步按钮
   */
  function renderSyncStatus() {
    if (!els.syncStatusBtn) return;

    // 只更新文字节点，保留左侧单色云朵 SVG 图标
    var textEl = els.syncStatusText || els.syncStatusBtn;

    els.syncStatusBtn.classList.remove('state-syncing', 'state-ok', 'state-error');

    if (!isSyncConfigured()) {
      textEl.textContent = '未配置同步';
      els.syncStatusBtn.title = '点击前往【设置】配置云端同步';
      return;
    }

    els.syncStatusBtn.title = '点击立即同步云端数据';

    if (syncState === 'syncing') {
      textEl.textContent = '同步中...';
      els.syncStatusBtn.classList.add('state-syncing');
    } else if (syncState === 'ok') {
      textEl.textContent = '✓ 已同步 (' + formatSyncAgo(lastSyncAt) + ')';
      els.syncStatusBtn.classList.add('state-ok');
    } else if (syncState === 'error') {
      textEl.textContent = '同步失败';
      els.syncStatusBtn.classList.add('state-error');
    } else if (syncState === '已暂停同步') {
      textEl.textContent = '已暂停同步';
    } else {
      textEl.textContent = '云同步';
    }
  }

  /**
   * 设置同步状态并立即刷新按钮
   */
  function setSyncStatus(state) {
    syncState = state;
    renderSyncStatus();
  }

  /**
   * 统一的同步错误处理：只更新按钮状态并打印详情，绝不向上抛出
   */
  function handleSyncError(err) {
    console.error('[云同步] 同步失败：', err);
    setSyncStatus('error');
  }


  /**
   * 当前平台对应的 Gist API 基础路径
   */
  function getGistApiBase() {
    return config.syncPlatform === 'github' ? SYNC_API_BASE.github : SYNC_API_BASE.gitee;
  }

  /**
   * 发起 Gist 请求：
   * - GitHub：Authorization: token <TOKEN>
   * - Gitee：令牌放在 URL 参数 access_token 中（避免额外的 CORS 预检）
   */
  function gistFetch(path, method, body) {
    var url = getGistApiBase() + path;
    var headers = { 'Accept': 'application/json' };

    // 仅在携带请求体时才声明 JSON 类型，减少无谓的跨域预检
    if (body) headers['Content-Type'] = 'application/json';

    if (config.syncPlatform === 'github') {
      headers['Authorization'] = 'token ' + config.syncToken;
    } else {
      url +=
        (url.indexOf('?') === -1 ? '?' : '&') +
        'access_token=' +
        encodeURIComponent(config.syncToken);
    }

    return fetch(url, {
      method: method || 'GET',
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
  }

  /**
   * 请求并解析 Gist 接口，非 2xx 时抛出带中文说明的错误
   */
  async function gistRequest(path, method, body) {
    var res = await gistFetch(path, method, body);

    var text = '';
    try {
      text = await res.text();
    } catch (readErr) {
      text = '';
    }

    if (!res.ok) {
      var parsed = safeJsonParse(text);
      var detail = '';
      if (parsed) {
        detail =
          parsed.message ||
          (parsed.error && (parsed.error.message || JSON.stringify(parsed.error))) ||
          '';
      }
      if (!detail) detail = String(text || res.statusText || '').slice(0, 200);
      throw new Error('Gist 接口请求失败（HTTP ' + res.status + '）：' + detail);
    }

    return safeJsonParse(text) || {};
  }

  /**
   * 组装当前要写入云端的完整数据
   * 除会话外，还打包渠道 / 模型 / 当前模型 / 主题 / 视图与预留槽位，
   * 由上传流程统一做 Gzip + Base64 对调混淆
   */
  function buildCloudPayload(lastModified, forCloud) {
    // 仅打包当前受支持字段，不透传历史镜像中的废弃或重复大字段。
    var payload = {
      schemaVersion: CLOUD_SCHEMA_VERSION,
      lastModified: typeof lastModified === 'number' ? lastModified : Date.now(),
      currentId: currentId || '',
      sessions: serializeSessions(),
      globalTavernVars: MyChatBridge.getGlobalTavernVars(),
      // 渠道与模型配置（含名称、接口地址、API Key、别名与三档单价）
      providers: providers,
      // 当前选中的渠道与模型
      activeTarget: {
        providerId: activeTarget.providerId || '',
        modelId: activeTarget.modelId || ''
      },
      // 界面偏好：深浅色主题与气泡 / 宽屏视图
      theme: uiState.dark ? 'dark' : 'light',
      // 历史偏好仅用于备份兼容，不再控制布局。
      wideView: localStorage.getItem(VIEW_KEY) === 'wide' ? 'wide' : 'bubble',
      config: Object.assign({}, config)
    };

    // 预留槽位：对话参数与模块化系统提示词预设（本地存在才打包）
    var chatParamsData = readStorageValue(CHAT_PARAMS_KEY);
    payload.chatParams = chatParamsData !== null ? chatParamsData : getGlobalChatParams();

    // 预设库优先使用内存镜像，保证刚做完增删改就同步时拿到的是最新数据
    if (Array.isArray(promptPresets) && promptPresets.length > 0) {
      payload.promptPresets = promptPresets;
    } else {
      var presetData = readStorageValue(PROMPT_PRESETS_KEY);
      payload.promptPresets = presetData !== null ? presetData : [];
    }

    // 正则与输入 / 输出预处理规则库：与预设库保持相同的打包方式
    var regexRulesData = readStorageValue(REGEX_RULES_KEY);
    payload.regexRules = regexRulesData !== null ? regexRulesData : [];

    // 全局世界书库（mychat_worldbooks）：本地存在才打包，
    // 与 applyCloudExtras 的「字段缺失则跳过」保护一一对应
    var worldbooksData = readStorageValue(WORLDBOOKS_KEY);
    payload.worldbooks = worldbooksData !== null ? worldbooksData : [];

    payload.vocabRules = readStorageValue(VOCAB_RULES_KEY) || [];
    payload.quickReplies = readStorageValue(QUICK_REPLIES_KEY);
    payload.autoRetry = readStorageValue(AUTO_RETRY_KEY);
    // 未知扩展仅保留小值；旧载荷、备份及快照等容器不再透传。
    var mirror = readStorageValue(CLOUD_MIRROR_KEY);
    var extensionBytes = 0;
    if (mirror && typeof mirror === 'object' && !Array.isArray(mirror)) {
      Object.keys(mirror).forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(payload, key) ||
            /^(?:__proto__|constructor|prototype)$/.test(key) ||
            /session|message|snapshot|backup|history|payload|content|data|config|provider|preset|worldbook/i.test(key)) return;
        try {
          var size = new Blob([JSON.stringify(mirror[key])]).size + new Blob([key]).size;
          if (size > 4096 || extensionBytes + size > 16384) return;
          payload[key] = mirror[key];
          extensionBytes += size;
        } catch (err) { /* 非 JSON 扩展值不参与同步。 */ }
      });
    }
    // 仅替换云传输副本的嵌套对象，不触碰运行时或 IndexedDB 的完整历史。
    if (forCloud === true) {
      payload.sessions = payload.sessions.map(function (session) {
        if (!Array.isArray(session.subChats)) return session;
        return Object.assign({}, session, { subChats: session.subChats.map(function (subChat) {
          var memory = subChat.memoryData;
          if (!memory || !Array.isArray(memory.snapshots) || memory.snapshots.length <= 5) return subChat;
          return Object.assign({}, subChat, { memoryData: Object.assign({}, memory, {
            snapshots: memory.snapshots.slice(-5)
          }) });
        }) });
      });
    }
    return payload;
  }

  /**
   * 解析云端主文件内容，结构异常时返回 null
   * 自动识别加密包装（_encrypted: true）并解密，明文记录直接解析
   */
  function parseCloudPayload(rawContent) {
    var plain = rawContent;
    try {
      plain = decryptCloudContent(rawContent);
    } catch (decErr) {
      console.warn('[云同步] 云端数据解密失败：', decErr);
      return null;
    }

    var data = safeJsonParse(plain);
    if (!data || typeof data !== 'object') return null;

    var list = [];
    if (Array.isArray(data.sessions)) {
      data.sessions.forEach(function (item) {
        // 解析仅校验结构；基础配置恢复后才能规范化旧会话。
        if (item && typeof item === 'object' && !Array.isArray(item)) list.push(item);
      });
    }

    // 解析阶段不写底板；仅在用户真正采用这份云端数据时落盘，避免探测污染。
    return Object.assign({}, data, {
      lastModified:
        typeof data.lastModified === 'number' &&
        isFinite(data.lastModified) &&
        data.lastModified > 0
          ? data.lastModified
          : 0,
      currentId: typeof data.currentId === 'string' ? data.currentId : '',
      sessions: list,
      // ===== 扩展同步数据：旧版云端数据缺少这些字段，缺失时统一下降为空值 =====
      providers: Array.isArray(data.providers) ? data.providers : null,
      activeTarget:
        data.activeTarget && typeof data.activeTarget === 'object' ? data.activeTarget : null,
      theme: data.theme === 'dark' || data.theme === 'light' ? data.theme : '',
      wideView: data.wideView === 'wide' || data.wideView === 'bubble' ? data.wideView : '',
      chatParams: Object.prototype.hasOwnProperty.call(data, 'chatParams')
        ? data.chatParams
        : null,
      promptPresets: Object.prototype.hasOwnProperty.call(data, 'promptPresets')
        ? data.promptPresets
        : null,
      regexRules: Object.prototype.hasOwnProperty.call(data, 'regexRules')
        ? data.regexRules
        : null,
      // 世界书词条库（mychat_worldbooks）：缺失时保持 null，交由 applyCloudExtras 跳过写入
      worldbooks: Object.prototype.hasOwnProperty.call(data, 'worldbooks')
        ? data.worldbooks
        : null,
      vocabRules: Array.isArray(data.vocabRules) ? data.vocabRules : null,
      quickReplies: data.quickReplies && typeof data.quickReplies === 'object' ? data.quickReplies : null,
      autoRetry: data.autoRetry && typeof data.autoRetry === 'object' ? data.autoRetry : null
    });
  }

  async function parseCloudPayloadAsync(rawContent) {
    if (typeof rawContent === 'string' && !rawContent.trim()) return null;
    try {
      var payload = parseCloudPayload(await decryptCloudContentAsync(rawContent));
      if (!payload) throw new Error('无效云端载荷');
      return payload;
    } catch (decErr) {
      console.warn('[云同步] 云端数据解密或解析失败：', decErr);
      throw new Error('云端数据解析失败，已中止同步以保护云端数据');
    }
  }

  /**
   * 确保拿到可用的 Gist ID：
   *   1. 本地已保存则直接使用；
   *   2. 否则遍历 Gist 列表，查找描述为 MyChat_Cloud_Sync_Data
   *      或已包含 mychat_latest.json 的 Gist；
   *   3. 仍未找到则自动创建一个私有 Gist 并回填 ID。
   */
  async function ensureGistId(readOnly) {
    var identity = JSON.stringify([config.syncPlatform, config.syncToken, config.gistId]);
    if (identity !== cachedGistIdentity) {
      cachedGistIdentity = identity;
      cachedGistFiles = null;
      // 初次绑定缓存身份不清空持久化冷却；真实切换连接才重置。
      if (lastBackupUploadAt && cachedGistIdentityInitialized) {
        lastBackupUploadAt = 0;
        try { localStorage.removeItem(LAST_BACKUP_MAINT_AT_KEY); } catch (e) {}
      }
      cachedGistIdentityInitialized = true;
    }
    if (config.gistId) return config.gistId;

    // 1. 拉取 Gist 列表（最多 3 页 × 100 个，足够普通用户使用）
    var all = [];
    for (var page = 1; page <= 3; page++) {
      var pageList = await gistRequest('?per_page=100&page=' + page, 'GET');
      if (!Array.isArray(pageList) || pageList.length === 0) break;
      all = all.concat(pageList);
      if (pageList.length < 100) break;
    }

    var matched = null;
    for (var i = 0; i < all.length; i++) {
      var item = all[i];
      if (!item || !item.id) continue;
      var files = item.files || {};
      if (
        item.description === SYNC_GIST_DESC ||
        Object.prototype.hasOwnProperty.call(files, SYNC_FILE_NAME)
      ) {
        matched = item;
        break;
      }
    }

    // 2. 找到历史同步 Gist：直接复用，手机端只填 Token 就能连上电脑端数据
    if (matched) {
      config.gistId = matched.id;
      cachedGistIdentity = JSON.stringify([config.syncPlatform, config.syncToken, config.gistId]);
      persistConfig(true);
      console.log('[云同步] 已自动找到历史同步 Gist：' + matched.id);
      return config.gistId;
    }

    if (readOnly) throw new Error('未找到云端数据');
    // 3. 没找到则新建私有 Gist，并写入一份当前数据
    // 注意：这里不刷新全局时间戳，避免仅"创建 Gist"就被判定为本地有新修改
    var initPayload = buildCloudPayload(getLocalLastModified() || Date.now(), true);
    var initContent = await encryptCloudContentAsync(JSON.stringify(initPayload), createCloudMeta(initPayload));
    var initFiles = buildSyncedFileMap(initContent, {});

    var created = await gistRequest('', 'POST', {
      description: SYNC_GIST_DESC,
      public: false,
      files: initFiles
    });

    if (!created || !created.id) {
      throw new Error('创建 Gist 失败：接口未返回有效的 Gist ID');
    }

    config.gistId = created.id;
    cachedGistIdentity = JSON.stringify([config.syncPlatform, config.syncToken, config.gistId]);
    cachedGistFiles = Object.assign({}, created.files || initFiles);
    persistConfig(true);
    localStorage.setItem(LAST_SYNCED_CLOUD_STAMP_KEY, String(initPayload.lastModified));
    console.log('[云同步] 已自动创建私有同步 Gist：' + created.id);
    return config.gistId;
  }

  /**
   * 用云端数据覆盖本地并重绘界面
   * 时间戳沿用云端值，保证下次比对口径一致
   */
  // 原始字符串快照保留「不存在」与空字符串的区别，不能重新序列化旧数据。
  function createStorageSnapshot() {
    var keys = [CONFIG_KEY, PROVIDERS_KEY, ACTIVE_TARGET_KEY, SESSIONS_KEY, CURRENT_ID_KEY,
      LAST_MODIFIED_KEY, THEME_KEY, VIEW_KEY, CHAT_PARAMS_KEY, PROMPT_PRESETS_KEY,
      REGEX_RULES_KEY, WORLDBOOKS_KEY, VOCAB_RULES_KEY, QUICK_REPLIES_KEY,
      GLOBAL_TAVERN_VARS_KEY, AUTO_RETRY_KEY, CLOUD_MIRROR_KEY];
    var storage = {};
    keys.forEach(function (key) { storage[key] = localStorage.getItem(key); });
    return { storage: storage, cache: new Map(storageCache), memory: JSON.parse(JSON.stringify({config: config,
      providers: providers, activeTarget: activeTarget, sessions: sessions, currentId: currentId,
      globalChatParams: globalChatParams, promptPresets: promptPresets, uiState: uiState,
      inputDraftDirty: inputDraftDirty})), input: els.input ? els.input.value : '' };
  }

  function restoreStorageSnapshot(snapshot) {
    var failures = [];
    // 先释放本轮写入的空间，再还原旧字符串，避免新旧包同时占用配额。
    Object.keys(snapshot.storage).forEach(function (key) {
      try { if (localStorage.getItem(key) !== snapshot.storage[key]) localStorage.removeItem(key); }
      catch (err) { failures.push(key); }
    });
    Object.keys(snapshot.storage).forEach(function (key) {
      try {
        var raw = snapshot.storage[key];
        if (raw !== null && localStorage.getItem(key) !== raw) localStorage.setItem(key, raw);
        if (localStorage.getItem(key) !== raw) throw new Error(key);
      } catch (err) { failures.push(key); }
    });
    storageCache = new Map(snapshot.cache);
    Object.keys(snapshot.storage).forEach(function (key) {
      var raw = snapshot.storage[key];
      if (raw === IDB_MARKER) raw = storageCache.get(key);
      if (raw != null) queueLargeStorageWrite(key, raw, false);
      else if (idbDatabase) {
        try { idbDatabase.transaction(IDB_TABLE, 'readwrite').objectStore(IDB_TABLE).delete(key); }
        catch (error) { failures.push(key); }
      }
    });
    var state = snapshot.memory;
    config = state.config; providers = state.providers; activeTarget = state.activeTarget;
    sessions = state.sessions; currentId = state.currentId; globalChatParams = state.globalChatParams;
    promptPresets = state.promptPresets; uiState = state.uiState; inputDraftDirty = state.inputDraftDirty;
    sessions.forEach(function (s) { syncActiveSubMessages(s, false); });
    if (els.input) els.input.value = snapshot.input;
    if (failures.length) throw new Error('存储回滚未完成，请保留备份并停止操作：' + failures.join('、'));
  }

  function requireStorageWrite(result) {
    if (result !== true) throw new Error('存储写入失败');
  }

  function collectRestoreStats(data) {
    var stats = { sessionsCount: 0, subChatsCount: 0, messagesCount: 0, eventsCount: 0,
      presetsCount: Array.isArray(data.promptPresets) ? data.promptPresets.length : 0,
      worldbooksCount: Array.isArray(data.worldbooks) ? data.worldbooks.length : 0 };
    (data.sessions || []).forEach(function (session) {
      stats.sessionsCount++;
      var subs = Array.isArray(session.subChats) && session.subChats.length ? session.subChats : [];
      stats.subChatsCount += subs.length;
      // session.messages 是激活子对话的镜像，不能重复计数。
      (subs.length ? subs : [session]).forEach(function (sub) {
        stats.messagesCount += Array.isArray(sub.messages) ? sub.messages.length : 0;
        var events = sub.memoryData && sub.memoryData.eventEntries;
        if (!Array.isArray(events)) events = sub.memory && sub.memory.events;
        stats.eventsCount += Array.isArray(events) ? events.length : 0;
      });
    });
    return stats;
  }

  function formatRestoreStats(stats) {
    return stats.sessionsCount + ' 个会话（' + stats.subChatsCount + ' 个子对话 / ' +
      stats.messagesCount + ' 条消息）、' + stats.eventsCount + ' 条记忆档案、' +
      stats.presetsCount + ' 个预设、' + stats.worldbooksCount + ' 本世界书';
  }

  function reloadRestoredModules() {
    [window.MyChatWorldbook, window.MyChatVocab, window.MyChatQuickReplies, window.MyChatAutoRetry].forEach(function (module) {
      if (module && typeof module.reload === 'function') module.reload();
    });
  }

  function applyCloudData(payload, options = {}) {
    var source = options.source === undefined ? 'cloud' : options.source;
    if (source !== 'local' && source !== 'cloud') throw new Error('恢复来源无效');
    if (!payload || !Array.isArray(payload.sessions)) throw new Error('恢复数据缺少会话数组');
    if (activeGenerationMap.size > 0) throw new Error('请等待回复结束');
    var snapshot = createStorageSnapshot();
    // 不修改调用方的备份对象；规范化与记忆迁移只作用于本轮恢复副本。
    payload = JSON.parse(JSON.stringify(payload));
    // 云恢复以远端草稿为准，取消旧草稿的延迟提交。
    if (inputDraftTimer) clearTimeout(inputDraftTimer);
    inputDraftTimer = null;
    inputDraftDirty = false;
    // 云端覆盖本地期间禁止刷新时间戳 / 触发自动上传，避免「刚拉取就回传」
    applyingCloudData = true;

    try {
      var mirror = Object.assign({}, payload);
      delete mirror.sessions;
      requireStorageWrite(writeStorageValue(CLOUD_MIRROR_KEY, mirror));
      // 全部基础配置必须先落盘并更新内存，然后才规范化会话。
      applyCloudExtras(payload, { source: source });
      // 统一走一次规范化：保证云端历史会话也补齐 params 等标准字段
      sessions = (payload.sessions || []).map(function (item) {
        var normalized = normalizeSession(item);
        if (!normalized) throw new Error('恢复数据含无效会话');
        return normalized;
      });

      // 固化云端恢复的会话参数：缺少 params 的会话继承当前全局默认并写回
      freezeMissingSessionParams(sessions);

      if (sessions.length === 0) {
        // 云端为空：保留一个可用的空会话，保证界面正常
        var fresh = {
          id: genId(),
          title: DEFAULT_TITLE,
          updatedAt: Date.now(),
          messages: [],
          inputDraft: '',
          params: getGlobalChatParams()
        };
        ensureSessionSubChats(fresh);
        sessions.push(fresh);
        currentId = fresh.id;
      } else {
        currentId = getSession(payload.currentId) ? payload.currentId : sessions[0].id;
      }

      var cloudStamp = payload.lastModified > 0 ? payload.lastModified : Date.now();
      requireStorageWrite(writeStorageValue(LAST_MODIFIED_KEY, String(cloudStamp)));
      requireStorageWrite(persistSessions());
      var memory = window.MemorySummaryModule || window.MemorySummary;
      if (memory) {
        if (typeof memory.migrateLegacyMemory === 'function') memory.migrateLegacyMemory({ persist: false });
        sessions.forEach(function (session) {
          (session.subChats && session.subChats.length ? session.subChats : [session]).forEach(function (sub) {
            memory.reconcileMemoryAfterFloorChange(session, sub.id, { persist: false });
          });
        });
        requireStorageWrite(persistSessions());
      }
    } catch (err) {
      try { restoreStorageSnapshot(snapshot); }
      catch (rollbackError) { throw new Error('存储写入失败；' + rollbackError.message); }
      try { reloadRestoredModules(); applyUiPrefs(); }
      catch (reloadError) { console.warn('回滚后模块刷新失败：', reloadError); }
      throw new Error('存储写入失败，已安全回滚至原状态，未造成数据损坏。原因：' + err.message);
    } finally {
      applyingCloudData = false;
    }

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    restoreInputDraft();
    reloadRestoredModules();
    renderSessionList();
    renderMessages();
    // 云端主数据覆盖后同步刷新底部参数面板与按钮状态
    refreshQuickParamsPanel();
    refreshPresetButtonState();
    refreshTopPresetUI();
    if (subchatModalOpen) renderSubChatList();
    if (source === 'cloud') localStorage.setItem(LAST_SYNCED_CLOUD_STAMP_KEY, String(Number(payload.lastModified) || 0));
    return collectRestoreStats({ sessions: sessions, promptPresets: promptPresets, worldbooks: readStorageValue(WORLDBOOKS_KEY) });
  }

  /**
   * 把云端携带的扩展数据（渠道配置、当前模型、界面偏好、预留槽位）
   * 写回 localStorage 并立即刷新内存状态
   * 旧版云端数据没有这些字段时全部跳过，向下 100% 兼容
   */
  function applyCloudExtras(payload, options = {}) {
    if (!payload || typeof payload !== 'object') return;

    if (payload.globalTavernVars && typeof payload.globalTavernVars === 'object' && !Array.isArray(payload.globalTavernVars)) {
      requireStorageWrite(writeStorageValue(GLOBAL_TAVERN_VARS_KEY, payload.globalTavernVars));
    }

    // 本地备份完整恢复连接字段；云端拉取保留目标设备连接字段。
    if (payload.config && typeof payload.config === 'object' && !Array.isArray(payload.config)) {
      var localConnection = { syncPlatform: config.syncPlatform, syncToken: config.syncToken,
        gistId: config.gistId, autoSync: config.autoSync };
      config = Object.assign({}, payload.config, config, localConnection);
      Object.keys(payload.config).forEach(function (key) {
        if (options.source === 'local' || !Object.prototype.hasOwnProperty.call(localConnection, key)) config[key] = payload.config[key];
      });
      requireStorageWrite(persistConfig(true));
    }
    if (Array.isArray(payload.vocabRules)) {
      requireStorageWrite(writeStorageValue(VOCAB_RULES_KEY, payload.vocabRules));
    }
    if (payload.quickReplies && typeof payload.quickReplies === 'object') {
      requireStorageWrite(writeStorageValue(QUICK_REPLIES_KEY, payload.quickReplies));
    }
    if (payload.autoRetry && typeof payload.autoRetry === 'object') {
      requireStorageWrite(writeStorageValue(AUTO_RETRY_KEY, payload.autoRetry));
    }
    var hasProviders = Array.isArray(payload.providers);

    // 1. 渠道与模型列表（含 API Key / 别名 / 三档单价）
    if (hasProviders) {
      var list = [];
      payload.providers.forEach(function (item) {
        var normalized = normalizeProvider(item);
        if (normalized) list.push(normalized);
      });
      providers = mergeBuiltinProviders(list);
      requireStorageWrite(writeStorageValue(PROVIDERS_KEY, providers));
    }

    // 2. 当前选中的渠道与模型
    var target = payload.activeTarget;
    if (
      target &&
      typeof target === 'object' &&
      typeof target.providerId === 'string' &&
      typeof target.modelId === 'string'
    ) {
      activeTarget = { providerId: target.providerId, modelId: target.modelId };
      // 目标可能指向已不存在的渠道 / 模型，统一做一次有效性兜底
      ensureActiveTarget();
      requireStorageWrite(writeStorageValue(ACTIVE_TARGET_KEY, activeTarget));
    }

    // 3. 渠道与当前模型恢复后统一刷新内存状态与界面
    if (hasProviders) {
      renderQuickModelSelect();
      // 设置弹窗未打开时才重绘其内部列表，避免覆盖用户正在编辑的草稿
      if (!draftProviders) {
        renderProviderSelect();
        renderModelList();
      }
    }

    // 4. 界面偏好：深浅色主题与宽屏视图
    if (payload.theme === 'dark' || payload.theme === 'light') {
      requireStorageWrite(writeStorageValue(THEME_KEY, payload.theme));
    }
    if (payload.wideView === 'wide' || payload.wideView === 'bubble') {
      requireStorageWrite(writeStorageValue(VIEW_KEY, payload.wideView));
    }
    loadUiPrefs();
    applyUiPrefs();

    // 5. 全局默认对话参数与模块化系统提示词预设
    if (payload.chatParams !== null && payload.chatParams !== undefined) {
      requireStorageWrite(writeStorageValue(CHAT_PARAMS_KEY, payload.chatParams));
      // 同步刷新内存中的全局默认参数，保证新会话立即继承云端配置
      globalChatParams = cloneChatParams(payload.chatParams);
      // 同步刷新设置弹窗表单与底部「已定制」按钮状态
      if (els.cfgContextLimit) loadChatParamsForm();
      refreshQuickParamsPanel();
    }
    // 预设库：先同步内存镜像，后续界面渲染才能读到最新数据
    if (payload.promptPresets !== null && payload.promptPresets !== undefined) {
      promptPresets = normalizePromptPresets(payload.promptPresets);
      requireStorageWrite(writeStorageValue(PROMPT_PRESETS_KEY, promptPresets));
      refreshPresetButtonState();
    }
    // 正则规则库：缺失字段（旧版云端数据）时跳过，不会误清空本地规则
    if (payload.regexRules !== null && payload.regexRules !== undefined) {
      requireStorageWrite(writeStorageValue(REGEX_RULES_KEY, normalizeRegexRules(payload.regexRules)));
    }
    // 全局世界书库：缺失字段（旧版云端数据）时跳过，不会误清空本地世界书
    if (payload.worldbooks !== null && payload.worldbooks !== undefined) {
      requireStorageWrite(writeStorageValue(WORLDBOOKS_KEY, Array.isArray(payload.worldbooks) ? payload.worldbooks : []));
      // 通知世界书模块重新拉取数据并重绘界面（模块未加载时静默跳过）
      try {
        if (window.MyChatWorldbook && typeof window.MyChatWorldbook.reload === 'function') {
          window.MyChatWorldbook.reload();
        }
      } catch (wbErr) {
        console.warn('[世界书] 云端恢复后刷新模块失败：', wbErr);
      }
    }
  }

  // 主文件与分片共用读取逻辑；截断或缺片时禁止解析不完整内容。
  async function readGistFileContent(fileObj) {
    if (!fileObj) throw new Error('云端同步文件缺失');
    var content = typeof fileObj.content === 'string' ? fileObj.content : '';
    if (!content || fileObj.truncated) {
      if (!fileObj.raw_url) throw new Error('云端同步文件不完整');
      var rawRes = await fetch(fileObj.raw_url, { cache: 'no-store' });
      if (!rawRes.ok) throw new Error('云端文件读取失败：' + rawRes.status);
      content = await rawRes.text();
    }
    return content;
  }

  /**
   * 读取云端主文件；云端尚无该文件时 payload 为 null
   */
  async function fetchCloudData(readOnly) {
    var gistId = await ensureGistId(readOnly);
    var detail = await gistRequest('/' + encodeURIComponent(gistId), 'GET');
    cachedGistFiles = Object.assign({}, (detail && detail.files) || {});
    var file = detail && detail.files ? detail.files[SYNC_FILE_NAME] : null;

    if (!file) return { payload: null };

    var content = await readGistFileContent(file);
    if (!content.trim()) return { payload: null };
    var payload = await parseGistCloudContent(content, cachedGistFiles);
    if (!payload) throw new Error('云端数据解析失败，已中止同步以保护云端数据');
    return { payload: payload };
  }

  async function parseGistCloudContent(content, files) {
    var manifest = safeJsonParse(content);
    if (manifest && manifest._chunked === true) {
      if (!Number.isSafeInteger(manifest.totalChunks) || manifest.totalChunks <= 0 ||
          manifest.totalChunks > Object.keys(files).length) {
        throw new Error('云端分片清单无效');
      }
      var chunks = [];
      for (var i = 0; i < manifest.totalChunks; i++) {
        chunks.push(await readGistFileContent(files[SYNC_CHUNK_PREFIX + i + '.dat']));
      }
      content = chunks.join('');
    }
    return await parseCloudPayloadAsync(content);
  }

  /**
   * 上传本地数据到云端（对外入口）：持有全局 isSyncing 锁，防止连点触发接口限流
   * @param {boolean} fromSync 是否由同步流程调用（true 时沿用当前按钮状态）
   */
  async function uploadToCloud(fromSync) {
    if (!isSyncConfigured()) return;

    // 防连点锁：已有同步 / 上传任务在进行时直接忽略本次触发
    if (isSyncing) {
      console.log('[云同步] 上传请求已在进行中，忽略本次重复触发');
      return;
    }

    isSyncing = true;
    try {
      // 此入口是自动上传，不是已完成版本比对的双向同步。
      await doUploadToCloud(false);
    } finally {
      isSyncing = false;
    }
  }

  /**
   * 实际执行上传：主文件及分片优先提交，快照与过期清理独立 PATCH。
   * 备份失败只警告，不覆盖主同步成功状态。
   */
  async function doUploadToCloud(fromSync, isManualPush) {
    if (!isSyncConfigured()) return;

    // 已有上传在途：直接视为已同步，避免并发覆盖同一份 Gist
    if (uploadInFlight) {
      setSyncStatus('ok');
      return;
    }

    uploadInFlight = true;
    if (!fromSync) setSyncStatus('syncing');

    try {
      var gistId = await ensureGistId();

      var now = Date.now();
      var maintainBackup = isManualPush === true || now - lastBackupUploadAt >= 30 * 60 * 1000;
      var automaticPush = !isManualPush;
      // 自动上传必须刷新远端主文件，缓存不能作为版本门禁依据。
      if (automaticPush || !cachedGistFiles || now - lastBackupUploadAt >= 30 * 60 * 1000) {
        var detail = await gistRequest('/' + encodeURIComponent(gistId), 'GET');
        cachedGistFiles = Object.assign({}, (detail && detail.files) || {});
      }
      if (automaticPush && cachedGistFiles[SYNC_FILE_NAME]) {
        var mainContent = await readGistFileContent(cachedGistFiles[SYNC_FILE_NAME]);
        var outer = safeJsonParse(mainContent);
        var remoteStats = outer && outer._meta;
        if (!remoteStats || !['lastModified', 'sessionCount', 'totalMessages'].every(function (key) {
          return typeof remoteStats[key] === 'number' && Number.isFinite(remoteStats[key]) && remoteStats[key] >= 0;
        })) {
          var oldPayload = await parseGistCloudContent(mainContent, cachedGistFiles);
          if (!oldPayload && mainContent.trim()) throw new Error('云端数据解析失败，已中止同步以保护云端数据');
          remoteStats = computeCloudDataStats(oldPayload || {});
        }
        var localStats = computeLocalDataStats();
        var lastSyncedStamp = Number(localStorage.getItem(LAST_SYNCED_CLOUD_STAMP_KEY) || 0);
        if ((lastSyncedStamp > 0 && remoteStats.lastModified > lastSyncedStamp) || remoteStats.totalMessages > localStats.totalMessages) {
          // 不在当前上传锁内递归同步；释放锁后再执行安全裁决。
          queueCloudSync(false);
          return;
        }
      }
      var existingFiles = cachedGistFiles || {};
      var stamp = getLocalLastModified();
      if (!stamp) {
        // 旧版本数据没有全局时间戳：补一个并立即落盘
        touchLastModified();
        stamp = getLocalLastModified() || now;
      }

      var payload = buildCloudPayload(stamp, true);
      var content = await encryptCloudContentAsync(JSON.stringify(payload), createCloudMeta(payload));
      var mainFiles = buildSyncedFileMap(content, cachedGistFiles || {});
      var patchRes = await gistRequest('/' + encodeURIComponent(gistId), 'PATCH', {
        description: SYNC_GIST_DESC,
        files: mainFiles
      });
      cachedGistFiles = Object.assign({}, patchRes.files || cachedGistFiles);
      localStorage.setItem(LAST_SYNCED_CLOUD_STAMP_KEY, String(stamp));
      lastSyncAt = Date.now();
      setSyncStatus('ok');

      if (!maintainBackup) return;
      // 主同步已成功；手动推送或每 30 分钟维护一次快照，失败不标记完成。
      var backupFiles = {};
      var todayBackupName = BACKUP_PREFIX + formatDateKey(now) + '.json';
      backupFiles[todayBackupName] = { content: content };

      var todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      var todayStamp = todayStart.getTime();
      var removed = 0;

      Object.keys(existingFiles).forEach(function (name) {
        if (!name || name.indexOf(BACKUP_PREFIX) !== 0) return;

        var dateText = name.slice(BACKUP_PREFIX.length).replace(/\.json$/i, '');
        var parts = dateText.split('-');
        if (parts.length !== 3) return;

        var fileStamp = new Date(
          Number(parts[0]),
          Number(parts[1]) - 1,
          Number(parts[2])
        ).getTime();
        if (!isFinite(fileStamp)) return;

        // 超过 7 天或旧巨型快照一并清理；今日新快照覆盖优先。
        var oldFile = existingFiles[name] || {};
        var oversized = Number(oldFile.size) > 2 * 1024 * 1024 ||
          (typeof oldFile.content === 'string' && oldFile.content.length > 2 * 1024 * 1024);
        if (name !== todayBackupName && (todayStamp - fileStamp > 7 * 24 * 3600 * 1000 || oversized)) {
          backupFiles[name] = null; // Gitee / GitHub Gist 标准删除文件语法
          removed++;
        }
      });

      if (Object.keys(backupFiles).length > 0) {
        try {
          var backupRes = await gistRequest('/' + encodeURIComponent(gistId), 'PATCH', {
            description: SYNC_GIST_DESC,
            files: backupFiles
          });
          cachedGistFiles = Object.assign({}, backupRes.files || cachedGistFiles);
          lastBackupUploadAt = Date.now();
          try { localStorage.setItem(LAST_BACKUP_MAINT_AT_KEY, String(lastBackupUploadAt)); } catch (e) {}
          console.log('[云同步] 快照备份已更新，清理旧备份 ' + removed + ' 个');
        } catch (backupErr) {
          console.warn('[云同步] 快照备份更新跳过：', backupErr);
        }
      } else {
        lastBackupUploadAt = Date.now();
        try { localStorage.setItem(LAST_BACKUP_MAINT_AT_KEY, String(lastBackupUploadAt)); } catch (e) {}
      }
    } catch (err) {
      handleSyncError(err);
    } finally {
      uploadInFlight = false;
    }
  }

  /**
   * 静默上传：AI 回复结束 / 删除会话后延迟 1 秒触发，避免频繁请求
   */
  async function manualCloudSync(direction) {
    if (isSyncing || syncInFlight || uploadInFlight) return;
    if (activeGenerationMap.size > 0) { await window.showAppAlert('请等待回复结束'); return; }
    var platform = els.cfgSyncPlatform.value === 'github' ? 'github' : 'gitee';
    var token = els.cfgSyncToken.value.trim();
    var gist = els.cfgGistId.value.trim();
    if (!token) { await window.showAppAlert('请先填写访问令牌'); return; }
    if (direction === 'pull' && !await window.showAppConfirm('云端将覆盖本机，继续？')) return;
    if (activeGenerationMap.size > 0 || isSyncing || syncInFlight || uploadInFlight) return;
    if ((platform !== config.syncPlatform || token !== config.syncToken) && gist === config.gistId) gist = '';
    config.syncPlatform = platform;
    config.syncToken = token;
    config.gistId = gist;
    config.autoSync = document.getElementById('cfg-auto-sync').checked;
    persistConfig(true);
    if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }
    isSyncing = true;
    setSyncStatus('syncing');
    try {
      if (direction === 'push') {
        await doUploadToCloud(false, true);
      } else {
        var remote = await fetchCloudData(true);
        if (!remote.payload) throw new Error('云端数据无效');
        applyCloudData(remote.payload, { source: 'cloud' });
        lastSyncAt = Date.now();
        setSyncStatus('ok');
      }
      if (els.cfgGistId) els.cfgGistId.value = config.gistId;
    } catch (err) {
      handleSyncError(err);
    } finally {
      isSyncing = false;
    }
  }

  function scheduleCloudUpload() {
    if (isBooting || applyingCloudData || !isStartupSyncSettled) return;
    if (!config.autoSync || !isSyncConfigured()) return;
    if (uploadTimer) clearTimeout(uploadTimer);
    uploadTimer = setTimeout(function () {
      uploadTimer = null;
      if (config.autoSync && !isBooting && !applyingCloudData && isStartupSyncSettled) uploadToCloud(false);
    }, UPLOAD_DELAY_MS);
  }

  /**
   * 双向同步主入口：打开软件、点击状态按钮、保存配置后触发
   * @param {boolean} silent 静默模式（未配置时不弹窗）
   * @param {boolean} retried 是否已因 Gist 失效重试过
   */
  async function syncWithCloud(silent, retried) {
    if (silent && !config.autoSync) { isStartupSyncSettled = true; return; }
    if (!isSyncConfigured()) {
      isStartupSyncSettled = true;
      renderSyncStatus();
      if (!silent) {
        await window.showAppAlert('请先填写云端访问令牌');
      }
      return;
    }

    // 正在生成 AI 回复时不做双向同步，避免云端覆盖打断当前输出
    if (activeGenerationMap.size > 0) {
      if (silent) queueCloudSync(true);
      else await window.showAppAlert('请等待回复结束');
      return;
    }

    // 静默前台请求不能因同步锁而永久丢失。
    if (isSyncing || syncInFlight || uploadInFlight) {
      if (silent) queueCloudSync(true);
      console.log('[云同步] 同步进行中，忽略重复触发');
      return;
    }

    isSyncing = true;
    syncInFlight = true;
    setSyncStatus('syncing');

    try {
      var remote = await fetchCloudData();

      // 云端还没有主同步文件：直接把本地数据推上去
      if (!remote.payload) {
        await doUploadToCloud(true);
        return;
      }

      var remoteStats = computeCloudDataStats(remote.payload);
      var localStats = computeLocalDataStats();
      var remoteStamp = remoteStats.lastModified;
      var localStamp = localStats.lastModified;
      var lastSyncedStamp = Number(localStorage.getItem(LAST_SYNCED_CLOUD_STAMP_KEY) || 0);

      // 本机还没有任何聊天内容（例如手机刚填好 Token）：
      // 直接采用云端数据，避免空数据把电脑上的历史记录覆盖掉
      if (remoteHasMeaningfulData(remote.payload) && !hasMeaningfulLocalData()) {
        await applyCloudData(remote.payload, { source: 'cloud' });
        lastSyncAt = Date.now();
        setSyncStatus('ok');
        console.log('[云同步] 本机无聊天记录，已拉取云端数据');
        return;
      }

      if (remoteStamp > localStamp) {
        // 另一台设备有新记录：云端覆盖本地
        await applyCloudData(remote.payload, { source: 'cloud' });
        lastSyncAt = Date.now();
        setSyncStatus('ok');
        console.log(
          '[云同步] 云端数据更新，已覆盖本地（云端 ' + remoteStamp + ' / 本地 ' + localStamp + '）'
        );
      } else if (localStamp > remoteStamp) {
        var suspicious = (lastSyncedStamp === 0 && remoteHasMeaningfulData(remote.payload)) ||
          (lastSyncedStamp > 0 && remoteStamp !== lastSyncedStamp) ||
          remoteStats.totalMessages > localStats.totalMessages ||
          remoteStats.sessionCount > localStats.sessionCount;
        if (suspicious) {
          var preferCloud = await window.showAppConfirm('检测到云端与本机数据存在版本差异：\n• 云端：' + remoteStats.sessionCount + ' 个会话 / 共 ' + remoteStats.totalMessages + ' 层消息\n• 本机：' + localStats.sessionCount + ' 个会话 / 共 ' + localStats.totalMessages + ' 层消息\n\n点击「确定」拉取云端最新数据覆盖本机；点击「取消」暂不同步（保留本机现状，不覆盖云端）。');
          if (!preferCloud) { setSyncStatus('已暂停同步', ''); return; }
          if (activeGenerationMap.size > 0) { queueCloudSync(silent); return; }
          if (preferCloud) {
            await applyCloudData(remote.payload, { source: 'cloud' });
            lastSyncAt = Date.now();
            setSyncStatus('ok');
          }
        } else {
          await doUploadToCloud(true);
        }
      } else {
        // 同时间戳但云端内容更多仍须拉取，不能误记为已对齐。
        if (remoteStats.totalMessages > localStats.totalMessages || remoteStats.sessionCount > localStats.sessionCount) {
          await applyCloudData(remote.payload, { source: 'cloud' });
        }
        // 时间戳一致：记录本设备已经对齐的云端基准。
        localStorage.setItem(LAST_SYNCED_CLOUD_STAMP_KEY, String(remoteStamp));
        lastSyncAt = Date.now();
        setSyncStatus('ok');
      }
    } catch (err) {
      // 本地保存的 Gist 可能已被删除（404）或无权访问（401/403）：清空后重试一次
      if (
        !retried &&
        config.gistId &&
        /HTTP 40[134]/.test(String(err && err.message))
      ) {
        config.gistId = '';
        persistConfig(true);
        syncInFlight = false;
        isSyncing = false;
        return await syncWithCloud(silent, true);
      }
      handleSyncError(err);
    } finally {
      syncInFlight = false;
      isSyncing = false;
      isStartupSyncSettled = true;
    }
  }

  /* ================= 主题偏好（统一气泡布局） ================= */

  var uiState = {
    dark: false
  };

  /**
   * 读取本地保存的主题 / 视图偏好；未保存时跟随系统深色设置
   */
  function loadUiPrefs() {
    var savedTheme = null;
    try {
      savedTheme = localStorage.getItem(THEME_KEY);
    } catch (err) {
      savedTheme = null;
    }

    if (savedTheme === 'dark' || savedTheme === 'light') {
      uiState.dark = savedTheme === 'dark';
    } else {
      // 首次使用：默认跟随系统深浅色设置
      uiState.dark =
        !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

  }

  /**
   * 保存界面偏好
   */
  function persistUiPrefs() {
    try {
      localStorage.setItem(THEME_KEY, uiState.dark ? 'dark' : 'light');
    } catch (err) {
      console.warn('界面偏好保存失败：', err);
    }
  }

  /**
   * 把当前偏好应用到 DOM（body 类名 + 主题色 meta + 按钮文案）
   */
  function applyUiPrefs() {
    document.body.classList.toggle('dark-mode', uiState.dark);

    // 同步手机浏览器地址栏 / 状态栏主题色：两个 meta 统一改为当前实际底色，
    // 避免「系统浅色 + 应用暗黑」时地址栏仍然是白色
    var themeColor = uiState.dark ? '#131417' : '#f4f6f8';
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    Array.prototype.forEach.call(metas, function (meta) {
      meta.setAttribute('content', themeColor);
    });

    // 主题切换：浅色模式显示月亮图标，暗黑模式显示太阳图标（由 CSS 控制显隐）
    if (els.themeToggleBtn) {
      els.themeToggleBtn.classList.toggle('is-dark', !!uiState.dark);
      els.themeToggleBtn.title = uiState.dark
        ? '当前为暗黑模式，点击切换为浅色'
        : '当前为浅色模式，点击切换为暗黑';
    }

  }

  /**
   * 切换深浅色主题
   */
  function toggleTheme() {
    uiState.dark = !uiState.dark;
    applyUiPrefs();
    persistUiPrefs();
  }

  // === [ANCHOR: INIT_EVENTS] 全局事件绑定与初始化入口 ===
  /* ================= 事件绑定 ================= */

  function bindEvents() {
    // 密码框「小眼睛」：点击切换明文 / 密文（API Key 与云同步 Token）
    if (els.passwordToggles && els.passwordToggles.length) {
      Array.prototype.forEach.call(els.passwordToggles, function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          togglePasswordVisibility(btn);
        });
      });
    }

    // 顶部主题切换
    if (els.themeToggleBtn) {
      els.themeToggleBtn.addEventListener('click', toggleTheme);
    }
    // 发送按钮
    window.addEventListener('mychat-memory-task-changed', syncStreamingUiState);
    window.addEventListener('mychat-memory-task-aborted', function (event) {
      stopChannelGeneration(event.detail.sessionId, event.detail.subChatId);
    });
    if (els.sendBtn) {
      els.sendBtn.addEventListener('click', function () {
        if (updateSendButtonState()) {
          var session = getCurrentSession();
          if (session) stopChannelGeneration(session.id, getActiveSubChatId(session));
          return;
        }
        sendMessage();
      });
    }

    // 输入框：自动增高 + 回车发送
    if (els.input) {
      els.input.addEventListener('input', function () {
        autoGrowInput();
        saveInputDraft();
      });

      els.input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        // 中文输入法选词时的回车不触发发送
        if (e.isComposing || e.keyCode === 229) return;

        // 手机端（粗指针设备）回车保持换行行为
        var isTouchDevice =
          window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        if (isTouchDevice) return;

        // Shift + Enter 换行
        if (e.shiftKey) return;

        e.preventDefault();
        sendMessage();
      });
    }

    // 消息区：四大操作（复制 / 修改 / 重新回复 / 删除）事件委托
    if (els.chatArea) {
      els.chatArea.addEventListener('click', handleMessageAction);
      // 触摸屏（无悬浮能力）：点击气泡切换操作栏显示
      els.chatArea.addEventListener('click', toggleActionsOnTouch);
      // 智能跟随滚动：监听用户滚动，判断是否需要暂停自动跟随
      els.chatArea.addEventListener('scroll', handleChatScroll, { passive: true });
    }

    // 底部快捷模型切换器：点击按钮展开 / 收起上弹面板
    if (els.quickModelBtn) {
      els.quickModelBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleQuickModelPanel();
      });
    }

    // 面板内点击：分组标题切换折叠，模型项则立即切换模型
    if (els.quickModelPanel) {
      els.quickModelPanel.addEventListener('click', function (e) {
        var target = e.target;

        var groupBtn = target.closest ? target.closest('[data-qm-group]') : null;
        if (groupBtn) {
          e.stopPropagation();
          toggleQuickGroup(groupBtn.getAttribute('data-qm-group'));
          return;
        }

        var itemBtn = target.closest ? target.closest('[data-qm-model]') : null;
        if (itemBtn) {
          e.stopPropagation();
          selectQuickModel(
            itemBtn.getAttribute('data-qm-provider'),
            itemBtn.getAttribute('data-qm-model')
          );
        }
      });
    }

    // 底部「参数」：展开 / 收起当前对话参数面板
    if (els.quickParamsBtn) {
      els.quickParamsBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleQuickParamsPanel();
      });
    }

    // 面板内任意输入或开关变化：实时自动保存到当前会话
    if (els.quickParamsPanel) {
      ['input', 'change'].forEach(function (evtName) {
        els.quickParamsPanel.addEventListener(evtName, function (e) {
          if (!e.target || e.target === els.quickParamsPanel) return;
          handleQuickParamsInput();
        });
      });
      els.quickParamsPanel.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }

    if (els.qpResetBtn) {
      els.qpResetBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        resetQuickParams();
      });
    }

    // 设置弹窗内「默认对话参数」页签：仅保留「恢复全空默认」（只清表单，不写库）
    if (els.resetChatParamsBtn) {
      els.resetChatParamsBtn.addEventListener('click', resetChatParamsForm);
    }

    // 点击空白处收起各浮层（面板内部点击已阻止冒泡）
    document.addEventListener('click', function (e) {
      // 顶部 #0 一站式预设控制台：点击其外部才收起
      // 子弹窗（小模块编辑 / 合并预览）打开期间必须保持下拉展开
      var subModalOpen =
        (els.moduleEditModal && els.moduleEditModal.classList.contains('show')) ||
        (els.presetMergedModal && els.presetMergedModal.classList.contains('show')) ||
        !!document.querySelector('.app-dialog-overlay:not([hidden])');
      if (
        topPresetOpen &&
        els.topPresetWrap &&
        !subModalOpen &&
        !els.topPresetWrap.contains(e.target) &&
        !(e.composedPath && e.composedPath().indexOf(els.topPresetWrap) >= 0) &&
        !e.target.closest('.preset-picker-menu, .feature-help-overlay, .app-dialog-overlay') &&
        !(e.composedPath && e.composedPath().some(function (node) {
          return node.classList && (node.classList.contains('app-dialog-overlay') || node.classList.contains('preset-picker-menu'));
        }))
      ) {
        closeTopPresetDropdown();
      }

      // 输入区左侧自适应工具箱
      if (els.inputToolboxPanel && !els.inputToolboxPanel.hidden) {
        var inToolbox =
          (els.inputToolboxBtn && els.inputToolboxBtn.contains(e.target)) ||
          els.inputToolboxPanel.contains(e.target);
        if (!inToolbox) closeInputToolbox();
      }

      // 消息角落扩展菜单（点击菜单自身时不收起）
      if (!e.target.closest || !e.target.closest('.msg-corner')) closeAllCornerMenus();

      if (els.quickParams && els.quickParamsPanel && !els.quickParamsPanel.hidden) {
        if (!els.quickParams.contains(e.target)) closeQuickParamsPanel();
      }

      if (!els.quickModelPicker) return;
      if (els.quickModelPanel && els.quickModelPanel.hidden) return;
      if (els.quickModelPicker.contains(e.target)) return;
      closeQuickModelPanel();
    });

    // 页面滚动或窗口尺寸变化时收起面板，避免面板与按钮错位
    window.addEventListener('resize', function () {
      closeQuickParamsPanel();
      closeQuickModelPanel();
    });
    if (els.chatArea) {
      els.chatArea.addEventListener('scroll', function () {
        closeQuickParamsPanel();
        closeQuickModelPanel();
      }, { passive: true });
    }

    // 设置弹窗：左侧选项卡切换（事件委托，后续新增选项卡无需改代码）
    if (els.settingsNav) {
      els.settingsNav.addEventListener('click', function (e) {
        var tab = e.target.closest ? e.target.closest('.settings-tab') : null;
        if (!tab) return;
        switchSettingsTab(tab.getAttribute('data-tab'));
      });
    }

    // 侧边栏：新建对话（主会话）
    if (els.newChatBtn) {
      els.newChatBtn.addEventListener('click', function () {
        createSession(true);
        closeSidebar();
        if (els.input) els.input.focus();
      });
    }

    // 侧边栏：收藏夹折叠 / 切换 / 收藏 / 角色设置 / 删除（事件委托）
    if (els.sessionList) {
      els.sessionList.addEventListener('click', function (e) {
        if (sessionDragId || Date.now() < sessionDragClickUntil) { e.preventDefault(); return; }
        // ① 分组标题：收藏夹折叠 / 展开（仅收藏夹分组可折叠）
        var groupHead = e.target.closest ? e.target.closest('.session-group-head') : null;
        if (groupHead && groupHead.getAttribute('data-role') === 'toggle-group') {
          pinnedCollapsed = !pinnedCollapsed;
          renderSessionList();
          return;
        }

        var item = e.target.closest ? e.target.closest('.session-item') : null;
        if (!item) return;

        var id = item.getAttribute('data-id');
        if (!id) return;

        // ② 收藏（置顶）切换
        var pinBtn = e.target.closest ? e.target.closest('[data-role="pin"]') : null;
        if (pinBtn) {
          e.stopPropagation();
          var pinSession = getSession(id);
          if (pinSession) {
            pinSession.pinned = pinSession.pinned !== true;
            pinSession.updatedAt = Date.now();
            persistSessions();
            flushSave();
            touchLastModified();
            scheduleCloudUpload();
            renderSessionList();
            showToast(pinSession.pinned ? '已加入收藏夹' : '已取消收藏');
          }
          return;
        }

        // ③ 角色与对话设置
        var charBtn = e.target.closest ? e.target.closest('[data-role="char"]') : null;
        if (charBtn) {
          e.stopPropagation();
          openSessionCharModal(id);
          return;
        }

        // ④ 删除会话
        var delBtn = e.target.closest ? e.target.closest('[data-role="delete"]') : null;
        if (delBtn) {
          e.stopPropagation();
          deleteSession(id);
          return;
        }

        selectSession(id);
      });
    }

    // 导入角色卡（PNG 内嵌卡 / JSON 卡）
    if (els.btnImportCharcard) {
      els.btnImportCharcard.addEventListener('click', importCharcardFlow);
    }

    // ===== 角色与对话设置弹窗 =====
    if (els.sessionCharClose) {
      els.sessionCharClose.addEventListener('click', closeSessionCharModal);
    }
    if (els.sessionCharCancel) {
      els.sessionCharCancel.addEventListener('click', closeSessionCharModal);
    }
    if (els.sessionCharSave) {
      els.sessionCharSave.addEventListener('click', saveSessionCharSettings);
    }
    // 头像本地图片：选中后立即压缩为 128x128 草稿并刷新预览（点保存才写入）
    if (els.scCharAvatarFile) {
      els.scCharAvatarFile.addEventListener('change', function () {
        var file = this.files && this.files[0];
        if (!file) return;
        compressAvatarFile(file, function (dataUrl) {
          if (!dataUrl) return;
          charAvatarDraft = dataUrl;
          if (els.scCharAvatarUrl) els.scCharAvatarUrl.value = '';
          refreshCharModalPreview();
        });
      });
    }
    if (els.scUserAvatarFile) {
      els.scUserAvatarFile.addEventListener('change', function () {
        var file = this.files && this.files[0];
        if (!file) return;
        compressAvatarFile(file, function (dataUrl) {
          if (!dataUrl) return;
          userAvatarDraft = dataUrl;
          if (els.scUserAvatarUrl) els.scUserAvatarUrl.value = '';
          refreshCharModalPreview();
        });
      });
    }
    if (els.scCharAvatarClear) {
      els.scCharAvatarClear.addEventListener('click', function () {
        charAvatarDraft = '';
        if (els.scCharAvatarUrl) els.scCharAvatarUrl.value = '';
        if (els.scCharAvatarFile) els.scCharAvatarFile.value = '';
        refreshCharModalPreview();
      });
    }
    if (els.scUserAvatarClear) {
      els.scUserAvatarClear.addEventListener('click', function () {
        userAvatarDraft = '';
        if (els.scUserAvatarUrl) els.scUserAvatarUrl.value = '';
        if (els.scUserAvatarFile) els.scUserAvatarFile.value = '';
        refreshCharModalPreview();
      });
    }
    // 头像 URL 输入：实时更新草稿与预览
    if (els.scCharAvatarUrl) {
      els.scCharAvatarUrl.addEventListener('input', function () {
        charAvatarDraft = this.value.trim();
        refreshCharModalPreview();
      });
    }
    if (els.scUserAvatarUrl) {
      els.scUserAvatarUrl.addEventListener('input', function () {
        userAvatarDraft = this.value.trim();
        refreshCharModalPreview();
      });
    }
    // 名称输入：实时刷新首字徽章
    if (els.scCharNameInput) {
      els.scCharNameInput.addEventListener('input', refreshCharModalPreview);
    }
    if (els.scUserNameInput) {
      els.scUserNameInput.addEventListener('input', refreshCharModalPreview);
    }
    // 将开场白重置到当前空对话 #1 楼
    if (els.scApplyFirstMessage) {
      els.scApplyFirstMessage.addEventListener('click', function () {
        var session = getSession(charModalSessionId) || getCurrentSession();
        if (!session) return;
        var text = els.scFirstMessageInput ? els.scFirstMessageInput.value.trim() : '';
        if (!text) {
          showToast('请先填写角色开场白');
          return;
        }
        if (!isSessionEmpty(session)) {
          showToast('当前对话已有用户发言，为避免误删记录不能覆盖 #1 楼');
          return;
        }
        if (applyFirstMessageToSession(session, text)) {
          persistSessions();
          syncActiveSubMessages(session);
          flushSave();
          touchLastModified();
          if (isCurrentSession(session, getActiveSubChatId(session))) renderMessages();
          renderSessionList();
          showToast('开场白已写入 #1 楼');
        }
      });
    }

    // ===== 世界书触发明细弹窗 =====
    if (els.wbDetailClose) {
      els.wbDetailClose.addEventListener('click', closeWbTriggeredDetail);
    }
    if (els.wbDetailDone) {
      els.wbDetailDone.addEventListener('click', closeWbTriggeredDetail);
    }
    // 聊天区内点击「已触发世界书」标签 → 打开明细
    if (els.chatArea) {
      els.chatArea.addEventListener('click', function (e) {
        var badge = e.target.closest ? e.target.closest('.wb-trigger-badge') : null;
        if (!badge) return;
        e.stopPropagation();
        var idx = parseInt(badge.getAttribute('data-msg-index'), 10);
        if (isFinite(idx) && idx >= 0) openWbTriggeredDetail(idx);
      });
    }
    // 明细列表：点击条目头展开 / 收起内容
    if (els.wbDetailList) {
      els.wbDetailList.addEventListener('click', function (e) {
        var head = e.target.closest ? e.target.closest('[data-role="toggle-detail"]') : null;
        if (!head) return;
        var card = head.closest('.wb-detail-item');
        if (!card) return;
        var isOpen = card.classList.toggle('is-open');
        head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
    }

    // ===== 预设小模块：角色作用方式切换时显示 / 隐藏预输入保留选项 =====
    if (els.moduleRoleSelect) {
      els.moduleRoleSelect.addEventListener('change', function () {
        syncPrefillOptionVisibility(this.value);
      });
    }

    // 手机端汉堡菜单：展开 / 收起抽屉
    if (els.menuBtn) {
      els.menuBtn.addEventListener('click', function () {
        if (els.sidebar && els.sidebar.classList.contains('open')) {
          closeSidebar();
        } else {
          openSidebar();
        }
      });
    }

    // 点击遮罩层收起抽屉
    if (els.sidebarMask) {
      els.sidebarMask.addEventListener('click', closeSidebar);
    }

    // 窗口尺寸变化：回到宽屏时清除抽屉状态，避免出现半屏残留
    window.addEventListener('resize', function () {
      if (!isMobileView()) closeSidebar();
    });

    // 设置弹窗
    if (els.settingsBtn) {
      els.settingsBtn.addEventListener('click', openSettings);
    }
    if (els.saveBtn) {
      els.saveBtn.addEventListener('click', saveSettings);
    }
    if (els.cancelBtn) {
      els.cancelBtn.addEventListener('click', closeSettings);
    }

    // 渠道管理：切换 / 新增 / 删除
    if (els.providerSelect) {
      els.providerSelect.addEventListener('change', function () {
        selectProvider(els.providerSelect.value);
      });
    }
    if (els.addProviderBtn) {
      els.addProviderBtn.addEventListener('click', addProvider);
    }
    if (els.delProviderBtn) {
      els.delProviderBtn.addEventListener('click', deleteProvider);
    }
    if (els.testConnBtn) {
      els.testConnBtn.addEventListener('click', function () {
        testProviderConnection();
      });
    }

    // 手动添加模型
    if (els.addModelBtn) {
      els.addModelBtn.addEventListener('click', addModelManually);
    }
    if (els.newModelId) {
      els.newModelId.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        addModelManually();
      });
    }

    // 模型列表：点击 × 移除模型（事件委托）
    if (els.modelList) {
      els.modelList.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.model-item-remove') : null;
        if (!btn) return;
        var modelId = btn.getAttribute('data-model-id');
        if (modelId) removeModelFromProvider(modelId);
      });
    }

    // 自动拉取：打开面板 / 搜索过滤 / 关闭 / 点击添加
    if (els.fetchModelsBtn) {
      els.fetchModelsBtn.addEventListener('click', function () {
        fetchProviderModels();
      });
    }
    if (els.fetchSearch) {
      els.fetchSearch.addEventListener('input', renderFetchedList);
    }
    if (els.fetchCloseBtn) {
      els.fetchCloseBtn.addEventListener('click', hideFetchPanel);
    }
    if (els.fetchList) {
      els.fetchList.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.fetch-item') : null;
        if (!btn || btn.disabled) return;
        var modelId = btn.getAttribute('data-model-id');
        if (!modelId) return;

        var provider = getEditingProvider();
        if (!provider) return;
        if (findProviderModel(provider, modelId)) return;

        provider.models.push({
          id: modelId,
          alias: '',
          inputPrice: '',
          cachePrice: '',
          outputPrice: ''
        });
        renderModelList();
        renderFetchedList();
      });
    }

    // 渠道输入框改动时同步回草稿，避免直接切换渠道丢失输入
    [els.providerName, els.cfgBaseUrl, els.cfgApiKey].forEach(function (input) {
      if (!input) return;
      input.addEventListener('change', syncEditingProviderFields);
    });

    ['btn-cloud-upload', 'btn-cloud-pull'].forEach(function (id) {
      var button = document.getElementById(id);
      if (button) button.addEventListener('click', function () {
        manualCloudSync(id === 'btn-cloud-upload' ? 'push' : 'pull');
      });
    });
    document.getElementById('cfg-auto-sync').addEventListener('change', function (event) {
      config.autoSync = event.target.checked;
      if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }
      persistConfig(true);
    });

    // 顶部按钮打开云端面板，由用户明确选择推送或拉取。
    if (els.syncStatusBtn) {
      els.syncStatusBtn.addEventListener('click', function () {
        openSettings();
        var tab = document.querySelector('.settings-tab[data-tab="sync"], .settings-tab[data-pane="sync"]');
        if (tab) tab.click();
      });
    }

    // 全局 app-dialogs 守卫校验按下、松开、点击后，才允许遮罩关闭。
    if (els.modal) {
      els.modal.addEventListener('click', function (e) {
        if (e.target === els.modal) closeSettings();
      });
    }

    // Esc 关闭弹窗 / 侧边栏抽屉；Ctrl + S（Cmd + S）保存设置
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        if (els.modal && els.modal.classList.contains('show')) {
          e.preventDefault();
          saveSettings();
        }
        return;
      }
      if (e.key !== 'Escape') return;

      // 小模块编辑窗口优先关闭（内部修改一律不保存）
      if (els.moduleEditModal && els.moduleEditModal.classList.contains('show')) {
        closeModuleEditModal();
        return;
      }

      // 预设管理弹窗
      if (els.presetModal && els.presetModal.classList.contains('show')) {
        closePresetModal();
        return;
      }

      // 内部对话管理弹窗
      if (els.subchatModal && els.subchatModal.classList.contains('show')) {
        closeSubChatModal();
        return;
      }

      // 预设合并效果预览弹窗
      if (els.presetMergedModal && els.presetMergedModal.classList.contains('show')) {
        closeMergedPreview();
        return;
      }

      // 顶部 #0 一站式预设控制台下拉
      if (topPresetOpen) {
        closeTopPresetDropdown();
        return;
      }

      // 输入区左侧工具箱
      if (els.inputToolboxPanel && !els.inputToolboxPanel.hidden) {
        closeInputToolbox();
        return;
      }

      // 优先收起底部浮层（参数面板 / 模型面板）
      if (els.quickParamsPanel && !els.quickParamsPanel.hidden) {
        closeQuickParamsPanel();
        return;
      }

      if (els.quickModelPanel && !els.quickModelPanel.hidden) {
        closeQuickModelPanel();
        return;
      }

      if (els.modal && els.modal.classList.contains('show')) {
        closeSettings();
      } else if (els.sidebar && els.sidebar.classList.contains('open')) {
        closeSidebar();
      }
    });

    // 弹窗内输入框按 Enter 直接保存（下拉框不参与）
    [
      els.cfgBaseUrl,
      els.cfgApiKey,
      els.cfgSyncToken,
      els.cfgGistId
    ].forEach(function (input) {
      if (!input) return;
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveSettings();
        }
      });
    });

    // 关闭设置弹窗时，若同步配置被清空则同步刷新顶部按钮状态
    if (els.cancelBtn) {
      els.cancelBtn.addEventListener('click', function () {
        renderSyncStatus();
      });
    }

    // ===== 系统提示词预设：顶部入口 + 管理弹窗 + 小模块编辑窗口 =====
    if (els.presetBtn) {
      els.presetBtn.addEventListener('click', openPresetModal);
    }
    if (els.presetCloseBtn) {
      els.presetCloseBtn.addEventListener('click', closePresetModal);
    }
    if (els.presetSelect) {
      els.presetSelect.addEventListener('change', function () {
        handlePresetSelectChange(els.presetSelect.value);
      });
    }
    if (els.presetNewBtn) {
      els.presetNewBtn.addEventListener('click', createPresetFlow);
    }
    if (els.presetRenameBtn) {
      els.presetRenameBtn.addEventListener('click', renamePresetFlow);
    }
    if (els.presetDeleteBtn) {
      els.presetDeleteBtn.addEventListener('click', deletePresetFlow);
    }
    if (els.presetAddModuleBtn) {
      els.presetAddModuleBtn.addEventListener('click', function () {
        var preset = getCurrentSessionPreset();
        if (!preset) return;
        openModuleEditModal(preset.id, null);
      });
    }

    // 顶部右上角对话搜索：输入即搜、范围切换、结果跳转与高亮
    bindSearchEvents();

    // 拖拽排序：容器级 dragover 只绑定一次
    if (els.presetModuleList) {
      els.presetModuleList.addEventListener('dragover', handleModuleDragOver);
    }

    // 小模块编辑窗口：仅「保存」写入大预设，取消 / 关闭 / 遮罩点击一律丢弃修改
    if (els.moduleSaveBtn) {
      els.moduleSaveBtn.addEventListener('click', saveModuleFromEditor);
    }
    if (els.moduleCancelBtn) {
      els.moduleCancelBtn.addEventListener('click', closeModuleEditModal);
    }
    if (els.moduleEditClose) {
      els.moduleEditClose.addEventListener('click', closeModuleEditModal);
    }
    if (els.moduleDeleteBtn) {
      els.moduleDeleteBtn.addEventListener('click', deleteModuleFromEditor);
    }

    // 预设弹窗与小模块弹窗：遮罩点击关闭（按下与松开都落在遮罩层才生效）
    [
      [els.presetModal, closePresetModal],
      [els.moduleEditModal, closeModuleEditModal],
      [els.subchatModal, closeSubChatModal],
      [els.presetMergedModal, closeMergedPreview],
      [els.wbDetailModal, closeWbTriggeredDetail],
      [els.sessionCharModal, closeSessionCharModal]
    ].forEach(function (pair) {
      var modalEl = pair[0];
      var closeFn = pair[1];
      if (!modalEl) return;

      modalEl.addEventListener('click', function (e) {
        if (e.target === modalEl) closeFn();
      });
    });

    // ===== 顶部 #0 一站式预设控制台：常驻入口 + 下拉面板 =====
    if (els.topPresetTrigger) {
      els.topPresetTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleTopPresetDropdown();
      });
    }
    if (els.topPresetDropdown) {
      els.topPresetDropdown.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }
    if (els.topPresetSelect) {
      els.topPresetSelect.addEventListener('change', function () {
        handlePresetSelectChange(els.topPresetSelect.value);
      });
    }
    if (els.tpNewBtn) {
      els.tpNewBtn.addEventListener('click', createPresetFlow);
    }
    if (els.tpRenameBtn) {
      els.tpRenameBtn.addEventListener('click', renamePresetFlow);
    }
    if (els.tpDeleteBtn) {
      els.tpDeleteBtn.addEventListener('click', deletePresetFlow);
    }
    if (els.tpAddModuleBtn) {
      els.tpAddModuleBtn.addEventListener('click', function () {
        var preset = getCurrentSessionPreset();
        if (!preset) return;
        openModuleEditModal(preset.id, null);
      });
    }
    if (els.tpPreviewBtn) {
      els.tpPreviewBtn.addEventListener('click', openMergedPreview);
    }
    // 拖拽排序：顶部小模块列表容器级 dragover 只绑定一次
    if (els.tpModuleList) {
      els.tpModuleList.addEventListener('dragover', handleTopModuleDragOver);
    }

    // 合并效果预览：一键复制 / 关闭
    if (els.presetMergedCopy) {
      els.presetMergedCopy.addEventListener('click', function () {
        var text = els.presetMergedContent ? els.presetMergedContent.textContent : '';
        copyText(text, function (ok) {
          els.presetMergedCopy.textContent = ok ? '已复制' : '复制失败';
          setTimeout(function () {
            els.presetMergedCopy.textContent = '一键复制';
          }, 1500);
        });
      });
    }
    if (els.presetMergedClose) {
      els.presetMergedClose.addEventListener('click', closeMergedPreview);
    }
    if (els.presetMergedDone) {
      els.presetMergedDone.addEventListener('click', closeMergedPreview);
    }

    // 本地全量备份复用云同步的打包、规范化与恢复入口
    document.getElementById('btn-export-all-backup').addEventListener('click', function () {
      try {
        if (!flushSave()) throw new Error('存储写入失败，已取消导出');
        var backup = { _backupType: 'mychat_full_backup', version: 2, exportedAt: Date.now(), data: buildCloudPayload() };
        var now = new Date();
        var pad = function (n) { return String(n).padStart(2, '0'); };
        var stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes());
        var url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }));
        var link = document.createElement('a');
        link.href = url;
        link.download = 'mychat-backup-' + stamp + '.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      } catch (err) { void window.showAppAlert('导出失败：' + err.message); }
    });
    var backupInput = document.getElementById('input-import-all-backup');
    document.getElementById('btn-import-all-backup').addEventListener('click', function () { backupInput.click(); });
    backupInput.addEventListener('change', async function () {
      var file = backupInput.files[0];
      if (!file) return;
      try {
        if (document.getElementById('btn-send').disabled || document.getElementById('btn-send').textContent === '停止') throw new Error('请先停止正在生成的回复再恢复备份');
        var raw = JSON.parse(await file.text());
        var data = raw && raw._backupType === 'mychat_full_backup' ? raw.data : raw;
        if (!data || !Array.isArray(data.sessions)) throw new Error('备份格式无效：缺少会话数组');
        var parsed = parseCloudPayload(JSON.stringify(data));
        if (!parsed || parsed.sessions.length !== data.sessions.length) throw new Error('备份中含无效会话，已取消恢复');
        var beforeStats = collectRestoreStats(data);
        if (!await window.showAppConfirm('导入将覆盖本地数据。备份包含：' + formatRestoreStats(beforeStats) + '。继续？')) return;
        if (activeGenerationMap.size > 0) throw new Error('请等待回复结束');
        // applyCloudData 内部已经调用 applyCloudExtras，不重复恢复
        var afterStats = applyCloudData(parsed, { source: 'local' });
        if (window.MemorySummaryModule) window.MemorySummaryModule.refreshTokenMeter();
        var filteredCount = Math.max(0, beforeStats.messagesCount - afterStats.messagesCount);
        await window.showAppAlert('恢复成功：' + formatRestoreStats(afterStats) + '。\n导入前：' + formatRestoreStats(beforeStats) + (filteredCount ? '。\n已过滤 ' + filteredCount + ' 条非法空消息' : ''));
      } catch (err) { await window.showAppAlert('导入失败：' + err.message); }
      finally { backupInput.value = ''; }
    });

    // ===== 输入区左侧自适应工具箱 =====
    if (els.inputToolboxBtn) {
      els.inputToolboxBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleInputToolbox();
      });
    }
    if (els.inputToolboxPanel) {
      els.inputToolboxPanel.addEventListener('click', function (e) {
        e.stopPropagation();
        var item = e.target.closest ? e.target.closest('.toolbox-item') : null;
        if (!item) return;
        var tool = item.getAttribute('data-tool');
        closeInputToolbox();
        if (tool === 'subchats') openSubChatModal();
      });
    }

    // ===== 内部对话管理弹窗 =====
    // 「+ 新建对话」统一收敛为容器级事件委托：
    // 1) 弹窗打开时列表由 renderSubChatList() 动态重绘，直接绑定按钮在重绘后会失效；
    // 2) 委托挂在弹窗容器上，只有一次监听，天然不会重复触发。
    if (els.subchatModal) {
      els.subchatModal.addEventListener('click', function (e) {
        var target = e.target;
        if (!target || !target.closest) return;
        if (target.closest('#subchat-new-btn')) {
          e.preventDefault();
          createSubChatFlow();
          return;
        }
        if (target.closest('#subchat-close')) {
          e.preventDefault();
          closeSubChatModal();
        }
      });
    }

    // 页面重新可见时保持滚动到底部，并顺带比对一次云端是否有新数据
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        captureInputDraft();
        flushSave();
        return;
      }
      scrollToBottom();

      requestForegroundCloudSync();
    });
    window.addEventListener('focus', requestForegroundCloudSync);
    window.addEventListener('pagehide', function () {
      captureInputDraft();
      flushSave();
    });
  }

  /* ================= 初始化 ================= */

  async function init() {
    // 跟随软键盘与可视视口，桌面端继续使用原有布局。
    function updateVisualViewport() {
      var viewport = window.visualViewport;
      document.documentElement.style.setProperty('--visual-height', (viewport ? viewport.height : window.innerHeight) + 'px');
      document.documentElement.style.setProperty('--app-vv-height', (viewport ? viewport.height : window.innerHeight) + 'px');
      document.documentElement.style.setProperty('--visual-top', (viewport ? viewport.offsetTop : 0) + 'px');
    }
    updateVisualViewport();
    window.addEventListener('resize', updateVisualViewport);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateVisualViewport);
      window.visualViewport.addEventListener('scroll', updateVisualViewport);
    }
    // Markdown 引擎：禁用 4 空格缩进代码块，避免正则产出的 HTML 被误当代码
    setupMarkdownEngine();
    // 酒馆兼容发送桥接器（状态栏按钮 directSend）
    setupSillyTavernBridge();
    loadConfig();
    // 全局默认对话参数：必须早于会话加载，新会话才能正确继承
    loadChatParams();
    // 渠道 / 模型：先迁移旧配置，再恢复上次选中的渠道与模型
    loadProviders();
    loadActiveTarget();
    loadSessions();
    // 模块化系统提示词预设库：早于首次渲染，保证顶部入口高亮状态正确
    loadPromptPresets();
    ensureLocalLastModified(); // 启动保护期间不补写全局时间戳

    // 主题 / 视图偏好：必须在首次渲染前应用，避免闪烁
    loadUiPrefs();
    applyUiPrefs();

    bindEvents();
    renderQuickModelSelect(); // 底部快捷选择器必须在首次渲染前就绪
    renderSessionList();
    renderMessages();
    refreshQuickParamsPanel(); // 首屏同步当前会话的参数按钮状态
    refreshPresetButtonState(); // 首屏同步顶部预设入口高亮状态
    refreshTopPresetUI(); // 首屏同步顶部 #0 一站式预设控制台的显示名与高亮
    restoreInputDraft();
    if (els.input) els.input.focus();

    // 本地迁移与巡检必须在启动锁内完成，不能抢在首次云端对表前刷新版本。
    if (window.MemorySummaryModule) window.MemorySummaryModule.migrateLegacyMemory();
    refreshMemoryContext();
    setSyncStatus('idle');

    // 每 30 秒刷新「已同步 (x 分钟前)」的相对时间
    setInterval(renderSyncStatus, 30 * 1000);

    // 初始化收尾：此后渠道 / 模型变更才允许刷新时间戳并触发自动上传
    isBooting = false;
    await syncWithCloud(true);
  }

  window.addEventListener('mychat-provider-defaults-ready', function () {
    if (isBooting) return; // 大容量历史预加载完成后由 loadProviders 合并，禁止抢先覆写。
    mergeBuiltinProviders(providers);
    persistProviders(true);
    renderQuickModelSelect();
  }, { once: true });
  window.addEventListener('beforeunload', function (event) {
    if (pendingIdbWrites <= 0) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.MyChatStorageReady = preloadLargeStorage().then(async function () {
    await init();
  }).catch(function (error) {
    console.error('历史数据加载失败：', error);
    window.alert(error.message || '历史数据加载失败');
    throw error;
  });

  // 等所有模块的就绪回调完成后补绘首屏；动态加载时也走下一帧兜底。
  function scheduleReadyChatRender() {
    window.requestAnimationFrame(function () { MyChatBridge.refreshChatUI(); });
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', scheduleReadyChatRender, { once: true });
  } else {
    scheduleReadyChatRender();
  }
})();
