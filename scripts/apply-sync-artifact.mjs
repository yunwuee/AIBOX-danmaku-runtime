import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  assertInside,
  copyRegularFile,
  fromRoot,
  listFilesRecursively,
  parseArguments,
  readJson,
  replaceDirectory,
  repoRoot,
  toPosix,
} from './lib/project.mjs';

const args = parseArguments(process.argv.slice(2));
if (!args.source) throw new Error('--source is required');
const sourceRoot = path.resolve(String(args.source));
const policy = await readJson(fromRoot('config', 'runtime-policy.json'));
const allowedFiles = new Set([
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'upstream.lock.json',
  'reports/upstream-sync.md',
]);
const files = await listFilesRecursively(sourceRoot);
let totalBytes = 0;
for (const filePath of files) {
  const relative = toPosix(path.relative(sourceRoot, filePath));
  if (!allowedFiles.has(relative) && !relative.startsWith('generated/upstream/')) {
    throw new Error(`Unexpected synchronization artifact path: ${relative}`);
  }
  const fileInfo = await import('node:fs/promises').then(({ lstat }) => lstat(filePath));
  totalBytes += fileInfo.size;
  if (fileInfo.size > policy.limits.maxSingleFileBytes || totalBytes > policy.limits.maxArtifactBytes) {
    throw new Error('Synchronization artifact exceeds configured limits');
  }
}

const lock = await readJson(path.join(sourceRoot, 'upstream.lock.json'));
if (!/^[0-9a-f]{40}$/i.test(lock.commit || '')) throw new Error('Synchronization artifact has an invalid commit');
if (lock.repository !== policy.upstream.repository || lock.branch !== policy.upstream.branch) {
  throw new Error('Synchronization artifact targets an unexpected upstream repository');
}

const stagingPath = fromRoot('generated', `.apply-${process.pid}-${Date.now()}`);
await rm(stagingPath, { recursive: true, force: true });
await mkdir(stagingPath, { recursive: true });
for (const sourceFile of files.filter((item) => toPosix(path.relative(sourceRoot, item)).startsWith('generated/upstream/'))) {
  const relative = toPosix(path.relative(path.join(sourceRoot, 'generated', 'upstream'), sourceFile));
  const targetFile = assertInside(stagingPath, path.join(stagingPath, relative), 'staged generated module');
  await copyRegularFile(sourceFile, targetFile, policy.limits.maxSingleFileBytes);
}
await replaceDirectory(stagingPath, fromRoot('generated', 'upstream'));
for (const relative of allowedFiles) {
  await copyRegularFile(
    path.join(sourceRoot, relative),
    assertInside(repoRoot, path.join(repoRoot, relative), 'synchronization destination'),
    policy.limits.maxSingleFileBytes,
  );
}
console.log(`Applied upstream synchronization artifact for ${lock.commit.slice(0, 12)}.`);
