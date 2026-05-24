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

// One entry per configured agent, keyed by agentId. Populated by
// warmCurrentProviderAuthState at gateway startup / on reload; consulted by
// hasAuthForModelProvider on every model-listing call.
let currentProviderAuthStates: ReadonlyMap<string, PreparedProviderAuthState> | null = null;
const configFingerprintCache = new WeakMap<OpenClawConfig, string>();
// Generation counter guards against an in-flight warm publishing stale
// state after a subsequent warm or clear has invalidated it.
let currentProviderAuthStateGeneration = 0;

export function clearCurrentProviderAuthState(): void {
  currentProviderAuthStates = null;
  currentProviderAuthStateGeneration += 1;
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
  // The prepared map is built by warmCurrentProviderAuthState — one entry per
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
  const catalog = await loadModelCatalog({ config: cfg, readOnly: true });
  if (isWarmStale()) {
    return;
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
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);
    const runtimeAuthLookup = createRuntimeProviderAuthLookup({
      cfg,
      workspaceDir,
    });
    // One AuthProfileStore scoped to every candidate provider; without this
    // the per-provider externalCli discovery rebuilds the store ~N times.
    const store = ensureAuthProfileStore(agentDir, {
      config: cfg,
      externalCli: externalCliDiscoveryForProviders({
        cfg,
        providers: providerList,
      }),
    });
    const state = new Map<string, boolean>();
    for (const provider of providers) {
      if (isWarmStale()) {
        return;
      }
      const value = await hasAuthForModelProvider({
        provider,
        cfg,
        workspaceDir,
        agentId,
        store,
        runtimeAuthLookup,
      });
      state.set(provider, value);
    }
    states.set(agentId, {
      agentId,
      configFingerprint,
      providers: state,
    });
  }
  if (options.isCancelled?.() || ownGeneration !== currentProviderAuthStateGeneration) {
    // A newer warm or clear ran while we were building; skip publication so
    // the newer answer wins.
    return;
  }
  currentProviderAuthStates = states;
}
