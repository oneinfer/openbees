import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { platform } from 'node:os';

const KEYS = [
  'LUX_TTS_ENABLED','LUX_TTS_PYTHON','LUX_TTS_MODEL','LUX_TTS_DEVICE','LUX_TTS_THREADS',
  'LUX_TTS_REFERENCE_AUDIO_PATH','LUX_TTS_NUM_STEPS','LUX_TTS_T_SHIFT','LUX_TTS_SPEED',
  'LUX_TTS_RUN_LIMIT','LUX_TTS_SEGMENT_MAX_CHARS','LUX_TTS_SEGMENT_FLUSH_MS',
  'LUX_TTS_QUEUE_MAX_SEGMENTS','LUX_TTS_SEGMENT_TIMEOUT_MS','LUX_TTS_PRELOAD',
];
const DEFAULT_MODEL = 'YatharthS/LuxTTS';
const DEFAULT_REFERENCE_AUDIO = 'voice-reference.wav';
const LINACODEC_PACKAGE = 'git+https://github.com/ysharma3501/LinaCodec.git';
const PIPER_PHONEMIZE_FIND_LINKS = 'https://k2-fsa.github.io/icefall/piper_phonemize.html';
const PACKAGES = ['numpy', 'git+https://github.com/ysharma3501/LuxTTS.git'];

