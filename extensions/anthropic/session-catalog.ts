import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export const CLAUDE_SESSIONS_LIST_COMMAND = "anthropic.claude.sessions.list.v1";
export const CLAUDE_SESSION_READ_COMMAND = "anthropic.claude.sessions.read.v1";
export const CLAUDE_SESSION_CATALOG_METHOD = "anthropic.sessions.list";
export const CLAUDE_SESSION_READ_METHOD = "anthropic.sessions.read";

const CLAUDE_SESSIONS_CAPABILITY = "claude-sessions";
const CLAUDE_LOCAL_SESSION_HOST_ID = "gateway:local";
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_TRANSCRIPT_LIMIT = 20;
const MAX_TRANSCRIPT_LIMIT = 50;
const MAX_HOSTS = 100;
const MAX_STRING_LENGTH = 4096;
const MAX_SEARCH_LENGTH = 500;
const MAX_CURSOR_LENGTH = 256;
const MAX_CATALOG_DISCOVERY_FILES = 10_000;
const CLAUDE_METADATA_PREFIX_BYTES = 1024 * 1024;
const CLAUDE_METADATA_READ_CHUNK_BYTES = 16 * 1024;
const MAX_CATALOG_METADATA_SCAN_BYTES = 64 * 1024 * 1024;
const TRANSCRIPT_READ_CHUNK_BYTES = 128 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_PAGE_BYTES = 20 * 1024 * 1024;
const MAX_TRANSCRIPT_TEXT_LENGTH = 1_000_000;
const NODE_INVOKE_TIMEOUT_MS = 30_000;

type ClaudeSessionSource = "claude-cli" | "claude-desktop";

export type ClaudeSessionCatalogSession = {
  threadId: string;
  name?: string | null;
  cwd?: string;
  status: "stored";
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  source: ClaudeSessionSource;
  modelProvider: "anthropic";
  cliVersion?: string;
  gitBranch?: string;
  archived: false;
};

export type ClaudeSessionCatalogPage = {
  sessions: ClaudeSessionCatalogSession[];
  nextCursor?: string;
};

export type ClaudeSessionCatalogHost = ClaudeSessionCatalogPage & {
  hostId: string;
  label: string;
  kind: "gateway" | "node";
  connected: boolean;
  nodeId?: string;
  error?: { code: string; message: string };
};

export type ClaudeSessionCatalogResult = {
  hosts: ClaudeSessionCatalogHost[];
};

export type ClaudeTranscriptItem = {
  type: string;
  text?: string;
  content?: unknown;
  timestamp?: string;
  model?: string;
  uuid?: string;
  truncated?: true;
};

export type ClaudeSessionTranscriptPage = {
  hostId: string;
  label: string;
  threadId: string;
  items: ClaudeTranscriptItem[];
  nextCursor?: string;
};

type SessionIndexEntry = {
  sessionId?: unknown;
  fullPath?: unknown;
  fileMtime?: unknown;
  firstPrompt?: unknown;
  summary?: unknown;
  messageCount?: unknown;
  created?: unknown;
  modified?: unknown;
  gitBranch?: unknown;
  projectPath?: unknown;
  isSidechain?: unknown;
};

type DesktopSessionMetadata = {
  sessionId?: unknown;
  cliSessionId?: unknown;
  cwd?: unknown;
  originCwd?: unknown;
  createdAt?: unknown;
  lastActivityAt?: unknown;
  model?: unknown;
  isArchived?: unknown;
  title?: unknown;
};

type CatalogRecord = ClaudeSessionCatalogSession & {
  filePath: string;
};

class ClaudeCatalogParamsError extends Error {}

