/* ===================================================================
   MyChat 酒馆导入器（modules/tavern-importer.js）
   --------------------------------------------------------------
   1. 纯前端 PNG 角色卡解析（不依赖任何第三方库）：
        tEXt（明文）/ zTXt（zlib 压缩，如「雌小鬼.png」）/ iTXt（自适应）
        优先读取 ccv3，其次 chara；也支持直接上传 .json 角色卡。
   2. 一键解包角色卡：新建对话 + 头像 + 全部设定字段 + 开场白
        + 内嵌世界书（character_book）+ 专属正则（regex_scripts）。
   3. 一键导入酒馆预设（TGbreak写作版.json 之类）：
        prompts + prompt_order + assistant_prefill + regex_scripts
        → mychat_prompt_presets（可直接使用的大预设）。

   设计约束：
     - 纯原生 ES5 + async/await，双击 index.html（file://）直接可用；
     - 只通过 window.MyChat / window.MyChatWorldbook 桥接器读写数据；
     - 任何一步失败都只提示、不清空用户已有数据。
   =================================================================== */

(function () {
  'use strict';

  var bridge = window.MyChat;
  if (!bridge || typeof bridge.registerHook !== 'function') {
    console.warn('[酒馆导入] 未检测到 window.MyChat 桥接器，模块跳过加载（请确认 app.js 已先加载）');
    return;
  }

  /* ================= 通用工具 ================= */

  function toast(text) {
    if (typeof bridge.showToast === 'function') bridge.showToast(text);
    else console.log('[酒馆导入] ' + text);
  }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function isNum(value) {
    return typeof value === 'number' && isFinite(value);
  }

  /**
   * 读取整个文件为 ArrayBuffer（FileReader 包装为 Promise）
   */
  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败'));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ''));
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败'));
      };
      reader.readAsText(file, 'utf-8');
    });
  }

  /* ================= PNG 分块解析 ================= */

  var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

  function readUint32(bytes, offset) {
    return (
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0
    );
  }

  function isPng(bytes) {
    if (!bytes || bytes.length < 8) return false;
    for (var i = 0; i < PNG_SIGNATURE.length; i++) {
      if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    }
    return true;
  }

  /**
   * Base64 → Uint8Array（自动补 padding，兼容 URL-safe 变体）
   */
  function base64ToBytes(b64) {
    var clean = String(b64 || '')
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    while (clean.length % 4 !== 0) clean += '=';
    var bin = window.atob(clean);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * 解压 zlib / deflate 数据块
   * @param {Uint8Array} bytes 压缩数据
   * @param {Boolean} raw true 表示无 zlib 头的原始 deflate
   */
  async function inflateBytes(bytes, raw) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持解压角色卡，请改用 .json 格式角色卡');
    }
    var format = raw ? 'deflate-raw' : 'deflate';
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    var buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  /**
   * 解压 zTXt / iTXt 压缩文本，失败时自动回退到 deflate-raw
   */
  async function inflateSmart(bytes) {
    var useRaw = true;
    // zlib 头约定：第一个字节低 4 位为 8（deflate），(b0<<8 | b1) % 31 === 0
    if (bytes.length >= 2) {
      var header = (bytes[0] << 8) | bytes[1];
      if ((bytes[0] & 0x0f) === 8 && header % 31 === 0) useRaw = false;
    }
    try {
      return await inflateBytes(bytes, useRaw);
    } catch (err) {
      // 头判断失误时反向再试一次，避免个别工具写出非标准头
      try {
        return await inflateBytes(bytes, !useRaw);
      } catch (err2) {
        throw new Error('角色卡数据解压失败');
      }
    }
  }

  /**
   * 从 PNG 字节流中找出 ccv3 / chara 文本块
   * @return {Promise<Object|null>} 解析出的角色卡对象
   */
  async function extractCardFromPngBuffer(buffer) {
    var bytes = new Uint8Array(buffer);
    if (!isPng(bytes)) return null;

    var decoder = new TextDecoder('utf-8');
    var latinDecoder = new TextDecoder('latin1');
    var found = { ccv3: null, chara: null };

    var pos = 8;
    while (pos + 8 <= bytes.length) {
      var length = readUint32(bytes, pos);
      if (length > bytes.length) break;
      var type = String.fromCharCode(
        bytes[pos + 4],
        bytes[pos + 5],
        bytes[pos + 6],
        bytes[pos + 7]
      );
      var dataStart = pos + 8;
      if (dataStart + length > bytes.length) break;
      var data = bytes.subarray(dataStart, dataStart + length);

      try {
        if (type === 'tEXt') {
          var tZero = data.indexOf(0);
          if (tZero > 0) {
            var tKey = latinDecoder.decode(data.subarray(0, tZero));
            if (tKey === 'ccv3' || tKey === 'chara') {
              if (!found[tKey]) found[tKey] = latinDecoder.decode(data.subarray(tZero + 1));
            }
          }
        } else if (type === 'zTXt') {
          var zZero = data.indexOf(0);
          if (zZero > 0) {
            var zKey = latinDecoder.decode(data.subarray(0, zZero));
            if (zKey === 'ccv3' || zKey === 'chara') {
              // zZero+1 是压缩方法（0 = deflate），其后为压缩数据
              var payload = data.subarray(zZero + 2);
              if (payload.length > 0 && !found[zKey]) {
                var plain = await inflateSmart(payload);
                found[zKey] = decoder.decode(plain);
              }
            }
          }
        } else if (type === 'iTXt') {
          var iZero = data.indexOf(0);
          if (iZero > 0) {
            var iKey = latinDecoder.decode(data.subarray(0, iZero));
            if (iKey === 'ccv3' || iKey === 'chara') {
              var cursor = iZero + 1;
              var compressed = data[cursor] === 1;
              cursor += 2; // 跳过压缩标记 + 压缩方法
              // languageTag\0
              var langEnd = data.indexOf(0, cursor);
              if (langEnd === -1) langEnd = cursor;
              cursor = langEnd + 1;
              // translatedKeyword\0
              var transEnd = data.indexOf(0, cursor);
              if (transEnd === -1) transEnd = cursor;
              cursor = transEnd + 1;
              var textBytes = data.subarray(cursor);
              if (!found[iKey] && textBytes.length > 0) {
                found[iKey] =
                  compressed && textBytes[0] !== undefined && compressed === true
                    ? decoder.decode(await inflateSmart(textBytes))
                    : decoder.decode(textBytes);
              }
            }
          }
        }
      } catch (err) {
        console.warn('[酒馆导入] 解析 ' + type + ' 数据块失败，已跳过：', err);
      }

      if (type === 'IEND') break;
      pos = dataStart + length + 4; // 跳过 4 字节 CRC
    }

    // 优先 ccv3（V3 规范），其次 chara（V2 兼容）
    var raw = found.ccv3 || found.chara;
    if (!raw) return null;
    try {
      var jsonBytes = base64ToBytes(raw);
      var text = decoder.decode(jsonBytes);
      var card = JSON.parse(text);
      return card && typeof card === 'object' ? card : null;
    } catch (err) {
      console.warn('[酒馆导入] 角色卡 JSON 解析失败：', err);
      return null;
    }
  }

  /* ================= 头像处理 ================= */

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error('头像解析失败'));
      };
      img.src = url;
    });
  }

  /**
   * 把 PNG 角色卡图片裁成 128x128 正方形头像（居中裁切，不拉伸变形）
   */
  async function buildAvatarFromFile(file) {
    if (!file) return '';
    var url = '';
    try {
      url = URL.createObjectURL(file);
      var img = await loadImage(url);
      if (!img.width || !img.height) return '';
      var side = Math.min(img.width, img.height);
      var sx = (img.width - side) / 2;
      var sy = (img.height - side) / 2;
      var canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      var ctx = canvas.getContext('2d');
      if (!ctx) return '';
      ctx.drawImage(img, sx, sy, side, side, 0, 0, 128, 128);
      var dataUrl = canvas.toDataURL('image/webp', 0.86);
      // 不支持 webp 的浏览器会回退成 image/png，同样可用
      return typeof dataUrl === 'string' ? dataUrl : '';
    } catch (err) {
      console.warn('[酒馆导入] 头像生成失败，将使用首字徽章：', err);
      return '';
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  /* ================= 角色卡 → 会话 ================= */

  function pickString(src, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = src[keys[i]];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  }

  /**
   * 兼容 V1 平铺结构 / V2、V3 的 { spec, data } 嵌套结构
   */
  function getCardData(card) {
    if (!card || typeof card !== 'object') return null;
    if (card.data && typeof card.data === 'object') return card.data;
    return card;
  }

  /**
   * 提取角色卡内的正则脚本数组
   */
  function getCardRegexScripts(data) {
    if (!data || typeof data !== 'object') return [];
    var ext = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
    var list = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
    if (!list.length && Array.isArray(data.regex_scripts)) list = data.regex_scripts;
    return list;
  }

  /**
   * 一键导入角色卡：始终新建对话，绝不影响用户已有会话
   * @param {Object} card 角色卡对象
   * @param {File} [file] 原始 PNG 文件（用于生成头像）
   */
  async function importCharacterCard(card, file) {
    var data = getCardData(card);
    if (!data) {
      toast('角色卡内容为空，无法导入');
      return null;
    }

    var name = pickString(data, ['name', 'char_name', 'charName']).trim();
    var description = pickString(data, ['description', 'char_persona', 'charPersona']);
    var personality = pickString(data, ['personality']);
    var scenario = pickString(data, ['scenario']);
    var mesExample = pickString(data, ['mes_example', 'example_dialogue', 'mesExample']);
    var systemPrompt = pickString(data, ['system_prompt', 'systemPrompt']);
    var postHistory = pickString(data, [
      'post_history_instructions',
      'postHistoryInstructions'
    ]);
    var firstMes = pickString(data, ['first_mes', 'firstMessage', 'char_greeting']);
    var alternate = Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.filter(function (g) {
          return typeof g === 'string' && g.trim();
        })
      : [];

    if (!name && !description && !firstMes) {
      toast('该角色卡没有可用的角色信息');
      return null;
    }

    // 1. 新建对话（switchView = true，导入后立刻可见）
    var session = null;
    if (typeof bridge.createSession === 'function') session = bridge.createSession(true);
    if (!session) {
      toast('新建对话失败，请重试');
      return null;
    }

    var charName = name || '未命名角色';
    session.title = charName;
    session.charName = charName;
    session.charDescription = description;
    session.charPersonality = personality;
    session.charScenario = scenario;
    session.charMesExample = mesExample;
    session.charSystemPrompt = systemPrompt;
    session.charPostHistory = postHistory;
    session.alternateGreetings = alternate;
    session.greetingIndex = -1;

    // 2. 头像：PNG 用离屏 Canvas 裁成 128x128；JSON 卡尝试 data.avatar
    var avatar = '';
    if (file && /\.png$/i.test(file.name || '')) {
      avatar = await buildAvatarFromFile(file);
    }
    if (!avatar) {
      var ext = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
      if (typeof data.avatar === 'string' && /^data:image\//.test(data.avatar)) avatar = data.avatar;
      else if (typeof ext.avatar === 'string' && /^data:image\//.test(ext.avatar)) {
        avatar = ext.avatar;
      }
    }
    if (avatar) session.avatar = avatar;

    // 3. #1 楼开场白：直接写入消息数组（带 isGreeting 标识，便于后续切换备选开场白）
    var greetingText = String(firstMes || '').trim();
    if (greetingText && Array.isArray(session.messages)) {
      session.messages.length = 0;
      session.messages.push({
        role: 'assistant',
        content: greetingText,
        reasoning: '',
        meta: { isGreeting: true, greetingIndex: 0 }
      });
      session.firstMessage = greetingText;
    }

    // 4. 内嵌世界书：character_book → 独立世界书并立即启用
    var wbId = '';
    var wbCount = 0;
    var book = data.character_book && typeof data.character_book === 'object'
      ? data.character_book
      : null;
    if (book && window.MyChatWorldbook && typeof window.MyChatWorldbook.importCharacterBook === 'function') {
      try {
        wbId = window.MyChatWorldbook.importCharacterBook(book, '角色书 · ' + charName) || '';
        if (wbId) {
          wbCount = book.entries
            ? Object.keys(book.entries).length
            : Array.isArray(book.entries)
              ? book.entries.length
              : 0;
          session.worldbookIds = [wbId];
        }
      } catch (err) {
        console.warn('[酒馆导入] 世界书导入失败：', err);
        wbId = '';
      }
    }

    // 5. 专属正则：extensions.regex_scripts → session.regexRules（会话层）
    var regexCount = 0;
    var scripts = getCardRegexScripts(data);
    if (scripts.length && typeof bridge.convertTavernRegex === 'function') {
      var rules = [];
      scripts.forEach(function (script) {
        try {
          var rule = bridge.convertTavernRegex(script);
          if (rule && rule.pattern) rules.push(rule);
        } catch (err) {
          console.warn('[酒馆导入] 单条正则转换失败，已跳过：', err);
        }
      });
      if (rules.length) {
        session.regexRules = rules;
        regexCount = rules.length;
      }
    }

    // 6. 落盘并刷新界面
    session.updatedAt = Date.now();
    if (typeof bridge.saveSession === 'function' && bridge.saveSession(session) === false) {
      throw new Error('存储保存失败');
    }
    if (typeof bridge.selectSession === 'function') bridge.selectSession(session.id);
    if (window.MyChatRegex && typeof window.MyChatRegex.reload === 'function') {
      window.MyChatRegex.reload();
    }
    if (window.MyChatWorldbook && typeof window.MyChatWorldbook.reload === 'function') {
      window.MyChatWorldbook.reload();
    }

    var extras = [];
    if (greetingText) extras.push('开场白');
    if (wbCount) extras.push(wbCount + ' 条世界书');
    if (regexCount) extras.push(regexCount + ' 条专属正则');
    toast(
      '✓ 已导入角色「' +
        charName +
        '」' +
        (extras.length ? '（含' + extras.join('、') + '）' : '')
    );
    return session;
  }

  /* ================= 酒馆预设 → MyChat 预设 ================= */

  /**
   * 选出条目最多的 prompt_order 分组（酒馆里常有多套角色分组，取最完整的一套）
   */
  function pickBestOrder(promptOrder) {
    var groups = [];
    if (Array.isArray(promptOrder)) {
      groups = promptOrder;
    } else if (promptOrder && typeof promptOrder === 'object') {
      Object.keys(promptOrder).forEach(function (key) {
        groups.push(promptOrder[key]);
      });
    }
    var best = null;
    groups.forEach(function (group) {
      if (!group || !Array.isArray(group.order)) return;
      if (!best || group.order.length > best.order.length) best = group;
    });
    return best && best.order ? best.order : [];
  }

  /**
   * 构建 identifier → prompt 映射（同一 identifier 只取第一条）
   */
  function buildPromptMap(prompts) {
    var map = {};
    if (!Array.isArray(prompts)) return map;
    prompts.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var id = typeof item.identifier === 'string' ? item.identifier : '';
      if (!id || map[id]) return;
      map[id] = item;
    });
    return map;
  }

  /**
   * 判定单个 prompt 的落位方式
   * system     —— 合并进 #0 系统提示词
   * prefill    —— 作为最后一条 assistant 预输入
   * post_history —— 插在最新用户消息正上方（越狱 / 后置指令）
   */
  function resolveRoleType(prompt, identifier, orderIndex, chatHistoryIndex) {
    var role = prompt && prompt.role === 'assistant' ? 'assistant' : 'system';
    var lowerId = String(identifier || '').toLowerCase();
    var name = typeof prompt.name === 'string' ? prompt.name : '';

    if (role === 'assistant') return 'prefill';
    if (lowerId.indexOf('enhancedefinitions') !== -1) return 'prefill';
    if (name && name.indexOf('Assistant Prefill') !== -1) return 'prefill';
    if (lowerId === 'jailbreak') return 'post_history';
    if (chatHistoryIndex >= 0 && orderIndex > chatHistoryIndex) return 'post_history';
    return 'system';
  }

  /**
   * 导入酒馆预设 JSON
   * @param {Object} data 预设 JSON 对象
   * @param {String} [fallbackName] 缺名字时的兜底名（一般取文件名）
   */
  function importTavernPreset(data, fallbackName) {
    if (!data || typeof data !== 'object') {
      toast('预设文件内容为空');
      return null;
    }

    var prompts = Array.isArray(data.prompts) ? data.prompts : [];
    var order = pickBestOrder(data.prompt_order);

    // prompt_order 缺失时，退化为按 prompts 原始顺序处理
    if (!order.length) {
      order = prompts.map(function (item) {
        return { identifier: item && item.identifier, enabled: true };
      });
    }
    if (!order.length) {
      toast('该文件不含 prompts，可能不是酒馆预设');
      return null;
    }

    var promptMap = buildPromptMap(prompts);

    var chatHistoryIndex = -1;
    for (var ci = 0; ci < order.length; ci++) {
      if (order[ci] && order[ci].identifier === 'chatHistory') {
        chatHistoryIndex = ci;
        break;
      }
    }

    var modules = [];
    var seen = {};
    order.forEach(function (item, index) {
      if (!item || typeof item !== 'object') return;
      var identifier = typeof item.identifier === 'string' ? item.identifier : '';
      var prompt = promptMap[identifier];
      if (!prompt) return;
      // 酒馆的 marker（占位行，如 chatHistory / worldInfoBefore）没有正文
      if (prompt.marker === true) return;

      var content = typeof prompt.content === 'string' ? prompt.content : '';
      var roleType = resolveRoleType(prompt, identifier, index, chatHistoryIndex);
      if (!content.trim() && roleType !== 'prefill') return;
      if (!content.trim()) return;

      var name =
        (typeof prompt.name === 'string' && prompt.name.trim()) || identifier || '未命名模块';
      // 同名同内容只入一次，避免 prompt_order 重复项导致重复注入
      var dedupeKey = name + '|' + content.length;
      if (seen[dedupeKey]) return;
      seen[dedupeKey] = true;

      modules.push({
        id: uid('mod'),
        name: name,
        content: content,
        enabled: item.enabled !== false,
        roleType: roleType,
        keepPrefillInReply: false
      });
    });

    // 顶层 assistant_prefill：SD 有时把它单独放在预设根节点
    var prefillText = typeof data.assistant_prefill === 'string' ? data.assistant_prefill : '';
    if (prefillText.trim()) {
      var hasPrefill = modules.some(function (mod) {
        return mod.roleType === 'prefill' && mod.content.trim() === prefillText.trim();
      });
      if (!hasPrefill) {
        modules.push({
          id: uid('mod'),
          name: 'Assistant Prefill (预输入)',
          content: prefillText,
          enabled: true,
          roleType: 'prefill',
          keepPrefillInReply: false
        });
      }
    }

    if (!modules.length) {
      toast('该预设没有可用的小模块（内容均为空）');
      return null;
    }

    // 预设专属正则
    var regexRules = [];
    var scripts = [];
    var ext = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
    if (Array.isArray(ext.regex_scripts)) scripts = ext.regex_scripts;
    else if (Array.isArray(data.regex_scripts)) scripts = data.regex_scripts;
    if (scripts.length && typeof bridge.convertTavernRegex === 'function') {
      scripts.forEach(function (script) {
        try {
          var rule = bridge.convertTavernRegex(script);
          if (rule && rule.pattern) regexRules.push(rule);
        } catch (err) {
          console.warn('[酒馆导入] 预设正则转换失败，已跳过：', err);
        }
      });
    }

    var presetName =
      (typeof data.name === 'string' && data.name.trim()) ||
      (typeof fallbackName === 'string' && fallbackName.trim()) ||
      '导入的酒馆预设';
    // 去掉 .json 后缀，避免列表里出现文件名尾巴
    presetName = presetName.replace(/\.json$/i, '');

    var presetList = typeof bridge.getPromptPresets === 'function' ? bridge.getPromptPresets() : [];
    if (!Array.isArray(presetList)) presetList = [];

    var preset = {
      id: uid('preset'),
      name: presetName,
      modules: modules,
      regexRules: regexRules
    };
    presetList.push(preset);
    if (typeof bridge.savePromptPresets === 'function' && bridge.savePromptPresets(presetList) === false) {
      throw new Error('存储保存失败');
    }
    if (typeof bridge.setCurrentPreset === 'function') bridge.setCurrentPreset(preset.id);
    if (window.MyChatRegex && typeof window.MyChatRegex.reload === 'function') {
      window.MyChatRegex.reload();
    }

    toast(
      '✓ 已导入酒馆预设「' +
        presetName +
        '」（含 ' +
        modules.length +
        ' 个模块' +
        (regexRules.length ? '、' + regexRules.length + ' 条预设正则' : '') +
        ')'
    );
    return preset;
  }

  /* ================= 基础 XML 拆分与零 AI 中文转换 ================= */

  var tagNames = Object.create(null);
  [
    ['role', '角色定位'], ['profile', '基础档案'], ['background', '背景设定'], ['skills', '核心技能'],
    ['rules', '核心规则'], ['workflow', '工作流程'], ['output_format', '输出格式'], ['initialization', '开场白与初始化'],
    ['constraints', '约束与限制'], ['guidelines', '行动指南'], ['objective goals mission', '核心目标'],
    ['context', '上下文背景'], ['persona character', '人设详情'], ['style tone voice', '语言风格'],
    ['examples few_shot', '参考示例'], ['knowledge lore worldview', '知识库与世界观'], ['memory', '记忆机制'],
    ['task instructions system_prompt', '任务指令'], ['thinking reasoning cot', '思考与推演'],
    ['safety boundaries', '安全与边界'], ['tools functions', '工具调用'], ['input user_input', '输入规范'],
    ['output', '输出要求'], ['attention note warning important', '重要注意事项'], ['fallback error_handling', '异常处理'],
    ['criteria evaluation', '评估标准'], ['steps process', '执行步骤'], ['summary', '总结要求'], ['format', '格式规范']
  ].forEach(function (pair) { pair[0].split(' ').forEach(function (key) { tagNames[key] = pair[1]; }); });

  var roots = Object.create(null);
  ('user:用户 ai:人工智能 assistant:助手 system:系统 core:核心 basic:基础 advanced:高级 detail:详细 strict:严格 hard:硬性 soft:弹性 custom:自定义 global:全局 local:局部 chat:对话 reply:回复 response:响应 message:消息 history:历史 current:当前 state:状态 status:状态 setting:设置 config:配置 logic:逻辑 action:动作 behavior:行为 emotion:情绪 relationship:关系 scene:场景 plot:剧情 writing:写作 review:审查 audit:审计 risk:风险 control:控制 financial:金融 asset:资产 data:数据 analysis:分析 template:模板 structure:结构 list:列表 table:表格 запрет:禁止 ban:禁止 forbid:禁止 prohibit:禁止 must:必须 role:角色 profile:档案 background:背景 skill:技能 rule:规则 work:工作 flow:流程 workflow:工作流程 output:输出 input:输入 format:格式 initialization:初始化 constraint:约束 guideline:指南 objective:目标 goal:目标 mission:使命 context:上下文 persona:人设 character:角色 style:风格 tone:语气 voice:口吻 example:示例 few:少量 shot:示例 knowledge:知识 lore:设定 worldview:世界观 memory:记忆 task:任务 instruction:指令 prompt:提示词 thinking:思考 reasoning:推演 cot:思维链 safety:安全 boundary:边界 tool:工具 function:函数 attention:注意 note:备注 warning:警告 important:重要 fallback:兜底 error:异常 handling:处理 criteria:标准 evaluation:评估 step:步骤 process:流程 summary:总结 language:语言 author:作者 version:版本 description:描述 name:名称 gender:性别 age:年龄 personality:性格 model:模型 text:文本 content:内容 section:章节 module:模块 priority:优先级 order:顺序 first:首要 last:最后 before:之前 after:之后 main:主要 secondary:次要 special:特殊 general:通用 default:默认 optional:可选 required:必需 positive:正向 negative:负向 allow:允许 deny:拒绝 limit:限制 length:长度 time:时间 date:日期 number:数量 value:数值 key:键 information:信息 fact:事实 truth:真实 accuracy:准确 quality:质量 check:检查 validation:校验 security:安全 privacy:隐私 identity:身份 purpose:目的 target:目标 result:结果 answer:回答 question:问题 request:请求 instruction:指令 execution:执行 plan:计划 strategy:策略 policy:策略 principle:原则 standard:标准 mode:模式 detail:详细 introduction:介绍 opening:开场 ending:结尾 start:开始 end:结束 professional:专业 personal:个人 finance:财务 investment:投资 wealth:财富 budget:预算 income:收入 expense:支出 family:家庭 defense:防御 management:管理 manager:管理器 engine:引擎 mechanism:机制 description:描述 definition:定义 interaction:交互 dialogue:对话 narration:叙事 story:故事 world:世界 environment:环境 emotional:情绪 internal:内部 external:外部 hidden:隐藏 visible:可见 final:最终 initial:初始 dynamic:动态 static:静态 creative:创意 creativity:创造力 reasoning:推演 reasoning:推演').split(' ').forEach(function (pair) {
    var parts = pair.split(':'); roots[parts[0]] = parts[1];
  });

  function splitTagWords(tag) {
    return tag.trim().replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase().split(/[_\-\s]+/).filter(Boolean);
  }

  // 提示词不是严格 XML：只找独占一行的同名配对，正文标签一律不校验。
  function parseTopLevelXmlBlocks(rawText) {
    var text = String(rawText || '').replace(/\r\n/g, '\n');
    var blocks = [], consumed = 0, match;
    function loose(end) {
      var content = text.slice(consumed, end);
      if (content.trim()) blocks.push({ tag: '', name: blocks.length ? '补充说明' : '前置说明', content: content });
    }
    // 保留既有中文开场标签兼容；只允许行内空格，不跨行吞掉正文。
    var starts = /^[ \t]*<([a-zA-Z0-9_\u3400-\u9fff-]+)>[ \t]*$/gm;
    while ((match = starts.exec(text))) {
      var closing = new RegExp('^[ \\t]*</' + match[1] + '>[ \\t]*$', 'gm');
      closing.lastIndex = starts.lastIndex;
      var end = closing.exec(text);
      if (!end) continue;
      loose(match.index);
      var bodyStart = starts.lastIndex;
      if (text.charAt(bodyStart) === '\n') bodyStart++;
      blocks.push({ tag: match[1], xmlTag: match[1].toLowerCase(), content: text.slice(bodyStart, end.index) });
      consumed = closing.lastIndex;
      starts.lastIndex = consumed;
    }
    if (blocks.some(function (block) { return block.tag; })) {
      loose(text.length);
      return blocks;
    }
    // 只有未发现任何整行块时才回退紧凑格式；不使用全局标签栈。
    var compact = /<([a-zA-Z0-9_\u3400-\u9fff-]+)>([\s\S]*?)<\/\1>/g;
    while ((match = compact.exec(text))) {
      loose(match.index);
      blocks.push({ tag: match[1], xmlTag: match[1].toLowerCase(), content: match[2] });
      consumed = compact.lastIndex;
    }
    loose(text.length);
    if (!blocks.length) blocks.push({ tag: '', name: '前置说明', content: text });
    return blocks;
  }

  function chineseTitle(content) {
    var first = content.trim().split(/\r?\n/, 1)[0].trim();
    var title = first.replace(/^#{1,6}\s*/, '').replace(/^【([^】]+)】$/, '$1').trim();
    return /^[\u3400-\u9fff]{1,15}$/.test(title) ? title : '';
  }

  async function translateTag(tag) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer;
    try {
      // 仅传标签名，不外发正文、预设名称或凭据；超时与断网静默降级。
      var timeout = new Promise(function (resolve) { timer = setTimeout(function () { if (controller) controller.abort(); resolve(''); }, 1500); });
      var request = fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(splitTagWords(tag).join(' ')), {
        signal: controller ? controller.signal : undefined, credentials: 'omit', referrerPolicy: 'no-referrer'
      }).then(function (res) { return res.ok ? res.json() : null; }).then(function (data) {
        var value = data && Array.isArray(data[0]) ? data[0].map(function (part) { return part[0] || ''; }).join('').trim() : '';
        return value.length <= 40 && /[\u3400-\u9fff]/.test(value) && !/[a-zA-Z]/.test(value) ? value : '';
      }).catch(function () { return ''; });
      return await Promise.race([request, timeout]);
    } catch (err) { return ''; } finally { clearTimeout(timer); }
  }

  async function chineseModuleName(block, index, cache) {
    if (!block.tag) return block.name;
    var key = block.tag.trim().toLowerCase();
    if (tagNames[key]) return tagNames[key];
    var words = splitTagWords(block.tag);
    var translated = words.map(function (word) { return roots[word] || roots[word.replace(/s$/, '')] || (/^\d+$/.test(word) ? word : ''); });
    if (translated.every(Boolean)) return translated.join('');
    var title = chineseTitle(block.content);
    if (title) return title;
    if (!cache[key]) cache[key] = translateTag(block.tag);
    return await cache[key] || '自定义模块' + (index + 1);
  }

  function translateMetadata(content) {
    var names = { author: '作者', version: '版本', language: '语言', description: '核心描述', name: '名称', gender: '性别', age: '年龄', personality: '性格特征' };
    return content.replace(/^([\t ]*[-*+][\t ]+)(Author|Version|Language|Description|Name|Gender|Age|Personality)[\t ]*[:：][\t ]*/gim,
      function (_, prefix, key) { return prefix + names[key.toLowerCase()] + '：'; });
  }

  var openingTags = ['initialization', 'init', 'greeting', 'greetings', 'first_mes', 'first_message', 'opening', 'welcome', '开场白', '初始化'];

  function normalizeOpeningGreeting(rawInitText, roleTitle) {
    // 元指令整句删除；真正的推演正文也不作为开场台词展示。
    var text = String(rawInitText || '').replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking\s*>/gi, '')
      .replace(/[^。！？\n]*(?:隐藏|不要显示|不(?:要)?输出|不展示)[^。！？\n]*(?:thinking|思考过程|思考标签)[^。！？\n]*[。！？]?/gi, '')
      .replace(/[^。！？\n]*(?:thinking)[^。！？\n]*(?:隐藏|不显示|不输出)[^。！？\n]*[。！？]?/gi, '').trim();
    var director = /(?:在)?(?:第一次与用户打招呼时|初次对话时|首次对话时)|请用[^。！？\n]*口吻向用户问好|简要说明你的工作原则|随后邀请用户|询问用户|请向用户问好/.test(text);
    if (!director) return text;
    var principle = text.match(/(?:简要说明你的工作原则|工作原则)\s*(?:是|为)?\s*(?:——|—|[:：])?\s*(?:[“"]([^”"]+)[”"]|\*\*([\s\S]+?)\*\*|([^。！？\n]+))/);
    var quoted = text.match(/[“"]([^”"]+)[”"]|\*\*([\s\S]+?)\*\*/);
    var core = principle ? (principle[1] || principle[2] || principle[3]) : quoted ? (quoted[1] || quoted[2]) : '';
    core = String(core || '').replace(/[，,；;。]+$/, '').trim();
    var invitation = text.match(/(?:随后|然后|最后)?\s*(?:邀请用户|询问用户)\s*([\s\S]*)$/);
    var lead = '';
    if (invitation) {
      lead = invitation[1].replace(/用户/g, '你').replace(/^[：:，,\s]+/, '').trim();
      lead = lead.replace(/^(?:请|可以|你可以)\s*/, '');
      if (/^(?:直接)?(?:发来|提供|发送|告诉|描述|提出|分享)/.test(lead)) lead = '现在，你可以' + lead;
      else if (lead) lead = '现在，' + lead;
    }
    if (!core && !lead) {
      lead = text.replace(/(?:在)?(?:第一次与用户打招呼时|初次对话时|首次对话时)[，,：:\s]*/g, '')
        .replace(/请用[^。！？\n]*?口吻向用户问好[，,。\s]*/g, '').replace(/请向用户问好[，,。\s]*/g, '')
        .replace(/用户/g, '你').trim();
    }
    return ['你好！我是你的' + (String(roleTitle || '').trim() || '专属助手') + '。', core ? '我的核心工作原则是：' + core + '。' : '', lead].filter(Boolean).join('\n\n');
  }

  async function importXmlPreset(rawText, name) {
    var blocks = parseTopLevelXmlBlocks(rawText), cache = Object.create(null);
    var role = blocks.find(function (block) { return block.tag.toLowerCase() === 'role'; });
    var roleTitle = role ? role.content.trim().split(/\r?\n/, 1)[0].trim() : '';
    var presetName = String(name || '').trim() || roleTitle || 'XML导入预设';
    var rawInitText = blocks.filter(function (block) { return openingTags.indexOf(block.tag.toLowerCase()) !== -1; })
      .map(function (block) { return block.content; }).join('\n\n');
    blocks = blocks.filter(function (block) { return openingTags.indexOf(block.tag.toLowerCase()) === -1; });
    var firstMessage = normalizeOpeningGreeting(rawInitText, roleTitle);
    var modules = await Promise.all(blocks.map(async function (block, index) {
      var module = { id: uid('mod'), name: await chineseModuleName(block, index, cache), content: translateMetadata(block.content), enabled: true, roleType: 'system', keepPrefillInReply: false };
      if (block.xmlTag) module.xmlTag = block.xmlTag;
      return module;
    }));
    // 翻译期间用户可能改库；在提交前重新取副本，不覆盖其改动。
    if (!bridge.getCurrentSession || !bridge.getCurrentSession()) throw new Error('请先新建对话');
    var preset = { id: uid('preset'), name: presetName, modules: modules, regexRules: [] };
    if (firstMessage) preset.firstMessage = firstMessage;
    var list = bridge.getPromptPresets(); list.push(preset);
    if (!bridge.applyPresetWorkbenchChanges(list)) throw new Error('预设保存失败');
    if (!bridge.setCurrentPreset(preset.id)) throw new Error('预设激活失败');
    document.dispatchEvent(new CustomEvent('mychat-preset-imported', { detail: { presetId: preset.id } }));
    toast('已成功拆分为 ' + modules.length + ' 个中文模块并激活预设「' + presetName + '」');
    return preset;
  }

  /* ================= 文件选择交互 ================= */

  function pickFile(accept) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', function () {
        var file = input.files && input.files[0] ? input.files[0] : null;
        if (document.body.contains(input)) document.body.removeChild(input);
        resolve(file);
      });
      input.click();
    });
  }

  /**
   * 角色卡导入流程：PNG（tEXt / zTXt / iTXt）与 JSON 双通道
   */
  async function importCharcardFlow() {
    var file = await pickFile('.png,.json,image/png,application/json');
    if (!file) return;
    var isJson = /\.json$/i.test(file.name || '') || /json/i.test(file.type || '');

    try {
      if (isJson) {
        var text = await readAsText(file);
        var json = null;
        try {
          json = JSON.parse(text);
        } catch (err) {
          toast('JSON 格式有误，无法解析角色卡');
          return;
        }
        await importCharacterCard(json, null);
        return;
      }

      var buffer = await readAsArrayBuffer(file);
      var card = await extractCardFromPngBuffer(buffer);
      if (!card) {
        toast('未在该 PNG 中找到角色卡数据（tEXt / zTXt / iTXt），请改用 JSON 角色卡');
        return;
      }
      await importCharacterCard(card, file);
    } catch (err) {
      console.error('[酒馆导入] 角色卡导入失败：', err);
      toast('导入角色卡失败：' + (err && err.message ? err.message : err));
    }
  }

  /**
   * 酒馆预设导入流程
   */
  async function importPresetFlow() {
    var file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      var text = await readAsText(file);
      var json = null;
      try {
        json = JSON.parse(text);
      } catch (err) {
        toast('JSON 格式有误，无法解析预设');
        return;
      }
      window.MyChatTavern.importPreset(json, file.name || '');
    } catch (err) {
      console.error('[酒馆导入] 预设导入失败：', err);
      toast('导入预设失败：' + (err && err.message ? err.message : err));
    }
  }

  /* ================= 接管按钮（捕获阶段优先，屏蔽 app.js 的旧逻辑） ================= */

  function bindButtons() {
    // 角色卡：app.js 自带的 importCharcardFlow 不支持 zTXt 压缩块，
    // 这里在 document 捕获阶段拦截，阻止事件继续冒泡到按钮自身的监听器
    document.addEventListener(
      'click',
      function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var btn = target.closest('#btn-import-charcard');
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        // 顺带收起移动端侧边栏，避免弹窗被遮挡
        var sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.remove('open');
        importCharcardFlow();
      },
      true
    );

    // 预设导入按钮（#0 面板工具栏）
    var presetImportBtn = document.getElementById('tp-import-btn');
    if (presetImportBtn) {
      presetImportBtn.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        var chooser = document.getElementById('preset-import-choice');
        if (chooser && !chooser.open) chooser.showModal();
      });
    }
    var chooser = document.getElementById('preset-import-choice');
    var xmlDialog = document.getElementById('xml-preset-dialog');
    if (!chooser || !xmlDialog) return;
    var text = document.getElementById('xml-preset-content');
    var name = document.getElementById('xml-preset-name');
    var submit = document.getElementById('xml-preset-submit');
    var read = document.getElementById('xml-preset-read');
    var busy = false;
    document.getElementById('preset-import-json').onclick = function () { chooser.close(); importPresetFlow(); };
    document.getElementById('preset-import-xml').onclick = function () { chooser.close(); xmlDialog.showModal(); name.focus(); };
    document.querySelectorAll('[data-preset-import-close]').forEach(function (button) {
      button.onclick = function () { if (!busy) button.closest('dialog').close(); };
    });
    xmlDialog.addEventListener('cancel', function (event) { if (busy) event.preventDefault(); });
    read.onclick = async function () {
      var file = await pickFile('.txt,.xml,.md,text/plain,text/xml,application/xml,text/markdown');
      if (!file) return;
      try { text.value = await readAsText(file); } catch (err) { toast('读取文件失败'); }
    };
    submit.onclick = async function () {
      if (busy) return;
      busy = true; submit.disabled = read.disabled = name.disabled = text.disabled = true;
      xmlDialog.setAttribute('aria-busy', 'true');
      try { await importXmlPreset(text.value, name.value); xmlDialog.close(); text.value = name.value = ''; }
      catch (err) { toast(err.message || 'XML 导入失败'); }
      finally { busy = false; submit.disabled = read.disabled = name.disabled = text.disabled = false; xmlDialog.removeAttribute('aria-busy'); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindButtons);
  } else {
    bindButtons();
  }

  /* ================= 对外接口 ================= */

  window.MyChatTavern = {
    // 直接把已解析的对象交给导入器（便于控制台调试 / 其他模块复用）
    importCharacterCard: importCharacterCard,
    importPreset: importTavernPreset,
    parseTopLevelXmlBlocks: parseTopLevelXmlBlocks,
    normalizeOpeningGreeting: normalizeOpeningGreeting,
    importXmlPreset: importXmlPreset,
    // 单独解析 PNG 角色卡（返回角色卡对象，不写入任何数据）
    parsePngCard: async function (file) {
      var buffer = await readAsArrayBuffer(file);
      return extractCardFromPngBuffer(buffer);
    }
  };
})();
