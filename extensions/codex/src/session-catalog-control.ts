import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import type { CodexManagedThreadStore } from "./app-server/managed-thread-store.js";
import { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import { assertCodexThreadForkParams } from "./app-server/protocol.js";
import type {
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  CodexThread,
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadListParams,
  CodexThreadListResponse,
  CodexThreadItemsListParams,
  CodexThreadItemsListResponse,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResponse,
} from "./app-server/protocol.js";
import { withTimeout } from "./app-server/timeout.js";
import { createCodexCatalogHomeResolver, type CodexCatalogHome } from "./session-catalog-homes.js";
import {
  MAX_TITLE_SEARCH_CATALOG_PAGES,
  MAX_ACTION_CATALOG_PAGES,
  CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
  CatalogParamsError,
  isInteractiveThreadSource,
  normalizeLimit,
  readControlCursor,
  toCatalogSession,
} from "./session-catalog-parsing.js";
import {
  isOpenClawManagedCodexThread,
  readCodexSessionMeta,
} from "./session-catalog-provenance.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
  CodexSessionCatalogSession,
} from "./session-catalog-types.js";

const CODEX_SESSION_CATALOG_LIST_TTL_MS = 32_000;
const CODEX_SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES = 32;

type CodexCatalogRequestOptions = {
  agentDir: string;
  config: OpenClawConfig | undefined;
  startOptions: CodexAppServerStartOptions;
};

type CodexCatalogPageCacheEntry = {
  expiresAt: number;
  page: Promise<CodexSessionCatalogPage>;
  value?: CodexSessionCatalogPage;
};

function codexCatalogPageCacheKey(
  params: CodexSessionCatalogPageParams,
  agentId: string,
  source?: CodexCatalogHome,
): string {
  // Mirror listPage's search/cwd normalization; these trimmed values are what reach app-server.
  return JSON.stringify([
    agentId,
    source?.sourceHomeId ?? null,
    params.cursor ?? null,
    params.limit ?? null,
    params.searchTerm?.trim().toLocaleLowerCase() || null,
    params.cwd?.trim() || null,
  ]);
}

type CodexSessionCatalogRequestSnapshot = {
  requestTimeoutMs: number;
  listThreads(params: CodexThreadListParams, timeoutMs: number): Promise<CodexThreadListResponse>;
  listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
  listThreadItems(params: CodexThreadItemsListParams): Promise<CodexThreadItemsListResponse>;
  forkThread(
    params: CodexThreadForkParams,
    assertCurrent?: () => void,
  ): Promise<CodexThreadForkResponse>;
  readThread(threadId: string, includeTurns: boolean, timeoutMs?: number): Promise<CodexThread>;
  archiveThread(threadId: string, assertCurrent?: () => void): Promise<void>;
};

type CodexCatalogRequestMethod =
  | typeof CODEX_CONTROL_METHODS.archiveThread
  | typeof CODEX_CONTROL_METHODS.forkThread
  | typeof CODEX_CONTROL_METHODS.listThreads
  | typeof CODEX_CONTROL_METHODS.listThreadTurns
  | typeof CODEX_CONTROL_METHODS.listThreadItems
  | typeof CODEX_CONTROL_METHODS.readThread;

type CodexCatalogRequest = <M extends CodexCatalogRequestMethod>(
  method: M,
  requestParams: CodexAppServerRequestParams<M>,
  timeoutMs?: number,
  assertCurrent?: () => void,
) => Promise<CodexAppServerRequestResult<M>>;

