import { createHash } from "node:crypto";
import { resolveDefaultAgentDir, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  SessionCatalogHost,
  SessionCatalogProvider,
} from "openclaw/plugin-sdk/session-catalog";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config.js";
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
import {
  adoptedSourceKey,
  adoptionSessionKeyRest,
  continueOperations,
  listNodeAdoptedSessionEntries,
  listSupervisionAgentIds,
  runSessionActionExclusive,
  type AdoptedSessionEntry,
  type CodexSessionDisposition,
} from "./session-catalog-node-adoption.js";
import {
  compareNodeLabels,
  continueNodeCodexSession,
  listPairedNode,
  nodeLabel,
  type CatalogNode,
} from "./session-catalog-node-continue.js";
import {
  boundedCatalogString,
  catalogError,
  CatalogParamsError,
  CODEX_APP_SERVER_THREADS_CAPABILITY,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  DEFAULT_TRANSCRIPT_PAGE_LIMIT,
  filterCatalogPageByTitle,
  isInteractiveThreadSource,
  MAX_CURSOR_LENGTH,
  MAX_HOST_COUNT,
  MAX_SESSION_ID_LENGTH,
  MAX_TITLE_SEARCH_CATALOG_PAGES,
  MAX_TRANSCRIPT_PAGE_LIMIT,
  NODE_INVOKE_TIMEOUT_MS,
  normalizeLimit,
  parseCatalogPage,
  parseJsonParams,
  parseTranscriptPage,
  readControlCursor,
  readGatewayParams,
  readOptionalString,
  readPageParams,
  requireBoundThread,
  requireOnlyKeys,
  toCatalogSession,
  unwrapNodeInvokePayload,
} from "./session-catalog-parsing.js";
import {
  CODEX_TERMINAL_RESUME_COMMAND,
  codexNodeTerminalCapability,
  createCodexTerminalNodeHostCommand,
  openCodexCatalogTerminal,
  requireCatalogEligibleThread,
  resolveLocalCodexTerminalExecutable,
} from "./session-catalog-terminal.js";
import { toGenericTranscriptItem } from "./session-catalog-transcript-item.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogHost,
  CodexSessionCatalogParams,
  CodexSessionCatalogResult,
  CodexSessionCatalogSession,
  CodexSessionTranscriptPage,
} from "./session-catalog-types.js";
import * as upstream from "./session-upstream-activity.js";
import {
  codexLastTerminalTurnId,
  codexUpstreamBaseline,
  codexUpstreamContinueResult,
  type CodexUpstreamBaseline,
} from "./session-upstream-marker.js";
const boundCatalogSessionId = (value: unknown) =>
  boundedCatalogString(value, MAX_SESSION_ID_LENGTH);

const CODEX_SUPERVISION_SESSION_KEY_PREFIX = "harness:codex:supervision:";

export {
  CODEX_LOCAL_SESSION_HOST_ID,
  CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
} from "./session-catalog-parsing.js";

type CodexSessionCatalogRequestSnapshot = {
  requestTimeoutMs: number;
  listThreads(params: CodexThreadListParams, timeoutMs: number): Promise<CodexThreadListResponse>;
  listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
  readThread(threadId: string, includeTurns: boolean): Promise<CodexThread>;
  archiveThread(threadId: string): Promise<void>;
};

