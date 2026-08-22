import { Buffer } from "node:buffer";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage, Usage } from "openclaw/plugin-sdk/llm";
import type { SessionTranscriptMessageEntry } from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThread, JsonValue } from "./protocol.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const CODEX_HISTORY_IMPORT_MAX_MESSAGES = 200;
const CODEX_HISTORY_IMPORT_MAX_BYTES = 512 * 1024;
const CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES = 64 * 1024;
const CODEX_HISTORY_TRUNCATION_SUFFIX = "\n\n[Message truncated during Codex history import.]";
const CODEX_HISTORY_ASSISTANT_API = "openai-chatgpt-responses" as const;
const CODEX_HISTORY_ASSISTANT_PROVIDER = "openai";
const CODEX_HISTORY_ASSISTANT_MODEL = "native-history";
const CODEX_HISTORY_ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type CodexThreadHistoryImportResult = {
  importedMessages: number;
  omittedMessages: number;
};

type BoundedCodexThreadHistoryProjection = CodexThreadHistoryImportResult & {
  responseItems: JsonValue[];
  transcriptMessages: AgentMessage[];
};

type ProjectedCodexHistoryMessage = {
  message: AgentMessage;
  responseItem: JsonValue;
  textBytes: number;
};

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function truncateUtf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let end = Math.max(0, maxBytes);
  while (end > 0 && isUtf8ContinuationByte(bytes[end])) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function normalizeImportedHistoryText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (Buffer.byteLength(text, "utf8") <= CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES) {
    return text;
  }
  const suffixBytes = Buffer.byteLength(CODEX_HISTORY_TRUNCATION_SUFFIX, "utf8");
  const contentLimitBytes = Math.max(0, CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES - suffixBytes);
  return `${truncateUtf8Prefix(text, contentLimitBytes)}${CODEX_HISTORY_TRUNCATION_SUFFIX}`;
}

function projectCodexUserItemText(item: Record<string, unknown>): string | undefined {
  if (!Array.isArray(item.content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const value of item.content) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const input = value as Record<string, unknown>;
    if (input.type === "text") {
      const text = normalizeImportedHistoryText(input.text);
      if (text) {
        parts.push(text);
      }
      continue;
    }
    if (input.type === "image" || input.type === "localImage") {
      parts.push("[Image attachment]");
      continue;
    }
    if (input.type === "audio" || input.type === "localAudio" || input.type === "local_audio") {
      parts.push("[Audio attachment]");
    }
    if (input.type === "skill" || input.type === "mention") {
      const name = normalizeOptionalString(input.name);
      if (name) {
        parts.push(`${input.type === "skill" ? "$" : "@"}${name}`);
      }
    }
  }
  return normalizeImportedHistoryText(parts.join("\n"));
}

function selectTurnsThroughBoundary(
  thread: CodexThread,
  throughTurnId: string | null,
): NonNullable<CodexThread["turns"]> {
  if (throughTurnId === null) {
    return [];
  }
  const turns = thread.turns ?? [];
  const boundaryIndex = turns.findIndex((turn) => turn.id === throughTurnId);
  if (boundaryIndex < 0) {
    throw new Error(`Codex history boundary turn not found: ${throughTurnId}`);
  }
  const boundary = turns[boundaryIndex];
  if (
    boundary?.status !== "completed" &&
    boundary?.status !== "interrupted" &&
    boundary?.status !== "failed"
  ) {
    throw new Error(`Codex history boundary turn is not terminal: ${throughTurnId}`);
  }
  return turns.slice(0, boundaryIndex + 1);
}

