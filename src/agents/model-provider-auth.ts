/**
 * Warms and queries provider-auth availability for model catalogs. The module
 * keeps per-agent auth snapshots process-current so model listing can avoid
 * repeated env/profile/plugin discovery on hot paths.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope-config.js";
import {
  externalCliDiscoveryForProviderAuth,
  externalCliDiscoveryForProviders,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  getRuntimeAuthProfileStoreSnapshot,
  listProfilesForProvider,
  type AuthProfileStore,
} from "./auth-profiles.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
  type ModelAuthAvailabilityRef,
  type ModelAuthAvailabilityResolver,
} from "./model-auth-availability.js";
import {
  createRuntimeProviderAuthLookup,
  hasAvailableAuthForProvider,
  hasRuntimeAvailableProviderAuth,
  type RuntimeProviderAuthLookup,
} from "./model-auth.js";
import {
  cancelCurrentProviderAuthWarmWorker,
  claimCurrentProviderAuthStateGeneration,
  clearCurrentProviderAuthState,
  clearCurrentProviderAuthWarmWorker,
  getCurrentProviderAuthStates,
  isCurrentProviderAuthStateGeneration,
  publishProviderAuthWarmSnapshot,
  setCurrentProviderAuthWarmWorker,
  type PreparedProviderAuthState,
  type ProviderAuthWarmSnapshot,
} from "./model-provider-auth-state.js";
import { normalizeProviderId } from "./model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

type ProviderAuthWarmWorkerResult =
  | {
      status: "ok";
      snapshot: ProviderAuthWarmSnapshot;
    }
  | {
      status: "failed";
      error: string;
    };

type ProviderAuthWarmRuntimeAuthStore = {
  agentDir?: string;
  store: AuthProfileStore;
};

type ProviderAuthWarmRuntimeAuthLookup = {
  agentId: string;
  lookup: RuntimeProviderAuthLookup;
};

type ProviderAuthWarmWorkerRunner = (params: {
  cfg: OpenClawConfig;
  runtimeAuthStores?: ProviderAuthWarmRuntimeAuthStore[];
  runtimeAuthLookups?: ProviderAuthWarmRuntimeAuthLookup[];
  omitFalseProviderAuth?: boolean;
  timeoutMs: number;
  isCancelled: () => boolean;
  workerUrl?: URL;
}) => Promise<ProviderAuthWarmSnapshot>;

const PROVIDER_AUTH_WARM_WORKER_TIMEOUT_MS = 120_000;
const PROVIDER_AUTH_WARM_CANCEL_POLL_MS = 25;

const configFingerprintCache = new WeakMap<OpenClawConfig, string>();
/** Clears process-current warmed provider auth state. */
export { clearCurrentProviderAuthState };

function resolvePreparedStateForCaller(params: {
  states: ReadonlyMap<string, PreparedProviderAuthState> | null;
  cfg: OpenClawConfig | undefined;
  callerAgentId: string | undefined;
}): PreparedProviderAuthState | null {
  if (!params.states) {
    return null;
  }
  if (params.callerAgentId !== undefined) {
    return params.states.get(params.callerAgentId) ?? null;
  }
  // Caller didn't pass agentId: treat as a query against the default agent.
  if (!params.cfg) {
    return null;
  }
  return params.states.get(resolveDefaultAgentId(params.cfg)) ?? null;
}

function resolveProviderAuthConfigFingerprint(cfg: OpenClawConfig | undefined): string | null {
  if (!cfg) {
    return null;
  }
  const cached = configFingerprintCache.get(cfg);
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = hashRuntimeConfigValue(cfg);
  configFingerprintCache.set(cfg, fingerprint);
  return fingerprint;
}

