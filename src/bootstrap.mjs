import fetch, {
  Blob,
  File,
  FormData,
  Headers,
  Request,
  Response,
} from 'node-fetch';

const RUNTIME_VERSION = __AIBOX_RUNTIME_VERSION__;
const UPSTREAM_COMMIT = __AIBOX_UPSTREAM_COMMIT__;
const UPSTREAM_VERSION = __AIBOX_UPSTREAM_VERSION__;
const RUNTIME_API = 1;
const ENGINE_API = 1;
const DEFAULT_PREFIX = '/internal/danmaku';
const DEFAULT_SOURCES = Object.freeze([
  'dandan',
  'bilibili',
  'qq',
  'qiyi',
  'imgo',
  'youku',
  'sohu',
  'leshi',
  'xigua',
  'renren',
  'hanjutv',
  'bahamut',
  'animeko',
  'douban',
  '360',
]);
const ALLOWED_SOURCES = new Set(DEFAULT_SOURCES);

let upstreamPromise;
let initialized = false;
let startedAt;
let activeSources = [...DEFAULT_SOURCES];

function installFetchPolyfills() {
  Object.assign(globalThis, {
    fetch,
    Blob,
    File,
    FormData,
    Headers,
    Request,
    Response,
  });
}

async function loadUpstream() {
  installFetchPolyfills();
  upstreamPromise ??= Promise.all([
    import('../generated/upstream/danmu_api/apis/dandan-api.js'),
    import('../generated/upstream/danmu_api/configs/globals.js'),
  ]).then(([api, config]) => ({ api, config }));
  return upstreamPromise;
}

function normalizePrefix(value) {
  const prefix = String(value || DEFAULT_PREFIX).trim();
  if (!prefix.startsWith('/') || prefix.includes('?') || prefix.includes('#')) {
    throw new TypeError('Danmaku runtime prefix must be an absolute path');
  }
  return prefix.length > 1 ? prefix.replace(/\/+$/, '') : prefix;
}

function normalizeSources(value) {
  if (value == null) return [...DEFAULT_SOURCES];
  if (!Array.isArray(value)) {
    throw new TypeError('Danmaku runtime sources must be an array');
  }
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const source = String(item || '').trim();
    if (!ALLOWED_SOURCES.has(source) || seen.has(source)) continue;
    seen.add(source);
    result.push(source);
  }
  return result;
}

function createRuntimeEnvironment(sources) {
  return Object.freeze({
    TOKEN: 'aibox-internal',
    ADMIN_TOKEN: '',
    SOURCE_ORDER: sources.join(','),
    USE_BANGUMI_DATA: 'false',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
    LOCAL_REDIS_URL: '',
    PROXY_URL: '',
    CUSTOM_SOURCE_API_URL: '',
    AI_API_KEY: '',
    RATE_LIMIT_MAX_REQUESTS: '0',
    DANMU_OUTPUT_FORMAT: 'json',
  });
}

function createUrl(request, pathname, searchParams) {
  const rawUrl = request?.raw?.url || request?.url || '/';
  const incoming = new URL(rawUrl, 'http://127.0.0.1');
  const target = new URL(pathname, 'http://127.0.0.1');
  target.search = incoming.search;
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value != null && value !== '') target.searchParams.set(key, value);
    }
  }
  return target;
}

async function sendFetchResponse(reply, response) {
  const status = Number(response?.status || 500);
  const contentType = response?.headers?.get?.('content-type') || 'application/json; charset=utf-8';
  const body = await response.text();
  reply.code(status);
  reply.header('content-type', contentType);
  reply.header('cache-control', 'no-store');
  return reply.send(body);
}

function safeLogger(logger) {
  const target = logger && typeof logger === 'object' ? logger : {};
  return {
    info: typeof target.info === 'function' ? target.info.bind(target) : () => {},
    error: typeof target.error === 'function' ? target.error.bind(target) : () => {},
  };
}