function createCodexSessionCatalogControlFromRequests(params: {
  connectionFingerprint?: string;
  createRequestSnapshot: () => CodexSessionCatalogRequestSnapshot;
  now: () => number;
  withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"];
}): CodexSessionCatalogControl {
  return {
    ...(params.connectionFingerprint
      ? { connectionFingerprint: params.connectionFingerprint }
      : {}),
    withPinnedConnection: params.withPinnedConnection,
    async listPage(pageParams) {
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
      const requests = params.createRequestSnapshot();
      const response = await requests.listThreads(listParams, requests.requestTimeoutMs);
      return response;
    },
    async readThread(threadId, includeTurns = false) {
      const thread = await params.createRequestSnapshot().readThread(threadId, includeTurns);
      return thread;
    },
    async listTurnPage(listParams) {
      const response = await params.createRequestSnapshot().listThreadTurns(listParams);
      return response;
    },
    async archiveThread(threadId) {
      await params.createRequestSnapshot().archiveThread(threadId);
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
  const getPluginConfig = () => params.getPluginConfig();
  const createRequestSnapshot = (): CodexSessionCatalogRequestSnapshot => {
    const pluginConfig = getPluginConfig();
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
    const pluginConfig = getPluginConfig();
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
    createRequestSnapshot,
    now,
    withPinnedConnection,
  });
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

/** Lists Gateway-local and paired-node Codex sessions with per-host failures. */
async function listCodexSessionCatalog(params: {
  bindingStore: CodexAppServerBindingStore;
  config?: OpenClawConfig;
  runtime: PluginRuntime;
  control: CodexSessionCatalogControl;
  query?: CodexSessionCatalogParams;
}): Promise<CodexSessionCatalogResult> {
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
  const adoptedNodeSessions = listNodeAdoptedSessionEntries({
    config: params.config,
    runtime: params.runtime,
  });
  const nodeHosts = nodes.toSorted(compareNodeLabels).map(async (node) => {
    const host = await listPairedNode({
      runtime: params.runtime,
      node,
      query,
      adoptedSessions: adoptedNodeSessions,
    });
    return Object.assign(host, codexNodeTerminalCapability(node));
  });
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
    createCodexTerminalNodeHostCommand(control),
  ];
}

type CodexNodeSessionTranscriptParams = {
  threadId: string;
  cursor?: string;
  limit: number;
};

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

function flattenTranscriptPageDesc(page: CodexThreadTurnsListResponse) {
  return page.data.flatMap((turn) => turn.items.toReversed());
}

/** Reads the persisted transcript for a Gateway-local or paired-node Codex session. */
async function readCodexSessionTranscript(params: {
  runtime: PluginRuntime;
  control: CodexSessionCatalogControl;
  hostId: string;
  threadId: string;
  cursor?: string;
  limit: number;
}): Promise<CodexSessionTranscriptPage> {
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
    scopes: ["operator.write"],
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

function adoptionSessionKey(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("hex");
  return `${CODEX_SUPERVISION_SESSION_KEY_PREFIX}${digest}`;
}

function isAdoptionSessionKeyForThread(sessionKey: string, threadId: string): boolean {
  return adoptionSessionKeyRest(sessionKey) === adoptionSessionKey(threadId);
}

type CodexSupervisionMarker = { sourceThreadId: string };

async function listAdoptedSessionEntries(params: {
  bindingStore: CodexAppServerBindingStore;
  config?: OpenClawConfig;
  runtime: PluginRuntime;
}): Promise<Map<string, AdoptedSessionEntry>> {
  const adopted = new Map<string, AdoptedSessionEntry>();
  for (const agentId of listSupervisionAgentIds(params.config ?? {})) {
    for (const { entry, sessionKey } of params.runtime.agent.session.listSessionEntries({
      agentId,
    })) {
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
      const boundThreadId = binding?.threadId.trim();
      if (
        binding?.connectionScope !== "supervision" ||
        !sourceThreadId ||
        !boundThreadId ||
        sessionKeyRest !== adoptionSessionKey(sourceThreadId)
      ) {
        continue;
      }
      if (adopted.has(sourceThreadId)) {
        throw new Error(`multiple OpenClaw sessions adopt Codex thread ${sourceThreadId}`);
      }
      adopted.set(sourceThreadId, { key: sessionKey, sessionId, agentId, boundThreadId });
    }
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
    const pendingLastTurnId = codexLastTerminalTurnId(params.sourceThread, boundCatalogSessionId);
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
        // Post-flip the mirror targets SQLite rows; resolve the agent's store
        // path instead of trusting the legacy sessionFile locator marker.
        const storePath = resolveStorePath(params.config.session?.store, {
          agentId: entry.agentId,
        });
        await importCodexThreadHistoryToTranscript({
          thread: params.sourceThread,
          throughTurnId: pendingLastTurnId ?? null,
          storePath,
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
    return {
      key: created.key,
      sessionId: created.sessionId,
      agentId: created.agentId,
      boundThreadId: params.sourceThread.id,
    };
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

async function continueLocalCodexSessionInner(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  control: CodexSessionCatalogControl;
  threadId: string;
  onContinued?: (upstream: CodexUpstreamBaseline & { connectionFingerprint: string }) => void;
}): Promise<{ sessionKey: string; disposition: CodexSessionDisposition }> {
  await requireCatalogEligibleThread(params.control, params.threadId);
  const existing = await findAdoptedSessionEntry({
    bindingStore: params.bindingStore,
    config: params.config,
    runtime: params.api.runtime,
    threadId: params.threadId,
  });
  if (existing) {
    const boundThreadId = requireBoundThread(existing);
    const boundThread = await params.control.readThread(boundThreadId, true);
    if (boundThread.id !== boundThreadId) {
      throw new Error("Codex app-server returned a different thread than requested");
    }
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
    const connectionFingerprint = params.control.connectionFingerprint;
    if (connectionFingerprint) {
      params.onContinued?.({
        connectionFingerprint,
        ...codexUpstreamBaseline(boundThread, boundCatalogSessionId),
      });
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
  const boundThreadId = requireBoundThread(adopted);
  const baselineThread =
    boundThreadId === sourceThread.id
      ? sourceThread
      : await params.control.readThread(boundThreadId, true);
  if (baselineThread.id !== boundThreadId) {
    throw new Error("Codex app-server returned a different thread than requested");
  }
  params.onContinued?.({
    connectionFingerprint,
    ...codexUpstreamBaseline(baselineThread, boundCatalogSessionId),
  });
  return { sessionKey: adopted.key, disposition: "forked" };
}

/** Creates one locked OpenClaw branch whose first harness run forks the Codex source. */
async function continueLocalCodexSession(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  control: CodexSessionCatalogControl;
  threadId: string;
  onContinued?: (upstream: CodexUpstreamBaseline & { connectionFingerprint: string }) => void;
}): Promise<{ sessionKey: string; disposition: CodexSessionDisposition }> {
  const sourceKey = adoptedSourceKey(CODEX_LOCAL_SESSION_HOST_ID, params.threadId);
  const current = continueOperations.get(sourceKey);
  if (current) {
    return await current;
  }
  const operation = runSessionActionExclusive(sourceKey, async () =>
    params.control.withPinnedConnection(async (control) =>
      continueLocalCodexSessionInner({ ...params, control }),
    ),
  );
  continueOperations.set(sourceKey, operation);
  try {
    return await operation;
  } finally {
    if (continueOperations.get(sourceKey) === operation) {
      continueOperations.delete(sourceKey);
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
async function archiveLocalCodexSession(params: {
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  control: CodexSessionCatalogControl;
  runtime: PluginRuntime;
  threadId: string;
}): Promise<{ archived: true }> {
  return await runSessionActionExclusive(
    adoptedSourceKey(CODEX_LOCAL_SESSION_HOST_ID, params.threadId),
    async () => {
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
    },
  );
}

/** Allows read-only catalog and transcript commands on supported paired-node platforms. */
export function createCodexSessionCatalogNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [
        CODEX_APP_SERVER_THREADS_LIST_COMMAND,
        CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
        CODEX_TERMINAL_RESUME_COMMAND,
      ],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) =>
        context.command === CODEX_TERMINAL_RESUME_COMMAND ? { ok: true } : context.invokeNode(),
    },
  ];
}

function toGenericCatalogHost(
  host: CodexSessionCatalogHost,
  localTerminalAvailable: boolean,
): SessionCatalogHost {
  const local = host.hostId === CODEX_LOCAL_SESSION_HOST_ID;
  return {
    hostId: host.hostId,
    label: host.label,
    kind: host.kind,
    connected: host.connected,
    ...(host.nodeId ? { nodeId: host.nodeId } : {}),
    sessions: host.sessions.map((session) => {
      const continuableStatus =
        !session.archived && (session.status === "idle" || session.status === "notLoaded");
      const canContinue =
        (local || host.canContinueCodex === true) &&
        continuableStatus &&
        isInteractiveThreadSource(session.source);
      const canArchive = local && continuableStatus && isInteractiveThreadSource(session.source);
      const canOpenTerminal =
        isInteractiveThreadSource(session.source) &&
        (local ? localTerminalAvailable : host.canOpenTerminalCodex === true);
      return {
        threadId: session.threadId,
        ...(session.name != null ? { name: session.name } : {}),
        ...(session.cwd ? { cwd: session.cwd } : {}),
        status: session.status,
        ...(session.createdAt != null ? { createdAt: session.createdAt } : {}),
        ...(session.updatedAt != null ? { updatedAt: session.updatedAt } : {}),
        ...(session.recencyAt != null ? { recencyAt: session.recencyAt } : {}),
        ...(session.source ? { source: session.source } : {}),
        ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
        ...(session.cliVersion ? { cliVersion: session.cliVersion } : {}),
        ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
        archived: session.archived,
        ...(session.openClawSessionKey ? { openClawSessionKey: session.openClawSessionKey } : {}),
        canContinue,
        canArchive,
        canOpenTerminal,
      };
    }),
    ...(host.nextCursor ? { nextCursor: host.nextCursor } : {}),
    ...(host.error ? { error: host.error } : {}),
  };
}

function registerCodexSessionCatalog(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  control: CodexSessionCatalogControl;
  getRuntimeConfig: () => OpenClawConfig | undefined;
}): void {
  const provider: SessionCatalogProvider = {
    id: "codex",
    label: "Codex",
    list: async (query) => {
      const localTerminalAvailable = resolveLocalCodexTerminalExecutable() !== undefined;
      return (
        await listCodexSessionCatalog({
          bindingStore: params.bindingStore,
          config: params.getRuntimeConfig(),
          runtime: params.api.runtime,
          control: params.control,
          query,
        })
      ).hosts.map((host) => toGenericCatalogHost(host, localTerminalAvailable));
    },
    read: async (request) => {
      const page = await readCodexSessionTranscript({
        runtime: params.api.runtime,
        control: params.control,
        hostId: request.hostId,
        threadId: request.threadId,
        cursor: request.cursor,
        limit: request.limit ?? DEFAULT_TRANSCRIPT_PAGE_LIMIT,
      });
      return { ...page, items: page.items.map(toGenericTranscriptItem) };
    },
    continueSession: async (request) => {
      const config = params.getRuntimeConfig();
      if (!config) {
        throw new Error("OpenClaw runtime config is unavailable");
      }
      if (request.hostId.startsWith("node:")) {
        return await continueNodeCodexSession({
          api: params.api,
          config,
          hostId: request.hostId,
          threadId: request.threadId,
          clientScopes: request.clientScopes,
        });
      }
      if (request.hostId !== CODEX_LOCAL_SESSION_HOST_ID) {
        throw new CatalogParamsError("Codex session catalog hostId is invalid");
      }
      let upstreamBaseline: (CodexUpstreamBaseline & { connectionFingerprint: string }) | undefined;
      const continued = await continueLocalCodexSession({
        api: params.api,
        bindingStore: params.bindingStore,
        config,
        control: params.control,
        threadId: request.threadId,
        onContinued: (baseline) => {
          upstreamBaseline = baseline;
        },
      });
      return codexUpstreamContinueResult(continued.sessionKey, request.threadId, upstreamBaseline);
    },
    checkUpstreamActivity: upstream.createChecker(params),
    archive: async (request) => {
      const runnerConfirmation: unknown = request.confirmNoOtherRunner;
      if (runnerConfirmation !== true) {
        throw new CatalogParamsError(
          "archive requires confirmation that no other runner is active",
        );
      }
      if (request.hostId !== CODEX_LOCAL_SESSION_HOST_ID) {
        throw new CatalogParamsError("paired-node Codex sessions are view-only");
      }
      const config = params.getRuntimeConfig();
      if (!config) {
        throw new Error("OpenClaw runtime config is unavailable");
      }
      await archiveLocalCodexSession({
        bindingStore: params.bindingStore,
        config,
        control: params.control,
        runtime: params.api.runtime,
        threadId: request.threadId,
      });
      return { ok: true };
    },
    openTerminal: (request) =>
      openCodexCatalogTerminal({
        api: params.api,
        control: params.control,
        parseCatalogPage,
        ...request,
      }),
  };
  params.api.registerSessionCatalog(provider);
}

export const codexSessionCatalogRuntime = {
  register: registerCodexSessionCatalog,
  list: listCodexSessionCatalog,
  readTranscript: readCodexSessionTranscript,
  continueLocal: continueLocalCodexSession,
  continueNode: continueNodeCodexSession,
  archiveLocal: archiveLocalCodexSession,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