function optionalString(value: unknown, maxLength = MAX_STRING_LENGTH): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function safeSessionFile(
  root: string,
  resolvedRoot: string,
  candidate: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!isWithin(root, candidate) || path.basename(candidate) !== `${sessionId}.jsonl`) {
    return undefined;
  }
  try {
    const resolvedCandidate = await fs.realpath(candidate);
    if (!isWithin(resolvedRoot, resolvedCandidate)) {
      return undefined;
    }
    const stat = await fs.stat(resolvedCandidate);
    return stat.isFile() ? resolvedCandidate : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function childDirectories(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function projectsDir(homeDir: string): string {
  return path.join(homeDir, ".claude", "projects");
}

function desktopSessionsDir(homeDir: string): string {
  return path.join(homeDir, "Library", "Application Support", "Claude", "claude-code-sessions");
}

function claudeProjectsAvailable(env: NodeJS.ProcessEnv): boolean {
  const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  try {
    return statSync(projectsDir(homeDir)).isDirectory();
  } catch {
    return false;
  }
}

async function readDesktopMetadata(homeDir: string): Promise<{
  active: Map<string, DesktopSessionMetadata>;
  archived: Set<string>;
}> {
  const active = new Map<string, DesktopSessionMetadata>();
  const archived = new Set<string>();
  for (const accountDir of await childDirectories(desktopSessionsDir(homeDir))) {
    for (const workspaceDir of await childDirectories(accountDir)) {
      let entries: string[];
      try {
        entries = await fs.readdir(workspaceDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.startsWith("local_") || !name.endsWith(".json")) {
          continue;
        }
        const raw = await readJsonFile(path.join(workspaceDir, name));
        if (!isRecord(raw)) {
          continue;
        }
        const metadata = raw as DesktopSessionMetadata;
        const cliSessionId = optionalString(metadata.cliSessionId, 256);
        if (!cliSessionId) {
          continue;
        }
        if (metadata.isArchived === true) {
          archived.add(cliSessionId);
          active.delete(cliSessionId);
          continue;
        }
        if (!archived.has(cliSessionId)) {
          active.set(cliSessionId, metadata);
        }
      }
    }
  }
  return { active, archived };
}

async function readIndexRecords(homeDir: string): Promise<{
  records: Map<string, CatalogRecord>;
  sidechainIds: Set<string>;
}> {
  const root = projectsDir(homeDir);
  const records = new Map<string, CatalogRecord>();
  const sidechainIds = new Set<string>();
  const resolvedRoot = await fs.realpath(root).catch(() => undefined);
  if (!resolvedRoot) {
    return { records, sidechainIds };
  }
  for (const projectDir of await childDirectories(root)) {
    const raw = await readJsonFile(path.join(projectDir, "sessions-index.json"));
    if (!isRecord(raw) || !Array.isArray(raw.entries)) {
      continue;
    }
    for (const candidate of raw.entries) {
      if (!isRecord(candidate)) {
        continue;
      }
      const entry = candidate as SessionIndexEntry;
      const sessionId = optionalString(entry.sessionId, 256);
      if (!sessionId) {
        continue;
      }
      if (entry.isSidechain === true) {
        sidechainIds.add(sessionId);
        records.delete(sessionId);
        continue;
      }
      const indexedPath = optionalString(entry.fullPath, MAX_STRING_LENGTH);
      const filePath = await safeSessionFile(
        root,
        resolvedRoot,
        indexedPath ?? path.join(projectDir, `${sessionId}.jsonl`),
        sessionId,
      );
      if (!filePath) {
        continue;
      }
      const createdAt = timestampMs(entry.created);
      const updatedAt = timestampMs(entry.modified) ?? timestampMs(entry.fileMtime);
      const summary = optionalString(entry.summary, 500);
      const firstPrompt = optionalString(entry.firstPrompt, 500);
      records.set(sessionId, {
        threadId: sessionId,
        name: summary ?? firstPrompt ?? null,
        cwd: optionalString(entry.projectPath),
        status: "stored",
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt, recencyAt: updatedAt } : {}),
        source: "claude-cli",
        modelProvider: "anthropic",
        ...(optionalString(entry.gitBranch, 500)
          ? { gitBranch: optionalString(entry.gitBranch, 500) }
          : {}),
        archived: false,
        filePath,
      });
    }
  }
  return { records, sidechainIds };
}

async function locateSessionFile(homeDir: string, sessionId: string): Promise<string | undefined> {
  const root = projectsDir(homeDir);
  const resolvedRoot = await fs.realpath(root).catch(() => undefined);
  if (!resolvedRoot) {
    return undefined;
  }
  for (const projectDir of await childDirectories(root)) {
    const candidate = path.join(projectDir, `${sessionId}.jsonl`);
    const filePath = await safeSessionFile(root, resolvedRoot, candidate, sessionId);
    if (filePath) {
      return filePath;
    }
  }
  return undefined;
}

