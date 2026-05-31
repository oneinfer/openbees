import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverSourceRoot = fileURLToPath(new URL('../server/', import.meta.url));
const serverDestRoot = fileURLToPath(new URL('../dist/server/server/', import.meta.url));
const activitySourceRoot = fileURLToPath(new URL('../activity_daemon/', import.meta.url));
const activityDestRoot = fileURLToPath(new URL('../dist/activity_daemon/', import.meta.url));
const serverExtensions = new Set(['.py', '.sql']);
const activityExtensions = new Set(['.py']);
const activityFiles = new Set(['requirements.txt']);

async function copyAssets(sourceRoot, destRoot, dir, allowedExtensions, allowedFiles = new Set()) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await copyAssets(sourceRoot, destRoot, sourcePath, allowedExtensions, allowedFiles);
      continue;
    }

    if (!allowedExtensions.has(extname(entry.name)) && !allowedFiles.has(entry.name)) continue;

    const relativePath = relative(sourceRoot, sourcePath);
    const destPath = join(destRoot, relativePath);
    const destDir = dirname(destPath);

    await mkdir(destDir, { recursive: true });
    await cp(sourcePath, destPath);
  }
}

await copyAssets(serverSourceRoot, serverDestRoot, serverSourceRoot, serverExtensions);
await copyAssets(activitySourceRoot, activityDestRoot, activitySourceRoot, activityExtensions, activityFiles);
