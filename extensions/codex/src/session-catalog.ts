import { createHash } from "node:crypto";
import {
  listAgentIds,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  readCodexPluginConfig,
  resolveCodexSupervisionAppServerRuntimeOptions,
} from "./app-server/config.js";
import { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import type {
  CodexThread,
  CodexThreadListParams,
  CodexThreadListResponse,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResponse,
} from "./app-server/protocol.js";
import { CODEX_INTERACTIVE_THREAD_SOURCE_KINDS } from "./app-server/protocol.js";
import { requestCodexAppServerClientJson } from "./app-server/request.js";
import {
  reclaimCurrentCodexSessionGeneration,
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerPendingSupervisionBranch,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";
import { assertCodexArchiveDescendantsUnowned } from "./app-server/thread-archive-guard.js";
import { importCodexThreadHistoryToTranscript } from "./app-server/transcript-mirror.js";
import { codexControlRequest } from "./command-rpc.js";
import type {
  CodexSessionCatalogError,
  CodexSessionCatalogHost,
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
  CodexSessionCatalogParams,
  CodexSessionCatalogResult,
  CodexSessionCatalogSession,
  CodexSessionTranscriptPage,
} from "./session-catalog-types.js";

export type {
  CodexSessionCatalogError,
  CodexSessionCatalogHost,
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
  CodexSessionCatalogParams,
  CodexSessionCatalogResult,
  CodexSessionCatalogSession,
  CodexSessionTranscriptPage,
} from "./session-catalog-types.js";

export const CODEX_APP_SERVER_THREADS_LIST_COMMAND = "codex.appServer.threads.list.v1";
export const CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND = "codex.appServer.thread.turns.list.v1";
export const CODEX_SESSION_CATALOG_METHOD = "codex.sessions.list";
export const CODEX_SESSION_READ_METHOD = "codex.sessions.read";
export const CODEX_SESSION_CONTINUE_METHOD = "codex.sessions.continue";
export const CODEX_SESSION_ARCHIVE_METHOD = "codex.sessions.archive";

const CODEX_APP_SERVER_THREADS_CAPABILITY = "codex-app-server-threads";
const DEFAULT_PAGE_LIMIT = 50;
export const CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT = 100;
// A node may need a cold Codex state scan before returning a large catalog page.
// Keep this above the Mac node's native 60-second deadline so its specific
// timeout wins instead of the less useful generic node.invoke timeout.
const NODE_INVOKE_TIMEOUT_MS = 65_000;
const MAX_SEARCH_LENGTH = 500;
const MAX_CURSOR_LENGTH = 4096;
const MAX_CURSOR_COUNT = 100;
const MAX_HOST_COUNT = 100;
const MAX_HOST_ID_LENGTH = 256;
const MAX_CWD_LENGTH = 4096;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSION_NAME_LENGTH = 500;
const MAX_SESSION_KEY_LENGTH = 1024;
const MAX_METADATA_LENGTH = 500;
const MAX_ACTIVE_FLAGS = 16;
const MAX_ACTION_CATALOG_PAGES = 100;
const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 20;
const MAX_TRANSCRIPT_PAGE_LIMIT = 50;
const MAX_TRANSCRIPT_PAGE_BYTES = 20 * 1024 * 1024;
const MAX_TITLE_SEARCH_CATALOG_PAGES = 20;
const CODEX_SUPERVISION_SESSION_KEY_PREFIX = "harness:codex:supervision:";

class CatalogParamsError extends Error {}

type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];

export const CODEX_LOCAL_SESSION_HOST_ID = "gateway:local";

export type CodexSessionCatalogControl = {
  assertEnabled(): void;
  connectionFingerprint?: string;
  withPinnedConnection<T>(run: (control: CodexSessionCatalogControl) => Promise<T>): Promise<T>;
  listPage(params: CodexSessionCatalogPageParams): Promise<CodexSessionCatalogPage>;
  listDescendantPage(params: CodexThreadListParams): Promise<CodexThreadListResponse>;
  listTurnPage(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
  readThread(threadId: string, includeTurns?: boolean): Promise<CodexThread>;
  archiveThread(threadId: string): Promise<void>;
};

function requireCodexSessionSupervisionEnabled(pluginConfig: unknown): void {
  if (readCodexPluginConfig(pluginConfig).supervision?.enabled !== true) {
    throw new Error("Codex session supervision is disabled");
  }
}

type CodexSessionCatalogRequestSnapshot = {
  requestTimeoutMs: number;
  listThreads(params: CodexThreadListParams, timeoutMs: number): Promise<CodexThreadListResponse>;
  listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
  readThread(threadId: string, includeTurns: boolean): Promise<CodexThread>;
  archiveThread(threadId: string): Promise<void>;
};

function createCodexSessionCatalogControlFromRequests(params: {
  assertEnabled: () => void;
  connectionFingerprint?: string;
  createRequestSnapshot: () => CodexSessionCatalogRequestSnapshot;
  now: () => number;
  withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"];
}): CodexSessionCatalogControl {
  return {
    assertEnabled: params.assertEnabled,
    ...(params.connectionFingerprint
      ? { connectionFingerprint: params.connectionFingerprint }
      : {}),
    withPinnedConnection: params.withPinnedConnection,
    async listPage(pageParams) {
      params.assertEnabled();
      const limit = normalizeLimit(pageParams.limit, "limit");
      // App Server search also matches transcript previews. Scan native pages
      // without that filter so this catalog remains a title-only surface.
      const search = pageParams.searchTerm?.trim().toLocaleLowerCase() || undefined;
      const cwd = pageParams.cwd?.trim() || undefined;
      const maxPages = search ? MAX_TITLE_SEARCH_CATALOG_PAGES : 1;
      const sessions: CodexSessionCatalogSession[] = [];
      let cursor = readControlCursor(pageParams.cursor, "request");
      let nextCursor: string | undefined;
      let backwardsCursor: string | undefined;
      const seenCursors = new Set(cursor ? [cursor] : []);
      const requests = params.createRequestSnapshot();
      const deadline = params.now() + requests.requestTimeoutMs;

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        params.assertEnabled();
        const remaining = limit - sessions.length;
        const remainingTimeoutMs = Math.ceil(deadline - params.now());
        if (remainingTimeoutMs <= 0) {
          throw new Error("Codex session catalog listing timed out");
        }
        const response = await requests.listThreads(
          {
            archived: false,
            limit: remaining,
            modelProviders: [],
            sortKey: "recency_at",
            sortDirection: "desc",
            sourceKinds: [...CODEX_INTERACTIVE_THREAD_SOURCE_KINDS],
            ...(cwd ? { cwd } : {}),
            ...(cursor ? { cursor } : {}),
          },
          remainingTimeoutMs,
        );
        params.assertEnabled();
        if (pageIndex === 0) {
          backwardsCursor = readControlCursor(response.backwardsCursor, "backwards response");
        }
        sessions.push(
          ...response.data
            .flatMap((thread) => {
              const session = toCatalogSession(thread, false);
              return session ? [session] : [];
            })
            .filter((session) => !search || session.name?.toLocaleLowerCase().includes(search)),
        );
        nextCursor = readControlCursor(response.nextCursor, "next response");
        if (!nextCursor || sessions.length >= limit) {
          break;
        }
        if (seenCursors.has(nextCursor)) {
          throw new Error("Codex session catalog returned a repeated search cursor");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      return {
        sessions,
        ...(nextCursor ? { nextCursor } : {}),
        ...(backwardsCursor ? { backwardsCursor } : {}),
      };
    },
    async listDescendantPage(listParams) {
      params.assertEnabled();
      const requests = params.createRequestSnapshot();
      const response = await requests.listThreads(listParams, requests.requestTimeoutMs);
      params.assertEnabled();
      return response;
    },
    async readThread(threadId, includeTurns = false) {
      params.assertEnabled();
      const thread = await params.createRequestSnapshot().readThread(threadId, includeTurns);
      params.assertEnabled();
      return thread;
    },
    async listTurnPage(listParams) {
      params.assertEnabled();
      const response = await params.createRequestSnapshot().listThreadTurns(listParams);
      params.assertEnabled();
      return response;
    },
    async archiveThread(threadId) {
      params.assertEnabled();
      await params.createRequestSnapshot().archiveThread(threadId);
      params.assertEnabled();
    },
  };
}

/** Builds the passive catalog over the Codex plugin's canonical shared client. */
export function createCodexSessionCatalogControl(params: {
  getPluginConfig: () => unknown;
  getRuntimeConfig: () => OpenClawConfig | undefined;
  now?: () => number;
}): CodexSessionCatalogControl {
  const now = params.now ?? Date.now;
  const requireEnabledPluginConfig = () => {
    const pluginConfig = params.getPluginConfig();
    requireCodexSessionSupervisionEnabled(pluginConfig);
    return pluginConfig;
  };
  const assertEnabled = () => void requireEnabledPluginConfig();
  const createRequestSnapshot = (): CodexSessionCatalogRequestSnapshot => {
    const pluginConfig = requireEnabledPluginConfig();
    const runtime = resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig });
    const requestOptions = {
      config: structuredClone(params.getRuntimeConfig()),
      startOptions: structuredClone(runtime.start),
    };
    return {
      requestTimeoutMs: runtime.requestTimeoutMs,
      listThreads: async (listParams, timeoutMs) =>
        await codexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listThreads, listParams, {
          ...requestOptions,
          timeoutMs,
        }),
      readThread: async (threadId, includeTurns) =>
        (
          await codexControlRequest(
            pluginConfig,
            CODEX_CONTROL_METHODS.readThread,
            { threadId, includeTurns },
            requestOptions,
          )
        ).thread,
      listThreadTurns: async (listParams) =>
        await codexControlRequest(
          pluginConfig,
          CODEX_CONTROL_METHODS.listThreadTurns,
          listParams,
          requestOptions,
        ),
      archiveThread: async (threadId) => {
        await codexControlRequest(
          pluginConfig,
          CODEX_CONTROL_METHODS.archiveThread,
          { threadId },
          requestOptions,
        );
      },
    };
  };

  const withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"] = async (run) => {
    const pluginConfig = requireEnabledPluginConfig();
    const runtime = resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig });
    const runtimeConfig = structuredClone(params.getRuntimeConfig());
    const startOptions = structuredClone(runtime.start);
    const client = await getLeasedSharedCodexAppServerClient({
      config: runtimeConfig,
      startOptions,
      timeoutMs: runtime.requestTimeoutMs,
    });
    try {
      const requests: CodexSessionCatalogRequestSnapshot = {
        requestTimeoutMs: runtime.requestTimeoutMs,
        listThreads: async (listParams, timeoutMs) =>
          await requestCodexAppServerClientJson<CodexThreadListResponse>({
            client,
            method: CODEX_CONTROL_METHODS.listThreads,
            requestParams: listParams,
            config: runtimeConfig,
            timeoutMs,
          }),
        readThread: async (threadId, includeTurns) =>
          (
            await requestCodexAppServerClientJson<{ thread: CodexThread }>({
              client,
              method: CODEX_CONTROL_METHODS.readThread,
              requestParams: { threadId, includeTurns },
              config: runtimeConfig,
              timeoutMs: runtime.requestTimeoutMs,
            })
          ).thread,
        listThreadTurns: async (listParams) =>
          await requestCodexAppServerClientJson<CodexThreadTurnsListResponse>({
            client,
            method: CODEX_CONTROL_METHODS.listThreadTurns,
            requestParams: listParams,
            config: runtimeConfig,
            timeoutMs: runtime.requestTimeoutMs,
          }),
        archiveThread: async (threadId) => {
          await requestCodexAppServerClientJson({
            client,
            method: CODEX_CONTROL_METHODS.archiveThread,
            requestParams: { threadId },
            config: runtimeConfig,
            timeoutMs: runtime.requestTimeoutMs,
          });
        },
      };
      const pinnedControl: CodexSessionCatalogControl =
        createCodexSessionCatalogControlFromRequests({
          assertEnabled,
          connectionFingerprint: buildCodexAppServerConnectionFingerprint(
            runtime,
            resolveDefaultAgentDir(runtimeConfig ?? {}),
          ),
          createRequestSnapshot: () => requests,
          now,
          withPinnedConnection: async (nestedRun) => await nestedRun(pinnedControl),
        });
      return await run(pinnedControl);
    } finally {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  };

  return createCodexSessionCatalogControlFromRequests({
    assertEnabled,
    createRequestSnapshot,
    now,
    withPinnedConnection,
  });
}

