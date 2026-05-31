import 'dotenv/config';
import { ensureHermesEnvironment } from './hermes-setup.mjs';
import { ensureQwenAsrEnvironment } from './qwen-asr-setup.mjs';
import { ensureActivityDaemonEnvironment } from './activity-daemon-setup.mjs';
import { ensureSupportedNodeVersion } from './runtime.mjs';

ensureSupportedNodeVersion('npm run dev');
ensureHermesEnvironment({ writeExampleEnv: false });
ensureQwenAsrEnvironment({ enabled: true, writeExampleEnv: true });
ensureActivityDaemonEnvironment({ failOnInstallError: true, writeExampleEnv: true });

process.env.NODE_ENV = 'development';
await import('../server/index.ts');
