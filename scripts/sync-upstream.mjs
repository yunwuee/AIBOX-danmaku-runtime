import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { collectImportGraph, summarizeGraph } from './lib/import-graph.mjs';
import {
  assertInside,
  copyRegularFile,
  fromRoot,
  parseArguments,
  readJson,
  replaceDirectory,
  repoRoot,
  run,
  toPosix,
  writeJson,
} from './lib/project.mjs';

const args = parseArguments(process.argv.slice(2));
const policy = await readJson(fromRoot('config', 'runtime-policy.json'));

async function prepareUpstream() {
  if (args.source) {
    return assertInside(path.resolve(args.source), path.resolve(args.source), 'local upstream source');
  }
  const cachePath = fromRoot('.cache', 'upstream');
  const gitDirectory = path.join(cachePath, '.git');
  try {
    await readFile(path.join(gitDirectory, 'HEAD'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path.dirname(cachePath), { recursive: true });
    await run('git', ['clone', '--filter=blob:none', '--no-checkout', policy.upstream.repository, cachePath]);
  }
  const reference = String(args.ref || policy.upstream.branch);
  await run('git', ['fetch', '--depth', '1', 'origin', reference], { cwd: cachePath });
  await run('git', ['checkout', '--detach', '--force', 'FETCH_HEAD'], { cwd: cachePath });
  return cachePath;
}

async function gitValue(upstreamPath, format) {
  try {
    const result = await run('git', ['log', '-1', `--format=${format}`], {
      cwd: upstreamPath,
      capture: true,
    });
    return result.stdout;
  } catch {
    return 'unknown';
  }
}

function disableForwardProxy(source) {
  const pattern = /if \(forwardProxy\) \{\s*return `http:\/\/127\.0\.0\.1:5321\/proxy\?url=\$\{encodeURIComponent\(targetUrl\)\}`;\s*\}/m;
  const matches = source.match(new RegExp(pattern.source, 'gm')) || [];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one forward-proxy branch, found ${matches.length}`);
  }
  return source.replace(pattern, 'if (forwardProxy) {\n        return targetUrl;\n    }');
}

function normalizeGeneratedSource(source) {
  return source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n*$/, '\n');
}

async function copyNormalizedTextFile(source, destination, maximumBytes) {
  await copyRegularFile(source, destination, maximumBytes);
  const content = await readFile(destination, 'utf8');
  await writeFile(destination, normalizeGeneratedSource(content), 'utf8');
}

function assertSourceCompatibility(fileKey, source) {
  const forbiddenPatterns = [
    ['Array.prototype.toSorted', /\.toSorted\s*\(/],
    ['iterator.toArray', /\.toArray\s*\(/],
    ['Map.getOrInsert', /\.getOrInsert\s*\(/],
    ['Map.getOrInsertComputed', /\.getOrInsertComputed\s*\(/],
  ];
  for (const [label, pattern] of forbiddenPatterns) {
    if (pattern.test(source)) throw new Error(`${label} is not compatible with Node 18: ${fileKey}`);
  }
}

const upstreamPath = await prepareUpstream();
const commit = await gitValue(upstreamPath, '%H');
if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('Unable to resolve a full upstream commit hash');
const commitDate = await gitValue(upstreamPath, '%cI');
const commitSubject = await gitValue(upstreamPath, '%s');
const upstreamPackage = await readJson(path.join(upstreamPath, policy.upstream.packageFile));
const graph = await collectImportGraph({ sourceRoot: upstreamPath, policy });
const graphSummary = summarizeGraph(graph);
const stagingPath = fromRoot('generated', `.upstream-${process.pid}-${Date.now()}`);
const targetPath = fromRoot('generated', 'upstream');
await rm(stagingPath, { recursive: true, force: true });

for (const file of graph.files) {
  let source = file.source;
  if (file.key === 'danmu_api/configs/globals.js') source = disableForwardProxy(source);
  assertSourceCompatibility(file.key, source);
  source = normalizeGeneratedSource(source);
  const destination = assertInside(stagingPath, path.join(stagingPath, file.key), 'generated module');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, source, 'utf8');
}

const upstreamLicense = path.join(upstreamPath, policy.upstream.licenseFile);
await copyNormalizedTextFile(upstreamLicense, path.join(stagingPath, 'LICENSE'), policy.limits.maxSingleFileBytes);
await writeJson(path.join(stagingPath, 'AIBOX_UPSTREAM.json'), {
  repository: policy.upstream.repository,
  branch: policy.upstream.branch,
  commit,
  commitDate,
  commitSubject,
  upstreamVersion: upstreamPackage.version || 'unknown',
  generatedAt: commitDate,
  ...graphSummary,
});
await replaceDirectory(stagingPath, targetPath);

await copyNormalizedTextFile(upstreamLicense, fromRoot('LICENSE'), policy.limits.maxSingleFileBytes);
await writeFile(fromRoot('THIRD_PARTY_NOTICES.md'), `# Third-party notices\n\nThis runtime contains a mechanically selected and modified subset of [huangxd-/danmu_api](${policy.upstream.repository.replace(/\.git$/, '')}) at commit \`${commit}\`.\n\nThe upstream project is distributed under the GNU Affero General Public License v3.0. The corresponding selected source is committed under \`generated/upstream/\`; the deterministic selection rules live in \`config/runtime-policy.json\` and \`scripts/sync-upstream.mjs\`.\n\nAIBOX-specific changes disable the standalone server, management APIs, Redis integrations, the local forward proxy, unsupported sources, and WASM-dependent Migu support.\n`, 'utf8');

const lock = {
  schemaVersion: 1,
  repository: policy.upstream.repository,
  branch: policy.upstream.branch,
  commit,
  commitDate,
  commitSubject,
  upstreamVersion: upstreamPackage.version || 'unknown',
  generatedAt: commitDate,
  policySchemaVersion: policy.schemaVersion,
  ...graphSummary,
};
await writeJson(fromRoot('upstream.lock.json'), lock);
await mkdir(fromRoot('reports'), { recursive: true });
await writeFile(fromRoot('reports', 'upstream-sync.md'), `# Upstream synchronization report\n\n- Repository: ${policy.upstream.repository}\n- Branch: \`${policy.upstream.branch}\`\n- Commit: \`${commit}\`\n- Commit date: ${commitDate}\n- Upstream version: \`${lock.upstreamVersion}\`\n- Selected modules: ${lock.fileCount}\n- Selected source bytes: ${lock.sourceBytes}\n- Replaced modules: ${lock.replacements.length}\n- Allowed packages: ${lock.packages.map((item) => `\`${item}\``).join(', ') || 'none'}\n\nThe synchronization workflow never publishes this update directly. A pull request must pass the Node 18 build, runtime tests, artifact inspection, and human review before release.\n`, 'utf8');

console.log(`Synchronized ${graph.files.length} modules from ${commit.slice(0, 12)}.`);
console.log(`Generated source: ${toPosix(path.relative(repoRoot, targetPath))}`);