async function discoverCliRecords(
  homeDir: string,
  records: Map<string, CatalogRecord>,
  sidechainIds: Set<string>,
): Promise<void> {
  const root = projectsDir(homeDir);
  const resolvedRoot = await fs.realpath(root).catch(() => undefined);
  if (!resolvedRoot) {
    return;
  }
  let discoveredFiles = 0;
  let scannedBytes = 0;
  for (const projectDir of await childDirectories(root)) {
    let names: string[];
    try {
      names = await fs.readdir(projectDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl") || discoveredFiles >= MAX_CATALOG_DISCOVERY_FILES) {
        continue;
      }
      discoveredFiles += 1;
      const sessionId = name.slice(0, -".jsonl".length);
      if (!sessionId || records.has(sessionId) || sidechainIds.has(sessionId)) {
        continue;
      }
      const filePath = await safeSessionFile(
        root,
        resolvedRoot,
        path.join(projectDir, name),
        sessionId,
      );
      if (!filePath) {
        continue;
      }
      const handle = await fs.open(filePath, "r").catch(() => undefined);
      if (!handle) {
        continue;
      }
      try {
        const stat = await handle.stat();
        let aiTitle: string | undefined;
        let pending = Buffer.alloc(0);
        let fileOffset = 0;
        let stopFile = false;
        const inspectLine = (line: Buffer): boolean => {
          let raw: unknown;
          try {
            raw = JSON.parse(line.toString("utf8")) as unknown;
          } catch {
            return false;
          }
          if (!isRecord(raw) || raw.sessionId !== sessionId) {
            return false;
          }
          if (raw.type === "ai-title") {
            aiTitle = optionalString(raw.aiTitle, 500) ?? aiTitle;
            return false;
          }
          if (typeof raw.entrypoint === "string" && raw.entrypoint !== "sdk-cli") {
            return true;
          }
          if (raw.entrypoint === "sdk-cli" && raw.isSidechain === true) {
            sidechainIds.add(sessionId);
            return true;
          }
          if (
            raw.entrypoint !== "sdk-cli" ||
            raw.type !== "user" ||
            !isRecord(raw.message) ||
            raw.message.role !== "user"
          ) {
            return false;
          }
          const fragments: string[] = [];
          collectTranscriptText(raw.message.content, fragments);
          const firstPrompt = optionalString(fragments[0], 500);
          const createdAt = timestampMs(raw.timestamp);
          records.set(sessionId, {
            threadId: sessionId,
            name: aiTitle ?? firstPrompt ?? null,
            cwd: optionalString(raw.cwd),
            status: "stored",
            ...(createdAt !== undefined ? { createdAt } : {}),
            updatedAt: stat.mtimeMs,
            recencyAt: stat.mtimeMs,
            source: "claude-cli",
            modelProvider: "anthropic",
            ...(optionalString(raw.version, 256)
              ? { cliVersion: optionalString(raw.version, 256) }
              : {}),
            ...(optionalString(raw.gitBranch, 500)
              ? { gitBranch: optionalString(raw.gitBranch, 500) }
              : {}),
            archived: false,
            filePath,
          });
          return true;
        };
        while (
          !stopFile &&
          fileOffset < stat.size &&
          fileOffset < CLAUDE_METADATA_PREFIX_BYTES &&
          scannedBytes < MAX_CATALOG_METADATA_SCAN_BYTES
        ) {
          const size = Math.min(
            CLAUDE_METADATA_READ_CHUNK_BYTES,
            stat.size - fileOffset,
            CLAUDE_METADATA_PREFIX_BYTES - fileOffset,
            MAX_CATALOG_METADATA_SCAN_BYTES - scannedBytes,
          );
          const chunk = Buffer.allocUnsafe(size);
          const { bytesRead } = await handle.read(chunk, 0, size, fileOffset);
          if (bytesRead === 0) {
            break;
          }
          fileOffset += bytesRead;
          scannedBytes += bytesRead;
          pending = pending.length
            ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
            : chunk.subarray(0, bytesRead);
          let newline: number;
          while (!stopFile && (newline = pending.indexOf(0x0a)) >= 0) {
            stopFile = inspectLine(pending.subarray(0, newline));
            pending = pending.subarray(newline + 1);
          }
        }
        if (!stopFile && fileOffset >= stat.size && pending.length > 0) {
          inspectLine(pending);
        }
      } finally {
        await handle.close();
      }
      if (scannedBytes >= MAX_CATALOG_METADATA_SCAN_BYTES) {
        return;
      }
    }
    if (discoveredFiles >= MAX_CATALOG_DISCOVERY_FILES) {
      break;
    }
  }
}

