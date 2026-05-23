import { readFile } from 'node:fs/promises';
import type { ChatAttachment } from '../shared/types.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_OUTPUT_TOKENS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_IMAGE_CONTEXT_BYTES = 20 * 1024 * 1024;

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
  };
}

export async function enrichImageAttachmentContext(
  attachments: ChatAttachment[],
): Promise<ChatAttachment[]> {
  if (attachments.length === 0 || !imageContextEnabled()) return attachments;

  const enriched: ChatAttachment[] = [];
  for (const attachment of attachments) {
    if (!shouldSummarizeImage(attachment)) {
      enriched.push(attachment);
      continue;
    }

    try {
      const visualSummary = await summarizeImageAttachment(attachment);
      enriched.push(visualSummary ? { ...attachment, visualSummary } : attachment);
    } catch (error) {
      console.warn(`Failed to summarize image attachment ${attachment.name}:`, error);
      enriched.push(attachment);
    }
  }

  return enriched;
}

export function imageContextEnabled(): boolean {
  if (process.env.BEES_IMAGE_CONTEXT_ENABLED === 'false') return false;
  return Boolean(imageContextApiKey());
}

function shouldSummarizeImage(attachment: ChatAttachment): boolean {
  if (attachment.kind !== 'image') return false;
  if (attachment.size > MAX_IMAGE_CONTEXT_BYTES) return false;
  return SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType.toLowerCase());
}

async function summarizeImageAttachment(attachment: ChatAttachment): Promise<string | null> {
  const apiKey = imageContextApiKey();
  if (!apiKey) return null;

  const image = await readFile(attachment.path);
  if (image.length > MAX_IMAGE_CONTEXT_BYTES) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), imageContextTimeoutMs());

  try {
    const response = await fetch(`${imageContextBaseUrl()}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: imageContextModel(),
        temperature: 0,
        max_tokens: imageContextMaxOutputTokens(),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  'Describe this attached image for an autonomous task agent.',
                  'Include visible text, UI state, error messages, important layout details, objects, and any information needed to act on the user request.',
                  'Be concise and factual. If the image is a screenshot, read the visible text carefully.',
                  `File name: ${attachment.name}`,
                ].join(' '),
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${attachment.mimeType};base64,${image.toString('base64')}`,
                  detail: process.env.BEES_IMAGE_CONTEXT_DETAIL || 'auto',
                },
              },
            ],
          },
        ],
      }),
    });

    const body = await response.json().catch(() => ({})) as ChatCompletionResponse;
    if (!response.ok) {
      const message = body.error?.message || `Image context request failed with HTTP ${response.status}`;
      throw new Error(message);
    }

    return normalizeSummary(extractMessageContent(body));
  } finally {
    clearTimeout(timer);
  }
}

function extractMessageContent(body: ChatCompletionResponse): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function normalizeSummary(value: string): string | null {
  const summary = value.replace(/\s+\n/g, '\n').trim();
  if (!summary) return null;
  return summary.length > 2000 ? `${summary.slice(0, 1997)}...` : summary;
}

function imageContextApiKey(): string | null {
  return process.env.BEES_IMAGE_CONTEXT_API_KEY?.trim()
    || process.env.OPENAI_API_KEY?.trim()
    || null;
}

function imageContextBaseUrl(): string {
  const baseUrl = process.env.BEES_IMAGE_CONTEXT_BASE_URL?.trim()
    || process.env.OPENAI_BASE_URL?.trim()
    || DEFAULT_BASE_URL;
  return baseUrl.replace(/\/+$/, '');
}

function imageContextModel(): string {
  return process.env.BEES_IMAGE_CONTEXT_MODEL?.trim() || DEFAULT_MODEL;
}

function imageContextMaxOutputTokens(): number {
  const value = Number(process.env.BEES_IMAGE_CONTEXT_MAX_TOKENS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_OUTPUT_TOKENS;
}

function imageContextTimeoutMs(): number {
  const value = Number(process.env.BEES_IMAGE_CONTEXT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}
