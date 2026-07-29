import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { init, parse } from 'es-module-lexer';

import { assertInside, repoRoot, toPosix } from './project.mjs';

const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

export function normalizeSourceText(source) {
  return source.replace(/\r\n?/g, '\n');
}

async function resolveRelativeModule(sourceRoot, importerKey, specifier, replacements) {
  const baseKey = path.posix.normalize(path.posix.join(path.posix.dirname(importerKey), specifier));
  if (baseKey.startsWith('../') || baseKey === '..' || path.posix.isAbsolute(baseKey)) {
    throw new Error(`Relative import escapes upstream root: ${importerKey} -> ${specifier}`);
  }
  const candidates = path.posix.extname(baseKey)
    ? [baseKey]
    : [`${baseKey}.js`, `${baseKey}.mjs`, `${baseKey}.cjs`, `${baseKey}/index.js`];
  for (const candidate of candidates) {
    if (replacements[candidate]) return candidate;
    try {
      const sourcePath = assertInside(sourceRoot, path.join(sourceRoot, candidate), 'upstream module');
      const source = normalizeSourceText(await readFile(sourcePath, 'utf8'));
      if (source != null) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Cannot resolve import: ${importerKey} -> ${specifier}`);
}

export async function collectImportGraph({ sourceRoot, policy }) {
  await init;
  const replacements = policy.replacements || {};
  const allowedPackages = new Set(policy.allowedPackages || []);
  const allowedBuiltins = new Set(policy.allowedNodeBuiltins || []);
  const queue = [...policy.entrypoints];
  const files = new Map();
  const packages = new Set();
  let totalBytes = 0;

  while (queue.length > 0) {
    const key = queue.shift();
    if (files.has(key)) continue;
    if (!key.startsWith(`${policy.upstream.sourceRoot}/`)) {
      throw new Error(`Entrypoint is outside the allowed source root: ${key}`);
    }

    const replacement = replacements[key];
    const sourcePath = replacement
      ? assertInside(repoRoot, path.join(repoRoot, replacement), 'replacement module')
      : assertInside(sourceRoot, path.join(sourceRoot, key), 'upstream module');
    const source = normalizeSourceText(await readFile(sourcePath, 'utf8'));
    const sourceBytes = Buffer.byteLength(source);
    if (sourceBytes > policy.limits.maxSingleFileBytes) {
      throw new Error(`Source module exceeds per-file limit: ${key}`);
    }
    totalBytes += sourceBytes;
    if (totalBytes > policy.limits.maxSourceBytes) {
      throw new Error('Selected upstream source exceeds total size limit');
    }

    const [imports] = parse(source);
    const dependencies = [];
    for (const importRecord of imports) {
      if (importRecord.n == null) {
        throw new Error(`Non-literal dynamic import is not allowed: ${key}`);
      }
      const specifier = importRecord.n;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const dependency = await resolveRelativeModule(sourceRoot, key, specifier, replacements);
        dependencies.push(dependency);
        queue.push(dependency);
        continue;
      }
      if (BUILTINS.has(specifier)) {
        if (!allowedBuiltins.has(specifier)) {
          throw new Error(`Node builtin is not allowlisted: ${key} -> ${specifier}`);
        }
        continue;
      }
      const dependencyPackage = packageName(specifier);
      if (!allowedPackages.has(dependencyPackage)) {
        throw new Error(`Package is not allowlisted: ${key} -> ${specifier}`);
      }
      packages.add(dependencyPackage);
    }

    if (/\brequire\s*\(/.test(source)) {
      throw new Error(`CommonJS require is not allowed in selected upstream code: ${key}`);
    }
    files.set(key, {
      key,
      sourcePath,
      replacement: replacement || null,
      bytes: sourceBytes,
      dependencies,
      source,
    });
    if (files.size > policy.limits.maxFiles) {
      throw new Error('Selected upstream source exceeds file-count limit');
    }
  }

  return {
    files: [...files.values()].sort((left, right) => left.key.localeCompare(right.key)),
    packages: [...packages].sort(),
    totalBytes,
  };
}

export function summarizeGraph(graph) {
  const replacements = graph.files
    .filter((file) => file.replacement)
    .map((file) => ({ target: file.key, replacement: toPosix(file.replacement) }));
  return {
    fileCount: graph.files.length,
    sourceBytes: graph.totalBytes,
    packages: graph.packages,
    replacements,
  };
}