async function listClaudeSessions(homeDir = os.homedir()): Promise<CatalogRecord[]> {
  const [indexed, desktop] = await Promise.all([
    readIndexRecords(homeDir),
    readDesktopMetadata(homeDir),
  ]);
  const records = indexed.records;
  await discoverCliRecords(homeDir, records, indexed.sidechainIds);
  for (const sessionId of desktop.archived) {
    records.delete(sessionId);
  }
  for (const [sessionId, metadata] of desktop.active) {
    if (indexed.sidechainIds.has(sessionId)) {
      continue;
    }
    const existing = records.get(sessionId);
    const filePath = existing?.filePath ?? (await locateSessionFile(homeDir, sessionId));
    if (!filePath) {
      continue;
    }
    const createdAt = timestampMs(metadata.createdAt) ?? existing?.createdAt;
    const updatedAt = timestampMs(metadata.lastActivityAt) ?? existing?.updatedAt;
    records.set(sessionId, {
      ...(existing ?? {
        threadId: sessionId,
        status: "stored" as const,
        modelProvider: "anthropic" as const,
        archived: false as const,
      }),
      name: optionalString(metadata.title, 500) ?? existing?.name ?? null,
      cwd: optionalString(metadata.cwd) ?? optionalString(metadata.originCwd) ?? existing?.cwd,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt, recencyAt: updatedAt } : {}),
      source: "claude-desktop",
      filePath,
    });
  }
  return [...records.values()].toSorted((left, right) => {
    const recency =
      (right.recencyAt ?? right.updatedAt ?? 0) - (left.recencyAt ?? left.updatedAt ?? 0);
    return recency || left.threadId.localeCompare(right.threadId);
  });
}

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeOffset(cursor: unknown, label: string): number {
  if (cursor === undefined) {
    return 0;
  }
  if (typeof cursor !== "string" || !cursor || cursor.length > MAX_CURSOR_LENGTH) {
    throw new ClaudeCatalogParamsError(`${label} cursor is invalid`);
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      throw new Error("invalid offset");
    }
    return parsed.offset as number;
  } catch (error) {
    throw new ClaudeCatalogParamsError(`${label} cursor is invalid`, { cause: error });
  }
}

function readLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new ClaudeCatalogParamsError(`limit must be an integer from 1 to ${max}`);
  }
  return value as number;
}

function readListParams(value: unknown): {
  cursor?: string;
  limit: number;
  searchTerm?: string;
} {
  if (value === undefined || value === null) {
    return { limit: DEFAULT_PAGE_LIMIT };
  }
  if (!isRecord(value)) {
    throw new ClaudeCatalogParamsError("Claude session catalog parameters must be an object");
  }
  const allowed = new Set(["cursor", "limit", "searchTerm"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ClaudeCatalogParamsError(`unknown Claude session catalog parameter: ${unknown}`);
  }
  const cursor = optionalString(value.cursor, MAX_CURSOR_LENGTH);
  const searchTerm = optionalString(value.searchTerm, MAX_SEARCH_LENGTH);
  return {
    limit: readLimit(value.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    ...(cursor ? { cursor } : {}),
    ...(searchTerm ? { searchTerm } : {}),
  };
}

export async function listLocalClaudeSessionPage(
  value: unknown,
  homeDir = os.homedir(),
): Promise<ClaudeSessionCatalogPage> {
  const params = readListParams(value);
  const offset = decodeOffset(params.cursor, "catalog");
  const search = params.searchTerm?.toLocaleLowerCase();
  const records = (await listClaudeSessions(homeDir)).filter((record) => {
    if (!search) {
      return true;
    }
    return [record.name, record.cwd, record.gitBranch, record.threadId].some((candidate) =>
      candidate?.toLocaleLowerCase().includes(search),
    );
  });
  const page = records
    .slice(offset, offset + params.limit)
    .map(({ filePath: _filePath, ...record }) => record);
  const nextOffset = offset + page.length;
  return {
    sessions: page,
    ...(nextOffset < records.length ? { nextCursor: encodeOffset(nextOffset) } : {}),
  };
}

function parseNodeParams(paramsJSON?: string | null): unknown {
  if (!paramsJSON) {
    return undefined;
  }
  try {
    return JSON.parse(paramsJSON) as unknown;
  } catch (error) {
    throw new ClaudeCatalogParamsError("Claude session parameters must be valid JSON", {
      cause: error,
    });
  }
}

function transcriptItemType(role: string, content: unknown): string {
  if (!Array.isArray(content)) {
    return role === "user" ? "userMessage" : "agentMessage";
  }
  const types = content.flatMap((block) =>
    isRecord(block) && typeof block.type === "string" ? [block.type] : [],
  );
  if (types.length > 0 && types.every((type) => type === "tool_result")) {
    return "toolResult";
  }
  if (types.length > 0 && types.every((type) => type === "tool_use")) {
    return "toolCall";
  }
  if (types.length > 0 && types.every((type) => type === "thinking")) {
    return "reasoning";
  }
  return role === "user" ? "userMessage" : "agentMessage";
}

function collectTranscriptText(value: unknown, fragments: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) {
      fragments.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTranscriptText(item, fragments);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["text", "thinking", "content", "input"]) {
    if (key in value) {
      collectTranscriptText(value[key], fragments);
    }
  }
}

function parseTranscriptLine(line: Buffer): ClaudeTranscriptItem | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.isSidechain === true || !isRecord(raw.message)) {
    return undefined;
  }
  const role = raw.message.role;
  if ((role !== "user" && role !== "assistant") || raw.type !== role) {
    return undefined;
  }
  const content = raw.message.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    return undefined;
  }
  const fragments: string[] = [];
  collectTranscriptText(content, fragments);
  const text = [...new Set(fragments)].join("\n\n");
  const item: ClaudeTranscriptItem = {
    type: transcriptItemType(role, content),
    ...(text ? { text } : {}),
    content,
    ...(optionalString(raw.timestamp, 128)
      ? { timestamp: optionalString(raw.timestamp, 128) }
      : {}),
    ...(optionalString(raw.message.model, 256)
      ? { model: optionalString(raw.message.model, 256) }
      : {}),
    ...(optionalString(raw.uuid, 256) ? { uuid: optionalString(raw.uuid, 256) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(item), "utf8") <= MAX_TRANSCRIPT_ITEM_BYTES) {
    return item;
  }
  return {
    type: item.type,
    text: `${truncateUtf16Safe(text, MAX_TRANSCRIPT_TEXT_LENGTH)}\n\n[oversized Claude item truncated]`,
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.uuid ? { uuid: item.uuid } : {}),
    truncated: true,
  };
}

