import { mkdirSync } from 'node:fs';
import { copyFile, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import type { ChatAttachment } from '../shared/types.js';
import { resolveMinionsWorkspaceDir } from './paths.js';

const ATTACHMENT_TMP_DIR = join(tmpdir(), 'minions-chat-attachments');
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 10;

mkdirSync(ATTACHMENT_TMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: ATTACHMENT_TMP_DIR,
    filename: (_req, file, callback) => {
      callback(null, `${Date.now()}-${randomUUID()}-${safeFileName(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: MAX_ATTACHMENT_BYTES,
    files: MAX_ATTACHMENT_COUNT,
  },
}).array('attachments', MAX_ATTACHMENT_COUNT);

export function attachmentUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  upload(req, res, (error) => {
    if (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to upload attachments' });
      return;
    }
    next();
  });
}

export function uploadedAttachments(req: Request): Express.Multer.File[] {
  return Array.isArray(req.files) ? req.files : [];
}

export async function cleanupUploadedAttachments(files: Express.Multer.File[]): Promise<void> {
  await Promise.all(files.map((file) => unlink(file.path).catch(() => undefined)));
}

export async function saveTaskAttachments(
  taskId: string,
  files: Express.Multer.File[],
): Promise<ChatAttachment[]> {
  if (files.length === 0) return [];

  const attachmentDir = join(resolveMinionsWorkspaceDir(), 'attachments', taskId);
  mkdirSync(attachmentDir, { recursive: true });

  const attachments: ChatAttachment[] = [];

  for (const file of files) {
    const id = randomUUID();
    const safeName = safeFileName(file.originalname || 'attachment');
    const targetPath = join(attachmentDir, `${Date.now()}-${id}-${safeName}`);

    try {
      await rename(file.path, targetPath);
    } catch {
      await copyFile(file.path, targetPath);
      await unlink(file.path).catch(() => undefined);
    }

    attachments.push({
      id,
      name: file.originalname || safeName,
      path: targetPath,
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      kind: (file.mimetype || '').startsWith('image/') ? 'image' : 'file',
    });
  }

  return attachments;
}

export function appendAttachmentContext(message: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return message;

  const lines = attachments.map((attachment, index) => {
    return [
      `  <attachment index="${index + 1}" kind="${attachment.kind}">`,
      `    <name>${escapeXml(attachment.name)}</name>`,
      `    <mime_type>${escapeXml(attachment.mimeType)}</mime_type>`,
      `    <size_bytes>${attachment.size}</size_bytes>`,
      `    <absolute_path>${escapeXml(attachment.path)}</absolute_path>`,
      '  </attachment>',
    ].join('\n');
  });

  return `${message.trimEnd()}

The user attached the following file${attachments.length === 1 ? '' : 's'}. Use the absolute path to inspect image/file content when it is relevant.
<attachments>
${lines.join('\n')}
</attachments>`;
}

function safeFileName(value: string): string {
  const name = basename(value).trim().replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '_');
  return name || 'attachment';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
