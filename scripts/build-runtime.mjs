import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { zipSync } from 'fflate';
import { build } from 'esbuild';

import { fromRoot, hashFile, readJson, writeJson } from './lib/project.mjs';

const packageJson = await readJson(fromRoot('package.json'));
const policy = await readJson(fromRoot('config', 'runtime-policy.json'));
const lock = await readJson(fromRoot('upstream.lock.json'));
if (!/^[0-9a-f]{40}$/i.test(lock.commit || '')) throw new Error('Run npm run sync:upstream before building');

const distPath = fromRoot('dist');
const artifactsPath = fromRoot('artifacts');
await rm(distPath, { recursive: true, force: true });
await rm(artifactsPath, { recursive: true, force: true });
await mkdir(distPath, { recursive: true });
await mkdir(artifactsPath, { recursive: true });

const bundleName = 'runtime.bundle.cjs';
const bundlePath = path.join(distPath, bundleName);
const buildResult = await build({
  entryPoints: [fromRoot('src', 'bootstrap.mjs')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node18.20'],
  charset: 'utf8',
  legalComments: 'linked',
  logLevel: 'info',
  metafile: true,
  minifySyntax: true,
  treeShaking: true,
  define: {
    __AIBOX_RUNTIME_VERSION__: JSON.stringify(packageJson.version),
    __AIBOX_UPSTREAM_COMMIT__: JSON.stringify(lock.commit),
    __AIBOX_UPSTREAM_VERSION__: JSON.stringify(lock.upstreamVersion),
  },
});
await writeJson(path.join(distPath, 'build-meta.json'), buildResult.metafile);

const legalName = `${bundleName}.LEGAL.txt`;
const legalPath = path.join(distPath, legalName);
try {
  await stat(legalPath);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await copyFile(fromRoot('THIRD_PARTY_NOTICES.md'), legalPath);
}
await copyFile(fromRoot('LICENSE'), path.join(distPath, 'LICENSE'));
await copyFile(fromRoot('THIRD_PARTY_NOTICES.md'), path.join(distPath, 'THIRD_PARTY_NOTICES.md'));

const bundleHash = await hashFile(bundlePath);
const runtimeManifest = {
  schemaVersion: 1,
  version: packageJson.version,
  runtimeApi: 1,
  engineApi: 1,
  nodeRange: packageJson.engines.node,
  entrypoint: bundleName,
  sha256: bundleHash,
  license: 'AGPL-3.0-only',
  sourceUrl: `https://github.com/yunwuee/AIBOX-danmaku-runtime/tree/v${packageJson.version}`,
  upstream: {
    repository: lock.repository,
    commit: lock.commit,
    version: lock.upstreamVersion,
  },
  providers: {
    defaults: policy.defaultSources,
    disabled: policy.disabledSources,
  },
  files: [
    bundleName,
    legalName,
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ],
};
await writeJson(path.join(distPath, 'manifest.json'), runtimeManifest);

const artifactName = `aibox-danmaku-runtime-${packageJson.version}.zip`;
const artifactPath = path.join(artifactsPath, artifactName);
const zipTimestamp = new Date('1980-01-01T00:00:00.000Z');
const zipEntries = {};
for (const fileName of [...runtimeManifest.files, 'manifest.json']) {
  const contents = new Uint8Array(await readFile(path.join(distPath, fileName)));
  zipEntries[fileName] = [contents, { level: 9, mtime: zipTimestamp }];
}
await writeFile(artifactPath, zipSync(zipEntries, { level: 9 }), { flag: 'wx' });

const artifactInfo = await stat(artifactPath);
if (artifactInfo.size > policy.limits.maxArtifactBytes) throw new Error('Runtime artifact exceeds configured size limit');
const artifactHash = await hashFile(artifactPath);
const releaseManifest = {
  schemaVersion: 1,
  channel: 'stable',
  version: packageJson.version,
  runtimeApi: 1,
  engineApi: 1,
  nodeRange: packageJson.engines.node,
  minimumAppVersion: '0.1.8',
  downloadUrl: `https://github.com/yunwuee/AIBOX-danmaku-runtime/releases/download/v${packageJson.version}/${artifactName}`,
  sha256: artifactHash,
  size: artifactInfo.size,
  license: 'AGPL-3.0-only',
  sourceUrl: `https://github.com/yunwuee/AIBOX-danmaku-runtime/tree/v${packageJson.version}`,
  disabledPlatforms: [],
  upstream: runtimeManifest.upstream,
};
await writeJson(path.join(artifactsPath, 'release-manifest.json'), releaseManifest);
await writeFile(path.join(artifactsPath, 'SHA256SUMS'), `${artifactHash}  ${artifactName}\n`, 'utf8');

console.log(`Built ${artifactName} (${artifactInfo.size} bytes).`);
console.log(`SHA-256: ${artifactHash}`);