function readTranscriptParams(
  value: unknown,
  options: { includeHostId?: boolean } = {},
): { threadId: string; cursor?: string; limit: number } {
  if (!isRecord(value)) {
    throw new ClaudeCatalogParamsError("Claude session read parameters must be an object");
  }
  const allowed = new Set([
    "threadId",
    "cursor",
    "limit",
    ...(options.includeHostId ? ["hostId"] : []),
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ClaudeCatalogParamsError(`unknown Claude session read parameter: ${unknown}`);
  }
  const threadId = optionalString(value.threadId, 256);
  if (!threadId || !/^[A-Za-z0-9._:-]+$/.test(threadId)) {
    throw new ClaudeCatalogParamsError("threadId is invalid");
  }
  const cursor = optionalString(value.cursor, MAX_CURSOR_LENGTH);
  return {
    threadId,
    limit: readLimit(value.limit, DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT),
    ...(cursor ? { cursor } : {}),
  };
}

export async function readLocalClaudeTranscriptPage(
  value: unknown,
  homeDir = os.homedir(),
): Promise<Omit<ClaudeSessionTranscriptPage, "hostId" | "label">> {
  const params = readTranscriptParams(value);
  const filePath = (await listClaudeSessions(homeDir)).find(
    (record) => record.threadId === params.threadId,
  )?.filePath;
  if (!filePath) {
    throw new ClaudeCatalogParamsError("Claude session is unavailable");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const requestedEnd = params.cursor ? decodeOffset(params.cursor, "transcript") : stat.size;
    if (requestedEnd > stat.size) {
      throw new ClaudeCatalogParamsError("transcript cursor is invalid");
    }
    let position = requestedEnd;
    let scanned = 0;
    let fragments: Buffer[] = [];
    const found: Array<{ item: ClaudeTranscriptItem; start: number }> = [];
    while (position > 0 && scanned < MAX_TRANSCRIPT_SCAN_BYTES && found.length <= params.limit) {
      const size = Math.min(
        TRANSCRIPT_READ_CHUNK_BYTES,
        position,
        MAX_TRANSCRIPT_SCAN_BYTES - scanned,
      );
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      if (bytesRead !== size) {
        throw new Error("Claude transcript changed while it was being read");
      }
      scanned += bytesRead;
      let right = bytesRead;
      for (let index = bytesRead - 1; index >= 0; index -= 1) {
        if (chunk[index] !== 0x0a) {
          continue;
        }
        const segment = chunk.subarray(index + 1, right);
        if (segment.length > 0 || fragments.length > 0) {
          const line = Buffer.concat([segment, ...fragments.toReversed()]);
          const item = parseTranscriptLine(line);
          fragments = [];
          if (item) {
            found.push({ item, start: position + index + 1 });
            if (found.length > params.limit) {
              break;
            }
          }
        }
        right = index;
      }
      if (found.length > params.limit) {
        break;
      }
      const prefix = chunk.subarray(0, right);
      if (position === 0) {
        if (prefix.length > 0 || fragments.length > 0) {
          const line = Buffer.concat([prefix, ...fragments.toReversed()]);
          const item = parseTranscriptLine(line);
          if (item) {
            found.push({ item, start: 0 });
          }
        }
        fragments = [];
      } else if (prefix.length > 0) {
        fragments.push(prefix);
      }
    }
    if (position > 0 && found.length < params.limit) {
      throw new Error("Claude transcript page exceeded the safe scan limit");
    }
    const requested = found.slice(0, params.limit);
    const selected: typeof requested = [];
    let selectedBytes = 0;
    for (const entry of requested) {
      const itemBytes = Buffer.byteLength(JSON.stringify(entry.item), "utf8");
      if (
        selected.length > 0 &&
        selectedBytes + itemBytes > MAX_TRANSCRIPT_PAGE_BYTES - 64 * 1024
      ) {
        break;
      }
      selected.push(entry);
      selectedBytes += itemBytes;
    }
    const earliestStart = selected.at(-1)?.start;
    const hasEarlierItems = selected.length < found.length || position > 0;
    return {
      threadId: params.threadId,
      // Match the Codex session-page contract: newest item first on the wire;
      // the shared UI prepends each page after restoring chronological order.
      items: selected.map((entry) => entry.item),
      ...(hasEarlierItems && earliestStart !== undefined && earliestStart > 0
        ? { nextCursor: encodeOffset(earliestStart) }
        : {}),
    };
  } finally {
    await handle.close();
  }
}

function parseCatalogPage(value: unknown): ClaudeSessionCatalogPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_PAGE_LIMIT
  ) {
    throw new Error("Claude node returned an invalid session page");
  }
  const sessions = value.sessions.map((candidate): ClaudeSessionCatalogSession => {
    if (!isRecord(candidate)) {
      throw new Error("Claude node returned an invalid session");
    }
    const threadId = optionalString(candidate.threadId, 256);
    const source = candidate.source;
    if (
      !threadId ||
      candidate.archived !== false ||
      candidate.status !== "stored" ||
      (source !== "claude-cli" && source !== "claude-desktop") ||
      candidate.modelProvider !== "anthropic"
    ) {
      throw new Error("Claude node returned an invalid session");
    }
    const parseStringField = (key: string, maxLength = MAX_STRING_LENGTH): string | undefined => {
      if (!(key in candidate)) {
        return undefined;
      }
      const parsed = optionalString(candidate[key], maxLength);
      if (!parsed) {
        throw new Error("Claude node returned an invalid session");
      }
      return parsed;
    };
    const parseNumberField = (key: string, nullable = false): number | null | undefined => {
      if (!(key in candidate)) {
        return undefined;
      }
      if (nullable && candidate[key] === null) {
        return null;
      }
      const parsed = candidate[key];
      if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        throw new Error("Claude node returned an invalid session");
      }
      return parsed;
    };
    let name: string | null | undefined;
    if (candidate.name === null) {
      name = null;
    } else {
      name = parseStringField("name", 500);
    }
    const cwd = parseStringField("cwd");
    const createdAt = parseNumberField("createdAt") as number | undefined;
    const updatedAt = parseNumberField("updatedAt") as number | undefined;
    const recencyAt = parseNumberField("recencyAt", true);
    const cliVersion = parseStringField("cliVersion", 256);
    const gitBranch = parseStringField("gitBranch", 500);
    return {
      threadId,
      status: "stored",
      source,
      modelProvider: "anthropic",
      archived: false,
      ...(name !== undefined ? { name } : {}),
      ...(cwd ? { cwd } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(recencyAt !== undefined ? { recencyAt } : {}),
      ...(cliVersion ? { cliVersion } : {}),
      ...(gitBranch ? { gitBranch } : {}),
    };
  });
  const nextCursor = optionalString(value.nextCursor, MAX_CURSOR_LENGTH);
  if ("nextCursor" in value && !nextCursor) {
    throw new Error("Claude node returned an invalid session page");
  }
  return { sessions, ...(nextCursor ? { nextCursor } : {}) };
}

