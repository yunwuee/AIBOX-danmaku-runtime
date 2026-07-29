import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function fromRoot(...segments) {
  return path.join(repoRoot, ...segments);
}

export function toPosix(value) {
  return value.split(path.sep).join('/');
}

export function assertInside(parent, candidate, label = 'path') {
  const parentPath = path.resolve(parent);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(parentPath, candidatePath);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return candidatePath;
  }
  throw new Error(`${label} escapes its allowed directory`);
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function copyRegularFile(source, destination, maximumBytes = Infinity) {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Refusing to copy non-regular file: ${source}`);
  }
  if (sourceInfo.size > maximumBytes) {
    throw new Error(`File exceeds size limit: ${source}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return sourceInfo.size;
}

export async function replaceDirectory(stagingPath, targetPath) {
  const safeStaging = assertInside(repoRoot, stagingPath, 'staging directory');
  const safeTarget = assertInside(repoRoot, targetPath, 'target directory');
  const backupPath = `${safeTarget}.previous`;
  await rm(backupPath, { recursive: true, force: true });
  try {
    await rename(safeTarget, backupPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(safeStaging, safeTarget);
    await rm(backupPath, { recursive: true, force: true });
  } catch (error) {
    try {
      await rename(backupPath, safeTarget);
    } catch {}
    throw error;
  }
}

export async function hashFile(filePath) {
  const file = await open(filePath, 'r');
  const hash = createHash('sha256');
  try {
    for await (const chunk of file.createReadStream()) hash.update(chunk);
  } finally {
    await file.close();
  }
  return hash.digest('hex');
}

export async function listFilesRecursively(rootPath) {
  const files = [];
  async function visit(currentPath) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${entryPath}`);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      } else {
        throw new Error(`Unsupported filesystem entry: ${entryPath}`);
      }
    }
  }
  const rootInfo = await stat(rootPath);
  if (!rootInfo.isDirectory()) throw new Error(`Not a directory: ${rootPath}`);
  await visit(rootPath);
  return files;
}

export async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      shell: false,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

export function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}
