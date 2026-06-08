import { mkdirSync } from 'node:fs';
import { copyFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { graniteAsr, GraniteAsrError } from '../asr/granite-worker.js';
import { agents } from '../app.js';
import { activityDaemon } from '../activity-daemon.js';
import { parseRunSettingsBody } from '../agent-settings.js';
import { broadcast } from '../events.js';
import { toErrorMessage } from '../errors.js';
import { normalizeActivityIntentDecision } from '../prompts/activity-intent.js';
import { createTaskRecord, startTaskImmediately } from '../task-service.js';
import { defaultRuntime, parseRuntimeValue } from '../runtime-config.js';
import { parseWorkspacePath } from '../workspace-access.js';
import { saveProject, setAppSetting, updateTask } from '../db/queries.js';
import { CURRENT_PROJECT_SETTING_KEY } from './projects.js';
import { TASK_MODES } from '../../shared/types.js';
import type { ActivityIntentDecision, AsrTaskIntentResponse, AsrTranscriptionResponse, TaskMode } from '../../shared/types.js';
import { notifyTaskCreated } from '../native-notifications.js';
import { resolveBeesHome } from '../paths.js';

const router = Router();
const ASR_TMP_DIR = join(tmpdir(), 'bees-granite-asr');
const DEFAULT_MAX_AUDIO_MB = 25;

mkdirSync(ASR_TMP_DIR, { recursive: true });

function maxAudioBytes(): number {
  const configured = Number(process.env.GRANITE_ASR_MAX_AUDIO_MB ?? process.env.QWEN_ASR_MAX_AUDIO_MB ?? DEFAULT_MAX_AUDIO_MB);
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_AUDIO_MB;
  return megabytes * 1024 * 1024;
}

function safeFileName(value: string): string {
  const name = basename(value).trim().replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '_');
  return name || 'speech.webm';
}

function debugAsrUploadsEnabled(): boolean {
  const value = (process.env.BEES_ASR_DEBUG_SAVE_AUDIO ?? process.env.GRANITE_ASR_DEBUG_SAVE_AUDIO ?? '')
    .trim()
    .toLowerCase();
  return new Set(['true', '1', 'yes', 'on']).has(value);
}

function debugAsrUploadDir(): string {
  const configured = process.env.BEES_ASR_DEBUG_AUDIO_DIR?.trim() || process.env.GRANITE_ASR_DEBUG_AUDIO_DIR?.trim();
  return configured || join(resolveBeesHome(), 'audio-debug', 'click-record-button');
}

async function saveDebugUpload(file: Express.Multer.File, route: string): Promise<void> {
  if (!debugAsrUploadsEnabled()) return;

  const dir = debugAsrUploadDir();
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '').replace('Z', 'Z');
  const extension = extname(file.originalname || file.filename) || '.wav';
  const safeRoute = route.replace(/[^a-zA-Z0-9_.-]+/g, '_');
  const audioPath = join(dir, `${timestamp}_${randomUUID()}_${safeRoute}${extension}`);
  await copyFile(file.path, audioPath);
  const fileStat = await stat(audioPath);
  await writeFile(
    audioPath.replace(/\.[^./\\]+$/, '.json'),
    JSON.stringify({
      route,
      savedAt: now.toISOString(),
      audioPath,
      uploadTempPath: file.path,
      originalName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: fileStat.size,
    }, null, 2),
    'utf-8',
  );
  console.log(`[asr] saved debug upload ${route}: ${audioPath}`);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: ASR_TMP_DIR,
    filename: (_req, file, callback) => {
      callback(null, `${Date.now()}-${randomUUID()}-${safeFileName(file.originalname || 'speech.webm')}`);
    },
  }),
  limits: {
    fileSize: maxAudioBytes(),
    files: 1,
  },
}).single('audio');

function audioUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  upload(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    const message = error instanceof Error ? error.message : 'Failed to upload audio';
    const isLimit = typeof error === 'object' && error !== null && (error as { code?: string }).code === 'LIMIT_FILE_SIZE';
    res.status(isLimit ? 413 : 400).json({ error: message });
  });
}

function uploadedAudio(req: Request): Express.Multer.File | null {
  return 'file' in req && req.file ? req.file : null;
}

function parseTaskMode(value: unknown): TaskMode {
  if (value === undefined || value === null || value === '') return 'direct';
  if (typeof value !== 'string' || !(TASK_MODES as readonly string[]).includes(value)) {
    throw new Error(`taskMode must be one of: ${TASK_MODES.join(', ')}`);
  }
  return value as TaskMode;
}

function noCreateDecision(reason: string, transcript = ''): ActivityIntentDecision {
  return {
    action: 'save_context',
    title: 'Saved voice input',
    taskDescription: transcript,
    hasEnoughContext: false,
    screenContextRequired: false,
    reason,
  };
}

function insertForEditResponse(
  transcript: AsrTranscriptionResponse,
  reason: string,
  decision?: ActivityIntentDecision,
  error?: string,
): AsrTaskIntentResponse {
  return {
    transcript,
    decision: decision ?? noCreateDecision(reason, transcript.text),
    actionTaken: 'insert_for_edit',
    ...(error ? { error } : {}),
  };
}

