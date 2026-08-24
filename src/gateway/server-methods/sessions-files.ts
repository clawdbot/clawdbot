// Gateway methods expose session files and workspace browsing.
import { createHash } from "node:crypto";
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  isCloudWorkerPlacementState,
  type SessionFileBrowserEntry,
  type SessionFileBrowserResult,
  type SessionFileEntry,
  type SessionFileRelevance,
  type SessionsFilesGetParams,
  validateSessionsFilesRevealParams,
  validateSessionsFilesGetParams,
  validateSessionsFilesListParams,
  validateSessionsFilesSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveToCwd as resolveSessionToolPathToCwd } from "../../agents/sessions/tools/path-utils.js";
import { runGit } from "../../agents/worktrees/git.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { isPathInside } from "../../infra/path-guards.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  readSessionTranscriptVisibleMessageDeltaCore,
  resolveTranscriptReadTarget,
  sqliteMessageEventWithSeq,
  toTranscriptReadScope,
  type SessionTranscriptReadScope,
} from "../session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import {
  execOpenPath,
  formatOpenPathError,
  isHeadlessOpenPathError,
  resolveOpenPathCommand,
  sanitizePathForLog,
} from "./open-path.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";
import {
  decodeUtf8Strict,
  listWorkspacePath,
  normalizeRelativePath,
  readWorkspaceFile,
  readWorkspaceFilePrefix,
  resolveWorkspacePath,
  sortDirents,
  sortWorkspaceEntries,
  statWorkspacePath,
  toUpdatedAtMs,
  updateWorkspaceFile,
  WORKSPACE_PREVIEW_MAX_BYTES,
  workspaceStatKind,
  type WorkspaceDirEntry,
  type WorkspaceFileUpdateResult,
} from "./workspace-fs.js";

type FileKind = "modified" | "read";

type TouchedFile = {
  path: string;
  kind: FileKind;
};

type LoadedSessionFiles = {
  root?: string;
  fileRoot?: string;
  diffCwd?: string;
  files: TouchedFile[];
};

type TouchedFilesCacheEntry = {
  cursor: string;
  files: Map<string, TouchedFile>;
};

const MAX_PREVIEW_BYTES = WORKSPACE_PREVIEW_MAX_BYTES;
const MAX_BROWSER_ENTRIES = 250;
const MAX_SEARCH_ENTRIES = 500;
const MAX_SEARCH_VISITED_ENTRIES = 5_000;
const TOUCHED_FILES_CACHE_LIMIT = 16;
const TOUCHED_FILES_DELTA_MAX_MESSAGES = 1_000;
const TOUCHED_FILES_DELTA_MAX_BYTES = 1_000_000;
// Matches file-type's documented default buffer sample while keeping metadata
// classification independent from the 256 KiB inline-content cap.
const MIME_SNIFF_PREFIX_BYTES = 4_100;
// Inline previews stay limited to formats supported by modern Control UI browsers.
// Native workspace clients intentionally own a broader, separate image policy.
const BROWSER_PREVIEW_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const DETECTED_TEXT_MIME_TYPES = new Set([
  "application/rtf",
  "application/xml",
  "application/x-ms-regedit",
  "model/stl",
]);
const SEARCH_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".next",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
]);

// Request latency must not scale with transcript size: delta resets rebuild the
// fold, while this process-local LRU cap bounds retained session state.
const touchedFilesCache = new Map<string, TouchedFilesCacheEntry>();
// Page yields let other requests interleave, so singleflight keeps one cache-mutating fold per key.
const touchedFilesFolds = new Map<string, Promise<Map<string, TouchedFile>>>();

function readTouchedFilesCache(key: string): TouchedFilesCacheEntry | undefined {
  const cached = touchedFilesCache.get(key);
  if (cached) {
    touchedFilesCache.delete(key);
    touchedFilesCache.set(key, cached);
  }
  return cached;
}

function writeTouchedFilesCache(key: string, entry: TouchedFilesCacheEntry): void {
  touchedFilesCache.delete(key);
  touchedFilesCache.set(key, entry);
  pruneMapToMaxSize(touchedFilesCache, TOUCHED_FILES_CACHE_LIMIT);
}

function sessionFilesError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

function readPathArg(args: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(args.path) ??
    normalizeOptionalString(args.file_path) ??
    normalizeOptionalString(args.filePath) ??
    normalizeOptionalString(args.file)
  );
}