/** Resolves whether auth is available for a model provider in the caller's runtime scope. */
export async function hasAuthForModelProvider(params: {
  provider: string;
  modelApi?: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  store?: AuthProfileStore;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
  allowPreparedRuntimeAuth?: boolean;
  runtimeAuthLookup?: RuntimeProviderAuthLookup;
  resolveRuntimeAuthLookup?: () => RuntimeProviderAuthLookup;
}): Promise<boolean> {
  const provider = normalizeProviderId(params.provider);
  // The prepared map is built by the provider auth warm path — one entry per
  // configured agent, keyed by agentId. Only consult it when the caller's
  // full auth context matches the warmed scope; otherwise fall through to
  // compute so callers that narrow the scope — e.g. gateway `models.list`
  // with `runtimeAuthDiscovery: false`, or callers with a non-warmed
  // workspaceDir — get the answer they asked for.
  const preparedStates = getCurrentProviderAuthStates();
  const workspaceDir = params.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const configFingerprint = resolveProviderAuthConfigFingerprint(params.cfg);
  const preparedState = resolvePreparedStateForCaller({
    states: preparedStates,
    cfg: params.cfg,
    callerAgentId: params.agentId,
  });
  // workspaceDir is a pure function of (cfg, agentId), so we recompute the
  // warmer's expected value at read time rather than storing it. Caller can
  // still override workspaceDir explicitly — that forces a mismatch and
  // falls through to the compute path.
  const expectedWorkspaceDir =
    preparedState !== null && params.cfg
      ? resolveAgentWorkspaceDir(params.cfg, preparedState.agentId)
      : null;
  const expectedAgentDir =
    preparedState !== null && params.cfg
      ? resolveAgentDir(params.cfg, preparedState.agentId)
      : null;
  const matchesWarmedScope =
    preparedState !== null &&
    configFingerprint === preparedState.configFingerprint &&
    workspaceDir === expectedWorkspaceDir &&
    (params.agentDir === undefined || params.agentDir === expectedAgentDir) &&
    (params.allowPreparedRuntimeAuth === true ||
      (params.discoverExternalCliAuth !== false && params.allowPluginSyntheticAuth !== false)) &&
    params.env === undefined &&
    params.store === undefined &&
    params.modelApi === undefined;
  if (matchesWarmedScope) {
    const preparedAnswer = preparedState.providers.get(provider);
    if (preparedAnswer !== undefined) {
      return preparedAnswer;
    }
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const slowPathAgentDir =
    params.agentDir ??
    (params.agentId && params.cfg
      ? resolveAgentDir(params.cfg, params.agentId, params.env)
      : undefined);
  const store =
    params.store ??
    (params.discoverExternalCliAuth === false
      ? ensureAuthProfileStoreWithoutExternalProfiles(slowPathAgentDir, {
          allowKeychainPrompt: false,
        })
      : ensureAuthProfileStore(slowPathAgentDir, {
          externalCli: externalCliDiscoveryForProviderAuth({ cfg: params.cfg, provider }),
        }));

  if (
    hasRuntimeAvailableProviderAuth({
      provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
      runtimeLookup: params.runtimeAuthLookup ?? params.resolveRuntimeAuthLookup?.(),
      modelApi: params.modelApi,
      store,
    })
  ) {
    return true;
  }
  if (listProfilesForProvider(store, provider).length > 0) {
    return params.modelApi === undefined
      ? true
      : await hasAvailableAuthForProvider({
          provider,
          modelApi: params.modelApi,
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          agentDir: slowPathAgentDir,
          store,
        });
  }
  return false;
}

export type ProviderModelAuthChecker = ((
  provider: string,
  ref?: ModelAuthAvailabilityRef,
) => Promise<boolean>) & {
  evaluateModelAuth(
    provider: string,
    ref?: ModelAuthAvailabilityRef,
  ): Promise<ModelAuthAvailabilityEvaluation>;
};

/** Creates a cached provider-auth evaluator bound to one agent/runtime context. */
export function createProviderAuthChecker(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
  allowPreparedRuntimeAuth?: boolean;
}): ProviderModelAuthChecker {
  const authCache = new Map<string, Promise<ModelAuthAvailabilityEvaluation>>();
  let runtimeAuthLookup: RuntimeProviderAuthLookup | undefined;
  let modelAuthResolver: ModelAuthAvailabilityResolver | undefined;
  const resolveModelAuthResolver = () => {
    if (modelAuthResolver) {
      return modelAuthResolver;
    }
    const agentDir =
      params.agentDir ??
      (params.agentId && params.cfg
        ? resolveAgentDir(params.cfg, params.agentId, params.env)
        : undefined);
    const authStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
      allowKeychainPrompt: false,
    });
    runtimeAuthLookup ??= createRuntimeProviderAuthLookup({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      includePluginSyntheticAuth: params.allowPluginSyntheticAuth !== false,
    });
    modelAuthResolver = createModelAuthAvailabilityResolver({
      cfg: params.cfg ?? {},
      authStore,
      agentDir,
      workspaceDir: params.workspaceDir,
      env: params.env,
      skipSetupProviderFallback: true,
      allowPreparedRuntimeAuth:
        params.allowPreparedRuntimeAuth === true ||
        (params.discoverExternalCliAuth !== false && params.allowPluginSyntheticAuth !== false),
      syntheticAuthProviderRefs: runtimeAuthLookup.syntheticAuthProviderRefs,
      ...(params.discoverExternalCliAuth === false ? {} : { externalCliProviderIds: ["openai"] }),
    });
    return modelAuthResolver;
  };
  const evaluateModelAuth = (
    provider: string,
    ref: ModelAuthAvailabilityRef = {},
  ): Promise<ModelAuthAvailabilityEvaluation> => {
    const key = normalizeProviderId(provider);
    const hasRouteFacts =
      ref.modelId !== undefined ||
      ref.api !== undefined ||
      ref.baseUrl !== undefined ||
      ref.observedRoutes !== undefined;
    const cacheKey = hasRouteFacts
      ? `${key}\0${hashRuntimeConfigValue(ref as unknown as OpenClawConfig)}`
      : key;
    const cached = authCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const resolveLegacyProviderAuth = () =>
      hasAuthForModelProvider({
        provider: key,
        modelApi: typeof ref.api === "string" ? ref.api : undefined,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        agentId: params.agentId,
        env: params.env,
        allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
        discoverExternalCliAuth: params.discoverExternalCliAuth,
        allowPreparedRuntimeAuth: params.allowPreparedRuntimeAuth,
        resolveRuntimeAuthLookup: () =>
          (runtimeAuthLookup ??= createRuntimeProviderAuthLookup({
            cfg: params.cfg,
            workspaceDir: params.workspaceDir,
            env: params.env,
            includePluginSyntheticAuth: params.allowPluginSyntheticAuth !== false,
          })),
      });
    const evaluation = Promise.resolve().then(
      async (): Promise<ModelAuthAvailabilityEvaluation> => {
        if (hasRouteFacts) {
          return resolveModelAuthResolver().evaluateModelAuth(key, ref);
        }
        return {
          availability: await resolveLegacyProviderAuth(),
          routeResolution: null,
        };
      },
    );
    authCache.set(cacheKey, evaluation);
    void evaluation.catch(() => {
      if (authCache.get(cacheKey) === evaluation) {
        authCache.delete(cacheKey);
      }
    });
    return evaluation;
  };
  return Object.assign(
    async (provider: string, ref: ModelAuthAvailabilityRef = {}) =>
      (await evaluateModelAuth(provider, ref)).availability === true,
    { evaluateModelAuth },
  );
}

