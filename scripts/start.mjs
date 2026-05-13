import { spawn } from 'node:child_process';
import { ensureSupportedNodeVersion } from './runtime.mjs';

ensureSupportedNodeVersion('npm run start');

const child = spawn(process.execPath, ['dist/server/server/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
