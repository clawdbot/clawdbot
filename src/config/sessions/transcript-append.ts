import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  acquireSessionWriteLock,
  resolveSessionWriteLockAcquireTimeoutMs,
} from "../../agents/session-write-lock.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { redactSecrets } from "../../logging/redact.js";

const TRANSCRIPT_APPEND_SCAN_CHUNK_BYTES = 64 * 1024;
const SESSION_MANAGER_APPEND_MAX_BYTES = 8 * 1024 * 1024;

let piCodingAgentModulePromise: Promise<typeof import("@earendil-works/pi-coding-agent")> | null =
  null;
const transcriptAppendQueues = new Map<string, Promise<void>>();

async function loadCurrentSessionVersion(): Promise<number> {
  piCodingAgentModulePromise ??= import("@earendil-works/pi-coding-agent");
  return (await piCodingAgentModulePromise).CURRENT_SESSION_VERSION;
}

type TranscriptLeafInfo = {
  leafId?: string;
  hasParentLinkedEntries: boolean;
  nonSessionEntryCount: number;
};

async function yieldTranscriptAppendScan(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function lineParentLinkedEntryId(line: string): string | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as { type?: unknown; id?: unknown; parentId?: unknown };
    return parsed.type !== "session" && typeof parsed.id === "string" && "parentId" in parsed
      ? parsed.id
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEntryId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function generateEntryId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  const id = randomUUID();
  existingIds.add(id);
  return id;
}

async function readTranscriptLeafInfo(transcriptPath: string): Promise<TranscriptLeafInfo> {
  const handle = await fs.open(transcriptPath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_APPEND_SCAN_CHUNK_BYTES);
    let carry = "";
    let leafId: string | undefined;
    let hasParentLinkedEntries = false;
    let nonSessionEntryCount = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const text = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (lineHasNonSessionEntry(line)) {
          nonSessionEntryCount += 1;
        }
        const id = lineParentLinkedEntryId(line);
        if (id) {
          leafId = id;
          hasParentLinkedEntries = true;
        }
      }
      await yieldTranscriptAppendScan();
    }
    const tail = carry + decoder.end();
    if (lineHasNonSessionEntry(tail)) {
      nonSessionEntryCount += 1;
    }
    const id = lineParentLinkedEntryId(tail);
    if (id) {
      leafId = id;
      hasParentLinkedEntries = true;
    }
    return {
      ...(leafId ? { leafId } : {}),
      hasParentLinkedEntries,
      nonSessionEntryCount,
    };
  } finally {
    await handle.close();
  }
}

function lineHasNonSessionEntry(line: string): boolean {
  if (!line.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    return parsed.type !== "session";
  } catch {
    return false;
  }
}

