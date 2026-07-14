import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  SessionCatalogHost,
  SessionCatalogProvider,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import { withSessionTranscriptWriteLock } from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const CLAUDE_SESSIONS_LIST_COMMAND = "anthropic.claude.sessions.list.v1";
export const CLAUDE_SESSION_READ_COMMAND = "anthropic.claude.sessions.read.v1";
export const CLAUDE_CLI_NODE_RUN_COMMAND = "agent.cli.claude.run.v1";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_DEFAULT_MODEL_REF } from "./cli-constants.js";
import {
  adoptedSessionKey,
  adoptedSourceKey,
  CLAUDE_LOCAL_SESSION_HOST_ID,
} from "./session-catalog-adoption.js";
import {
  currentClaudeSessionCatalogConfig,
  listBoundClaudeSessions,
  resolveClaudeCatalogCreateSession,
} from "./session-catalog-runtime.js";
import {
  collectTranscriptText,
  parseTranscriptLine,
  type ClaudeTranscriptItem,
} from "./session-catalog-transcript.js";

export type { ClaudeTranscriptItem } from "./session-catalog-transcript.js";

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
const MAX_TRANSCRIPT_PAGE_BYTES = 20 * 1024 * 1024;

const NODE_INVOKE_TIMEOUT_MS = 30_000;
const CLAUDE_HISTORY_IMPORT_MAX_ITEMS = 200;
const CLAUDE_HISTORY_IMPORT_MAX_BYTES = 512 * 1024;

type ClaudeSessionSource = "claude-cli" | "claude-desktop";

// Desktop-app sessions live in the same ~/.claude/projects store as CLI
// sessions (records without a projects JSONL are dropped during discovery),
// so `claude --resume --fork-session` continues both alike.
function isResumableClaudeSource(source: string | undefined): boolean {
  return source === "claude-cli" || source === "claude-desktop";
}

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
  canContinueClaude?: boolean;
  error?: { code: string; message: string };
};