function serializeProviderAuthStates(
  states: ReadonlyMap<string, PreparedProviderAuthState>,
): ProviderAuthWarmSnapshot {
  return {
    agents: [...states.values()].map((state) => ({
      agentId: state.agentId,
      configFingerprint: state.configFingerprint,
      providers: [...state.providers.entries()],
    })),
  };
}

function resolveProviderConfigApi(
  cfg: OpenClawConfig | undefined,
  provider: string,
): string | undefined {
  const providers = cfg?.models?.providers ?? {};
  const direct = providers[provider];
  if (direct?.api) {
    return direct.api;
  }
  const normalized = normalizeProviderId(provider);
  const matched = Object.entries(providers).find(
    ([key]) => normalizeProviderId(key) === normalized,
  )?.[1];
  return matched?.api;
}

function shouldOmitFalsePreparedAuthForProcessSyntheticProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  runtimeAuthLookup: RuntimeProviderAuthLookup;
}): boolean {
  const syntheticRefs = params.runtimeAuthLookup.syntheticAuthProviderRefs;
  if (!syntheticRefs?.length) {
    return false;
  }
  const eligibleRefs = new Set(syntheticRefs.map((ref) => normalizeProviderId(ref)));
  const providerApi = resolveProviderConfigApi(params.cfg, params.provider);
  return [params.provider, providerApi]
    .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
    .some((ref) => eligibleRefs.has(normalizeProviderId(ref)));
}

