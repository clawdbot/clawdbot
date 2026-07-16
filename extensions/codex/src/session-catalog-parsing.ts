import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CodexThread, CodexThreadTurnsListResponse } from "./app-server/protocol.js";
import { CODEX_INTERACTIVE_THREAD_SOURCE_KINDS } from "./app-server/protocol.js";
import type {
  CodexSessionCatalogError,
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
  CodexSessionCatalogParams,
  CodexSessionCatalogSession,
} from "./session-catalog-types.js";

const DEFAULT_PAGE_LIMIT = 50;
export const CODEX_APP_SERVER_THREADS_CAPABILITY = "codex-app-server-threads";
export const CODEX_APP_SERVER_THREADS_LIST_COMMAND = "codex.appServer.threads.list.v1";
export const CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND = "codex.appServer.thread.turns.list.v1";
export const CODEX_LOCAL_SESSION_HOST_ID = "gateway:local";
export const CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT = 100;
// Cold Codex state scans can outlive the Mac node's native 60-second deadline.
export const NODE_INVOKE_TIMEOUT_MS = 65_000;
const MAX_SEARCH_LENGTH = 500;
export const MAX_CURSOR_LENGTH = 4096;
const MAX_CURSOR_COUNT = 100;
export const MAX_HOST_COUNT = 100;
const MAX_HOST_ID_LENGTH = 256;
const MAX_CWD_LENGTH = 4096;
export const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSION_NAME_LENGTH = 500;
const MAX_SESSION_KEY_LENGTH = 1024;
const MAX_METADATA_LENGTH = 500;
const MAX_ACTIVE_FLAGS = 16;
export const MAX_ACTION_CATALOG_PAGES = 100;
export const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 20;
export const MAX_TRANSCRIPT_PAGE_LIMIT = 50;
const MAX_TRANSCRIPT_PAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TITLE_SEARCH_CATALOG_PAGES = 20;

export class CatalogParamsError extends Error {}

export function readControlCursor(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CURSOR_LENGTH) {
    throw new CatalogParamsError(`invalid Codex session catalog ${label} cursor`);
  }
  return value;
}

export function boundedCatalogString(
  value: unknown,
  maxLength: number,
  overflow: "omit" | "truncate" = "omit",
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return overflow === "truncate" ? truncateUtf16Safe(normalized, maxLength) : undefined;
}

type CodexInteractiveThreadSourceKind = (typeof CODEX_INTERACTIVE_THREAD_SOURCE_KINDS)[number];

export function isInteractiveThreadSource(
  source: unknown,
): source is CodexInteractiveThreadSourceKind {
  return CODEX_INTERACTIVE_THREAD_SOURCE_KINDS.some((kind) => kind === source);
}