function unwrapNodePayload(value: unknown): unknown {
  if (isRecord(value) && typeof value.payloadJSON === "string") {
    return JSON.parse(value.payloadJSON) as unknown;
  }
  return value;
}

function nodeLabel(node: { displayName?: string; remoteIp?: string; nodeId: string }): string {
  return node.displayName?.trim() || node.remoteIp?.trim() || node.nodeId;
}

function parseGatewayQuery(value: unknown): {
  search?: string;
  limitPerHost: number;
  hostIds?: string[];
  cursors?: Record<string, string>;
} {
  if (value === undefined || value === null) {
    return { limitPerHost: DEFAULT_PAGE_LIMIT };
  }
  if (!isRecord(value)) {
    throw new ClaudeCatalogParamsError("Claude session catalog parameters must be an object");
  }
  const allowed = new Set(["search", "limitPerHost", "hostIds", "cursors"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ClaudeCatalogParamsError(`unknown Claude session catalog parameter: ${unknown}`);
  }
  const search = optionalString(value.search, MAX_SEARCH_LENGTH);
  let hostIds: string[] | undefined;
  if (value.hostIds !== undefined) {
    if (!Array.isArray(value.hostIds) || value.hostIds.length > MAX_HOSTS) {
      throw new ClaudeCatalogParamsError("hostIds must be a bounded array");
    }
    hostIds = [
      ...new Set(
        value.hostIds.map((hostId) => {
          const normalized = optionalString(hostId, 256);
          if (
            !normalized ||
            (normalized !== CLAUDE_LOCAL_SESSION_HOST_ID && !normalized.startsWith("node:"))
          ) {
            throw new ClaudeCatalogParamsError("hostId is invalid");
          }
          return normalized;
        }),
      ),
    ];
  }
  let cursors: Record<string, string> | undefined;
  if (value.cursors !== undefined) {
    if (!isRecord(value.cursors) || Object.keys(value.cursors).length > MAX_HOSTS) {
      throw new ClaudeCatalogParamsError("cursors must be a bounded object");
    }
    cursors = Object.fromEntries(
      Object.entries(value.cursors).map(([hostId, cursor]) => {
        const normalized = optionalString(cursor, MAX_CURSOR_LENGTH);
        if (!normalized) {
          throw new ClaudeCatalogParamsError(`cursor for ${hostId} is invalid`);
        }
        return [hostId, normalized];
      }),
    );
  }
  return {
    limitPerHost: readLimit(value.limitPerHost, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    ...(search ? { search } : {}),
    ...(hostIds ? { hostIds } : {}),
    ...(cursors ? { cursors } : {}),
  };
}

export async function listClaudeSessionCatalog(params: {
  runtime: PluginRuntime;
  query?: unknown;
}): Promise<ClaudeSessionCatalogResult> {
  const query = parseGatewayQuery(params.query);
  const requested = query.hostIds ? new Set(query.hostIds) : undefined;
  const hosts: ClaudeSessionCatalogHost[] = [];
  if (!requested || requested.has(CLAUDE_LOCAL_SESSION_HOST_ID)) {
    try {
      hosts.push({
        hostId: CLAUDE_LOCAL_SESSION_HOST_ID,
        label: "Local Claude",
        kind: "gateway",
        connected: true,
        ...(await listLocalClaudeSessionPage({
          limit: query.limitPerHost,
          ...(query.search ? { searchTerm: query.search } : {}),
          ...(query.cursors?.[CLAUDE_LOCAL_SESSION_HOST_ID]
            ? { cursor: query.cursors[CLAUDE_LOCAL_SESSION_HOST_ID] }
            : {}),
        })),
      });
    } catch {
      hosts.push({
        hostId: CLAUDE_LOCAL_SESSION_HOST_ID,
        label: "Local Claude",
        kind: "gateway",
        connected: true,
        sessions: [],
        error: { code: "LOCAL_READ_FAILED", message: "Local Claude sessions are unavailable" },
      });
    }
  }
  const wantsNodes = !requested || query.hostIds?.some((hostId) => hostId.startsWith("node:"));
  if (!wantsNodes) {
    return { hosts };
  }
  let nodes: Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"];
  try {
    nodes = (await params.runtime.nodes.list()).nodes;
  } catch {
    return {
      hosts: [
        ...hosts,
        {
          hostId: "node:registry",
          label: "Paired nodes",
          kind: "node",
          connected: false,
          sessions: [],
          error: { code: "NODE_LIST_FAILED", message: "Paired nodes could not be listed" },
        },
      ],
    };
  }
  const eligible = nodes
    .filter(
      (node) =>
        node.commands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) &&
        (!requested || requested.has(`node:${node.nodeId}`)),
    )
    .slice(0, MAX_HOSTS - hosts.length)
    .toSorted((left, right) => nodeLabel(left).localeCompare(nodeLabel(right)));
  const nodeHosts = await Promise.all(
    eligible.map(async (node): Promise<ClaudeSessionCatalogHost> => {
      const hostId = `node:${node.nodeId}`;
      const common = {
        hostId,
        label: nodeLabel(node),
        kind: "node" as const,
        connected: node.connected === true,
        nodeId: node.nodeId,
      };
      if (node.connected !== true) {
        return Object.assign(common, {
          sessions: [],
          error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
        });
      }
      try {
        const raw = await params.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: CLAUDE_SESSIONS_LIST_COMMAND,
          params: {
            limit: query.limitPerHost,
            ...(query.search ? { searchTerm: query.search } : {}),
            ...(query.cursors?.[hostId] ? { cursor: query.cursors[hostId] } : {}),
          },
          timeoutMs: NODE_INVOKE_TIMEOUT_MS,
        });
        return Object.assign(common, parseCatalogPage(unwrapNodePayload(raw)));
      } catch {
        return Object.assign(common, {
          sessions: [],
          error: {
            code: "NODE_INVOKE_FAILED",
            message: "Paired node Claude sessions are unavailable",
          },
        });
      }
    }),
  );
  return { hosts: [...hosts, ...nodeHosts] };
}

