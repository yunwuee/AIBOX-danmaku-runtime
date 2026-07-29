import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { unzipSync } from 'fflate';

import { fromRoot, hashFile, readJson } from './lib/project.mjs';

const require = createRequire(import.meta.url);
const policy = await readJson(fromRoot('config', 'runtime-policy.json'));
const runtimeManifest = await readJson(fromRoot('dist', 'manifest.json'));
const releaseManifest = await readJson(fromRoot('artifacts', 'release-manifest.json'));
const bundlePath = fromRoot('dist', runtimeManifest.entrypoint);
const bundle = await readFile(bundlePath, 'utf8');
const forbidden = [
  ['standalone server', /\.listen\s*\(|\bcreateServer\s*\(/],
  ['local forward proxy', /127\.0\.0\.1:5321\/proxy/],
  ['Redis client', /require\(["']redis["']\)/],
  ['file watcher', /require\(["']chokidar["']\)/],
  ['proxy agent', /https-proxy-agent/],
  ['WASM instantiation', /WebAssembly\.instantiate/],
  ['deployment API', /\/api\/deploy/],
  ['environment management API', /\/api\/env/],
];
for (const [label, pattern] of forbidden) {
  if (pattern.test(bundle)) throw new Error(`Forbidden runtime capability found: ${label}`);
}

const exported = require(bundlePath);
if (typeof exported.registerDanmakuRuntime !== 'function') throw new Error('Runtime entrypoint export is missing');
if (typeof exported.getDanmakuRuntimeInfo !== 'function') throw new Error('Runtime info export is missing');
if (exported.danmakuRuntimeMetadata?.minimumNodeVersion !== '18.20.4') throw new Error('Unexpected minimum Node version');
if (exported.danmakuRuntimeMetadata?.upstreamCommit !== runtimeManifest.upstream.commit) {
  throw new Error('Bundled upstream commit does not match manifest');
}

if (await hashFile(bundlePath) !== runtimeManifest.sha256) throw new Error('Bundle SHA-256 mismatch');
const artifactName = path.basename(new URL(releaseManifest.downloadUrl).pathname);
const artifactPath = fromRoot('artifacts', artifactName);
const artifactInfo = await stat(artifactPath);
if (artifactInfo.size !== releaseManifest.size) throw new Error('Artifact size mismatch');
if (artifactInfo.size > policy.limits.maxArtifactBytes) throw new Error('Artifact exceeds configured size limit');
if (await hashFile(artifactPath) !== releaseManifest.sha256) throw new Error('Artifact SHA-256 mismatch');

const expectedEntries = new Set([...runtimeManifest.files, 'manifest.json']);
const actualEntries = await inspectZip(artifactPath);
if (actualEntries.length !== expectedEntries.size) throw new Error('Runtime ZIP contains unexpected entry count');
for (const entry of actualEntries) {
  if (!expectedEntries.delete(entry)) throw new Error(`Unexpected runtime ZIP entry: ${entry}`);
}
if (expectedEntries.size > 0) throw new Error(`Runtime ZIP is missing: ${[...expectedEntries].join(', ')}`);

console.log(`Verified runtime ${runtimeManifest.version}.`);
console.log(`Verified artifact ${artifactName} (${artifactInfo.size} bytes).`);

async function inspectZip(filePath) {
  const archive = unzipSync(new Uint8Array(await readFile(filePath)));
  const entries = Object.keys(archive);
  let totalUncompressed = 0;
  for (const name of entries) {
    const normalized = name.replaceAll('\\', '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error('Unsafe ZIP path: ' + normalized);
    }
    const contents = archive[name];
    totalUncompressed += contents.byteLength;
    if (contents.byteLength > policy.limits.maxSingleFileBytes * 16 || totalUncompressed > policy.limits.maxArtifactBytes * 2) {
      throw new Error('ZIP uncompressed size exceeds configured limits');
    }
  }
  return entries;
}
