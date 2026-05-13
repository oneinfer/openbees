const MIN_SUPPORTED_NODE_MAJOR = 20;
const MAX_SUPPORTED_NODE_MAJOR = 24;
const RECOMMENDED_NODE_VERSION = 'Node.js 22 LTS';
const SUPPORTED_NODE_RANGE = `>=${MIN_SUPPORTED_NODE_MAJOR} and <${MAX_SUPPORTED_NODE_MAJOR}`;

function getNodeMajor(version = process.versions.node) {
  return Number.parseInt(version.split('.')[0] ?? '', 10);
}

function getFixSteps(commandName) {
  const installCommand = 'npm install';

  if (!commandName || commandName === installCommand) {
    return [
      `  1. Switch to ${RECOMMENDED_NODE_VERSION}`,
      '  2. Delete node_modules',
      `  3. Run ${installCommand}`,
    ];
  }

  return [
    `  1. Switch to ${RECOMMENDED_NODE_VERSION}`,
    '  2. Delete node_modules',
    `  3. Run ${installCommand}`,
    `  4. Run ${commandName}`,
  ];
}

export function ensureSupportedNodeVersion(commandName) {
  const detectedVersion = process.versions.node;
  const major = getNodeMajor(detectedVersion);

  if (Number.isFinite(major) && major >= MIN_SUPPORTED_NODE_MAJOR && major < MAX_SUPPORTED_NODE_MAJOR) {
    return;
  }

  console.error(
    [
      '',
      'Unsupported Node.js version for this project.',
      `Detected: ${detectedVersion}`,
      `Required: ${SUPPORTED_NODE_RANGE}`,
      '',
      `Recommended: ${RECOMMENDED_NODE_VERSION}`,
      'Reason: better-sqlite3 does not currently install cleanly on Windows with Node 24 unless you compile it with Visual Studio C++ build tools.',
      'If dependencies were installed under a different Node version, native modules like better-sqlite3 will fail to load.',
      '',
      'Please switch Node versions and reinstall dependencies:',
      ...getFixSteps(commandName),
      '',
    ].join('\n'),
  );

  process.exit(1);
}