export function toCatalogSession(
  thread: CodexThread,
  archived: boolean,
): CodexSessionCatalogSession | undefined {
  const source = thread.source;
  if (!isInteractiveThreadSource(source)) {
    return undefined;
  }
  const record = thread as CodexThread & Record<string, unknown>;
  const threadId = boundedCatalogString(thread.id, MAX_SESSION_ID_LENGTH);
  if (!threadId) {
    return undefined;
  }
  const activeFlags =
    thread.status?.type === "active"
      ? thread.status.activeFlags
          ?.flatMap((flag) => {
            const normalized = boundedCatalogString(flag, 128);
            return normalized ? [normalized] : [];
          })
          .slice(0, MAX_ACTIVE_FLAGS)
      : undefined;
  const gitInfo = isRecord(record.gitInfo) ? record.gitInfo : undefined;
  const sessionId = boundedCatalogString(thread.sessionId, MAX_SESSION_ID_LENGTH);
  const name = boundedCatalogString(thread.name, MAX_SESSION_NAME_LENGTH, "truncate");
  const cwd = boundedCatalogString(thread.cwd, MAX_CWD_LENGTH);
  const modelProvider = boundedCatalogString(record.modelProvider, MAX_METADATA_LENGTH, "truncate");
  const cliVersion = boundedCatalogString(record.cliVersion, MAX_METADATA_LENGTH, "truncate");
  const gitBranch = boundedCatalogString(gitInfo?.branch, MAX_METADATA_LENGTH, "truncate");
  return {
    threadId,
    status: thread.status?.type ?? "notLoaded",
    archived,
    ...(sessionId ? { sessionId } : {}),
    ...(thread.name === null ? { name: null } : name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
    ...(activeFlags?.length ? { activeFlags } : {}),
    ...(typeof thread.createdAt === "number" && Number.isFinite(thread.createdAt)
      ? { createdAt: thread.createdAt }
      : {}),
    ...(typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
      ? { updatedAt: thread.updatedAt }
      : {}),
    ...(typeof record.recencyAt === "number" && Number.isFinite(record.recencyAt)
      ? { recencyAt: record.recencyAt }
      : record.recencyAt === null
        ? { recencyAt: null }
        : {}),
    source,
    ...(modelProvider ? { modelProvider } : {}),
    ...(cliVersion ? { cliVersion } : {}),
    ...(gitBranch ? { gitBranch } : {}),
  };
}

export function normalizeLimit(value: unknown, key: string): number {
  if (value === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT
  ) {
    throw new CatalogParamsError(
      `${key} must be an integer from 1 to ${CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT}`,
    );
  }
  return value as number;
}

export function readOptionalString(
  params: Record<string, unknown>,
  key: string,
  maxLength: number,
) {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CatalogParamsError(`${key} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new CatalogParamsError(`${key} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function requireOnlyKeys(
  params: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(params).find((key) => !allowed.has(key));
  if (unknown) {
    throw new CatalogParamsError(`unknown Codex session catalog parameter: ${unknown}`);
  }
}

export function readPageParams(value: unknown): CodexSessionCatalogPageParams {
  if (!isRecord(value)) {
    throw new CatalogParamsError("Codex session catalog parameters must be an object");
  }
  const params = value;
  requireOnlyKeys(params, new Set(["cursor", "limit", "searchTerm", "cwd"]));
  const cursor = readOptionalString(params, "cursor", MAX_CURSOR_LENGTH);
  const searchTerm = readOptionalString(params, "searchTerm", MAX_SEARCH_LENGTH);
  const cwd = readOptionalString(params, "cwd", MAX_CWD_LENGTH);
  return {
    limit: normalizeLimit(params.limit, "limit"),
    ...(cursor ? { cursor } : {}),
    ...(searchTerm ? { searchTerm } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

export function readGatewayParams(value: unknown): CodexSessionCatalogParams {
  if (value !== undefined && !isRecord(value)) {
    throw new CatalogParamsError("Codex session catalog parameters must be an object");
  }
  const params = isRecord(value) ? value : {};
  requireOnlyKeys(params, new Set(["search", "limitPerHost", "hostIds", "cursors"]));
  const search = readOptionalString(params, "search", MAX_SEARCH_LENGTH);
  let hostIds: string[] | undefined;
  if (params.hostIds !== undefined) {
    if (!Array.isArray(params.hostIds) || params.hostIds.length > MAX_HOST_COUNT) {
      throw new CatalogParamsError(`hostIds must contain at most ${MAX_HOST_COUNT} host ids`);
    }
    hostIds = [...new Set(params.hostIds.map((hostId) => readHostId(hostId)))];
  }
  let cursors: Record<string, string> | undefined;
  if (params.cursors !== undefined) {
    if (!isRecord(params.cursors)) {
      throw new CatalogParamsError("cursors must be an object");
    }
    const entries = Object.entries(params.cursors);
    if (entries.length > MAX_CURSOR_COUNT) {
      throw new CatalogParamsError(`cursors may contain at most ${MAX_CURSOR_COUNT} hosts`);
    }
    cursors = {};
    for (const [hostId, cursor] of entries) {
      const normalizedHostId = hostId.trim();
      if (
        normalizedHostId.length === 0 ||
        normalizedHostId.length > MAX_HOST_ID_LENGTH ||
        (!normalizedHostId.startsWith("gateway:") && !normalizedHostId.startsWith("node:"))
      ) {
        throw new CatalogParamsError(`invalid Codex session catalog host id: ${hostId}`);
      }
      if (
        typeof cursor !== "string" ||
        !cursor.trim() ||
        cursor.trim().length > MAX_CURSOR_LENGTH
      ) {
        throw new CatalogParamsError(`invalid cursor for Codex session catalog host: ${hostId}`);
      }
      cursors[normalizedHostId] = cursor.trim();
    }
  }
  return {
    limitPerHost: normalizeLimit(params.limitPerHost, "limitPerHost"),
    ...(search ? { search } : {}),
    ...(hostIds && hostIds.length > 0 ? { hostIds } : {}),
    ...(cursors && Object.keys(cursors).length > 0 ? { cursors } : {}),
  };
}

function readHostId(value: unknown): string {
  if (typeof value !== "string") {
    throw new CatalogParamsError("Codex session catalog host ids must be strings");
  }
  const hostId = value.trim();
  if (
    hostId.length === 0 ||
    hostId.length > MAX_HOST_ID_LENGTH ||
    (!hostId.startsWith("gateway:") && !hostId.startsWith("node:"))
  ) {
    throw new CatalogParamsError(`invalid Codex session catalog host id: ${value}`);
  }
  return hostId;
}

export function parseJsonParams(paramsJSON?: string | null): unknown {
  if (!paramsJSON?.trim()) {
    return {};
  }
  try {
    return JSON.parse(paramsJSON) as unknown;
  } catch (error) {
    throw new Error("Codex session catalog parameters must be valid JSON", { cause: error });
  }
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOptionalCatalogString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`Codex session catalog returned an invalid ${field}`);
  }
  return value;
}

function parseCatalogSession(
  value: unknown,
  options: { allowOpenClawSessionKey?: boolean } = {},
): CodexSessionCatalogSession {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    !value.threadId.trim() ||
    value.threadId.length > MAX_SESSION_ID_LENGTH ||
    value.archived !== false
  ) {
    throw new Error("Codex session catalog returned an invalid session");
  }
  const status = parseOptionalCatalogString(value.status, "status", 64);
  if (!status?.trim()) {
    throw new Error("Codex session catalog returned an invalid status");
  }
  if (value.activeFlags !== undefined && !Array.isArray(value.activeFlags)) {
    throw new Error("Codex session catalog returned invalid active flags");
  }
  if (Array.isArray(value.activeFlags) && value.activeFlags.length > MAX_ACTIVE_FLAGS) {
    throw new Error("Codex session catalog returned too many active flags");
  }
  const activeFlags = Array.isArray(value.activeFlags)
    ? value.activeFlags.map((entry) => {
        const flag = parseOptionalCatalogString(entry, "active flag", 128);
        if (flag === undefined) {
          throw new Error("Codex session catalog returned an invalid active flag");
        }
        return flag;
      })
    : undefined;
  const sessionId = parseOptionalCatalogString(
    value.sessionId,
    "session id",
    MAX_SESSION_ID_LENGTH,
  );
  const name =
    value.name === null
      ? null
      : parseOptionalCatalogString(value.name, "session name", MAX_SESSION_NAME_LENGTH);
  const cwd = parseOptionalCatalogString(value.cwd, "cwd", MAX_CWD_LENGTH);
  const source = parseOptionalCatalogString(value.source, "source", MAX_METADATA_LENGTH);
  const modelProvider = parseOptionalCatalogString(
    value.modelProvider,
    "model provider",
    MAX_METADATA_LENGTH,
  );
  const cliVersion = parseOptionalCatalogString(
    value.cliVersion,
    "CLI version",
    MAX_METADATA_LENGTH,
  );
  const gitBranch = parseOptionalCatalogString(value.gitBranch, "Git branch", MAX_METADATA_LENGTH);
  const openClawSessionKey = options.allowOpenClawSessionKey
    ? parseOptionalCatalogString(
        value.openClawSessionKey,
        "OpenClaw session key",
        MAX_SESSION_KEY_LENGTH,
      )
    : undefined;
  const createdAt = readFiniteNumber(value.createdAt);
  const updatedAt = readFiniteNumber(value.updatedAt);
  const recencyAt = value.recencyAt === null ? null : readFiniteNumber(value.recencyAt);
  return {
    threadId: value.threadId,
    status,
    archived: value.archived,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(activeFlags && activeFlags.length > 0 ? { activeFlags } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(recencyAt !== undefined ? { recencyAt } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    ...(cliVersion !== undefined ? { cliVersion } : {}),
    ...(gitBranch !== undefined ? { gitBranch } : {}),
    ...(openClawSessionKey !== undefined ? { openClawSessionKey } : {}),
  };
}

export function parseCatalogPage(
  value: unknown,
  options: { allowOpenClawSessionKey?: boolean } = {},
): CodexSessionCatalogPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT
  ) {
    throw new Error("Codex session catalog returned an invalid page");
  }
  const nextCursor = parseOptionalCatalogString(value.nextCursor, "next cursor", MAX_CURSOR_LENGTH);
  const backwardsCursor = parseOptionalCatalogString(
    value.backwardsCursor,
    "backwards cursor",
    MAX_CURSOR_LENGTH,
  );
  return {
    sessions: value.sessions.map((session) => parseCatalogSession(session, options)),
    ...(nextCursor ? { nextCursor } : {}),
    ...(backwardsCursor ? { backwardsCursor } : {}),
  };
}

export function filterCatalogPageByTitle(
  page: CodexSessionCatalogPage,
  searchTerm: string | undefined,
): CodexSessionCatalogPage {
  if (!searchTerm) {
    return page;
  }
  return {
    ...page,
    sessions: page.sessions.filter((session) =>
      session.name?.toLocaleLowerCase().includes(searchTerm.toLocaleLowerCase()),
    ),
  };
}

export function unwrapNodeInvokePayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (typeof value.payloadJSON === "string" && value.payloadJSON.trim()) {
    try {
      return JSON.parse(value.payloadJSON) as unknown;
    } catch (error) {
      throw new Error("Codex node returned malformed session catalog JSON", { cause: error });
    }
  }
  return "payload" in value ? value.payload : value;
}

function catalogErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim();
  }
  if (typeof error === "string") {
    return error.trim();
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message.trim() : "";
  }
  return "";
}

