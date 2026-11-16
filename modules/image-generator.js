/* 双引擎生图：仅通过宿主桥接访问渠道、会话与持久化。 */
(function () {
  'use strict';
  var bridge = window.MyChat;
  if (!bridge) return;
  var DIRECTOR = '【视觉演出插画指令】当且仅当剧情出现重要场景转换、关键人物特写或高潮动作演出时，请在回复正文的对应段落后换行输出一个插画标签：<draw>详细的画面视觉描述（包含人物外貌衣着、动作神态、环境光影与镜头角度）</draw>。日常平淡对话无需输出该标签，每条回复最多输出 1 个 <draw> 标签。';
  var SUMMARIZER = '你是一名专业的视觉小说分镜画师。请根据提供的最近对话剧情上下文，提炼出当前最核心的一个画面镜头描述，直接用于输入给 AI 绘画模型。要求：1. 明确交代人物的动作、神态、衣着细节、所处环境背景、光影氛围与镜头角度；2. 若提供了【登场角色外貌设定】，必须将其外貌特征自然融入画面描述中；3. 只输出纯中文画面描述正文（约 80~150 字），严禁输出任何解释、前缀、引号或 <draw> 标签。';
  var STYLES = [
    {id:'pm_dark', name:'废墟暗黑厚涂 (月亮计划风)', prompt:'月亮计划（Project Moon）与《废墟图书馆》官方美术风格，暗黑都市奇幻，粗犷富有表现力的厚涂笔触，强烈的高对比度戏剧性光影，低饱和冷暗色调搭配鲜明暗红点缀，压抑冷峻的史诗氛围，大师级插画'},
    {id:'anime_cg', name:'日系精致视觉小说 CG', prompt:'高品质日系视觉小说 CG 插画，新海诚式通透光影，细腻的人物五官与发丝刻画，丰富的背景细节，色彩饱满和谐，电影级景深构图'},
    {id:'cinematic', name:'电影感写实概念画', prompt:'电影级写实概念艺术，虚幻引擎5渲染质感，戏剧性体积光与丁达尔效应，逼真的材质纹理，宏大叙事构图，8K超高清细节'},
    {id:'watercolor', name:'复古手绘水彩绘本', prompt:'复古手绘水彩与钢笔淡彩风格，温暖柔和的纸张肌理，自然晕染的边缘，细腻怀旧的故事绘本质感'},
    {id:'none', name:'无附加画风', prompt:''}
  ];
  var LEGACY_STYLES = {
    pm_dark:'Project Moon style, Library of Ruina official art style, dark urban fantasy, rough expressive brushstrokes, high contrast lighting, muted colors with vivid crimson accents, masterpiece',
    anime_cg:'anime key visual style, Makoto Shinkai lighting, detailed background, vibrant colors, cinematic composition, high quality illustration',
    cinematic:'cinematic concept art, Unreal Engine 5 render, dramatic volumetric lighting, photorealistic textures, 8k resolution'
  };
  function defaultStyles() { return STYLES.map(function (p) { return Object.assign({}, p); }); }
  var SIZES = [['1024x1024','1:1'], ['1024x576','16:9'], ['768x1024','3:4']];
  var paths = {
    image:'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M14 8h2',
    settings:'M4 7h16M4 17h16M9 4v6m6 4v6', close:'m6 6 12 12M6 18 18 6',
    edit:'m15 5 4 4M4 20l4-1L20 7l-4-4L4 15z',
    refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1',
    ratio:'M3 6h18v12H3zM8 6v12', download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    remove:'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6',
    add:'M12 5v14M5 12h14', check:'m5 12 4 4L19 6'
  };
  function svg(name) { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + paths[name] + '"/></svg>'; }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return String.fromCharCode(38) + '#' + c.charCodeAt(0) + ';'; }); }
  function safeSource(value) { return typeof value === 'string' && /^(https?:\/\/|data:image\/(?:png|jpeg|webp|gif|avif);base64,)/i.test(value) ? value : ''; }
  function uid() { return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2); }
  function normalize(raw) {
    var c = raw && typeof raw === 'object' ? raw : {}, active = bridge.getActiveTarget(), providers = bridge.getProviders();
    return {
      mode:['off','direct','companion'].includes(c.mode) ? c.mode : 'off',
      providerId:typeof c.providerId === 'string' && c.providerId ? c.providerId : active.providerId || (providers[0] && providers[0].id) || '',
      model:typeof c.model === 'string' ? c.model : '',
      endpointType:c.endpointType === 'chat_completions' ? 'chat_completions' : 'images_generations',
      size:SIZES.some(function (x) { return x[0] === c.size; }) ? c.size : '1024x576',
      summarizerEnabled:c.summarizerEnabled !== false,
      summarizerUseMainModel:c.summarizerUseMainModel !== false,
      summarizerProviderId:typeof c.summarizerProviderId === 'string' ? c.summarizerProviderId : '',
      summarizerModel:typeof c.summarizerModel === 'string' ? c.summarizerModel : '',
      summarizerContextCount:Math.max(1, Math.min(30, Math.floor(Number(c.summarizerContextCount) || 4))),
      summarizerPrompt:typeof c.summarizerPrompt === 'string' ? c.summarizerPrompt : SUMMARIZER,
      activeStyleId:typeof c.activeStyleId === 'string' ? c.activeStyleId : 'pm_dark',
      stylePresets:Array.isArray(c.stylePresets) ? c.stylePresets.filter(function (p) { return p && typeof p.id === 'string'; }).map(function (p) {
        var original = STYLES.find(function (s) { return s.id === p.id; });
        return original && LEGACY_STYLES[p.id] === p.prompt ? Object.assign({}, original) : {id:p.id, name:String(p.name || '未命名'), prompt:String(p.prompt || '')};
      }) : defaultStyles(),
      characterList:Array.isArray(c.characterList) ? c.characterList.filter(function (p) { return p && typeof p === 'object'; }).map(function (p) {
        return {id:String(p.id || uid()), enabled:p.enabled === true, keywords:String(p.keywords || ''), appearance:String(p.appearance || '')};
      }) : typeof c.charAppearanceText === 'string' && c.charAppearanceText.trim() ? c.charAppearanceText.split(/\r?\n/).filter(function (line) { return line.trim(); }).map(function (line) {
        var match = line.match(/^\s*([^:：]+)[:：]\s*([\s\S]*)$/);
        return {id:'legacy_' + uid(), enabled:true, keywords:match ? match[1].trim() : line.trim(), appearance:match ? match[2].trim() : line.trim()};
      }) : [{id:'demo_1', enabled:false, keywords:'罗兰, Roland', appearance:'黑色短碎发，眼神疲惫，身穿笔挺的黑色西装外套、白衬衫与黑领带，戴着黑色手套，干练的收尾人打扮'}],
      directorPrompt:typeof c.directorPrompt === 'string' ? c.directorPrompt : DIRECTOR
    };
  }
  function loadConfig() {
    var raw = bridge.getImageGenConfig(), value = normalize(raw);
    // 仅迁移已有配置；静默落盘不抢占首次云同步基线。
    if (raw && JSON.stringify(raw) !== JSON.stringify(value)) {
      try { bridge.saveImageGenConfig(value,{silent:true}); } catch (err) { bridge.showToast('配置迁移保存失败'); }
    }
    return value;
  }
  var config = loadConfig();
  var jobs = new WeakMap(), directLocks = new WeakSet(), capsule, modeButton;
  function persist() { try { bridge.saveImageGenConfig(config); paint(); } catch (err) { bridge.showToast('配置保存失败'); throw err; } }
  function paint() {
    if (!modeButton) return;
    modeButton.innerHTML = svg('image') + '<span>' + ({off:'生图关闭',companion:'伴生插画',direct:'直接生图'}[config.mode]) + '</span>';
    modeButton.title = {off:'生图关闭',companion:'伴生插画',direct:'直接生图'}[config.mode];
    modeButton.setAttribute('aria-label', modeButton.title);
    modeButton.setAttribute('aria-pressed', String(config.mode !== 'off'));
    capsule.classList.toggle('active', config.mode !== 'off');
  }
  function capture(session, msg, index) {
    var owner = (session.subChats || []).find(function (sub) { return Array.isArray(sub.messages) && sub.messages.includes(msg); });
    var messages = owner ? owner.messages : session.messages;
    return {session:session, msg:msg, messages:messages, owner:owner || session, index:index};
  }
  function valid(ctx) {
    return bridge.getSessionById(ctx.session.id) === ctx.session && ctx.owner.messages === ctx.messages && ctx.messages.includes(ctx.msg) &&
      (ctx.owner === ctx.session || (ctx.session.subChats || []).includes(ctx.owner));
  }
  function refresh(ctx, save) {
    if (!valid(ctx)) return;
    if (save && !bridge.saveSession(ctx.session, {background:true})) throw new Error('图片保存失败');
    bridge.refreshMessage(ctx.session, ctx.msg);
  }
  function states(msg) { var list = jobs.get(msg); if (!list) { list = []; jobs.set(msg, list); } return list; }
  function drawTags(text) {
    var out = [], re = /<draw>([\s\S]*?)<\/draw>/gi, match;
    while ((match = re.exec(String(text || '')))) out.push({prompt:match[1].trim(), full:match[0], index:out.length});
    return out;
  }
  function imageForTag(msg, index) { return (msg.generatedImages || []).find(function (image) { return image.id.indexOf('draw_' + index + '_') === 0; }); }
  function recentContext(messages, index, c) {
    var end = Math.min(messages.length, Math.max(0, index + 1));
    return messages.slice(Math.max(0, end - c.summarizerContextCount), end).map(function (m) {
      return (m.role === 'user' ? '用户：' : '助手：') + String(m.content || '');
    }).join('\n\n');
  }
  function matchedCharacters(text, c) {
    return c.characterList.filter(function (p) {
      return p.enabled && p.appearance.trim() && p.keywords.split(/[,、，]/).some(function (word) { return word.trim() && text.includes(word.trim()); });
    }).map(function (p) { return p.keywords.split(/[,、，]/).map(function (s) { return s.trim(); }).filter(Boolean)[0] + '（外貌设定：' + p.appearance + '）'; });
  }
  function buildFinalImagePrompt(rawPrompt, options) {
    var opts = options || {}, c = normalize(opts.config || config);
    var session = opts.session || bridge.getCurrentSession(), messages = opts.messages || session && session.messages || [];
    var index = Number.isInteger(opts.index) ? opts.index : messages.length - 1;
    var context = String(rawPrompt || '') + '\n' + recentContext(messages, index, c);
    var appearance = matchedCharacters(context, c);
    var style = c.stylePresets.find(function (p) { return p.id === c.activeStyleId; });
    return [style && style.prompt, appearance.length ? '【登场角色外貌设定】\n' + appearance.join('\n') : '', String(rawPrompt || '').trim()].filter(Boolean).join('\n');
  }
  function endpoint(base, type) {
    var url = String(base || '').trim().replace(/\/+$/, '').replace(/\/(?:images\/generations|chat\/completions)$/i, '');
    if (!/^https?:\/\//i.test(url)) throw new Error('渠道地址无效');
    var parsed = new URL(url);
    if (!parsed.pathname || parsed.pathname === '/') url += '/v1';
    return url + (type === 'chat_completions' ? '/chat/completions' : '/images/generations');
  }
  function extractImage(data) {
    var first = data.data && data.data[0];
    if (first && first.b64_json) return 'data:image/png;base64,' + first.b64_json;
    if (first && safeSource(first.url)) return first.url;
    var message = data.choices && data.choices[0] && data.choices[0].message;
    if (!message) throw new Error('接口未返回图片');
    var content = message.content;
    var pieces = Array.isArray(content) ? content.map(function (p) { return p.image_url && (p.image_url.url || p.image_url) || p.text || ''; }).join('\n') : String(content || '');
    if (Array.isArray(message.images)) pieces += '\n' + message.images.map(function (p) { return p.image_url && (p.image_url.url || p.image_url) || p.url || ''; }).join('\n');
    var match = pieces.match(/data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/=\r\n]+/i) || pieces.match(/!\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\s*\)/i);
    if (match) return match[1] || match[0].replace(/[\r\n]/g, '');
    match = pieces.match(/https?:\/\/[^\s<>"')]+/i);
    if (match) return match[0];
    throw new Error('接口未返回图片');
  }
  function loadImage(src, cors) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), timer = setTimeout(function () { img.src = ''; reject(new Error('图片读取超时')); }, 45000);
      if (cors) img.crossOrigin = 'anonymous';
      img.onload = function () { clearTimeout(timer); resolve(img); };
      img.onerror = function () { clearTimeout(timer); reject(new Error('图片读取失败')); };
      img.src = src;
    });
  }
  function canvasWebP(img) {
    var scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    var context = canvas.getContext('2d');
    if (!context) throw new Error('画布不可用');
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    var result = canvas.toDataURL('image/webp', 0.82);
    if (!result.startsWith('data:image/')) throw new Error('图片压缩失败');
    canvas.width = canvas.height = 1;
    return result;
  }
  async function persistImage(source, signal) {
    if (!safeSource(source)) throw new Error('图片地址无效');
    if (source.startsWith('data:')) return canvasWebP(await loadImage(source));
    var objectUrl;
    try {
      var response = await fetch(source, {signal:signal, credentials:'omit', referrerPolicy:'no-referrer'});
      if (!response.ok) throw new Error('图片下载失败');
      var blob = await response.blob();
      if (blob.type && !blob.type.startsWith('image/')) throw new Error('返回内容不是图片');
      objectUrl = URL.createObjectURL(blob);
      return canvasWebP(await loadImage(objectUrl));
    } catch (err) {
      if (signal && signal.aborted) throw err;
      try { return canvasWebP(await loadImage(source, true)); }
      catch (corsError) {
        // 无 CORS 的远程地址只能保留兜底，不宣称已本地化。
        await loadImage(source, false);
        bridge.showToast('跨域图片保留原链');
        return source;
      }
    } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
  }
  async function generateImage(rawPrompt, options) {
    var opts = options || {}, c = normalize(opts.config || config);
    var provider = bridge.getProviders().find(function (p) { return p.id === c.providerId; });
    if (!provider) throw new Error('请选择生图渠道');
    if (!c.model.trim()) throw new Error('请填写生图模型');
    var size = opts.size || c.size, finalPrompt = buildFinalImagePrompt(rawPrompt, Object.assign({}, opts, {config:c}));
    var body = c.endpointType === 'images_generations' ? {model:c.model, prompt:finalPrompt, size:size, n:1, response_format:'b64_json'} : {
      model:c.model, stream:false, messages:[{role:'user', content:'请生成一张图片，画幅 ' + size + '。返回图片或图片链接，不要解释。\n' + finalPrompt}]
    };
    var headers = {'Content-Type':'application/json'};
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;
    var url = endpoint(provider.baseUrl, c.endpointType);
    var response = await fetch(url, {method:'POST', headers:headers, signal:opts.signal, body:JSON.stringify(body)});
    // 部分兼容服务明确拒绝 response_format，去除后再请求一次。
    if (!response.ok && [400,422].includes(response.status) && body.response_format) {
      var detail = await response.text();
      if (/response_format|b64_json/i.test(detail)) {
        delete body.response_format;
        response = await fetch(url, {method:'POST', headers:headers, signal:opts.signal, body:JSON.stringify(body)});
      } else throw new Error('生图请求失败（' + response.status + '）');
    }
    if (!response.ok) throw new Error('生图请求失败（' + response.status + '）');
    var source = extractImage(await response.json());
    var dataUrl = await persistImage(source, opts.signal);
    if (opts.signal && opts.signal.aborted) throw new DOMException('已取消', 'AbortError');
    return {id:opts.id || 'manual_' + uid(), prompt:String(rawPrompt), finalPrompt:finalPrompt, size:size, dataUrl:dataUrl, timestamp:Date.now()};
  }
  async function runImage(ctx, prompt, options) {
    if (!valid(ctx)) return;
    var opts = options || {}, id = opts.id || 'manual_' + uid(), list = states(ctx.msg);
    if (list.some(function (j) { return j.id === id && j.pending; })) return;
    var job = {id:id, prompt:prompt, pending:true, controller:new AbortController(), error:''};
    var previous = list.findIndex(function (j) { return j.id === id; });
    if (previous >= 0) list.splice(previous, 1);
    list.push(job); refresh(ctx, false);
    var originalContent = ctx.msg.content;
    try {
      var image = await generateImage(prompt, {id:id, size:opts.size, config:opts.config || config, session:ctx.session, messages:ctx.messages,
        index:Number.isInteger(opts.contextIndex) ? opts.contextIndex : ctx.messages.indexOf(ctx.msg), signal:job.controller.signal});
      if (!valid(ctx) || job.controller.signal.aborted || ctx.msg.content !== originalContent) return;
      if (!Array.isArray(ctx.msg.generatedImages)) ctx.msg.generatedImages = [];
      var index = ctx.msg.generatedImages.findIndex(function (i) { return i.id === id; });
      if (index >= 0) ctx.msg.generatedImages[index] = image; else ctx.msg.generatedImages.push(image);
      refresh(ctx, true);
    } catch (err) {
      if (err.name !== 'AbortError' && valid(ctx)) { job.error = err.message || '绘制失败'; bridge.showToast(job.error); }
    } finally { job.pending = false; if (valid(ctx)) refresh(ctx, false); }
  }
  async function processMessageDrawTags(session, msg, msgIndex) {
    if (!session || !msg) return;
    var ctx = capture(session, msg, msgIndex);
    // 标签显式请求也允许在关闭模式下补图；刷新历史不自动重复请求。
    var tags = drawTags(msg.content).slice(0, 1);
    await Promise.all(tags.filter(function (tag) { return tag.prompt && !imageForTag(msg, tag.index); }).map(function (tag) {
      var existing = states(msg).find(function (j) { return j.id.startsWith('draw_' + tag.index + '_'); });
      return existing ? undefined : runImage(ctx, tag.prompt, {id:'draw_' + tag.index + '_' + uid()});
    }));
  }
  async function describe(text, ctx, index, c, signal) {
    if (!c.summarizerEnabled) return text;
    var context = recentContext(ctx.messages, index, c), appearance = matchedCharacters(text + '\n' + context, c);
    var options = {signal:signal};
    // 冻结主模型选择，切换会话不会让已启动任务改用另一个渠道。
    var target = c.summarizerUseMainModel ? bridge.getActiveTarget() : {providerId:c.summarizerProviderId, modelId:c.summarizerModel};
    options.providerId = target.providerId; options.model = target.modelId;
    if (!options.providerId || !options.model) throw new Error('请配置构图文字模型');
    var prompt = await bridge.completeText([{role:'system', content:c.summarizerPrompt || SUMMARIZER}, {role:'user', content:
      '【最近对话剧情】\n' + context + '\n\n【待绘内容】\n' + text + (appearance.length ? '\n\n【登场角色外貌设定】\n' + appearance.join('\n') : '')}], options);
    prompt = String(prompt || '').replace(/<\/?draw>/gi, '').trim();
    if (!prompt) throw new Error('构图描述为空');
    return prompt;
  }
  async function triggerManualIllustration(index) {
    var session = bridge.getCurrentSession(), msg = session && session.messages[index];
    if (!msg) return;
    var ctx = capture(session, msg, index), tags = drawTags(msg.content), c = normalize(config), originalContent = msg.content;
    if (states(msg).some(function (j) { return j.pending; })) return;
    var prep = {id:'prepare_' + uid(), prompt:'', pending:true, controller:new AbortController()};
    states(msg).push(prep); refresh(ctx, false);
    try {
      var source = tags.length ? tags[0].prompt : String(msg.content || '');
      var prompt = await describe(source, ctx, index, c, prep.controller.signal);
      prep.pending = false;
      if (valid(ctx) && msg.content === originalContent && !prep.controller.signal.aborted) await runImage(ctx, prompt, {config:c,
        id:tags.length ? (imageForTag(msg, 0) || {}).id || 'draw_0_' + uid() : undefined});
    } catch (err) { bridge.showToast(err.message || '提炼失败'); }
    finally { prep.pending = false; refresh(ctx, false); }
  }
  async function handleDirectImageChat(userText) {
    var current = bridge.getCurrentSession();
    if (current && directLocks.has(current.messages)) return;
    var result, ctx, prep, c = normalize(config);
    try {
      var provider = bridge.getProviders().find(function (p) { return p.id === config.providerId; });
      if (!provider || !config.model.trim()) throw new Error('请先配置生图');
      result = bridge.beginImageReply(String(userText).trim());
      directLocks.add(result.messages); ctx = capture(result.session, result.msg, result.index);
      prep = {id:'prepare_' + uid(), prompt:'', pending:true, controller:new AbortController()};
      states(result.msg).push(prep); refresh(ctx, false);
      // 空白助手占位楼不占上下文配额，直接模式截止本次用户楼。
      var contextIndex = result.index - 1;
      var prompt = await describe(userText, ctx, contextIndex, c, prep.controller.signal);
      if (!valid(ctx) || prep.controller.signal.aborted || result.msg.content) return;
      result.msg.content = '<draw>' + prompt + '</draw>';
      prep.pending = false;
      refresh(ctx, true);
      await runImage(ctx, prompt, {id:'draw_0_' + uid(), config:c, contextIndex:contextIndex});
    } catch (err) {
      bridge.showToast(err.message || '绘制失败');
      if (ctx && valid(ctx) && !ctx.msg.content) { ctx.msg.content = '绘制失败'; refresh(ctx, true); }
    } finally {
      if (prep) prep.pending = false;
      if (result) { directLocks.delete(result.messages); refresh(ctx, false); }
    }
  }
  function skeleton(text) { return '<div class="image-gen-skeleton" role="status">' + svg('image') + '<span>' + esc(text || '正在绘制场景插画...') + '</span></div>'; }
  function card(image, msg, msgIndex, fallback) {
    var job = states(msg).find(function (j) { return j.id === image.id; });
    var source = safeSource(image.dataUrl), pending = job && job.pending;
    var tools = [['edit','改词重绘'],['refresh','同词重刷'],['ratio','切换比例重绘'],['download','下载 WebP'],['remove','删除此图']].map(function (x) {
      return '<button type="button" data-ig-action="' + x[0] + '" title="' + x[1] + '" aria-label="' + x[1] + '"' + (pending && x[0] !== 'remove' ? ' disabled' : '') + '>' + svg(x[0]) + '</button>';
    }).join('');
    return '<section class="image-gen-card" data-ig-msg="' + msgIndex + '" data-ig-id="' + esc(image.id) + '">' +
      (pending ? skeleton() : source ? '<button type="button" class="image-gen-preview" data-ig-action="preview" title="放大图片"><img loading="lazy" src="' + esc(source) + '" alt="场景插画"></button>' : '<div class="image-gen-empty">' + svg('image') + '<span>' + esc(job && job.error || '待绘制') + '</span></div>') +
      '<details class="image-gen-prompt"><summary>画面描述</summary><div>' + esc(image.finalPrompt || image.prompt || fallback || '') + '</div></details><div class="image-gen-tools">' + tools + '</div></section>';
  }
  function renderMessageImages(html, msg, msgIndex, appendOnly) {
    if (!msg) return html;
    var tags = drawTags(msg.content), used = new Set(), container = document.createElement('div');
    container.innerHTML = html;
    function tagCard(index) {
      var tag = tags[index];
      if (!tag) return '';
      var image = imageForTag(msg, index);
      var job = states(msg).find(function (j) { return j.id.startsWith('draw_' + index + '_'); });
      image = image || {id:job ? job.id : 'draw_' + index + '_new', prompt:tag.prompt};
      used.add(image.id);
      return card(image, msg, msgIndex, tag.prompt);
    }
    if (!appendOnly) {
      container.querySelectorAll('[data-image-gen-tag]').forEach(function (node) {
        node.outerHTML = tagCard(Number(node.getAttribute('data-image-gen-tag')));
      });
      container.querySelectorAll('draw').forEach(function (node, index) { node.outerHTML = tagCard(index); });
    }
    var result = container.innerHTML;
    (msg.generatedImages || []).forEach(function (image) { if (!used.has(image.id)) { result += card(image, msg, msgIndex); used.add(image.id); } });
    states(msg).forEach(function (job) {
      if (job.pending && !used.has(job.id)) result += job.id.startsWith('prepare_') ? skeleton(msg.role === 'assistant' ? '正在绘制图像...' : '正在提炼画面...') : card({id:job.id, prompt:job.prompt}, msg, msgIndex);
    });
    return result;
  }
  // 渲染管道只改显示副本；原始 draw 标签始终留在文字上下文。
  bridge.registerHook('onRender', function (text, context) {
    if (context && context.role === 'user') return text;
    var index = 0;
    return String(text).replace(/<draw>[\s\S]*?<\/draw>/gi, function () { return '\n\n<span data-image-gen-tag="' + index++ + '"></span>\n\n'; });
  });
  function button(title, name, handler) {
    var b = document.createElement('button'); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.innerHTML = svg(name); if (handler) b.onclick = handler; return b;
  }
  function dialog(title, id) {
    var old = id && document.getElementById(id); if (old) old.remove();
    var el = document.createElement('dialog'); el.className = 'image-gen-dialog'; if (id) el.id = id;
    var head = document.createElement('header'), h = document.createElement('h3'); h.textContent = title;
    head.append(h, button('关闭', 'close', function () { el.close(); })); el.appendChild(head);
    el.addEventListener('close', function () { el.remove(); }); document.body.appendChild(el); return el;
  }
  var HELP = {
    mode:'关闭：不自动生图，但仍可点击消息底部画板图标手动配图；伴生插画：主 AI 写剧情时自动在关键镜头插入插画；直接生图：输入框直接发送文字生成图片。',
    endpoint:'专用生图端点：适合 Flux、Kolors、DALL-E 3 等标准画图模型（调用 /v1/images/generations）；聊天生图端点：适合 gpt-4o-image、gemini-image 等通过对话接口返回图片的模型。',
    summarizer:'开启后，在点击消息底部“手动生成插画”或“直接生图”时，会先让指定的文字 AI 读取最近 N 楼剧情上下文，结合命中角色的外貌，提炼成一段精准的画面构图描述，再交给生图模型绘制。',
    style:'生图时固定拼接在最前面的全局美术风格描述词，支持自由修改或新增自定义中文画风。',
    characters:'设置角色的触发关键词（多个词用逗号隔开）与外貌特征。当剧情或画面描述中出现该角色名字时，会自动将其外貌特征拼入生图提示词，防止生图 AI 画错人物长相。',
    director:'开启“伴生插画”模式时，自动附加在发送给主聊天 AI 上下文最末尾的规则指令，用于告诉主 AI 什么时候该插入 <draw> 画图标签。'
  };
  function helpIcon(parent, key) {
    var icon = button('查看说明','image'), pop = document.createElement('div'), owner = parent.closest('dialog'), pinned = false;
    icon.className = 'img-gen-help-icon'; icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3.5M12 16.5h.01"/></svg>';
    pop.className = 'img-gen-help-popover'; pop.id = 'img-gen-help-' + uid(); pop.setAttribute('role','tooltip'); pop.textContent = HELP[key]; pop.hidden = true;
    icon.setAttribute('aria-describedby',pop.id); icon.setAttribute('aria-expanded','false'); parent.appendChild(icon); owner.appendChild(pop);
    function hide() { pop.hidden = true; icon.setAttribute('aria-expanded','false'); }
    function show() {
      owner.querySelectorAll('.img-gen-help-popover').forEach(function (n) { n.hidden = true; });
      pop.hidden = false; icon.setAttribute('aria-expanded','true'); var rect = icon.getBoundingClientRect();
      pop.style.left = Math.max(12,Math.min(rect.left,window.innerWidth - pop.offsetWidth - 12)) + 'px';
      pop.style.top = Math.max(12,Math.min(rect.bottom + 6,window.innerHeight - pop.offsetHeight - 12)) + 'px';
    }
    icon.onmouseenter = show; icon.onmouseleave = function () { if (!pinned) hide(); }; icon.onfocus = show;
    icon.onblur = function () { pinned = false; hide(); };
    icon.onclick = function (e) { e.preventDefault(); e.stopPropagation(); pinned = !pinned; if (pinned) show(); else hide(); };
    icon.onkeydown = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pinned = false; hide(); } };
    function outside(e) { if (!icon.contains(e.target) && !pop.contains(e.target)) { pinned = false; hide(); } }
    function scrolled() { pinned = false; hide(); }
    owner.addEventListener('click',outside); owner.addEventListener('scroll',scrolled,true);
    icon.disposeHelp = function () { pop.remove(); owner.removeEventListener('click',outside); owner.removeEventListener('scroll',scrolled,true); };
  }
  function heading(parent, title, help) {
    var head = document.createElement('div'), text = document.createElement('span'); head.className = 'image-gen-heading'; text.textContent = title; head.appendChild(text); parent.appendChild(head);
    if (help) helpIcon(head,help); return head;
  }
  function field(parent, title, control, help) {
    var wrap = document.createElement('div'); wrap.className = 'image-gen-field'; parent.appendChild(wrap);
    var head = heading(wrap,title,help); control.setAttribute('aria-label',title); wrap.appendChild(control); head.firstChild.onclick = function () { control.focus(); }; return control;
  }
  function section(parent, title, help) {
    var wrap = document.createElement('section'); wrap.className = 'image-gen-section'; parent.appendChild(wrap); heading(wrap,title,help); return wrap;
  }
  function toggle(parent, title, value, change) {
    var label = document.createElement('label'), input = document.createElement('input'); label.className = 'image-gen-toggle'; input.type = 'checkbox'; input.checked = value;
    input.onchange = function () { change(input.checked); }; label.append(input,document.createTextNode(title)); parent.appendChild(label); return input;
  }
  function select(items, value, change) {
    var s = document.createElement('select'); items.forEach(function (x) { var o = document.createElement('option'); o.value = x[0]; o.textContent = x[1]; s.appendChild(o); }); s.value = value; s.onchange = function () { change(s.value); }; return s;
  }
  function textarea(value, rows, change) { var t = document.createElement('textarea'); t.rows = rows; t.value = value; t.onchange = function () { change(t.value); }; return t; }
  function openSettings() {
    var el = dialog('生图设置', 'image-gen-modal'), grid = document.createElement('div'); grid.className = 'image-gen-form'; el.appendChild(grid);
    var radios = document.createElement('div'); radios.className = 'image-gen-modes'; radios.setAttribute('role','group');
    [['off','关闭'],['companion','伴生插画'],['direct','直接生图']].forEach(function (x) {
      var item = document.createElement('button'); item.type = 'button'; item.textContent = x[1]; item.dataset.mode = x[0]; item.setAttribute('aria-pressed',String(config.mode === x[0]));
      item.onclick = function () { config.mode = x[0]; persist(); radios.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed',String(b.dataset.mode === config.mode)); }); }; radios.appendChild(item);
    }); field(grid, '工作模式', radios, 'mode');
    var providers = bridge.getProviders(), model = document.createElement('input'); model.value = config.model; model.setAttribute('list', 'image-gen-models');
    model.onchange = function () { config.model = model.value.trim(); persist(); };
    var models = document.createElement('datalist'); models.id = 'image-gen-models';
    function updateModels() { models.replaceChildren(); var p = providers.find(function (x) { return x.id === config.providerId; }); (p && p.models || []).forEach(function (m) { var o = document.createElement('option'); o.value = typeof m === 'string' ? m : m.id; models.appendChild(o); }); }
    var choices = providers.map(function (p) { return [p.id, p.name]; }); if (!choices.some(function (p) { return p[0] === config.providerId; })) choices.unshift([config.providerId, '选择渠道']);
    field(grid, '生图渠道', select(choices, config.providerId, function (v) { config.providerId = v; persist(); updateModels(); }));
    field(grid, '生图模型', model); grid.appendChild(models); updateModels();
    field(grid, '接口协议', select([['images_generations','专用生图端点'],['chat_completions','聊天生图端点']], config.endpointType, function (v) { config.endpointType = v; persist(); }), 'endpoint');
    field(grid, '画幅比例', select(SIZES, config.size, function (v) { config.size = v; persist(); }));
    var summary = section(grid,'画面构图提炼 AI','summarizer');
    toggle(summary,'启用构图提炼 AI',config.summarizerEnabled,function (v) { config.summarizerEnabled = v; persist(); summaryBody.hidden = !v; });
    var summaryBody = document.createElement('div'); summaryBody.className = 'image-gen-summary-body'; summaryBody.hidden = !config.summarizerEnabled; summary.appendChild(summaryBody);
    field(summaryBody,'文字模型',select([['main','跟随当前主聊天渠道与模型'],['custom','独立指定渠道与模型']],config.summarizerUseMainModel ? 'main' : 'custom',function (v) { config.summarizerUseMainModel = v === 'main'; independent.hidden = config.summarizerUseMainModel; persist(); }));
    var independent = document.createElement('div'); independent.className = 'image-gen-summary-body'; independent.hidden = config.summarizerUseMainModel; summaryBody.appendChild(independent);
    var summaryModel = document.createElement('input'), summaryModels = document.createElement('datalist'); summaryModels.id = 'image-gen-summary-models'; summaryModel.setAttribute('list',summaryModels.id); summaryModel.value = config.summarizerModel;
    function updateSummaryModels() { summaryModels.replaceChildren(); var p = providers.find(function (x) { return x.id === config.summarizerProviderId; }); (p && p.models || []).forEach(function (m) { var o = document.createElement('option'); o.value = typeof m === 'string' ? m : m.id; summaryModels.appendChild(o); }); }
    var summaryChoices = [['','选择渠道']].concat(providers.map(function (p) { return [p.id,p.name]; }));
    if (config.summarizerProviderId && !providers.some(function (p) { return p.id === config.summarizerProviderId; })) summaryChoices.push([config.summarizerProviderId,'渠道已失效']);
    field(independent,'构图渠道',select(summaryChoices,config.summarizerProviderId,function (v) { config.summarizerProviderId = v; persist(); updateSummaryModels(); }));
    summaryModel.onchange = function () { config.summarizerModel = summaryModel.value.trim(); persist(); }; field(independent,'构图模型',summaryModel); independent.appendChild(summaryModels); updateSummaryModels();
    var count = document.createElement('input'); count.type = 'number'; count.min = '1'; count.max = '30'; count.step = '1'; count.value = config.summarizerContextCount;
    count.onchange = function () { config.summarizerContextCount = Math.max(1,Math.min(30,Math.floor(Number(count.value) || 4))); count.value = config.summarizerContextCount; persist(); }; field(summaryBody,'读取最近对话楼层数（层）',count);
    var summaryPrompt = textarea(config.summarizerPrompt,5,function (v) { config.summarizerPrompt = v; persist(); }); field(summaryBody,'构图提炼提示词',summaryPrompt);
    summaryBody.appendChild(button('恢复默认','refresh',function () { config.summarizerPrompt = SUMMARIZER; summaryPrompt.value = SUMMARIZER; persist(); }));
    var styleWrap = document.createElement('div'); styleWrap.className = 'image-gen-style'; grid.appendChild(styleWrap);
    function drawStyles() {
      styleWrap.querySelectorAll('.img-gen-help-icon').forEach(function (icon) { icon.disposeHelp(); });
      styleWrap.replaceChildren();
      var s = select(config.stylePresets.map(function (p) { return [p.id,p.name]; }), config.activeStyleId, function (v) { config.activeStyleId = v; persist(); drawStyles(); });
      field(styleWrap, '画风预设', s, 'style');
      var tools = document.createElement('div'); tools.className = 'image-gen-style-tools';
      tools.append(button('新增画风','add',function () { var p = {id:'style_' + uid(),name:'新画风',prompt:''}; config.stylePresets.push(p); config.activeStyleId = p.id; persist(); drawStyles(); }), button('删除画风','remove',async function () {
        var id = config.activeStyleId;
        if (window.showAppConfirm && !await window.showAppConfirm('删除此画风？')) return;
        config.stylePresets = config.stylePresets.filter(function (p) { return p.id !== id; }); config.activeStyleId = (config.stylePresets[0] || {}).id || ''; persist(); drawStyles();
      }), button('重置默认画风','refresh',async function () {
        if (window.showAppConfirm && !await window.showAppConfirm('重置默认画风？')) return;
        config.stylePresets = defaultStyles().concat(config.stylePresets.filter(function (p) { return !STYLES.some(function (s) { return s.id === p.id; }); }));
        config.activeStyleId = 'pm_dark'; persist(); drawStyles();
      }));
      tools.children[0].appendChild(document.createTextNode('新增画风')); tools.children[1].appendChild(document.createTextNode('删除当前画风')); styleWrap.appendChild(tools);
      var selected = config.stylePresets.find(function (p) { return p.id === config.activeStyleId; });
      if (selected) {
        var name = document.createElement('input'); name.value = selected.name; name.onchange = function () { selected.name = name.value.trim() || '未命名'; persist(); drawStyles(); }; field(styleWrap,'画风名称',name);
        field(styleWrap,'当前画风提示词内容',textarea(selected.prompt,3,function (v) { selected.prompt = v; persist(); }));
      }
    }
    drawStyles();
    var characters = section(grid,'角色外貌关键词库','characters'), characterCards = document.createElement('div'); characterCards.className = 'image-gen-character-list';
    characters.firstChild.appendChild(button('添加角色','add',function () { config.characterList.push({id:'char_' + uid(),enabled:true,keywords:'',appearance:''}); persist(); drawCharacters(); })); characters.appendChild(characterCards);
    function drawCharacters() {
      characterCards.replaceChildren();
      config.characterList.forEach(function (p) {
        var card = document.createElement('div'); card.className = 'image-gen-character-card'; card.dataset.characterId = p.id;
        toggle(card,'启用',p.enabled,function (v) { p.enabled = v; persist(); });
        var keywords = document.createElement('input'); keywords.value = p.keywords; keywords.placeholder = '触发词，多个用逗号隔开，如：罗兰, Roland'; keywords.onchange = function () { p.keywords = keywords.value; persist(); }; keywords.setAttribute('aria-label','触发关键词');
        var remove = button('删除角色','remove',function () { config.characterList = config.characterList.filter(function (x) { return x !== p; }); persist(); drawCharacters(); });
        var appearance = textarea(p.appearance,2,function (v) { p.appearance = v; persist(); }); appearance.placeholder = '输入该角色的发型、瞳色、服装、标志性武器等中文外貌描述...'; appearance.setAttribute('aria-label','外貌特征');
        card.append(keywords,remove,appearance); characterCards.appendChild(card);
      });
    }
    drawCharacters();
    var director = textarea(config.directorPrompt, 5, function (v) { config.directorPrompt = v; persist(); }); field(grid, '伴生插画导演指令', director, 'director');
    var reset = button('恢复默认','refresh',function () { config.directorPrompt = DIRECTOR; director.value = DIRECTOR; persist(); }); reset.className = 'image-gen-reset'; grid.appendChild(reset);
    el.showModal();
  }
  async function action(event) {
    var b = event.target.closest('[data-ig-action]'); if (!b) return;
    var root = b.closest('.image-gen-card'); if (!root) return;
    event.preventDefault(); event.stopPropagation();
    var session = bridge.getCurrentSession(), index = Number(root.dataset.igMsg), msg = session && session.messages[index]; if (!msg) return;
    var ctx = capture(session,msg,index), id = root.dataset.igId;
    var image = (msg.generatedImages || []).find(function (i) { return i.id === id; });
    var tagIndex = /^draw_(\d+)_/.exec(id), tag = tagIndex && drawTags(msg.content)[Number(tagIndex[1])];
    image = image || {id:id, prompt:tag ? tag.prompt : '', size:config.size};
    var command = b.dataset.igAction;
    try {
      if (command === 'preview') {
        var lightbox = dialog('插画预览'); lightbox.classList.add('image-gen-lightbox'); var img = document.createElement('img'); img.src = safeSource(image.dataUrl); img.alt = '场景插画'; lightbox.appendChild(img); lightbox.showModal();
      } else if (command === 'refresh') await runImage(ctx,image.prompt,{id:id,size:image.size});
      else if (command === 'edit') {
        var editor = dialog('改词重绘'), input = textarea(image.prompt,6,function () {}); field(editor,'画面描述',input);
        editor.appendChild(button('确认重绘','check',function () { if (!input.value.trim() || !valid(ctx)) return; editor.close(); void runImage(ctx,input.value.trim(),{id:id,size:image.size}); })); editor.showModal();
      } else if (command === 'ratio') {
        document.querySelectorAll('.image-gen-ratios').forEach(function (n) { n.remove(); });
        var menu = document.createElement('div'); menu.className = 'image-gen-ratios'; menu.setAttribute('role','menu');
        SIZES.forEach(function (size) { var item = button(size[1],'ratio',function () { menu.remove(); void runImage(ctx,image.prompt,{id:id,size:size[0]}); }); item.appendChild(document.createTextNode(size[1])); menu.appendChild(item); });
        document.body.appendChild(menu); var rect = b.getBoundingClientRect(); menu.style.left = Math.max(12,Math.min(rect.left,window.innerWidth - menu.offsetWidth - 12)) + 'px'; menu.style.top = Math.max(12,Math.min(rect.top - menu.offsetHeight - 6,window.innerHeight - menu.offsetHeight - 12)) + 'px';
        setTimeout(function () { document.addEventListener('click',function close(e) { if (menu.contains(e.target)) return; menu.remove(); document.removeEventListener('click',close); }); },0);
      } else if (command === 'download') {
        if (!safeSource(image.dataUrl)) return;
        if (!image.dataUrl.startsWith('data:')) { bridge.showToast('原链图片另存'); window.open(image.dataUrl,'_blank','noopener,noreferrer'); return; }
        var a = document.createElement('a'); a.href = image.dataUrl; a.download = '插画-' + image.timestamp + (image.dataUrl.startsWith('data:image/webp') ? '.webp' : '.png'); a.click();
      } else if (command === 'remove') {
        var pending = states(msg).find(function (j) { return j.id === id; }); if (pending) { pending.controller.abort(); pending.pending = false; }
        msg.generatedImages = (msg.generatedImages || []).filter(function (i) { return i.id !== id; });
        if (tag) { var count = -1; msg.content = msg.content.replace(/<draw>[\s\S]*?<\/draw>/gi,function (full) { count++; return count === Number(tagIndex[1]) ? '' : full; }); }
        refresh(ctx,true);
      }
    } catch (err) { bridge.showToast(err.message || '操作失败'); }
  }
  function init() {
    var toolbar = document.querySelector('.send-extra-actions') || document.querySelector('.auto-retry-toolbar');
    if (toolbar && !document.getElementById('image-gen-capsule')) {
      capsule = document.createElement('div'); capsule.id = 'image-gen-capsule'; capsule.className = 'image-gen-capsule';
      modeButton = button('切换生图模式','image',function () { var modes = ['off','companion','direct']; config.mode = modes[(modes.indexOf(config.mode) + 1) % 3]; persist(); });
      capsule.append(modeButton, button('生图设置','settings',openSettings));
      toolbar.insertBefore(capsule, toolbar.querySelector('#msg-batch-toggle-btn')); paint();
    }
  }
  document.addEventListener('click',function (event) { void action(event); });
  window.addEventListener('mychat-context-changed',init);
  window.MyChatImageGenerator = {
    isDirectMode:function () { return config.mode === 'direct'; }, isCompanionMode:function () { return config.mode === 'companion'; },
    getDirectorPrompt:function () { return config.directorPrompt; }, buildFinalImagePrompt:buildFinalImagePrompt,
    generateImage:generateImage, processMessageDrawTags:processMessageDrawTags, onAiMessageCompleted:processMessageDrawTags,
    renderDrawTagsInHtml:renderMessageImages, renderMessageImages:renderMessageImages,
    triggerManualIllustration:triggerManualIllustration, handleDirectImageChat:handleDirectImageChat,
    isPending:function (msg) { return states(msg).some(function (j) { return j.pending; }); },
    openSettings:openSettings, reload:function () { config = loadConfig(); paint(); },
    getConfig:function () { return JSON.parse(JSON.stringify(config)); }
  };
  init();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true});
}());
