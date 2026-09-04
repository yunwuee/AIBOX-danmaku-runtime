import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { normalizeSourceText } from '../scripts/lib/import-graph.mjs';
import { fromRoot, readJson } from '../scripts/lib/project.mjs';

test('normalizes source bytes independently of checkout line endings', () => {
  const unixSource = 'import value from "./value.js";\nexport default value;\n';
  const windowsSource = unixSource.replace(/\n/g, '\r\n');
  assert.equal(normalizeSourceText(windowsSource), unixSource);
  assert.equal(Buffer.byteLength(normalizeSourceText(windowsSource)), Buffer.byteLength(unixSource));
});

test('allows the Node HTTP transports used by the upstream request fallback', async () => {
  const policy = await readJson(fromRoot('config', 'runtime-policy.json'));
  for (const builtin of ['node:http', 'node:https', 'http', 'https']) {
    assert.ok(policy.allowedNodeBuiltins.includes(builtin), `missing allowlist entry: ${builtin}`);
  }
});

test('locks a reviewed upstream commit and records replacements', async () => {
  const lock = await readJson(fromRoot('upstream.lock.json'));
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  assert.equal(lock.repository, 'https://github.com/huangxd-/danmu_api.git');
  assert.ok(lock.fileCount > 10);
  const replacedTargets = new Set(lock.replacements.map((entry) => entry.target));
  assert.ok(replacedTargets.has('danmu_api/utils/redis-util.js'));
  assert.ok(replacedTargets.has('danmu_api/utils/local-redis-util.js'));
  assert.ok(replacedTargets.has('danmu_api/sources/migu.js'));
});

test('generated source cannot re-enable excluded local services', async () => {
  const globals = await readFile(fromRoot('generated', 'upstream', 'danmu_api', 'configs', 'globals.js'), 'utf8');
  const migu = await readFile(fromRoot('generated', 'upstream', 'danmu_api', 'sources', 'migu.js'), 'utf8');
  const redis = await readFile(fromRoot('generated', 'upstream', 'danmu_api', 'utils', 'redis-util.js'), 'utf8');
  assert.doesNotMatch(globals, /127\.0\.0\.1:5321\/proxy/);
  assert.doesNotMatch(migu, /WebAssembly|WASM_BASE64/);
  assert.doesNotMatch(redis, /from ['"]redis['"]|createClient/);
});
