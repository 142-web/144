/* 渠道快捷填入与 Anthropic 协议适配；不自动请求、不保存密钥。 */
(function () {
  'use strict';
  var choices = [
    ['自定义手动输入 (Custom)', '', 'openai'],
    ['OpenAI 官方', 'https://api.openai.com/v1', 'openai'],
    ['Anthropic Claude 官方', 'https://api.anthropic.com/v1', 'anthropic'],
    ['Google Gemini 官方 (OpenAI 兼容)', 'https://generativelanguage.googleapis.com/v1beta/openai', 'openai'],
    ['DeepSeek 官方', 'https://api.deepseek.com/v1', 'openai'],
    ['硅基流动 (SiliconFlow)', 'https://api.siliconflow.cn/v1', 'openai'],
    ['OpenRouter (全球模型聚合中转)', 'https://openrouter.ai/api/v1', 'openai'],
    ['Groq 高速推理', 'https://api.groq.com/openai/v1', 'openai'],
    ['xAI (Grok 官方)', 'https://api.x.ai/v1', 'openai'],
    ['阿里云百炼 (DashScope)', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'openai'],
    ['火山引擎 (豆包 Ark)', 'https://ark.cn-beijing.volces.com/api/v3', 'openai'],
    ['Moonshot (Kimi 月之暗面)', 'https://api.moonshot.cn/v1', 'openai'],
    ['智谱 AI (BigModel)', 'https://open.bigmodel.cn/api/paas/v4', 'openai'],
    ['Ollama 本地模型', 'http://localhost:11434/v1', 'openai']
  ];
  // 固定标识不随名称或地址编辑改变，渠道的保存与迁移由宿主负责。
  window.MyChatProviderDefaults = choices.slice(1).map(function (item, i) {
    return { builtinId: ['openai','anthropic','gemini','deepseek','siliconflow','openrouter','groq','xai','dashscope','ark','moonshot','bigmodel','ollama'][i],
      name: item[0], baseUrl: item[1], apiType: item[2] };
  });
  window.dispatchEvent(new Event('mychat-provider-defaults-ready'));
  var protocol = document.getElementById('cfg-api-type');
  [protocol, document.getElementById('cfg-vision-support')].forEach(function (field) {
    if (field) field.addEventListener('change', function () {
      document.getElementById('cfg-baseurl').dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  function usage(value) {
    value = value || {};
    var input = (value.input_tokens || 0) + (value.cache_read_input_tokens || 0) + (value.cache_creation_input_tokens || 0);
    return { prompt_tokens: input, completion_tokens: value.output_tokens || 0,
      total_tokens: input + (value.output_tokens || 0), prompt_tokens_details: { cached_tokens: value.cache_read_input_tokens || 0 } };
  }
  function dataSource(url) {
    var match = /^data:([^;]+);base64,([\s\S]+)$/.exec(url || '');
    if (!match) throw new Error('附件数据格式无效');
    return {type:'base64', media_type:match[1], data:match[2]};
  }
  function claudeParts(content) {
    if (!Array.isArray(content)) return content;
    return content.map(function (part) {
      if (part.type === 'image_url') return {type:'image', source:dataSource(part.image_url.url)};
      if (part.type === 'file') return {type:'document', source:dataSource(part.file.file_data)};
      return part;
    });
  }
  async function geminiRequest(provider, url, options) {
    if (!/\/chat\/completions$/i.test(url)) return window.fetch(url, options);
    var body = JSON.parse(options.body), systems = [], contents = [];
    body.messages.forEach(function (msg) {
      if (msg.role === 'system') { systems.push(msg.content); return; }
      var parts = (Array.isArray(msg.content) ? msg.content : [{type:'text', text:msg.content}]).map(function (p) {
        if (p.type === 'text') return {text:p.text};
        var source = dataSource(p.type === 'image_url' ? p.image_url.url : p.file.file_data);
        return {inlineData:{mimeType:source.media_type, data:source.data}};
      });
      contents.push({role:msg.role === 'assistant' ? 'model' : 'user', parts:parts});
    });
    var payload = {contents:contents, generationConfig:{}};
    if (systems.length) payload.systemInstruction = {parts:[{text:systems.join('\n\n')}]};
    [['temperature','temperature'],['top_p','topP'],['max_tokens','maxOutputTokens']].forEach(function (pair) { if (body[pair[0]] !== undefined) payload.generationConfig[pair[1]] = body[pair[0]]; });
    var base = url.replace(/\/chat\/completions$/i, '').replace(/\/openai\/?$/i, '');
    var opts = Object.assign({}, options, {headers:{'Content-Type':'application/json', 'x-goog-api-key':provider.apiKey || ''}, body:JSON.stringify(payload)});
    var response = await window.fetch(base + '/models/' + encodeURIComponent(body.model) + ':generateContent', opts);
    if (!response.ok) return response;
    var data = await response.json();
    var parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [];
    var text = parts.filter(function (p) { return !p.thought; }).map(function (p) { return p.text || ''; }).join('');
    var u = data.usageMetadata || {}, result = {choices:[{message:{role:'assistant', content:text}}], usage:{prompt_tokens:u.promptTokenCount || 0, completion_tokens:u.candidatesTokenCount || 0, total_tokens:u.totalTokenCount || 0}};
    if (!body.stream) return new Response(JSON.stringify(result), {headers:{'Content-Type':'application/json'}});
    // 原生生成响应转换成宿主 SSE；不伪造逐字流式，保留统一消费接口。
    return new Response('data: ' + JSON.stringify({choices:[{delta:{content:text}}], usage:result.usage}) + '\n\ndata: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
  }
  async function request(provider, url, options) {
    if (provider && provider.apiType === 'gemini') return geminiRequest(provider, url, options);
    if (!provider || provider.apiType !== 'anthropic') return window.fetch(url, options);
    var opts = Object.assign({}, options);
    opts.headers = Object.assign({}, options.headers);
    delete opts.headers.Authorization;
    opts.headers['x-api-key'] = provider.apiKey || '';
    opts.headers['anthropic-version'] = '2023-06-01';
    opts.headers['anthropic-dangerous-direct-browser-access'] = 'true';
    var isChat = /\/chat\/completions$/i.test(url);
    if (isChat) {
      url = url.replace(/\/chat\/completions$/i, '/messages');
      var body = JSON.parse(opts.body);
      var systems = [];
      body.messages = body.messages.filter(function (msg) {
        if (msg.role === 'system') { systems.push(msg.content); return false; }
        return true;
      });
      body.messages = body.messages.map(function (msg) { return {role:msg.role, content:claudeParts(msg.content)}; });
      if (systems.length) body.system = systems.join('\n\n');
      body.max_tokens = body.max_tokens || 4096;
      delete body.stream_options;
      // Claude 不接受同时设置 temperature 和 top_p。
      if (body.temperature !== undefined) delete body.top_p;
      if (body.temperature !== undefined) body.temperature = Math.max(0, Math.min(1, body.temperature));
      opts.body = JSON.stringify(body);
    }
    var response = await window.fetch(url, opts);
    if (!response.ok || !isChat) return response;
    if (!body.stream) {
      var data = await response.json();
      var text = (data.content || []).filter(function (part) { return part.type === 'text'; }).map(function (part) { return part.text; }).join('');
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }], usage: usage(data.usage) }), { headers: { 'Content-Type': 'application/json' } });
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var encoder = new TextEncoder();
    var buffer = '';
    var totals = {};
    var stream = new ReadableStream({
      async pull(controller) {
        try {
          var chunk = await reader.read();
          buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }).replace(/\r\n/g, '\n');
          var blocks = buffer.split('\n\n');
          buffer = blocks.pop();
          if (chunk.done && buffer.trim()) { blocks.push(buffer); buffer = ''; }
          blocks.forEach(function (block) {
            var line = block.split('\n').filter(function (s) { return s.indexOf('data: ') === 0; }).map(function (s) { return s.slice(6); }).join('\n');
            if (!line) return;
            var event = JSON.parse(line);
            if (event.type === 'error') throw new Error(event.error && event.error.message || 'Claude 请求失败');
            if (event.message && event.message.usage) Object.assign(totals, event.message.usage);
            if (event.usage) Object.assign(totals, event.usage);
            var delta = {};
            if (event.delta && event.delta.type === 'text_delta') delta.content = event.delta.text;
            if (event.delta && event.delta.type === 'thinking_delta') delta.reasoning_content = event.delta.thinking;
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: delta }], usage: usage(totals) }) + '\n\n'));
          });
          if (chunk.done) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
        } catch (error) { controller.error(error); reader.cancel().catch(function () {}); }
      },
      cancel: function (reason) { return reader.cancel(reason); }
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  window.MyChatProviders = { fetch: request };
}());