function createCodexCatalogRequestSnapshot(
  requestTimeoutMs: number,
  request: CodexCatalogRequest,
): CodexSessionCatalogRequestSnapshot {
  return {
    requestTimeoutMs,
    listThreads: (params, timeoutMs) =>
      request(CODEX_CONTROL_METHODS.listThreads, params, timeoutMs),
    listThreadTurns: (params) => request(CODEX_CONTROL_METHODS.listThreadTurns, params),
    listThreadItems: (params) => request(CODEX_CONTROL_METHODS.listThreadItems, params),
    forkThread: (params, assertCurrent) =>
      request(
        CODEX_CONTROL_METHODS.forkThread,
        assertCodexThreadForkParams(params),
        undefined,
        assertCurrent,
      ),
    readThread: async (threadId, includeTurns, timeoutMs) =>
      (await request(CODEX_CONTROL_METHODS.readThread, { threadId, includeTurns }, timeoutMs))
        .thread,
    archiveThread: async (threadId, assertCurrent) => {
      await request(CODEX_CONTROL_METHODS.archiveThread, { threadId }, undefined, assertCurrent);
    },
  };
}

function createCodexSessionCatalogControlFromRequests(params: {
  forkContext?: CodexSessionCatalogControl["forkContext"];
  clientId?: string;
  retireConnection?: () => void;
  connectionFingerprint?: string;
  createRequestSnapshot: () => CodexSessionCatalogRequestSnapshot;
  localSessionsRoot?: string;
  sourceHomeId?: string;
  managedThreads?: CodexManagedThreadStore;
  now: () => number;
  withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"];
}): CodexSessionCatalogControl {
  return {
    forkContext: params.forkContext,
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...(params.connectionFingerprint
      ? { connectionFingerprint: params.connectionFingerprint }
      : {}),
    withPinnedConnection: params.withPinnedConnection,
    async requireEligibleThread(threadId) {
      const requests = params.createRequestSnapshot();
      const deadline = params.now() + requests.requestTimeoutMs;
      const unverified = () =>
        new CatalogParamsError(
          "Codex session eligibility could not be verified. Refresh the catalog and verify the session in its native Codex home before retrying.",
        );
      const remaining = () => {
        const timeoutMs = Math.ceil(deadline - params.now());
        if (timeoutMs <= 0) {
          throw unverified();
        }
        return timeoutMs;
      };
      const verify = async () => {
        if (
          params.sourceHomeId &&
          (await params.managedThreads?.has(params.sourceHomeId, threadId))
        ) {
          throw unverified();
        }
        // Local exact reads seed missing native index rows before DB-only membership checks.
        // Remote/pathless stores retain native scan-and-repair membership: no local rollout authority.
        const root = params.localSessionsRoot;
        const thread = root ? await requests.readThread(threadId, false, remaining()) : undefined;
        if (
          root &&
          (!thread || thread.id !== threadId || !isInteractiveThreadSource(thread.source))
        ) {
          throw unverified();
        }
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        for (let pageIndex = 0; pageIndex < MAX_ACTION_CATALOG_PAGES; pageIndex += 1) {
          const page = await requests.listThreads(
            {
              archived: false,
              limit: CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
              modelProviders: [],
              sortKey: root ? "recency_at" : "updated_at",
              sortDirection: "desc",
              ...(root
                ? { useStateDbOnly: true, ...(thread?.cwd ? { cwd: thread.cwd } : {}) }
                : {}),
              ...(cursor ? { cursor } : {}),
            },
            remaining(),
          );
          remaining();
          const candidate = page.data.find((value) => value.id === threadId);
          if (candidate) {
            if (!isInteractiveThreadSource(candidate.source)) {
              throw unverified();
            }
            if (root && thread) {
              const rolloutPath = thread.path;
              // Codex may retain the plain path after compressing the selected immutable rollout.
              if (
                !rolloutPath ||
                !candidate.path ||
                rolloutPath.replace(/\.zst$/u, "") !== candidate.path.replace(/\.zst$/u, "")
              ) {
                throw unverified();
              }
              const metadata = await readCodexSessionMeta(root, rolloutPath, threadId);
              remaining();
              if (
                !metadata ||
                !isInteractiveThreadSource(metadata.source) ||
                metadata.originator === "openclaw"
              ) {
                throw unverified();
              }
              return thread;
            }
            return candidate;
          }
          const nextCursor = readControlCursor(page.nextCursor, "next response");
          if (!nextCursor || seenCursors.has(nextCursor)) {
            throw unverified();
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        throw unverified();
      };
      return await withTimeout(
        verify(),
        requests.requestTimeoutMs,
        "Codex session eligibility could not be verified",
        unverified,
      );
    },
    retireConnection: params.retireConnection,
    async listPage(pageParams) {
      const limit = normalizeLimit(pageParams.limit, "limit");
      // App Server search also matches transcript previews. Scan native pages
      // without that filter so this catalog remains a title-only surface.
      const search = pageParams.searchTerm?.trim().toLocaleLowerCase() || undefined;
      const cwd = pageParams.cwd?.trim() || undefined;
      const maxPages = search ? MAX_TITLE_SEARCH_CATALOG_PAGES : 1;
      const sessions: CodexSessionCatalogSession[] = [];
      const managedThreads: Array<{ threadId: string; rolloutPath?: string }> = [];
      let cursor = readControlCursor(pageParams.cursor, "request");
      let nextCursor: string | undefined;
      let backwardsCursor: string | undefined;
      const seenCursors = new Set(cursor ? [cursor] : []);
      const requests = params.createRequestSnapshot();
      const deadline = params.now() + requests.requestTimeoutMs;
      // Keep config/home sampling before the import and charge cold loading to this deadline.
      const { sanitizeTerminalText } = await import("openclaw/plugin-sdk/text-chunking");

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const remainingTimeoutMs = Math.ceil(deadline - params.now());
        if (remainingTimeoutMs <= 0) {
          throw new Error("Codex session catalog listing timed out");
        }
        const response = await requests.listThreads(
          {
            archived: false,
            limit: limit - sessions.length,
            modelProviders: [],
            // Match Codex's resume picker/latest-session ordering so a session
            // created outside OpenClaw enters the first catalog page immediately.
            sortKey: "updated_at",
            sortDirection: "desc",
            ...(cwd ? { cwd } : {}),
            ...(cursor ? { cursor } : {}),
          },
          remainingTimeoutMs,
        );
        if (pageIndex === 0) {
          backwardsCursor = readControlCursor(response.backwardsCursor, "backwards response");
        }
        for (const thread of response.data) {
          if (await isOpenClawManagedCodexThread(thread, params.localSessionsRoot)) {
            const rolloutPath = typeof thread.path === "string" ? thread.path.trim() : "";
            managedThreads.push({
              threadId: thread.id,
              ...(rolloutPath ? { rolloutPath } : {}),
            });
            continue;
          }
          const session = toCatalogSession(thread, false, sanitizeTerminalText);
          if (
            session &&
            (!search ||
              (session.name ?? session.fallbackName)?.toLocaleLowerCase().includes(search))
          ) {
            sessions.push(session);
          }
        }
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
        ...(managedThreads.length > 0 ? { managedThreads } : {}),
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
    listItemPage: (listParams) => params.createRequestSnapshot().listThreadItems(listParams),
    async forkThread(forkParams, assertCurrent) {
      return await params.createRequestSnapshot().forkThread(forkParams, assertCurrent);
    },
    async archiveThread(threadId, assertCurrent) {
      await params.createRequestSnapshot().archiveThread(threadId, assertCurrent);
    },
  };
}

/** Builds the passive catalog over the Codex plugin's canonical shared client. */
export function createCodexSessionCatalogControl(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  getPluginConfig: () => unknown;
  getRuntimeConfig: () => OpenClawConfig | undefined;
  resolveRuntimeOptions: typeof resolveCodexSupervisionAppServerRuntimeOptions;
  now?: () => number;
  managedThreads?: CodexManagedThreadStore;
}): CodexSessionCatalogControlFactory {
  const now = params.now ?? Date.now;
  const getPluginConfig = () => params.getPluginConfig();
  const homeResolver = createCodexCatalogHomeResolver({
    config: params.getRuntimeConfig() ?? params.config ?? {},
    getRuntimeConfig: params.getRuntimeConfig,
    getPluginConfig: params.getPluginConfig,
    resolveRuntimeOptions: params.resolveRuntimeOptions,
    ...(params.env ? { env: params.env } : {}),
  });
  const requestOptionsByConfig = new WeakMap<
    OpenClawConfig,
    Map<string, CodexCatalogRequestOptions>
  >();
  const catalogPagesByConfig = new WeakMap<
    OpenClawConfig,
    Map<string, CodexCatalogPageCacheEntry>
  >();
  const resolveRequestOptions = (
    startOptions: CodexAppServerStartOptions,
    agentId: string,
    source?: CodexCatalogHome,
  ): CodexCatalogRequestOptions => {
    const runtimeConfig = params.getRuntimeConfig();
    const agentDir = source?.agentDir ?? resolveAgentDir(runtimeConfig ?? {}, agentId);
    const resolvedStartOptions = source?.appServer.start ?? startOptions;
    if (!runtimeConfig) {
      return {
        agentDir,
        config: undefined,
        startOptions: structuredClone(resolvedStartOptions),
      };
    }
    let byAgent = requestOptionsByConfig.get(runtimeConfig);
    const cacheKey = `${agentId ?? ""}\0${source?.sourceHomeId ?? ""}`;
    const cached = byAgent?.get(cacheKey);
    if (cached) {
      // Plugin start options derive from this same immutable config snapshot. Config reload changes
      // object identity; re-cloning on every poll only adds CPU and allocation to the catalog path.
      return cached;
    }
    const resolved = {
      agentDir,
      config: structuredClone(runtimeConfig),
      startOptions: structuredClone(resolvedStartOptions),
    };
    if (!byAgent) {
      byAgent = new Map();
      requestOptionsByConfig.set(runtimeConfig, byAgent);
    }
    byAgent.set(cacheKey, resolved);
    return resolved;
  };
  const createRequestSnapshot = (
    agentId: string,
    source?: CodexCatalogHome,
  ): CodexSessionCatalogRequestSnapshot => {
    const pluginConfig = getPluginConfig();
    const runtime = source?.appServer ?? params.resolveRuntimeOptions({ pluginConfig });
    const requestOptions = resolveRequestOptions(runtime.start, agentId, source);
    return createCodexCatalogRequestSnapshot(
      runtime.requestTimeoutMs,
      async (method, requestParams, timeoutMs, assertCurrent) => {
        const { codexControlRequest } = await import("./command-rpc.js");
        return await codexControlRequest(pluginConfig, method, requestParams, {
          ...requestOptions,
          assertCurrent,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      },
    );
  };

  const forRequest = (agentId: string, source?: CodexCatalogHome): CodexSessionCatalogControl => {
    const withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"] = async (
      run,
    ) => {
      const pluginConfig = getPluginConfig();
      const runtime = source?.appServer ?? params.resolveRuntimeOptions({ pluginConfig });
      const {
        agentDir,
        config: runtimeConfig,
        startOptions,
      } = resolveRequestOptions(runtime.start, agentId, source);
      // Capture the request's config/home before loading execution; imports must
      // not let a concurrent reload move this pinned operation to another owner.
      const {
        getLeasedSharedCodexAppServerClient,
        releaseLeasedSharedCodexAppServerClient,
        retireSharedCodexAppServerClientIfCurrent,
      } = await import("./app-server/shared-client.js");
      const { resolveCodexAppServerClientInstanceId } = await import("./app-server/client.js");
      const { requestCodexAppServerClientJson } = await import("./app-server/request.js");
      const client = await getLeasedSharedCodexAppServerClient({
        agentDir,
        config: runtimeConfig,
        startOptions,
        timeoutMs: runtime.requestTimeoutMs,
      });
      try {
        const requests = createCodexCatalogRequestSnapshot(
          runtime.requestTimeoutMs,
          async <M extends CodexCatalogRequestMethod>(
            method: M,
            requestParams: CodexAppServerRequestParams<M>,
            timeoutMs?: number,
            assertCurrent?: () => void,
          ): Promise<CodexAppServerRequestResult<M>> =>
            await requestCodexAppServerClientJson<CodexAppServerRequestResult<M>>({
              client,
              method,
              requestParams,
              config: runtimeConfig,
              timeoutMs: timeoutMs ?? runtime.requestTimeoutMs,
              assertCurrent,
            }),
        );
        const pinnedControl: CodexSessionCatalogControl =
          createCodexSessionCatalogControlFromRequests({
            forkContext: {
              client,
              appServer: runtime,
              pluginConfig,
              agentDir,
              localSessionsRoot: source?.localSessionsRoot,
            },
            clientId: resolveCodexAppServerClientInstanceId(client),
            retireConnection: () => {
              retireSharedCodexAppServerClientIfCurrent(client);
            },
            connectionFingerprint: buildCodexAppServerConnectionFingerprint(runtime, agentDir),
            createRequestSnapshot: () => requests,
            ...(source?.localSessionsRoot ? { localSessionsRoot: source.localSessionsRoot } : {}),
            sourceHomeId: source?.sourceHomeId,
            managedThreads: params.managedThreads,
            now,
            withPinnedConnection: async (nestedRun) => await nestedRun(pinnedControl),
          });
        return await run(pinnedControl);
      } finally {
        releaseLeasedSharedCodexAppServerClient(client);
      }
    };
    const control = createCodexSessionCatalogControlFromRequests({
      createRequestSnapshot: () => createRequestSnapshot(agentId, source),
      ...(source?.localSessionsRoot ? { localSessionsRoot: source.localSessionsRoot } : {}),
      now,
      withPinnedConnection,
    });
    return {
      ...control,
      requireEligibleThread: (threadId) =>
        withPinnedConnection((pinned) => pinned.requireEligibleThread(threadId)),
      async listPage(pageParams: CodexSessionCatalogPageParams) {
        const runtimeConfig = params.getRuntimeConfig();
        if (!runtimeConfig) {
          return await control.listPage(pageParams);
        }
        let cache = catalogPagesByConfig.get(runtimeConfig);
        if (!cache) {
          cache = new Map();
          catalogPagesByConfig.set(runtimeConfig, cache);
        }
        const key = codexCatalogPageCacheKey(pageParams, agentId, source);
        const cached = cache.get(key);
        if (cached) {
          cache.delete(key);
          cache.set(key, cached);
          if (cached.expiresAt > now()) {
            return cached.value ?? (await cached.page);
          }
        }
        if (cached) {
          cache.delete(key);
        }
        const page = control.listPage(pageParams);
        const staleValue = cached?.value;
        const entry: CodexCatalogPageCacheEntry = {
          expiresAt: Number.POSITIVE_INFINITY,
          page,
          ...(staleValue ? { value: staleValue } : {}),
        };
        cache.set(key, entry);
        pruneMapToMaxSize(cache, CODEX_SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES);
        const settle = (value: CodexSessionCatalogPage) => {
          if (cache.get(key) === entry) {
            entry.value = value;
            entry.expiresAt = now() + CODEX_SESSION_CATALOG_LIST_TTL_MS;
          }
          return value;
        };
        const restore = () => {
          if (cache.get(key) !== entry) {
            return;
          }
          if (staleValue) {
            cache.set(key, {
              expiresAt: now(),
              page: Promise.resolve(staleValue),
              value: staleValue,
            });
          } else {
            cache.delete(key);
          }
        };
        // Expiry starts one background refresh. Passive callers keep the last settled page while
        // the next poll publishes success or retries failure.
        if (staleValue) {
          void page.then(settle, restore);
          return staleValue;
        }
        try {
          return settle(await page);
        } catch (error) {
          restore();
          throw error;
        }
      },
    };
  };
  const homesForAgent = (agentId: string) => homeResolver.forAgent(agentId);
  const forUpstream = (agentId: string, connectionFingerprint: string) => {
    // A fingerprint is correlation only. A miss must stay fail-closed instead of selecting a
    // different home whose thread namespace could contain the same copied identifier.
    const source = homesForAgent(agentId).find(
      (home) =>
        buildCodexAppServerConnectionFingerprint(home.appServer, home.agentDir) ===
        connectionFingerprint,
    );
    return source ? forRequest(agentId, source) : undefined;
  };
  return { forRequest, forUpstream, homesForAgent };
}
