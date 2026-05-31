import { spawn } from 'node:child_process';

export function openBrowserForDev(url: string): void {
  if (process.env.NODE_ENV !== 'development') return;
  if (!envFlagEnabled(process.env.BEES_OPEN_BROWSER, true)) return;

  const command = process.platform === 'win32'
    ? 'cmd'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    console.warn(`Could not open browser automatically: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function envFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}
