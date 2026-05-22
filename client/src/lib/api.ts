import type {
  AgentDefaults,
  AgentModelsResponse,
  AgentRuntime,
  AgentRuntimeInstallResponse,
  AgentRuntimesResponse,
  AgentRunSettings,
  CronJob,
  CronRun,
  FileCreateResponse,
  FileCreateType,
  FileDeleteResponse,
  FileListResponse,
  FileReadResponse,
  FileRenameResponse,
  FileUploadResponse,
  FileWriteResponse,
  ContextUsage,
  Project,
  SessionMetadata,
  Task,
  TaskAgentSettings,
  TaskKind,
  TaskMode,
  TaskMessage,
  TaskStatus,
  ReasoningEffort,
} from '@shared/types';

export type { AgentRunSettings };

export const BASE = '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  key: string;
  source: string;
  bundled: boolean;
  readOnly: boolean;
  autoIncluded: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: extraHeaders, ...rest } = init ?? {};
  const isFormDataBody = typeof FormData !== 'undefined' && rest.body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    headers: isFormDataBody
      ? extraHeaders
      : { 'Content-Type': 'application/json', ...extraHeaders as Record<string, string> },
    ...rest,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
    throw new ApiError(message, res.status, code);
  }
  return res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function fetchTasks() {
  return request<{ tasks: Task[] }>('/tasks');
}

export function fetchProjects() {
  return request<{ projects: Project[] }>('/projects');
}

export function createProject(workspacePath: string) {
  return request<{ project: Project }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ workspacePath }),
  });
}

export function deleteProject(workspacePath: string) {
  return request<{ ok: boolean; taskIds: string[] }>('/projects', {
    method: 'DELETE',
    body: JSON.stringify({ workspacePath }),
  });
}

export function moveTask(id: string, status: TaskStatus) {
  return request<{ task: Task }>(`/tasks/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

export function deleteTask(id: string) {
  return request<{ ok: boolean }>(`/tasks/${id}`, { method: 'DELETE' });
}

export function patchTask(
  id: string,
  fields: { title?: string; description?: string; status?: TaskStatus; workspacePath?: string | null; runtime?: AgentRuntime | null },
) {
  return request<{ task: Task }>(`/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

export function markTaskViewed(id: string) {
  return request<{ task: Task }>(`/tasks/${id}/viewed`, {
    method: 'POST',
  });
}

export function createTask(
  description: string,
  title?: string,
  workspacePath?: string | null,
  runtime?: AgentRuntime | null,
  model?: string | null,
  reasoningEffort?: ReasoningEffort | null,
  taskMode?: TaskMode,
  attachments?: File[],
  taskKind?: TaskKind,
) {
  if (attachments?.length) {
    const formData = new FormData();
    formData.append('description', description);
    appendOptionalFormValue(formData, 'title', title);
    appendOptionalFormValue(formData, 'workspacePath', workspacePath);
    appendOptionalFormValue(formData, 'runtime', runtime);
    appendOptionalFormValue(formData, 'model', model);
    appendOptionalFormValue(formData, 'reasoningEffort', reasoningEffort);
    appendOptionalFormValue(formData, 'taskMode', taskMode);
    appendOptionalFormValue(formData, 'taskKind', taskKind);
    for (const attachment of attachments) {
      formData.append('attachments', attachment, attachment.name);
    }

    return request<{ task: Task }>('/tasks', {
      method: 'POST',
      body: formData,
    });
  }

  return request<{ task: Task }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({ description, title, workspacePath, runtime, model, reasoningEffort, taskMode, taskKind }),
  });
}

export function fetchMessages(taskId: string) {
  return request<{ messages: TaskMessage[]; context?: ContextUsage | null }>(`/tasks/${taskId}/messages`);
}

export function fetchSession(taskId: string) {
  return request<{ session: SessionMetadata | null }>(`/tasks/${taskId}/session`);
}

export function fetchHealth() {
  return request<{ ok: boolean; hermes: boolean; runtimes: Record<AgentRuntime, boolean> }>('/health');
}

export function fetchAgentDefaults() {
  return request<AgentDefaults>('/agent/defaults');
}

export function pickWorkspaceDirectory(initialPath?: string | null) {
  return request<{ path: string | null }>('/system/select-directory', {
    method: 'POST',
    body: JSON.stringify({ initialPath: initialPath ?? null }),
  });
}