async function transcribeWithLoadedRuntime(filePath: string, language?: string | null): Promise<AsrTranscriptionResponse> {
  try {
    const transcript = await activityDaemon.transcribeFile(filePath, language);
    console.log('[asr] transcribed via activity daemon loaded ASR model');
    return transcript;
  } catch (error) {
    console.warn(`[asr] activity daemon ASR unavailable; falling back to Granite worker: ${error instanceof Error ? error.message : String(error)}`);
    return await graniteAsr.transcribe(filePath, language);
  }
}

router.get('/status', async (_req, res) => {
  res.json(await graniteAsr.status());
});

router.post('/transcribe', audioUploadMiddleware, async (req, res) => {
  const file = uploadedAudio(req);
  if (!file) return res.status(400).json({ error: 'audio is required' });

  try {
    await saveDebugUpload(file, 'transcribe').catch((error) => {
      console.warn(`[asr] failed to save debug upload: ${error instanceof Error ? error.message : String(error)}`);
    });
    const language = typeof req.body?.language === 'string' ? req.body.language.trim() || null : null;
    const result = await transcribeWithLoadedRuntime(file.path, language);
    res.json(result);
  } catch (error) {
    const status = error instanceof GraniteAsrError && error.code === 'disabled' ? 503 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    await unlink(file.path).catch(() => undefined);
  }
});

router.post('/transcribe-task-intent', audioUploadMiddleware, async (req, res) => {
  const file = uploadedAudio(req);
  if (!file) return res.status(400).json({ error: 'audio is required' });

  try {
    await saveDebugUpload(file, 'transcribe_task_intent').catch((error) => {
      console.warn(`[asr] failed to save debug upload: ${error instanceof Error ? error.message : String(error)}`);
    });
    const language = typeof req.body?.language === 'string' ? req.body.language.trim() || null : null;
    const transcript = await transcribeWithLoadedRuntime(file.path, language);
    const transcriptText = transcript.text.trim();

    if (!transcriptText) {
      return res.json(insertForEditResponse(
        transcript,
        'No speech was detected. Add more detail and submit manually.',
      ));
    }

    let runSettings: ReturnType<typeof parseRunSettingsBody>;
    let requestedRuntime: ReturnType<typeof parseRuntimeValue>;
    let workspacePath: string | null;
    let taskMode: TaskMode;
    try {
      runSettings = parseRunSettingsBody(req.body);
      requestedRuntime = parseRuntimeValue(req.body.runtime);
      workspacePath = parseWorkspacePath(req.body) ?? null;
      taskMode = parseTaskMode(req.body.taskMode ?? req.body.task_mode);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid voice task settings' });
    }
    const defaults = await agents.defaults().catch(() => null);
    const runtime = requestedRuntime ?? runSettings.taskFields.agent_runtime ?? agents.defaultRuntime();
    const model = runSettings.taskFields.agent_model ?? defaults?.model ?? null;
    const reasoningEffort = runSettings.taskFields.reasoning_effort ?? defaults?.reasoningEffort ?? null;

    let decision: ActivityIntentDecision;
    try {
      decision = normalizeActivityIntentDecision(
        await agents.adapterFor(runtime).judgeActivityIntent(transcriptText, {
          source: 'browser_voice_new_task',
          model,
          reasoningEffort,
        }),
        transcriptText,
      );
    } catch (error) {
      const message = toErrorMessage(error, 'Voice intent classification failed');
      return res.json(insertForEditResponse(
        transcript,
        `${message}. Review the transcript and submit manually.`,
        noCreateDecision(`${message}. Review the transcript and submit manually.`, transcriptText),
        message,
      ));
    }

    if (decision.action !== 'create_task' || !decision.hasEnoughContext) {
      return res.json(insertForEditResponse(transcript, decision.reason, decision));
    }

    let task = createTaskRecord({
      title: decision.title,
      description: decision.taskDescription || transcriptText,
      status: 'pending',
      taskKind: 'task',
      taskMode,
      workspacePath,
      runtime: runtime ?? defaultRuntime(),
      model,
      reasoningEffort,
    });

    try {
      task = startTaskImmediately(task);
    } catch (error) {
      const reverted = updateTask(task.id, { status: 'pending' }) ?? task;
      notifyTaskCreated(reverted);
      broadcast({ type: 'task_created', task: reverted });
      const message = toErrorMessage(error, 'Task was created but could not be activated');
      return res.status(409).json({
        ...insertForEditResponse(transcript, message, decision, message),
        task: reverted,
      });
    }

    if (workspacePath) {
      const project = saveProject({ path: workspacePath });
      setAppSetting(CURRENT_PROJECT_SETTING_KEY, workspacePath);
      broadcast({ type: 'project_saved', project });
    }

    notifyTaskCreated(task);
    broadcast({ type: 'task_created', task });
    res.status(201).json({
      transcript,
      decision,
      actionTaken: 'task_created_started',
      task,
    } satisfies AsrTaskIntentResponse);
  } catch (error) {
    const status = error instanceof GraniteAsrError && error.code === 'disabled' ? 503 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    await unlink(file.path).catch(() => undefined);
  }
});

export const asrRouter = router;
