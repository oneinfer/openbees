import { spawn } from 'node:child_process';
import type { AgentRuntime, AgentRuntimeInstallResponse } from '../shared/types.js';
import { runtimeCommandAvailable, runtimeInstallResponse, runtimeInstaller } from './runtime-config.js';

const activeInstalls = new Map<AgentRuntime, Promise<AgentRuntimeInstallResponse>>();

function npmInstallCommand(args: string[]): { executable: string; args: string[]; label: string } {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath) {
    return {
      executable: process.execPath,
      args: [npmExecPath, ...args],
      label: ['npm', ...args].join(' '),
    };
  }

  return {
    executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    label: ['npm', ...args].join(' '),
  };
}

function trimOutput(output: string): string {
  const normalized = output.trim();
  if (normalized.length <= 4000) return normalized;
  return normalized.slice(normalized.length - 4000);
}

async function runInstall(runtime: AgentRuntime): Promise<AgentRuntimeInstallResponse> {
  const installer = runtimeInstaller(runtime);
  const response = runtimeInstallResponse(runtime);
  if (!installer || !response) {
    throw new Error('This runtime cannot be installed automatically');
  }

  if (runtimeCommandAvailable(runtime)) return response;

  const command = npmInstallCommand(installer.command.slice(1));
  const output = await new Promise<string>((resolveInstall, reject) => {
    const child = spawn(command.executable, command.args, {
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let combined = '';
    child.stdout.on('data', (chunk) => { combined += String(chunk); });
    child.stderr.on('data', (chunk) => { combined += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveInstall(combined);
        return;
      }
      reject(new Error(trimOutput(combined) || `${command.label} exited with code ${code ?? 'unknown'}`));
    });
  });

  const installed = runtimeInstallResponse(runtime, trimOutput(output));
  if (!installed?.installed) {
    throw new Error(`${response.packageName} installed, but ${response.command ?? runtime} was not found on PATH. Restart the dev server or update PATH.`);
  }

  return installed;
}

export async function installRuntime(runtime: AgentRuntime): Promise<AgentRuntimeInstallResponse> {
  const existing = activeInstalls.get(runtime);
  if (existing) return await existing;

  const install = runInstall(runtime).finally(() => {
    activeInstalls.delete(runtime);
  });
  activeInstalls.set(runtime, install);
  return await install;
}
