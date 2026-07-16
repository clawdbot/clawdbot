import { spawn } from "node:child_process";
import process from "node:process";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";

const LOCAL_HOST_ID = "gateway";
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const MAX_SEARCH_LENGTH = 500;
const MAX_CURSOR_LENGTH = 128;
const MAX_CLI_LIST_SESSIONS = 10_000;
const MAX_CLI_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_ITEM_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_PAGE_BYTES = 20 * 1024 * 1024;
const CLI_TIMEOUT_MS = 30_000;
const SESSION_ID_PATTERN = /^(?!-)[A-Za-z0-9._:-]{1,256}$/u;
const SAFE_ENV_KEYS = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "OPENCODE_DB",
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

export type OpenCodeSessionPage = {
  sessions: SessionCatalogSession[];
  nextCursor?: string;
};

type OpenCodeListParams = {
  searchTerm?: string;
  limit?: number;
  cursor?: string;
};

type OpenCodeReadParams = {
  threadId: string;
  limit?: number;
  cursor?: string;
};

export function optionalOpenCodeString(value: unknown, maxLength: number): string | undefined {
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
  const cursor = optionalOpenCodeString(value, MAX_CURSOR_LENGTH);
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

function parseListParams(
  value: unknown,
): Required<Pick<OpenCodeListParams, "limit">> & OpenCodeListParams {
  if (value === undefined || value === null) {
    return { limit: DEFAULT_PAGE_LIMIT };
  }
  if (!isRecord(value)) {
    throw new Error("OpenCode session list parameters must be an object");
  }
  const unknown = Object.keys(value).find(
    (key) => !["searchTerm", "limit", "cursor"].includes(key),
  );
  if (unknown) {
    throw new Error(`unknown OpenCode session list parameter: ${unknown}`);
  }
  const searchTerm = optionalOpenCodeString(value.searchTerm, MAX_SEARCH_LENGTH);
  if (value.searchTerm !== undefined && !searchTerm) {
    throw new Error("searchTerm is invalid");
  }
  const cursor = optionalOpenCodeString(value.cursor, MAX_CURSOR_LENGTH);
  if (value.cursor !== undefined && !cursor) {
    throw new Error("cursor is invalid");
  }
  return {
    limit: boundedLimit(value.limit),
    ...(searchTerm ? { searchTerm } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function parseReadParams(
  value: unknown,
): Required<Pick<OpenCodeReadParams, "threadId" | "limit">> & OpenCodeReadParams {
  if (!isRecord(value)) {
    throw new Error("OpenCode session read parameters must be an object");
  }
  const unknown = Object.keys(value).find((key) => !["threadId", "limit", "cursor"].includes(key));
  if (unknown) {
    throw new Error(`unknown OpenCode session read parameter: ${unknown}`);
  }
  const threadId = optionalOpenCodeString(value.threadId, 256);
  if (!threadId || !SESSION_ID_PATTERN.test(threadId)) {
    throw new Error("threadId is invalid");
  }
  const cursor = optionalOpenCodeString(value.cursor, MAX_CURSOR_LENGTH);
  if (value.cursor !== undefined && !cursor) {
    throw new Error("cursor is invalid");
  }
  return {
    threadId,
    limit: boundedLimit(value.limit),
    ...(cursor ? { cursor } : {}),
  };
}

function resolveSpawnInvocation(args: string[]): {
  command: string;
  argv: string[];
  shell?: boolean;
  windowsHide?: boolean;
} {
  const program = resolveWindowsSpawnProgram({
    command: "opencode",
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    packageName: "opencode-ai",
  });
  return materializeWindowsSpawnProgram(program, args);
}

async function runOpenCode(args: string[]): Promise<string> {
  const invocation = resolveSpawnInvocation(args);
  const env: NodeJS.ProcessEnv = { OPENCODE_PURE: "1", NO_COLOR: "1" };
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  const child = spawn(invocation.command, invocation.argv, {
    env,
    shell: invocation.shell,
    windowsHide: invocation.windowsHide,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  const timeout = setTimeout(() => child.kill("SIGKILL"), CLI_TIMEOUT_MS);
  timeout.unref?.();
  let outputError: Error | undefined;
  const failFromOutputError = (source: "stdout" | "stderr", error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    outputError ??= new Error(`OpenCode ${source} stream failed: ${message}`, { cause: error });
    child.kill("SIGKILL");
  };
  const collect = (target: Buffer[], chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_CLI_OUTPUT_BYTES) {
      overflow = true;
      child.kill("SIGKILL");
      return;
    }
    target.push(chunk);
  };
  child.stdout.once("error", (error) => failFromOutputError("stdout", error));
  child.stderr.once("error", (error) => failFromOutputError("stderr", error));
  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => clearTimeout(timeout));
  if (overflow) {
    throw new Error("OpenCode session output exceeded the safety limit");
  }
  if (outputError) {
    throw outputError;
  }
  if (exitCode !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(detail || `OpenCode exited with code ${String(exitCode)}`);
  }
  return Buffer.concat(stdout).toString("utf8");
}

function parseOpenCodeSession(value: unknown): SessionCatalogSession | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const threadId = optionalOpenCodeString(value.id, 256);
  if (!threadId || !SESSION_ID_PATTERN.test(threadId)) {
    return undefined;
  }
  const name = optionalOpenCodeString(value.title, 1_000);
  const cwd = optionalOpenCodeString(value.directory, 4_096);
  const createdAt =
    typeof value.created === "number" && Number.isFinite(value.created) ? value.created : undefined;
  const updatedAt =
    typeof value.updated === "number" && Number.isFinite(value.updated) ? value.updated : undefined;
  return {
    threadId,
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
    status: "stored",
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt, recencyAt: updatedAt } : {}),
    source: "opencode-cli",
    modelProvider: "opencode",
    archived: false,
    canContinue: false,
    canArchive: false,
  };
}

export async function listLocalOpenCodeSessionPage(value?: unknown): Promise<OpenCodeSessionPage> {
  const params = parseListParams(value);
  const offset = decodeCursor(params.cursor);
  const requestedCount = params.searchTerm
    ? MAX_CLI_LIST_SESSIONS
    : Math.min(MAX_CLI_LIST_SESSIONS, offset + params.limit + 1);
  const query = [
    "SELECT id, title, time_created AS created, time_updated AS updated,",
    "project_id AS projectId, directory FROM session",
    "WHERE parent_id IS NULL AND time_archived IS NULL",
    `ORDER BY time_updated DESC, id DESC LIMIT ${String(requestedCount)}`,
  ].join(" ");
  const output = await runOpenCode(["--pure", "db", query, "--format", "json"]);
  const parsed = output.trim() ? (JSON.parse(output) as unknown) : [];
  if (!Array.isArray(parsed) || parsed.length > MAX_CLI_LIST_SESSIONS) {
    throw new Error("OpenCode returned an invalid session list");
  }
  const needle = params.searchTerm?.toLocaleLowerCase();
  const sessions = parsed
    .flatMap((entry) => {
      const session = parseOpenCodeSession(entry);
      return session ? [session] : [];
    })
    .filter((session) => {
      if (!needle) {
        return true;
      }
      return [session.threadId, session.name, session.cwd].some((field) =>
        field?.toLocaleLowerCase().includes(needle),
      );
    });
  const page = sessions.slice(offset, offset + params.limit);
  return {
    sessions: page,
    ...(offset + page.length < sessions.length
      ? { nextCursor: encodeCursor(offset + page.length) }
      : {}),
  };
}

function jsonText(value: unknown, maxLength = 20_000): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return undefined;
  }
}