function addTouchedFile(
  files: Map<string, TouchedFile>,
  filePath: string | undefined,
  kind: FileKind,
) {
  if (!filePath) {
    return;
  }
  const existing = files.get(filePath);
  if (existing?.kind === "modified" || (existing && kind === "read")) {
    return;
  }
  files.set(filePath, { path: filePath, kind });
}

function addRawPatchFiles(files: Map<string, TouchedFile>, input: unknown) {
  if (typeof input !== "string") {
    return;
  }
  const fileLinePattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  for (const match of input.matchAll(fileLinePattern)) {
    addTouchedFile(files, match[1]?.trim(), "modified");
  }
  const moveLinePattern = /^\*\*\* Move to: (.+)$/gm;
  for (const match of input.matchAll(moveLinePattern)) {
    addTouchedFile(files, match[1]?.trim(), "modified");
  }
}

function addStructuredPatchFiles(files: Map<string, TouchedFile>, changes: unknown) {
  if (!Array.isArray(changes)) {
    return;
  }
  for (const changeValue of changes) {
    const change = asOptionalObjectRecord(changeValue);
    addTouchedFile(files, normalizeOptionalString(change?.path), "modified");
    const kind = asOptionalObjectRecord(change?.kind);
    addTouchedFile(
      files,
      normalizeOptionalString(kind?.move_path) ?? normalizeOptionalString(kind?.movePath),
      "modified",
    );
  }
}

function addPatchFiles(files: Map<string, TouchedFile>, args: Record<string, unknown>) {
  addRawPatchFiles(files, args.input);
  addStructuredPatchFiles(files, args.changes);
}

function isToolCallBlockType(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.toLowerCase().replace(/[_-]/g, "");
  return normalized === "toolcall" || normalized === "tooluse";
}

function collectTouchedFilesFromMessage(message: unknown, files: Map<string, TouchedFile>) {
  const record = asOptionalObjectRecord(message);
  if (record?.role !== "assistant" || !Array.isArray(record.content)) {
    return;
  }
  for (const blockValue of record.content) {
    const block = asOptionalObjectRecord(blockValue);
    if (!block || !isToolCallBlockType(block.type)) {
      continue;
    }
    const toolName = normalizeOptionalString(block.name)?.toLowerCase();
    const args =
      asOptionalObjectRecord(block.arguments) ??
      asOptionalObjectRecord(block.input) ??
      asOptionalObjectRecord(block.args);
    if (!toolName || !args) {
      continue;
    }
    if (toolName === "read") {
      addTouchedFile(files, readPathArg(args), "read");
    } else if (toolName === "write" || toolName === "edit") {
      addTouchedFile(files, readPathArg(args), "modified");
    } else if (toolName === "apply_patch") {
      addPatchFiles(files, args);
    }
  }
}

