import { spawn } from 'node:child_process';
import type { Task } from '../shared/types.js';

const NOTIFICATION_TIMEOUT_MS = 8000;

export function notifyTaskCreated(task: Pick<Task, 'title' | 'status'>): void {
  const title = 'Bees task created';
  const body = `Task ${task.status === 'in_progress' ? 'created and started' : 'created'}: ${task.title}`;

  try {
    if (process.platform === 'win32') {
      notifyWindows(title, body);
    } else if (process.platform === 'darwin') {
      notifyMac(title, body);
    } else {
      notifyLinux(title, body);
    }
  } catch {
    // Native notifications are best-effort; task creation should never depend on them.
  }
}

function notifyWindows(title: string, body: string): void {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$title = ${powershellString(title)}`,
    `$body = ${powershellString(body)}`,
    'try {',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$escapedTitle = [System.Security.SecurityElement]::Escape($title)',
    '$escapedBody = [System.Security.SecurityElement]::Escape($body)',
    '$template = "<toast><visual><binding template=\\"ToastGeneric\\"><text>$escapedTitle</text><text>$escapedBody</text></binding></visual></toast>"',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml($template)',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    '$toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds(30)',
    '$toast.Tag = "bees-task-created"',
    '$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.Windows.PowerShell")',
    '$notifier.Show($toast)',
    '} catch {',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$notify = New-Object System.Windows.Forms.NotifyIcon',
    '$notify.Icon = [System.Drawing.SystemIcons]::Information',
    '$notify.BalloonTipTitle = $title',
    '$notify.BalloonTipText = $body',
    '$notify.Visible = $true',
    '$notify.ShowBalloonTip(6000)',
    'Start-Sleep -Milliseconds 6500',
    '$notify.Dispose()',
    '}',
  ].join('; ');

  spawnDetached('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);
}

function notifyMac(title: string, body: string): void {
  spawnDetached('osascript', [
    '-e',
    `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`,
  ]);
}

function notifyLinux(title: string, body: string): void {
  spawnDetached('notify-send', [title, body]);
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  const timer = setTimeout(() => {
    if (!child.killed) child.kill();
  }, NOTIFICATION_TIMEOUT_MS);
  timer.unref();

  child.once('error', () => {
    clearTimeout(timer);
  });
  child.once('exit', () => {
    clearTimeout(timer);
  });
  child.unref();
}

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