export function openSystemPath(path: string) {
  return request<{ ok: boolean }>('/system/open-path', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

export function fetchAgentModels(runtime?: AgentRuntime | null) {
  const query = runtime ? `?runtime=${encodeURIComponent(runtime)}` : '';
  return request<AgentModelsResponse>(`/agent/models${query}`);
}

export function fetchAgentRuntimes() {
  return request<AgentRuntimesResponse>('/agent/runtimes');
}

export function installAgentRuntime(runtime: AgentRuntime) {
  return request<AgentRuntimeInstallResponse>(`/agent/runtimes/${encodeURIComponent(runtime)}/install`, {
    method: 'POST',
  });
}

export function updateAgentDefaults(updates: { runtime?: AgentRuntime | null; model?: string | null; reasoningEffort?: ReasoningEffort | null }) {
  return request<AgentDefaults>('/agent/defaults', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function fetchTaskAgentSettings(taskId: string) {
  return request<TaskAgentSettings>(`/tasks/${taskId}/agent-settings`);
}


export function fetchCronJobs(includeDisabled = true) {
  return request<{ jobs: CronJob[] }>(`/cron/jobs?includeDisabled=${includeDisabled ? 'true' : 'false'}`);
}

export function fetchSkills() {
  return request<{ skills: SkillMeta[] }>('/skills');
}

export function fetchSkillContent(id: string) {
  return request<{ skill: SkillMeta; content: string }>(`/skills/${encodeURIComponent(id)}/content`);
}

export function listFiles(path = '~/.minions/workspace') {
  return request<FileListResponse>(`/files/list?path=${encodeURIComponent(path)}`);
}

export function readFile(path: string) {
  return request<FileReadResponse>(`/files/read?path=${encodeURIComponent(path)}`);
}

export function fileDownloadUrl(path: string) {
  return `${BASE}/files/download?path=${encodeURIComponent(path)}`;
}

export function fileViewUrl(path: string) {
  return `${BASE}/files/view?path=${encodeURIComponent(path)}`;
}

export function writeFile(path: string, content: string, expectedModifiedAt?: number, overwrite = false) {
  return request<FileWriteResponse>('/files/write', {
    method: 'PUT',
    body: JSON.stringify({ path, content, expectedModifiedAt, overwrite }),
  });
}

export function createFileEntry(parentPath: string, name: string, type: FileCreateType, content?: string) {
  return request<FileCreateResponse>('/files/create', {
    method: 'POST',
    body: JSON.stringify({ parentPath, name, type, content }),
  });
}

export function renameFileEntry(path: string, newName: string) {
  return request<FileRenameResponse>('/files/rename', {
    method: 'PATCH',
    body: JSON.stringify({ path, newName }),
  });
}

export function uploadFileEntries(parentPath: string, files: File[]) {
  const formData = new FormData();
  formData.append('targetPath', parentPath);

  for (const file of files) {
    const relativePath = fileRelativePath(file);
    formData.append('files', file, file.name);
    formData.append('relativePaths', relativePath);
  }

  return request<FileUploadResponse>('/files/upload', {
    method: 'POST',
    body: formData,
  });
}

export function deleteFileEntry(path: string, recursive = false) {
  return request<FileDeleteResponse>('/files', {
    method: 'DELETE',
    body: JSON.stringify({ path, recursive }),
  });
}

export function fetchCronRuns(jobId: string, limit = 20) {
  return request<{ runs: CronRun[] }>(`/cron/jobs/${encodeURIComponent(jobId)}/runs?limit=${limit}`);
}

export function fetchCronRunContent(jobId: string, runId: string) {
  return request<{ content: string }>(`/cron/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}/content`);
}

export function pauseCronJob(jobId: string, reason?: string) {
  return request<{ job: CronJob }>(`/cron/jobs/${encodeURIComponent(jobId)}/pause`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function resumeCronJob(jobId: string) {
  return request<{ job: CronJob }>(`/cron/jobs/${encodeURIComponent(jobId)}/resume`, {
    method: 'POST',
  });
}

export function runCronJob(jobId: string) {
  return request<{ job: CronJob }>(`/cron/jobs/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
  });
}

export function deleteCronJob(jobId: string) {
  return request<{ ok: boolean }>(`/cron/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
}

function fileRelativePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath && relativePath.length > 0 ? relativePath : file.name;
}

function appendOptionalFormValue(formData: FormData, key: string, value: string | null | undefined): void {
  if (value !== undefined && value !== null && value !== '') formData.append(key, value);
}