/** Builds a provider auth snapshot for every configured agent. */
export async function buildCurrentProviderAuthStateSnapshot(
  cfg: OpenClawConfig,
  options: {
    isCancelled?: () => boolean;
    readOnlyAuthStore?: boolean;
    runtimeAuthLookups?: ReadonlyMap<string, RuntimeProviderAuthLookup>;
    omitFalseProviderAuth?: boolean;
  } = {},
): Promise<ProviderAuthWarmSnapshot> {
  const isWarmStale = () => options.isCancelled?.() === true;
  const configFingerprint = resolveProviderAuthConfigFingerprint(cfg) ?? "";
  const states = new Map<string, PreparedProviderAuthState>();
  // Catalog generations are agent-scoped because provider plugins and auth stores can differ.
  // Keep each auth snapshot paired with the same lifecycle owner that supplied its model rows.
  for (const agentId of listAgentIds(cfg)) {
    if (isWarmStale()) {
      return { agents: [] };
    }
    const agentDir = resolveAgentDir(cfg, agentId);
    // Worker warmup is the only path that may need to construct a read-only catalog generation.
    // Keep the lifecycle graph out of foreground provider-auth module initialization.
    const { loadPreparedModelCatalogOwnerSnapshot } = await import("./prepared-model-catalog.js");
    const preparedOwner = await loadPreparedModelCatalogOwnerSnapshot({
      config: cfg,
      agentId,
      agentDir,
      readOnly: true,
    });
    const workspaceDir = preparedOwner.workspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId);
    const catalog = preparedOwner.modelCatalog.entries;
    if (isWarmStale()) {
      return { agents: [] };
    }
    const providers = new Set(catalog.map((entry) => normalizeProviderId(entry.provider)));
    const providerList = [...providers];
    const runtimeAuthLookup =
      options.runtimeAuthLookups?.get(agentId) ??
      createRuntimeProviderAuthLookup({
        cfg,
        workspaceDir,
      });
    // One AuthProfileStore scoped to every candidate provider; without this
    // the per-provider externalCli discovery rebuilds the store ~N times.
    const externalCli = externalCliDiscoveryForProviders({
      cfg,
      providers: providerList,
    });
    const store = options.readOnlyAuthStore
      ? ensureAuthProfileStore(agentDir, {
          config: cfg,
          externalCli,
          readOnly: true,
          syncExternalCli: false,
        })
      : ensureAuthProfileStore(agentDir, {
          config: cfg,
          externalCli,
        });
    const state = new Map<string, boolean>();
    for (const provider of providers) {
      if (isWarmStale()) {
        return { agents: [] };
      }
      const value = await hasAuthForModelProvider({
        provider,
        cfg,
        workspaceDir,
        agentId,
        store,
        runtimeAuthLookup,
      });
      if (
        !value &&
        (options.omitFalseProviderAuth ||
          shouldOmitFalsePreparedAuthForProcessSyntheticProvider({
            cfg,
            provider,
            runtimeAuthLookup,
          }))
      ) {
        continue;
      }
      state.set(provider, value);
    }
    states.set(agentId, {
      agentId,
      configFingerprint,
      providers: state,
    });
  }
  return serializeProviderAuthStates(states);
}

