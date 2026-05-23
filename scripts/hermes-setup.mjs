import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERMES_INSTALL_SH_URL = 'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh';
const HERMES_INSTALL_PS1_URL = 'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1';
const HERMES_KEYS = ['HERMES_AGENT_DIR', 'HERMES_PYTHON', 'HERMES_HOME'];

function isWindows() {
  return platform() === 'win32';
}

function expandHomePrefix(value) {
  if (!value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function existingDirectory(value) {
  if (!value) return null;
  try {
    const expanded = resolve(expandHomePrefix(value));
    return existsSync(expanded) && statSync(expanded).isDirectory() ? expanded : null;
  } catch {
    return null;
  }
}

function existingFile(value) {
  if (!value) return null;
  try {
    const expanded = resolve(expandHomePrefix(value));
    return existsSync(expanded) && statSync(expanded).isFile() ? expanded : null;
  } catch {
    return null;
  }
}

function hasHermesSource(agentDir) {
  return Boolean(existingFile(join(agentDir, 'run_agent.py')));
}

function pythonCandidatesForAgentDir(agentDir) {
  return isWindows()
    ? [
        join(agentDir, 'venv', 'Scripts', 'python.exe'),
        join(agentDir, 'venv', 'python.exe'),
      ]
    : [
        join(agentDir, 'venv', 'bin', 'python'),
      ];
}

function findPythonForAgentDir(agentDir) {
  return pythonCandidatesForAgentDir(agentDir).find((candidate) => existingFile(candidate)) ?? null;
}

function inferHermesHome(agentDir) {
  const normalized = resolve(agentDir);
  const parent = dirname(normalized);
  if (basename(normalized).toLowerCase() === 'hermes-agent') {
    if (isWindows() && basename(parent).toLowerCase() === 'hermes') {
      const localHome = join(parent, 'home');
      if (existingDirectory(localHome) || existingDirectory(parent)) return localHome;
    }
    if (parent === join(homedir(), '.hermes')) return parent;
    return parent;
  }
  return process.env.HERMES_HOME?.trim() ? resolve(expandHomePrefix(process.env.HERMES_HOME.trim())) : join(homedir(), '.hermes');
}

function resolveAgentDirFromHermesCli() {
  try {
    const lookup = execFileSync(isWindows() ? 'where.exe' : 'which', ['hermes'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!lookup) return null;

    const real = realpathSync(lookup);
    const candidates = isWindows()
      ? [
          resolve(dirname(real), '..', 'hermes-agent'),
          resolve(dirname(real), '..', '..'),
          resolve(dirname(real), '..', '..', 'hermes-agent'),
        ]
      : [
          resolve(dirname(real), '..', '..'),
          resolve(dirname(real), '..', '..', '..', 'lib', 'hermes-agent'),
        ];

    return candidates.find((candidate) => hasHermesSource(candidate)) ?? null;
  } catch {
    return null;
  }
}

function envCandidates() {
  const candidates = [];
  if (process.env.HERMES_AGENT_DIR?.trim()) candidates.push(process.env.HERMES_AGENT_DIR.trim());
  if (process.env.HERMES_HOME?.trim()) candidates.push(join(process.env.HERMES_HOME.trim(), 'hermes-agent'));
  return candidates;
}

function commonCandidates() {
  const candidates = [
    join(homedir(), '.hermes', 'hermes-agent'),
  ];

  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    const appData = process.env.APPDATA?.trim();
    const programData = process.env.ProgramData?.trim() || process.env.PROGRAMDATA?.trim();
    if (localAppData) candidates.push(join(localAppData, 'hermes', 'hermes-agent'));
    if (appData) candidates.push(join(appData, 'hermes', 'hermes-agent'));
    if (programData) candidates.push(join(programData, 'hermes', 'hermes-agent'));
    candidates.push(...windowsUserProfileCandidates());
  } else {
    candidates.push('/usr/local/lib/hermes-agent');
    candidates.push('/opt/hermes-agent');
  }

  return candidates;
}

function windowsUserProfileCandidates() {
  const usersDir = process.env.SystemDrive ? `${process.env.SystemDrive}\\Users` : 'C:\\Users';
  let entries = [];
  try {
    entries = readdirSync(usersDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('Default') && entry.name !== 'Public' && entry.name !== 'All Users')
    .flatMap((entry) => {
      const profile = join(usersDir, entry.name);
      return [
        join(profile, '.hermes', 'hermes-agent'),
        join(profile, 'AppData', 'Local', 'hermes', 'hermes-agent'),
      ];
    });
}

function fullScanRoots() {
  const configured = process.env.BEES_HERMES_SCAN_ROOTS?.trim();
  if (configured) return configured.split(isWindows() ? ';' : ':').map((value) => value.trim()).filter(Boolean);

  if (isWindows()) {
    const roots = [];
    for (let code = 67; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      if (existingDirectory(root)) roots.push(root);
    }
    return roots;
  }

  return [homedir(), '/usr/local', '/opt'];
}

function shouldSkipScanDir(path) {
  const name = basename(path).toLowerCase();
  return [
    '$recycle.bin',
    '.git',
    'node_modules',
    'windows',
    'system volume information',
    'program files',
    'program files (x86)',
  ].includes(name);
}

function scanForAgentDirs(roots, maxDepth = 7, maxEntries = 75_000) {
  const found = [];
  let visited = 0;
  const stack = roots.map((root) => ({ path: root, depth: 0 }));

  while (stack.length > 0 && visited < maxEntries) {
    const current = stack.pop();
    if (!current || current.depth > maxDepth || shouldSkipScanDir(current.path)) continue;
    visited += 1;

    if (basename(current.path).toLowerCase() === 'hermes-agent' && hasHermesSource(current.path)) {
      found.push(resolve(current.path));
      continue;
    }

    let entries = [];
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      stack.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }

  return found;
}

function discoverHermes({ fullScan = false } = {}) {
  const cliCandidate = resolveAgentDirFromHermesCli();
  const directCandidates = unique([
    ...envCandidates(),
    cliCandidate,
    ...commonCandidates(),
  ]);

  for (const candidate of directCandidates) {
    const dir = existingDirectory(candidate);
    if (dir && hasHermesSource(dir)) {
      const python = findPythonForAgentDir(dir);
      if (python) return { agentDir: dir, python, hermesHome: inferHermesHome(dir), source: 'detected' };
    }
  }

  if (fullScan) {
    for (const dir of scanForAgentDirs(fullScanRoots())) {
      const python = findPythonForAgentDir(dir);
      if (python) return { agentDir: dir, python, hermesHome: inferHermesHome(dir), source: 'scan' };
    }
  }

  return null;
}

function installHermes() {
  if (process.env.BEES_SKIP_HERMES_INSTALL === '1') {
    console.warn('[hermes-setup] Hermes install skipped because BEES_SKIP_HERMES_INSTALL=1.');
    return false;
  }

  console.log('[hermes-setup] Hermes was not found. Running the official Hermes installer...');
  const command = isWindows()
    ? {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `$script = irm ${HERMES_INSTALL_PS1_URL}; & ([scriptblock]::Create($script)) -SkipSetup -NonInteractive`,
        ],
      }
    : {
        file: 'bash',
        args: ['-lc', `curl -fsSL ${HERMES_INSTALL_SH_URL} | bash -s -- --skip-setup`],
      };

  const result = spawnSync(command.file, command.args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Hermes installer exited with code ${result.status ?? 'unknown'}.`);
  }

  return true;
}

function formatEnvValue(value) {
  return value;
}

function patchEnvContent(content, values) {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const present = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match || !Object.hasOwn(values, match[2])) return line;

    present.add(match[2]);
    const trailingComment = match[4].match(/(\s+#.*)$/)?.[1] ?? '';
    return `${match[1]}${match[2]}${match[3]}${formatEnvValue(values[match[2]])}${trailingComment}`;
  });

  if (next.length > 0 && next.at(-1) !== '') next.push('');
  for (const key of HERMES_KEYS) {
    if (!present.has(key)) next.push(`${key}=${formatEnvValue(values[key])}`);
  }

  return next.join('\n');
}

function writeEnvFile(path, values) {
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const patched = patchEnvContent(content, values);
  if (patched !== content) writeFileSync(path, patched, 'utf8');
}

function ensureProjectEnvFiles(discovery, { writeLocalEnv = true, writeExampleEnv = true } = {}) {
  const values = {
    HERMES_AGENT_DIR: discovery.agentDir,
    HERMES_PYTHON: discovery.python,
    HERMES_HOME: discovery.hermesHome,
  };

  if (writeExampleEnv) writeEnvFile(resolve(process.cwd(), '.env.example'), values);
  if (writeLocalEnv) writeEnvFile(resolve(process.cwd(), '.env'), values);
}

export function ensureHermesEnvironment(options = {}) {
  const {
    installIfMissing = true,
    fullScan = process.env.BEES_HERMES_FULL_SCAN === '1',
    writeLocalEnv = true,
    writeExampleEnv = true,
  } = options;

  let discovery = discoverHermes({ fullScan });
  if (!discovery && installIfMissing) {
    installHermes();
    discovery = discoverHermes({ fullScan: true });
  }

  if (!discovery) {
    throw new Error(
      'Hermes agent source was not found. Install Hermes or set HERMES_AGENT_DIR and HERMES_PYTHON manually.',
    );
  }

  ensureProjectEnvFiles(discovery, { writeLocalEnv, writeExampleEnv });
  process.env.HERMES_AGENT_DIR = discovery.agentDir;
  process.env.HERMES_PYTHON = discovery.python;
  process.env.HERMES_HOME = discovery.hermesHome;

  console.log(`[hermes-setup] HERMES_AGENT_DIR=${discovery.agentDir}`);
  console.log(`[hermes-setup] HERMES_PYTHON=${discovery.python}`);
  console.log(`[hermes-setup] HERMES_HOME=${discovery.hermesHome}`);
  return discovery;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  ensureHermesEnvironment({
    installIfMissing: !args.has('--no-install'),
    fullScan: args.has('--full-scan') || process.env.BEES_HERMES_FULL_SCAN === '1',
    writeLocalEnv: !args.has('--no-env'),
    writeExampleEnv: !args.has('--no-env-example'),
  });
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    console.error(`[hermes-setup] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