function isWindows() { return platform() === 'win32'; }
function venvDir() { return resolve(process.cwd(), '.venv-granite-asr'); }
function venvPython() { return isWindows() ? join(venvDir(), 'Scripts', 'python.exe') : join(venvDir(), 'bin', 'python'); }
function venvBin() { return isWindows() ? join(venvDir(), 'Scripts') : join(venvDir(), 'bin'); }
function exists(path) { try { return existsSync(path); } catch { return false; } }
function which(name) {
  try { return execFileSync(isWindows() ? 'where.exe' : 'which', [name], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).split(/\r?\n/).map(s => s.trim()).find(Boolean) || null; }
  catch { return null; }
}
function envForVenv() {
  const current = process.env.PATH || process.env.Path || '';
  const bin = venvBin();
  const path = current.split(delimiter).some(p => resolve(p).toLowerCase() === resolve(bin).toLowerCase()) ? current : [bin, current].filter(Boolean).join(delimiter);
  return { ...process.env, VIRTUAL_ENV: venvDir(), PATH: path, Path: path, PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONNOUSERSITE: '1' };
}
function run(file, args) {
  const result = spawnSync(file, args, { stdio: 'inherit', env: envForVenv() });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}`);
}
function moduleInstalled(python, mod) { return spawnSync(python, ['-c', `import importlib.util,sys;sys.exit(0 if importlib.util.find_spec(${JSON.stringify(mod)}) else 1)`], { stdio: 'ignore', env: envForVenv() }).status === 0; }
function parseEnv(path) {
  if (!exists(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}
function patchEnv(path, values) {
  const old = exists(path) ? readFileSync(path, 'utf8') : '';
  const present = new Set();
  const lines = old ? old.split(/\r?\n/).map(line => {
    const m = line.match(/^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!m || !Object.hasOwn(values, m[2])) return line;
    present.add(m[2]);
    const comment = m[4].match(/(\s+#.*)$/)?.[1] || '';
    return `${m[1]}${m[2]}${m[3]}${values[m[2]]}${comment}`;
  }) : [];
  if (lines.length && lines.at(-1) !== '') lines.push('');
  for (const key of KEYS) if (!present.has(key)) lines.push(`${key}=${values[key]}`);
  const next = lines.join('\n');
  if (next !== old) writeFileSync(path, next, 'utf8');
}
function bootstrapPython() { return process.env.LUX_TTS_BOOTSTRAP_PYTHON?.trim() || process.env.GRANITE_ASR_PYTHON?.trim() || process.env.HERMES_PYTHON?.trim() || which('python') || which('python3'); }

export function ensureLuxTtsEnvironment(options = {}) {
  const { installIfMissing = process.env.BEES_SKIP_LUX_TTS_INSTALL !== '1', writeLocalEnv = true, writeExampleEnv = true } = options;
  const local = parseEnv(resolve(process.cwd(), '.env'));
  const cfg = (key) => process.env[key]?.trim() || local[key]?.trim() || '';
  const enabled = (cfg('LUX_TTS_ENABLED') || 'false').toLowerCase() === 'true';
  const python = cfg('LUX_TTS_PYTHON') || cfg('GRANITE_ASR_PYTHON') || venvPython();
  const values = {
    LUX_TTS_ENABLED: String(enabled), LUX_TTS_PYTHON: python, LUX_TTS_MODEL: cfg('LUX_TTS_MODEL') || DEFAULT_MODEL,
    LUX_TTS_DEVICE: cfg('LUX_TTS_DEVICE') || cfg('GRANITE_ASR_DEVICE') || 'cpu', LUX_TTS_THREADS: cfg('LUX_TTS_THREADS') || '2',
    LUX_TTS_REFERENCE_AUDIO_PATH: cfg('LUX_TTS_REFERENCE_AUDIO_PATH') || DEFAULT_REFERENCE_AUDIO, LUX_TTS_NUM_STEPS: cfg('LUX_TTS_NUM_STEPS') || '4',
    LUX_TTS_T_SHIFT: cfg('LUX_TTS_T_SHIFT') || '0.9', LUX_TTS_SPEED: cfg('LUX_TTS_SPEED') || '1.0', LUX_TTS_RUN_LIMIT: cfg('LUX_TTS_RUN_LIMIT') || '1',
    LUX_TTS_SEGMENT_MAX_CHARS: cfg('LUX_TTS_SEGMENT_MAX_CHARS') || '420', LUX_TTS_SEGMENT_FLUSH_MS: cfg('LUX_TTS_SEGMENT_FLUSH_MS') || '900',
    LUX_TTS_QUEUE_MAX_SEGMENTS: cfg('LUX_TTS_QUEUE_MAX_SEGMENTS') || '12', LUX_TTS_SEGMENT_TIMEOUT_MS: cfg('LUX_TTS_SEGMENT_TIMEOUT_MS') || '30000',
    LUX_TTS_PRELOAD: cfg('LUX_TTS_PRELOAD') || 'true',
  };
  const example = {
    ...values,
    LUX_TTS_ENABLED: String(enabled),
    LUX_TTS_PYTHON: '',
    LUX_TTS_REFERENCE_AUDIO_PATH: DEFAULT_REFERENCE_AUDIO,
  };
  if (writeExampleEnv) patchEnv(resolve(process.cwd(), '.env.example'), example);
  if (writeLocalEnv) patchEnv(resolve(process.cwd(), '.env'), values);
  Object.assign(process.env, values);
  if (!enabled) { console.log(`[lux-tts-setup] LUX_TTS_ENABLED=${values.LUX_TTS_ENABLED}`); console.log('[lux-tts-setup] LuxTTS disabled'); return { python, installed: false, venvDir: venvDir(), binDir: venvBin() }; }
  if (!exists(python)) { const source = bootstrapPython(); if (!source) throw new Error('No Python executable found for LuxTTS setup.'); if (installIfMissing) { console.log(`[lux-tts-setup] Creating ${venvDir()} with ${source}`); run(source, ['-m','venv',venvDir()]); } }
  if (!moduleInstalled(python, 'zipvoice') || !moduleInstalled(python, 'numpy') || !moduleInstalled(python, 'linacodec')) { if (!installIfMissing) console.warn('[lux-tts-setup] LuxTTS dependencies are missing and install is disabled.'); else { console.log('[lux-tts-setup] Installing LuxTTS dependencies into .venv-granite-asr...'); if (!moduleInstalled(python, 'linacodec')) run(python, ['-m','pip','install','--upgrade','--upgrade-strategy','only-if-needed',LINACODEC_PACKAGE]); run(python, ['-m','pip','install','--upgrade','--upgrade-strategy','only-if-needed','--find-links',PIPER_PHONEMIZE_FIND_LINKS,...PACKAGES]); } }
  const ready = exists(python) && moduleInstalled(python, 'zipvoice') && moduleInstalled(python, 'numpy');
  console.log(`[lux-tts-setup] LUX_TTS_ENABLED=${values.LUX_TTS_ENABLED}`); console.log(`[lux-tts-setup] LUX_TTS_PYTHON=${values.LUX_TTS_PYTHON}`); console.log(`[lux-tts-setup] LuxTTS dependencies ${ready ? 'ready' : 'not installed'}`);
  if (!ready && installIfMissing) throw new Error('LuxTTS dependencies were not installed successfully.');
  return { python, installed: ready, venvDir: venvDir(), binDir: venvBin() };
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('lux-tts-setup.mjs')) {
  try { ensureLuxTtsEnvironment({ writeLocalEnv: !process.argv.includes('--no-env'), writeExampleEnv: !process.argv.includes('--no-env-example'), installIfMissing: !process.argv.includes('--no-install') }); }
  catch (error) { console.error(`[lux-tts-setup] ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
