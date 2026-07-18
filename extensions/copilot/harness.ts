// Copilot plugin module implements harness behavior.
import type { CopilotClient } from "@github/copilot-sdk";
import {
  buildAgentHookContextChannelFields,
  compactWithSafetyTimeout,
  getModelProviderRequestTransport,
  resolveCompactionTimeoutMs,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
  type AgentHarness,
  type AgentHarnessAttemptParams,
  type AgentHarnessAttemptResult,
  type AgentHarnessCompactParams,
  type AgentHarnessCompactResult,
  type AgentHarnessResetParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { CopilotSessionConfig } from "./src/attempt.js";
import { createCopilotByokAuth, resolveCopilotAuth, tokenFingerprint } from "./src/auth-bridge.js";
import { createCopilotByokProxy } from "./src/byok-proxy.js";
import {
  isCopilotByokUnsupportedProviderError,
  resolveCopilotProvider,
  supportsCopilotByokProviderShape,
} from "./src/provider-bridge.js";
import type {
  ClientCreateOptions,
  CopilotClientPool,
  CopilotClientPoolOptions,
  PooledClient,
  PoolKey,
} from "./src/runtime.js";

const COPILOT_PROVIDER_IDS: ReadonlySet<string> = new Set(["github-copilot"]);

interface CreateCopilotAgentHarnessOptions {
  id?: string;
  label?: string;
  pluginConfig?: unknown;
  pool?: CopilotClientPool;
  poolOptions?: CopilotClientPoolOptions;
  sessionStore?: CopilotSessionBindingStore;
}

interface TrackedSession {
  sdkSessionId: string;
  client: CopilotClient;
  clientOptions: ClientCreateOptions;
  poolKey: PoolKey;
  sessionConfig: CopilotSessionConfig;
  // Compatibility fingerprint of the params that created the SDK
  // session. We only reuse the tracked SDK session when the next
  // attempt's fingerprint matches — different provider/model/cwd/auth
  // configurations should start a fresh SDK session rather than resume
  // one bound to incompatible state. Mismatch falls back to
  // `createSession` (no resume injection) and the new sdkSessionId
  // replaces this entry via `onSessionEstablished`.
  compatKey: string;
  compactKey: string;
  authMode: "gitHubToken" | "useLoggedInUser" | "byok";
  authProfileId?: string;
  authProfileVersion?: string;
}

interface CopilotHistoryCompactResult {
  success: boolean;
  tokensRemoved: number;
  messagesRemoved: number;
  summaryContent?: string;
  contextWindow?: {
    tokenLimit: number;
    currentTokens: number;
    messagesLength: number;
    systemTokens?: number;
    conversationTokens?: number;
    toolDefinitionsTokens?: number;
  };
}

interface CopilotHistoryCompactSession {
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  rpc: {
    history: {
      abortManualCompaction(): Promise<{ aborted: boolean }>;
      compact(params?: { customInstructions?: string }): Promise<CopilotHistoryCompactResult>;
    };
  };
}

export type CopilotSessionBinding = {
  schemaVersion: 2;
  sdkSessionId: string;
  compatKey: string;
  compactKey: string;
  authMode: "gitHubToken" | "useLoggedInUser" | "byok";
  authProfileId?: string;
  authProfileVersion?: string;
  updatedAt: number;
};

type LegacyCopilotSessionBinding = {
  schemaVersion: 1;
  sdkSessionId: string;
  compatKey: string;
  updatedAt: number;
};

type CopilotAttemptSessionBinding = Pick<CopilotSessionBinding, "compatKey" | "sdkSessionId">;
type DeferredCompactionCleanupOutcome = "aborted" | "completed" | "deadline";
type DeferredCompactionCleanup = {
  abort: () => void;
  sdkSessionId: string;
};

type CopilotSessionBindingStore = Pick<
  PluginStateSyncKeyedStore<CopilotSessionBinding>,
  "delete" | "lookup" | "register"
>;

type CopilotSessionAuth = Pick<
  CopilotSessionBinding,
  "authMode" | "authProfileId" | "authProfileVersion"
>;

function sessionAuthFields(auth: CopilotSessionAuth): CopilotSessionAuth {
  return auth.authMode === "gitHubToken" || auth.authMode === "byok"
    ? {
        authMode: auth.authMode,
        authProfileId: auth.authProfileId,
        authProfileVersion: auth.authProfileVersion,
      }
    : { authMode: "useLoggedInUser" };
}

function sessionAuthMatches(stored: CopilotSessionAuth, current: CopilotSessionAuth): boolean {
  if (stored.authMode !== current.authMode) {
    return false;
  }
  if (stored.authMode === "useLoggedInUser") {
    return true;
  }
  return (
    current.authMode === stored.authMode &&
    stored.authProfileId === current.authProfileId &&
    stored.authProfileVersion === current.authProfileVersion
  );
}

function normalizeBinding(
  value: CopilotSessionBinding | undefined,
): CopilotSessionBinding | undefined {
  if (
    !value ||
    value.schemaVersion !== 2 ||
    typeof value.sdkSessionId !== "string" ||
    value.sdkSessionId.trim() === "" ||
    typeof value.compatKey !== "string" ||
    value.compatKey.trim() === "" ||
    typeof value.compactKey !== "string" ||
    value.compactKey.trim() === "" ||
    (value.authMode !== "gitHubToken" &&
      value.authMode !== "byok" &&
      value.authMode !== "useLoggedInUser") ||
    ((value.authMode === "gitHubToken" || value.authMode === "byok") &&
      (typeof value.authProfileId !== "string" ||
        value.authProfileId.trim() === "" ||
        typeof value.authProfileVersion !== "string" ||
        value.authProfileVersion.trim() === "")) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 2,
    sdkSessionId: value.sdkSessionId.trim(),
    compatKey: value.compatKey,
    compactKey: value.compactKey,
    authMode: value.authMode,
    ...(value.authMode === "gitHubToken" || value.authMode === "byok"
      ? {
          authProfileId: value.authProfileId,
          authProfileVersion: value.authProfileVersion,
        }
      : {}),
    updatedAt: value.updatedAt,
  };
}

function normalizeAttemptBinding(value: unknown): CopilotAttemptSessionBinding | undefined {
  const current = normalizeBinding(value as CopilotSessionBinding | undefined);
  if (current) {
    return current;
  }
  const legacy = value as LegacyCopilotSessionBinding | undefined;
  if (
    !legacy ||
    legacy.schemaVersion !== 1 ||
    typeof legacy.sdkSessionId !== "string" ||
    legacy.sdkSessionId.trim() === "" ||
    typeof legacy.compatKey !== "string" ||
    legacy.compatKey.trim() === "" ||
    typeof legacy.updatedAt !== "number" ||
    !Number.isFinite(legacy.updatedAt)
  ) {
    return undefined;
  }
  return {
    sdkSessionId: legacy.sdkSessionId.trim(),
    compatKey: legacy.compatKey,
  };
}

function lookupStoredBinding(
  store: CopilotSessionBindingStore | undefined,
  key: string,
): CopilotAttemptSessionBinding | undefined {
  try {
    return normalizeAttemptBinding(store?.lookup(key));
  } catch {
    try {
      store?.delete(key);
    } catch {
      // Durable binding cleanup is best-effort; the turn can create a fresh SDK session.
    }
    return undefined;
  }
}

function registerStoredBinding(
  store: CopilotSessionBindingStore | undefined,
  key: string,
  binding: CopilotSessionBinding,
): boolean {
  try {
    store?.register(key, binding);
    return true;
  } catch {
    try {
      store?.delete(key);
    } catch {
      // A failed invalidation just degrades to in-memory reuse for this process.
    }
    // The in-memory binding still keeps this process warm; persistence is an optimization.
    return false;
  }
}

function deleteStoredBinding(store: CopilotSessionBindingStore | undefined, key: string): boolean {
  try {
    store?.delete(key);
    return true;
  } catch {
    // Reset must still clear tracked SDK sessions even if plugin state is unhealthy.
    return false;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = "reason" in signal ? signal.reason : undefined;
  if (reason instanceof Error) {
    throw reason;
  }
  const error = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  error.name = "AbortError";
  throw error;
}

function isStaleSdkSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(404|not found|no such session|unknown session|stale|deleted|does not exist)\b/i.test(
    message,
  );
}

async function compactTrackedSdkSession(params: {
  abortSignal?: AbortSignal;
  client: CopilotClient;
  customInstructions?: string;
  gitHubToken?: string;
  onSession?: (session: CopilotHistoryCompactSession) => void;
  sessionConfig: CopilotSessionConfig;
  sdkSessionId: string;
}): Promise<CopilotHistoryCompactResult> {
  throwIfAborted(params.abortSignal);
  const session = (await params.client.resumeSession(params.sdkSessionId, {
    ...params.sessionConfig,
    continuePendingWork: false,
    ...(params.gitHubToken ? { gitHubToken: params.gitHubToken } : {}),
    suppressResumeEvent: true,
  })) as unknown as CopilotHistoryCompactSession;
  params.onSession?.(session);
  const request = params.customInstructions?.trim()
    ? { customInstructions: params.customInstructions }
    : undefined;
  try {
    throwIfAborted(params.abortSignal);
    return await session.rpc.history.compact(request);
  } finally {
    try {
      await session.disconnect();
    } catch {
      // Preserve the compaction or cancellation outcome; cleanup is best-effort here.
    }
  }
}

// Build a string fingerprint of the attempt params that must agree
// across turns for SDK-session reuse to be safe. Keep this list
// conservative: any field whose change would invalidate the SDK
// session's bound state belongs here. Token / auth profile rotation
// produces a new fingerprint so we don't replay a session against a
// stale credential.
//
// Auth identity is derived from `resolveCopilotAuth(...)` — the same
// function `resolvePoolAcquire` uses to build the pool key. That
// ensures the compat key tracks the EFFECTIVE auth (which can come
// from the legacy `auth.*` subobject, the contract-resolved
// top-level `resolvedApiKey` + `authProfileId`, or the env-var
// fallback) rather than any single one of those raw inputs. The
// `authProfileVersion` field is a non-secret sha256 fingerprint of
// the token (see `tokenFingerprint` in `src/auth-bridge.ts`), so
// rotating the token under the same profile id still invalidates
// the compat key without ever serializing the raw credential.
type CopilotSessionCompatParams = AgentHarnessAttemptParams | AgentHarnessCompactParams;

function readAgentIdFromSessionKey(sessionKey: unknown): string | undefined {
  if (typeof sessionKey !== "string") {
    return undefined;
  }
  const parts = sessionKey.trim().split(":");
  return parts[0] === "agent" && parts[1]?.trim() ? parts[1].trim() : undefined;
}

function computeSessionKey(
  params: CopilotSessionCompatParams,
  options: { includeApi: boolean; includeAuth: boolean },
): string {
  const p = params as CopilotSessionCompatParams & {
    auth?: {
      gitHubToken?: string;
      profileId?: string;
      profileVersion?: string;
      useLoggedInUser?: boolean;
    };
    agentId?: string;
    agentDir?: string;
    authProfileId?: string;
    copilotHome?: string;
    cwd?: string;
    modelId?: string;
    model?:
      | {
          api?: string;
          id?: string;
          provider?: string;
          baseUrl?: string;
          azureApiVersion?: string;
          headers?: Record<string, string | null | undefined>;
          authHeader?: boolean;
          params?: Record<string, unknown>;
          request?: {
            auth?: { mode?: unknown };
            proxy?: unknown;
            tls?: unknown;
            allowPrivateNetwork?: unknown;
          };
          contextTokens?: number;
          contextWindow?: number;
          maxTokens?: number;
        }
      | string;
    runtimeModel?: {
      api?: string;
      id?: string;
      provider?: string;
      baseUrl?: string;
      azureApiVersion?: string;
      headers?: Record<string, string | null | undefined>;
      authHeader?: boolean;
      params?: Record<string, unknown>;
      request?: {
        auth?: { mode?: unknown };
        proxy?: unknown;
        tls?: unknown;
        allowPrivateNetwork?: unknown;
      };
      contextTokens?: number;
      contextWindow?: number;
      maxTokens?: number;
    };
    profileVersion?: string;
    resolvedApiKey?: string;
    sessionKey?: string;
    workspaceDir?: string;
  };
  const modelObj: {
    api?: string;
    id?: string;
    provider?: string;
    baseUrl?: string;
    azureApiVersion?: string;
    headers?: Record<string, string | null | undefined>;
    authHeader?: boolean;
    params?: Record<string, unknown>;
    request?: {
      auth?: { mode?: unknown };
      proxy?: unknown;
      tls?: unknown;
      allowPrivateNetwork?: unknown;
    };
    contextTokens?: number;
    contextWindow?: number;
    maxTokens?: number;
  } =
    p.model && typeof p.model === "object"
      ? p.model
      : p.runtimeModel && typeof p.runtimeModel === "object"
        ? p.runtimeModel
        : { id: typeof p.model === "string" ? p.model : undefined };
  const provider = modelObj.provider ?? (typeof p.provider === "string" ? p.provider : "");
  const modelId =
    modelObj.id ??
    (typeof p.modelId === "string" ? p.modelId : undefined) ??
    (typeof p.model === "string" ? p.model : "");
  const requestTransport =
    p.model && typeof p.model === "object" ? getModelProviderRequestTransport(p.model) : undefined;
  const requestAuthMode = readSessionString(
    requestTransport?.auth?.mode ?? modelObj.request?.auth?.mode,
  );
  const azureApiVersion = readSessionString(
    modelObj.azureApiVersion ?? modelObj.params?.azureApiVersion,
  );
  // resolveCopilotAuth can throw when an explicit `auth.gitHubToken`
  // is supplied without profileId + profileVersion (the existing
  // pool-key safety invariant). That same error would surface
  // immediately afterwards from `resolvePoolAcquire` inside
  // `runCopilotAttempt`, so we don't want to mask it here — but
  // we also can't include random / time-based data in the compat key
  // (would break the deterministic equality check). Use a stable
  // sentinel that will never match any previously-tracked compat key.
  let authParts: string[];
  let resolvedAgentId = "";
  let resolvedCopilotHome = "";
  try {
    const resolved = !options.includeAuth
      ? resolveCopilotAuth({
          agentId:
            typeof p.agentId === "string" ? p.agentId : readAgentIdFromSessionKey(p.sessionKey),
          agentDir: typeof p.agentDir === "string" ? p.agentDir : undefined,
          workspaceDir: typeof p.workspaceDir === "string" ? p.workspaceDir : undefined,
          copilotHome: typeof p.copilotHome === "string" ? p.copilotHome : undefined,
          auth: { useLoggedInUser: true },
        })
      : (() => {
          const modelProvider = resolveCopilotProvider({
            model: {
              api: modelObj.api,
              id: modelId,
              provider,
              baseUrl: modelObj.baseUrl,
              azureApiVersion,
              headers: modelObj.headers,
              authHeader: modelObj.authHeader,
              requestAuthMode,
              requestProxy: requestTransport?.proxy ?? modelObj.request?.proxy,
              requestTls: requestTransport?.tls ?? modelObj.request?.tls,
              requestAllowPrivateNetwork:
                requestTransport?.allowPrivateNetwork ?? modelObj.request?.allowPrivateNetwork,
              contextTokens: modelObj.contextTokens,
              contextWindow: modelObj.contextWindow,
              maxTokens: modelObj.maxTokens,
            },
            resolvedApiKey: typeof p.resolvedApiKey === "string" ? p.resolvedApiKey : undefined,
            authProfileId: typeof p.authProfileId === "string" ? p.authProfileId : undefined,
          });
          return modelProvider.mode === "byok"
            ? createCopilotByokAuth({
                agentId:
                  typeof p.agentId === "string"
                    ? p.agentId
                    : readAgentIdFromSessionKey(p.sessionKey),
                agentDir: typeof p.agentDir === "string" ? p.agentDir : undefined,
                workspaceDir: typeof p.workspaceDir === "string" ? p.workspaceDir : undefined,
                copilotHome: typeof p.copilotHome === "string" ? p.copilotHome : undefined,
                authProfileId: modelProvider.authProfileId,
                authProfileVersion: modelProvider.authProfileVersion,
              })
            : resolveCopilotAuth({
                agentId:
                  typeof p.agentId === "string"
                    ? p.agentId
                    : readAgentIdFromSessionKey(p.sessionKey),
                agentDir: typeof p.agentDir === "string" ? p.agentDir : undefined,
                workspaceDir: typeof p.workspaceDir === "string" ? p.workspaceDir : undefined,
                copilotHome: typeof p.copilotHome === "string" ? p.copilotHome : undefined,
                auth: p.auth,
                resolvedApiKey: typeof p.resolvedApiKey === "string" ? p.resolvedApiKey : undefined,
                authProfileId: typeof p.authProfileId === "string" ? p.authProfileId : undefined,
                profileVersion: typeof p.profileVersion === "string" ? p.profileVersion : undefined,
              });
        })();
    resolvedAgentId = resolved.agentId;
    resolvedCopilotHome = resolved.copilotHome;
    authParts = [
      `auth.mode=${resolved.authMode}`,
      `auth.profileId=${resolved.authProfileId ?? ""}`,
      `auth.profileVersion=${resolved.authProfileVersion ?? ""}`,
    ];
    if (!options.includeAuth) {
      authParts = [];
    }
  } catch {
    authParts = ["auth=unresolvable"];
  }
  const parts = [
    `provider=${provider}`,
    `model=${modelId}`,
    ...(options.includeApi ? [`api=${modelObj.api ?? ""}`] : []),
    ...(options.includeApi
      ? [`baseUrlFingerprint=${fingerprintSessionValue(modelObj.baseUrl)}`]
      : []),
    `cwd=${p.cwd ?? p.workspaceDir ?? ""}`,
    `agentId=${resolvedAgentId}`,
    `agentDir=${p.agentDir ?? ""}`,
    `copilotHome=${p.copilotHome ?? ""}`,
    `resolvedCopilotHome=${resolvedCopilotHome}`,
    ...(options.includeAuth ? authParts : []),
  ];
  return parts.join("|");
}

function readSessionString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fingerprintSessionValue(value: unknown): string {
  return typeof value === "string" && value ? tokenFingerprint(value) : "";
}

function computeSessionCompatKey(params: CopilotSessionCompatParams): string {
  return computeSessionKey(params, { includeApi: true, includeAuth: true });
}

function computeSessionCompactKey(params: CopilotSessionCompatParams): string {
  return computeSessionKey(params, { includeApi: false, includeAuth: false });
}

function buildCopilotCompactionHookContext(params: AgentHarnessCompactParams) {
  return {
    ...(params.runId ? { runId: params.runId } : {}),
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    modelProviderId: params.provider,
    modelId: params.model,
    trigger: params.trigger,
    ...buildAgentHookContextChannelFields(params),
  };
}

export function createCopilotAgentHarness(
  options?: CreateCopilotAgentHarnessOptions,
): AgentHarness {
  let poolPromise: Promise<CopilotClientPool> | undefined;
  let createdPool: CopilotClientPool | undefined;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  const deferredCompactionCleanups = new Map<
    string,
    Map<Promise<DeferredCompactionCleanupOutcome>, DeferredCompactionCleanup>
  >();
  // Maps OpenClaw session id (from AgentHarnessAttemptParams.sessionId) to
  // the SDK session id + client that owns it. Populated by
  // runCopilotAttempt via the onSessionEstablished callback so that
  // reset(params) can call client.deleteSession on the right client.
  const trackedSessions = new Map<string, TrackedSession>();
  const resetBlockedStoredSessions = new Set<string>();

  async function getPool(): Promise<CopilotClientPool> {
    if (options?.pool) {
      return options.pool;
    }
    if (!poolPromise) {
      poolPromise = (async () => {
        const { createCopilotClientPool } = await import("./src/runtime.js");
        createdPool = createCopilotClientPool(options?.poolOptions);
        return createdPool;
      })();
    }
    return poolPromise;
  }

  function trackDeferredCompactionCleanup(params: {
    abort: () => void;
    cleanup: Promise<DeferredCompactionCleanupOutcome>;
    sessionId: string;
    sdkSessionId: string;
  }): void {
    const cleanups =
      deferredCompactionCleanups.get(params.sessionId) ??
      new Map<Promise<DeferredCompactionCleanupOutcome>, DeferredCompactionCleanup>();
    cleanups.set(params.cleanup, { abort: params.abort, sdkSessionId: params.sdkSessionId });
    deferredCompactionCleanups.set(params.sessionId, cleanups);
    void params.cleanup.then(
      () => removeDeferredCompactionCleanup(params.sessionId, params.cleanup),
      () => removeDeferredCompactionCleanup(params.sessionId, params.cleanup),
    );
  }

  function removeDeferredCompactionCleanup(
    sessionId: string,
    cleanup: Promise<DeferredCompactionCleanupOutcome>,
  ): void {
    const cleanups = deferredCompactionCleanups.get(sessionId);
    if (!cleanups) {
      return;
    }
    cleanups.delete(cleanup);
    if (cleanups.size === 0) {
      deferredCompactionCleanups.delete(sessionId);
    }
  }

  function hasPendingDeferredCompactionCleanup(sessionId: string): boolean {
    const cleanups = deferredCompactionCleanups.get(sessionId);
    if (!cleanups) {
      return false;
    }
    const currentSdkSessionId =
      trackedSessions.get(sessionId)?.sdkSessionId ??
      lookupStoredBinding(options?.sessionStore, sessionId)?.sdkSessionId;
    return (
      currentSdkSessionId !== undefined &&
      [...cleanups.values()].some((cleanup) => cleanup.sdkSessionId === currentSdkSessionId)
    );
  }

  async function abortDeferredCompactionCleanups(sessionId: string): Promise<void> {
    const cleanups = deferredCompactionCleanups.get(sessionId);
    if (!cleanups) {
      return;
    }
    const pending = [...cleanups.entries()];
    for (const [, cleanup] of pending) {
      cleanup.abort();
    }
    await Promise.allSettled(pending.map(([cleanup]) => cleanup));
  }

  return {
    id: options?.id ?? "copilot",
    label: options?.label ?? "GitHub Copilot agent runtime",
    autoSelection: { providerIds: [] },

    supports(ctx) {
      const requestedRuntime = String(ctx.requestedRuntime ?? "")
        .trim()
        .toLowerCase();
      if (requestedRuntime !== "copilot") {
        return { supported: false, reason: "copilot is opt-in only" };
      }
      const provider = ctx.provider.trim().toLowerCase();
      if (!provider) {
        return { supported: false, reason: "provider is required" };
      }
      if (COPILOT_PROVIDER_IDS.has(provider)) {
        return { supported: true, priority: 100 };
      }
      const providerOwnerPluginIds = ctx.providerOwnerPluginIds;
      if (
        ctx.providerOwnerStatus !== "unowned" ||
        !providerOwnerPluginIds ||
        providerOwnerPluginIds.length > 0
      ) {
        return {
          supported: false,
          reason: `provider is not one of: ${[...COPILOT_PROVIDER_IDS].toSorted().join(", ")}`,
        };
      }
      if (
        !supportsCopilotByokProviderShape({
          api: ctx.modelProvider?.api,
          baseUrl: ctx.modelProvider?.baseUrl,
          requestProxy: ctx.modelProvider?.request?.proxy,
          requestTls: ctx.modelProvider?.request?.tls,
          requestAllowPrivateNetwork: ctx.modelProvider?.request?.allowPrivateNetwork,
        })
      ) {
        return {
          supported: false,
          reason:
            "provider is not a supported Copilot BYOK model (requires supported api, baseUrl, and no request transport policy overrides)",
        };
      }
      return { supported: true, priority: 100 };
    },

    async runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult> {
      const attemptPromise = (async () => {
        if (disposed) {
          throw new Error("[copilot] harness has been disposed; cannot start new attempts");
        }
        const { resolvePoolAcquire, runCopilotAttempt } = await import("./src/attempt.js");
        if (disposed) {
          throw new Error("[copilot] harness was disposed while starting an attempt");
        }
        const pool = await getPool();
        if (disposed) {
          throw new Error("[copilot] harness was disposed while starting an attempt");
        }
        let poolAcquire: ReturnType<typeof resolvePoolAcquire>;
        try {
          poolAcquire = resolvePoolAcquire(params as never);
        } catch (error) {
          // Keep invalid forced BYOK model configuration on the normal attempt
          // result path so callers receive `model_not_supported` instead of an
          // uncaught harness rejection. Other auth/pool errors remain fatal.
          if (isCopilotByokUnsupportedProviderError(error)) {
            return runCopilotAttempt(params, { pool });
          }
          throw error;
        }
        const openclawSessionId =
          typeof params.sessionId === "string" ? params.sessionId : undefined;

        // Dogfood finding #4: reuse the SDK session across turns within
        // the same OpenClaw session so that the GitHub Copilot agent runtime's prompt
        // cache, tool-call history, and any server-side compaction state
        // survive turn boundaries. Without this, every turn called
        // `createSession()` and lost cache + thread continuity — the
        // smoking gun was distinct `${sdkSessionId}` scopes per turn in
        // the playground transcript.
        //
        // Safety:
        //   - Only inject when the tracked compatKey still matches the
        //     current attempt's fingerprint (provider/model/cwd/auth).
        //     Mismatch falls through to `createSession` and the new SDK
        //     session replaces the tracked entry below.
        //   - Preserve any caller-provided `replayInvalid: true` — never
        //     downgrade an orchestrator-issued safety signal to false.
        //     `decideReplayAction` treats undefined as resumable already.
        //   - On resume failure, `attempt.ts` recovers via the
        //     `replay-shim` (`resumeFailureRecovered:true`) and falls
        //     back to `createSession`, so a stale-session error never
        //     surfaces as a prompt error.
        const currentCompatKey = computeSessionCompatKey(params);
        const currentCompactKey = computeSessionCompactKey(params);
        const compactionCleanupPending =
          openclawSessionId !== undefined && hasPendingDeferredCompactionCleanup(openclawSessionId);
        const replayBlocked =
          openclawSessionId !== undefined &&
          (compactionCleanupPending || resetBlockedStoredSessions.has(openclawSessionId));
        const tracked =
          openclawSessionId && !replayBlocked ? trackedSessions.get(openclawSessionId) : undefined;
        const stored = openclawSessionId
          ? replayBlocked
            ? undefined
            : lookupStoredBinding(options?.sessionStore, openclawSessionId)
          : undefined;
        const resumableSessionId =
          tracked && tracked.compatKey === currentCompatKey
            ? tracked.sdkSessionId
            : !tracked && stored && stored.compatKey === currentCompatKey
              ? stored.sdkSessionId
              : undefined;
        const effectiveParams: AgentHarnessAttemptParams = resumableSessionId
          ? ({
              ...params,
              initialReplayState: {
                ...params.initialReplayState,
                sdkSessionId: resumableSessionId,
              },
            } as AgentHarnessAttemptParams)
          : params;

        return runCopilotAttempt(effectiveParams, {
          pool,
          onSessionEstablished: openclawSessionId
            ? ({
                compactionSessionConfig,
                sdkSessionId,
                pooledClient,
                sessionConfig,
              }: {
                compactionSessionConfig?: CopilotSessionConfig;
                sdkSessionId: string;
                pooledClient: PooledClient;
                sessionConfig: CopilotSessionConfig;
              }) => {
                trackedSessions.set(openclawSessionId, {
                  sdkSessionId,
                  client: pooledClient.client,
                  clientOptions: poolAcquire.options,
                  compatKey: currentCompatKey,
                  compactKey: currentCompactKey,
                  poolKey: pooledClient.key,
                  sessionConfig: compactionSessionConfig ?? sessionConfig,
                  ...sessionAuthFields(poolAcquire.auth),
                });
                registerStoredBinding(options?.sessionStore, openclawSessionId, {
                  schemaVersion: 2,
                  sdkSessionId,
                  compatKey: currentCompatKey,
                  compactKey: currentCompactKey,
                  ...sessionAuthFields(poolAcquire.auth),
                  updatedAt: Date.now(),
                });
                resetBlockedStoredSessions.delete(openclawSessionId);
              }
            : undefined,
          onDeferredCompaction: openclawSessionId
            ? ({
                abort,
                cleanup,
                sdkSessionId,
              }: {
                abort: () => void;
                cleanup: Promise<DeferredCompactionCleanupOutcome>;
                sdkSessionId: string;
              }) => {
                const trackedBinding = trackedSessions.get(openclawSessionId);
                const storedBinding = lookupStoredBinding(options?.sessionStore, openclawSessionId);
                const ownsTrackedSession = trackedBinding?.sdkSessionId === sdkSessionId;
                const ownsStoredSession = storedBinding?.sdkSessionId === sdkSessionId;
                if (!ownsTrackedSession && !ownsStoredSession) {
                  return;
                }
                trackDeferredCompactionCleanup({
                  abort,
                  cleanup,
                  sessionId: openclawSessionId,
                  sdkSessionId,
                });
                // The attempt retains this SDK session until its background
                // compaction resolves. Preserve its binding for a successful
                // completion, but do not let a new turn resume it yet.
                resetBlockedStoredSessions.add(openclawSessionId);
                void cleanup.then((outcome) => {
                  const currentTracked = trackedSessions.get(openclawSessionId);
                  const currentStored = lookupStoredBinding(
                    options?.sessionStore,
                    openclawSessionId,
                  );
                  const stillOwnsTrackedSession = currentTracked?.sdkSessionId === sdkSessionId;
                  const stillOwnsStoredSession = currentStored?.sdkSessionId === sdkSessionId;
                  if (outcome === "completed") {
                    if (stillOwnsTrackedSession || stillOwnsStoredSession) {
                      resetBlockedStoredSessions.delete(openclawSessionId);
                    }
                    return;
                  }
                  if (stillOwnsTrackedSession) {
                    trackedSessions.delete(openclawSessionId);
                  }
                  if (stillOwnsStoredSession) {
                    deleteStoredBinding(options?.sessionStore, openclawSessionId);
                  }
                  if (stillOwnsTrackedSession || stillOwnsStoredSession) {
                    resetBlockedStoredSessions.add(openclawSessionId);
                  }
                });
              }
            : undefined,
        });
      })();
      inFlight.add(attemptPromise);
      try {
        return await attemptPromise;
      } finally {
        inFlight.delete(attemptPromise);
      }
    },

    async reset(params: AgentHarnessResetParams): Promise<void> {
      const openclawSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (!openclawSessionId) {
        return;
      }
      // Deferred cleanup yields while another attempt can establish a fresh
      // session. Capture the reset target first so reset never deletes that
      // replacement session or its durable binding.
      const tracked = trackedSessions.get(openclawSessionId);
      const stored = lookupStoredBinding(options?.sessionStore, openclawSessionId);
      resetBlockedStoredSessions.add(openclawSessionId);
      await abortDeferredCompactionCleanups(openclawSessionId);
      const currentStored = lookupStoredBinding(options?.sessionStore, openclawSessionId);
      const stillOwnsStoredSession =
        stored !== undefined && currentStored?.sdkSessionId === stored.sdkSessionId;
      if (stillOwnsStoredSession) {
        if (deleteStoredBinding(options?.sessionStore, openclawSessionId)) {
          resetBlockedStoredSessions.delete(openclawSessionId);
        }
      } else {
        resetBlockedStoredSessions.delete(openclawSessionId);
      }
      if (!tracked) {
        // Session was created by a different harness, or already reset.
        return;
      }
      if (trackedSessions.get(openclawSessionId)?.sdkSessionId === tracked.sdkSessionId) {
        trackedSessions.delete(openclawSessionId);
      }
      try {
        await tracked.client.deleteSession(tracked.sdkSessionId);
      } catch {
        // Best-effort: client may be stopped, session may not exist
        // server-side, or the SDK may report a transient error. The
        // registry already logs broadcast reset failures; swallow here
        // so one harness cannot block the reset broadcast.
      }
    },

    async compact(
      params: AgentHarnessCompactParams,
    ): Promise<AgentHarnessCompactResult | undefined> {
      // The SDK owns Copilot history compaction. OpenClaw only resumes
      // the tracked SDK session and calls the session-scoped RPC; durable
      // OpenClaw session/transcript state stays in SQLite, with no marker
      // sidecars under the workspace.
      const openclawSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (!openclawSessionId) {
        return {
          ok: false,
          compacted: false,
          reason: "missing-required-params",
        };
      }
      if (hasPendingDeferredCompactionCleanup(openclawSessionId)) {
        return {
          ok: false,
          compacted: false,
          reason: "background-compaction-pending",
          failure: { reason: "background-compaction-pending" },
        };
      }
      const tracked = trackedSessions.get(openclawSessionId);
      const currentCompactKey = computeSessionCompactKey(params);
      const { resolvePoolAcquire } = await import("./src/attempt.js");
      let resolvedPoolAcquire: ReturnType<typeof resolvePoolAcquire> | undefined;
      let currentAuth: CopilotSessionAuth | undefined;
      try {
        resolvedPoolAcquire = resolvePoolAcquire(params as never);
      } catch (error) {
        if (isCopilotByokUnsupportedProviderError(error)) {
          return {
            ok: false,
            compacted: false,
            reason: "missing_thread_binding",
            failure: { reason: "missing_thread_binding" },
          };
        }
        throw error;
      }
      if (!currentAuth) {
        currentAuth = sessionAuthFields(resolvedPoolAcquire.auth);
      }
      const compatibleTracked =
        tracked?.compactKey === currentCompactKey && sessionAuthMatches(tracked, currentAuth)
          ? tracked
          : undefined;
      if (!compatibleTracked) {
        // Durable bindings only carry SDK session ids. Manual SDK compaction also
        // needs the live SessionConfig with OpenClaw hooks/tools, so preserve the
        // binding for the next attempt and let the host compact transcript state.
        return {
          ok: false,
          compacted: false,
          reason: "missing_thread_binding",
          failure: { reason: "missing_thread_binding" },
        };
      }
      const poolAcquire = {
        key: compatibleTracked.poolKey,
        options: compatibleTracked.clientOptions,
      };
      let compactResult: CopilotHistoryCompactResult;
      let handle: PooledClient | undefined;
      let pool: CopilotClientPool | undefined;
      let activeSdkSession: CopilotHistoryCompactSession | undefined;
      let cleanupByokProxy: (() => Promise<void>) | undefined;
      const hookContext = buildCopilotCompactionHookContext(params);
      try {
        throwIfAborted(params.abortSignal);
        pool = await getPool();
        handle = await pool.acquire(poolAcquire.key, poolAcquire.options);
        const client = handle.client;
        const byokProxy =
          compatibleTracked.authMode === "byok" && compatibleTracked.sessionConfig.provider
            ? await createCopilotByokProxy({
                mode: "byok",
                provider: compatibleTracked.sessionConfig.provider,
              })
            : undefined;
        cleanupByokProxy = byokProxy?.close;
        const sessionConfig = byokProxy?.provider.provider
          ? { ...compatibleTracked.sessionConfig, provider: byokProxy.provider.provider }
          : compatibleTracked.sessionConfig;
        // Manual compaction resumes a distinct SDK session, bypassing the attempt event bridge.
        // Run the portable lifecycle hook here so both compaction paths stay observable.
        await runAgentHarnessBeforeCompactionHook({
          sessionFile: params.sessionFile,
          ctx: hookContext,
        });
        compactResult = await compactWithSafetyTimeout(
          (abortSignal) =>
            compactTrackedSdkSession({
              abortSignal,
              client,
              customInstructions: params.customInstructions,
              gitHubToken:
                compatibleTracked?.clientOptions.gitHubToken ??
                (resolvedPoolAcquire?.auth.authMode === "gitHubToken"
                  ? resolvedPoolAcquire.auth.gitHubToken
                  : undefined),
              onSession: (session) => {
                activeSdkSession = session;
              },
              sessionConfig,
              sdkSessionId: compatibleTracked.sdkSessionId,
            }),
          resolveCompactionTimeoutMs(
            (params as { config?: Parameters<typeof resolveCompactionTimeoutMs>[0] }).config,
          ),
          {
            abortSignal: params.abortSignal,
            onCancel: () =>
              void activeSdkSession?.rpc.history.abortManualCompaction().catch(() => undefined),
          },
        );
      } catch (err) {
        const rawError = err instanceof Error ? err.message : String(err);
        if (isStaleSdkSessionError(err)) {
          trackedSessions.delete(openclawSessionId);
          deleteStoredBinding(options?.sessionStore, openclawSessionId);
          return {
            ok: false,
            compacted: false,
            reason: "stale_thread_binding",
            failure: { reason: "stale_thread_binding", rawError },
          };
        }
        return {
          ok: false,
          compacted: false,
          reason: "copilot-sdk-history-compact-failed",
          failure: {
            reason: "copilot-sdk-history-compact-failed",
            rawError,
          },
        };
      } finally {
        await cleanupByokProxy?.();
        if (pool && handle) {
          try {
            await pool.release(handle);
          } catch {
            // Pool release failure must not mask the compaction outcome.
          }
        }
      }
      if (!compactResult.success) {
        return {
          ok: false,
          compacted: false,
          reason: "copilot-sdk-history-compact-failed",
          failure: { reason: "copilot-sdk-history-compact-failed" },
        };
      }
      const compacted = compactResult.tokensRemoved > 0 || compactResult.messagesRemoved > 0;
      if (compacted) {
        await runAgentHarnessAfterCompactionHook({
          sessionFile: params.sessionFile,
          compactedCount: compactResult.messagesRemoved,
          ctx: hookContext,
        });
      }
      return {
        ok: true,
        compacted,
        reason: compacted ? "copilot-sdk-history-compacted" : "already under target",
        ...(compacted
          ? {
              result: {
                summary: compactResult.summaryContent ?? "",
                firstKeptEntryId: "",
                tokensBefore:
                  params.currentTokenCount ??
                  (compactResult.contextWindow?.currentTokens ?? 0) + compactResult.tokensRemoved,
                tokensAfter: compactResult.contextWindow?.currentTokens,
                details: compactResult,
                sessionId: params.sessionId,
                sessionFile: params.sessionFile,
              },
            }
          : {}),
      };
    },

    async dispose() {
      if (disposePromise) {
        return disposePromise;
      }
      disposed = true;
      disposePromise = (async () => {
        if (inFlight.size > 0) {
          await Promise.allSettled(inFlight);
        }
        // Deferred compaction callbacks retain pooled clients after an attempt.
        // Cancel them before pool disposal so they cannot outlive this harness.
        const cleanupSessionIds = [...deferredCompactionCleanups.keys()];
        for (const sessionId of cleanupSessionIds) {
          await abortDeferredCompactionCleanups(sessionId);
        }
        trackedSessions.clear();
        resetBlockedStoredSessions.clear();
        if (createdPool) {
          const errors = await createdPool.dispose();
          if (errors.length > 0) {
            throw new AggregateError(errors, "[copilot] pool disposal errors");
          }
        }
      })();
      return disposePromise;
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