function projectCodexThreadHistory(params: {
  thread: CodexThread;
  throughTurnId: string | null;
  importedAt: number;
  modelProvider?: string;
}): ProjectedCodexHistoryMessage[] {
  const projected: ProjectedCodexHistoryMessage[] = [];
  const threadTimestamp =
    typeof params.thread.createdAt === "number" && Number.isFinite(params.thread.createdAt)
      ? params.thread.createdAt * 1000
      : params.importedAt;
  let itemOffset = 0;
  for (const turn of selectTurnsThroughBoundary(params.thread, params.throughTurnId)) {
    for (const value of turn.items) {
      const item = value;
      const itemId = normalizeOptionalString(item.id);
      const identity = `${turn.id}:${itemId ?? itemOffset}`;
      const timestampSeconds =
        item.type === "agentMessage"
          ? (turn.completedAt ?? turn.startedAt)
          : (turn.startedAt ?? turn.completedAt);
      const timestamp =
        typeof timestampSeconds === "number" && Number.isFinite(timestampSeconds)
          ? timestampSeconds * 1000 + itemOffset
          : threadTimestamp + itemOffset;
      const text =
        item.type === "userMessage"
          ? projectCodexUserItemText(item)
          : item.type === "agentMessage"
            ? normalizeImportedHistoryText(item.text)
            : undefined;
      const role =
        item.type === "userMessage"
          ? ("user" as const)
          : item.type === "agentMessage"
            ? ("assistant" as const)
            : undefined;
      itemOffset += 1;
      if (!text || !role) {
        continue;
      }
      const phase =
        item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
      const asyncDelivery = item.delivery === "async";
      const message =
        role === "assistant"
          ? attachCodexMirrorIdentity(
              {
                role,
                content: [{ type: "text", text }],
                api: CODEX_HISTORY_ASSISTANT_API,
                provider:
                  normalizeOptionalString(params.modelProvider) ??
                  normalizeOptionalString(params.thread.modelProvider) ??
                  CODEX_HISTORY_ASSISTANT_PROVIDER,
                model: CODEX_HISTORY_ASSISTANT_MODEL,
                usage: CODEX_HISTORY_ZERO_USAGE,
                stopReason:
                  turn.status === "interrupted"
                    ? "aborted"
                    : turn.status === "failed"
                      ? "error"
                      : "stop",
                ...(turn.status === "failed" && turn.error?.message
                  ? { errorMessage: turn.error.message }
                  : {}),
                ...(phase ? { phase } : {}),
                ...(asyncDelivery && itemId ? { openclawAsyncDelivery: { itemId } } : {}),
                timestamp,
              } satisfies AssistantMessage,
              identity,
            )
          : attachCodexMirrorIdentity({ role, content: text, timestamp } as AgentMessage, identity);
      projected.push({
        message,
        responseItem: {
          type: "message",
          role,
          content: [
            {
              type: role === "assistant" ? "output_text" : "input_text",
              text,
            },
          ],
          ...(role === "assistant" && phase ? { phase } : {}),
        },
        textBytes: Buffer.byteLength(text, "utf8"),
      });
    }
  }
  return projected;
}

function selectBoundedCodexHistoryTail(
  projected: ProjectedCodexHistoryMessage[],
): ProjectedCodexHistoryMessage[] {
  const selected: ProjectedCodexHistoryMessage[] = [];
  let selectedBytes = 0;
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const candidate = projected[index];
    if (!candidate) {
      continue;
    }
    if (
      selected.length >= CODEX_HISTORY_IMPORT_MAX_MESSAGES ||
      selectedBytes + candidate.textBytes > CODEX_HISTORY_IMPORT_MAX_BYTES
    ) {
      break;
    }
    selected.push(candidate);
    selectedBytes += candidate.textBytes;
  }
  return selected.toReversed();
}

/** Projects one terminal Codex history prefix into transcript and Responses API items. */
export function projectBoundedCodexThreadHistory(params: {
  thread: CodexThread;
  throughTurnId: string | null;
  importedAt: number;
  modelProvider?: string | null;
}): BoundedCodexThreadHistoryProjection {
  const projected = projectCodexThreadHistory({
    thread: params.thread,
    throughTurnId: params.throughTurnId,
    importedAt: params.importedAt,
    ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
  });
  const selected = selectBoundedCodexHistoryTail(projected);
  return {
    importedMessages: selected.length,
    omittedMessages: projected.length - selected.length,
    // Failed assistant fragments remain visible in operator transcripts, but
    // injecting them would permanently replay incomplete model output.
    responseItems: selected
      .filter(
        ({ message }) =>
          message.role !== "assistant" ||
          (message.stopReason !== "aborted" &&
            message.stopReason !== "error" &&
            !("openclawAsyncDelivery" in message)),
      )
      .map(({ responseItem }) => responseItem),
    transcriptMessages: selected.map(({ message }) => message),
  };
}

/** Projects only visible local user/assistant messages through the same bounded history policy. */
export function projectBoundedCodexVisibleSessionHistory(
  entries: readonly SessionTranscriptMessageEntry[],
): JsonValue[] {
  const projected: ProjectedCodexHistoryMessage[] = [];
  for (const entry of entries) {
    if ((entry.role !== "user" && entry.role !== "assistant") || !("content" in entry.message)) {
      continue;
    }
    if (
      entry.role === "assistant" &&
      (("stopReason" in entry.message &&
        (entry.message.stopReason === "aborted" || entry.message.stopReason === "error")) ||
        "openclawAsyncDelivery" in entry.message)
    ) {
      continue;
    }
    const content = entry.message.content;
    const text = normalizeImportedHistoryText(
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((part) =>
                part && typeof part === "object" && "text" in part && typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
              .join("\n")
          : undefined,
    );
    if (!text) {
      continue;
    }
    projected.push({
      message: entry.message,
      responseItem: {
        type: "message",
        role: entry.role,
        content: [
          {
            type: entry.role === "assistant" ? "output_text" : "input_text",
            text,
          },
        ],
      },
      textBytes: Buffer.byteLength(text, "utf8"),
    });
  }
  return selectBoundedCodexHistoryTail(projected).map(({ responseItem }) => responseItem);
}
