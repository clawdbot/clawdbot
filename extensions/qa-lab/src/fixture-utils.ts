// Qa Lab plugin module provides reusable fixture utilities.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";

export type QaFixtureFetchJsonOptions = {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  maxBodyBytes?: number;
  timeoutMs?: number;
};

const DEFAULT_FETCH_BODY_MAX_BYTES = 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export function readPositiveIntEnv(name: string, fallback: number, env: NodeJS.ProcessEnv) {
  const raw = env[name] ?? fallback;
  const text = raw == null ? "unset" : String(raw).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

function timeoutError(message: string) {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

function bodyTooLargeErrorMessage(url: string, byteLimit: number) {
  return `HTTP response from ${url} exceeded ${byteLimit} bytes`;
}

function cancelReaderSoon(reader: ReadableStreamDefaultReader<Uint8Array>) {
  void Promise.resolve()
    .then(() => reader.cancel())
    .catch(() => undefined);
}

async function readBoundedResponseText(params: {
  response: Response;
  url: string;
  maxBytes: number;
  timeoutPromise: Promise<never>;
  signal: AbortSignal;
}) {
  const tooLargeError = () =>
    Object.assign(new Error(bodyTooLargeErrorMessage(params.url, params.maxBytes)), {
      code: "ETOOBIG",
    });
  const contentLength = params.response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > params.maxBytes) {
    await params.response.body?.cancel().catch(() => undefined);
    throw tooLargeError();
  }
  if (!params.response.body) {
    return "";
  }

  const reader = params.response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let canceled = false;
  try {
    for (;;) {
      const readPromise = reader.read();
      let removeAbortListener: (() => void) | undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          canceled = true;
          cancelReaderSoon(reader);
          reject(
            params.signal.reason instanceof Error
              ? params.signal.reason
              : new Error(`HTTP request to ${params.url} aborted`),
          );
        };
        params.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => params.signal.removeEventListener("abort", onAbort);
      });
      const { done, value } = await Promise.race([
        readPromise,
        abortPromise,
        params.timeoutPromise,
      ]).finally(() => removeAbortListener?.());
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > params.maxBytes) {
        canceled = true;
        await reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (!canceled) {
      reader.releaseLock();
    }
  }
  return chunks.join("");
}

export async function fetchQaFixtureJson(
  url: string,
  init: RequestInit = {},
  options: QaFixtureFetchJsonOptions = {},
): Promise<unknown> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_FETCH_BODY_MAX_BYTES);
  const controller = new AbortController();
  const error = timeoutError(`HTTP request to ${url} timed out after ${timeoutMs}ms`);
  let timeout: ReturnType<typeof setNodeTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setNodeTimeout(() => {
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  let response: Response;
  let text: string;
  try {
    response = await Promise.race([
      (options.fetchImpl ?? fetch)(url, {
        ...init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    text = await readBoundedResponseText({
      response,
      url,
      maxBytes: maxBodyBytes,
      timeoutPromise,
      signal: controller.signal,
    });
  } finally {
    if (timeout) {
      clearNodeTimeout(timeout);
    }
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  }
  return parsed;
}

export function outputToolNames(response: unknown): string[] {
  const output = (response as { output?: Array<{ type?: unknown; name?: unknown }> }).output;
  if (!Array.isArray(output)) {
    return [];
  }
  return output
    .filter((item) => item.type === "function_call" && typeof item.name === "string")
    .map((item) => item.name as string);
}

export function outputText(response: unknown): string {
  const output = (response as { output?: Array<{ type?: unknown; content?: unknown }> }).output;
  if (!Array.isArray(output)) {
    return "";
  }
  return output
    .flatMap((item) => {
      if (item.type !== "message" || !Array.isArray(item.content)) {
        return [];
      }
      return item.content.flatMap((piece) => {
        if (!piece || typeof piece !== "object") {
          return [];
        }
        const record = piece as { text?: unknown };
        return typeof record.text === "string" ? [record.text] : [];
      });
    })
    .join("\n");
}

function readContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as { type?: unknown; text?: unknown };
      return typeof record.text === "string" ? record.text : "";
    })
    .join("\n");
}

export function countSystemPromptChars(body: unknown): number {
  if (!body || typeof body !== "object") {
    return 0;
  }
  const record = body as { instructions?: unknown; input?: unknown };
  let total = typeof record.instructions === "string" ? record.instructions.length : 0;
  if (Array.isArray(record.input)) {
    for (const item of record.input) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const inputRecord = item as { role?: unknown; content?: unknown };
      if (inputRecord.role === "system" || inputRecord.role === "developer") {
        total += readContentText(inputRecord.content).length;
      }
    }
  }
  return total;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = haystack.indexOf(needle, offset);
    if (next < 0) {
      return count;
    }
    count += 1;
    offset = next + needle.length;
  }
}

