import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  completeWithPreparedSimpleCompletionModel,
  extractAssistantText,
  prepareSimpleCompletionModelForAgent,
} from "openclaw/plugin-sdk/simple-completion-runtime";
import { withAbortTimeout } from "./timeouts.js";

const DEFAULT_THREAD_TITLE_TIMEOUT_MS = 10_000;
const MAX_THREAD_TITLE_SOURCE_CHARS = 600;
const MAX_THREAD_TITLE_CHANNEL_NAME_CHARS = 120;
const MAX_THREAD_TITLE_CHANNEL_DESCRIPTION_CHARS = 320;
// Budget generous enough to cover reasoning-model thinking tokens plus the
// short text output. Lower values (e.g. 24) starve reasoning models of output
// capacity: the entire budget is consumed by the thinking block before any
// text is emitted, so extractAssistantText returns empty and the rename is
// silently skipped.
const DISCORD_THREAD_TITLE_MAX_TOKENS = 512;
const DISCORD_THREAD_TITLE_SYSTEM_PROMPT =
  "Generate a concise Discord thread title (3-6 words). Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.";

export async function generateThreadTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  messageText: string;
  modelRef?: string;
  channelName?: string;
  channelDescription?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const sourceText = params.messageText.trim();
  if (!sourceText) {
    return null;
  }

  const prepared = await prepareSimpleCompletionModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    ...(params.modelRef ? { modelRef: params.modelRef } : {}),
    allowMissingApiKeyModes: ["aws-sdk"],
  });
  if ("error" in prepared) {
    const modelLabel = prepared.selection
      ? `${prepared.selection.provider}/${prepared.selection.modelId}`
      : "unknown";
    logVerbose(`thread-title: ${prepared.error} (agent=${params.agentId}, model=${modelLabel})`);
    return null;
  }

  try {
    const promptText = truncateThreadTitleSourceText(sourceText);
    const userMessage = buildThreadTitleUserMessage({
      sourceText: promptText,
      channelName: params.channelName,
      channelDescription: params.channelDescription,
    });
    const timeoutMs = resolveThreadTitleTimeoutMs(params.timeoutMs);
    const response = await completeThreadTitle({
      model: prepared.model,
      auth: prepared.auth,
      userMessage,
      timeoutMs,
    });
    const generated = normalizeGeneratedThreadTitle(extractAssistantText(response));
    return generated || null;
  } catch (err) {
    logVerbose(`thread-title: title generation failed for agent ${params.agentId}: ${String(err)}`);
    return null;
  }
}

async function completeThreadTitle(params: {
  model: Parameters<typeof completeWithPreparedSimpleCompletionModel>[0]["model"];
  auth: Parameters<typeof completeWithPreparedSimpleCompletionModel>[0]["auth"];
  userMessage: string;
  timeoutMs: number;
}) {
  return await withAbortTimeout({
    timeoutMs: params.timeoutMs,
    createTimeoutError: () => new Error(`thread-title timed out after ${params.timeoutMs}ms`),
    run: async (signal) =>
      await completeWithPreparedSimpleCompletionModel({
        model: params.model,
        auth: params.auth,
        context: {
          systemPrompt: DISCORD_THREAD_TITLE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: params.userMessage,
              timestamp: Date.now(),
            },
          ],
        },
        options: {
          maxTokens: DISCORD_THREAD_TITLE_MAX_TOKENS,
          signal,
        },
      }),
  });
}

function buildThreadTitleUserMessage(params: {
  sourceText: string;
  channelName?: string;
  channelDescription?: string;
}): string {
  const channelName = normalizeTitleContextField(
    params.channelName,
    MAX_THREAD_TITLE_CHANNEL_NAME_CHARS,
  );
  const channelDescription = normalizeTitleContextField(
    params.channelDescription,
    MAX_THREAD_TITLE_CHANNEL_DESCRIPTION_CHARS,
  );
  const messageLines: string[] = [];
  if (channelName) {
    messageLines.push(`Channel: ${channelName}`);
  }
  if (channelDescription) {
    messageLines.push(`Channel description: ${channelDescription}`);
  }
  messageLines.push(`Message:\n${params.sourceText}`);
  return messageLines.join("\n\n");
}

function truncateThreadTitleSourceText(sourceText: string): string {
  if (sourceText.length <= MAX_THREAD_TITLE_SOURCE_CHARS) {
    return sourceText;
  }
  return `${sourceText.slice(0, MAX_THREAD_TITLE_SOURCE_CHARS)}...`;
}

function resolveThreadTitleTimeoutMs(timeoutMs: number | undefined): number {
  return Math.max(100, Math.floor(timeoutMs ?? DEFAULT_THREAD_TITLE_TIMEOUT_MS));
}

export function normalizeGeneratedThreadTitle(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  let firstLine = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (!firstLine && trimmed.startsWith("```")) {
      continue;
    }
    firstLine = trimmed;
    break;
  }
  return stripThreadTitleWrappers(firstLine);
}

function stripThreadTitleWrappers(raw: string): string {
  let current = raw.trim();
  let previous = "";
  while (current && current !== previous) {
    previous = current;
    current = current.replace(/^["'`]+|["'`]+$/g, "").trim();
    current = current.replace(/^\*\*(.+)\*\*$/u, "$1").trim();
    current = current.replace(/^__(.+)__$/u, "$1").trim();
    current = current.replace(/^\*(.+)\*$/u, "$1").trim();
    current = current.replace(/^_(.+)_$/u, "$1").trim();
    current = current.replace(/^~~(.+)~~$/u, "$1").trim();
  }
  return current;
}

function normalizeTitleContextField(raw: string | undefined, maxChars: number): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  const singleLine = value.replace(/\s+/g, " ");
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars)}...`;
}