function readControlCursor(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CURSOR_LENGTH) {
    throw new CatalogParamsError(`invalid Codex session catalog ${label} cursor`);
  }
  return value;
}

function boundedCatalogString(
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

function isInteractiveThreadSource(
  source: CodexThread["source"],
): source is CodexInteractiveThreadSourceKind {
  return CODEX_INTERACTIVE_THREAD_SOURCE_KINDS.some((kind) => kind === source);
}

function toCatalogSession(
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

function normalizeLimit(value: unknown, key: string): number {
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

function readOptionalString(params: Record<string, unknown>, key: string, maxLength: number) {
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

function requireOnlyKeys(params: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(params).find((key) => !allowed.has(key));
  if (unknown) {
    throw new CatalogParamsError(`unknown Codex session catalog parameter: ${unknown}`);
  }
}

function readPageParams(value: unknown): CodexSessionCatalogPageParams {
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

function readGatewayParams(value: unknown): CodexSessionCatalogParams {
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

function parseJsonParams(paramsJSON?: string | null): unknown {
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

function parseCatalogError(value: unknown): CodexSessionCatalogError | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    return undefined;
  }
  const messages: Record<string, string> = {
    APP_SERVER_UNAVAILABLE: "Codex app-server is unavailable on this host",
    NODE_INVOKE_FAILED: "The paired node could not return its Codex session catalog",
    NODE_LIST_FAILED: "Paired nodes could not be listed",
    NODE_OFFLINE: "Paired node is offline",
  };
  return {
    code: value.code in messages ? value.code : "CATALOG_FAILED",
    message: messages[value.code] ?? "Codex session catalog request failed",
  };
}

function parseCatalogPage(
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

function filterCatalogPageByTitle(
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

function parseCatalogHost(value: unknown): CodexSessionCatalogHost {
  if (
    !isRecord(value) ||
    typeof value.hostId !== "string" ||
    typeof value.label !== "string" ||
    (value.kind !== "gateway" && value.kind !== "node") ||
    typeof value.connected !== "boolean" ||
    !Array.isArray(value.sessions)
  ) {
    throw new Error("Codex session catalog returned an invalid host");
  }
  const page = parseCatalogPage(value, { allowOpenClawSessionKey: value.kind === "gateway" });
  const error = parseCatalogError(value.error);
  return {
    hostId: value.hostId,
    label: value.label,
    kind: value.kind,
    connected: value.connected,
    sessions: page.sessions,
    ...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.backwardsCursor ? { backwardsCursor: page.backwardsCursor } : {}),
    ...(error ? { error } : {}),
  };
}

/** Validates and strips unknown fields from a Gateway catalog response. */
export function parseCodexSessionCatalogResult(value: unknown): CodexSessionCatalogResult {
  if (!isRecord(value) || !Array.isArray(value.hosts) || value.hosts.length > MAX_HOST_COUNT) {
    throw new Error("Codex session catalog returned an invalid result");
  }
  return { hosts: value.hosts.map(parseCatalogHost) };
}

function unwrapNodeInvokePayload(value: unknown): unknown {
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

function catalogError(code: string, _error: unknown): CodexSessionCatalogError {
  const messages: Record<string, string> = {
    APP_SERVER_UNAVAILABLE: "Codex app-server is unavailable on this host",
    NODE_INVOKE_FAILED: "The paired node could not return its Codex session catalog",
    NODE_LIST_FAILED: "Paired nodes could not be listed",
  };
  return { code, message: messages[code] ?? "Codex session catalog request failed" };
}

async function listGatewayHost(params: {
  bindingStore: CodexAppServerBindingStore;
  config?: OpenClawConfig;
  control: CodexSessionCatalogControl;
  query: CodexSessionCatalogParams;
  runtime: PluginRuntime;
}): Promise<CodexSessionCatalogHost> {
  try {
    const page = parseCatalogPage(
      await params.control.listPage({
        limit: params.query.limitPerHost,
        ...(params.query.cursors?.[CODEX_LOCAL_SESSION_HOST_ID]
          ? { cursor: params.query.cursors[CODEX_LOCAL_SESSION_HOST_ID] }
          : {}),
        ...(params.query.search ? { searchTerm: params.query.search } : {}),
      }),
    );
    const adoptedSessions = await listAdoptedSessionEntries({
      bindingStore: params.bindingStore,
      config: params.config,
      runtime: params.runtime,
    });
    return {
      hostId: CODEX_LOCAL_SESSION_HOST_ID,
      label: "Local Codex",
      kind: "gateway",
      connected: true,
      ...page,
      sessions: page.sessions.map((session) => {
        const adopted = adoptedSessions.get(session.threadId);
        return adopted ? Object.assign({}, session, { openClawSessionKey: adopted.key }) : session;
      }),
    };
  } catch (error) {
    return {
      hostId: CODEX_LOCAL_SESSION_HOST_ID,
      label: "Local Codex",
      kind: "gateway",
      connected: false,
      sessions: [],
      error: catalogError("APP_SERVER_UNAVAILABLE", error),
    };
  }
}

function nodeLabel(node: CatalogNode): string {
  return node.displayName?.trim() || node.remoteIp?.trim() || node.nodeId;
}

function compareNodeLabels(left: CatalogNode, right: CatalogNode): number {
  const leftLabel = nodeLabel(left);
  const rightLabel = nodeLabel(right);
  if (leftLabel < rightLabel) {
    return -1;
  }
  if (leftLabel > rightLabel) {
    return 1;
  }
  return 0;
}

async function listPairedNode(params: {
  runtime: PluginRuntime;
  node: CatalogNode;
  query: CodexSessionCatalogParams;
}): Promise<CodexSessionCatalogHost> {
  const hostId = `node:${params.node.nodeId}`;
  const common = {
    hostId,
    label: nodeLabel(params.node),
    kind: "node" as const,
    nodeId: params.node.nodeId,
  };
  if (params.node.connected !== true) {
    return {
      ...common,
      connected: false,
      sessions: [],
      error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
    };
  }
  try {
    const raw = await params.runtime.nodes.invoke({
      nodeId: params.node.nodeId,
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      params: {
        cursor: params.query.cursors?.[hostId],
        limit: params.query.limitPerHost,
        searchTerm: params.query.search,
      },
      timeoutMs: NODE_INVOKE_TIMEOUT_MS,
    });
    const page = filterCatalogPageByTitle(
      parseCatalogPage(unwrapNodeInvokePayload(raw)),
      params.query.search,
    );
    return {
      ...common,
      connected: true,
      ...page,
    };
  } catch (error) {
    return {
      ...common,
      connected: true,
      sessions: [],
      error: catalogError("NODE_INVOKE_FAILED", error),
    };
  }
}

/** Lists Gateway-local and paired-node Codex sessions with per-host failures. */
export async function listCodexSessionCatalog(params: {
  bindingStore: CodexAppServerBindingStore;
  config?: OpenClawConfig;
  runtime: PluginRuntime;
  control: CodexSessionCatalogControl;
  query?: CodexSessionCatalogParams;
}): Promise<CodexSessionCatalogResult> {
  params.control.assertEnabled();
  const query = readGatewayParams(params.query);
  const requestedHostIds = query.hostIds ? new Set(query.hostIds) : undefined;
  const localHosts =
    !requestedHostIds || requestedHostIds.has(CODEX_LOCAL_SESSION_HOST_ID)
      ? [
          listGatewayHost({
            bindingStore: params.bindingStore,
            config: params.config,
            control: params.control,
            query,
            runtime: params.runtime,
          }),
        ]
      : [];
  const wantsNodes =
    !requestedHostIds || query.hostIds?.some((hostId) => hostId.startsWith("node:"));
  if (!wantsNodes) {
    return { hosts: await Promise.all(localHosts) };
  }
  let nodes: CatalogNode[];
  try {
    nodes = (await params.runtime.nodes.list()).nodes
      .filter(
        (node) =>
          node.commands?.includes(CODEX_APP_SERVER_THREADS_LIST_COMMAND) &&
          (!requestedHostIds || requestedHostIds.has(`node:${node.nodeId}`)),
      )
      .slice(0, MAX_HOST_COUNT - localHosts.length);
  } catch (error) {
    return {
      hosts: [
        ...(await Promise.all(localHosts)),
        {
          hostId: "node:registry",
          label: "Paired nodes",
          kind: "node",
          connected: false,
          sessions: [],
          error: catalogError("NODE_LIST_FAILED", error),
        },
      ],
    };
  }
  const nodeHosts = nodes
    .toSorted(compareNodeLabels)
    .map((node) => listPairedNode({ runtime: params.runtime, node, query }));
  return { hosts: await Promise.all([...localHosts, ...nodeHosts]) };
}

/** Builds the node-local read-only Codex app-server catalog command. */
export function createCodexSessionCatalogNodeHostCommands(
  control: CodexSessionCatalogControl,
): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      cap: CODEX_APP_SERVER_THREADS_CAPABILITY,
      dangerous: false,
      handle: async (paramsJSON) => {
        const pageParams = readPageParams(parseJsonParams(paramsJSON));
        try {
          const page = filterCatalogPageByTitle(
            parseCatalogPage(await control.listPage(pageParams)),
            pageParams.searchTerm,
          );
          return JSON.stringify(page);
        } catch {
          // App-server stderr and transport details stay on the node boundary.
          throw new Error("Codex app-server catalog is unavailable");
        }
      },
    },
    {
      command: CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
      cap: CODEX_APP_SERVER_THREADS_CAPABILITY,
      dangerous: false,
      handle: async (paramsJSON) => {
        const action = readNodeTranscriptParams(parseJsonParams(paramsJSON));
        try {
          await requireCatalogEligibleThread(control, action.threadId);
          const page = parseTranscriptPage(
            await control.listTurnPage({
              threadId: action.threadId,
              limit: action.limit,
              sortDirection: "desc",
              itemsView: "full",
              ...(action.cursor ? { cursor: action.cursor } : {}),
            }),
          );
          return JSON.stringify(page);
        } catch (error) {
          if (error instanceof CatalogParamsError) {
            throw error;
          }
          throw new Error("Codex app-server transcript is unavailable", { cause: error });
        }
      },
    },
  ];
}

type CodexSessionActionParams = {
  hostId: string;
  threadId: string;
};

type CodexSessionTranscriptParams = CodexSessionActionParams & {
  cursor?: string;
  limit: number;
};

type CodexNodeSessionTranscriptParams = Omit<CodexSessionTranscriptParams, "hostId">;

function readActionParams(
  value: unknown,
  options: { archive?: boolean } = {},
): CodexSessionActionParams {
  if (!isRecord(value)) {
    throw new CatalogParamsError("Codex session action parameters must be an object");
  }
  requireOnlyKeys(
    value,
    new Set(
      options.archive ? ["hostId", "threadId", "confirmNoOtherRunner"] : ["hostId", "threadId"],
    ),
  );
  const hostId = readHostId(value.hostId);
  const threadId = readOptionalString(value, "threadId", MAX_SESSION_ID_LENGTH);
  if (!threadId) {
    throw new CatalogParamsError("threadId is required");
  }
  if (hostId !== CODEX_LOCAL_SESSION_HOST_ID) {
    throw new CatalogParamsError("paired-node Codex sessions are view-only");
  }
  if (options.archive && value.confirmNoOtherRunner !== true) {
    throw new CatalogParamsError(
      "confirmNoOtherRunner=true is required because Codex client and runner activity is process-local",
    );
  }
  return { hostId, threadId };
}

function readTranscriptParams(value: unknown): CodexSessionTranscriptParams {
  if (!isRecord(value)) {
    throw new CatalogParamsError("Codex session read parameters must be an object");
  }
  requireOnlyKeys(value, new Set(["hostId", "threadId", "cursor", "limit"]));
  const hostId = readHostId(value.hostId);
  const threadId = readOptionalString(value, "threadId", MAX_SESSION_ID_LENGTH);
  if (!threadId) {
    throw new CatalogParamsError("threadId is required");
  }
  const cursor = readOptionalString(value, "cursor", MAX_CURSOR_LENGTH);
  const limit = readBoundedLimit(
    value.limit,
    "limit",
    DEFAULT_TRANSCRIPT_PAGE_LIMIT,
    MAX_TRANSCRIPT_PAGE_LIMIT,
  );
  return { hostId, threadId, limit, ...(cursor ? { cursor } : {}) };
}

function readNodeTranscriptParams(value: unknown): CodexNodeSessionTranscriptParams {
  if (!isRecord(value)) {
    throw new CatalogParamsError("Codex session read parameters must be an object");
  }
  requireOnlyKeys(value, new Set(["threadId", "cursor", "limit"]));
  const threadId = readOptionalString(value, "threadId", MAX_SESSION_ID_LENGTH);
  if (!threadId) {
    throw new CatalogParamsError("threadId is required");
  }
  const cursor = readOptionalString(value, "cursor", MAX_CURSOR_LENGTH);
  const limit = readBoundedLimit(
    value.limit,
    "limit",
    DEFAULT_TRANSCRIPT_PAGE_LIMIT,
    MAX_TRANSCRIPT_PAGE_LIMIT,
  );
  return { threadId, limit, ...(cursor ? { cursor } : {}) };
}

function readBoundedLimit(value: unknown, key: string, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new CatalogParamsError(`${key} must be an integer from 1 to ${max}`);
  }
  return value as number;
}

function parseTranscriptPage(value: unknown): CodexThreadTurnsListResponse {
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

function flattenTranscriptPageDesc(page: CodexThreadTurnsListResponse) {
  return page.data.flatMap((turn) => turn.items.toReversed());
}

/** Reads the persisted transcript for a Gateway-local or paired-node Codex session. */
export async function readCodexSessionTranscript(params: {
  runtime: PluginRuntime;
  control: CodexSessionCatalogControl;
  hostId: string;
  threadId: string;
  cursor?: string;
  limit: number;
}): Promise<CodexSessionTranscriptPage> {
  params.control.assertEnabled();
  if (params.hostId === CODEX_LOCAL_SESSION_HOST_ID) {
    await requireCatalogEligibleThread(params.control, params.threadId);
    const page = parseTranscriptPage(
      await params.control.listTurnPage({
        threadId: params.threadId,
        limit: params.limit,
        sortDirection: "desc",
        itemsView: "full",
        ...(params.cursor ? { cursor: params.cursor } : {}),
      }),
    );
    return {
      hostId: params.hostId,
      label: "Local Codex",
      threadId: params.threadId,
      items: flattenTranscriptPageDesc(page),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(page.backwardsCursor ? { backwardsCursor: page.backwardsCursor } : {}),
    };
  }

  const nodeId = params.hostId.slice("node:".length);
  const node = (await params.runtime.nodes.list()).nodes.find(
    (candidate) =>
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      candidate.commands?.includes(CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND),
  );
  if (!node) {
    throw new CatalogParamsError("paired-node Codex session host is offline or unavailable");
  }
  const raw = await params.runtime.nodes.invoke({
    nodeId,
    command: CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
    params: {
      threadId: params.threadId,
      limit: params.limit,
      ...(params.cursor ? { cursor: params.cursor } : {}),
    },
    timeoutMs: NODE_INVOKE_TIMEOUT_MS,
  });
  const page = parseTranscriptPage(unwrapNodeInvokePayload(raw));
  return {
    hostId: params.hostId,
    label: nodeLabel(node),
    threadId: params.threadId,
    items: flattenTranscriptPageDesc(page),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.backwardsCursor ? { backwardsCursor: page.backwardsCursor } : {}),
  };
}

function requireIdleThread(thread: CodexThread, action: "continue" | "archive"): void {
  if (
    thread.status?.type === "idle" ||
    (action === "archive" && thread.status?.type === "notLoaded")
  ) {
    return;
  }
  if (thread.status?.type === "active") {
    throw new CatalogParamsError(
      `Codex session is active in this App Server; wait for it to finish before ${action === "continue" ? "starting a branch" : "archiving"}`,
    );
  }
  throw new CatalogParamsError(
    action === "archive"
      ? "Codex session cannot be archived in its current state"
      : "Codex session cannot start a branch in its current state",
  );
}

async function requireCatalogEligibleThread(
  control: CodexSessionCatalogControl,
  threadId: string,
): Promise<void> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < MAX_ACTION_CATALOG_PAGES; pageIndex += 1) {
    const page = await control.listPage({
      limit: CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    const candidate = page.sessions.find((session) => session.threadId === threadId);
    if (candidate) {
      if (candidate.source === "cli" || candidate.source === "vscode") {
        return;
      }
      throw new CatalogParamsError(
        "Codex session is not a non-archived interactive CLI or VS Code session",
      );
    }
    const nextCursor = page.nextCursor?.trim();
    if (!nextCursor) {
      throw new CatalogParamsError(
        "Codex session is not a non-archived interactive CLI or VS Code session",
      );
    }
    if (seenCursors.has(nextCursor)) {
      throw new CatalogParamsError("Codex session eligibility could not be verified");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new CatalogParamsError("Codex session eligibility could not be verified");
}

function adoptionSessionKey(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("hex");
  return `${CODEX_SUPERVISION_SESSION_KEY_PREFIX}${digest}`;
}

// Session creation persists this plugin-owned suffix under an agent-qualified key.
// Restart discovery must compare the parsed suffix, not the returned canonical key.
function adoptionSessionKeyRest(sessionKey: string): string {
  const trimmed = sessionKey.trim();
  return parseAgentSessionKey(trimmed)?.rest ?? trimmed;
}

function isAdoptionSessionKeyForThread(sessionKey: string, threadId: string): boolean {
  return adoptionSessionKeyRest(sessionKey) === adoptionSessionKey(threadId);
}

type CodexSessionDisposition = "existing" | "forked";

type CodexSupervisionMarker = { sourceThreadId: string };

type AdoptedSessionEntry = {
  key: string;
  sessionId: string;
};

function listSupervisionAgentIds(config: OpenClawConfig): string[] {
  const defaultAgentId = resolveDefaultAgentId(config);
  return [defaultAgentId, ...listAgentIds(config).filter((agentId) => agentId !== defaultAgentId)];
}

async function listAdoptedSessionEntries(params: {
  bindingStore: CodexAppServerBindingStore;
  config?: OpenClawConfig;
  runtime: PluginRuntime;
}): Promise<Map<string, AdoptedSessionEntry>> {
  const adopted = new Map<string, AdoptedSessionEntry>();
  for (const { entry, sessionKey } of listSupervisionAgentIds(params.config ?? {}).flatMap(
    (agentId) => params.runtime.agent.session.listSessionEntries({ agentId }),
  )) {
    const sessionKeyRest = adoptionSessionKeyRest(sessionKey);
    if (
      !sessionKeyRest.startsWith(CODEX_SUPERVISION_SESSION_KEY_PREFIX) ||
      entry.initializationPending === true ||
      entry.agentHarnessId !== "codex" ||
      entry.modelSelectionLocked !== true
    ) {
      continue;
    }
    const sessionId = entry.sessionId?.trim();
    if (!sessionId) {
      continue;
    }
    const binding = await params.bindingStore.read(
      sessionBindingIdentity({ sessionId, sessionKey, config: params.config }),
    );
    const sourceThreadId = binding?.supervisionSourceThreadId?.trim();
    if (
      binding?.connectionScope !== "supervision" ||
      !sourceThreadId ||
      sessionKeyRest !== adoptionSessionKey(sourceThreadId)
    ) {
      continue;
    }
    if (adopted.has(sourceThreadId)) {
      throw new Error(`multiple OpenClaw sessions adopt Codex thread ${sourceThreadId}`);
    }
    adopted.set(sourceThreadId, { key: sessionKey, sessionId });
  }
  return adopted;
}

async function findAdoptedSessionEntry(params: {
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  threadId: string;
}): Promise<AdoptedSessionEntry | undefined> {
  return (await listAdoptedSessionEntries(params)).get(params.threadId);
}

class CodexAdoptionBindingCleanupError extends AggregateError {}

async function clearCreatedAdoptionBinding(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: ReturnType<typeof sessionBindingIdentity>;
  sourceThreadId: string;
  expectedPending: CodexAppServerPendingSupervisionBranch;
  cause: unknown;
}): Promise<void> {
  let cleared = false;
  let clearError: unknown;
  try {
    cleared = await params.bindingStore.mutate(params.identity, {
      kind: "clear",
      threadId: params.sourceThreadId,
      expectedPendingSupervisionBranch: params.expectedPending,
    });
  } catch (error) {
    clearError = error;
  }
  if (cleared) {
    return;
  }

  let current: CodexAppServerThreadBinding | undefined;
  try {
    current = await params.bindingStore.read(params.identity);
  } catch (readError) {
    throw new CodexAdoptionBindingCleanupError(
      [params.cause, ...(clearError ? [clearError] : []), readError],
      `OpenClaw session creation failed and the Codex binding could not be verified for ${params.sourceThreadId}`,
    );
  }
  // Pending state is the cleanup CAS token. Once lifecycle work changes it,
  // that successor owns every tracked native artifact and must survive here.
  if (!matchesPendingSupervisionOwner(current, params.expectedPending)) {
    return;
  }
  throw new CodexAdoptionBindingCleanupError(
    [params.cause, ...(clearError ? [clearError] : [])],
    `OpenClaw session creation failed and the Codex binding could not be cleared for ${params.sourceThreadId}`,
  );
}

function lastTerminalTurnId(thread: CodexThread): string | undefined {
  for (let index = (thread.turns?.length ?? 0) - 1; index >= 0; index -= 1) {
    const turn = thread.turns?.[index];
    const turnId = boundedCatalogString(turn?.id, MAX_SESSION_ID_LENGTH);
    if (!turnId) {
      continue;
    }
    if (
      turn?.status === "completed" ||
      turn?.status === "interrupted" ||
      turn?.status === "failed"
    ) {
      return turnId;
    }
  }
  return undefined;
}

function matchesPendingAdoptionBinding(
  binding: CodexAppServerThreadBinding | undefined,
  expected: {
    sourceThreadId: string;
    connectionFingerprint: string;
    cwd: string;
    lastTurnId?: string;
  },
): boolean {
  const historyCoveredThrough = binding?.historyCoveredThrough;
  return (
    binding?.threadId === expected.sourceThreadId &&
    binding.connectionScope === "supervision" &&
    binding.supervisionSourceThreadId === expected.sourceThreadId &&
    binding.cwd === expected.cwd &&
    binding.conversationSourceTransferComplete === true &&
    binding.preserveNativeModel === true &&
    binding.pendingSupervisionBranch?.sourceThreadId === expected.sourceThreadId &&
    binding.pendingSupervisionBranch.connectionFingerprint === expected.connectionFingerprint &&
    binding.pendingSupervisionBranch.lastTurnId === expected.lastTurnId &&
    (binding.pendingSupervisionBranch.cleanupThreadIds?.length ?? 0) === 0 &&
    typeof historyCoveredThrough === "string" &&
    Number.isFinite(Date.parse(historyCoveredThrough))
  );
}

function matchesPendingSupervisionOwner(
  binding: CodexAppServerThreadBinding | undefined,
  expected: CodexAppServerPendingSupervisionBranch,
): boolean {
  const pending = binding?.pendingSupervisionBranch;
  const cleanupThreadIds = pending?.cleanupThreadIds ?? [];
  const expectedCleanupThreadIds = expected.cleanupThreadIds ?? [];
  return (
    binding?.threadId === expected.sourceThreadId &&
    binding.connectionScope === "supervision" &&
    binding.supervisionSourceThreadId === expected.sourceThreadId &&
    pending?.sourceThreadId === expected.sourceThreadId &&
    pending.connectionFingerprint === expected.connectionFingerprint &&
    pending.lastTurnId === expected.lastTurnId &&
    cleanupThreadIds.length === expectedCleanupThreadIds.length &&
    cleanupThreadIds.every((threadId, index) => threadId === expectedCleanupThreadIds[index])
  );
}

async function ensurePendingAdoptionBinding(params: {
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  identity: ReturnType<typeof sessionBindingIdentity>;
  sourceThreadId: string;
  connectionFingerprint: string;
  cwd: string;
  lastTurnId?: string;
}): Promise<void> {
  const pending: CodexAppServerPendingSupervisionBranch = {
    sourceThreadId: params.sourceThreadId,
    connectionFingerprint: params.connectionFingerprint,
    ...(params.lastTurnId ? { lastTurnId: params.lastTurnId } : {}),
  };
  const ownsGeneration = await reclaimCurrentCodexSessionGeneration({
    bindingStore: params.bindingStore,
    identity: params.identity,
    config: params.config,
  });
  if (!ownsGeneration) {
    throw new Error(`failed to claim the OpenClaw session generation for ${params.sourceThreadId}`);
  }
  const existing = await params.bindingStore.read(params.identity);
  if (existing) {
    if (matchesPendingAdoptionBinding(existing, params)) {
      return;
    }
    throw new Error(`OpenClaw session is already bound to Codex thread ${existing.threadId}`);
  }
  const binding = {
    threadId: params.sourceThreadId,
    connectionScope: "supervision" as const,
    supervisionSourceThreadId: params.sourceThreadId,
    cwd: params.cwd,
    historyCoveredThrough: new Date().toISOString(),
    conversationSourceTransferComplete: true as const,
    preserveNativeModel: true as const,
    pendingSupervisionBranch: pending,
  };
  let stored: boolean;
  try {
    stored = await params.bindingStore.mutate(params.identity, {
      kind: "set",
      if: { kind: "absent" },
      binding,
    });
  } catch (error) {
    const committed = await params.bindingStore.read(params.identity);
    if (matchesPendingAdoptionBinding(committed, params)) {
      return;
    }
    throw error;
  }
  if (stored) {
    return;
  }
  const raced = await params.bindingStore.read(params.identity);
  if (!matchesPendingAdoptionBinding(raced, params)) {
    throw new Error(`failed to bind OpenClaw session to Codex thread ${params.sourceThreadId}`);
  }
}

async function createOrReuseAdoptedSession(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  sourceThread: CodexThread;
  connectionFingerprint: string;
}): Promise<AdoptedSessionEntry> {
  const existing = await findAdoptedSessionEntry({
    bindingStore: params.bindingStore,
    config: params.config,
    runtime: params.api.runtime,
    threadId: params.sourceThread.id,
  });
  if (existing) {
    return existing;
  }
  let createdBindingIdentity: ReturnType<typeof sessionBindingIdentity> | undefined;
  let createdPendingBinding: CodexAppServerPendingSupervisionBranch | undefined;
  try {
    const label = params.sourceThread.name?.trim() || undefined;
    const spawnedCwd = params.sourceThread.cwd?.trim() || undefined;
    const pendingLastTurnId = lastTerminalTurnId(params.sourceThread);
    const marker: CodexSupervisionMarker = { sourceThreadId: params.sourceThread.id };
    const created = await params.api.runtime.agent.session.createSessionEntry({
      cfg: params.config,
      key: adoptionSessionKey(params.sourceThread.id),
      agentId: resolveDefaultAgentId(params.config),
      recoverMatchingInitialEntry: true,
      ...(label ? { label } : {}),
      ...(spawnedCwd ? { spawnedCwd } : {}),
      initialEntry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: {
            supervision: {
              ...marker,
              initializing: true,
              modelLocked: true,
            },
          },
        },
      },
      afterCreate: async (entry) => {
        createdBindingIdentity = sessionBindingIdentity({
          sessionId: entry.sessionId,
          sessionKey: entry.key,
          config: params.config,
        });
        const sessionFile = entry.entry.sessionFile?.trim();
        if (!sessionFile) {
          throw new Error("Codex supervision session creation did not produce a transcript file");
        }
        await importCodexThreadHistoryToTranscript({
          thread: params.sourceThread,
          throughTurnId: pendingLastTurnId ?? null,
          sessionFile,
          sessionId: entry.sessionId,
          sessionKey: entry.key,
          agentId: entry.agentId,
          ...(spawnedCwd ? { cwd: spawnedCwd } : {}),
          modelProvider: params.sourceThread.modelProvider,
          config: params.config,
        });
        createdPendingBinding = {
          sourceThreadId: params.sourceThread.id,
          connectionFingerprint: params.connectionFingerprint,
          ...(pendingLastTurnId ? { lastTurnId: pendingLastTurnId } : {}),
        };
        await ensurePendingAdoptionBinding({
          bindingStore: params.bindingStore,
          config: params.config,
          identity: createdBindingIdentity,
          sourceThreadId: params.sourceThread.id,
          connectionFingerprint: params.connectionFingerprint,
          cwd: spawnedCwd ?? "",
          ...(pendingLastTurnId ? { lastTurnId: pendingLastTurnId } : {}),
        });
        return {
          pluginExtensions: {
            codex: {
              supervision: { ...marker, modelLocked: true },
            },
          },
        };
      },
    });
    return { key: created.key, sessionId: created.sessionId };
  } catch (error) {
    // Concurrent/retried Continue calls converge on the same trusted marker.
    // An unrelated entry at the deterministic key is never overwritten.
    let raced = await findAdoptedSessionEntry({
      bindingStore: params.bindingStore,
      config: params.config,
      runtime: params.api.runtime,
      threadId: params.sourceThread.id,
    });
    if (raced) {
      return raced;
    }
    if (createdBindingIdentity && createdPendingBinding) {
      await clearCreatedAdoptionBinding({
        bindingStore: params.bindingStore,
        identity: createdBindingIdentity,
        sourceThreadId: params.sourceThread.id,
        expectedPending: createdPendingBinding,
        cause: error,
      });
      raced = await findAdoptedSessionEntry({
        bindingStore: params.bindingStore,
        config: params.config,
        runtime: params.api.runtime,
        threadId: params.sourceThread.id,
      });
      if (raced) {
        return raced;
      }
    }
    throw error;
  }
}

const continueOperations = new Map<
  string,
  Promise<{ sessionKey: string; disposition: CodexSessionDisposition }>
>();
const sessionActionTails = new Map<string, Promise<void>>();

async function runSessionActionExclusive<T>(threadId: string, run: () => Promise<T>): Promise<T> {
  const previous = sessionActionTails.get(threadId) ?? Promise.resolve();
  const operation = previous.then(run);
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  sessionActionTails.set(threadId, tail);
  try {
    return await operation;
  } finally {
    if (sessionActionTails.get(threadId) === tail) {
      sessionActionTails.delete(threadId);
    }
  }
}

async function continueLocalCodexSessionInner(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  control: CodexSessionCatalogControl;
  threadId: string;
}): Promise<{ sessionKey: string; disposition: CodexSessionDisposition }> {
  await requireCatalogEligibleThread(params.control, params.threadId);
  const existing = await findAdoptedSessionEntry({
    bindingStore: params.bindingStore,
    config: params.config,
    runtime: params.api.runtime,
    threadId: params.threadId,
  });
  if (existing) {
    const sourceThread = await params.control.readThread(params.threadId, false);
    if (sourceThread.id !== params.threadId) {
      throw new Error("Codex app-server returned a different thread than requested");
    }
    params.control.assertEnabled();
    // Catalog state can race archive/reset. Restore only the same locked generation
    // under the session-store write lock so a stale Open Chat cannot revive a replacement.
    const changedError = () =>
      new CatalogParamsError("Codex OpenClaw session changed before it could be opened. Retry.");
    const restored = await params.api.runtime.agent.session.patchSessionEntry({
      sessionKey: existing.key,
      readConsistency: "latest",
      preserveActivity: true,
      update: (entry) => {
        if (
          entry.sessionId?.trim() !== existing.sessionId ||
          entry.initializationPending === true ||
          entry.agentHarnessId !== "codex" ||
          entry.modelSelectionLocked !== true
        ) {
          throw changedError();
        }
        return { archivedAt: undefined };
      },
    });
    if (!restored) {
      throw changedError();
    }
    return { sessionKey: existing.key, disposition: "existing" };
  }

  const sourceThread = await params.control.readThread(params.threadId, true);
  if (sourceThread.id !== params.threadId) {
    throw new Error("Codex app-server returned a different thread than requested");
  }
  if (sourceThread.status?.type !== "notLoaded") {
    requireIdleThread(sourceThread, "continue");
  }
  params.control.assertEnabled();
  const connectionFingerprint = params.control.connectionFingerprint;
  if (!connectionFingerprint) {
    throw new Error("Codex Continue requires a pinned app-server connection");
  }
  const adopted = await createOrReuseAdoptedSession({
    api: params.api,
    bindingStore: params.bindingStore,
    config: params.config,
    sourceThread,
    connectionFingerprint,
  });
  return { sessionKey: adopted.key, disposition: "forked" };
}