async function readClaudeSessionTranscript(params: {
  runtime: PluginRuntime;
  hostId: string;
  threadId: string;
  cursor?: string;
  limit: number;
}): Promise<ClaudeSessionTranscriptPage> {
  if (params.hostId === CLAUDE_LOCAL_SESSION_HOST_ID) {
    return {
      hostId: params.hostId,
      label: "Local Claude",
      ...(await readLocalClaudeTranscriptPage({
        threadId: params.threadId,
        limit: params.limit,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      })),
    };
  }
  if (!params.hostId.startsWith("node:")) {
    throw new ClaudeCatalogParamsError("hostId is invalid");
  }
  const nodeId = params.hostId.slice("node:".length);
  const node = (await params.runtime.nodes.list()).nodes.find(
    (candidate) =>
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      candidate.commands?.includes(CLAUDE_SESSION_READ_COMMAND),
  );
  if (!node) {
    throw new ClaudeCatalogParamsError("paired-node Claude session host is unavailable");
  }
  const raw = await params.runtime.nodes.invoke({
    nodeId,
    command: CLAUDE_SESSION_READ_COMMAND,
    params: {
      threadId: params.threadId,
      limit: params.limit,
      ...(params.cursor ? { cursor: params.cursor } : {}),
    },
    timeoutMs: NODE_INVOKE_TIMEOUT_MS,
  });
  const page = unwrapNodePayload(raw);
  if (
    !isRecord(page) ||
    !Array.isArray(page.items) ||
    page.items.length > MAX_TRANSCRIPT_LIMIT ||
    page.items.some((item) => !isRecord(item) || typeof item.type !== "string") ||
    page.threadId !== params.threadId ||
    Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_TRANSCRIPT_PAGE_BYTES
  ) {
    throw new Error("Claude node returned an invalid transcript page");
  }
  return {
    hostId: params.hostId,
    label: nodeLabel(node),
    threadId: params.threadId,
    items: page.items as ClaudeTranscriptItem[],
    ...(optionalString(page.nextCursor, MAX_CURSOR_LENGTH)
      ? { nextCursor: optionalString(page.nextCursor, MAX_CURSOR_LENGTH) }
      : {}),
  };
}

