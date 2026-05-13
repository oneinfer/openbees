import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const sharedDir = path.resolve(clientDir, '../shared');

export function createClientViteConfig() {
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': sharedDir,
      },
    },
    server: {
      port: 6969,
      strictPort: true,
    },
  };
}

export { clientDir };