/** Creates one locked OpenClaw branch whose first harness run forks the Codex source. */
export async function continueLocalCodexSession(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  control: CodexSessionCatalogControl;
  threadId: string;
}): Promise<{ sessionKey: string; disposition: CodexSessionDisposition }> {
  params.control.assertEnabled();
  const current = continueOperations.get(params.threadId);
  if (current) {
    return await current;
  }
  const operation = runSessionActionExclusive(params.threadId, async () =>
    params.control.withPinnedConnection(async (control) =>
      continueLocalCodexSessionInner({ ...params, control }),
    ),
  );
  continueOperations.set(params.threadId, operation);
  try {
    return await operation;
  } finally {
    if (continueOperations.get(params.threadId) === operation) {
      continueOperations.delete(params.threadId);
    }
  }
}

async function assertNoPendingSupervisionBranch(params: {
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  threadId: string;
}): Promise<void> {
  const adoptedEntries = listSupervisionAgentIds(params.config)
    .flatMap((agentId) => params.runtime.agent.session.listSessionEntries({ agentId }))
    .filter((candidate) => isAdoptionSessionKeyForThread(candidate.sessionKey, params.threadId));
  for (const adopted of adoptedEntries) {
    if (adopted.entry.initializationPending === true) {
      throw new CatalogParamsError(
        "Codex session cannot be archived while its OpenClaw branch is initializing",
      );
    }
    const sessionId = adopted.entry.sessionId?.trim();
    if (!sessionId) {
      continue;
    }
    const binding = await params.bindingStore.read(
      sessionBindingIdentity({
        sessionId,
        sessionKey: adopted.sessionKey,
        config: params.config,
      }),
    );
    if (
      binding?.connectionScope === "supervision" &&
      binding.supervisionSourceThreadId === params.threadId &&
      binding.pendingSupervisionBranch?.sourceThreadId === params.threadId
    ) {
      throw new CatalogParamsError(
        "Codex session cannot be archived until its OpenClaw branch starts",
      );
    }
  }
}

