import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { ensureSupportedNodeVersion } from './runtime.mjs';

ensureSupportedNodeVersion('npm run dev');

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve('tsx/cli');

const child = spawn(process.execPath, [tsxCliPath, 'watch', 'server/index.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