async function foldSqliteTouchedFiles(
  scope: SessionTranscriptReadScope,
  cacheKey: string,
): Promise<Map<string, TouchedFile>> {
  let cached = readTouchedFilesCache(cacheKey);
  let cursor = cached?.cursor;
  let files = cached?.files ?? new Map<string, TouchedFile>();
  let maxBytes = TOUCHED_FILES_DELTA_MAX_BYTES;

  while (true) {
    const delta = readSessionTranscriptVisibleMessageDeltaCore(scope, {
      ...(cursor ? { cursor } : {}),
      maxBytes,
      maxMessages: TOUCHED_FILES_DELTA_MAX_MESSAGES,
    });
    if (delta.kind === "missing") {
      touchedFilesCache.delete(cacheKey);
      return new Map();
    }
    if (delta.kind === "reset") {
      cached = { cursor: delta.cursor, files: new Map() };
      cursor = cached.cursor;
      files = cached.files;
      writeTouchedFilesCache(cacheKey, cached);
      continue;
    }
    for (const event of delta.events) {
      const message = sqliteMessageEventWithSeq(event);
      if (message !== undefined) {
        collectTouchedFilesFromMessage(message, files);
      }
    }
    cached = { cursor: delta.cursor, files };
    cursor = cached.cursor;
    writeTouchedFilesCache(cacheKey, cached);
    if (!delta.hasMore) {
      return files;
    }
    if (delta.requiredBytes !== undefined) {
      maxBytes = delta.requiredBytes;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function loadSqliteTouchedFiles(
  scope: SessionTranscriptReadScope,
  cacheKey: string,
): Promise<Map<string, TouchedFile>> {
  const inFlight = touchedFilesFolds.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  const fold = foldSqliteTouchedFiles(scope, cacheKey);
  touchedFilesFolds.set(cacheKey, fold);
  try {
    return await fold;
  } finally {
    touchedFilesFolds.delete(cacheKey);
  }
}

function toDisplayPath(root: string, resolved: string): string {
  const relative = path.relative(root, resolved);
  if (!relative) {
    return "";
  }
  return relative.split(path.sep).join("/");
}

function resolveTouchedFilePath(params: {
  root: string | undefined;
  fileRoot: string | undefined;
  filePath: string;
}): string | undefined {
  if (!params.root) {
    return undefined;
  }
  const base = params.fileRoot ?? params.root;
  const resolved = resolveSessionToolPathToCwd(params.filePath, base);
  if (!isPathInside(params.root, resolved)) {
    return undefined;
  }
  return resolved;
}

function resolveFileRoot(params: {
  root: string | undefined;
  spawnedCwd: string | undefined;
}): string | undefined {
  if (!params.root) {
    return undefined;
  }
  if (!params.spawnedCwd) {
    return params.root;
  }
  const resolvedCwd = path.resolve(params.spawnedCwd);
  const resolvedRoot = path.resolve(params.root);
  return isPathInside(resolvedRoot, resolvedCwd) ? params.spawnedCwd : params.root;
}

function relevanceForKind(kind: FileKind): SessionFileRelevance {
  return kind;
}

function mergeRelevance(
  current: SessionFileRelevance | undefined,
  next: SessionFileRelevance | undefined,
): SessionFileRelevance | undefined {
  if (!current) {
    return next;
  }
  if (!next || current === next) {
    return current;
  }
  return "mixed";
}

function buildSessionRelevanceMap(
  files: readonly TouchedFile[],
  root: string | undefined,
  fileRoot: string | undefined,
): Map<string, SessionFileRelevance> {
  const relevance = new Map<string, SessionFileRelevance>();
  if (!root) {
    for (const file of files) {
      relevance.set(normalizeRelativePath(file.path), relevanceForKind(file.kind));
    }
    return relevance;
  }
  for (const file of files) {
    const resolved = resolveTouchedFilePath({ root, fileRoot, filePath: file.path });
    if (!resolved) {
      continue;
    }
    relevance.set(toDisplayPath(root, resolved), relevanceForKind(file.kind));
  }
  return relevance;
}

function relevanceForBrowserPath(
  browserPath: string,
  kind: "file" | "directory",
  relevance: ReadonlyMap<string, SessionFileRelevance>,
): SessionFileRelevance | undefined {
  if (kind === "file") {
    return relevance.get(browserPath);
  }
  const prefix = browserPath ? `${browserPath}/` : "";
  let aggregate: SessionFileRelevance | undefined;
  for (const [filePath, sessionKind] of relevance) {
    if (filePath.startsWith(prefix) && filePath !== browserPath) {
      aggregate = mergeRelevance(aggregate, sessionKind);
    }
  }
  return aggregate;
}

function displayNameForPath(filePath: string): string {
  const base = path.basename(filePath);
  return base || filePath;
}

function isDetectedTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.endsWith("+xml") ||
    DETECTED_TEXT_MIME_TYPES.has(mimeType)
  );
}

function applyInlineFilePreview(entry: SessionFileEntry, buffer: Buffer, mimeType?: string): void {
  if (mimeType && BROWSER_PREVIEW_IMAGE_MIME_TYPES.has(mimeType)) {
    entry.mimeType = mimeType;
    entry.contentEncoding = "base64";
    entry.previewKind = "image";
    entry.content = buffer.toString("base64");
    return;
  }
  const text = decodeUtf8Strict(buffer);
  if ((!mimeType || isDetectedTextMime(mimeType)) && text !== undefined) {
    entry.mimeType = mimeType ?? "text/plain";
    entry.contentEncoding = "utf8";
    entry.previewKind = "text";
    entry.content = text;
    // The hash doubles as the sessions.files.set CAS token. Binary files
    // never receive one, so replacement characters cannot be saved back.
    entry.hash = createHash("sha256").update(buffer).digest("hex");
    return;
  }
  entry.previewKind = "unsupported";
  if (mimeType) {
    entry.mimeType = mimeType;
  }
}

function applyOversizedFileMetadata(
  entry: SessionFileEntry,
  buffer: Buffer,
  mimeType?: string,
): void {
  const prefixIsText = decodeUtf8Strict(buffer) !== undefined;
  if ((!mimeType && prefixIsText) || (mimeType && isDetectedTextMime(mimeType) && prefixIsText)) {
    return;
  }
  entry.previewKind = "unsupported";
  if (mimeType) {
    entry.mimeType = mimeType;
  }
}

async function toSessionFileEntry(
  touched: TouchedFile,
  root: string | undefined,
  fileRoot: string | undefined,
  opts: { includeContent?: boolean } = {},
): Promise<SessionFileEntry> {
  const resolved = resolveTouchedFilePath({ root, fileRoot, filePath: touched.path });
  const base = {
    path: touched.path,
    name: displayNameForPath(touched.path),
    kind: touched.kind,
  } satisfies Pick<SessionFileEntry, "path" | "name" | "kind">;
  if (!resolved) {
    return { ...base, missing: true };
  }
  const browserPath = toDisplayPath(root!, resolved);
  const stat = await statWorkspacePath(root!, browserPath);
  if (!stat || workspaceStatKind(stat) !== "file") {
    return { ...base, missing: true };
  }
  const entry: SessionFileEntry = {
    ...base,
    workspacePath: browserPath,
    missing: false,
    size: stat.size,
    updatedAtMs: toUpdatedAtMs(stat.mtimeMs),
  };
  if (!opts.includeContent) {
    return entry;
  }
  if (stat.size <= MAX_PREVIEW_BYTES) {
    const read = await readWorkspaceFile(root!, browserPath);
    if (!read) {
      return { ...base, missing: true };
    }
    if (read === "too-large") {
      return entry;
    }
    entry.workspacePath = read.canonicalPath;
    entry.size = read.stat.size;
    entry.updatedAtMs = toUpdatedAtMs(read.stat.mtimeMs);
    const mimeType = await detectMime({ buffer: read.buffer });
    applyInlineFilePreview(entry, read.buffer, mimeType);
    return entry;
  }
  const prefix = await readWorkspaceFilePrefix(root!, browserPath, MIME_SNIFF_PREFIX_BYTES);
  if (!prefix) {
    return { ...base, missing: true };
  }
  entry.workspacePath = prefix.canonicalPath;
  entry.size = prefix.stat.size;
  entry.updatedAtMs = toUpdatedAtMs(prefix.stat.mtimeMs);
  const mimeType = await detectMime({ buffer: prefix.buffer });
  applyOversizedFileMetadata(entry, prefix.buffer, mimeType);
  return entry;
}

function loadSessionFileRoot(params: { sessionKey: string; agentId?: string }) {
  const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
  if (!loaded.entry?.sessionId) {
    return { ...loaded, agentId: undefined, root: undefined, fileRoot: undefined };
  }
  const agentId = normalizeAgentId(
    loaded.agentId ??
      parseAgentSessionKey(loaded.canonicalKey)?.agentId ??
      params.agentId ??
      parseAgentSessionKey(params.sessionKey)?.agentId,
  );
  const spawnedCwd = normalizeOptionalString(loaded.entry.spawnedCwd);
  const spawnedWorkspaceDir = normalizeOptionalString(loaded.entry.spawnedWorkspaceDir);
  const configuredWorkspaceDir =
    spawnedCwd || spawnedWorkspaceDir
      ? undefined
      : normalizeOptionalString(resolveAgentWorkspaceDir(loaded.cfg, agentId));
  // Keep this cwd precedence aligned with sessions.diff so the advertised
  // checkout state cannot disagree with the panel's fallback result.
  const diffCwd = spawnedCwd ?? spawnedWorkspaceDir ?? configuredWorkspaceDir;
  const root = spawnedWorkspaceDir ?? spawnedCwd ?? configuredWorkspaceDir;
  return {
    ...loaded,
    agentId,
    root,
    fileRoot: resolveFileRoot({ root, spawnedCwd }),
    diffCwd,
  };
}

/**
 * Canonical workspace root of a session that lives on this Gateway's own disk.
 * Workspace identity surfaces must name the same directory the file routes
 * open, so they read it from here instead of re-deriving the precedence.
 *
 * An exec-node session's directory only exists on the remote host, while the
 * precedence below falls back to the local agent workspace — returning that
 * would describe the wrong machine. `sessions.files.reveal` refuses the same
 * case; callers here get "no local root" and their own absent-workspace path.
 */
export function resolveLocalSessionWorkspaceRoot(params: {
  sessionKey: string;
  agentId?: string;
}): string | undefined {
  const loaded = loadSessionFileRoot(params);
  return loaded.entry?.execNode ? undefined : loaded.root;
}

function resolveSessionFileCandidates(params: {
  root: string;
  fileRoot: string | undefined;
  filePath: string;
}): string[] {
  return [
    resolveTouchedFilePath(params),
    resolveWorkspacePath(params.root, params.filePath),
  ].filter((candidate, index, all): candidate is string => {
    return candidate !== undefined && all.indexOf(candidate) === index;
  });
}

async function toBrowserEntry(
  browserPath: string,
  dirent: WorkspaceDirEntry,
  relevance: ReadonlyMap<string, SessionFileRelevance>,
): Promise<SessionFileBrowserEntry | undefined> {
  const statKind = workspaceStatKind(dirent);
  const kind = statKind === "directory" ? "directory" : statKind === "file" ? "file" : null;
  if (!kind) {
    return undefined;
  }
  const sessionKind = relevanceForBrowserPath(browserPath, kind, relevance);
  return {
    path: browserPath,
    name: dirent.name,
    kind,
    ...(kind === "file" ? { size: dirent.size } : {}),
    updatedAtMs: toUpdatedAtMs(dirent.mtimeMs),
    ...(sessionKind ? { sessionKind } : {}),
  };
}

function matchesSearch(entryPath: string, name: string, query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  return (
    name.toLowerCase().includes(normalizedQuery) ||
    entryPath.toLowerCase().includes(normalizedQuery)
  );
}

async function searchBrowserEntries(params: {
  root: string;
  query: string;
  relevance: ReadonlyMap<string, SessionFileRelevance>;
}): Promise<{ entries: SessionFileBrowserEntry[]; truncated?: boolean }> {
  const entries: SessionFileBrowserEntry[] = [];
  let visitedEntries = 0;
  let truncated = false;
  const shouldStop = (): boolean => {
    if (entries.length >= MAX_SEARCH_ENTRIES || visitedEntries >= MAX_SEARCH_VISITED_ENTRIES) {
      truncated = true;
      return true;
    }
    return false;
  };
  const visit = async (dir: string): Promise<void> => {
    if (shouldStop()) {
      return;
    }
    const dirents = await listWorkspacePath(params.root, dir);
    if (!dirents) {
      return;
    }
    for (const dirent of sortDirents(dirents)) {
      if (shouldStop()) {
        return;
      }
      visitedEntries += 1;
      const browserPath = dir ? `${dir}/${dirent.name}` : dirent.name;
      if (matchesSearch(browserPath, dirent.name, params.query)) {
        const entry = await toBrowserEntry(browserPath, dirent, params.relevance);
        if (entry) {
          entries.push(entry);
        }
      }
      if (workspaceStatKind(dirent) === "directory" && !SEARCH_SKIP_DIRS.has(dirent.name)) {
        await visit(browserPath);
      }
    }
  };
  await visit("");
  return { entries: sortWorkspaceEntries(entries), ...(truncated ? { truncated } : {}) };
}

async function buildBrowserResult(params: {
  root: string | undefined;
  fileRoot: string | undefined;
  path?: string;
  search?: string;
  files: readonly TouchedFile[];
}): Promise<SessionFileBrowserResult | undefined> {
  if (!params.root) {
    return undefined;
  }
  const search = normalizeOptionalString(params.search);
  const relevance = buildSessionRelevanceMap(params.files, params.root, params.fileRoot);
  if (search) {
    const result = await searchBrowserEntries({
      root: params.root,
      query: search,
      relevance,
    });
    return {
      path: "",
      search,
      entries: result.entries,
      ...(result.truncated ? { truncated: result.truncated } : {}),
    };
  }
  const browserPath = normalizeRelativePath(params.path);
  const resolved = resolveWorkspacePath(params.root, browserPath);
  if (!resolved) {
    return undefined;
  }
  const stat = await statWorkspacePath(params.root, browserPath);
  if (!stat || workspaceStatKind(stat) !== "directory") {
    return undefined;
  }
  const dirents = await listWorkspacePath(params.root, browserPath);
  if (!dirents) {
    return undefined;
  }
  const entries = (
    await Promise.all(
      sortDirents(dirents)
        .slice(0, MAX_BROWSER_ENTRIES + 1)
        .map((dirent) => {
          const entryPath = browserPath ? `${browserPath}/${dirent.name}` : dirent.name;
          return toBrowserEntry(entryPath, dirent, relevance);
        }),
    )
  ).filter((entry): entry is SessionFileBrowserEntry => Boolean(entry));
  const parent = path.dirname(browserPath);
  return {
    path: browserPath,
    ...(browserPath ? { parentPath: parent === "." ? "" : parent } : {}),
    entries: sortWorkspaceEntries(entries.slice(0, MAX_BROWSER_ENTRIES)),
    ...(entries.length > MAX_BROWSER_ENTRIES ? { truncated: true } : {}),
  };
}

async function loadSessionFiles(params: {
  sessionKey: string;
  agentId?: string;
}): Promise<LoadedSessionFiles> {
  const loaded = loadSessionFileRoot(params);
  const { storePath, entry, canonicalKey, agentId } = loaded;
  if (!entry?.sessionId || !storePath || !agentId) {
    return { files: [] };
  }
  const scope = {
    agentId,
    sessionEntry: entry,
    sessionId: entry.sessionId,
    sessionKey: canonicalKey,
    storePath,
  } satisfies SessionTranscriptReadScope;
  const target = resolveTranscriptReadTarget(scope);
  // Entry-scoped reads without an explicit sessionFile always resolve to a canonical SQLite marker.
  // Legacy transcript files are doctor-owned migration debt, not a runtime read path.
  const files = await loadSqliteTouchedFiles(
    toTranscriptReadScope(target),
    `${agentId}\0${entry.sessionId}\0${target.storePath ?? ""}`,
  );
  return {
    root: loaded.root,
    fileRoot: loaded.fileRoot,
    diffCwd: loaded.diffCwd,
    files: [...files.values()].toSorted((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "modified" ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    }),
  };
}

async function buildListResult(params: {
  sessionKey: string;
  agentId?: string;
  path?: string;
  search?: string;
}): Promise<{
  root?: string;
  gitCheckout?: boolean;
  files: SessionFileEntry[];
  browser?: SessionFileBrowserResult;
}> {
  const loaded = await loadSessionFiles(params);
  const root = loaded.root;
  let gitCheckout: boolean | undefined;
  if (loaded.diffCwd) {
    try {
      const result = await runGit(loaded.diffCwd, ["rev-parse", "--show-toplevel"]);
      gitCheckout = result.code === 0 && Boolean(result.stdout.trim());
    } catch {
      gitCheckout = false;
    }
  }
  const workspaceFiles = root
    ? loaded.files.filter((file) =>
        Boolean(resolveTouchedFilePath({ root, fileRoot: loaded.fileRoot, filePath: file.path })),
      )
    : loaded.files;
  const files = await Promise.all(
    workspaceFiles.map((file) => toSessionFileEntry(file, loaded.root, loaded.fileRoot)),
  );
  const browser = await buildBrowserResult({
    root,
    fileRoot: loaded.fileRoot,
    path: params.path,
    search: params.search,
    files: workspaceFiles,
  });
  return {
    ...(root ? { root } : {}),
    ...(gitCheckout === undefined ? {} : { gitCheckout }),
    files,
    ...(browser ? { browser } : {}),
  };
}

async function findSessionFile(
  params: SessionsFilesGetParams,
): Promise<{ root?: string; file?: SessionFileEntry }> {
  const loaded = await loadSessionFiles(params);
  const exactTouched = loaded.files.find((file) => file.path === params.path);
  if (exactTouched) {
    return {
      ...(loaded.root ? { root: loaded.root } : {}),
      file: await toSessionFileEntry(exactTouched, loaded.root, loaded.fileRoot, {
        includeContent: true,
      }),
    };
  }
  if (!loaded.root) {
    return {};
  }
  // Any in-root file is previewable; fs-safe root enforces containment, symlink/hardlink
  // rejection, and the 256 KB cap.
  const candidates = resolveSessionFileCandidates({
    root: loaded.root,
    fileRoot: loaded.fileRoot,
    filePath: params.path,
  });
  if (candidates.length === 0) {
    return { root: loaded.root };
  }
  const relevance = buildSessionRelevanceMap(loaded.files, loaded.root, loaded.fileRoot);
  for (const candidate of candidates) {
    const browserPath = toDisplayPath(loaded.root, candidate);
    const sessionKind = relevance.get(browserPath);
    const touched: TouchedFile = {
      path: browserPath,
      kind: sessionKind === "modified" ? "modified" : "read",
    };
    const file = await toSessionFileEntry(touched, loaded.root, loaded.root, {
      includeContent: true,
    });
    if (!file.missing) {
      return { root: loaded.root, file };
    }
  }
  return { root: loaded.root };
}

function respondSessionFileNotFound(respond: RespondFn, filePath: string) {
  respond(
    false,
    undefined,
    sessionFilesError("session_file_not_found", "session file not found", { path: filePath }),
  );
}

function respondSessionFileTooLarge(respond: RespondFn, file: SessionFileEntry, filePath: string) {
  respond(
    false,
    undefined,
    sessionFilesError("session_file_too_large", "session file is too large to preview", {
      maxPreviewBytes: MAX_PREVIEW_BYTES,
      path: file.path || filePath,
      size: file.size,
    }),
  );
}

function respondSessionFileUnsafe(respond: RespondFn, filePath: string) {
  respond(
    false,
    undefined,
    sessionFilesError("session_file_unsafe", "session file could not be written safely", {
      path: filePath,
    }),
  );
}

function requireSessionFilesAgentId(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  respond: RespondFn;
}): string | undefined {
  const requestedAgent = resolveRequestedSessionAgentId(
    params.cfg,
    params.sessionKey,
    params.agentId,
  );
  if (!requestedAgent.ok) {
    params.respond(false, undefined, requestedAgent.error);
    return undefined;
  }
  return requestedAgent.agentId;
}