export function createClaudeSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CLAUDE_SESSIONS_LIST_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: ({ env }) => claudeProjectsAvailable(env),
      handle: async (paramsJSON) =>
        JSON.stringify(await listLocalClaudeSessionPage(parseNodeParams(paramsJSON))),
    },
    {
      command: CLAUDE_SESSION_READ_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: ({ env }) => claudeProjectsAvailable(env),
      handle: async (paramsJSON) =>
        JSON.stringify(await readLocalClaudeTranscriptPage(parseNodeParams(paramsJSON))),
    },
  ];
}

export function createClaudeSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_SESSION_READ_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) => context.invokeNode(),
    },
  ];
}

export function registerClaudeSessionCatalog(api: OpenClawPluginApi): void {
  api.session.controls.registerControlUiDescriptor({
    surface: "tab",
    id: "sessions",
    label: "Claude Sessions",
    description: "Claude CLI and Desktop sessions on this Gateway and paired nodes.",
    icon: "terminal",
    group: "control",
    requiredScopes: ["operator.write"],
  });
  api.registerGatewayMethod(
    CLAUDE_SESSION_CATALOG_METHOD,
    async ({ params, respond }: GatewayRequestHandlerOptions) => {
      try {
        respond(true, await listClaudeSessionCatalog({ runtime: api.runtime, query: params }));
      } catch (error) {
        if (error instanceof ClaudeCatalogParamsError) {
          respond(
            false,
            { error: error.message },
            errorShape(ErrorCodes.INVALID_REQUEST, error.message),
          );
          return;
        }
        const message = "Claude session catalog request failed";
        respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    CLAUDE_SESSION_READ_METHOD,
    async ({ params, respond }: GatewayRequestHandlerOptions) => {
      try {
        if (!isRecord(params)) {
          throw new ClaudeCatalogParamsError("Claude session read parameters must be an object");
        }
        const hostId = optionalString(params.hostId, 256);
        const read = readTranscriptParams(params, { includeHostId: true });
        if (!hostId) {
          throw new ClaudeCatalogParamsError("hostId is invalid");
        }
        respond(true, await readClaudeSessionTranscript({ runtime: api.runtime, hostId, ...read }));
      } catch (error) {
        if (error instanceof ClaudeCatalogParamsError) {
          respond(
            false,
            { error: error.message },
            errorShape(ErrorCodes.INVALID_REQUEST, error.message),
          );
          return;
        }
        const message = "Claude session transcript could not be read";
        respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
      }
    },
    { scope: "operator.write" },
  );
}
