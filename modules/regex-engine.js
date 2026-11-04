/* ===================================================================
   MyChat 三层正则引擎（modules/regex-engine.js）
   --------------------------------------------------------------
   三层规则优先级与执行顺序（同一阶段内按 全局 → 预设 → 会话 依次叠加）：
     1. 全局正则      localStorage.mychat_regex_rules
     2. 预设正则      当前会话绑定的大预设 preset.regexRules
     3. 会话正则      当前会话 session.regexRules（角色卡专属正则落在这里）

   三个阀门（与 app.js 的 PLUGIN_PIPELINE 完全一致）：
     beforeSend —— 发送前改写本次请求的 messages（不落盘，不影响本地聊天记录）
     onReceive  —— AI 回复写入会话历史之前清洗
     onRender   —— 仅影响气泡显示，绝不改动入库内容

   设计约束：
     - 纯原生 ES5 语法，双击 index.html（file:// 协议）可直接运行；
     - 只通过 window.MyChat 桥接器读写数据，绝不触碰 app.js 私有变量；
     - 任何一条非法正则都必须被 try/catch 吞掉，绝不阻塞消息渲染。
   =================================================================== */

(function () {
  'use strict';

  var bridge = window.MyChat;
  if (!bridge || typeof bridge.registerHook !== 'function') {
    console.warn('[正则引擎] 未检测到 window.MyChat 桥接器，模块跳过加载（请确认 app.js 已先加载）');
    return;
  }

  /* ================= 常量与状态 ================= */

  var STAGES = ['beforeSend', 'onReceive', 'onRender'];
  var STAGE_LABELS = {
    beforeSend: '发送前',
    onReceive: '接收落盘',
    onRender: '渲染时'
  };
  var TARGET_LABELS = { user: '用户', assistant: 'AI', system: '系统' };

  var uiState = {
    scope: 'session', // session / preset / global
    editingId: ''     // 空字符串 = 正在新建规则
  };

  /* ================= 通用工具 ================= */

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  var AMP = '&' + 'amp;';
  var LT = '&' + 'lt;';
  var GT = '&' + 'gt;';
  var QUOT = '&' + 'quot;';
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

  function toast(text) {
    if (bridge.showToast) bridge.showToast(text);
    else console.log('[正则引擎] ' + text);
  }

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (err) {
      return Array.isArray(value) ? [] : {};
    }
  }

  /* ================= 酒馆正则转换（对外公共方法） ================= */

  /**
   * 把酒馆正则脚本的 placement 统一解析为数字数组
   * 1 = 用户输入，2 = AI 输出
   */
  function parsePlacement(raw) {
    var out = [];
    var push = function (item) {
      var num = typeof item === 'number' ? item : parseInt(item, 10);
      if (num === 1 || num === 2) {
        if (out.indexOf(num) === -1) out.push(num);
      }
    };
    if (Array.isArray(raw)) {
      raw.forEach(push);
    } else if (typeof raw === 'number') {
      push(raw);
    } else if (typeof raw === 'string') {
      raw.split(/[,，\s|]+/).forEach(push);
    }
    return out;
  }

  /**
   * 剥离 /pattern/flags 包裹写法，返回 { pattern, flags }
   * 例如 /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/g
   *   → pattern: '<UpdateVariable>([\s\S]*?)<\/UpdateVariable>' , flags: 'g'
   * 没有包裹时原样作为 pattern，flags 默认 'g'
   */
  function unwrapTavernRegex(findRegex) {
    var find = typeof findRegex === 'string' ? findRegex : '';
    if (!find) return { pattern: '', flags: 'g' };
    if (find.charAt(0) !== '/') return { pattern: find, flags: 'g' };

    // 从尾部向前找第一个未被转义的斜杠作为结束分隔符
    var lastSlash = -1;
    for (var i = find.length - 1; i > 0; i--) {
      if (find.charAt(i) !== '/') continue;
      var escaped = false;
      var k = i - 1;
      while (k >= 0 && find.charAt(k) === '\\') {
        escaped = !escaped;
        k--;
      }
      if (!escaped) {
        lastSlash = i;
        break;
      }
    }
    if (lastSlash <= 0) return { pattern: find, flags: 'g' };

    var tail = find.slice(lastSlash + 1);
    if (!/^[dgimsuvy]*$/.test(tail)) {
      // 尾部不是合法修饰符，说明不是 /pattern/flags 写法，原样使用
      return { pattern: find, flags: 'g' };
    }
    return {
      pattern: find.slice(1, lastSlash),
      flags: tail || 'g'
    };
  }

  /**
   * 酒馆正则脚本 → MyChat 规则结构（对外公共方法，供 tavern-importer.js 复用）
   * @param {Object} script 酒馆 regex_scripts 中的单条脚本
   * @return {Object} MyChat 规则 { id,name,pattern,flags,replacement,stages,stage,targets,enabled }
   */
  function convertTavernRegex(script) {
    var src = script && typeof script === 'object' ? script : {};
    var unwrapped = unwrapTavernRegex(src.findRegex || src.find_regex || src.pattern);

    var placement = parsePlacement(src.placement);

    // 多阶段推导（兼容 markdownOnly / promptOnly / placement 三种写法）
    var stages = [];
    var pushStage = function (stage) {
      if (STAGES.indexOf(stage) !== -1 && stages.indexOf(stage) === -1) stages.push(stage);
    };
    var hasFlagFields =
      typeof src.markdownOnly === 'boolean' || typeof src.promptOnly === 'boolean';
    if (hasFlagFields) {
      var mdOnly = src.markdownOnly === true;
      var promptOnly = src.promptOnly === true;
      if (mdOnly && promptOnly) {
        pushStage('beforeSend');
        pushStage('onRender');
      } else if (mdOnly) {
        pushStage('onRender');
      } else if (promptOnly) {
        pushStage('beforeSend');
      }
    }
    if (stages.length === 0) {
      if (placement.indexOf(1) !== -1) pushStage('beforeSend');
      if (placement.indexOf(2) !== -1) {
        pushStage('onReceive');
        pushStage('onRender');
      }
    }
    if (stages.length === 0) pushStage('onRender');

    // 作用对象推导
    var targets = [];
    if (placement.indexOf(1) !== -1) targets.push('user');
    if (placement.indexOf(2) !== -1) targets.push('assistant');
    if (targets.length === 0) targets = ['user', 'assistant'];

    return {
      id: uid('rule'),
      name:
        (typeof src.scriptName === 'string' && src.scriptName.trim()) ||
        (typeof src.name === 'string' && src.name.trim()) ||
        '未命名正则',
      pattern: unwrapped.pattern,
      flags: unwrapped.flags,
      replacement:
        typeof src.replaceString === 'string'
          ? src.replaceString
          : typeof src.replace_string === 'string'
            ? src.replace_string
            : '',
      stages: stages,
      stage: stages[0],
      targets: targets,
      enabled: src.disabled !== true && src.enabled !== false
    };
  }

  // 同时挂到桥接器上，供其他模块（酒馆导入器）直接调用
  bridge.convertTavernRegex = convertTavernRegex;

  /* ================= 规则读取与执行 ================= */

  function readScopeRules(scope) {
    if (scope === 'global') {
      return typeof bridge.getRegexRules === 'function' ? bridge.getRegexRules() : [];
    }
    if (scope === 'preset') {
      return typeof bridge.getPresetRegexRules === 'function'
        ? bridge.getPresetRegexRules()
        : [];
    }
    return typeof bridge.getSessionRegexRules === 'function'
      ? bridge.getSessionRegexRules()
      : [];
  }

  function writeScopeRules(scope, rules) {
    if (scope === 'global') {
      return typeof bridge.saveRegexRules === 'function' ? bridge.saveRegexRules(rules) : [];
    }
    if (scope === 'preset') {
      return typeof bridge.savePresetRegexRules === 'function'
        ? bridge.savePresetRegexRules(rules)
        : [];
    }
    return typeof bridge.saveSessionRegexRules === 'function'
      ? bridge.saveSessionRegexRules(rules)
      : [];
  }

  function ruleStages(rule) {
    if (Array.isArray(rule.stages) && rule.stages.length) return rule.stages;
    if (typeof rule.stage === 'string') return [rule.stage];
    return [];
  }

  function ruleTargets(rule) {
    if (Array.isArray(rule.targets) && rule.targets.length) return rule.targets;
    return ['assistant'];
  }

  /**
   * 编译单条规则：非法正则只告警并跳过，绝不抛错阻塞渲染
   */
  function compileRule(rule) {
    var pattern = typeof rule.pattern === 'string' ? rule.pattern : '';
    if (!pattern) return null;
    try {
      return new RegExp(pattern, typeof rule.flags === 'string' ? rule.flags : '');
    } catch (err) {
      console.warn('[正则引擎] 规则「' + (rule.name || '未命名') + '」正则语法有误，已跳过：', err);
      return null;
    }
  }

  /**
   * 取出三层规则（全局 → 预设 → 会话），保证执行顺序固定
   */
  function collectLayeredRules(session) {
    var layers = [];
    var globalRules = readScopeRules('global');
    var presetRules = readScopeRules('preset');
    var sessionRules =
      session && Array.isArray(session.regexRules) ? session.regexRules : readScopeRules('session');
    layers.push({ scope: 'global', rules: globalRules });
    layers.push({ scope: 'preset', rules: presetRules });
    layers.push({ scope: 'session', rules: sessionRules });
    return layers;
  }

  /**
   * 对单段文本执行指定阶段 / 指定角色的全部规则
   * @param {String} text  原始文本
   * @param {String} stage 阶段名
   * @param {String} role  角色（user / assistant / system）
   * @param {Object} session 当前会话
   * @return {String} 处理后的文本
   */
  function applyRules(text, stage, role, session) {
    if (typeof text !== 'string' || !text) return text;
    var targetRole = role === 'user' || role === 'system' ? role : 'assistant';
    var layers = collectLayeredRules(session);
    var out = text;

    for (var i = 0; i < layers.length; i++) {
      var list = Array.isArray(layers[i].rules) ? layers[i].rules : [];
      for (var j = 0; j < list.length; j++) {
        var rule = list[j];
        if (!rule || typeof rule !== 'object') continue;
        if (rule.enabled === false) continue;
        if (ruleStages(rule).indexOf(stage) === -1) continue;
        if (ruleTargets(rule).indexOf(targetRole) === -1) continue;

        var re = compileRule(rule);
        if (!re) continue;

        var replacement = typeof rule.replacement === 'string' ? rule.replacement : '';
        if (replacement && typeof bridge.replaceMacros === 'function') {
          replacement = bridge.replaceMacros(replacement, session);
        }
        try {
          out = out.replace(re, replacement);
        } catch (err) {
          console.warn('[正则引擎] 规则「' + (rule.name || '未命名') + '」替换失败，已跳过：', err);
        }
      }
    }
    return out;
  }

  /* ================= MVU 变量引擎（MagVarUpdate 兼容） ================= */

  /**
   * 宽松 YAML / JSON 解析器（只服务 MVU 的 [initvar] 变量初始化，不求完整 YAML 规范）
   * 支持：
   *   - 二级及更深缩进（2 空格递进）的嵌套对象，键名支持中文
   *   - 字符串（自动去首尾引号）、数字、布尔、null
   *   - "- 值" 形式的简单列表
   * @param {String} text 原始文本
   * @return {Object|Array|null} 解析失败返回 null
   */
  function parseSimpleYamlOrJson(text) {
    var raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    if (!raw.trim()) return null;

    // 优先按标准 JSON 解析（很多卡直接给 JSON）
    var trimmed = raw.trim();
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      try {
        return JSON.parse(trimmed);
      } catch (jsonErr) {
        /* 继续尝试 YAML */
      }
    }

    var lines = raw.split(/\r?\n/);
    var root = {};

    // 栈：{ indent, value } —— value 为当前缩进层对应的容器
    var stack = [{ indent: -1, value: root }];

    var parseScalar = function (val) {
      var s = String(val == null ? '' : val).trim();
      if (!s) return '';
      if (
        (s.charAt(0) === '"' && s.charAt(s.length - 1) === '"' && s.length >= 2) ||
        (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'" && s.length >= 2)
      ) {
        s = s.slice(1, -1);
        return s;
      }
      if (/^(null|~)$/i.test(s)) return null;
      if (/^(true|yes|on)$/i.test(s)) return true;
      if (/^(false|no|off)$/i.test(s)) return false;
      if (/^-?\d+$/.test(s)) return Number(s);
      if (/^-?\d*\.\d+$/.test(s)) return Number(s);
      // 行内数组：[a, b, c]
      if (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') {
        var inner = s.slice(1, -1).trim();
        if (!inner) return [];
        return inner.split(',').map(function (item) {
          return parseScalar(item);
        });
      }
      return s;
    };

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\t/g, '  ');
      if (!line.trim()) continue;
      if (/^\s*#/.test(line)) continue; // 注释行

      var indentMatch = /^(\s*)/.exec(line);
      var indent = indentMatch ? indentMatch[1].length : 0;
      var body = line.trim();

      // 列表项：- 值
      if (/^-\s*/.test(body)) {
        var itemText = body.replace(/^-\s*/, '');
        // 找到最近的数组容器
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
        var holder = stack[stack.length - 1].value;
        if (Array.isArray(holder)) {
          if (itemText && itemText.indexOf(':') !== -1 && !/^[\[{]/.test(itemText)) {
            var objItem = {};
            var pair = /^([^:]+):\s*(.*)$/.exec(itemText);
            if (pair) objItem[String(pair[1]).trim()] = parseScalar(pair[2]);
            holder.push(objItem);
          } else {
            holder.push(parseScalar(itemText));
          }
        }
        continue;
      }

      var pairMatch = /^([^:]+):\s*(.*)$/.exec(body);
      if (!pairMatch) continue;

      var key = String(pairMatch[1]).trim().replace(/^["']|["']$/g, '');
      var valueText = pairMatch[2];

      // 回退到正确的父容器
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      var container = stack[stack.length - 1].value;
      if (!container || typeof container !== 'object') continue;

      if (valueText === '' || valueText === '|' || valueText === '>') {
        // 需要判断下一行是对象还是列表
        var nextLine = '';
        for (var k = i + 1; k < lines.length; k++) {
          if (lines[k].trim()) {
            nextLine = lines[k];
            break;
          }
        }
        var isList = /^\s*-/.test(nextLine);
        var child = isList ? [] : {};
        container[key] = child;
        stack.push({ indent: indent, value: child });
      } else {
        container[key] = parseScalar(valueText);
        // 标量占位后，后续同级键需要覆盖它
        stack.push({ indent: indent, value: container });
      }
    }

    return root;
  }

  /**
   * 解析 JSON-Patch 路径：/stat_data/系统/具体时间 → ['系统', '具体时间']
   */
  function patchPathParts(pathText) {
    var raw = String(pathText == null ? '' : pathText).trim();
    if (!raw) return [];
    return raw
      .split('/')
      .filter(function (seg) {
        return seg !== '';
      })
      .map(function (seg) {
        return decodeURIComponent(seg).replace(/~1/g, '/').replace(/~0/g, '~');
      });
  }

  /**
   * 在 stat_data 上读取路径值
   */
  function patchGet(root, parts) {
    var cursor = root;
    for (var i = 0; i < parts.length; i++) {
      if (cursor === null || cursor === undefined) return undefined;
      cursor = cursor[parts[i]];
    }
    return cursor;
  }

  /**
   * 在 stat_data 上写入路径值（自动补建中间对象 / 数组）
   */
  function patchSet(root, parts, value) {
    if (!parts.length) return root;
    var cursor = root;
    for (var i = 0; i < parts.length - 1; i++) {
      var key = parts[i];
      if (!cursor[key] || typeof cursor[key] !== 'object') {
        cursor[key] = /^\d+$/.test(parts[i + 1] || '') ? [] : {};
      }
      cursor = cursor[key];
    }
    var lastKey = parts[parts.length - 1];
    if (Array.isArray(cursor) && lastKey === '-') {
      cursor.push(value);
    } else {
      cursor[lastKey] = value;
    }
    return root;
  }

  /**
   * 在 stat_data 上删除路径
   */
  function patchRemove(root, parts) {
    if (!parts.length) return root;
    var cursor = root;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cursor || typeof cursor !== 'object') return root;
      cursor = cursor[parts[i]];
    }
    if (!cursor || typeof cursor !== 'object') return root;
    var lastKey = parts[parts.length - 1];
    if (Array.isArray(cursor)) {
      var idx = Number(lastKey);
      if (isFinite(idx) && idx >= 0 && idx < cursor.length) cursor.splice(idx, 1);
    } else {
      delete cursor[lastKey];
    }
    return root;
  }

  /**
   * 应用单条 JSON-Patch 指令到 stat_data
   * 兼容 path 带 /stat_data 前缀与不带前缀两种写法
   */
  function applyPatchOp(statData, op) {
    if (!op || typeof op !== 'object') return statData;
    var action = String(op.op || '').toLowerCase();
    var parts = patchPathParts(op.path);
    // 统一剥掉开头的 stat_data，内部一律以 stat_data 对象本身为根
    if (parts.length && (parts[0] === 'stat_data' || parts[0] === 'statData')) {
      parts = parts.slice(1);
    }
    if (!action) return statData;

    if (action === 'replace') {
      if (!parts.length) return op.value && typeof op.value === 'object' ? op.value : statData;
      patchSet(statData, parts, op.value);
      return statData;
    }

    if (action === 'delta') {
      var current = patchGet(statData, parts);
      var base = typeof current === 'number' ? current : Number(current);
      if (!isFinite(base)) base = 0;
      var delta = Number(op.value);
      if (!isFinite(delta)) delta = 0;
      patchSet(statData, parts, base + delta);
      return statData;
    }

    if (action === 'insert') {
      var container = parts.length > 1 ? patchGet(statData, parts.slice(0, -1)) : statData;
      var lastKey = parts.length ? parts[parts.length - 1] : '';
      if (Array.isArray(container)) {
        if (lastKey === '-' || lastKey === '') container.push(op.value);
        else {
          var insertIdx = Number(lastKey);
          if (!isFinite(insertIdx) || insertIdx < 0) insertIdx = container.length;
          container.splice(insertIdx, 0, op.value);
        }
      } else if (parts.length) {
        patchSet(statData, parts, op.value);
      }
      return statData;
    }

    if (action === 'remove') {
      patchRemove(statData, parts);
      return statData;
    }

    if (action === 'move' || action === 'copy') {
      var fromParts = patchPathParts(op.from);
      if (fromParts.length && (fromParts[0] === 'stat_data' || fromParts[0] === 'statData')) {
        fromParts = fromParts.slice(1);
      }
      var moved = patchGet(statData, fromParts);
      if (action === 'move') patchRemove(statData, fromParts);
      var targetParts = parts;
      if (op.to && (!targetParts || !targetParts.length)) {
        targetParts = patchPathParts(op.to);
        if (targetParts.length && targetParts[0] === 'stat_data') targetParts = targetParts.slice(1);
      }
      patchSet(statData, targetParts, moved);
      return statData;
    }

    return statData;
  }

  /**
   * 从单条消息文本里提取并应用全部 <UpdateVariable> / <JSONPatch> 指令
   */
  function applyVariableUpdateTags(statData, content) {
    var text = String(content == null ? '' : content)
      .replace(/```[\s\S]*?```/g, '')
      .replace(/(`+)[^\r\n]*?\1/g, '');
    if (!text || text.indexOf('UpdateVariable') === -1) return statData;

    var blockRe = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi;
    var block;
    while ((block = blockRe.exec(text)) !== null) {
      var inner = String(block[1] || '');
      var patchRe = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/gi;
      var patch;
      var handled = false;
      while ((patch = patchRe.exec(inner)) !== null) {
        handled = true;
        applyPatchText(statData, patch[1]);
      }
      if (!handled) applyPatchText(statData, inner);
    }
    return statData;
  }

  /**
   * 把一段 JSON 数组文本解析为 patch 指令并依次执行
   */
  function applyPatchText(statData, patchText) {
    var raw = String(patchText == null ? '' : patchText).trim();
    if (!raw) return statData;
    // 去掉可能的 Markdown 代码围栏
    raw = raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
    if (raw.charAt(0) !== '[') {
      var start = raw.indexOf('[');
      var end = raw.lastIndexOf(']');
      if (start === -1 || end === -1 || end <= start) return statData;
      raw = raw.slice(start, end + 1);
    }
    var ops = null;
    try {
      ops = JSON.parse(raw);
    } catch (err) {
      return statData;
    }
    if (!Array.isArray(ops)) return statData;
    ops.forEach(function (op) {
      try {
        applyPatchOp(statData, op);
      } catch (opErr) {
        console.warn('[MVU] 单条 patch 执行失败：', opErr);
      }
    });
    return statData;
  }

  /**
   * 收集会话绑定世界书里的「变量初始化」条目内容
   * 注意：即使条目 enabled === false（作者常用 [initvar]...勿开 命名），也必须读取
   */
  function collectInitVarSources(session) {
    var sources = [];
    if (!session) return sources;
    var ids = Array.isArray(session.worldbookIds) ? session.worldbookIds : [];
    if (!ids.length) return sources;

    var books = [];
    try {
      books = typeof bridge.getWorldbooks === 'function' ? bridge.getWorldbooks() : [];
    } catch (err) {
      books = [];
    }
    if (!Array.isArray(books)) return sources;

    var isInitVar = function (entry) {
      var label = String((entry && entry.name) || '') + ' ' + String((entry && entry.comment) || '');
      return /initvar|变量初始化/i.test(label);
    };

    books.forEach(function (book) {
      if (!book || ids.indexOf(book.id) === -1) return;
      var entries = Array.isArray(book.entries) ? book.entries : [];
      entries.forEach(function (entry) {
        if (!entry || !isInitVar(entry)) return;
        var content = typeof entry.content === 'string' ? entry.content : '';
        if (content.trim()) sources.push(content);
      });
    });
    return sources;
  }

  // 变量状态缓存：会话 id + 楼层数 + 末条长度 → 已计算结果
  var mvuCache = { key: '', value: null };

  /**
   * 计算会话在指定楼层时的 MVU 变量状态（对外主入口）
   * @param {Object} session 会话对象
   * @param {Number} [upToMsgIndex] 截止消息下标（含），缺省为最后一条
   * @return {Object} { stat_data, ...顶层镜像字段 }
   */
  function computeSessionMvuState(session, upToMsgIndex) {
    if (!session || typeof session !== 'object') return { stat_data: {} };

    var messages = Array.isArray(session.messages) ? session.messages : [];
    var endIndex =
      typeof upToMsgIndex === 'number' && isFinite(upToMsgIndex)
        ? Math.min(Math.max(0, upToMsgIndex), Math.max(0, messages.length - 1))
        : messages.length - 1;

    var lastLen = 0;
    for (var li = 0; li <= endIndex && li < messages.length; li++) {
      lastLen = String((messages[li] && messages[li].content) || '').length;
    }
    var cacheKey = [
      session.id || '',
      endIndex,
      messages.length,
      lastLen,
      (Array.isArray(session.worldbookIds) ? session.worldbookIds.join(',') : '')
    ].join('|');

    if (mvuCache.key === cacheKey && mvuCache.value) {
      return mvuCache.value;
    }

    // ---- Step 1：从 initvar 条目读取初始变量 ----
    var statData = {};
    var initSources = collectInitVarSources(session);
    for (var si = 0; si < initSources.length; si++) {
      var parsed = parseSimpleYamlOrJson(initSources[si]);
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.stat_data && typeof parsed.stat_data === 'object') {
        statData = parsed.stat_data;
      } else {
        statData = parsed;
      }
      break; // 只取第一个成功解析的初始化源
    }
    if (!statData || typeof statData !== 'object') statData = {};

    // ---- Step 2：逐条消息累加 <UpdateVariable> 里的 JSONPatch ----
    for (var i = 0; i <= endIndex && i < messages.length; i++) {
      var msg = messages[i];
      if (!msg || typeof msg.content !== 'string') continue;
      applyVariableUpdateTags(statData, msg.content);
    }

    // ---- Step 3：外层同时镜像顶层键，兼容 _.get(all_variables, 'stat_data.系统.日期') ----
    var result = { stat_data: statData };
    Object.keys(statData).forEach(function (key) {
      if (key === 'stat_data') return;
      result[key] = statData[key];
    });

    mvuCache.key = cacheKey;
    mvuCache.value = result;
    return result;
  }

  /**
   * 把 MVU 变量状态序列化为可读文本（供 {{format_message_variable}} 使用）
   */
  function formatMvuState(statData, indent) {
    var level = typeof indent === 'number' ? indent : 0;
    var pad = new Array(level + 1).join('  ');
    if (statData === null || statData === undefined) return '';
    if (typeof statData !== 'object') return String(statData);

    if (Array.isArray(statData)) {
      return statData
        .map(function (item) {
          return pad + '- ' + formatMvuState(item, level + 1).replace(/^\s+/, '');
        })
        .join('\n');
    }

    return Object.keys(statData)
      .map(function (key) {
        var value = statData[key];
        if (value && typeof value === 'object') {
          return pad + key + ':\n' + formatMvuState(value, level + 1);
        }
        return pad + key + ': ' + (value === null || value === undefined ? '' : String(value));
      })
      .join('\n');
  }

  // 挂载到全局桥接器（app.js 的 replaceMacros / 沙盒垫片依赖此方法）
  bridge.computeSessionMvuState = computeSessionMvuState;
  bridge.parseSimpleYamlOrJson = parseSimpleYamlOrJson;
  bridge.formatMvuState = formatMvuState;

  /* ================= 管道接入（三个阀门） ================= */

  // 发送前：payload 为发往 API 的 messages 数组（临时快照，不落盘）
  bridge.registerHook('beforeSend', function (payload, context) {
    if (!Array.isArray(payload)) return undefined;
    var session = (context && context.session) || null;
    var changed = false;

    var next = payload.map(function (msg) {
      if (!msg || typeof msg.content !== 'string' || !msg.content) return msg;
      var role = msg.role === 'user' ? 'user' : msg.role === 'system' ? 'system' : 'assistant';
      var text = applyRules(msg.content, 'beforeSend', role, session);
      if (text === msg.content) return msg;
      changed = true;
      var copy = {};
      for (var key in msg) {
        if (Object.prototype.hasOwnProperty.call(msg, key)) copy[key] = msg[key];
      }
      copy.content = text;
      return copy;
    });

    return changed ? next : undefined;
  });

  // 接收落盘：payload 为 AI 回复正文（写入会话历史之前）
  bridge.registerHook('onReceive', function (payload, context) {
    if (typeof payload !== 'string' || !payload) return undefined;
    var session = (context && context.session) || null;
    var msg = context && context.msg ? context.msg : null;
    var role = msg && msg.role === 'user' ? 'user' : 'assistant';
    return applyRules(payload, 'onReceive', role, session);
  });

  // 渲染显示：payload 为交给 Markdown 渲染的正文（仅影响界面，不改数据）
  bridge.registerHook('onRender', function (payload, context) {
    if (typeof payload !== 'string' || !payload) return undefined;
    var session = (context && context.session) || null;
    var role = context && context.role === 'user' ? 'user' : 'assistant';
    return applyRules(payload, 'onRender', role, session);
  });

  /* ================= 管理器界面 ================= */

  var els = {};

  function bindEls() {
    els.modal = document.getElementById('regex-manager-modal');
    els.close = document.getElementById('regex-close-btn');
    els.tabs = document.getElementById('regex-tabs');
    els.list = document.getElementById('regex-rule-list');
    els.addBtn = document.getElementById('regex-add-btn');
    els.clearBtn = document.getElementById('regex-clear-btn');
    els.toolboxBtn = document.getElementById('toolbox-regex-btn');
    els.toolboxLabel = document.getElementById('toolbox-regex-label');

    els.editor = document.getElementById('regex-editor');
    els.edName = document.getElementById('regex-ed-name');
    els.edPattern = document.getElementById('regex-ed-pattern');
    els.edFlags = document.getElementById('regex-ed-flags');
    els.edReplacement = document.getElementById('regex-ed-replacement');
    els.edStageBeforeSend = document.getElementById('regex-stage-beforeSend');
    els.edStageOnRender = document.getElementById('regex-stage-onRender');
    els.edStageOnReceive = document.getElementById('regex-stage-onReceive');
    els.edTargetUser = document.getElementById('regex-target-user');
    els.edTargetAssistant = document.getElementById('regex-target-assistant');
    els.edCancel = document.getElementById('regex-ed-cancel');
    els.edSave = document.getElementById('regex-ed-save');
  }

  /**
   * 刷新工具箱按钮文本：显示三层规则总数
   */
  function updateToolboxLabel() {
    if (!els.toolboxLabel) return;
    var total = 0;
    ['global', 'preset', 'session'].forEach(function (scope) {
      var list = readScopeRules(scope);
      if (Array.isArray(list)) {
        list.forEach(function (rule) {
          if (rule && rule.enabled !== false) total++;
        });
      }
    });
    els.toolboxLabel.textContent = total > 0 ? '正则脚本 (' + total + ')' : '正则脚本';
  }

  function scopeLabel(scope) {
    if (scope === 'global') return '全局';
    if (scope === 'preset') return '预设';
    return '会话';
  }

  function renderTabs() {
    if (!els.tabs) return;
    var buttons = els.tabs.querySelectorAll('.regex-tab');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var scope = btn.getAttribute('data-scope') || 'session';
      var list = readScopeRules(scope);
      var count = Array.isArray(list) ? list.length : 0;
      var base =
        scope === 'global'
          ? '全局正则'
          : scope === 'preset'
            ? '当前预设正则'
            : '当前角色/对话正则';
      btn.textContent = base + ' (' + count + ')';
      if (scope === uiState.scope) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  }

  /**
   * 规则行的说明文字：阶段 + 对象 + 正则摘要
   */
  function buildRuleMeta(rule) {
    var stages = ruleStages(rule)
      .map(function (s) {
        return STAGE_LABELS[s] || s;
      })
      .join(' / ');
    var targets = ruleTargets(rule)
      .map(function (t) {
        return TARGET_LABELS[t] || t;
      })
      .join(' + ');
    var flags = typeof rule.flags === 'string' ? rule.flags : '';
    var pattern = typeof rule.pattern === 'string' ? rule.pattern : '';
    if (pattern.length > 60) pattern = pattern.slice(0, 60) + '…';
    return (
      (stages || '—') + ' · ' + (targets || '—') + ' · /' + pattern + '/' + flags
    );
  }

  function renderList() {
    if (!els.list) return;
    var rules = readScopeRules(uiState.scope);
    els.list.innerHTML = '';

    if (!Array.isArray(rules) || rules.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'regex-empty';
      empty.textContent =
        uiState.scope === 'preset'
          ? '当前对话未绑定预设，或该预设还没有正则规则'
          : uiState.scope === 'session'
            ? '当前对话还没有专属正则规则（导入角色卡时会自动写入）'
            : '还没有全局正则规则';
      els.list.appendChild(empty);
      return;
    }

    rules.forEach(function (rule) {
      if (!rule || typeof rule !== 'object') return;
      var row = document.createElement('div');
      row.className = 'regex-rule' + (rule.enabled === false ? ' off' : '');
      row.setAttribute('data-id', rule.id || '');

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'regex-switch' + (rule.enabled === false ? '' : ' on');
      toggle.setAttribute('data-act', 'toggle');
      toggle.setAttribute('aria-pressed', rule.enabled === false ? 'false' : 'true');
      toggle.title = rule.enabled === false ? '点击启用' : '点击停用';
      toggle.innerHTML = '<span class="regex-switch-dot"></span>';
      row.appendChild(toggle);

      var main = document.createElement('div');
      main.className = 'regex-rule-main';
      var title = document.createElement('div');
      title.className = 'regex-rule-name';
      title.textContent = rule.name || '未命名正则';
      var meta = document.createElement('div');
      meta.className = 'regex-rule-meta';
      meta.textContent = buildRuleMeta(rule);
      main.appendChild(title);
      main.appendChild(meta);
      row.appendChild(main);

      var actions = document.createElement('div');
      actions.className = 'regex-rule-actions';

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'regex-act-btn';
      editBtn.setAttribute('data-act', 'edit');
      editBtn.title = '编辑该规则';
      editBtn.textContent = '✎';
      actions.appendChild(editBtn);

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'regex-act-btn regex-act-danger';
      delBtn.setAttribute('data-act', 'delete');
      delBtn.title = '删除该规则';
      delBtn.textContent = '×';
      actions.appendChild(delBtn);

      row.appendChild(actions);
      els.list.appendChild(row);
    });
  }

  function renderAll() {
    renderTabs();
    renderList();
    updateToolboxLabel();
  }

  /* ---------- 规则编辑器 ---------- */

  function openEditor(rule) {
    if (!els.editor) return;
    var target = rule || null;
    uiState.editingId = target && target.id ? target.id : '';

    if (els.edName) els.edName.value = target ? target.name || '' : '';
    if (els.edPattern) els.edPattern.value = target ? target.pattern || '' : '';
    if (els.edFlags) els.edFlags.value = target && target.flags ? target.flags : 'g';
    if (els.edReplacement) els.edReplacement.value = target ? target.replacement || '' : '';

    var stages = target ? ruleStages(target) : ['onRender'];
    if (els.edStageBeforeSend) els.edStageBeforeSend.checked = stages.indexOf('beforeSend') !== -1;
    if (els.edStageOnRender) els.edStageOnRender.checked = stages.indexOf('onRender') !== -1;
    if (els.edStageOnReceive) els.edStageOnReceive.checked = stages.indexOf('onReceive') !== -1;

    var targets = target ? ruleTargets(target) : ['assistant'];
    if (els.edTargetUser) els.edTargetUser.checked = targets.indexOf('user') !== -1;
    if (els.edTargetAssistant) els.edTargetAssistant.checked = targets.indexOf('assistant') !== -1;

    els.editor.hidden = false;
    if (els.edName) els.edName.focus();
  }

  function closeEditor() {
    if (!els.editor) return;
    els.editor.hidden = true;
    uiState.editingId = '';
  }

  function saveEditor() {
    var name = els.edName ? els.edName.value.trim() : '';
    var pattern = els.edPattern ? els.edPattern.value : '';
    var flags = els.edFlags ? els.edFlags.value.trim() : '';
    var replacement = els.edReplacement ? els.edReplacement.value : '';

    if (!pattern) {
      toast('请填写匹配正则');
      return;
    }

    // 保存前先试编译一次，避免把语法错误的规则写进存储
    try {
      new RegExp(pattern, flags); // eslint-disable-line no-new
    } catch (err) {
      toast('正则语法有误：' + (err && err.message ? err.message : err));
      return;
    }

    var stages = [];
    if (els.edStageBeforeSend && els.edStageBeforeSend.checked) stages.push('beforeSend');
    if (els.edStageOnRender && els.edStageOnRender.checked) stages.push('onRender');
    if (els.edStageOnReceive && els.edStageOnReceive.checked) stages.push('onReceive');
    if (!stages.length) {
      toast('请至少勾选一个作用阶段');
      return;
    }

    var targets = [];
    if (els.edTargetUser && els.edTargetUser.checked) targets.push('user');
    if (els.edTargetAssistant && els.edTargetAssistant.checked) targets.push('assistant');
    if (!targets.length) {
      toast('请至少勾选一个作用对象');
      return;
    }

    if (uiState.scope === 'preset' && readScopeRules('preset').length === 0) {
      var presetHint = true;
      if (typeof bridge.getState === 'function') {
        var state = bridge.getState();
        presetHint = !(state && state.session && !state.session.presetId);
      }
      if (presetHint) {
        toast('当前对话未绑定大预设，请先在顶部 #0 选择或新建预设');
        return;
      }
    }

    var rules = clone(readScopeRules(uiState.scope));
    if (!Array.isArray(rules)) rules = [];

    var payload = {
      id: uiState.editingId || uid('rule'),
      name: name || '未命名正则',
      pattern: pattern,
      flags: flags,
      replacement: replacement,
      stages: stages,
      stage: stages[0],
      targets: targets,
      enabled: true
    };

    var found = false;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i] && rules[i].id === payload.id) {
        // 编辑时保留原有启用状态
        payload.enabled = rules[i].enabled !== false;
        rules[i] = payload;
        found = true;
        break;
      }
    }
    if (!found) rules.push(payload);

    writeScopeRules(uiState.scope, rules);
    closeEditor();
    renderAll();
    toast('正则规则已保存');
    if (typeof bridge.refreshChatUI === 'function') bridge.refreshChatUI();
  }

  /* ---------- 列表交互 ---------- */

  function findRuleById(rules, id) {
    for (var i = 0; i < rules.length; i++) {
      if (rules[i] && rules[i].id === id) return { index: i, rule: rules[i] };
    }
    return null;
  }

  async function handleListClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var btn = target.closest('[data-act]');
    if (!btn) return;
    var row = btn.closest('.regex-rule');
    if (!row) return;
    var id = row.getAttribute('data-id') || '';
    var act = btn.getAttribute('data-act');

    var rules = clone(readScopeRules(uiState.scope));
    if (!Array.isArray(rules)) rules = [];
    var found = findRuleById(rules, id);
    if (!found) return;

    if (act === 'toggle') {
      found.rule.enabled = found.rule.enabled === false;
      writeScopeRules(uiState.scope, rules);
      renderAll();
      toast(found.rule.enabled ? '规则已启用' : '规则已停用');
      if (typeof bridge.refreshChatUI === 'function') bridge.refreshChatUI();
      return;
    }

    if (act === 'edit') {
      openEditor(found.rule);
      return;
    }

    if (act === 'delete') {
      var scope = uiState.scope;
      var snapshot = JSON.stringify(rules);
      if (!await window.showAppConfirm('删除规则「' + (found.rule.name || '未命名正则') + '」？')) return;
      if (scope !== uiState.scope || JSON.stringify(readScopeRules(scope)) !== snapshot) return;
      rules.splice(found.index, 1);
      writeScopeRules(uiState.scope, rules);
      if (uiState.editingId === id) closeEditor();
      renderAll();
      toast('规则已删除');
      if (typeof bridge.refreshChatUI === 'function') bridge.refreshChatUI();
    }
  }

  function switchScope(scope) {
    if (['session', 'preset', 'global'].indexOf(scope) === -1) return;
    uiState.scope = scope;
    closeEditor();
    renderAll();
  }

  async function clearScope() {
    var list = readScopeRules(uiState.scope);
    if (!Array.isArray(list) || list.length === 0) {
      toast('本层暂无可清空的规则');
      return;
    }
    var scope = uiState.scope;
    if (!await window.showAppConfirm('清空「' + scopeLabel(scope) + '」正则？')) return;
    if (scope !== uiState.scope) return;
    writeScopeRules(uiState.scope, []);
    closeEditor();
    renderAll();
    toast('已清空' + scopeLabel(uiState.scope) + '层正则规则');
    if (typeof bridge.refreshChatUI === 'function') bridge.refreshChatUI();
  }

  /* ---------- 弹窗开关 ---------- */

  function openModal() {
    if (!els.modal) {
      toast('未找到正则管理器界面');
      return;
    }
    // 打开时清空编辑器状态，避免残留上一条规则
    closeEditor();
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
    closeEditor();
    blurInside(els.modal);
    els.modal.classList.remove('show');
    els.modal.setAttribute('aria-hidden', 'true');
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    if (els.tabs) {
      els.tabs.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var btn = target.closest('.regex-tab');
        if (!btn) return;
        switchScope(btn.getAttribute('data-scope') || 'session');
      });
    }

    if (els.list) {
      els.list.addEventListener('click', handleListClick);
    }

    if (els.addBtn) {
      els.addBtn.addEventListener('click', function () {
        openEditor(null);
      });
    }

    if (els.clearBtn) {
      els.clearBtn.addEventListener('click', clearScope);
    }

    if (els.edSave) {
      els.edSave.addEventListener('click', saveEditor);
    }

    if (els.edCancel) {
      els.edCancel.addEventListener('click', closeEditor);
    }

    if (els.close) {
      els.close.addEventListener('click', closeModal);
    }

    if (els.modal) {
      els.modal.addEventListener('click', function (event) {
        if (event.target === els.modal) closeModal();
      });
      els.modal.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeModal();
      });
    }

    if (els.toolboxBtn) {
      els.toolboxBtn.addEventListener('click', function () {
        // 工具箱面板关闭后再弹窗，避免层级遮挡
        var panel = document.getElementById('input-toolbox-panel');
        if (panel) panel.hidden = true;
        var trigger = document.getElementById('input-toolbox-btn');
        if (trigger) {
          trigger.setAttribute('aria-expanded', 'false');
          trigger.classList.remove('open');
        }
        window.setTimeout(openModal, 0);
      });
    }

    // 用户切换会话 / 云端恢复后，规则数量可能变化：点击工具箱前自动刷新一次
    var inputToolboxBtn = document.getElementById('input-toolbox-btn');
    if (inputToolboxBtn) {
      inputToolboxBtn.addEventListener('click', function () {
        renderAll();
      });
    }
  }

  function init() {
    bindEls();
    if (!els.modal) {
      console.warn('[正则引擎] 未找到 #regex-manager-modal 节点，管理器界面不可用');
    }
    bindEvents();
    updateToolboxLabel();
    // 管道与 MVU 接口已就绪，补绘启动时尚未应用正则的当前会话。
    if (typeof bridge.refreshChatUI === 'function') bridge.refreshChatUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ================= 对外最小接口 ================= */

  window.MyChatRegex = {
    // 打开管理器（供其他模块 / 外部脚本调用）
    open: openModal,
    close: closeModal,
    // 重绘（云同步恢复后调用）
    reload: renderAll,
    // 纯函数：酒馆正则转换（也挂在 window.MyChat.convertTavernRegex 上）
    convertTavernRegex: convertTavernRegex,
    // 纯函数：手动对一段文本执行指定阶段的规则（便于调试）
    applyRules: applyRules
  };
})();