function wrapHandler(logger, operation, handler) {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      logger.error({
        component: 'danmaku-runtime',
        operation,
        errorCategory: error?.name || 'Error',
      }, 'Danmaku runtime request failed');
      reply.code(502);
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('cache-control', 'no-store');
      return reply.send(JSON.stringify({
        success: false,
        errorCode: 502,
        errorMessage: 'Local danmaku runtime request failed',
      }));
    }
  };
}

export async function registerDanmakuRuntime(options = {}) {
  const fastify = options.fastify;
  if (!fastify || typeof fastify.get !== 'function') {
    throw new TypeError('registerDanmakuRuntime requires a Fastify-compatible host');
  }

  if (initialized) {
    return getDanmakuRuntimeInfo();
  }

  const prefix = normalizePrefix(options.prefix);
  const logger = safeLogger(options.logger || fastify.log);
  activeSources = normalizeSources(options.sources);
  const { api, config } = await loadUpstream();
  config.Globals.init(createRuntimeEnvironment(activeSources));
  config.globals.deployPlatform = 'aibox';

  fastify.get(`${prefix}/health`, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      ok: true,
      runtimeVersion: RUNTIME_VERSION,
      runtimeApi: RUNTIME_API,
      engineApi: ENGINE_API,
      upstreamVersion: UPSTREAM_VERSION,
      upstreamCommit: UPSTREAM_COMMIT.slice(0, 12),
      nodeVersion: process.versions.node,
      providers: {
        enabled: activeSources.length,
      },
    };
  });

  fastify.get(`${prefix}/info`, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return getDanmakuRuntimeInfo();
  });

  fastify.get(`${prefix}/api/v2/search/anime`, wrapHandler(
    logger,
    'searchAnime',
    async (request, reply) => sendFetchResponse(
      reply,
      await api.searchAnime(createUrl(request, '/api/v2/search/anime')),
    ),
  ));

  fastify.get(`${prefix}/api/v2/search/episodes`, wrapHandler(
    logger,
    'searchEpisodes',
    async (request, reply) => sendFetchResponse(
      reply,
      await api.searchEpisodes(createUrl(request, '/api/v2/search/episodes')),
    ),
  ));

  fastify.get(`${prefix}/api/v2/comment/:id`, wrapHandler(
    logger,
    'getComment',
    async (request, reply) => {
      const id = String(request?.params?.id || '').trim();
      if (!/^\d+$/.test(id)) {
        reply.code(400);
        return reply.send({
          success: false,
          errorCode: 400,
          errorMessage: 'Invalid comment id',
        });
      }
      const url = createUrl(request, `/api/v2/comment/${id}`, { format: 'json' });
      return sendFetchResponse(
        reply,
        await api.getComment(url.pathname, 'json', false, '127.0.0.1', false),
      );
    },
  ));

  initialized = true;
  startedAt = new Date().toISOString();
  logger.info({
    component: 'danmaku-runtime',
    runtimeVersion: RUNTIME_VERSION,
    upstreamCommit: UPSTREAM_COMMIT.slice(0, 12),
    providerCount: activeSources.length,
  }, 'Danmaku runtime registered');
  return getDanmakuRuntimeInfo();
}

export function getDanmakuRuntimeInfo() {
  return {
    running: initialized,
    runtimeVersion: RUNTIME_VERSION,
    runtimeApi: RUNTIME_API,
    engineApi: ENGINE_API,
    upstreamVersion: UPSTREAM_VERSION,
    upstreamCommit: UPSTREAM_COMMIT.slice(0, 12),
    startedAt: startedAt || null,
    providers: {
      enabled: activeSources.length,
      ids: [...activeSources],
    },
  };
}

export const danmakuRuntimeMetadata = Object.freeze({
  runtimeVersion: RUNTIME_VERSION,
  runtimeApi: RUNTIME_API,
  engineApi: ENGINE_API,
  upstreamVersion: UPSTREAM_VERSION,
  upstreamCommit: UPSTREAM_COMMIT,
  minimumNodeVersion: '18.20.4',
});
