import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, '..');
const bundlePath = resolve(
  process.argv[2] ??
    resolve(
      repositoryRoot,
      'third_party/aibox-engine/runtime/danmaku/runtime.bundle.cjs',
    ),
);
const manifestPath = resolve(
  process.argv[3] ?? resolve(bundlePath, '..', 'manifest.json'),
);
const marker = 'function withSourcePipelineDeadline';

function replaceOnce(source, before, after, label) {
  const firstIndex = source.indexOf(before);
  if (firstIndex < 0 || source.indexOf(before, firstIndex + before.length) >= 0) {
    throw new Error(`Unable to apply unique runtime patch: ${label}`);
  }
  return source.slice(0, firstIndex) + after + source.slice(firstIndex + before.length);
}

function patchFunction(source, startMarker, endMarker, transform) {
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Unable to locate runtime function: ${startMarker}`);
  }
  const original = source.slice(startIndex, endIndex);
  const patched = transform(original);
  return source.slice(0, startIndex) + patched + source.slice(endIndex);
}

function patchRetryContext(block, label) {
  const match = block.match(/^  let maxRetries = .*lastError;$/m);
  if (!match || block.includes('searchContext && (maxRetries = 0)')) {
    throw new Error(`Unable to apply unique runtime patch: ${label}`);
  }
  const declaration = match[0].replace(
    '  let maxRetries =',
    '  let searchContext = sourceSearchContext?.getStore(), maxRetries =',
  );
  return replaceOnce(
    block,
    match[0],
    `${declaration}\n  searchContext && (maxRetries = 0);`,
    label,
  );
}

function patchRuntime(source) {
  source = patchFunction(
    source,
    'async function httpGet(url, options = {}) {',
    'async function httpPost(url, body, options = {}) {',
    (block) => {
      block = patchRetryContext(block, 'httpGet retry context');
      block = replaceOnce(
        block,
        'cleanupSignal = linkSignal(options.signal, controller);',
        'cleanupSignal = linkSignal(options.signal, controller), cleanupSearchSignal = linkSignal(searchContext?.signal, controller);',
        'httpGet abort context',
      );
      return replaceOnce(
        block,
        '      cleanupSignal();',
        '      cleanupSignal(), cleanupSearchSignal();',
        'httpGet cleanup',
      );
    },
  );
  source = patchFunction(
    source,
    'async function httpPost(url, body, options = {}) {',
    'async function getPageTitle(url) {',
    (block) => {
      block = patchRetryContext(block, 'httpPost retry context');
      block = replaceOnce(
        block,
        'cleanupSignal = linkSignal(options.signal, controller)',
        'cleanupSignal = linkSignal(options.signal, controller), cleanupSearchSignal = linkSignal(searchContext?.signal, controller)',
        'httpPost abort context',
      );
      return replaceOnce(
        block,
        '      cleanupSignal();',
        '      cleanupSignal(), cleanupSearchSignal();',
        'httpPost cleanup',
      );
    },
  );
  const httpUtilHeaderPattern = /var [^\n]*sourceLogContext[^\n]*init_http_util = __esm\(\{/;
  const httpUtilHeaderMatch = source.match(httpUtilHeaderPattern);
  if (!httpUtilHeaderMatch || httpUtilHeaderMatch[0].includes('sourceSearchContext')) {
    throw new Error('Unable to locate unique HTTP utility context declaration');
  }
  source = replaceOnce(
    source,
    httpUtilHeaderMatch[0],
    httpUtilHeaderMatch[0].replace(
      'sourceLogContext,',
      'sourceLogContext, sourceSearchContext,',
    ),
    'search context declaration',
  );
  source = replaceOnce(
    source,
    'sourceLogContext = new import_node_async_hooks.AsyncLocalStorage(),',
    'sourceLogContext = new import_node_async_hooks.AsyncLocalStorage(), sourceSearchContext = new import_node_async_hooks.AsyncLocalStorage(),',
    'search context initialization',
  );
  source = replaceOnce(
    source,
    'async function executeSourceHandlers(resultData, queryTitle, targetAnimesList, requestAnimeDetailsMap, targetSeason, preferAnimeId = null, preferSource = null) {',
    'var sourcePipelineTimeoutMs = 15e3;\nfunction withSourcePipelineDeadline(source, operation, timeoutMs = sourcePipelineTimeoutMs) {\n  let controller = new AbortController(), timeoutId, timeoutPromise = new Promise((_, reject) => {\n    timeoutId = setTimeout(() => {\n      controller.abort();\n      let error = new Error(`Source ${source} exceeded ${timeoutMs}ms deadline`);\n      error.name = "SourceTimeoutError", error.timeoutMs = timeoutMs, reject(error);\n    }, timeoutMs);\n  }), operationPromise = sourceSearchContext.run({ signal: controller.signal }, operation);\n  return Promise.race([operationPromise, timeoutPromise]).finally(() => clearTimeout(timeoutId));\n}\nasync function executeSourceHandlers(resultData, queryTitle, targetAnimesList, requestAnimeDetailsMap, targetSeason, preferAnimeId = null, preferSource = null) {',
    'source deadline helper',
  );

  const deferredSearchCall = 'sourceSearchMap[source] = sourceLogContext.run(meta.logName, () => meta.instance.search(...args));';
  if (source.includes(deferredSearchCall)) {
    source = replaceOnce(
      source,
      deferredSearchCall,
      'sourceSearchMap[source] = () => sourceLogContext.run(meta.logName, () => meta.instance.search(...args));',
      'deferred source search call',
    );
  } else {
    const searchMapPattern = /let resultData = \{\}, sourceSearchMap = \{\};\r?\n    for \(let source of globals\.sourceOrderArr\)\r?\n      ([^\r\n]+);\r?\n    let pipelineTasks/;
    const searchMapMatch = source.match(searchMapPattern);
    if (!searchMapMatch) {
      throw new Error('Unable to locate source search map');
    }
    let searchExpression = searchMapMatch[1]
      .replaceAll('sourceSearchMap[source] = ', '')
      .replace('source === "animeko" && (', 'source === "animeko" ? ');
    if (!searchExpression.endsWith(')')) {
      throw new Error('Unexpected source search expression');
    }
    searchExpression = `${searchExpression.slice(0, -1)} : Promise.resolve([])`;
    source = source.replace(
      searchMapPattern,
      `let resultData = {}, sourceSearchMap = {};\n    for (let source of globals.sourceOrderArr)\n      sourceSearchMap[source] = () => ${searchExpression};\n    let pipelineTasks`,
    );
  }
  source = replaceOnce(
    source,
    '      let isolatedAnimes = [], isolatedDetailStore = /* @__PURE__ */ new Map(), pipelinePromise = sourceSearchMap[source].then(async (searchResult) => {\n        resultData[source] = searchResult, await executeSourceHandlers({ [source]: searchResult }, queryTitle, isolatedAnimes, isolatedDetailStore, querySeason, preferAnimeId, preferSource);\n      });',
    '      let isolatedAnimes = [], isolatedDetailStore = /* @__PURE__ */ new Map(), pipelinePromise = withSourcePipelineDeadline(source, async () => {\n        let searchResult = await sourceSearchMap[source]();\n        resultData[source] = searchResult, await executeSourceHandlers({ [source]: searchResult }, queryTitle, isolatedAnimes, isolatedDetailStore, querySeason, preferAnimeId, preferSource);\n      });',
    'source pipeline deadline',
  );
  source = replaceOnce(
    source,
    '        log("error", `[system] [searchAnime] 源 ${pipelineTasks[i2].key} 管道处理失败: ${pipelineResults[i2].reason}`);',
    '        let reason = pipelineResults[i2].reason;\n        reason?.name === "SourceTimeoutError" ? log("warn", `[system] [searchAnime] 源 ${pipelineTasks[i2].key} 超过 ${reason.timeoutMs || sourcePipelineTimeoutMs}ms，已跳过并继续返回其他站点结果`) : log("error", `[system] [searchAnime] 源 ${pipelineTasks[i2].key} 管道处理失败: ${reason}`);',
    'source timeout logging',
  );
  source = replaceOnce(
    source,
    '  let prefix = normalizePrefix(options.prefix), logger = safeLogger(options.logger || fastify.log);',
    '  let prefix = normalizePrefix(options.prefix), logger = safeLogger(options.logger || fastify.log), requestedSourceTimeout = Number(options.sourceTimeoutMs), requestedLogLevel = ["error", "warn", "info"].includes(String(process.env.LOG_LEVEL || "").toLowerCase()) ? String(process.env.LOG_LEVEL).toLowerCase() : "warn";\n  sourcePipelineTimeoutMs = Number.isFinite(requestedSourceTimeout) && requestedSourceTimeout >= 50 && requestedSourceTimeout <= 45e3 ? Math.trunc(requestedSourceTimeout) : 15e3;',
    'runtime source timeout option',
  );
  source = replaceOnce(
    source,
    'function createRuntimeEnvironment(sources) {',
    'function createRuntimeEnvironment(sources, logLevel) {',
    'runtime log environment signature',
  );
  source = replaceOnce(
    source,
    '    AI_API_KEY: "",\n    RATE_LIMIT_MAX_REQUESTS: "0",',
    '    AI_API_KEY: "",\n    LOG_LEVEL: logLevel,\n    RATE_LIMIT_MAX_REQUESTS: "0",',
    'runtime default log level',
  );
  source = replaceOnce(
    source,
    'config.Globals.init(createRuntimeEnvironment(activeSources))',
    'config.Globals.init(createRuntimeEnvironment(activeSources, requestedLogLevel))',
    'runtime log environment usage',
  );
  return source;
}

let bundle = readFileSync(bundlePath, 'utf8');
if (!bundle.includes(marker)) {
  bundle = patchRuntime(bundle);
  writeFileSync(bundlePath, bundle, 'utf8');
}
for (const requiredMarker of [
  marker,
  'sourceSearchContext',
  'SourceTimeoutError',
  'searchContext && (maxRetries = 0)',
  'controller.abort()',
  'requestedSourceTimeout',
  'LOG_LEVEL: logLevel',
]) {
  if (!bundle.includes(requiredMarker)) {
    throw new Error(`Patched runtime is missing marker: ${requiredMarker}`);
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.sha256 = createHash('sha256').update(Buffer.from(bundle)).digest('hex');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`Patched danmaku runtime: ${manifest.sha256}\n`);