/** Archives one inactive Gateway-local Codex thread after a fresh status read. */
export async function archiveLocalCodexSession(params: {
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  control: CodexSessionCatalogControl;
  runtime: PluginRuntime;
  threadId: string;
}): Promise<{ archived: true }> {
  params.control.assertEnabled();
  return await runSessionActionExclusive(params.threadId, async () => {
    return await params.bindingStore.withThreadArchiveFence(async () => {
      return await params.control.withPinnedConnection(async (control) => {
        await requireCatalogEligibleThread(control, params.threadId);
        await assertNoPendingSupervisionBranch(params);
        const thread = await control.readThread(params.threadId, false);
        if (thread.id !== params.threadId) {
          throw new Error("Codex app-server returned a different thread than requested");
        }
        requireIdleThread(thread, "archive");
        if (await params.bindingStore.hasOtherThreadOwner(params.threadId)) {
          throw new CatalogParamsError(
            "Codex session cannot be archived while it is attached to an OpenClaw session",
          );
        }
        await assertCodexArchiveDescendantsUnowned({
          bindingStore: params.bindingStore,
          threadId: params.threadId,
          listPage: (request) => control.listDescendantPage(request),
          assertDescendantIdle: async (descendantThreadId) => {
            const descendant = await control.readThread(descendantThreadId, false);
            if (descendant.id !== descendantThreadId) {
              throw new Error("Codex app-server returned a different descendant than requested");
            }
            requireIdleThread(descendant, "archive");
          },
        });
        await control.archiveThread(params.threadId);
        return { archived: true };
      });
    });
  });
}

