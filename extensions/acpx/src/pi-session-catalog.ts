import process from "node:process";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { listPiSummaryPage, readPiSessionById } from "./pi-session-store.js";

const LOCAL_HOST_ID = "gateway";
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const MAX_SEARCH_LENGTH = 500;
const MAX_CURSOR_LENGTH = 128;
const MAX_TRANSCRIPT_ITEM_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_PAGE_BYTES = 20 * 1024 * 1024;
const SESSION_ID_PATTERN = /^(?!-)[A-Za-z0-9._:-]{1,256}$/u;

export type PiSessionPage = { sessions: SessionCatalogSession[]; nextCursor?: string };

export function optionalPiString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function boundedLimit(value: unknown, fallback = DEFAULT_PAGE_LIMIT): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${String(MAX_PAGE_LIMIT)}`);
  }
  return Number(value);
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  const cursor = optionalPiString(value, MAX_CURSOR_LENGTH);
  if (!cursor) {
    throw new Error("cursor is invalid");
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed) || !Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) {
      throw new Error("invalid offset");
    }
    return Number(parsed.offset);
  } catch (error) {
    throw new Error("cursor is invalid", { cause: error });
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes - 3) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const end = low > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(low - 1)) ? low - 1 : low;
  return `${text.slice(0, end)}…`;
}

function transcriptPage(
  items: SessionCatalogTranscriptItem[],
  limit: number,
  offset: number,
): { items: SessionCatalogTranscriptItem[]; nextCursor?: string } {
  const end = Math.max(0, items.length - offset);
  const start = Math.max(0, end - limit);
  const page: SessionCatalogTranscriptItem[] = [];
  let pageBytes = 2;
  for (let index = end - 1; index >= start; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    const bounded: SessionCatalogTranscriptItem = {
      ...item,
      text: truncateUtf8(item.text ?? "", MAX_TRANSCRIPT_ITEM_BYTES),
    };
    const itemBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8") + 1;
    if (page.length > 0 && pageBytes + itemBytes > MAX_TRANSCRIPT_PAGE_BYTES) {
      break;
    }
    page.unshift(bounded);
    pageBytes += itemBytes;
  }
  const consumed = offset + page.length;
  return {
    items: page,
    ...(consumed < items.length ? { nextCursor: encodeCursor(consumed) } : {}),
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (!isRecord(part)) {
        return [];
      }
      if (part.type === "text" && typeof part.text === "string") {
        return [part.text];
      }
      if (part.type === "image") {
        const mimeType = optionalPiString(part.mimeType, 128);
        return [mimeType ? `[image: ${mimeType}]` : "[image]"];
      }
      return [];
    })
    .join("\n");
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function parseListParams(value: unknown): { searchTerm?: string; limit: number; cursor?: string } {
  if (value === undefined || value === null) {
    return { limit: DEFAULT_PAGE_LIMIT };
  }
  if (!isRecord(value)) {
    throw new Error("Pi session list parameters must be an object");
  }
  const unknown = Object.keys(value).find(
    (key) => !["searchTerm", "limit", "cursor"].includes(key),
  );
  if (unknown) {
    throw new Error(`unknown Pi session list parameter: ${unknown}`);
  }
  const searchTerm = optionalPiString(value.searchTerm, MAX_SEARCH_LENGTH);
  if (value.searchTerm !== undefined && !searchTerm) {
    throw new Error("searchTerm is invalid");
  }
  const cursor = optionalPiString(value.cursor, MAX_CURSOR_LENGTH);
  if (value.cursor !== undefined && !cursor) {
    throw new Error("cursor is invalid");
  }
  return {
    limit: boundedLimit(value.limit),
    ...(searchTerm ? { searchTerm } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function parseReadParams(value: unknown): { threadId: string; limit: number; cursor?: string } {
  if (!isRecord(value)) {
    throw new Error("Pi session read parameters must be an object");
  }
  const unknown = Object.keys(value).find((key) => !["threadId", "limit", "cursor"].includes(key));
  if (unknown) {
    throw new Error(`unknown Pi session read parameter: ${unknown}`);
  }
  const threadId = optionalPiString(value.threadId, 256);
  if (!threadId || !SESSION_ID_PATTERN.test(threadId)) {
    throw new Error("threadId is invalid");
  }
  const cursor = optionalPiString(value.cursor, MAX_CURSOR_LENGTH);
  if (value.cursor !== undefined && !cursor) {
    throw new Error("cursor is invalid");
  }
  return {
    threadId,
    limit: boundedLimit(value.limit),
    ...(cursor ? { cursor } : {}),
  };
}

export async function listLocalPiSessionPage(value?: unknown): Promise<PiSessionPage> {
  const params = parseListParams(value);
  const offset = decodeCursor(params.cursor);
  const { summaries, hasMore } = await listPiSummaryPage(process.env, {
    offset,
    limit: params.limit,
    ...(params.searchTerm ? { searchTerm: params.searchTerm } : {}),
  });
  const page = summaries.map(({ file: _file, ...session }) => session);
  return {
    sessions: page,
    ...(hasMore ? { nextCursor: encodeCursor(offset + page.length) } : {}),
  };
}

function isoTimestamp(
  message: Record<string, unknown>,
  entry: Record<string, unknown>,
): string | undefined {
  const value = timestampMs(message.timestamp) ?? timestampMs(entry.timestamp);
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function jsonText(value: unknown, maxLength = 20_000): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text.length > maxLength ? `${truncateUtf16Safe(text, maxLength)}…` : text;
  } catch {
    return undefined;
  }
}

function activePiEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const header = entries[0];
  const version =
    header?.type === "session" && typeof header.version === "number" ? header.version : 1;
  if (version < 2) {
    return entries.slice(1);
  }
  const body = entries.filter(
    (entry) => entry.type !== "session" && optionalPiString(entry.id, 256),
  );
  const byId = new Map(body.map((entry) => [String(entry.id), entry]));
  const active: Record<string, unknown>[] = [];
  let current = body.at(-1);
  const visited = new Set<string>();
  while (current) {
    const id = String(current.id);
    if (visited.has(id)) {
      break;
    }
    visited.add(id);
    active.push(current);
    const parentId = optionalPiString(current.parentId, 256);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return active.toReversed();
}

function piMessageItems(entry: Record<string, unknown>): SessionCatalogTranscriptItem[] {
  if (!isRecord(entry.message)) {
    return [];
  }
  const message = entry.message;
  const role = message.role;
  const id = optionalPiString(entry.id, 256);
  const timestamp = isoTimestamp(message, entry);
  const model = optionalPiString(message.model, 256);
  const provider = optionalPiString(message.provider, 256);
  const modelRef = provider && model ? `${provider}/${model}` : model;
  const common = {
    ...(id ? { id } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(modelRef ? { model: modelRef } : {}),
  };
  if (role === "user") {
    const text = textFromContent(message.content);
    return text ? [{ ...common, type: "userMessage", text }] : [];
  }
  if (role === "toolResult") {
    const toolName = optionalPiString(message.toolName, 256);
    const text = textFromContent(message.content);
    return [{ ...common, type: "toolResult", text: toolName ? `${toolName}\n${text}` : text }];
  }
  if (role === "bashExecution") {
    const command = optionalPiString(message.command, 4_096) ?? "bash";
    const output = typeof message.output === "string" ? message.output : "";
    const status =
      message.cancelled === true
        ? "command cancelled"
        : typeof message.exitCode === "number" && message.exitCode !== 0
          ? `command exited with code ${String(message.exitCode)}`
          : "";
    return [
      { ...common, type: "toolCall", text: `bash\n${command}` },
      {
        ...common,
        ...(id ? { id: `${id}:result` } : {}),
        type: "toolResult",
        text: [output, status].filter(Boolean).join("\n\n"),
      },
    ];
  }
  if (role === "custom" || role === "hookMessage") {
    if (message.display !== true) {
      return [];
    }
    const customType = optionalPiString(message.customType, 256);
    const text = textFromContent(message.content);
    return text
      ? [{ ...common, type: "other", text: customType ? `${customType}\n${text}` : text }]
      : [];
  }
  if (role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((part, index): SessionCatalogTranscriptItem[] => {
    if (!isRecord(part)) {
      return [];
    }
    const partCommon = { ...common, ...(id ? { id: `${id}:${String(index)}` } : {}) };
    if (part.type === "text" && typeof part.text === "string") {
      return [{ ...partCommon, type: "agentMessage", text: part.text }];
    }
    if (part.type === "thinking" && typeof part.thinking === "string") {
      return [{ ...partCommon, type: "reasoning", text: part.thinking }];
    }
    if (part.type === "toolCall") {
      const name = optionalPiString(part.name, 256) ?? "tool";
      const args = jsonText(part.arguments);
      return [{ ...partCommon, type: "toolCall", text: args ? `${name}\n${args}` : name }];
    }
    return [];
  });
}

function piTranscriptItems(entries: Record<string, unknown>[]): SessionCatalogTranscriptItem[] {
  return activePiEntries(entries).flatMap((entry): SessionCatalogTranscriptItem[] => {
    if (entry.type === "message") {
      return piMessageItems(entry);
    }
    const id = optionalPiString(entry.id, 256);
    const timestamp = optionalPiString(entry.timestamp, 128);
    const common = { ...(id ? { id } : {}), ...(timestamp ? { timestamp } : {}) };
    if (entry.type === "compaction" && typeof entry.summary === "string") {
      return [{ ...common, type: "other", text: entry.summary }];
    }
    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      return [{ ...common, type: "other", text: entry.summary }];
    }
    if (entry.type === "custom_message" && entry.display === true) {
      const text = textFromContent(entry.content);
      return text ? [{ ...common, type: "other", text }] : [];
    }
    return [];
  });
}

export async function readLocalPiTranscriptPage(
  value: unknown,
): Promise<SessionsCatalogReadResult> {
  const params = parseReadParams(value);
  const offset = decodeCursor(params.cursor);
  const items = piTranscriptItems(await readPiSessionById(params.threadId, process.env));
  const page = transcriptPage(items, params.limit, offset);
  return {
    hostId: LOCAL_HOST_ID,
    label: "Local Pi",
    threadId: params.threadId,
    ...page,
  };
}