async function migrateLinearTranscriptToParentLinked(transcriptPath: string): Promise<{
  leafId?: string;
}> {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  const currentSessionVersion = await loadCurrentSessionVersion();
  const existingIds = new Set<string>();
  const output: string[] = [];
  let previousId: string | null = null;
  let leafId: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      output.push(line);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      output.push(line);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "session") {
      output.push(JSON.stringify({ ...record, version: currentSessionVersion }));
      continue;
    }
    const id = normalizeEntryId(record.id) ?? generateEntryId(existingIds);
    existingIds.add(id);
    record.id = id;
    if (!Object.hasOwn(record, "parentId")) {
      record.parentId = previousId;
    }
    previousId = id;
    leafId = id;
    output.push(JSON.stringify(record));
  }
  await fs.writeFile(transcriptPath, `${output.join("\n")}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  const result: { leafId?: string } = {};
  if (leafId) {
    result.leafId = leafId;
  }
  return result;
}

async function ensureTranscriptHeader(
  transcriptPath: string,
  params: { sessionId?: string; cwd?: string } = {},
): Promise<void> {
  const stat = await fs.stat(transcriptPath).catch(() => null);
  if (stat?.isFile() && stat.size > 0) {
    return;
  }
  const currentSessionVersion = await loadCurrentSessionVersion();
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const header = {
    type: "session",
    version: currentSessionVersion,
    id: params.sessionId ?? randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.cwd ?? process.cwd(),
  };
  await fs.writeFile(transcriptPath, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
    flag: stat?.isFile() ? "w" : "wx",
  });
}

async function resolveTranscriptAppendQueueKey(transcriptPath: string): Promise<string> {
  const resolvedTranscriptPath = path.resolve(transcriptPath);
  const transcriptDir = path.dirname(resolvedTranscriptPath);
  await fs.mkdir(transcriptDir, { recursive: true });
  try {
    return path.join(await fs.realpath(transcriptDir), path.basename(resolvedTranscriptPath));
  } catch {
    return resolvedTranscriptPath;
  }
}

async function withTranscriptAppendQueue<T>(
  transcriptPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const queueKey = await resolveTranscriptAppendQueueKey(transcriptPath);
  const previous = transcriptAppendQueues.get(queueKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  transcriptAppendQueues.set(queueKey, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (transcriptAppendQueues.get(queueKey) === tail) {
      transcriptAppendQueues.delete(queueKey);
    }
  }
}

type AppendSessionTranscriptMessageParams<TMessage = unknown> = {
  transcriptPath: string;
  message: TMessage;
  now?: number;
  sessionId?: string;
  cwd?: string;
  useRawWhenLinear?: boolean;
  config?: OpenClawConfig;
};

function isTranscriptAgentMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { role?: unknown }).role === "string"
  );
}

export async function appendSessionTranscriptMessage<TMessage>(
  params: AppendSessionTranscriptMessageParams<TMessage>,
): Promise<{ messageId: string; message: TMessage }> {
  return await withTranscriptAppendQueue(params.transcriptPath, () =>
    appendSessionTranscriptMessageLocked(params),
  );
}

async function appendSessionTranscriptMessageLocked<TMessage>(
  params: AppendSessionTranscriptMessageParams<TMessage>,
): Promise<{ messageId: string; message: TMessage }> {
  const lock = await acquireSessionWriteLock({
    sessionFile: params.transcriptPath,
    timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(params.config),
    allowReentrant: true,
  });
  try {
    const now = params.now ?? Date.now();
    const messageId = randomUUID();
    await ensureTranscriptHeader(params.transcriptPath, {
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
    });
    const stat = await fs.stat(params.transcriptPath).catch(() => null);
    let leafInfo: TranscriptLeafInfo = await readTranscriptLeafInfo(params.transcriptPath).catch(
      () => ({
        hasParentLinkedEntries: false,
        nonSessionEntryCount: 0,
      }),
    );
    const hasLinearEntries = !leafInfo.hasParentLinkedEntries && leafInfo.nonSessionEntryCount > 0;
    const allowRawWhenLinear = params.useRawWhenLinear !== false;
    const shouldRawAppend =
      allowRawWhenLinear &&
      hasLinearEntries &&
      (stat?.size ?? 0) > SESSION_MANAGER_APPEND_MAX_BYTES;
    if (hasLinearEntries && !shouldRawAppend) {
      const migrated = await migrateLinearTranscriptToParentLinked(params.transcriptPath);
      leafInfo = {
        ...(migrated.leafId ? { leafId: migrated.leafId } : {}),
        hasParentLinkedEntries: Boolean(migrated.leafId),
        nonSessionEntryCount: leafInfo.nonSessionEntryCount,
      };
    }
    const finalMessage = (
      isTranscriptAgentMessage(params.message)
        ? redactTranscriptMessage(params.message, params.config)
        : redactSecrets(params.message)
    ) as TMessage;
    const entry = {
      type: "message",
      id: messageId,
      ...(shouldRawAppend ? {} : { parentId: leafInfo.leafId ?? null }),
      timestamp: new Date(now).toISOString(),
      message: finalMessage,
    };
    await fs.appendFile(params.transcriptPath, `${JSON.stringify(entry)}\n`, "utf-8");
    return { messageId, message: finalMessage };
  } finally {
    await lock.release();
  }
}
