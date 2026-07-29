import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

import { FastifyFixture } from '../fixtures/fastify-fixture.mjs';

const require = createRequire(import.meta.url);
const runtime = require('../dist/runtime.bundle.cjs');
const app = new FastifyFixture();
after(() => app.close());

test('registers only the AIBOX internal danmaku surface', async () => {
  const info = await runtime.registerDanmakuRuntime({
    fastify: app,
    sources: ['dandan', 'bilibili', 'migu', 'dandan'],
  });
  await app.ready();
  assert.equal(info.running, true);
  assert.deepEqual(info.providers.ids, ['dandan', 'bilibili']);
  assert.equal(app.hasRoute({ method: 'GET', url: '/internal/danmaku/health' }), true);
  assert.equal(app.hasRoute({ method: 'GET', url: '/internal/danmaku/info' }), true);
  assert.equal(app.hasRoute({ method: 'GET', url: '/internal/danmaku/api/v2/search/anime' }), true);
  assert.equal(app.hasRoute({ method: 'GET', url: '/internal/danmaku/api/v2/search/episodes' }), true);
  assert.equal(app.hasRoute({ method: 'GET', url: '/internal/danmaku/api/v2/comment/:id' }), true);
  assert.doesNotMatch(app.printRoutes(), /api\/deploy|api\/env|api\/logs|api\/config/);
});

test('health response exposes compatibility metadata without secrets', async () => {
  const response = await app.inject({ method: 'GET', url: '/internal/danmaku/health' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.runtimeApi, 1);
  assert.equal(body.engineApi, 1);
  assert.match(body.upstreamCommit, /^[0-9a-f]{12}$/);
  assert.equal(body.providers.enabled, 2);
  assert.doesNotMatch(response.body, /TOKEN|ADMIN_TOKEN|127\.0\.0\.1:5321/);
});

test('rejects non-numeric comment identities before upstream access', async () => {
  const response = await app.inject({ method: 'GET', url: '/internal/danmaku/api/v2/comment/not-an-id' });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    success: false,
    errorCode: 400,
    errorMessage: 'Invalid comment id',
  });
});
