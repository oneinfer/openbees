import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const CLIENT_DIST_DIR = path.join(CLIENT_DIR, 'dist');
const CLIENT_INDEX = path.join(CLIENT_DIST_DIR, 'index.html');

export type FrontendCleanup = () => Promise<void> | void;

async function loadClientViteConfig(): Promise<UserConfig> {
  // @ts-expect-error Shared Vite config is authored as a plain .mjs helper.
  const shared = await import('../client/vite.shared.mjs') as { createClientViteConfig: () => UserConfig };
  return shared.createClientViteConfig();
}

export async function mountFrontend(app: Express, httpServer: Server): Promise<FrontendCleanup> {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const viteConfig = await loadClientViteConfig();
    const vite = await createViteServer({
      ...viteConfig,
      root: CLIENT_DIR,
      appType: 'spa',
      server: {
        ...viteConfig.server,
        middlewareMode: true,
        hmr: { server: httpServer },
      },
    });

    app.use(vite.middlewares);
    return () => vite.close();
  }

  if (!existsSync(CLIENT_INDEX)) {
    throw new Error(`Client build not found at ${CLIENT_INDEX}. Run npm run build first.`);
  }

  app.use(express.static(CLIENT_DIST_DIR));
  app.get('*', (_req, res) => {
    res.sendFile(CLIENT_INDEX);
  });
  return () => {};
}
