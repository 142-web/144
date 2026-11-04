/* 复杂界面帮助：仅挂载白名单入口，说明不参与聊天与存储。 */
(function () {
  'use strict';
  var pages = {
    params: ['默认对话参数',
      '<h4>什么时候生效</h4><ul><li>保存后，只用于之后新建的会话，不会修改已有对话。当前会话可在输入区单独调整。</li><li>数值留空表示不向接口指定该参数，使用服务商默认值。</li></ul>' +
      '<h4>历史与回复长度</h4><ul><li><strong>上下文消息上限</strong>：最多带上多少条最近消息。一条用户发言或 AI 回复各算一条；草稿也会占一条。减少条数更省钱，但 AI 可能忘记前文。留空不按条数截断，仍受模型容量与记忆归档影响。</li><li><strong>最大输出 Token</strong>：限制一次回复的长度。Token 是文字碎片，不等于汉字数；这不是模型的总记忆容量。</li><li><strong>流式输出</strong>：开启后边生成边显示；关闭后通常等整段回复完成才显示，不会因此改变历史消息。</li></ul>' +
      '<h4>随机性与选词</h4><ul><li><strong>Temperature（温度）</strong>：越低通常越稳定，越高越多变。写代码或查资料可先试较低值，写故事可适当提高；范围以模型说明为准。</li><li><strong>Top P（词汇筛选范围）</strong>：例如 0.9，表示从累计可能性约 90% 的候选词中选词。越小通常越保守，1 表示不做这项筛选。</li><li>新手可以全部留空，之后先只调温度，不必同时修改温度和 Top P。</li></ul>'],
    sync: ['云端同步',
      '<h4>平台与地址怎么填</h4><ul><li>目前支持 Gitee 和 GitHub 的 <strong>Gist（代码片段存储）</strong>。选择平台后，填写该平台创建的访问令牌，并授予所需的 Gist 读写权限。</li><li><strong>Gist ID</strong>只填片段编号，不填整条网页链接；留空时自动查找已有备份。上传时找不到可创建，拉取不会创建。</li><li><strong>WebDAV</strong>是网盘的文件读写接口，本版本尚不支持，不能把 WebDAV 地址填入 Gist ID。本地备份也不需要填写服务器地址。</li></ul>' +
      '<h4>上传与拉取会怎样</h4><ul><li><strong>上传</strong>把本机完整数据写到云端，可能覆盖旧备份；<strong>拉取</strong>确认后采用云端数据，不是把两边聊天逐条合并。</li><li>同步包含聊天与子对话、角色与记忆、预设、世界书、正则、渠道密钥和模型价格等。拉取不替换本机同步平台、访问令牌、Gist ID 和自动同步开关。</li><li>自动同步默认关闭，开启后会按修改时间比较并同步；手动上传与拉取由你决定方向。不要两台设备同时修改后直接互相覆盖。</li></ul>' +
      '<h4>避免丢失数据</h4><ul><li>首次同步或更换设备前，先导出本地备份；确认哪台数据完整，再上传，另一台再拉取。</li><li>本地备份是包含密钥的明文文件，请妥善保管。云端使用可还原的文字混淆，并不是真正的安全加密。</li><li>同步失败时先保留本地数据与备份，检查网络、令牌权限和片段编号，不要反复拉取覆盖。</li></ul>'],
    memory: ['记忆库',
      '<h4>有什么用</h4><p>把较早的聊天整理成<strong>总纲和事件</strong>，减少每次发送的历史内容。每个子对话分别保存记忆，设置由整个会话共享。</p>' +
      '<h4>自动总结</h4><ul><li><strong>楼层间隔</strong>：每积累指定条数的消息，整理一段历史。一条用户消息或 AI 回复各算一楼。</li><li><strong>延后一轮总结</strong>：最新回复出现时不立刻整理；等你再次发送消息，才总结已完成的上一段，方便先修改或重答。</li><li>总结成功后，已整理的原文不再重复发送，但聊天记录仍保留在本机。失败不会推进总结位置。</li></ul>' +
      '<h4>智能检索</h4><p>开启后，发送前由模型挑选与当前话题相关的旧事件，再交给聊天模型。它会增加请求次数、耗时和费用。<strong>最大召回数</strong>限制本次选取的事件数量。</p>' +
      '<h4>模型与重试</h4><p>可跟随当前聊天模型，也可指定单独的渠道和模型。重试次数指失败后的额外尝试次数；填 0 表示不重试。自定义提示词留空会使用内置内容。</p>'],
    preset: ['预设编辑',
      '<h4>提示词与顺序</h4><p><strong>System Prompt（系统提示词）</strong>是提前告诉 AI 的规则，例如写作风格、任务和限制。创建小模块后，拖动调整顺序；关闭的模块不会发送。</p>' +
      '<h4>模块位置</h4><ul><li><strong>系统指令</strong>：作为系统提示发送；同类模块按列表顺序拼接。</li><li><strong>后置指令</strong>：放在最新用户消息前，补充本轮要求。</li><li><strong>Prefill（预输入）</strong>：替 AI 写好回复开头，让模型继续往下写；接口不支持时可能报错。保留选项决定是否把这个开头显示在最终回复里。</li></ul>' +
      '<h4>模型采样参数</h4><ul><li><strong>Temperature（温度 / 随机性）</strong>：越低通常越稳定，越高通常越多变；允许范围由模型决定。</li><li><strong>Top P</strong>：限制模型从多大范围的候选词中选择。通常先调整温度，不必同时改两项。</li><li><strong>最大输出 Token</strong>：限制单次回复长度，不是总上下文容量。</li><li><strong>上下文条数</strong>：限制发送多少条历史消息。留空表示不按条数裁剪，仍受模型容量限制。</li></ul><p>参数留空时不发送对应数值，由接口决定。当前会话参数与新对话默认参数分别保存。</p>'],
    worldbook: ['世界书',
      '<h4>有什么用</h4><p>保存人物、地点和规则等背景资料。先给当前会话启用世界书，再启用需要的词条。</p>' +
      '<h4>什么时候发送</h4><ul><li><strong>常驻词条</strong>：每次都发送，适合一直要遵守的规则。</li><li><strong>关键词触发</strong>：在参与匹配的聊天内容中找到关键词才发送，适合偶尔出现的人物或地点。关键词应填写聊天里实际会出现的词。</li></ul>' +
      '<h4>放在哪里</h4><p>可放在系统提示之前、之后，或历史消息中。<strong>注入深度（Depth）</strong>就是从最近的历史消息往前数几条，再把资料插进去；数字越大，位置越靠前。</p>' +
      '<h4>开了会怎样</h4><p>命中的资料只加入本次请求，不写进原聊天记录。常驻资料也会占 Token，但不会计入回复下方的关键词命中数量。</p>'],
    regex: ['正则脚本',
      '<h4>有什么用</h4><p><strong>正则表达式</strong>是描述文字特征的查找规则，用于批量替换或删除匹配的内容。查找框填规则，替换框填新文字；替换留空表示删除。</p>' +
      '<h4>选择处理阶段</h4><ul><li><strong>仅修改显示</strong>：只改变气泡里看到的样子，不改已保存文字，也不会因此改变发送内容。</li><li><strong>发送前</strong>：修改本次交给 AI 的文字，不改本地原聊天记录。</li><li><strong>接收落盘</strong>：AI 回复会先被处理再保存；之后发送的历史也会使用处理后的文字。</li></ul>' +
      '<h4>范围与写法</h4><p>规则依次按<strong>全局 → 预设 → 会话</strong>执行。目标决定处理用户、AI 还是系统文字。标志 g 表示替换全部匹配，i 表示忽略大小写；替换中的 $1 可引用第一组括号匹配到的内容。</p><p>先用少量样本文字测试，尤其是会改变已保存内容的规则。</p>'],
    character: ['角色与人设',
      '<h4>角色卡</h4><p>用于设置 AI 的名字、头像、开场白等资料。导入角色卡可能同时带来预设、世界书或正则规则，导入后可分别检查。</p>' +
      '<h4>用户人设</h4><p>填写你在对话中的名字及个人资料。<strong>写进人设不等于自动发送</strong>；资料需要由预设中的对应宏引用，才会进入本次请求。</p>' +
      '<h4>名字与开场白</h4><ul><li><strong>{{char}}</strong>代表 AI 角色名，<strong>{{user}}</strong>代表用户名字。</li><li>头像只影响显示，不会作为图片发给模型。</li><li>开场白用于空对话或重置开头，不会随意覆盖已有历史。</li><li>编辑完成后点击保存才生效。内部子对话共享角色设置。</li></ul>'],
    provider: ['模型渠道',
      '<h4>需要填什么</h4><ul><li><strong>Base URL（接口地址）</strong>：服务商给出的 API 入口，不是网页聊天地址，通常无需再补 /chat/completions。</li><li><strong>API Key（接口密钥）</strong>：服务商用来确认账户和计费的凭证；不同服务商的密钥不能混用。</li><li><strong>模型 ID</strong>：接口实际接受的模型名字。别名只改变界面显示。</li></ul>' +
      '<h4>内置与自定义渠道</h4><ul><li>在顶部直接选择内置渠道，填写自己的密钥，再拉取或添加模型。不自动发请求，地址和协议仍可手改。</li><li>内置渠道没有密钥或模型时不出现在聊天模型列表；本地 Ollama 配好模型后无需密钥。新增按钮可创建自定义渠道，删除按钮只删除自定义渠道。</li><li>Claude 官网使用 Anthropic 协议，其余内置渠道使用 OpenAI 兼容协议。</li></ul>' +
      '<h4>测试与拉取</h4><p><strong>测试连接</strong>检查接口能否响应，不保证每个模型都有权限；模型列表不可用时可能发送一条极短的测试消息。<strong>拉取模型</strong>读取可用列表，也可以手动添加模型 ID。</p>' +
      '<h4>常见问题</h4><p>浏览器直连要求服务商允许跨域；地址、密钥正确也可能被浏览器拦截。Ollama 需先启动本地服务并允许当前页面来源。价格选填，单位是元 / 百万 Token；实际账单以服务商为准。</p>'],
    token: ['Token 统计',
      '<h4>Token 是什么</h4><p><strong>Token（文字计数单位）</strong>可以理解为 AI 眼里的文字碎片；1 个汉字大约占 1～2 个 Token，不同模型的切分方式不同。</p>' +
      '<h4>这里统计什么</h4><p>按当前会话、激活子对话、上下文条数和输入草稿，估算将要发送的内容，包括预设、角色提示、世界书、记忆及历史。切换对话或修改设置会立即更新。</p>' +
      '<h4>容量与费用</h4><ul><li><strong>上下文容量</strong>是模型一次能处理的输入与输出总量；本地上下文条数限制不是模型的 Token 上限。</li><li><strong>最大输出</strong>只限制回复长度，需要给回复预留容量。</li><li>这里是本地估算，不是账单；回复下方的实际用量来自接口返回。</li></ul>' +
      '<h4>具体内容预览</h4><ul><li>顶部彩条显示各类 Token 占比；下方按实际发送顺序排列，连续历史合并，遇到深度注入则分段。点击各小标题查看正文，说明项不计 Token。</li><li>这是当前快照；发送时总结、智能检索、时间和随机宏可能重新计算。未来检索位置尚未确定，不会作为真实注入项穿插历史。</li></ul>']
  };
  var overlay, title, content, close, previous;
  function icon(path) { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>'; }
  function hide() {
    overlay.hidden = true;
    if (previous && previous.isConnected) previous.focus({ preventScroll: true });
  }
  function show(key, source) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'feature-help-overlay';
      overlay.dataset.modalOverlay = 'true';
      overlay.hidden = true;
      overlay.innerHTML = '<section class="feature-help-card" role="dialog" aria-modal="true" aria-labelledby="feature-help-title"><header><h3 id="feature-help-title"></h3><button type="button" title="关闭" aria-label="关闭">' + icon('<path d="m6 6 12 12M6 18 18 6"/>') + '</button></header><div class="feature-help-content" tabindex="0"></div></section>';
      document.body.appendChild(overlay);
      title = overlay.querySelector('h3');
      content = overlay.querySelector('.feature-help-content');
      close = overlay.querySelector('button');
      close.addEventListener('click', hide);
      overlay.addEventListener('click', function (e) { e.stopPropagation(); if (e.target === overlay) hide(); });
    }
    previous = source;
    title.textContent = pages[key][0];
    // 只使用本文件中的固定说明，不插入用户内容。
    content.innerHTML = pages[key][1];
    content.scrollTop = 0;
    overlay.hidden = false;
    close.focus({ preventScroll: true });
  }
  var targets = [
    ['#ms-console-modal .ms-title', 'memory'], ['#token-meter-modal .ms-title', 'token'],
    ['#preset-title', 'preset'], ['#module-edit-title', 'preset'], ['#top-preset-dropdown .tp-toolbar', 'preset'],
    ['#wb-title', 'worldbook'], ['#wb-ed-title', 'worldbook'], ['#regex-title', 'regex'],
    ['#session-char-title', 'character'], ['#provider-title', 'provider'],
    ['#params-title', 'params'], ['#sync-title', 'sync']
  ];
  function attach() {
    targets.forEach(function (target) {
      var host = document.querySelector(target[0]);
      if (!host || host.querySelector('.feature-help-btn')) return;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'feature-help-btn';
      button.title = pages[target[1]][0] + '帮助';
      button.setAttribute('aria-label', button.title);
      button.innerHTML = icon('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01"/>');
      button.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); show(target[1], button); });
      host.appendChild(button);
    });
  }
  document.addEventListener('keydown', function (e) {
    if (!overlay || overlay.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); hide(); }
    else if (e.key === 'Tab') {
      e.preventDefault(); e.stopImmediatePropagation();
      (document.activeElement === close ? content : close).focus();
    } else if (e.key === 'Enter' && document.activeElement !== close) e.stopImmediatePropagation();
  }, true);
  attach();
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
}());