function timestampFromInfo(info: Record<string, unknown>): string | undefined {
  if (!isRecord(info.time) || typeof info.time.created !== "number") {
    return undefined;
  }
  const date = new Date(info.time.created);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function openCodeTranscriptItems(value: unknown): SessionCatalogTranscriptItem[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("OpenCode returned an invalid session export");
  }
  return value.messages.flatMap((message): SessionCatalogTranscriptItem[] => {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) {
      return [];
    }
    const info = message.info;
    const role = info.role;
    const messageId = optionalOpenCodeString(info.id, 256);
    const timestamp = timestampFromInfo(info);
    const modelId =
      role === "assistant"
        ? optionalOpenCodeString(info.modelID, 256)
        : isRecord(info.model)
          ? optionalOpenCodeString(info.model.modelID, 256)
          : undefined;
    const providerId =
      role === "assistant"
        ? optionalOpenCodeString(info.providerID, 256)
        : isRecord(info.model)
          ? optionalOpenCodeString(info.model.providerID, 256)
          : undefined;
    const model = providerId && modelId ? `${providerId}/${modelId}` : modelId;
    return message.parts.flatMap((part, partIndex): SessionCatalogTranscriptItem[] => {
      if (!isRecord(part)) {
        return [];
      }
      const id =
        optionalOpenCodeString(part.id, 256) ??
        (messageId ? `${messageId}:${String(partIndex)}` : undefined);
      const common = {
        ...(id ? { id } : {}),
        ...(timestamp ? { timestamp } : {}),
        ...(model ? { model } : {}),
      };
      if (part.type === "text" && typeof part.text === "string") {
        return [
          { ...common, type: role === "user" ? "userMessage" : "agentMessage", text: part.text },
        ];
      }
      if (part.type === "reasoning" && typeof part.text === "string") {
        return [{ ...common, type: "reasoning", text: part.text }];
      }
      if (part.type === "tool") {
        const tool = optionalOpenCodeString(part.tool, 256) ?? "tool";
        const state = isRecord(part.state) ? part.state : undefined;
        const callText = state && "input" in state ? jsonText(state.input) : undefined;
        const resultText =
          state?.status === "completed" && typeof state.output === "string"
            ? state.output
            : state?.status === "error" && typeof state.error === "string"
              ? state.error
              : undefined;
        return [
          { ...common, type: "toolCall", text: callText ? `${tool}\n${callText}` : tool },
          ...(resultText
            ? [
                {
                  ...common,
                  ...(id ? { id: `${id}:result` } : {}),
                  type: "toolResult" as const,
                  text: resultText,
                },
              ]
            : []),
        ];
      }
      if (part.type === "file") {
        const filename = optionalOpenCodeString(part.filename, 1_000);
        const mime = optionalOpenCodeString(part.mime, 256);
        return [
          {
            ...common,
            type: "other",
            text: `[Attachment${filename ? `: ${filename}` : ""}${mime ? ` (${mime})` : ""}]`,
          },
        ];
      }
      return [];
    });
  });
}

export async function readLocalOpenCodeTranscriptPage(
  value: unknown,
): Promise<SessionsCatalogReadResult> {
  const params = parseReadParams(value);
  const offset = decodeCursor(params.cursor);
  const output = await runOpenCode(["--pure", "export", params.threadId]);
  const items = openCodeTranscriptItems(JSON.parse(output) as unknown);
  const page = transcriptPage(items, params.limit, offset);
  return {
    hostId: LOCAL_HOST_ID,
    label: "Local OpenCode",
    threadId: params.threadId,
    ...page,
  };
}
