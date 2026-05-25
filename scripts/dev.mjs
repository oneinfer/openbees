import { ensureHermesEnvironment } from './hermes-setup.mjs';
import { ensureQwenAsrEnvironment } from './qwen-asr-setup.mjs';
import { ensureSupportedNodeVersion } from './runtime.mjs';

ensureSupportedNodeVersion('npm run dev');
ensureHermesEnvironment();
ensureQwenAsrEnvironment();

process.env.NODE_ENV = 'development';
await import('../server/index.ts');
