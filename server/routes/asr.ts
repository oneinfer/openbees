import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { qwenAsr, QwenAsrError } from '../asr/qwen-worker.js';

const router = Router();
const ASR_TMP_DIR = join(tmpdir(), 'bees-qwen-asr');
const DEFAULT_MAX_AUDIO_MB = 25;

mkdirSync(ASR_TMP_DIR, { recursive: true });

function maxAudioBytes(): number {
  const configured = Number(process.env.QWEN_ASR_MAX_AUDIO_MB ?? DEFAULT_MAX_AUDIO_MB);
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_AUDIO_MB;
  return megabytes * 1024 * 1024;
}

function safeFileName(value: string): string {
  const name = basename(value).trim().replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '_');
  return name || 'speech.webm';
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

router.get('/status', async (_req, res) => {
  res.json(await qwenAsr.status());
});

router.post('/transcribe', audioUploadMiddleware, async (req, res) => {
  const file = uploadedAudio(req);
  if (!file) return res.status(400).json({ error: 'audio is required' });

  try {
    const language = typeof req.body?.language === 'string' ? req.body.language.trim() || null : null;
    const result = await qwenAsr.transcribe(file.path, language);
    res.json(result);
  } catch (error) {
    const status = error instanceof QwenAsrError && error.code === 'disabled' ? 503 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    await unlink(file.path).catch(() => undefined);
  }
});

export const asrRouter = router;