/** Allows read-only catalog and transcript commands on supported paired-node platforms. */
export function createCodexSessionCatalogNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND, CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) => context.invokeNode(),
    },
  ];
}

/** Registers the Control UI descriptor and host-grouped Gateway catalog method. */
export function registerCodexSessionCatalogGateway(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  control: CodexSessionCatalogControl;
  getRuntimeConfig: () => OpenClawConfig | undefined;
}): void {
  params.api.session.controls.registerControlUiDescriptor({
    surface: "tab",
    id: "sessions",
    label: "Codex Sessions",
    description: "Codex sessions on this Gateway and paired nodes.",
    icon: "terminal",
    group: "control",
    requiredScopes: ["operator.write"],
  });
  params.api.registerGatewayMethod(
    CODEX_SESSION_CATALOG_METHOD,
    async ({ params: requestParams, respond }: GatewayRequestHandlerOptions) => {
      try {
        respond(
          true,
          await listCodexSessionCatalog({
            bindingStore: params.bindingStore,
            config: params.getRuntimeConfig(),
            runtime: params.api.runtime,
            control: params.control,
            query: readGatewayParams(requestParams),
          }),
        );
      } catch (error) {
        if (error instanceof CatalogParamsError) {
          respond(
            false,
            { error: error.message },
            errorShape(ErrorCodes.INVALID_REQUEST, error.message),
          );
          return;
        }
        const message = "Codex session catalog request failed";
        respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
      }
    },
    // Core node.invoke is a write-scoped method even for read-only plugin commands.
    { scope: "operator.write" },
  );
  params.api.registerGatewayMethod(
    CODEX_SESSION_READ_METHOD,
    async ({ params: requestParams, respond }: GatewayRequestHandlerOptions) => {
      try {
        const action = readTranscriptParams(requestParams);
        respond(
          true,
          await readCodexSessionTranscript({
            runtime: params.api.runtime,
            control: params.control,
            hostId: action.hostId,
            threadId: action.threadId,
            cursor: action.cursor,
            limit: action.limit,
          }),
        );
      } catch (error) {
        if (error instanceof CatalogParamsError) {
          respond(
            false,
            { error: error.message },
            errorShape(ErrorCodes.INVALID_REQUEST, error.message),
          );
          return;
        }
        const message = "Codex session transcript could not be read";
        respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
      }
    },
    { scope: "operator.write" },
  );
  params.api.registerGatewayMethod(
    CODEX_SESSION_CONTINUE_METHOD,
    async ({ params: requestParams, respond }: GatewayRequestHandlerOptions) => {
      try {
        const action = readActionParams(requestParams);
        const config = params.getRuntimeConfig();
        if (!config) {
          throw new Error("OpenClaw runtime config is unavailable");
        }
        respond(
          true,
          await continueLocalCodexSession({
            api: params.api,
            bindingStore: params.bindingStore,
            config,
            control: params.control,
            threadId: action.threadId,
          }),
        );
      } catch (error) {
        if (error instanceof CatalogParamsError) {
          respond(
            false,
            { error: error.message },
            errorShape(ErrorCodes.INVALID_REQUEST, error.message),
          );
          return;
        }
        const message = "Codex session could not be continued";
        respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
      }
    },
    { scope: "operator.write" },
  );
  params.api.registerGatewayMethod(
    CODEX_SESSION_ARCHIVE_METHOD,
    async ({ params: requestParams, respond }: GatewayRequestHandlerOptions) => {
      try {
        const action = readActionParams(requestParams, { archive: true });
        const config = params.getRuntimeConfig();
        if (!config) {
          throw new Error("OpenClaw runtime config is unavailable");
        }
        respond(
          true,
          await archiveLocalCodexSession({
            bindingStore: params.bindingStore,
            config,
            control: params.control,
            runtime: params.api.runtime,
            threadId: action.threadId,
          }),
        );
      } catch (error) {
        if (error instanceof CatalogParamsError) {
          respond(
            false,
            { error: error.message },
            errorShape(ErrorCodes.INVALID_REQUEST, error.message),
          );
          return;
        }
        const message = "Codex session could not be archived";
        respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
      }
    },
    { scope: "operator.write" },
  );
}