export function catalogError(code: string, error: unknown): CodexSessionCatalogError {
  const messages: Record<string, string> = {
    APP_SERVER_UNAVAILABLE: "Codex app-server is unavailable on this host",
    NODE_INVOKE_FAILED: "The paired node could not return its Codex session catalog",
    NODE_LIST_FAILED: "Paired nodes could not be listed",
  };
  const summary = messages[code] ?? "Codex session catalog request failed";
  // Node-list failures are operator diagnostics from the local Gateway. Other
  // catalog errors may cross node/App Server boundaries and keep their bounded summary.
  const detail = code === "NODE_LIST_FAILED" ? catalogErrorDetail(error) : "";
  return { code, message: detail && detail !== summary ? `${summary}: ${detail}` : summary };
}

export function parseTranscriptPage(value: unknown): CodexThreadTurnsListResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length > MAX_TRANSCRIPT_PAGE_LIMIT ||
    value.data.some(
      (turn) =>
        !isRecord(turn) || !Array.isArray(turn.items) || turn.items.some((item) => !isRecord(item)),
    )
  ) {
    throw new Error("Codex app-server returned an invalid transcript page");
  }
  const nextCursor = readControlCursor(value.nextCursor, "transcript next response");
  const backwardsCursor = readControlCursor(value.backwardsCursor, "transcript backwards response");
  const page: CodexThreadTurnsListResponse = {
    data: value.data as CodexThreadTurnsListResponse["data"],
    ...(nextCursor ? { nextCursor } : {}),
    ...(backwardsCursor ? { backwardsCursor } : {}),
  };
  // A bounded item count does not bound tool output embedded in one item. Keep
  // the page below node.invoke and Gateway WebSocket payload ceilings.
  if (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_TRANSCRIPT_PAGE_BYTES) {
    throw new Error("Codex app-server transcript page exceeds the safe response size");
  }
  return page;
}

// Local adoptions always record a bound thread; a missing one means binding
// resolution failed, so fail loud rather than baseline the wrong source thread.
export function requireBoundThread(entry: { boundThreadId?: string }): string {
  if (!entry.boundThreadId) {
    throw new CatalogParamsError("Codex adoption is missing its bound thread. Retry.");
  }
  return entry.boundThreadId;
}