function resolveProviderAuthWarmWorkerUrl(currentModuleUrl: string): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const distMarker = `${path.sep}dist${path.sep}`;
  const distIndex = currentPath.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length - 1);
    return pathToFileURL(path.join(distRoot, "agents", "model-provider-auth.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./model-provider-auth.worker${extension}`, currentModuleUrl);
}

function isProviderAuthWarmSnapshot(value: unknown): value is ProviderAuthWarmSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { agents?: unknown }).agents)
  ) {
    return false;
  }
  return (value as ProviderAuthWarmSnapshot).agents.every(
    (agent) =>
      typeof agent.agentId === "string" &&
      typeof agent.configFingerprint === "string" &&
      Array.isArray(agent.providers) &&
      agent.providers.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "boolean",
      ),
  );
}

function isProviderAuthWarmWorkerResult(value: unknown): value is ProviderAuthWarmWorkerResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as ProviderAuthWarmWorkerResult;
  if (result.status === "failed") {
    return typeof result.error === "string";
  }
  return result.status === "ok" && isProviderAuthWarmSnapshot(result.snapshot);
}

function createProviderAuthWarmPresenceStore(store: AuthProfileStore): AuthProfileStore {
  const profiles: AuthProfileStore["profiles"] = {};
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    profiles[profileId] = {
      type: "api_key",
      provider: credential.provider,
    };
  }
  const usageStats: AuthProfileStore["usageStats"] = {};
  if (store.usageStats) {
    for (const [id, stats] of Object.entries(store.usageStats)) {
      if (id.startsWith("inline-api-key:")) {
        usageStats[id] = stats;
      }
    }
  }
  return {
    version: store.version,
    profiles,
    usageStats,
  };
}

function collectProviderAuthWarmRuntimeAuthStores(
  cfg: OpenClawConfig,
): ProviderAuthWarmRuntimeAuthStore[] {
  const entries: ProviderAuthWarmRuntimeAuthStore[] = [];
  const seen = new Set<string | undefined>();
  const addStore = (agentDir?: string) => {
    if (seen.has(agentDir)) {
      return;
    }
    seen.add(agentDir);
    const store = getRuntimeAuthProfileStoreSnapshot(agentDir);
    if (!store) {
      return;
    }
    entries.push({
      ...(agentDir === undefined ? {} : { agentDir }),
      store: createProviderAuthWarmPresenceStore(store),
    });
  };

  addStore();
  for (const agentId of listAgentIds(cfg)) {
    addStore(resolveAgentDir(cfg, agentId));
  }
  return entries;
}

function collectProviderAuthWarmRuntimeAuthLookups(cfg: OpenClawConfig): {
  entries: ProviderAuthWarmRuntimeAuthLookup[];
  omitFalseProviderAuth: boolean;
} {
  const entries: ProviderAuthWarmRuntimeAuthLookup[] = [];
  let omitFalseProviderAuth = false;
  for (const agentId of listAgentIds(cfg)) {
    const lookup = createRuntimeProviderAuthLookup({
      cfg,
      workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    });
    if (lookup.syntheticAuthProviderRefsComplete === false) {
      omitFalseProviderAuth = true;
    }
    entries.push({ agentId, lookup });
  }
  return { entries, omitFalseProviderAuth };
}

