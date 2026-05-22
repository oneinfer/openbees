import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Router } from 'express';
import { resolveWorkspacePath } from '../workspace-access.js';

const execFileAsync = promisify(execFile);

export const systemRouter = Router();

function parseInitialPath(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('initialPath must be a string or null');
  const trimmed = value.trim();
  if (!trimmed) return null;
  return resolveWorkspacePath(trimmed);
}

function toPowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parsePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('path is required');
  return resolveWorkspacePath(value.trim());
}

async function openWindowsDirectoryPicker(initialPath: string | null): Promise<string | null> {
  const initialSelection = initialPath
    ? `$dialog.SelectedPath = ${toPowerShellLiteral(initialPath)}`
    : '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Select working directory'",
    '$dialog.ShowNewFolderButton = $false',
    initialSelection,
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.SelectedPath)',
    '}',
  ].filter(Boolean).join('; ');

  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf8',
    windowsHide: false,
  });
  const selectedPath = stdout.trim();
  return selectedPath ? resolveWorkspacePath(selectedPath) : null;
}

async function openMacDirectoryPicker(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "Select working directory")',
    ], { encoding: 'utf8' });
    const selectedPath = stdout.trim();
    return selectedPath ? resolveWorkspacePath(selectedPath) : null;
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: number }).code : undefined;
    if (code === 1) return null;
    throw error;
  }
}

async function openLinuxDirectoryPicker(initialPath: string | null): Promise<string | null> {
  try {
    const args = ['--file-selection', '--directory', '--title=Select working directory'];
    if (initialPath) args.push(`--filename=${initialPath}`);
    const { stdout } = await execFileAsync('zenity', args, { encoding: 'utf8' });
    const selectedPath = stdout.trim();
    return selectedPath ? resolveWorkspacePath(selectedPath) : null;
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: number }).code : undefined;
    if (code === 1) return null;
    throw error;
  }
}

async function openDirectoryPicker(initialPath: string | null): Promise<string | null> {
  switch (process.platform) {
    case 'win32':
      return openWindowsDirectoryPicker(initialPath);
    case 'darwin':
      return openMacDirectoryPicker();
    case 'linux':
      return openLinuxDirectoryPicker(initialPath);
    default:
      throw new Error(`Folder picking is not supported on ${process.platform}`);
  }
}

systemRouter.post('/select-directory', async (req, res) => {
  let initialPath: string | null;
  try {
    initialPath = parseInitialPath(req.body?.initialPath);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid initialPath' });
  }

  try {
    const path = await openDirectoryPicker(initialPath);
    res.json({ path });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to open folder picker' });
  }
});

systemRouter.post('/open-path', async (req, res) => {
  let targetPath: string;
  try {
    targetPath = parsePath(req.body?.path);
    await stat(targetPath);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid path' });
  }

  try {
    switch (process.platform) {
      case 'win32':
        await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-Command',
          `Start-Process -LiteralPath ${toPowerShellLiteral(targetPath)}`,
        ], { windowsHide: true });
        break;
      case 'darwin':
        await execFileAsync('open', [targetPath]);
        break;
      case 'linux':
        await execFileAsync('xdg-open', [targetPath]);
        break;
      default:
        throw new Error(`Opening files is not supported on ${process.platform}`);
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to open path' });
  }
});
