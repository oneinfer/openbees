import 'dotenv/config';
import './db/index.js';
import { once } from 'node:events';
import { createServer } from 'node:http';
import app, { activityDaemon, agents, qwenAsr } from './app.js';
import { openBrowserForDev } from './browser-opener.js';
import { getAppSetting } from './db/queries.js';
import { mountFrontend, type FrontendCleanup } from './frontend.js';
import { CURRENT_PROJECT_SETTING_KEY } from './routes/projects.js';
import { ensureBundledSkillsLinked } from './skills/catalog.js';

const PORT = parseInt(process.env.PORT || '6969', 10);

const httpServer = createServer(app);
let closeFrontend: FrontendCleanup = () => {};
let shuttingDown = false;

type ShutdownReason = NodeJS.Signals | 'startup-error';

async function main() {
  ensureBundledSkillsLinked();
  await activityDaemon.start();
  closeFrontend = await mountFrontend(app, httpServer);
  httpServer.listen(PORT);
  await once(httpServer, 'listening');

  const url = `http://localhost:${PORT}`;
  const currentProjectPath = getAppSetting(CURRENT_PROJECT_SETTING_KEY);
  const startupUrl = currentProjectPath
    ? `${url}/projects?path=${encodeURIComponent(currentProjectPath)}`
    : url;
  console.log(`Hermes Agent Mission Control running on ${url}`);
  openBrowserForDev(startupUrl);
  activityDaemon.openUiOnWake(startupUrl);

  if (qwenAsr.enabled() && process.env.QWEN_ASR_PRELOAD?.trim().toLowerCase() === 'true') {
    console.log('Loading Qwen ASR model...');
    void qwenAsr.preload()
      .then(() => {
        console.log('Qwen ASR model loaded.');
      })
      .catch((error) => {
        console.error('Qwen ASR model failed to load:', error);
      });
  }
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    if (!httpServer.listening) {
      resolveClose();
      return;
    }

    httpServer.close((error?: Error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });

    httpServer.closeAllConnections();
  });
}

async function shutdown(reason: ShutdownReason, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    httpServer.closeAllConnections();
    process.exit(1);
  }
  shuttingDown = true;

  const forceExit = setTimeout(() => {
    console.error(`Forced shutdown after ${reason}`);
    process.exit(1);
  }, 5000);
  forceExit.unref();

  const results = await Promise.allSettled([
    closeHttpServer(),
    closeFrontend(),
    agents.stop(),
    qwenAsr.stop(),
    activityDaemon.stop(),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') console.error(result.reason);
  }

  clearTimeout(forceExit);
  process.exit(results.some((result) => result.status === 'rejected') ? 1 : exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  console.error(error);
  void shutdown('startup-error', 1);
});