/** Gateway handlers for session files and workspace browsing. */
export const sessionsFilesHandlers: GatewayRequestHandlers = {
  "sessions.files.list": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateSessionsFilesListParams, "sessions.files.list", respond)
    ) {
      return;
    }
    const agentId = requireSessionFilesAgentId({
      cfg: context.getRuntimeConfig(),
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!agentId) {
      return;
    }
    const result = await buildListResult({ ...params, agentId });
    respond(true, {
      sessionKey: params.sessionKey,
      ...result,
    });
  },
  "sessions.files.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsFilesGetParams, "sessions.files.get", respond)) {
      return;
    }
    const agentId = requireSessionFilesAgentId({
      cfg: context.getRuntimeConfig(),
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!agentId) {
      return;
    }
    const result = await findSessionFile({ ...params, agentId });
    if (!result.file || result.file.missing) {
      respondSessionFileNotFound(respond, params.path);
      return;
    }
    if (typeof result.file.content !== "string" && result.file.previewKind !== "unsupported") {
      respondSessionFileTooLarge(respond, result.file, params.path);
      return;
    }
    respond(true, {
      sessionKey: params.sessionKey,
      ...result,
    });
  },
  "sessions.files.set": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsFilesSetParams, "sessions.files.set", respond)) {
      return;
    }
    const agentId = requireSessionFilesAgentId({
      cfg: context.getRuntimeConfig(),
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!agentId) {
      return;
    }
    // NUL bytes would make the written file fail decodeUtf8Strict on the next
    // read, stranding it without a CAS hash; reject them up front so the API
    // never writes content its own editability checks classify as binary.
    if (params.content.includes("\0")) {
      respondSessionFileUnsafe(respond, params.path);
      return;
    }
    const contentSize = Buffer.byteLength(params.content, "utf8");
    if (contentSize > MAX_PREVIEW_BYTES) {
      respond(
        false,
        undefined,
        sessionFilesError("session_file_too_large", "session file content is too large", {
          maxPreviewBytes: MAX_PREVIEW_BYTES,
          path: params.path,
          size: contentSize,
        }),
      );
      return;
    }
    const contentBuffer = Buffer.from(params.content, "utf8");
    // Node replaces lone UTF-16 surrogates while encoding. Reject them instead
    // of reporting a hash for bytes that no longer match the submitted text.
    if (contentBuffer.toString("utf8") !== params.content) {
      respondSessionFileUnsafe(respond, params.path);
      return;
    }
    const loaded = loadSessionFileRoot({ ...params, agentId });
    if (!loaded.root) {
      respondSessionFileNotFound(respond, params.path);
      return;
    }
    const candidates = resolveSessionFileCandidates({
      root: loaded.root,
      fileRoot: loaded.fileRoot,
      filePath: params.path,
    });
    let browserPath: string | undefined;
    for (const candidate of candidates) {
      const candidatePath = toDisplayPath(loaded.root, candidate);
      const stat = await statWorkspacePath(loaded.root, candidatePath);
      if (stat && workspaceStatKind(stat) === "file") {
        browserPath = candidatePath;
        break;
      }
    }
    if (!browserPath) {
      respondSessionFileNotFound(respond, params.path);
      return;
    }
    let update: WorkspaceFileUpdateResult;
    // The resolved root belongs to the authorized instance. Recheck after all async path
    // discovery so a replacement cannot redirect this write to its workspace.
    sessionMutationAuthorization?.assertCurrent();
    try {
      update = await updateWorkspaceFile(
        loaded.root,
        browserPath,
        params.content,
        params.expectedHash,
      );
    } catch (err) {
      if (!(err instanceof FsSafeError)) {
        throw err;
      }
      respondSessionFileUnsafe(respond, params.path);
      return;
    }
    if (update.status === "conflict") {
      respond(
        false,
        undefined,
        sessionFilesError("session_file_conflict", "session file changed since it was read", {
          path: params.path,
          currentHash: update.currentHash,
        }),
      );
      return;
    }
    if (update.status === "unsafe") {
      respondSessionFileUnsafe(respond, params.path);
      return;
    }
    respond(true, {
      sessionKey: params.sessionKey,
      root: loaded.root,
      file: {
        path: params.path,
        workspacePath: update.canonicalPath,
        name: displayNameForPath(update.canonicalPath),
        kind: "modified",
        missing: false,
        size: update.stat.size,
        updatedAtMs: toUpdatedAtMs(update.stat.mtimeMs),
        hash: update.hash,
      },
    });
  },
  "sessions.files.reveal": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsFilesRevealParams,
        "sessions.files.reveal",
        respond,
      )
    ) {
      return;
    }
    const agentId = requireSessionFilesAgentId({
      cfg: context.getRuntimeConfig(),
      sessionKey: params.key,
      agentId: params.agentId,
      respond,
    });
    if (!agentId) {
      return;
    }
    const loaded = loadSessionFileRoot({ sessionKey: params.key, agentId });
    const workspaceRoot = loaded.root;
    if (!workspaceRoot) {
      respond(true, {
        ok: false,
        error: "No workspace root is available for this session.",
      });
      return;
    }
    if (loaded.entry?.execNode) {
      respond(true, {
        ok: false,
        path: workspaceRoot,
        error: "Cannot reveal this workspace because the session runs on an exec node.",
      });
      return;
    }
    const placement = loaded.entry?.sessionId
      ? context.workerSessionPlacementService
          ?.getMany([loaded.entry.sessionId])
          .get(loaded.entry.sessionId)
      : undefined;
    if (isCloudWorkerPlacementState(placement?.state)) {
      respond(true, {
        ok: false,
        path: workspaceRoot,
        error: `Cannot reveal this workspace because the session runs remotely (${placement.state}).`,
      });
      return;
    }
    try {
      await execOpenPath(resolveOpenPathCommand(workspaceRoot));
      respond(true, { ok: true, path: workspaceRoot });
    } catch (error) {
      const errorMessage = formatOpenPathError(error);
      const detailedError = isHeadlessOpenPathError(errorMessage)
        ? `Cannot open path in headless environment. Path: ${workspaceRoot}. This environment appears to lack a graphical or terminal browser handler.`
        : `Failed to reveal session workspace: ${errorMessage}`;
      context.logGateway.warn(
        `sessions.files.reveal failed path=${sanitizePathForLog(workspaceRoot)}: ${errorMessage}`,
      );
      respond(true, { ok: false, path: workspaceRoot, error: detailedError });
    }
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
