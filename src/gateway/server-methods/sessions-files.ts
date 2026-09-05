// Gateway methods expose session files and workspace browsing.
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  isCloudWorkerPlacementState,
  type SessionFileEntry,
  validateSessionsFilesRevealParams,
  validateSessionsFilesGetParams,
  validateSessionsFilesListParams,
  validateSessionsFilesSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
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
import { resolveSessionWorkspaceRoots } from "../session-workspace-roots.js";
import {
  execOpenPath,
  formatOpenPathError,
  isHeadlessOpenPathError,
  resolveOpenPathCommand,
  sanitizePathForLog,
} from "./open-path.js";
import { getRepositoryArtifact, listRepositoryArtifacts } from "./session-repository-artifacts.js";
import { resolveRepositoryWorkspaceAccess } from "./session-repository-workspace-access.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";
import {
  getSessionWorkspaceFile,
  listSessionWorkspaceFiles,
  setSessionWorkspaceFile,
  resolveFileRoot,
  type LoadedSessionFiles,
  type TouchedFile,
} from "./workspace-files.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "./workspace-fs.js";

type FileKind = TouchedFile["kind"];

type TouchedFilesCacheEntry = {
  cursor: string;
  files: Map<string, TouchedFile>;
};

const MAX_PREVIEW_BYTES = WORKSPACE_PREVIEW_MAX_BYTES;
// Control UI requests fan out per visible session; keep enough folds to avoid
// eviction and full-transcript reparsing across realistic concurrent viewers.
const TOUCHED_FILES_CACHE_LIMIT = 256;
const TOUCHED_FILES_DELTA_MAX_MESSAGES = 1_000;
const TOUCHED_FILES_DELTA_MAX_BYTES = 1_000_000;
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
  if (loaded.entry.repositoryWorkspaceId) {
    return { ...loaded, agentId, root: undefined, fileRoot: undefined, diffCwd: undefined };
  }
  const { spawnedCwd, root, diffCwd } = resolveSessionWorkspaceRoots(
    loaded.cfg,
    agentId,
    loaded.entry,
  );
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

async function loadSessionFiles(params: {
  sessionKey: string;
  agentId?: string;
  context: GatewayRequestContext;
}): Promise<
  LoadedSessionFiles & { repository?: ReturnType<typeof resolveRepositoryWorkspaceAccess> }
> {
  const loaded = loadSessionFileRoot(params);
  const { storePath, entry, canonicalKey, agentId } = loaded;
  if (!entry?.sessionId || !storePath || !agentId) {
    return { files: [] };
  }
  const repository = resolveRepositoryWorkspaceAccess(loaded, params.context);
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
    repository,
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
    const loaded = await loadSessionFiles({ ...params, agentId, context });
    const request = { files: loaded.files, path: params.path, search: params.search };
    const result =
      loaded.repository?.kind === "stored"
        ? await listRepositoryArtifacts(loaded.repository, request)
        : loaded.repository
          ? await loaded.repository.inspect("list", request)
          : await listSessionWorkspaceFiles({ ...loaded, ...request });
    respond(true, {
      sessionKey: params.sessionKey,
      ...result,
      ...(loaded.repository ? { root: undefined } : {}),
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
    const loaded = await loadSessionFiles({ ...params, agentId, context });
    const request = { files: loaded.files, path: params.path };
    const result =
      loaded.repository?.kind === "stored"
        ? await getRepositoryArtifact(loaded.repository, params.path)
        : loaded.repository
          ? await loaded.repository.inspect("get", request)
          : await getSessionWorkspaceFile({ ...loaded, ...request });
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
      ...(loaded.repository ? { root: undefined } : {}),
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
    const loaded = loadSessionFileRoot({ ...params, agentId });
    if (!loaded.agentId || !loaded.entry?.sessionId) {
      respondSessionFileNotFound(respond, params.path);
      return;
    }
    const repository = resolveRepositoryWorkspaceAccess(loaded, context);
    if (repository?.kind === "stored") {
      throw new Error("Start this cloud session before editing its repository files.");
    }
    const authorize = () => sessionMutationAuthorization?.assertCurrent();
    const update = repository
      ? await repository.inspect(
          "set",
          { path: params.path, content: params.content, expectedHash: params.expectedHash },
          authorize,
        )
      : await setSessionWorkspaceFile({
          ...params,
          root: loaded.root,
          fileRoot: loaded.fileRoot,
          assertCurrent: authorize,
        });
    if (update.status === "missing") {
      respondSessionFileNotFound(respond, params.path);
      return;
    }
    if (update.status === "too-large") {
      respond(
        false,
        undefined,
        sessionFilesError("session_file_too_large", "session file content is too large", {
          maxPreviewBytes: MAX_PREVIEW_BYTES,
          path: params.path,
          size: update.size,
        }),
      );
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
      ...(repository ? {} : { root: update.root }),
      file: update.file,
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
    if (loaded.entry?.repositoryWorkspaceId) {
      respond(true, {
        ok: false,
        error:
          "This repository exists only on the cloud session runner. Use the Files panel to browse it; there is no Gateway checkout to reveal.",
      });
      return;
    }
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
    const command = resolveOpenPathCommand(workspaceRoot);
    try {
      await execOpenPath(command);
      respond(true, { ok: true, path: workspaceRoot });
    } catch (error) {
      const errorMessage = formatOpenPathError(error);
      const detailedError = isHeadlessOpenPathError(error, command)
        ? `Cannot open path in headless environment. Path: ${workspaceRoot}. This environment appears to lack a graphical or terminal browser handler.`
        : `Failed to reveal session workspace: ${errorMessage}`;
      context.logGateway.warn(
        `sessions.files.reveal failed path=${sanitizePathForLog(workspaceRoot)}: ${errorMessage}`,
      );
      respond(true, { ok: false, path: workspaceRoot, error: detailedError });
    }
  },
};