function createCounts(needles: Record<string, string>): Record<string, number> {
  return Object.fromEntries(Object.keys(needles).map((key) => [key, 0]));
}

function recordRole(record: unknown): string | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const candidate = record as { message?: unknown; role?: unknown };
  if (typeof candidate.role === "string") {
    return candidate.role;
  }
  if (!candidate.message || typeof candidate.message !== "object") {
    return undefined;
  }
  const message = candidate.message as { role?: unknown };
  return typeof message.role === "string" ? message.role : undefined;
}

function collectStringLeaves(value: unknown, output: string[]) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLeaves(item, output);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const item of Object.values(value)) {
    collectStringLeaves(item, output);
  }
}

function sessionLogScanText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const record = JSON.parse(trimmed) as unknown;
    if (recordRole(record) === "user") {
      return null;
    }
    const strings: string[] = [];
    collectStringLeaves(record, strings);
    return strings.join("\n");
  } catch {
    return line;
  }
}

async function countNeedlesInFile(filePath: string, needles: Record<string, string>) {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  const counts = createCounts(needles);
  for (const line of text.split(/\r?\n/u)) {
    const scanText = sessionLogScanText(line);
    if (scanText === null) {
      continue;
    }
    for (const [key, needle] of Object.entries(needles)) {
      counts[key] += countOccurrences(scanText, needle);
    }
  }
  return counts;
}

function resolveAgentSqlitePathFromSessionsDir(sessionsDir: string): string | null {
  if (path.basename(sessionsDir) !== "sessions") {
    return null;
  }
  return path.join(path.dirname(sessionsDir), "agent", "openclaw-agent.sqlite");
}

function countNeedlesInSqliteTranscriptEvents(
  sqlitePath: string,
  needles: Record<string, string>,
): Record<string, number> {
  const counts = createCounts(needles);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(sqlitePath, { readOnly: true });
    const hasTranscriptEvents = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_events'")
      .get();
    if (!hasTranscriptEvents) {
      return counts;
    }
    const rows = db.prepare("SELECT event_json FROM transcript_events ORDER BY session_id, seq");
    for (const row of rows.iterate() as Iterable<{ event_json?: unknown }>) {
      if (typeof row.event_json !== "string") {
        continue;
      }
      const scanText = sessionLogScanText(row.event_json);
      if (scanText === null) {
        continue;
      }
      for (const [key, needle] of Object.entries(needles)) {
        counts[key] += countOccurrences(scanText, needle);
      }
    }
    return counts;
  } catch {
    return counts;
  } finally {
    db?.close();
  }
}

async function countNeedlesInSqliteTranscriptStore(
  sessionsDir: string,
  needles: Record<string, string>,
): Promise<Record<string, number>> {
  const sqlitePath = resolveAgentSqlitePathFromSessionsDir(sessionsDir);
  if (!sqlitePath) {
    return createCounts(needles);
  }
  try {
    const stat = await fs.stat(sqlitePath);
    if (!stat.isFile()) {
      return createCounts(needles);
    }
  } catch {
    return createCounts(needles);
  }
  return countNeedlesInSqliteTranscriptEvents(sqlitePath, needles);
}

export async function countSessionLogMentions(params: {
  sessionsDir: string;
  needles: Record<string, string>;
}): Promise<Record<string, number>> {
  const counts = createCounts(params.needles);
  const files = await fs.readdir(params.sessionsDir, { recursive: true }).catch(() => []);
  for (const file of files) {
    if (typeof file !== "string" || !file.endsWith(".jsonl")) {
      continue;
    }
    const fileCounts = await countNeedlesInFile(
      path.join(params.sessionsDir, file),
      params.needles,
    );
    for (const [key, count] of Object.entries(fileCounts)) {
      counts[key] = (counts[key] ?? 0) + count;
    }
  }
  const sqliteCounts = await countNeedlesInSqliteTranscriptStore(
    params.sessionsDir,
    params.needles,
  );
  for (const [key, count] of Object.entries(sqliteCounts)) {
    counts[key] = (counts[key] ?? 0) + count;
  }
  return counts;
}

export function subtractMentionCounts(
  after: Record<string, number>,
  before: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(after).map(([key, count]) => [key, count - (before[key] ?? 0)]),
  );
}
