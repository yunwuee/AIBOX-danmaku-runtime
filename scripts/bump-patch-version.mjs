import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));
const writeJson = async (filePath, value) => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const packageJson = await readJson(packagePath);
const lockJson = await readJson(lockPath);
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version || '');
if (!match) throw new Error(`Cannot bump non-stable package version: ${packageJson.version}`);
if (lockJson.name !== packageJson.name || !lockJson.packages?.['']) {
  throw new Error('package-lock.json does not match package.json');
}

const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
packageJson.version = nextVersion;
lockJson.version = nextVersion;
lockJson.packages[''].version = nextVersion;

await writeJson(packagePath, packageJson);
await writeJson(lockPath, lockJson);
console.log(`Bumped runtime version ${match[0]} -> ${nextVersion}.`);