export type ClaudeSessionCatalogResult = {
  hosts: ClaudeSessionCatalogHost[];
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

function currentHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
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

async function listClaudeSessions(homeDir = currentHomeDir()): Promise<CatalogRecord[]> {
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
  homeDir = currentHomeDir(),
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
  homeDir = currentHomeDir(),
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
          const item = parseTranscriptLine(line, optionalString);
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
          const item = parseTranscriptLine(line, optionalString);
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
        canContinueClaude:
          node.commands?.includes(CLAUDE_SESSION_READ_COMMAND) === true &&
          node.commands.includes(CLAUDE_CLI_NODE_RUN_COMMAND) &&
          node.invocableCommands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) === true &&
          node.invocableCommands.includes(CLAUDE_SESSION_READ_COMMAND) &&
          node.invocableCommands.includes(CLAUDE_CLI_NODE_RUN_COMMAND),
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

async function readBoundedClaudeHistory(params: {
  runtime: PluginRuntime;
  hostId: string;
  threadId: string;
}): Promise<ClaudeTranscriptItem[]> {
  const items: ClaudeTranscriptItem[] = [];
  let cursor: string | undefined;
  let bytes = 0;
  while (items.length < CLAUDE_HISTORY_IMPORT_MAX_ITEMS) {
    const page = await readClaudeSessionTranscript({
      runtime: params.runtime,
      hostId: params.hostId,
      threadId: params.threadId,
      limit: Math.min(MAX_TRANSCRIPT_LIMIT, CLAUDE_HISTORY_IMPORT_MAX_ITEMS - items.length),
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) {
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (items.length > 0 && bytes + itemBytes > CLAUDE_HISTORY_IMPORT_MAX_BYTES) {
        return items;
      }
      items.push(item);
      bytes += itemBytes;
    }
    if (!page.nextCursor || page.nextCursor === cursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  return items;
}

function importedClaudeMessage(
  item: ClaudeTranscriptItem,
  fallbackTimestamp: number,
): AgentMessage {
  const timestamp = item.timestamp ? Date.parse(item.timestamp) : fallbackTimestamp;
  const text = item.text?.trim() || "[Unsupported Claude transcript item]";
  if (item.type === "userMessage") {
    return { role: "user", content: text, timestamp } as AgentMessage;
  }
  const prefix =
    item.type === "reasoning"
      ? "Thinking\n\n"
      : item.type === "toolCall"
        ? "Tool call\n\n"
        : item.type === "toolResult"
          ? "Tool result\n\n"
          : "";
  return {
    role: "assistant",
    content: [{ type: "text", text: `${prefix}${text}` }],
    timestamp,
    api: "anthropic-messages",
    provider: CLAUDE_CLI_BACKEND_ID,
    model: "native-history",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  } as AgentMessage;
}

async function importClaudeHistory(params: {
  items: ClaudeTranscriptItem[];
  threadId: string;
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  cwd?: string;
  config: OpenClawConfig;
}): Promise<void> {
  const items = params.items.toReversed();
  await withSessionTranscriptWriteLock(params, async (transcript) => {
    for (const [index, item] of items.entries()) {
      // The idempotency key rides on the message so recovery re-imports dedupe
      // against the transcript instead of appending duplicate history.
      const message = {
        ...(importedClaudeMessage(item, Date.now() + index) as unknown as Record<string, unknown>),
        idempotencyKey: `claude-catalog:${params.threadId}:${item.uuid ?? index}`,
      } as unknown as AgentMessage;
      await transcript.appendMessage({
        message,
        idempotencyLookup: "scan",
        cwd: params.cwd,
      });
    }
  });
}

const claudeContinueOperations = new Map<string, Promise<{ sessionKey: string }>>();

async function resolveNodeClaudeRecord(params: {
  runtime: PluginRuntime;
  nodeId: string;
  threadId: string;
}): Promise<ClaudeSessionCatalogSession> {
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const raw = await params.runtime.nodes.invoke({
      nodeId: params.nodeId,
      command: CLAUDE_SESSIONS_LIST_COMMAND,
      params: {
        limit: MAX_PAGE_LIMIT,
        searchTerm: params.threadId,
        ...(cursor ? { cursor } : {}),
      },
      timeoutMs: NODE_INVOKE_TIMEOUT_MS,
    });
    const page = parseCatalogPage(unwrapNodePayload(raw));
    const record = page.sessions.find((candidate) => candidate.threadId === params.threadId);
    if (record) {
      return record;
    }
    if (!page.nextCursor || page.nextCursor === cursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  throw new ClaudeCatalogParamsError("Claude session is unavailable on the paired node");
}

async function continueClaudeSession(
  api: OpenClawPluginApi,
  hostId: string,
  threadId: string,
): Promise<{ sessionKey: string }> {
  const sourceKey = adoptedSourceKey(hostId, threadId);
  const existing = listBoundClaudeSessions(api).get(sourceKey);
  if (existing) {
    return { sessionKey: existing };
  }
  const pending = claudeContinueOperations.get(sourceKey);
  if (pending) {
    return await pending;
  }
  const operation = (async () => {
    let nodeId: string | undefined;
    let record: ClaudeSessionCatalogSession | undefined;
    if (hostId === CLAUDE_LOCAL_SESSION_HOST_ID) {
      record = (await listClaudeSessions()).find((candidate) => candidate.threadId === threadId);
      if (!record || !isResumableClaudeSource(record.source)) {
        throw new ClaudeCatalogParamsError("only local Claude Code sessions can be continued");
      }
    } else if (hostId.startsWith("node:")) {
      nodeId = hostId.slice("node:".length);
      const node = (await api.runtime.nodes.list()).nodes.find(
        (candidate) =>
          candidate.nodeId === nodeId &&
          candidate.connected === true &&
          candidate.commands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) &&
          candidate.commands.includes(CLAUDE_SESSION_READ_COMMAND) &&
          candidate.commands.includes(CLAUDE_CLI_NODE_RUN_COMMAND) &&
          candidate.invocableCommands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) === true &&
          candidate.invocableCommands.includes(CLAUDE_SESSION_READ_COMMAND) &&
          candidate.invocableCommands.includes(CLAUDE_CLI_NODE_RUN_COMMAND),
      );
      if (!node) {
        throw new ClaudeCatalogParamsError(
          "paired node does not permit Claude CLI session continuation",
        );
      }
      // Node rows stay CLI-only: desktop transcripts on nodes have no
      // node-side run command and remain view-only.
      record = await resolveNodeClaudeRecord({ runtime: api.runtime, nodeId, threadId });
      if (!record || record.source !== "claude-cli") {
        throw new ClaudeCatalogParamsError("only Claude CLI sessions can be continued");
      }
    } else {
      throw new ClaudeCatalogParamsError("hostId is invalid");
    }
    if (hostId === CLAUDE_LOCAL_SESSION_HOST_ID) {
      const source = await fs.stat((record as CatalogRecord).filePath).catch(() => undefined);
      if (!source?.isFile()) {
        throw new ClaudeCatalogParamsError("Claude session transcript is unavailable");
      }
    }
    const history = await readBoundedClaudeHistory({ runtime: api.runtime, hostId, threadId });
    const config = currentClaudeSessionCatalogConfig(api);
    const model = CLAUDE_CLI_DEFAULT_MODEL_REF.slice(`${CLAUDE_CLI_BACKEND_ID}/`.length);
    const marker = {
      sourceThreadId: threadId,
      ...(hostId !== CLAUDE_LOCAL_SESSION_HOST_ID ? { sourceHostId: hostId } : {}),
    };
    try {
      const created = await api.runtime.agent.session.createSessionEntry({
        cfg: config,
        key: adoptedSessionKey(hostId, threadId),
        agentId: resolveDefaultAgentId(config),
        recoverMatchingInitialEntry: true,
        ...(record.name ? { label: record.name } : {}),
        ...(record.cwd ? { spawnedCwd: record.cwd } : {}),
        ...(nodeId ? { execNode: nodeId, ...(record.cwd ? { execCwd: record.cwd } : {}) } : {}),
        initialEntry: {
          cliBackendId: CLAUDE_CLI_BACKEND_ID,
          model,
          modelSelectionLocked: true,
          pluginOwnerId: api.id,
          cliSessionBinding: { sessionId: threadId, forceReuse: true, forkNextResume: true },
          pluginExtensions: { anthropic: { sessionCatalog: marker } },
        },
        afterCreate: async (entry) => {
          if (!entry.entry.sessionFile) {
            throw new Error("Claude session creation did not produce a transcript file");
          }
          await importClaudeHistory({
            items: history,
            threadId,
            sessionFile: entry.entry.sessionFile,
            sessionId: entry.sessionId,
            sessionKey: entry.key,
            agentId: entry.agentId,
            ...(record.cwd ? { cwd: record.cwd } : {}),
            config,
          });
          return { pluginExtensions: { anthropic: { sessionCatalog: marker } } };
        },
      });
      return { sessionKey: created.key };
    } catch (error) {
      const raced = listBoundClaudeSessions(api).get(sourceKey);
      if (raced) {
        return { sessionKey: raced };
      }
      throw error;
    }
  })();
  claudeContinueOperations.set(sourceKey, operation);
  try {
    return await operation;
  } finally {
    if (claudeContinueOperations.get(sourceKey) === operation) {
      claudeContinueOperations.delete(sourceKey);
    }
  }
}

function toGenericClaudeItem(item: ClaudeTranscriptItem): SessionCatalogTranscriptItem {
  const allowed = new Set<SessionCatalogTranscriptItem["type"]>([
    "userMessage",
    "agentMessage",
    "reasoning",
    "toolCall",
    "toolResult",
    "other",
  ]);
  const type = allowed.has(item.type as SessionCatalogTranscriptItem["type"])
    ? (item.type as SessionCatalogTranscriptItem["type"])
    : "other";
  return {
    ...(item.uuid ? { id: item.uuid } : {}),
    type,
    ...(item.text ? { text: item.text } : {}),
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.truncated ? { truncated: true } : {}),
    ...(item.content !== undefined
      ? { raw: item.content as SessionCatalogTranscriptItem["raw"] }
      : {}),
  };
}

function toGenericClaudeHost(
  host: ClaudeSessionCatalogHost,
  adopted: ReadonlyMap<string, string>,
): SessionCatalogHost {
  return {
    hostId: host.hostId,
    label: host.label,
    kind: host.kind,
    connected: host.connected,
    ...(host.nodeId ? { nodeId: host.nodeId } : {}),
    sessions: host.sessions.map((session) => {
      const localResumable =
        host.hostId === CLAUDE_LOCAL_SESSION_HOST_ID && isResumableClaudeSource(session.source);
      const nodeCli =
        host.kind === "node" && host.canContinueClaude === true && session.source === "claude-cli";
      const existingSessionKey = adopted.get(adoptedSourceKey(host.hostId, session.threadId));
      // Already-adopted rows stay continuable even if node policy later denies
      // the run command: continue only returns the existing session key, and
      // the turn itself still fails closed at invoke time.
      const continuable = localResumable || nodeCli || Boolean(existingSessionKey);
      const openClawSessionKey = continuable ? existingSessionKey : undefined;
      return {
        threadId: session.threadId,
        ...(session.name ? { name: session.name } : {}),
        ...(session.cwd ? { cwd: session.cwd } : {}),
        status: session.status,
        ...(session.createdAt !== undefined ? { createdAt: session.createdAt } : {}),
        ...(session.updatedAt !== undefined ? { updatedAt: session.updatedAt } : {}),
        ...(session.recencyAt != null ? { recencyAt: session.recencyAt } : {}),
        source: session.source,
        modelProvider: session.modelProvider,
        ...(session.cliVersion ? { cliVersion: session.cliVersion } : {}),
        ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
        archived: session.archived,
        ...(openClawSessionKey ? { openClawSessionKey } : {}),
        canContinue: continuable,
        canArchive: false,
      };
    }),
    ...(host.nextCursor ? { nextCursor: host.nextCursor } : {}),
    ...(host.error ? { error: host.error } : {}),
  };
}

export function registerClaudeSessionCatalog(api: OpenClawPluginApi): void {
  const provider: SessionCatalogProvider = {
    id: "claude",
    label: "Claude Code",
    resolveCreateSession: ({ agentId }) => resolveClaudeCatalogCreateSession(api, agentId),
    list: async (query) => {
      const adopted = listBoundClaudeSessions(api);
      const result = await listClaudeSessionCatalog({ runtime: api.runtime, query });
      return result.hosts.map((host) => toGenericClaudeHost(host, adopted));
    },
    read: async (request) => {
      const page = await readClaudeSessionTranscript({
        runtime: api.runtime,
        hostId: request.hostId,
        threadId: request.threadId,
        cursor: request.cursor,
        limit: request.limit ?? DEFAULT_TRANSCRIPT_LIMIT,
      });
      return { ...page, items: page.items.map(toGenericClaudeItem) };
    },
    continueSession: async (request) =>
      await continueClaudeSession(api, request.hostId, request.threadId),
  };
  api.registerSessionCatalog(provider);
}
