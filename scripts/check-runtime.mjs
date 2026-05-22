import { ensureSupportedNodeVersion } from './runtime.mjs';
import { ensureHermesEnvironment } from './hermes-setup.mjs';

ensureSupportedNodeVersion('npm install');
ensureHermesEnvironment();
