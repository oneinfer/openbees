import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const ACTIVITY_KEYS = [
  'BEES_ACTIVITY_ENABLED',
  'BEES_ACTIVITY_HOST',
  'BEES_ACTIVITY_PORT',
  'BEES_ACTIVITY_PYTHON',
  'BEES_ACTIVITY_DATA_DIR',
  'BEES_ACTIVITY_REQUIRE_INPUT_DEVICE',
];

function isWindows() {
  return platform() === 'win32';
}

function expandHomePrefix(value) {
  if (!value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
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
    const expanded = resolve(expandHomePrefix(path));
    return existsSync(expanded) && statSync(expanded).isFile() ? expanded : null;
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

function configuredValue(localEnv, key) {
  return process.env[key]?.trim() || localEnv[key]?.trim();
}

function envFlagEnabled(value, defaultValue) {
  if (value === undefined || value.trim() === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function bootstrapPython(localEnv) {
  const configured = configuredValue(localEnv, 'BEES_ACTIVITY_BOOTSTRAP_PYTHON');
  if (configured && existingFile(configured)) return existingFile(configured);

  const activityPython = configuredValue(localEnv, 'BEES_ACTIVITY_PYTHON');
  if (activityPython && existingFile(activityPython)) return existingFile(activityPython);

  const granitePython = configuredValue(localEnv, 'GRANITE_ASR_PYTHON') || configuredValue(localEnv, 'QWEN_ASR_PYTHON');
  if (granitePython && existingFile(granitePython)) return existingFile(granitePython);

  const hermesPython = configuredValue(localEnv, 'HERMES_PYTHON');
  if (hermesPython && existingFile(hermesPython)) return existingFile(hermesPython);

  return findExecutable('python') ?? findExecutable('python3');
}

function pythonEnv(python = null) {
  const base = {
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    PYTHONNOUSERSITE: '1',
  };

  if (!python || !resolve(python).toLowerCase().startsWith(resolve(graniteVenvDir()).toLowerCase())) {
    return base;
  }

  const binDir = graniteVenvBinDir();
  const currentPath = process.env.PATH || process.env.Path || '';
  const entries = currentPath.split(delimiter).filter(Boolean);
  const alreadyPresent = entries.some((entry) => resolve(entry).toLowerCase() === resolve(binDir).toLowerCase());
  const path = alreadyPresent ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

  return {
    ...base,
    VIRTUAL_ENV: graniteVenvDir(),
    PATH: path,
    Path: path,
  };
}

function run(file, args, options = {}) {
  const { pythonForEnv = null, ...spawnOptions } = options;
  const result = spawnSync(file, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...pythonEnv(pythonForEnv),
    },
    ...spawnOptions,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}`);
  }
}

function pythonDefaultInputDeviceAvailable(python) {
  if (!python || !existingFile(python)) return null;

  const script = [
    'import sys',
    'try:',
    '    import speech_recognition as sr',
    '    sr.Microphone()',
    '    print("available")',
    '    sys.exit(0)',
    'except Exception as error:',
    '    message = str(error).lower()',
    '    if "no default input device" in message or ("default" in message and "input device" in message):',
    '        print("missing")',
    '        sys.exit(2)',
    '    print("unknown")',
    '    sys.exit(3)',
  ].join('\n');

  const result = spawnSync(python, ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...pythonEnv(python),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 8000,
  });

  if (result.status === 0 && result.stdout.includes('available')) return true;
  if (result.status === 2 && result.stdout.includes('missing')) return false;
  return null;
}

function windowsDefaultInputDeviceAvailable() {
  if (!isWindows()) return null;

  const script = String.raw`
$typeDefinition = @"
using System;
using System.Runtime.InteropServices;

namespace BeesAudio {
  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorComObject {}

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, IntPtr ppDevices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out object ppEndpoint);
    int GetDevice(string pwstrId, IntPtr ppDevice);
    int RegisterEndpointNotificationCallback(IntPtr pClient);
    int UnregisterEndpointNotificationCallback(IntPtr pClient);
  }
}
"@

try {
  Add-Type -TypeDefinition $typeDefinition -ErrorAction Stop | Out-Null
  $enumerator = [BeesAudio.IMMDeviceEnumerator]([BeesAudio.MMDeviceEnumeratorComObject]::new())
  $endpoint = $null
  $hr = $enumerator.GetDefaultAudioEndpoint([BeesAudio.EDataFlow]::eCapture, [BeesAudio.ERole]::eConsole, [ref]$endpoint)
  if ($hr -eq 0 -and $null -ne $endpoint) { exit 0 }
  exit 2
} catch {
  exit 3
}
`;

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    stdio: 'ignore',
    timeout: 8000,
  });

  if (result.status === 0) return true;
  if (result.status === 2) return false;
  return null;
}

function defaultInputDeviceAvailable(localEnv, python) {
  if (!envFlagEnabled(configuredValue(localEnv, 'BEES_ACTIVITY_REQUIRE_INPUT_DEVICE'), true)) return true;

  const fromPython = pythonDefaultInputDeviceAvailable(python);
  if (fromPython !== null) return fromPython;

  const fromWindows = windowsDefaultInputDeviceAvailable();
  if (fromWindows !== null) return fromWindows;

  return null;
}

function pipReady(python) {
  const result = spawnSync(python, ['-m', 'pip', '--version'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      ...pythonEnv(python),
    },
  });
  return result.status === 0;
}

function requiredModules() {
  const modules = [
    'mss',
    'pynput',
    'pyperclip',
    'speech_recognition',
    'pyaudio',
    'numpy',
    'openwakeword',
    'onnxruntime',
    'torch',
    'torchaudio',
    'soundfile',
    'transformers',
    'silero_vad',
    'psutil',
  ];

  if (isWindows()) modules.push('pywinauto');
  if (platform() === 'linux') modules.push('pyatspi');
  return modules;
}

function missingModules(python) {
  const script = [
    'import importlib.util, json',
    `modules = ${JSON.stringify(requiredModules())}`,
    'print(json.dumps([name for name in modules if importlib.util.find_spec(name) is None]))',
  ].join('; ');
  const result = spawnSync(python, ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...pythonEnv(python),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return requiredModules();
  try {
    return JSON.parse(result.stdout.trim() || '[]');
  } catch {
    return requiredModules();
  }
}

function ensurePip(python) {
  if (pipReady(python)) return;
  console.log('[activity-daemon-setup] Bootstrapping pip in .venv-granite-asr...');
  run(python, ['-m', 'ensurepip', '--upgrade'], { pythonForEnv: python });
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
  for (const key of ACTIVITY_KEYS) {
    if (!present.has(key)) next.push(`${key}=${values[key]}`);
  }

  return next.join('\n');
}

function writeEnvFile(path, values) {
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const patched = patchEnvContent(content, values);
  if (patched !== content) writeFileSync(path, patched, 'utf8');
}

function ensureEnvFiles(values, { writeLocalEnv = true, writeExampleEnv = true, exampleValues = values } = {}) {
  if (writeExampleEnv) writeEnvFile(resolve(process.cwd(), '.env.example'), exampleValues);
  if (writeLocalEnv) writeEnvFile(resolve(process.cwd(), '.env'), values);
}

function defaultDataDir(localEnv) {
  const beesHome = configuredValue(localEnv, 'BEES_HOME') || '~/.bees';
  return `${beesHome.replace(/[\\/]$/, '')}/activity-daemon`;
}

function requirementsPath() {
  return resolve(process.cwd(), 'activity_daemon', 'requirements.txt');
}

function installRequirements(python) {
  ensurePip(python);
  const requirements = requirementsPath();
  if (!existsSync(requirements)) throw new Error(`Activity daemon requirements not found: ${requirements}`);
  console.log('[activity-daemon-setup] Installing activity daemon Python dependencies into .venv-granite-asr...');
  run(python, [
    '-m',
    'pip',
    'install',
    '--upgrade',
    '--upgrade-strategy',
    'only-if-needed',
    '-r',
    requirements,
  ], { pythonForEnv: python });
}

export function ensureActivityDaemonEnvironment(options = {}) {
  const {
    installIfMissing = process.env.BEES_SKIP_ACTIVITY_DAEMON_INSTALL !== '1',
    failOnInstallError = false,
    writeLocalEnv = true,
    writeExampleEnv = true,
  } = options;

  const localEnv = parseEnvFile(resolve(process.cwd(), '.env'));
  const granitePython = configuredValue(localEnv, 'GRANITE_ASR_PYTHON') || configuredValue(localEnv, 'QWEN_ASR_PYTHON');
  const python = granitePython && existingFile(granitePython) ? existingFile(granitePython) : graniteVenvPython();
  const values = {
    BEES_ACTIVITY_ENABLED: configuredValue(localEnv, 'BEES_ACTIVITY_ENABLED') || 'true',
    BEES_ACTIVITY_HOST: configuredValue(localEnv, 'BEES_ACTIVITY_HOST') || '127.0.0.1',
    BEES_ACTIVITY_PORT: configuredValue(localEnv, 'BEES_ACTIVITY_PORT') || '4768',
    BEES_ACTIVITY_PYTHON: python,
    BEES_ACTIVITY_DATA_DIR: configuredValue(localEnv, 'BEES_ACTIVITY_DATA_DIR') || defaultDataDir(localEnv),
    BEES_ACTIVITY_REQUIRE_INPUT_DEVICE: configuredValue(localEnv, 'BEES_ACTIVITY_REQUIRE_INPUT_DEVICE') || 'true',
  };
  const exampleValues = {
    BEES_ACTIVITY_ENABLED: 'true',
    BEES_ACTIVITY_HOST: '127.0.0.1',
    BEES_ACTIVITY_PORT: '4768',
    BEES_ACTIVITY_PYTHON: python,
    BEES_ACTIVITY_DATA_DIR: '~/.bees/activity-daemon',
    BEES_ACTIVITY_REQUIRE_INPUT_DEVICE: 'true',
  };

  if (!envFlagEnabled(values.BEES_ACTIVITY_ENABLED, true)) {
    ensureEnvFiles(values, { writeLocalEnv, writeExampleEnv, exampleValues });
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    console.log('[activity-daemon-setup] Activity daemon disabled; dependency install skipped.');
    return { python, installed: existingFile(python) !== null, venvDir: graniteVenvDir(), disabled: true };
  }

  const hasDefaultInput = defaultInputDeviceAvailable(localEnv, python);
  if (hasDefaultInput === false) {
    values.BEES_ACTIVITY_ENABLED = 'false';
    ensureEnvFiles(values, { writeLocalEnv, writeExampleEnv, exampleValues });
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    console.log('[activity-daemon-setup] No default input device detected; activity daemon disabled and dependency install skipped.');
    return { python, installed: existingFile(python) !== null, venvDir: graniteVenvDir(), disabled: true, reason: 'no-default-input-device' };
  }

  ensureEnvFiles(values, { writeLocalEnv, writeExampleEnv, exampleValues });
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  if (!installIfMissing) {
    console.log('[activity-daemon-setup] Activity daemon dependency install skipped.');
    return { python, installed: existingFile(python) !== null, venvDir: graniteVenvDir() };
  }

  try {
    if (!existsSync(python)) {
      const sourcePython = bootstrapPython(localEnv);
      if (!sourcePython) throw new Error('No Python executable found. Install Python or set BEES_ACTIVITY_BOOTSTRAP_PYTHON.');
      console.log(`[activity-daemon-setup] Creating ${graniteVenvDir()} with ${sourcePython}`);
      run(sourcePython, ['-m', 'venv', graniteVenvDir()]);
    }

    const missingBefore = missingModules(python);
    if (missingBefore.length > 0) {
      console.log(`[activity-daemon-setup] Missing Python modules: ${missingBefore.join(', ')}`);
      installRequirements(python);
    } else {
      console.log('[activity-daemon-setup] activity daemon dependencies already ready');
    }

    const missingAfter = missingModules(python);
    if (missingAfter.length > 0) {
      throw new Error(`Activity daemon dependencies are still missing after install: ${missingAfter.join(', ')}`);
    }

    console.log(`[activity-daemon-setup] BEES_ACTIVITY_PYTHON=${python}`);
    console.log('[activity-daemon-setup] activity daemon dependencies ready');
    return { python, installed: true, venvDir: graniteVenvDir() };
  } catch (error) {
    if (failOnInstallError) throw error;
    console.warn(`[activity-daemon-setup] Activity daemon setup warning: ${error instanceof Error ? error.message : String(error)}`);
    console.warn('[activity-daemon-setup] Continuing because activity daemon install is best effort. Run npm run setup:activity to retry.');
    return { python, installed: false, venvDir: graniteVenvDir(), error };
  }
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  ensureActivityDaemonEnvironment({
    installIfMissing: !args.has('--no-install'),
    writeLocalEnv: !args.has('--no-env'),
    writeExampleEnv: !args.has('--no-env-example'),
  });
}

if (isMainModule()) {
  await main();
}
