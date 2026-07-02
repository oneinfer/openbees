import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const GRANITE_ASR_KEYS = [
  'GRANITE_ASR_ENABLED',
  'GRANITE_ASR_PYTHON',
  'GRANITE_ASR_MODEL',
  'GRANITE_ASR_DEVICE',
  'GRANITE_ASR_DTYPE',
  'GRANITE_ASR_MAX_AUDIO_MB',
];

const DEFAULT_GRANITE_ASR_MODEL = 'ibm-granite/granite-4.0-1b-speech';
const GRANITE_ASR_PACKAGES = [
  'torch',
  'torchaudio',
  'soundfile',
  'transformers>=4.52.1',
];

function isWindows() {
  return platform() === 'win32';
}

function graniteVenvDir() {
  return resolve(process.cwd(), '.venv-granite-asr');
}

function graniteVenvPython() {
  return isWindows()
    ? join(graniteVenvDir(), 'Scripts', 'python.exe')
    : join(graniteVenvDir(), 'bin', 'python');
}

function graniteVenvBinDir() {
  return isWindows()
    ? join(graniteVenvDir(), 'Scripts')
    : join(graniteVenvDir(), 'bin');
}

function existingFile(path) {
  try {
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function findExecutable(name) {
  try {
    const output = execFileSync(isWindows() ? 'where.exe' : 'which', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function bootstrapPython() {
  const configured = (process.env.GRANITE_ASR_BOOTSTRAP_PYTHON ?? process.env.QWEN_ASR_BOOTSTRAP_PYTHON)?.trim();
  if (configured && existingFile(configured)) return configured;

  const hermesPython = process.env.HERMES_PYTHON?.trim();
  if (hermesPython && existingFile(hermesPython)) return hermesPython;

  return findExecutable('python') ?? findExecutable('python3');
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    stdio: 'inherit',
    env: setupEnv(),
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}`);
  }
}

function setupEnv() {
  return {
    ...process.env,
    ...graniteActivationEnv(),
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    PYTHONNOUSERSITE: '1',
  };
}

function graniteActivationEnv() {
  const binDir = graniteVenvBinDir();
  const currentPath = process.env.PATH || process.env.Path || '';
  const entries = currentPath.split(delimiter).filter(Boolean);
  const alreadyPresent = entries.some((entry) => resolve(entry).toLowerCase() === resolve(binDir).toLowerCase());
  const path = alreadyPresent ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

  return {
    VIRTUAL_ENV: graniteVenvDir(),
    PATH: path,
    Path: path,
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function packageInstalled(python, moduleName) {
  const result = spawnSync(python, ['-c', `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`], {
    stdio: 'ignore',
    env: setupEnv(),
  });
  return result.status === 0;
}

function pipReady(python) {
  const result = spawnSync(python, ['-m', 'pip', '--version'], {
    stdio: 'ignore',
    env: setupEnv(),
  });
  return result.status === 0;
}

function ensurePip(python) {
  if (pipReady(python)) return;
  console.log('[granite-asr-setup] Bootstrapping pip in .venv-granite-asr...');
  run(python, ['-m', 'ensurepip', '--upgrade']);
}

function installGraniteAsr(python) {
  ensurePip(python);

  const attempts = Number(process.env.GRANITE_ASR_INSTALL_ATTEMPTS || process.env.QWEN_ASR_INSTALL_ATTEMPTS || '3');
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const attemptLabel = attempts > 1 ? ` (${attempt}/${attempts})` : '';
      console.log(`[granite-asr-setup] Installing Granite ASR dependencies into .venv-granite-asr${attemptLabel}...`);
      run(python, [
        '-m',
        'pip',
        'install',
        '--upgrade',
        '--upgrade-strategy',
        'only-if-needed',
        ...GRANITE_ASR_PACKAGES,
      ]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      console.warn(`[granite-asr-setup] Install attempt ${attempt} failed; retrying in 5s.`);
      sleep(5000);
    }
  }

  throw lastError ?? new Error('Granite ASR dependency install failed.');
}

function patchEnvContent(content, values) {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const present = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match || !Object.hasOwn(values, match[2])) return line;

    present.add(match[2]);
    const trailingComment = match[4].match(/(\s+#.*)$/)?.[1] ?? '';
    return `${match[1]}${match[2]}${match[3]}${values[match[2]]}${trailingComment}`;
  });

  if (next.length > 0 && next.at(-1) !== '') next.push('');
  for (const key of GRANITE_ASR_KEYS) {
    if (!present.has(key)) next.push(`${key}=${values[key]}`);
  }

  return next.join('\n');
}

function writeEnvFile(path, values) {
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const patched = patchEnvContent(content, values);
  if (patched !== content) writeFileSync(path, patched, 'utf8');
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function ensureEnvFiles(values, { writeLocalEnv = true, writeExampleEnv = true, exampleValues = values } = {}) {
  if (writeExampleEnv) writeEnvFile(resolve(process.cwd(), '.env.example'), exampleValues);
  if (writeLocalEnv) writeEnvFile(resolve(process.cwd(), '.env'), values);
}

export function ensureGraniteAsrEnvironment(options = {}) {
  const {
    enabled: enabledOverride,
    installIfMissing = process.env.BEES_SKIP_GRANITE_ASR_INSTALL !== '1' && process.env.BEES_SKIP_QWEN_ASR_INSTALL !== '1',
    writeLocalEnv = true,
    writeExampleEnv = true,
  } = options;

  const python = graniteVenvPython();
  const localEnv = parseEnvFile(resolve(process.cwd(), '.env'));
  const configured = (key, legacyKey = null) => process.env[key]?.trim() || localEnv[key]?.trim() || (legacyKey ? process.env[legacyKey]?.trim() || localEnv[legacyKey]?.trim() : '');
  const enabled = typeof enabledOverride === 'boolean'
    ? enabledOverride
    : (configured('GRANITE_ASR_ENABLED', 'QWEN_ASR_ENABLED') || 'false').toLowerCase() === 'true';
  const values = {
    GRANITE_ASR_ENABLED: String(enabled),
    GRANITE_ASR_PYTHON: python,
    GRANITE_ASR_MODEL: configured('GRANITE_ASR_MODEL') || DEFAULT_GRANITE_ASR_MODEL,
    GRANITE_ASR_DEVICE: configured('GRANITE_ASR_DEVICE', 'QWEN_ASR_DEVICE') || 'cpu',
    GRANITE_ASR_DTYPE: configured('GRANITE_ASR_DTYPE', 'QWEN_ASR_DTYPE') || 'float32',
    GRANITE_ASR_MAX_AUDIO_MB: configured('GRANITE_ASR_MAX_AUDIO_MB', 'QWEN_ASR_MAX_AUDIO_MB') || '25',
  };
  const exampleValues = {
    GRANITE_ASR_ENABLED: String(enabled),
    GRANITE_ASR_PYTHON: '',
    GRANITE_ASR_MODEL: DEFAULT_GRANITE_ASR_MODEL,
    GRANITE_ASR_DEVICE: 'cpu',
    GRANITE_ASR_DTYPE: 'float32',
    GRANITE_ASR_MAX_AUDIO_MB: '25',
  };

  ensureEnvFiles(values, { writeLocalEnv, writeExampleEnv, exampleValues });
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  if (!enabled) {
    console.log(`[granite-asr-setup] GRANITE_ASR_ENABLED=${values.GRANITE_ASR_ENABLED}`);
    console.log('[granite-asr-setup] Granite ASR disabled');
    return { python, installed: false, venvDir: graniteVenvDir(), binDir: graniteVenvBinDir() };
  }

  if (!existsSync(python)) {
    if (!installIfMissing) {
      console.warn('[granite-asr-setup] Granite ASR venv is missing and install is disabled.');
    } else {
      const sourcePython = bootstrapPython();
      if (!sourcePython) {
        throw new Error('No Python executable found for Granite ASR setup. Install Python or set GRANITE_ASR_BOOTSTRAP_PYTHON.');
      }
      console.log(`[granite-asr-setup] Creating ${graniteVenvDir()} with ${sourcePython}`);
      run(sourcePython, ['-m', 'venv', graniteVenvDir()]);
    }
  }

  if (existsSync(python) && !GRANITE_ASR_PACKAGES.every((packageName) => packageInstalled(python, packageName.split(/[<=>]/)[0]))) {
    if (!installIfMissing) {
      console.warn('[granite-asr-setup] Granite ASR dependencies are missing and install is disabled.');
    } else {
      installGraniteAsr(python);
    }
  }

  const installed = existsSync(python) && GRANITE_ASR_PACKAGES.every((packageName) => packageInstalled(python, packageName.split(/[<=>]/)[0]));
  console.log(`[granite-asr-setup] GRANITE_ASR_ENABLED=${values.GRANITE_ASR_ENABLED}`);
  console.log(`[granite-asr-setup] GRANITE_ASR_PYTHON=${values.GRANITE_ASR_PYTHON}`);
  console.log(`[granite-asr-setup] Granite ASR dependencies ${installed ? 'ready' : 'not installed'}`);

  if (!installed && installIfMissing) {
    throw new Error('Granite ASR dependencies were not installed successfully.');
  }

  return { python, installed, venvDir: graniteVenvDir(), binDir: graniteVenvBinDir() };
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  ensureGraniteAsrEnvironment({
    enabled: !args.has('--disabled'),
    installIfMissing: !args.has('--no-install'),
    writeLocalEnv: !args.has('--no-env'),
    writeExampleEnv: !args.has('--no-env-example'),
  });
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    console.error(`[granite-asr-setup] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
