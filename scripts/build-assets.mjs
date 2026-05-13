import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../server/', import.meta.url));
const destRoot = fileURLToPath(new URL('../dist/server/server/', import.meta.url));
const allowedExtensions = new Set(['.py', '.sql']);

async function copyAssets(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await copyAssets(sourcePath);
      continue;
    }

    if (!allowedExtensions.has(extname(entry.name))) continue;

    const relativePath = relative(sourceRoot, sourcePath);
    const destPath = join(destRoot, relativePath);
    const destDir = dirname(destPath);

    await mkdir(destDir, { recursive: true });
    await cp(sourcePath, destPath);
  }
}

await copyAssets(sourceRoot);
