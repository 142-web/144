/* 云同步与云端历史：纯原生独立基础设施，仅通过注入依赖访问宿主。 */
(function () {
  'use strict';
  var deps;

  function init(hostDeps) {
    deps = hostDeps;
  try { lastBackupUploadAt = Number(localStorage.getItem(deps.constants.LAST_BACKUP_MAINT_AT_KEY) || 0) || 0; } catch (e) {}
  }

  // 只取消尚未执行的自动上传，不改变同步队列或暂停状态。
  function cancelScheduledUpload() {
    if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }
  }

  // 云同步迁移正文开始
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
  var cloudSyncPausedByCancel = false; // 用户取消冲突裁决后，后台同步保持静默
  var syncInFlight = false;   // 是否有同步请求正在进行，避免重复请求
  var uploadInFlight = false; // 是否有上传请求正在进行，避免并发覆盖
  var uploadTimer = null;     // 1 秒延迟上传计时器
  var pendingCloudSync = false; // 前台同步被生成或锁阻挡时合并补跑
  var pendingCloudSyncSilent = true;
  var cloudSyncRetryTimer = null;

  function pauseCloudSyncByCancel() {
    cloudSyncPausedByCancel = true;
    pendingCloudSync = false;
    pendingCloudSyncSilent = true;
    if (cloudSyncRetryTimer) { clearTimeout(cloudSyncRetryTimer); cloudSyncRetryTimer = null; }
    if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }
  }

  function queueCloudSync(silent) {
    if (cloudSyncPausedByCancel) return;
    pendingCloudSync = true;
    if (silent === false) pendingCloudSyncSilent = false;
    if (cloudSyncRetryTimer) return;
    cloudSyncRetryTimer = setTimeout(function retry() {
      cloudSyncRetryTimer = null;
      if (cloudSyncPausedByCancel || !pendingCloudSync) return;
      if (!isSyncConfigured() || (pendingCloudSyncSilent && !deps.getConfig().autoSync)) {
        pendingCloudSync = false;
        pendingCloudSyncSilent = true;
        return;
      }
      if (deps.getActiveGenerationCount() > 0 || isSyncing || syncInFlight || uploadInFlight || deps.getApplyingCloudData()) {
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
    if (cloudSyncPausedByCancel) return;
    if (!isSyncConfigured() || !deps.getConfig().autoSync) return;
    if (lastSyncAt && Date.now() - lastSyncAt < 5000) return;
    if (deps.getActiveGenerationCount() > 0 || isSyncing || syncInFlight || uploadInFlight || deps.getApplyingCloudData()) {
      queueCloudSync(true);
      return;
    }
    syncWithCloud(true);
  }

  var cachedGistFiles = null; // 已知云端文件字典，仅驻留内存
  var lastBackupUploadAt = 0; // 最近一次快照维护成功时间，刷新后沿用本地冷却

  var cachedGistIdentity = ''; // 切换平台、令牌或 Gist 时隔离缓存
  var cachedGistIdentityInitialized = false;

  // 全局同步互斥锁：上传 / 拉取期间忽略重复点击，防止接口限流
  var isSyncing = false;

  var CLOUD_CHUNK_MAX = 900000;
  var BACKUP_MAX_SIZE = 900000;
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
    if (typeof rawContent === 'object' && rawContent !== null) return JSON.stringify(rawContent);
    var text = typeof rawContent === 'string' ? rawContent.trim() : '';
    if (!text) return null;

    var wrapper = deps.safeJsonParse(text);
    if (wrapper && typeof wrapper === 'object') {
      if (wrapper._compressed === 'gzip_v2' || wrapper._compressed === 'gzip') {
        throw new Error('GZIP_PAYLOAD_REQUIRES_ASYNC_DECRYPT');
      }
      if (wrapper._encrypted === true && !wrapper._compressed && typeof wrapper.payload === 'string') {
        var reversed = wrapper.payload.split('').reverse().join('');
        return base64ToUtf8(reversed);
      }
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
    var wrapper = null;
    if (rawContent && typeof rawContent === 'object') {
      if (Array.isArray(rawContent.sessions) && !rawContent._encrypted) return rawContent;
      wrapper = rawContent;
    } else if (typeof rawContent === 'string') {
      var text = rawContent.replace(/^\uFEFF/, '').trim();
      wrapper = deps.safeJsonParse(text);
      if (wrapper === null) {
        throw new Error('云端外层 JSON 损坏或被截断（长度 ' + rawContent.length + '）');
      }
    }
    if (wrapper && wrapper._encrypted === true && typeof wrapper.payload === 'string') {
      if (wrapper._compressed === 'gzip_v2' || wrapper._compressed === 'gzip') {
        if (typeof DecompressionStream !== 'function') {
          throw new Error('当前浏览器不支持 Gzip 解压');
        }
        var cleanPayload = wrapper.payload.replace(/\s+/g, '');
        function decodeB64ToBytes(b64Str) {
          var latin = atob(b64Str);
          var decoded = new Uint8Array(latin.length);
          for (var i = 0; i < latin.length; i++) decoded[i] = latin.charCodeAt(i);
          return decoded;
        }
        // 按固定顺序尝试历史混淆，只有 Gzip 魔数匹配才进入解压。
        var candidates = [
          unswapBase64Halves(cleanPayload),
          cleanPayload.split('').reverse().join(''),
          cleanPayload
        ];
        var bytes = null;
        for (var c = 0; c < candidates.length; c++) {
          var candidateBytes;
          try {
            candidateBytes = decodeB64ToBytes(candidates[c]);
          } catch (decodeErr) {
            continue;
          }
          if (candidateBytes.length >= 2 && candidateBytes[0] === 0x1f && candidateBytes[1] === 0x8b) {
            bytes = candidateBytes;
            break;
          }
        }
        if (!bytes) throw new Error('云端 Gzip 数据无效：未找到 Gzip 魔数');
        var decompressedStream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return await new Response(decompressedStream).text();
      }
      if (!wrapper._compressed) {
        var reversed = wrapper.payload.replace(/\s+/g, '').split('').reverse().join('');
        return base64ToUtf8(reversed);
      }
    }
    return wrapper;
  }

  // 主文件只保存完整密文或分片清单，旧分片在同一次提交中清理。
  function buildSyncedFileMap(encryptedStr, existingFiles) {
    var files = {};
    var chunks = [];
    if (encryptedStr.length <= CLOUD_CHUNK_MAX) {
      files[deps.constants.SYNC_FILE_NAME] = { content: encryptedStr };
    } else {
      for (var offset = 0; offset < encryptedStr.length; offset += CLOUD_CHUNK_MAX) {
        chunks.push(encryptedStr.slice(offset, offset + CLOUD_CHUNK_MAX));
      }
      var wrapper = deps.safeJsonParse(encryptedStr);
      var meta = wrapper && wrapper._meta || null;
      var stamp = meta ? meta.lastModified : deps.getLocalLastModified() || Date.now();
      files[deps.constants.SYNC_FILE_NAME] = { content: JSON.stringify({
        _chunked: true, totalChunks: chunks.length, expectedLength: encryptedStr.length,
        lastModified: stamp, _meta: meta
      }) };
      if (chunks.length > 8) {
        throw new Error('云端同步数据分片数（' + chunks.length + '）超出 Gist 单仓库文件数量上限');
      }
      chunks.forEach(function (chunk, i) {
        files[SYNC_CHUNK_PREFIX + i + '.dat'] = { content: chunk };
      });
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
  function getSyncConfig() {
    var result = { syncPlatform: deps.getConfig().syncPlatform, syncToken: deps.getConfig().syncToken,
      gistId: deps.getConfig().gistId, autoSync: deps.getConfig().autoSync,
      cloudHistoryPauseCleanup: deps.getConfig().cloudHistoryPauseCleanup === true };
    deps.getS3ConfigFields().forEach(function (key) { result[key] = deps.getConfig()[key] || ''; });
    return result;
  }

  function s3FieldId(key) {
    return { s3Endpoint: 'sync-s3-endpoint', s3Bucket: 'sync-s3-bucket',
      s3AccessKey: 'sync-s3-access-key', s3SecretKey: 'sync-s3-secret-key' }[key];
  }

  function updateSyncProviderFields() {
    var isS3 = deps.getEls().cfgSyncPlatform.value === 's3';
    var gistFields = document.getElementById('sync-gist-fields');
    var s3Fields = document.getElementById('sync-s3-fields');
    if (gistFields) gistFields.hidden = isS3;
    if (s3Fields) s3Fields.hidden = !isS3;
    var historyFields = document.getElementById('cloud-history-panel');
    if (historyFields) historyFields.hidden = !isS3;
  }

  function isSyncConfigured() {
    if (deps.getConfig().syncPlatform === 's3') return deps.getS3ConfigFields().every(function (key) { return !!String(deps.getConfig()[key] || '').trim(); });
    return !!(deps.getConfig().syncToken && deps.getConfig().syncToken.trim() && deps.getConfig().gistId && deps.getConfig().gistId.trim());
  }

  async function compressStringToGzipBytes(rawStr) {
    var blob = new Blob([String(rawStr || '')]);
    var stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
    var buf = await new Response(stream).arrayBuffer();
    console.log('[云同步] Gzip 二进制压缩：原始 UTF-8 约 ' + Math.round(blob.size / 1024) + ' KB -> 压缩后 ' + Math.round(buf.byteLength / 1024) + ' KB');
    return new Uint8Array(buf);
  }

  async function decompressGzipBytesToString(uint8Bytes) {
    var stream = new Blob([uint8Bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }

  // 原生 AWS V4：路径、查询及签名均针对最终实际请求地址计算。
  async function s3Request(method, objectKey, bodyBytesOrStr, contentType, queryParams, extraHeaders) {
    if (!window.crypto || !window.crypto.subtle) throw new Error('当前环境不支持安全签名，请使用 HTTPS 或本地安全环境');
    var encode = function (str) { return encodeURIComponent(str).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); };
    var url = new URL(deps.getConfig().s3Endpoint.trim().replace(/\/+$/, ''));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Endpoint 地址无效');
    var baseParts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    var bucket = deps.getConfig().s3Bucket.trim();
    if (baseParts[baseParts.length - 1] !== bucket) baseParts.push(bucket);
    if (objectKey) baseParts = baseParts.concat(String(objectKey).split('/'));
    var canonicalPath = '/' + baseParts.map(encode).join('/') + (objectKey ? '' : '/');
    url.pathname = canonicalPath;
    var pairs = Object.keys(queryParams || {}).map(function (key) { return [encode(key), encode(String(queryParams[key]))]; });
    pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });
    var query = pairs.map(function (pair) { return pair.join('='); }).join('&');
    url.search = query;
    url.hash = '';
    var encoder = new TextEncoder();
    var hex = function (buffer) { return Array.from(new Uint8Array(buffer), function (b) { return b.toString(16).padStart(2, '0'); }).join(''); };
    var sha256 = async function (bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)); };
    var hmac = async function (key, text) {
      var imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return await crypto.subtle.sign('HMAC', imported, encoder.encode(text));
    };
    method = method.toUpperCase();
    var hasBody = !['GET', 'HEAD', 'DELETE'].includes(method) && bodyBytesOrStr != null;
    var body = hasBody ? (typeof bodyBytesOrStr === 'string' ? encoder.encode(bodyBytesOrStr) : bodyBytesOrStr) : new Uint8Array(0);
    var payloadHash = await sha256(body);
    var amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    var date = amzDate.slice(0, 8);
    // R2 使用 auto，标准 AWS Endpoint 从域名提取区域。
    var regionMatch = url.hostname.match(/(?:^|\.)s3[.-]([a-z]{2}(?:-gov)?-[a-z]+-\d)\./);
    var region = regionMatch ? regionMatch[1] : (/^(?:s3\.)?amazonaws\.com$/.test(url.hostname) || url.hostname === 's3.amazonaws.com' ? 'us-east-1' : 'auto');
    var scope = date + '/' + region + '/s3/aws4_request';
    var signingHeaders = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    var additionalHeaders = {};
    Object.keys(extraHeaders || {}).forEach(function (key) {
      var name = key.toLowerCase();
      var value = String(extraHeaders[key]).trim().replace(/\s+/g, ' ');
      additionalHeaders[name] = value;
      if (name.indexOf('x-amz-') === 0) signingHeaders[name] = value;
    });
    var headerNames = Object.keys(signingHeaders).sort();
    var signedHeaders = headerNames.join(';');
    var canonicalHeaders = headerNames.map(function (name) { return name + ':' + signingHeaders[name] + '\n'; }).join('');
    var canonical = [method, canonicalPath, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    var stringToSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + scope + '\n' + await sha256(encoder.encode(canonical));
    var signingKey = await hmac(encoder.encode('AWS4' + deps.getConfig().s3SecretKey), date);
    signingKey = await hmac(signingKey, region);
    signingKey = await hmac(signingKey, 's3');
    signingKey = await hmac(signingKey, 'aws4_request');
    var signature = hex(await hmac(signingKey, stringToSign));
    var headers = { ...additionalHeaders, 'x-amz-date': signingHeaders['x-amz-date'], 'x-amz-content-sha256': signingHeaders['x-amz-content-sha256'],
      Authorization: 'AWS4-HMAC-SHA256 Credential=' + deps.getConfig().s3AccessKey + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature };
    if (contentType) headers['Content-Type'] = contentType;
    var response;
    try {
      response = await fetch(url.toString(), { method: method, headers: headers, body: hasBody ? body : undefined, cache: 'no-store' });
    } catch (err) {
      if (err instanceof TypeError) throw new Error(err.message + '（请检查 Endpoint 地址是否正确，以及 R2 存储桶设置中是否已配置 CORS 跨域策略允许 *）');
      throw err;
    }
    if ((method === 'GET' || method === 'HEAD') && response.status === 404) return null;
    if (!response.ok) throw new Error('S3 请求失败（' + response.status + '）：' + await response.text());
    return response;
  }

  async function readS3Meta() {
    var response = await s3Request('GET', 'mychat_meta.json');
    if (!response) return null;
    var meta = await response.json();
    if (!meta || !Number.isFinite(Number(meta.lastModified)) || Number(meta.lastModified) < 0 ||
        (meta.version === 'v2_layered' ? !meta.manifest || !Array.isArray(meta.manifest.sessionOrder) ||
          !meta.manifest.chunks || typeof meta.manifest.chunks !== 'object' :
          !Number.isSafeInteger(meta.byteLength) || meta.byteLength <= 0)) throw new Error('云端元数据清单无效');
    return meta;
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
    return computeCloudDataStats({ lastModified: deps.getLocalLastModified(), sessions: deps.getSessions() });
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
    if (!deps.getEls().syncStatusBtn) return;

    // 只更新文字节点，保留左侧单色云朵 SVG 图标
    var textEl = deps.getEls().syncStatusText || deps.getEls().syncStatusBtn;

    deps.getEls().syncStatusBtn.classList.remove('state-syncing', 'state-ok', 'state-error');

    if (!isSyncConfigured()) {
      textEl.textContent = '未配置同步';
      deps.getEls().syncStatusBtn.title = '点击前往【设置】配置云端同步';
      return;
    }

    deps.getEls().syncStatusBtn.title = '点击立即同步云端数据';

    if (syncState === 'syncing') {
      textEl.textContent = '同步中...';
      deps.getEls().syncStatusBtn.classList.add('state-syncing');
    } else if (syncState === 'ok') {
      textEl.textContent = '✓ 已同步 (' + formatSyncAgo(lastSyncAt) + ')';
      deps.getEls().syncStatusBtn.classList.add('state-ok');
    } else if (syncState === 'error') {
      textEl.textContent = '同步失败';
      deps.getEls().syncStatusBtn.classList.add('state-error');
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
    return deps.getConfig().syncPlatform === 'github' ? deps.constants.SYNC_API_BASE.github : deps.constants.SYNC_API_BASE.gitee;
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

    if (deps.getConfig().syncPlatform === 'github') {
      headers['Authorization'] = 'token ' + deps.getConfig().syncToken;
    } else {
      url +=
        (url.indexOf('?') === -1 ? '?' : '&') +
        'access_token=' +
        encodeURIComponent(deps.getConfig().syncToken);
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
      var parsed = deps.safeJsonParse(text);
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

    return deps.safeJsonParse(text) || {};
  }

  // 哈希缓存只保留当前一代分块；必须重算内容指纹，不能以可变对象引用判断未变。
  var layeredGzipCache = new Map();
  var isCloudHistoryWorking = false;

  function layeredObjectKey(kind, sid, subId, index) {
    return 'mychat_' + kind + '_' + encodeURIComponent(String(sid)) +
      (kind === 'hist' ? '_' + encodeURIComponent(String(subId)) + '_' + index : '') + '.gz';
  }

  async function layeredHash(text) {
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest)).map(function (n) { return n.toString(16).padStart(2, '0'); }).join('').slice(0, 16);
  }

  async function buildLayeredCloudChunks(lastModified) {
    var payload = deps.buildCloudPayload(lastModified, true);
    var chunks = Object.create(null);
    var globals = Object.assign({}, payload);
    delete globals.sessions;
    // 全局时间戳属于清单，避免每次聊天都重传全局配置。
    delete globals.lastModified;
    chunks['mychat_chunk_globals.gz'] = { rawObj: globals };
    var sessionOrder = payload.sessions.map(function (session) {
      var hot = Object.assign({}, session);
      var snapshots = Object.create(null);
      var hasSnapshots = false;
      function splitBranch(branch, subId) {
        var part = Object.assign({}, branch);
        var messages = Array.isArray(branch.messages) ? branch.messages : [];
        part.coldChunkCount = Math.floor(messages.length / 200);
        part.tailMessages = messages.slice(part.coldChunkCount * 200);
        delete part.messages;
        for (var i = 0; i < part.coldChunkCount; i++) {
          chunks[layeredObjectKey('hist', session.id, subId, i)] = { rawObj: messages.slice(i * 200, (i + 1) * 200) };
        }
        if (branch.memoryData) {
          part.memoryData = Object.assign({}, branch.memoryData);
          part.memorySnapshotsPresent = Object.prototype.hasOwnProperty.call(branch.memoryData, 'snapshots');
          if (part.memorySnapshotsPresent) {
            snapshots[subId] = branch.memoryData.snapshots;
            if (Array.isArray(snapshots[subId]) && snapshots[subId].length) hasSnapshots = true;
          }
          delete part.memoryData.snapshots;
        }
        return part;
      }
      if (Array.isArray(session.subChats) && session.subChats.length) {
        hot.subChats = session.subChats.map(function (sub) { return splitBranch(sub, sub.id); });
      } else {
        hot = splitBranch(session, session.id);
      }
      chunks[layeredObjectKey('sess', session.id)] = { rawObj: hot };
      if (hasSnapshots) chunks[layeredObjectKey('snap', session.id)] = { rawObj: snapshots };
      return session.id;
    });
    await Promise.all(Object.keys(chunks).map(async function (key) {
      var chunk = chunks[key];
      chunk.json = JSON.stringify(chunk.rawObj, function (_, value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        var sorted = Object.create(null);
        Object.keys(value).sort().forEach(function (key) { sorted[key] = value[key]; });
        return sorted;
      });
      chunk.hash = await layeredHash(chunk.json);
    }));
    return { chunks: chunks, sessionOrder: sessionOrder, payload: payload };
  }

  async function layeredCompressedChunk(key, chunk) {
    var cached = layeredGzipCache.get(key);
    if (cached && cached.hash === chunk.hash) return cached.gzBytes;
    var gzBytes = await compressStringToGzipBytes(chunk.json);
    layeredGzipCache.set(key, { hash: chunk.hash, gzBytes: gzBytes });
    return gzBytes;
  }

  // 限制并行数量，避免大历史在移动端瞬时开启数百个请求。
  async function mapLayeredChunks(keys, fn) {
    var next = 0;
    await Promise.all(Array.from({ length: Math.min(4, keys.length) }, async function () {
      while (next < keys.length) { var key = keys[next++]; await fn(key); }
    }));
  }

  async function fetchLayeredCloudData(meta) {
    var local = await buildLayeredCloudChunks(deps.getLocalLastModified());
    var manifest = meta.manifest;
    var raw = Object.create(null);
    await mapLayeredChunks(Object.keys(manifest.chunks), async function (key) {
      var expected = manifest.chunks[key];
      if (!/^mychat_(?:chunk_globals|sess_.+|snap_.+|hist_.+)\.gz$/.test(key) ||
          !expected || !/^[a-f0-9]{16}$/.test(expected.hash) || !Number.isSafeInteger(expected.size) || expected.size <= 0) {
        throw new Error('云端分块清单无效');
      }
      var existing = local.chunks[key];
      if (existing && existing.hash === expected.hash) { raw[key] = existing.rawObj; return; }
      var response = await s3Request('GET', key);
      if (!response) throw new Error('云端分块缺失：' + key);
      var bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== expected.size) throw new Error('云端分块长度不完整：' + key);
      var json = await decompressGzipBytesToString(bytes);
      if (await layeredHash(json) !== expected.hash) throw new Error('云端分块指纹不符：' + key);
      raw[key] = JSON.parse(json);
    });
    var globals = raw['mychat_chunk_globals.gz'];
    if (!globals || typeof globals !== 'object' || Array.isArray(globals)) throw new Error('云端全局配置包缺失');
    var seen = new Set();
    var restored = manifest.sessionOrder.map(function (sid) {
      if (seen.has(sid)) throw new Error('云端会话索引重复');
      seen.add(sid);
      var hot = raw[layeredObjectKey('sess', sid)];
      if (!hot || hot.id !== sid) throw new Error('云端会话包缺失：' + sid);
      var snapshots = raw[layeredObjectKey('snap', sid)];
      function restoreBranch(part, subId) {
        if (!Number.isSafeInteger(part.coldChunkCount) || part.coldChunkCount < 0 || !Array.isArray(part.tailMessages) || part.tailMessages.length >= 200) {
          throw new Error('云端会话分箱无效');
        }
        var branch = Object.assign({}, part);
        var messages = [];
        for (var i = 0; i < part.coldChunkCount; i++) {
          var bin = raw[layeredObjectKey('hist', sid, subId, i)];
          if (!Array.isArray(bin) || bin.length !== 200) throw new Error('云端历史分箱缺失');
          messages.push.apply(messages, bin);
        }
        branch.messages = messages.concat(part.tailMessages);
        if (part.memoryData) {
          branch.memoryData = Object.assign({}, part.memoryData);
          if (part.memorySnapshotsPresent) branch.memoryData.snapshots = snapshots && Object.prototype.hasOwnProperty.call(snapshots, subId) ? snapshots[subId] : [];
        }
        delete branch.coldChunkCount;
        delete branch.tailMessages;
        delete branch.memorySnapshotsPresent;
        return branch;
      }
      if (Array.isArray(hot.subChats) && hot.subChats.length) {
        return Object.assign({}, hot, { subChats: hot.subChats.map(function (sub) { return restoreBranch(sub, sub.id); }) });
      }
      return restoreBranch(hot, sid);
    });
    return Object.assign({}, globals, { sessions: restored, lastModified: Number(meta.lastModified) });
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

    var data = plain && typeof plain === 'object' ? plain : deps.safeJsonParse(plain);
    return normalizeCloudPayloadData(data);
  }

  // 只校验并规范化结构，不解密、不写入存储。
  function normalizeCloudPayloadData(data) {
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
      autoRetry: data.autoRetry && typeof data.autoRetry === 'object' ? data.autoRetry : null,
      imageGenConfig: data.imageGenConfig && typeof data.imageGenConfig === 'object' ? data.imageGenConfig : null
    });
  }

  async function parseCloudPayloadAsync(rawContent) {
    if (typeof rawContent === 'string' && !rawContent.trim()) return null;
    try {
      var decrypted = await decryptCloudContentAsync(rawContent);
      var data = (decrypted && typeof decrypted === 'object')
        ? decrypted
        : deps.safeJsonParse(typeof decrypted === 'string' ? decrypted.trim() : '');
      var payload = normalizeCloudPayloadData(data);
      if (!payload) {
        throw new Error('无效云端载荷');
      }
      return payload;
    } catch (decErr) {
      console.warn('[云同步] 云端数据解密或解析失败：', decErr);
      throw new Error('云端数据解析失败（' + (decErr && decErr.message ? decErr.message : '未知原因') + '），已中止同步以保护云端数据');
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
    var identity = JSON.stringify([deps.getConfig().syncPlatform, deps.getConfig().syncToken, deps.getConfig().gistId]);
    if (identity !== cachedGistIdentity) {
      cachedGistIdentity = identity;
      cachedGistFiles = null;
      // 初次绑定缓存身份不清空持久化冷却；真实切换连接才重置。
      if (lastBackupUploadAt && cachedGistIdentityInitialized) {
        lastBackupUploadAt = 0;
        try { localStorage.removeItem(deps.constants.LAST_BACKUP_MAINT_AT_KEY); } catch (e) {}
      }
      cachedGistIdentityInitialized = true;
    }
    if (deps.getConfig().gistId) return deps.getConfig().gistId;

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
        item.description === deps.constants.SYNC_GIST_DESC ||
        Object.prototype.hasOwnProperty.call(files, deps.constants.SYNC_FILE_NAME)
      ) {
        matched = item;
        break;
      }
    }

    // 2. 找到历史同步 Gist：直接复用，手机端只填 Token 就能连上电脑端数据
    if (matched) {
      deps.getConfig().gistId = matched.id;
      cachedGistIdentity = JSON.stringify([deps.getConfig().syncPlatform, deps.getConfig().syncToken, deps.getConfig().gistId]);
      deps.persistConfig(true);
      console.log('[云同步] 已自动找到历史同步 Gist：' + matched.id);
      return deps.getConfig().gistId;
    }

    if (readOnly) throw new Error('未找到云端数据');
    // 3. 没找到则新建私有 Gist，并写入一份当前数据
    // 注意：这里不刷新全局时间戳，避免仅"创建 Gist"就被判定为本地有新修改
    var initPayload = deps.buildCloudPayload(deps.getLocalLastModified() || Date.now(), true);
    var initContent = await encryptCloudContentAsync(JSON.stringify(initPayload), createCloudMeta(initPayload));
    var initFiles = buildSyncedFileMap(initContent, {});

    var created = await gistRequest('', 'POST', {
      description: deps.constants.SYNC_GIST_DESC,
      public: false,
      files: initFiles
    });

    if (!created || !created.id) {
      throw new Error('创建 Gist 失败：接口未返回有效的 Gist ID');
    }

    deps.getConfig().gistId = created.id;
    cachedGistIdentity = JSON.stringify([deps.getConfig().syncPlatform, deps.getConfig().syncToken, deps.getConfig().gistId]);
    cachedGistFiles = Object.assign({}, created.files || initFiles);
    deps.persistConfig(true);
    localStorage.setItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY, String(initPayload.lastModified));
    console.log('[云同步] 已自动创建私有同步 Gist：' + created.id);
    return deps.getConfig().gistId;
  }

  // 优先读取内联内容；raw 跨域失败时保留已有内容，交由解析层诊断。
  async function readGistFileContent(fileObj) {
    if (!fileObj) throw new Error('云端同步文件缺失');
    var content = typeof fileObj.content === 'string' ? fileObj.content : '';
    var isTruncated = fileObj.truncated === true || (!content && Number(fileObj.size) > 0) ||
      (typeof fileObj.size === 'number' && content.length > 0 && fileObj.size > content.length * 3 && content.trim().slice(-1) !== '}');
    if (!content || isTruncated) {
      if (!fileObj.raw_url) throw new Error('云端同步文件不完整');
      var rawUrl = fileObj.raw_url;
      if (deps.getConfig().syncPlatform === 'gitee' && rawUrl.indexOf('access_token=') === -1 && deps.getConfig().syncToken) {
        var tokenUrl = new URL(rawUrl);
        tokenUrl.searchParams.set('access_token', deps.getConfig().syncToken.trim());
        rawUrl = tokenUrl.toString();
      }
      try {
        var rawRes = await fetch(rawUrl, { cache: 'no-store' });
        if (!rawRes.ok) throw new Error('云端文件读取失败：' + rawRes.status);
        content = await rawRes.text();
      } catch (rawErr) {
        if (!content || !(rawErr instanceof TypeError)) throw rawErr;
        console.warn('[云同步] raw 文件跨域或网络读取失败，回退内联内容：', rawErr);
      }
    }
    return content;
  }

  /**
   * 读取云端主文件；云端尚无该文件时 payload 为 null
   */
  async function fetchCloudData(options = {}) {
    if (deps.getConfig().syncPlatform === 's3') {
      var meta = await readS3Meta();
      if (!meta) {
        var probe = await s3Request('HEAD', 'mychat_latest.gz');
        if (!probe) return { isEmpty: true, lastModified: 0, data: null, meta: null, payload: null };
        // 兼容仅有本体的历史桶：没有清单就必须读取正文取得真实版本。
      }
      if (meta && options && options.onlyMeta === true) {
        return { isEmpty: false, onlyMeta: true, lastModified: Number(meta.lastModified || 0),
          data: null, meta: meta._meta || null, s3Meta: meta, byteLength: Number(meta.byteLength || 0), files: {} };
      }
      if (meta && meta.version === 'v2_layered') {
        var layeredData = await fetchLayeredCloudData(meta);
        return { isEmpty: false, lastModified: Number(meta.lastModified), data: layeredData,
          payload: layeredData, meta: meta._meta || computeCloudDataStats(layeredData), s3Meta: meta, files: {} };
      }
      var response = await s3Request('GET', 'mychat_latest.gz');
      if (!response) {
        if (meta) throw new Error('云端主数据文件缺失');
        return { isEmpty: true, lastModified: 0, data: null, meta: null, payload: null };
      }
      var gzBytes = new Uint8Array(await response.arrayBuffer());
      if (meta && meta.byteLength > 0 && gzBytes.byteLength !== meta.byteLength) {
        throw new Error('云端二进制文件长度不完整（期望 ' + meta.byteLength + '，实际 ' + gzBytes.byteLength + '）');
      }
      var data = JSON.parse(await decompressGzipBytesToString(gzBytes));
      if (!data || !Array.isArray(data.sessions)) throw new Error('云端数据结构无效');
      var stamp = Number((meta && meta.lastModified) || data.lastModified || 0);
      data.lastModified = stamp;
      return { isEmpty: false, lastModified: stamp, data: data, payload: data,
        meta: meta && meta._meta || computeCloudDataStats(data), s3Meta: meta, files: {} };
    }
    var gistId = await ensureGistId(options === true);
    var detail = await gistRequest('/' + encodeURIComponent(gistId), 'GET');
    cachedGistFiles = Object.assign({}, (detail && detail.files) || {});
    var file = detail && detail.files ? detail.files[deps.constants.SYNC_FILE_NAME] : null;

    if (!file) return { payload: null };

    var content = await readGistFileContent(file);
    if (!content.trim()) return { payload: null };
    var payload = await parseGistCloudContent(content, cachedGistFiles);
    if (!payload) throw new Error('云端数据解析失败，已中止同步以保护云端数据');
    return { payload: payload };
  }

  async function parseGistCloudContent(content, files) {
    var manifest = deps.safeJsonParse(content);
    if (manifest && manifest._chunked === true) {
      if (!Number.isSafeInteger(manifest.totalChunks) || manifest.totalChunks <= 0) {
        throw new Error('云端分片清单无效');
      }
      var chunks = [];
      for (var i = 0; i < manifest.totalChunks; i++) {
        var chunkName = SYNC_CHUNK_PREFIX + i + '.dat';
        if (!files || !files[chunkName]) throw new Error('云端分片缺失：' + chunkName);
        chunks.push(await readGistFileContent(files[chunkName]));
      }
      var fullContent = chunks.join('');
      if (Number.isSafeInteger(manifest.expectedLength) && manifest.expectedLength > 0 &&
          fullContent.length !== manifest.expectedLength) {
        throw new Error('云端分片拼接长度不完整：期望 ' + manifest.expectedLength + '，实际 ' + fullContent.length);
      }
      return await parseCloudPayloadAsync(fullContent);
    }
    return await parseCloudPayloadAsync(content);
  }

  /**
   * 上传本地数据到云端（对外入口）：持有全局 isSyncing 锁，防止连点触发接口限流
   * @param {boolean} fromSync 是否由同步流程调用（true 时沿用当前按钮状态）
   */
  async function uploadToCloud(fromSync) {
    if (cloudSyncPausedByCancel || isCloudHistoryWorking) return;
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
  async function uploadS3Data(isManualPush, remote) {
    var identity = JSON.stringify(['s3', deps.getConfig().s3Endpoint, deps.getConfig().s3Bucket, deps.getConfig().s3AccessKey, deps.getConfig().s3SecretKey]);
    if (identity !== cachedGistIdentity) {
      if (cachedGistIdentityInitialized) {
        lastBackupUploadAt = 0;
        localStorage.removeItem(deps.constants.LAST_BACKUP_MAINT_AT_KEY);
      }
      cachedGistIdentity = identity;
      cachedGistIdentityInitialized = true;
    }
    // 本轮同步已读过清单时直接复用；只有基线一致才允许自动覆盖云端。
    var remoteMeta = remote ? (remote.isEmpty ? null : remote.s3Meta || { lastModified: remote.lastModified,
      _meta: remote.meta }) : await readS3Meta();
    if (!isManualPush && remoteMeta) {
      var lastSyncedCloudStamp = localStorage.getItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY) || '';
      if (!lastSyncedCloudStamp || lastSyncedCloudStamp !== String(remoteMeta.lastModified)) {
        queueCloudSync(false);
        return;
      }
    }
    var now = Date.now();
    var stamp = deps.getLocalLastModified() || now;
    var layered = await buildLayeredCloudChunks(stamp);
    var remoteChunks = remoteMeta && remoteMeta.version === 'v2_layered' ? remoteMeta.manifest.chunks : {};
    var manifest = { sessionOrder: layered.sessionOrder, chunks: Object.create(null) };
    await mapLayeredChunks(Object.keys(layered.chunks), async function (key) {
      var chunk = layered.chunks[key];
      if (remoteChunks[key] && remoteChunks[key].hash === chunk.hash) {
        manifest.chunks[key] = remoteChunks[key];
      } else {
        var bytes = await layeredCompressedChunk(key, chunk);
        await s3Request('PUT', key, bytes, 'application/gzip');
        manifest.chunks[key] = { hash: chunk.hash, size: bytes.byteLength };
      }
    });
    // 清单最后提交；清单之外的旧对象不再参与恢复，留待独立维护清理。
    await s3Request('PUT', 'mychat_meta.json', JSON.stringify({ lastModified: stamp,
      version: 'v2_layered', _meta: createCloudMeta(layered.payload), manifest: manifest }), 'application/json');
    layeredGzipCache.forEach(function (_, key) { if (!layered.chunks[key]) layeredGzipCache.delete(key); });
    try { localStorage.setItem(deps.constants.S3_MANIFEST_KEY, JSON.stringify({ endpoint: deps.getConfig().s3Endpoint, bucket: deps.getConfig().s3Bucket, manifest: manifest })); }
    catch (cacheErr) { console.warn('[云同步] 本地指纹缓存跳过：', cacheErr); }
    localStorage.setItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY, String(stamp));
    lastSyncAt = Date.now();
    setSyncStatus('ok');
    // 仅交付轻量清单；历史间隔通过前不复制、序列化或保留完整载荷。
    maintainS3LayeredBackup({ lastModified: stamp, manifest: manifest }, now);
  }

  // 历史配置与索引属于云同步主干，不增加独立插件或消息管道。
  var CLOUD_HISTORY_INDEX = 'mychat_history_index.json';
  var cloudHistoryFields = {
    retentionDays: [3, 1, 30], activeIntervalMinutes: [10, 5, 120],
    fineRetentionHours: [2, 1, 24], sparseIntervalHours: [2, 1, 12]
  };
  var cloudHistoryRefreshId = 0;
  var cloudHistoryHelpPinned = false;

  function closeCloudHistoryHelp() {
    cloudHistoryHelpPinned = false;
    var help = document.getElementById('cloud-history-help');
    var button = document.getElementById('cloud-history-help-btn');
    if (help) help.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function initCloudHistoryUi() {
    Object.keys(cloudHistoryFields).forEach(function (key) {
      var input = document.getElementById('cloud-history-' + key);
      if (!input) return;
      input.addEventListener('change', function () {
        var next = getCloudHistoryConfig(); next[key] = input.value;
        if (!deps.writeStorageValue(deps.constants.CLOUD_HISTORY_CONFIG_KEY, normalizeCloudHistoryConfig(next))) deps.showToast('历史配置保存失败');
        else deps.touchLastModified();
        fillCloudHistoryConfig();
      });
    });
    var refresh = document.getElementById('cloud-history-refresh');
    if (refresh) refresh.addEventListener('click', refreshCloudHistoryList);
    var help = document.getElementById('cloud-history-help'), button = document.getElementById('cloud-history-help-btn');
    if (!help || !button) return;
    function openHelp() {
      help.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      var box = button.getBoundingClientRect();
      help.style.left = Math.max(12, Math.min(box.left, window.innerWidth - help.offsetWidth - 12)) + 'px';
      help.style.top = Math.max(12, Math.min(box.bottom + 6, window.innerHeight - help.offsetHeight - 12)) + 'px';
    }
    button.addEventListener('mouseenter', openHelp);
    button.addEventListener('mouseleave', function (event) { if (!cloudHistoryHelpPinned && !help.contains(event.relatedTarget)) closeCloudHistoryHelp(); });
    help.addEventListener('mouseleave', function (event) { if (!cloudHistoryHelpPinned && !button.contains(event.relatedTarget)) closeCloudHistoryHelp(); });
    button.addEventListener('focus', openHelp);
    button.addEventListener('blur', function () { if (!cloudHistoryHelpPinned) closeCloudHistoryHelp(); });
    button.addEventListener('click', function () {
      if (cloudHistoryHelpPinned) closeCloudHistoryHelp();
      else { cloudHistoryHelpPinned = true; openHelp(); }
    });
    document.addEventListener('pointerdown', function (event) {
      if (!button.contains(event.target) && !help.contains(event.target)) closeCloudHistoryHelp();
    }, true);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !help.hidden) { closeCloudHistoryHelp(); event.stopImmediatePropagation(); }
    }, true);
    window.addEventListener('resize', closeCloudHistoryHelp);
  }

  function normalizeCloudHistoryConfig(value) {
    var result = {};
    Object.keys(cloudHistoryFields).forEach(function (key) {
      var rule = cloudHistoryFields[key], raw = value && value[key];
      var n = raw === '' || raw == null ? NaN : Number(raw);
      result[key] = Number.isFinite(n) ? Math.max(rule[1], Math.min(rule[2], Math.floor(n))) : rule[0];
    });
    return result;
  }

  function getCloudHistoryConfig() {
    return normalizeCloudHistoryConfig(deps.readStorageValue(deps.constants.CLOUD_HISTORY_CONFIG_KEY));
  }

  function fillCloudHistoryConfig() {
    var value = getCloudHistoryConfig();
    Object.keys(value).forEach(function (key) {
      var input = document.getElementById('cloud-history-' + key);
      if (input) input.value = value[key];
    });
  }

  function cloudHistoryIdentity() {
    return JSON.stringify([deps.getConfig().syncPlatform].concat(deps.getS3ConfigFields().map(function (key) { return deps.getConfig()[key]; })));
  }

  function assertCloudHistoryIdentity(identity) {
    if (deps.getConfig().syncPlatform !== 's3' || identity !== cloudHistoryIdentity()) throw new Error('云连接已变更，请重试');
  }

  async function cloudHistoryRequest(identity, method, key, body, type, headers) {
    assertCloudHistoryIdentity(identity);
    var response = await s3Request(method, key, body, type, null, headers);
    assertCloudHistoryIdentity(identity);
    return response;
  }

  async function readCloudHistoryIndex(identity) {
    var response = await cloudHistoryRequest(identity, 'GET', CLOUD_HISTORY_INDEX);
    if (!response) return { snapshots: [], etag: null, exists: false };
    var data = await response.json();
    // 损坏索引禁止覆盖；绝不根据未校验的 key 删除桶内其他文件。
    var list = Array.isArray(data) ? data : data && data.snapshots;
    if (!Array.isArray(list)) throw new Error('云端历史索引无效');
    var seen = new Set();
    list.forEach(function (item) {
      if (!item || !/^history\/mychat_backup_\d{4}-\d{2}-\d{2}_\d{6}(?:_[a-z0-9-]+)?\.gz$/.test(item.key) ||
          seen.has(item.key) || !Number.isFinite(item.timestamp) || item.timestamp <= 0 ||
          !['auto', 'pre_restore'].includes(item.reason) ||
          !['sessionCount', 'totalMessages', 'size'].every(function (key) { return Number.isSafeInteger(item[key]) && item[key] >= 0; })) {
        throw new Error('云端历史索引无效');
      }
      seen.add(item.key);
    });
    return { snapshots: list.slice().sort(function (a, b) { return b.timestamp - a.timestamp; }),
      etag: response.headers.get('ETag'), exists: true };
  }

  async function writeCloudHistoryIndex(identity, index) {
    var response = await cloudHistoryRequest(identity, 'PUT', CLOUD_HISTORY_INDEX,
      JSON.stringify({ snapshots: index.snapshots }), 'application/json');
    index.etag = response.headers.get('ETag');
    index.exists = true;
  }

  function cloudHistoryManifestFingerprint(manifest) {
    if (!manifest || !manifest.chunks) return '';
    // 只拼接主同步已算好的分块哈希，不遍历消息、不再次计算 SHA-256。
    return JSON.stringify([manifest.sessionOrder, Object.keys(manifest.chunks).sort().map(function (key) {
      return [key, manifest.chunks[key].hash];
    })]);
  }

  async function uploadCloudHistorySnapshot(json, reason, now, identity, index, metadata) {
    var time = new Date(now), pad = function (n) { return String(n).padStart(2, '0'); };
    // 随机后缀防同秒覆盖；JSON 直接压缩成二进制，与 R2 主同步一致。
    var nonce = Array.from(crypto.getRandomValues(new Uint32Array(2))).map(function (n) { return n.toString(36); }).join('-');
    var key = 'history/mychat_backup_' + deps.formatDateKey(now) + '_' + pad(time.getHours()) + pad(time.getMinutes()) + pad(time.getSeconds()) + '_' + nonce + '.gz';
    var bytes = await compressStringToGzipBytes(json);
    await cloudHistoryRequest(identity, 'PUT', key, bytes, 'application/gzip');
    var snapshot = { key: key, timestamp: now, sessionCount: metadata.sessionCount,
      totalMessages: metadata.totalMessages, size: bytes.byteLength, reason: reason,
      lastModified: metadata.lastModified, manifestFingerprint: metadata.manifestFingerprint || '' };
    index.snapshots.unshift(snapshot);
    // 索引提交失败同样视为保险失败，调用方不得开始恢复。
    await writeCloudHistoryIndex(identity, index);
    return snapshot;
  }

  function selectCloudHistoryKeep(list, now, settings) {
    var hour = 3600000, day = 24 * hour, slots = new Set(), dates = new Set(), keep = new Set();
    list.slice().sort(function (a, b) { return b.timestamp - a.timestamp; }).forEach(function (item) {
      var age = now - item.timestamp;
      if (age > settings.retentionDays * day) return;
      if (age <= settings.fineRetentionHours * hour) { keep.add(item.key); return; }
      if (age <= day) {
        var slot = Math.floor((age - settings.fineRetentionHours * hour) / (settings.sparseIntervalHours * hour));
        if (!slots.has(slot)) { slots.add(slot); keep.add(item.key); }
      } else {
        var date = deps.formatDateKey(item.timestamp);
        if (!dates.has(date)) { dates.add(date); keep.add(item.key); }
      }
    });
    return keep;
  }

  async function cleanupCloudHistory(identity, index, now, settings) {
    if (deps.getConfig().cloudHistoryPauseCleanup === true) return;
    var keep = selectCloudHistoryKeep(index.snapshots, now, settings);
    var deleted = new Set();
    try {
      for (var item of index.snapshots) {
        // 开关可在异步维护途中切换，每次 DELETE 前重新检查。
        if (deps.getConfig().cloudHistoryPauseCleanup === true) break;
        if (!keep.has(item.key)) {
          await cloudHistoryRequest(identity, 'DELETE', item.key);
          deleted.add(item.key);
        }
      }
    } finally {
      if (deleted.size) {
        index.snapshots = index.snapshots.filter(function (item) { return !deleted.has(item.key); });
        await writeCloudHistoryIndex(identity, index);
      }
    }
  }

  async function maintainS3LayeredBackup(metadata, now) {
    if (isCloudHistoryWorking) return;
    isCloudHistoryWorking = true;
    try {
      var identity = cloudHistoryIdentity(), settings = getCloudHistoryConfig();
      var index = await readCloudHistoryIndex(identity), latest = index.snapshots[0];
      var latestAuto = index.snapshots.find(function (item) { return item.reason === 'auto'; });
      // 第一关仅查看轻量索引，未满间隔绝不接触全量载荷。
      if (latestAuto && now - latestAuto.timestamp < settings.activeIntervalMinutes * 60000) return;
      var fingerprint = cloudHistoryManifestFingerprint(metadata.manifest);
      if (latest && (latest.lastModified === metadata.lastModified ||
          (fingerprint && latest.manifestFingerprint === fingerprint))) return;
      // 索引请求期间若本机变化，留待下轮主同步，避免给旧清单归档新正文。
      if (deps.getLocalLastModified() && deps.getLocalLastModified() !== metadata.lastModified) return;
      var payload = deps.buildCloudPayload(metadata.lastModified, true);
      var stats = deps.collectRestoreStats(payload);
      var snapshotMeta = { lastModified: metadata.lastModified, manifestFingerprint: fingerprint,
        sessionCount: stats.sessionsCount, totalMessages: stats.messagesCount };
      await uploadCloudHistorySnapshot(JSON.stringify(payload), 'auto', now, identity, index, snapshotMeta);
      await cleanupCloudHistory(identity, index, now, settings);
    } catch (err) {
      console.warn('[云同步] S3 历史维护跳过：', err);
    } finally { isCloudHistoryWorking = false; }
  }

  function formatCloudHistoryTime(timestamp) {
    var d = new Date(timestamp), pad = function (n) { return String(n).padStart(2, '0'); };
    return deps.formatDateKey(timestamp) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderCloudHistoryList(list) {
    var container = document.getElementById('cloud-history-list');
    if (!container) return;
    container.replaceChildren();
    if (!list.length) { container.textContent = '暂无云端历史'; return; }
    list.forEach(function (item) {
      var row = document.createElement('div'); row.className = 'cloud-history-row';
      var info = document.createElement('div');
      var time = document.createElement('time'); time.textContent = formatCloudHistoryTime(item.timestamp);
      var tag = document.createElement('span'); tag.className = 'cloud-history-tag';
      tag.textContent = item.reason === 'pre_restore' ? '恢复前备份' : '自动存档';
      var detail = document.createElement('small');
      var size = item.size >= 1048576 ? (item.size / 1048576).toFixed(2) + ' MB' : (item.size / 1024).toFixed(1) + ' KB';
      detail.textContent = item.sessionCount + ' 主对话 · ' + item.totalMessages + ' 消息 · ' + size;
      info.append(time, tag, detail);
      var button = document.createElement('button'); button.type = 'button'; button.className = 'cloud-history-icon';
      button.title = '恢复此版本'; button.setAttribute('aria-label', '恢复此版本');
      button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg>';
      button.addEventListener('click', function () { restoreCloudHistorySnapshot(item); });
      row.append(info, button); container.append(row);
    });
  }

  async function refreshCloudHistoryList() {
    var container = document.getElementById('cloud-history-list'), id = ++cloudHistoryRefreshId;
    if (!container) return;
    container.textContent = '请先保存云连接';
    if (deps.getConfig().syncPlatform !== 's3' || !isSyncConfigured()) return;
    var identity = cloudHistoryIdentity();
    container.textContent = '正在加载…';
    try {
      // 打开和刷新都只读轻量索引，不列桶、不下载历史正文。
      var index = await readCloudHistoryIndex(identity);
      if (id === cloudHistoryRefreshId) renderCloudHistoryList(index.snapshots);
    } catch (err) {
      if (id === cloudHistoryRefreshId) container.textContent = '加载失败：' + err.message;
    }
  }

  async function restoreCloudHistorySnapshot(target) {
    if (isSyncing || isCloudHistoryWorking || deps.getActiveGenerationCount()) { deps.showToast('请等待当前任务结束'); return; }
    var identity = cloudHistoryIdentity();
    if (!await window.showAppConfirm('恢复 ' + formatCloudHistoryTime(target.timestamp) + '？将先备份本机当前数据。')) return;
    if (isSyncing || isCloudHistoryWorking || deps.getActiveGenerationCount()) { deps.showToast('请等待当前任务结束'); return; }
    isSyncing = true; isCloudHistoryWorking = true;
    try {
      assertCloudHistoryIdentity(identity);
      deps.requireStorageWrite(deps.flushSave());
      var localStamp = deps.getLocalLastModified();
      var localPayload = deps.buildCloudPayload(localStamp || Date.now(), false);
      var stats = deps.collectRestoreStats(localPayload);
      var snapshotMeta = { lastModified: localPayload.lastModified,
        sessionCount: stats.sessionsCount, totalMessages: stats.messagesCount };
      var json = JSON.stringify(localPayload);
      localPayload = null;
      var index = await readCloudHistoryIndex(identity);
      if (!index.snapshots.some(function (item) { return item.key === target.key; })) throw new Error('目标历史已移除，请刷新');
      try {
        await uploadCloudHistorySnapshot(json, 'pre_restore', Date.now(), identity, index, snapshotMeta);
        json = null;
      } catch (err) { throw new Error('恢复前备份失败，已中止恢复：' + err.message); }
      // 保险提交成功后才准下载目标；不触发清理，避免误删目标或保险。
      var response = await cloudHistoryRequest(identity, 'GET', target.key);
      if (!response) throw new Error('目标历史不存在');
      var raw = await decompressGzipBytesToString(new Uint8Array(await response.arrayBuffer()));
      var data = JSON.parse(raw);
      if (data && data._encrypted === true && typeof data.payload === 'string') {
        var decoded = await decryptCloudContentAsync(data);
        data = typeof decoded === 'string' ? JSON.parse(decoded) : decoded;
      }
      if (!data || !Array.isArray(data.sessions)) throw new Error('历史数据无效');
      var payload = normalizeCloudPayloadData(data);
      // 下载期间若本机发生变化，不冒险覆盖尚未包含于保险的新数据。
      deps.requireStorageWrite(deps.flushSave());
      assertCloudHistoryIdentity(identity);
      if (deps.getActiveGenerationCount() || deps.getLocalLastModified() !== localStamp) throw new Error('本机数据已变化，请重新恢复');
      deps.applyCloudData(payload, { source: 'cloud' });
      // 历史时间不是主清单版本，不允许用它伪造自动上传的一致性基线。
      localStorage.removeItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY);
      fillCloudHistoryConfig();
      deps.showToast('已恢复，原数据已留档');
    } catch (err) { deps.showToast('恢复失败：' + err.message); }
    finally { isSyncing = false; isCloudHistoryWorking = false; refreshCloudHistoryList(); }
  }

  async function doUploadToCloud(fromSync, isManualPush, remote) {
    if (!isSyncConfigured()) return;

    // 已有上传在途：直接视为已同步，避免并发覆盖同一份 Gist
    if (uploadInFlight) {
      setSyncStatus('ok');
      return;
    }

    uploadInFlight = true;
    if (!fromSync) setSyncStatus('syncing');

    try {
      if (deps.getConfig().syncPlatform === 's3') {
        await uploadS3Data(isManualPush, remote);
        return;
      }
      var gistId = await ensureGistId();

      var now = Date.now();
      var maintainBackup = isManualPush === true || now - lastBackupUploadAt >= 30 * 60 * 1000;
      var automaticPush = !isManualPush;
      // 自动上传必须刷新远端主文件，缓存不能作为版本门禁依据。
      if (automaticPush || !cachedGistFiles || now - lastBackupUploadAt >= 30 * 60 * 1000) {
        var detail = await gistRequest('/' + encodeURIComponent(gistId), 'GET');
        cachedGistFiles = Object.assign({}, (detail && detail.files) || {});
      }
      if (automaticPush && cachedGistFiles[deps.constants.SYNC_FILE_NAME]) {
        var mainContent = await readGistFileContent(cachedGistFiles[deps.constants.SYNC_FILE_NAME]);
        var outer = deps.safeJsonParse(mainContent);
        var remoteStats = outer && outer._meta;
        if (!remoteStats || !['lastModified', 'sessionCount', 'totalMessages'].every(function (key) {
          return typeof remoteStats[key] === 'number' && Number.isFinite(remoteStats[key]) && remoteStats[key] >= 0;
        })) {
          var oldPayload = await parseGistCloudContent(mainContent, cachedGistFiles);
          if (!oldPayload && mainContent.trim()) throw new Error('云端数据解析失败，已中止同步以保护云端数据');
          remoteStats = computeCloudDataStats(oldPayload || {});
        }
        var lastSyncedCloudStamp = localStorage.getItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY) || '';
        if (!lastSyncedCloudStamp || lastSyncedCloudStamp !== String(remoteStats.lastModified)) {
          // 不在当前上传锁内递归同步；释放锁后再执行安全裁决。
          queueCloudSync(false);
          return;
        }
      }
      var existingFiles = cachedGistFiles || {};
      var stamp = Date.now();
      if (!stamp) {
        // 旧版本数据没有全局时间戳：补一个并立即落盘
        deps.touchLastModified();
        stamp = deps.getLocalLastModified() || now;
      }

      var payload = deps.buildCloudPayload(stamp, true);
      var content = await encryptCloudContentAsync(JSON.stringify(payload), createCloudMeta(payload));
      var mainFiles = buildSyncedFileMap(content, cachedGistFiles || {});
      var patchRes = await gistRequest('/' + encodeURIComponent(gistId), 'PATCH', {
        description: deps.constants.SYNC_GIST_DESC,
        files: mainFiles
      });
      // 服务端可能静默丢弃超限文件，确认主清单与新分片后才推进同步基准。
      var uploadedManifest = deps.safeJsonParse(mainFiles[deps.constants.SYNC_FILE_NAME].content);
      var savedFiles = patchRes && patchRes.files;
      var savedMain = savedFiles && savedFiles[deps.constants.SYNC_FILE_NAME];
      var incomplete = !savedMain;
      if (uploadedManifest && uploadedManifest._chunked === true && !incomplete) {
        for (var part = 0; part < uploadedManifest.totalChunks; part++) {
          if (!savedFiles[SYNC_CHUNK_PREFIX + part + '.dat']) incomplete = true;
        }
        if (typeof savedMain.content === 'string' && savedMain.content.trim()) {
          var savedManifest = deps.safeJsonParse(savedMain.content);
          if (!savedManifest || savedManifest._chunked !== true ||
              savedManifest.totalChunks !== uploadedManifest.totalChunks ||
              savedManifest.expectedLength !== uploadedManifest.expectedLength) incomplete = true;
        }
      }
      if (incomplete) {
        throw new Error('Gist 服务端未完整保存全部分片（可能触发了单 Gist 10 文件数量限制）');
      }
      cachedGistFiles = Object.assign({}, savedFiles);
      localStorage.setItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY, String(stamp));
      lastSyncAt = Date.now();
      setSyncStatus('ok');

      if (!maintainBackup) return;
      // 主同步已成功；手动推送或每 30 分钟维护一次快照，失败不标记完成。
      var backupFiles = {};
      var todayBackupName = deps.constants.BACKUP_PREFIX + deps.formatDateKey(now) + '.json';
      if (content.length <= BACKUP_MAX_SIZE) backupFiles[todayBackupName] = { content: content };

      var todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      var todayStamp = todayStart.getTime();
      var removed = 0;

      Object.keys(existingFiles).forEach(function (name) {
        if (!name || name.indexOf(deps.constants.BACKUP_PREFIX) !== 0) return;

        var dateText = name.slice(deps.constants.BACKUP_PREFIX.length).replace(/\.json$/i, '');
        var parts = dateText.split('-');
        if (parts.length !== 3) return;

        var fileStamp = new Date(
          Number(parts[0]),
          Number(parts[1]) - 1,
          Number(parts[2])
        ).getTime();
        if (!isFinite(fileStamp)) return;

        // 巨型单文件全部删除（含今日旧文件）；小型今日快照保留覆盖结果。
        var oldFile = existingFiles[name] || {};
        var oversized = Number(oldFile.size) > BACKUP_MAX_SIZE ||
          (typeof oldFile.content === 'string' && oldFile.content.length > BACKUP_MAX_SIZE);
        if (oversized || (name !== todayBackupName && todayStamp - fileStamp > 7 * 24 * 3600 * 1000)) {
          backupFiles[name] = null; // Gitee / GitHub Gist 标准删除文件语法
          removed++;
        }
      });

      if (Object.keys(backupFiles).length > 0) {
        try {
          var backupRes = await gistRequest('/' + encodeURIComponent(gistId), 'PATCH', {
            description: deps.constants.SYNC_GIST_DESC,
            files: backupFiles
          });
          cachedGistFiles = Object.assign({}, backupRes.files || cachedGistFiles);
          lastBackupUploadAt = Date.now();
          try { localStorage.setItem(deps.constants.LAST_BACKUP_MAINT_AT_KEY, String(lastBackupUploadAt)); } catch (e) {}
          console.log('[云同步] 快照备份已更新，清理旧备份 ' + removed + ' 个');
        } catch (backupErr) {
          console.warn('[云同步] 快照备份更新跳过：', backupErr);
        }
      } else {
        lastBackupUploadAt = Date.now();
        try { localStorage.setItem(deps.constants.LAST_BACKUP_MAINT_AT_KEY, String(lastBackupUploadAt)); } catch (e) {}
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
    cloudSyncPausedByCancel = false;
    if (isSyncing || syncInFlight || uploadInFlight) return;
    if (deps.getActiveGenerationCount() > 0) { await window.showAppAlert('请等待回复结束'); return; }
    var platform = deps.getEls().cfgSyncPlatform.value;
    var token = deps.getEls().cfgSyncToken.value.trim();
    var gist = deps.getEls().cfgGistId.value.trim();
    if (platform === 's3' ? !deps.getS3ConfigFields().every(function (key) { return document.getElementById(s3FieldId(key)).value.trim(); }) : !token) {
      await window.showAppAlert('请填写完整云配置'); return;
    }
    if (direction === 'pull' && !await window.showAppConfirm('云端将覆盖本机，继续？')) {
      pauseCloudSyncByCancel();
      return;
    }
    if (deps.getActiveGenerationCount() > 0 || isSyncing || syncInFlight || uploadInFlight) return;
    if ((platform !== deps.getConfig().syncPlatform || token !== deps.getConfig().syncToken) && gist === deps.getConfig().gistId) gist = '';
    deps.getConfig().syncPlatform = platform;
    deps.getConfig().syncToken = token;
    deps.getConfig().gistId = gist;
    deps.getConfig().autoSync = document.getElementById('cfg-auto-sync').checked;
    deps.getS3ConfigFields().forEach(function (key) { deps.getConfig()[key] = document.getElementById(s3FieldId(key)).value.trim(); });
    deps.persistConfig(true);
    if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }
    isSyncing = true;
    setSyncStatus('syncing');
    try {
      if (platform !== 's3' && !deps.getConfig().gistId) await ensureGistId(direction === 'pull');
      if (direction === 'push') {
        await doUploadToCloud(false, true);
      } else {
        var remote = await fetchCloudData(true);
        if (!remote.payload) throw new Error('云端数据无效');
        deps.applyCloudData(remote.payload, { source: 'cloud' });
        localStorage.setItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY, String(Number(remote.lastModified || remote.payload.lastModified) || 0));
        lastSyncAt = Date.now();
        setSyncStatus('ok');
      }
      if (deps.getEls().cfgGistId) deps.getEls().cfgGistId.value = deps.getConfig().gistId;
    } catch (err) {
      handleSyncError(err);
    } finally {
      isSyncing = false;
    }
  }

  function scheduleCloudUpload() {
    if (cloudSyncPausedByCancel) return;
    if (deps.getIsBooting() || deps.getApplyingCloudData() || !deps.getIsStartupSyncSettled()) return;
    if (!deps.getConfig().autoSync || !isSyncConfigured()) return;
    if (uploadTimer) clearTimeout(uploadTimer);
    uploadTimer = setTimeout(function () {
      uploadTimer = null;
      if (!cloudSyncPausedByCancel && deps.getConfig().autoSync && !deps.getIsBooting() && !deps.getApplyingCloudData() && deps.getIsStartupSyncSettled()) uploadToCloud(false);
    }, deps.constants.UPLOAD_DELAY_MS);
  }

  /**
   * 双向同步主入口：打开软件、点击状态按钮、保存配置后触发
   * @param {boolean} silent 静默模式（未配置时不弹窗）
   * @param {boolean} retried 是否已因 Gist 失效重试过
   */
  async function syncWithCloud(silent, retried, isManual) {
    if (isCloudHistoryWorking) {
      if (!silent) deps.showToast('请等待历史存档结束');
      return;
    }
    if (isManual === true) cloudSyncPausedByCancel = false;
    else if (cloudSyncPausedByCancel) return;
    if (silent && !deps.getConfig().autoSync) { deps.setIsStartupSyncSettled(true); return; }
    // 兼容旧版仅填令牌自动发现，实际同步仍需完整连接。
    if (deps.getConfig().syncPlatform !== 's3' && deps.getConfig().syncToken && !deps.getConfig().gistId) {
      if (isSyncing || syncInFlight || uploadInFlight) return;
      isSyncing = true;
      try { await ensureGistId(); }
      catch (err) { deps.setIsStartupSyncSettled(true); handleSyncError(err); return; }
      finally { isSyncing = false; }
    }
    if (!isSyncConfigured()) {
      deps.setIsStartupSyncSettled(true);
      renderSyncStatus();
      if (!silent) {
        await window.showAppAlert('请填写完整云配置');
      }
      return;
    }

    // 正在生成 AI 回复时不做双向同步，避免云端覆盖打断当前输出
    if (deps.getActiveGenerationCount() > 0) {
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
      var remote = await fetchCloudData(deps.getConfig().syncPlatform === 's3' ? { onlyMeta: true } : undefined);

      // 元数据响应没有正文，不能误判为空桶。
      if (!remote.onlyMeta && !remote.payload) {
        await doUploadToCloud(true, false, deps.getConfig().syncPlatform === 's3' ? remote : undefined);
        return;
      }
      if (remote.onlyMeta && remote.lastModified === deps.getLocalLastModified()) {
        localStorage.setItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY, String(remote.lastModified));
        lastSyncAt = Date.now();
        setSyncStatus('ok');
        return;
      }
      // 仅在实际采用云端版本时下载本体，同一轮最多下载一次。
      async function applyRemoteData() {
        if (remote.onlyMeta) remote = await fetchCloudData({ onlyMeta: false });
        if (!remote.payload) throw new Error('云端数据无效');
        await deps.applyCloudData(remote.payload, { source: 'cloud' });
        localStorage.setItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY, String(Number(remote.lastModified || remote.payload.lastModified) || 0));
      }
      var remoteMeaningful = remote.onlyMeta ? true : remoteHasMeaningfulData(remote.payload);
      var remoteStats = remote.onlyMeta ? Object.assign({ sessionCount: 0, totalMessages: 0 }, remote.meta || {},
        { lastModified: remote.lastModified }) : computeCloudDataStats(remote.payload);
      var localStats = computeLocalDataStats();
      var remoteStamp = remoteStats.lastModified;
      var localStamp = localStats.lastModified;
      var lastSyncedCloudStamp = localStorage.getItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY) || '';

      // 本机还没有任何聊天内容（例如手机刚填好 Token）：
      // 直接采用云端数据，避免空数据把电脑上的历史记录覆盖掉
      if (remoteMeaningful && !hasMeaningfulLocalData()) {
        await applyRemoteData();
        lastSyncAt = Date.now();
        setSyncStatus('ok');
        console.log('[云同步] 本机无聊天记录，已拉取云端数据');
        return;
      }

      if (remoteStamp > localStamp) {
        // 另一台设备有新记录：云端覆盖本地
        await applyRemoteData();
        lastSyncAt = Date.now();
        setSyncStatus('ok');
        console.log(
          '[云同步] 云端数据更新，已覆盖本地（云端 ' + remoteStamp + ' / 本地 ' + localStamp + '）'
        );
      } else if (localStamp > remoteStamp) {
        var suspicious = !lastSyncedCloudStamp || lastSyncedCloudStamp !== String(remoteStamp);
        if (suspicious) {
          var preferCloud = await window.showAppConfirm('检测到云端与本机数据存在版本差异：\n• 云端：' + remoteStats.sessionCount + ' 个会话 / 共 ' + remoteStats.totalMessages + ' 层消息\n• 本机：' + localStats.sessionCount + ' 个会话 / 共 ' + localStats.totalMessages + ' 层消息\n\n点击「确定」拉取云端最新数据覆盖本机；点击「取消」暂不同步（保留本机现状，不覆盖云端）。');
          if (!preferCloud) { pauseCloudSyncByCancel(); setSyncStatus('已暂停同步', ''); return; }
          if (deps.getActiveGenerationCount() > 0) { queueCloudSync(silent); return; }
          if (preferCloud) {
            await applyRemoteData();
            lastSyncAt = Date.now();
            setSyncStatus('ok');
          }
        } else {
          await doUploadToCloud(true, false, deps.getConfig().syncPlatform === 's3' ? remote : undefined);
        }
      } else {
        // 时间戳一致：按基线血统视为已对齐，不按数量逆流覆盖本地删除。
        localStorage.setItem(deps.constants.LAST_SYNCED_CLOUD_STAMP_KEY, String(remoteStamp));
        lastSyncAt = Date.now();
        setSyncStatus('ok');
      }
    } catch (err) {
      // 本地保存的 Gist 可能已被删除（404）或无权访问（401/403）：清空后重试一次
      if (
        !retried &&
        deps.getConfig().gistId &&
        /HTTP 40[134]/.test(String(err && err.message))
      ) {
        deps.getConfig().gistId = '';
        deps.persistConfig(true);
        syncInFlight = false;
        isSyncing = false;
        return await syncWithCloud(silent, true);
      }
      handleSyncError(err);
    } finally {
      syncInFlight = false;
      isSyncing = false;
      deps.setIsStartupSyncSettled(true);
    }
  }

  // 云同步迁移正文结束

  window.MyChatCloudSync = {
    init: init,
    scheduleCloudUpload: scheduleCloudUpload,
    cancelScheduledUpload: cancelScheduledUpload,
    syncWithCloud: syncWithCloud,
    requestForegroundCloudSync: requestForegroundCloudSync,
    manualCloudSync: manualCloudSync,
    isSyncConfigured: isSyncConfigured,
    setSyncStatus: setSyncStatus,
    renderSyncStatus: renderSyncStatus,
    getSyncConfig: getSyncConfig,
    s3FieldId: s3FieldId,
    updateSyncProviderFields: updateSyncProviderFields,
    fillCloudHistoryConfig: fillCloudHistoryConfig,
    refreshCloudHistoryList: refreshCloudHistoryList,
    closeCloudHistoryHelp: closeCloudHistoryHelp,
    initCloudHistoryUi: initCloudHistoryUi,
    parseCloudPayload: parseCloudPayload,
    normalizeCloudHistoryConfig: normalizeCloudHistoryConfig,
    getCloudHistoryConfig: getCloudHistoryConfig,
    base64ToUtf8: base64ToUtf8
  };
})();
