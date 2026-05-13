import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { clientDir, createClientViteConfig } from '../client/vite.shared.mjs';

await build({
  ...createClientViteConfig(),
  root: clientDir,
  build: {
    outDir: path.resolve(fileURLToPath(new URL('../dist/server/client/dist', import.meta.url))),
    emptyOutDir: true,
  },
});