function runProviderAuthWarmWorker(params: {
  cfg: OpenClawConfig;
  runtimeAuthStores?: ProviderAuthWarmRuntimeAuthStore[];
  runtimeAuthLookups?: ProviderAuthWarmRuntimeAuthLookup[];
  omitFalseProviderAuth?: boolean;
  timeoutMs: number;
  isCancelled: () => boolean;
  workerUrl?: URL;
}): Promise<ProviderAuthWarmSnapshot> {
  const worker = new Worker(params.workerUrl ?? resolveProviderAuthWarmWorkerUrl(import.meta.url), {
    workerData: {
      cfg: params.cfg,
      ...(params.runtimeAuthStores?.length ? { runtimeAuthStores: params.runtimeAuthStores } : {}),
      ...(params.runtimeAuthLookups?.length
        ? { runtimeAuthLookups: params.runtimeAuthLookups }
        : {}),
      ...(params.omitFalseProviderAuth ? { omitFalseProviderAuth: true } : {}),
    },
  });
  worker.unref?.();
  const handle = {
    worker,
    cancelled: false,
  };
  setCurrentProviderAuthWarmWorker(handle);
  return new Promise<ProviderAuthWarmSnapshot>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearCurrentProviderAuthWarmWorker(handle);
      if (timer) {
        clearTimeout(timer);
      }
      if (cancelTimer) {
        clearInterval(cancelTimer);
      }
      complete();
    };
    const cancelWorker = () => {
      handle.cancelled = true;
      void worker.terminate();
      finish(() => resolve({ agents: [] }));
    };
    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      handle.cancelled = true;
      void worker.terminate();
      finish(() => reject(new Error("provider auth warm worker timed out")));
    }, params.timeoutMs);
    timer.unref?.();
    const cancelTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      if (params.isCancelled()) {
        cancelWorker();
      }
    }, PROVIDER_AUTH_WARM_CANCEL_POLL_MS);
    cancelTimer.unref?.();
    worker.once("message", (message: unknown) => {
      void worker.terminate();
      finish(() => {
        if (handle.cancelled) {
          resolve({ agents: [] });
          return;
        }
        if (!isProviderAuthWarmWorkerResult(message)) {
          reject(new Error("invalid provider auth warm worker response"));
          return;
        }
        if (message.status === "failed") {
          reject(new Error(message.error));
          return;
        }
        resolve(message.snapshot);
      });
    });
    worker.once("error", (error) => {
      finish(() => {
        if (handle.cancelled) {
          resolve({ agents: [] });
          return;
        }
        reject(toErrorObject(error, "Non-Error rejection"));
      });
    });
    worker.once("exit", (code) => {
      if (settled || code === 0) {
        return;
      }
      finish(() => {
        if (handle.cancelled) {
          resolve({ agents: [] });
          return;
        }
        reject(new Error(`provider auth warm worker exited with code ${code}`));
      });
    });
    if (params.isCancelled()) {
      cancelWorker();
    }
  });
}

/** Warms process-current provider auth state in a worker thread. */
export async function warmCurrentProviderAuthStateOffMainThread(
  cfg: OpenClawConfig,
  options: {
    isCancelled?: () => boolean;
    timeoutMs?: number;
    workerUrl?: URL;
    runWorker?: ProviderAuthWarmWorkerRunner;
  } = {},
): Promise<void> {
  const ownGeneration = claimCurrentProviderAuthStateGeneration();
  cancelCurrentProviderAuthWarmWorker();
  const isWarmStale = () =>
    options.isCancelled?.() === true || !isCurrentProviderAuthStateGeneration(ownGeneration);
  if (isWarmStale()) {
    return;
  }
  const runtimeAuthStores = collectProviderAuthWarmRuntimeAuthStores(cfg);
  const runtimeAuthLookups = collectProviderAuthWarmRuntimeAuthLookups(cfg);
  const snapshot = await (options.runWorker ?? runProviderAuthWarmWorker)({
    cfg,
    ...(runtimeAuthStores.length ? { runtimeAuthStores } : {}),
    ...(runtimeAuthLookups.entries.length
      ? { runtimeAuthLookups: runtimeAuthLookups.entries }
      : {}),
    ...(runtimeAuthLookups.omitFalseProviderAuth ? { omitFalseProviderAuth: true } : {}),
    timeoutMs: options.timeoutMs ?? PROVIDER_AUTH_WARM_WORKER_TIMEOUT_MS,
    isCancelled: isWarmStale,
    workerUrl: options.workerUrl,
  });
  if (isWarmStale()) {
    return;
  }
  publishProviderAuthWarmSnapshot(snapshot);
}
