import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  createRuntimeProviderAuthLookup,
  hasRuntimeAvailableProviderAuth,
  type RuntimeProviderAuthLookup,
} from "./model-auth.js";
import { loadModelCatalog } from "./model-catalog.js";
import { normalizeProviderId } from "./model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

// Prepared runtime fact: which providers have available auth given the
// current cfg + env. Populated explicitly at gateway startup and on config
// reload; consulted by hasAuthForModelProvider so every model-listing call
// (pickers, /models, status commands, CLI) skips the per-provider plugin
// discovery and external-CLI probing on the hot path.

type PreparedProviderAuthState = {
  agentId: string;
  configFingerprint: string;
  providers: ReadonlyMap<string, boolean>;
};

export type ProviderAuthWarmSnapshot = {
  agents: Array<{
    agentId: string;
    configFingerprint: string;
    providers: Array<[string, boolean]>;
  }>;
};

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

// One entry per configured agent, keyed by agentId. Populated by the provider
// auth warm path; consulted by hasAuthForModelProvider on every model-listing call.
let currentProviderAuthStates: ReadonlyMap<string, PreparedProviderAuthState> | null = null;
const configFingerprintCache = new WeakMap<OpenClawConfig, string>();
// Generation counter guards against an in-flight warm publishing stale
// state after a subsequent warm or clear has invalidated it.
let currentProviderAuthStateGeneration = 0;
let currentProviderAuthWarmWorker:
  | {
      worker: Worker;
      cancelled: boolean;
    }
  | undefined;

function cancelCurrentProviderAuthWarmWorker(): void {
  const current = currentProviderAuthWarmWorker;
  if (!current) {
    return;
  }
  current.cancelled = true;
  currentProviderAuthWarmWorker = undefined;
  void current.worker.terminate();
}

export function clearCurrentProviderAuthState(): void {
  currentProviderAuthStates = null;
  currentProviderAuthStateGeneration += 1;
  cancelCurrentProviderAuthWarmWorker();
}

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

export async function hasAuthForModelProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  store?: AuthProfileStore;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
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
  const preparedStates = currentProviderAuthStates;
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
  const matchesWarmedScope =
    preparedState !== null &&
    configFingerprint === preparedState.configFingerprint &&
    workspaceDir === expectedWorkspaceDir &&
    params.discoverExternalCliAuth !== false &&
    params.allowPluginSyntheticAuth !== false &&
    params.env === undefined &&
    params.store === undefined;
  if (matchesWarmedScope) {
    const preparedAnswer = preparedState.providers.get(provider);
    if (preparedAnswer !== undefined) {
      return preparedAnswer;
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (
    hasRuntimeAvailableProviderAuth({
      provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
      runtimeLookup: params.runtimeAuthLookup ?? params.resolveRuntimeAuthLookup?.(),
    })
  ) {
    return true;
  }
  const slowPathAgentDir =
    params.agentId && params.cfg ? resolveAgentDir(params.cfg, params.agentId) : undefined;
  const store =
    params.store ??
    (params.discoverExternalCliAuth === false
      ? ensureAuthProfileStoreWithoutExternalProfiles(slowPathAgentDir, {
          allowKeychainPrompt: false,
        })
      : ensureAuthProfileStore(slowPathAgentDir, {
          externalCli: externalCliDiscoveryForProviderAuth({ cfg: params.cfg, provider }),
        }));
  if (listProfilesForProvider(store, provider).length > 0) {
    return true;
  }
  return false;
}

export function createProviderAuthChecker(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
}): (provider: string) => Promise<boolean> {
  const authCache = new Map<string, boolean>();
  let runtimeAuthLookup: RuntimeProviderAuthLookup | undefined;
  return async (provider: string) => {
    const key = normalizeProviderId(provider);
    const cached = authCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = await hasAuthForModelProvider({
      provider: key,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
      discoverExternalCliAuth: params.discoverExternalCliAuth,
      resolveRuntimeAuthLookup: () =>
        (runtimeAuthLookup ??= createRuntimeProviderAuthLookup({
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          env: params.env,
          includePluginSyntheticAuth: params.allowPluginSyntheticAuth !== false,
        })),
    });
    authCache.set(key, value);
    return value;
  };
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

function publishProviderAuthWarmSnapshot(snapshot: ProviderAuthWarmSnapshot): void {
  currentProviderAuthStates = new Map(
    snapshot.agents.map((state) => [
      state.agentId,
      {
        agentId: state.agentId,
        configFingerprint: state.configFingerprint,
        providers: new Map(state.providers),
      },
    ]),
  );
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
  const catalog = await loadModelCatalog({ config: cfg, readOnly: true });
  if (isWarmStale()) {
    return { agents: [] };
  }
  const providers = new Set<string>();
  for (const entry of catalog) {
    providers.add(normalizeProviderId(entry.provider));
  }
  const providerList = [...providers];
  const configFingerprint = resolveProviderAuthConfigFingerprint(cfg) ?? "";
  const states = new Map<string, PreparedProviderAuthState>();
  // Warm one entry per configured agent so callers hit the prepared map for
  // any agentId. The catalog above is shared across agents; the per-agent
  // work is the auth-discovery sweep against that agent's store.
  for (const agentId of listAgentIds(cfg)) {
    if (isWarmStale()) {
      return { agents: [] };
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);
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

export async function warmCurrentProviderAuthState(
  cfg: OpenClawConfig,
  options: { isCancelled?: () => boolean } = {},
): Promise<void> {
  // Claim a fresh generation; any concurrent warm or clear bumps this and
  // turns our published state stale.
  currentProviderAuthStateGeneration += 1;
  const ownGeneration = currentProviderAuthStateGeneration;
  const isWarmStale = () =>
    options.isCancelled?.() === true || ownGeneration !== currentProviderAuthStateGeneration;
  const snapshot = await buildCurrentProviderAuthStateSnapshot(cfg, {
    isCancelled: isWarmStale,
  });
  if (isWarmStale()) {
    return;
  }
  if (options.isCancelled?.() || ownGeneration !== currentProviderAuthStateGeneration) {
    // A newer warm or clear ran while we were building; skip publication so
    // the newer answer wins.
    return;
  }
  publishProviderAuthWarmSnapshot(snapshot);
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
  return {
    version: store.version,
    profiles,
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
  currentProviderAuthWarmWorker = handle;
  return new Promise<ProviderAuthWarmSnapshot>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setInterval> | undefined;
    const finish = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (currentProviderAuthWarmWorker === handle) {
        currentProviderAuthWarmWorker = undefined;
      }
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
    timer = setTimeout(() => {
      handle.cancelled = true;
      void worker.terminate();
      finish(() => reject(new Error("provider auth warm worker timed out")));
    }, params.timeoutMs);
    timer.unref?.();
    cancelTimer = setInterval(() => {
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
        reject(error);
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

export async function warmCurrentProviderAuthStateOffMainThread(
  cfg: OpenClawConfig,
  options: {
    isCancelled?: () => boolean;
    timeoutMs?: number;
    workerUrl?: URL;
    runWorker?: ProviderAuthWarmWorkerRunner;
  } = {},
): Promise<void> {
  currentProviderAuthStateGeneration += 1;
  const ownGeneration = currentProviderAuthStateGeneration;
  cancelCurrentProviderAuthWarmWorker();
  const isWarmStale = () =>
    options.isCancelled?.() === true || ownGeneration !== currentProviderAuthStateGeneration;
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
