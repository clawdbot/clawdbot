/** Holds active secrets runtime snapshots, refresh context, and cleanup hooks. */
import { isDeepStrictEqual } from "node:util";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreCredentialMutationToken,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreProfileSetMutationToken,
  getRuntimeAuthProfileStoreStateMutationToken,
  listRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { RuntimeAuthProfileStoreMutationToken } from "../agents/auth-profiles/runtime-snapshots.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  RuntimeAuthProfileStore,
} from "../agents/auth-profiles/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSourceSnapshotIfCurrent,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  type RuntimeConfigSnapshotRefreshHandler,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, isSecretRef, type SecretRef } from "../config/types.secrets.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { isRecord } from "../utils.js";
import type { SecretResolverWarning } from "./runtime-shared.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  setActiveRuntimeWebToolsMetadata,
} from "./runtime-web-tools-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

/** Prepared secrets runtime snapshot activated for fast secret resolution. */
export type PreparedSecretsRuntimeSnapshot = {
  sourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: RuntimeAuthProfileStore }>;
  authStoreCredentialsRevision: number;
  warnings: SecretResolverWarning[];
  webTools: RuntimeWebToolsMetadata;
};

/** Context needed to refresh active secrets runtime snapshots without losing plugin origin data. */
export type SecretsRuntimeRefreshContext = {
  env: Record<string, string | undefined>;
  explicitAgentDirs: string[] | null;
  includeAuthStoreRefs: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  loadablePluginOrigins: ReadonlyMap<string, PluginOrigin>;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
};

let activeSnapshot: PreparedSecretsRuntimeSnapshot | null = null;
let activeSnapshotRevision = 0;
let activeSnapshotLineageStartRevision = 0;
// Capture auth truth at candidate publication; descendant credential refreshes keep this base so
// rollback can distinguish pre-activation auth writes from candidate-owned resolved values.
let activeSnapshotLineageAuthStores: PreparedSecretsRuntimeSnapshot["authStores"] = [];
let activeSnapshotLineageAuthMutations: Record<
  string,
  {
    store: {
      baseline: StoreMutationLineage;
      candidate: StoreMutationLineage;
    };
    state: { token: RuntimeAuthProfileStoreMutationToken; includeMain: boolean };
    profiles: Record<
      string,
      {
        baseline: ProfileOwnerMutationLineage;
        candidate: ProfileOwnerMutationLineage;
      }
    >;
  }
> = {};
let activeRefreshContext: SecretsRuntimeRefreshContext | null = null;
const clearHooks = new Set<() => void>();
const preparedSnapshotRefreshContext = new WeakMap<
  PreparedSecretsRuntimeSnapshot,
  SecretsRuntimeRefreshContext
>();

type ProfileOwner = "absent" | "external" | "inherited" | "local";
type ProfileOwnerMutationLineage = {
  owner: ProfileOwner;
  token: RuntimeAuthProfileStoreMutationToken;
};
type StoreMutationLineage = {
  mainProfileSetToken?: RuntimeAuthProfileStoreMutationToken;
  token: RuntimeAuthProfileStoreMutationToken;
};

/**
 * Clones refresh context while preserving callback identity and isolating mutable maps/config.
 */
function cloneSecretsRuntimeRefreshContext(
  context: SecretsRuntimeRefreshContext,
): SecretsRuntimeRefreshContext {
  const cloned: SecretsRuntimeRefreshContext = {
    env: { ...context.env },
    explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
    includeAuthStoreRefs: context.includeAuthStoreRefs,
    loadablePluginOrigins: new Map(context.loadablePluginOrigins),
    ...(context.manifestRegistry
      ? { manifestRegistry: structuredClone(context.manifestRegistry) }
      : {}),
  };
  if (context.loadAuthStore) {
    cloned.loadAuthStore = context.loadAuthStore;
  }
  return cloned;
}

function cloneSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: structuredClone(snapshot.sourceConfig),
    config: structuredClone(snapshot.config),
    authStores: snapshot.authStores.map((entry) => ({
      agentDir: entry.agentDir,
      store: structuredClone(entry.store),
    })),
    authStoreCredentialsRevision: snapshot.authStoreCredentialsRevision,
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
    webTools: structuredClone(snapshot.webTools),
  };
}

function mergeLiveAuthStoreBookkeeping(
  authStores: PreparedSecretsRuntimeSnapshot["authStores"],
): PreparedSecretsRuntimeSnapshot["authStores"] {
  return authStores.map((entry) => {
    const live = getRuntimeAuthProfileStoreSnapshot(entry.agentDir);
    if (!live) {
      return entry;
    }
    return {
      agentDir: entry.agentDir,
      store: {
        ...entry.store,
        order: live.order,
        lastGood: live.lastGood,
        usageStats: live.usageStats,
      },
    };
  });
}

function profileOwner(store: RuntimeAuthProfileStore | undefined, profileId: string): ProfileOwner {
  if (!store?.profiles[profileId]) {
    return "absent";
  }
  if (store.runtimeExternalProfileIds?.includes(profileId)) {
    return "external";
  }
  return store.runtimeLocalProfileIds?.includes(profileId) ? "local" : "inherited";
}

function captureProfileOwnerMutationLineage(
  agentDir: string,
  store: RuntimeAuthProfileStore | undefined,
  profileId: string,
): ProfileOwnerMutationLineage {
  const owner = profileOwner(store, profileId);
  return {
    owner,
    token:
      owner === "external"
        ? { revision: 0, known: true }
        : getRuntimeAuthProfileStoreCredentialMutationToken(agentDir, profileId, {
            includeMain: owner === "absent" || owner === "inherited",
          }),
  };
}

function captureStoreMutationLineage(
  agentDir: string,
  store: RuntimeAuthProfileStore | undefined,
): StoreMutationLineage {
  const includeMain =
    !store ||
    Object.keys(store.profiles).length === 0 ||
    Object.keys(store.profiles).some((profileId) => profileOwner(store, profileId) === "inherited");
  return {
    ...(includeMain
      ? { mainProfileSetToken: getRuntimeAuthProfileStoreProfileSetMutationToken() }
      : {}),
    token: getRuntimeAuthProfileStoreCredentialMutationToken(agentDir),
  };
}

function captureAuthStoreMutationLineage(
  baselineAuthStores: PreparedSecretsRuntimeSnapshot["authStores"],
  candidateAuthStores: PreparedSecretsRuntimeSnapshot["authStores"],
): typeof activeSnapshotLineageAuthMutations {
  const baseline = Object.fromEntries(
    baselineAuthStores.map((entry) => [entry.agentDir, entry.store]),
  );
  const candidate = Object.fromEntries(
    candidateAuthStores.map((entry) => [entry.agentDir, entry.store]),
  );
  const agentDirs = new Set([...Object.keys(baseline), ...Object.keys(candidate)]);
  return Object.fromEntries(
    [...agentDirs].map((agentDir) => {
      const baselineStore = baseline[agentDir];
      const candidateStore = candidate[agentDir];
      const effectiveStore = candidateStore ?? baselineStore;
      const profileIds = new Set([
        ...Object.keys(baselineStore?.profiles ?? {}),
        ...Object.keys(candidateStore?.profiles ?? {}),
      ]);
      return [
        agentDir,
        {
          store: {
            baseline: captureStoreMutationLineage(agentDir, baselineStore),
            candidate: captureStoreMutationLineage(agentDir, candidateStore),
          },
          state: {
            token: getRuntimeAuthProfileStoreStateMutationToken(agentDir, {
              includeMain: effectiveStore?.runtimeInheritsMainState === true,
            }),
            includeMain: effectiveStore?.runtimeInheritsMainState === true,
          },
          profiles: Object.fromEntries(
            [...profileIds].map((profileId) => [
              profileId,
              {
                baseline: captureProfileOwnerMutationLineage(agentDir, baselineStore, profileId),
                candidate: captureProfileOwnerMutationLineage(agentDir, candidateStore, profileId),
              },
            ]),
          ),
        },
      ];
    }),
  );
}

function mergeRollbackValue(previous: unknown, candidate: unknown, current: unknown): unknown {
  if (isDeepStrictEqual(candidate, current)) {
    return structuredClone(previous);
  }
  if (isDeepStrictEqual(candidate, previous)) {
    return structuredClone(current);
  }
  if (!isRecord(previous) || !isRecord(candidate) || !isRecord(current)) {
    return structuredClone(previous);
  }
  const merged: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(candidate),
    ...Object.keys(current),
  ]);
  for (const key of keys) {
    const value = mergeRollbackValue(previous[key], candidate[key], current[key]);
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function hasSameSecretProviderDefinition(ref: SecretRef, configs: OpenClawConfig[]): boolean {
  const definition = configs[0]?.secrets?.providers?.[ref.provider];
  if (
    !configs.every((config) =>
      isDeepStrictEqual(config.secrets?.providers?.[ref.provider], definition),
    )
  ) {
    return false;
  }
  if (!definition || !("pluginIntegration" in definition)) {
    return true;
  }
  // Plugin integration ownership is not fully normalized to one entry. Preserve a resolved value
  // only across an unchanged plugin/channel snapshot, or rollback can pair it with rejected owner state.
  const dependency = (config: OpenClawConfig) => ({
    plugins: config.plugins,
    channels: config.channels,
  });
  const previous = dependency(configs[0]!);
  return configs.every((config) => isDeepStrictEqual(dependency(config), previous));
}

function preserveResolvedSecretRefValues(
  source: unknown,
  currentSource: unknown,
  current: unknown,
  restored: unknown,
  sourceConfig: OpenClawConfig,
  currentSourceConfig: OpenClawConfig,
): unknown {
  const sourceRef = coerceSecretRef(source, sourceConfig.secrets?.defaults);
  if (sourceRef) {
    const currentRef = coerceSecretRef(currentSource, currentSourceConfig.secrets?.defaults);
    return currentRef &&
      isDeepStrictEqual(sourceRef, currentRef) &&
      hasSameSecretProviderDefinition(sourceRef, [sourceConfig, currentSourceConfig])
      ? structuredClone(current)
      : restored;
  }
  if (Array.isArray(source) && Array.isArray(current) && Array.isArray(restored)) {
    const next = [...restored];
    for (const [index, value] of source.entries()) {
      next[index] = preserveResolvedSecretRefValues(
        value,
        Array.isArray(currentSource) ? currentSource[index] : undefined,
        current[index],
        next[index],
        sourceConfig,
        currentSourceConfig,
      );
    }
    return next;
  }
  if (isRecord(source) && isRecord(current) && isRecord(restored)) {
    const next = { ...restored };
    for (const [key, value] of Object.entries(source)) {
      next[key] = preserveResolvedSecretRefValues(
        value,
        isRecord(currentSource) ? currentSource[key] : undefined,
        current[key],
        next[key],
        sourceConfig,
        currentSourceConfig,
      );
    }
    return next;
  }
  return restored;
}

function preserveResolvedAuthStoreSecretValues(
  previous: Record<string, AuthProfileStore>,
  candidate: Record<string, AuthProfileStore>,
  restored: Record<string, AuthProfileStore>,
  current: Record<string, AuthProfileStore>,
  previousConfig: OpenClawConfig,
  candidateConfig: OpenClawConfig,
  currentConfig: OpenClawConfig,
): Record<string, AuthProfileStore> {
  const next = structuredClone(restored);
  for (const [agentDir, store] of Object.entries(next)) {
    const previousStore = previous[agentDir];
    const candidateStore = candidate[agentDir];
    const currentStore = current[agentDir];
    if (!previousStore || !candidateStore || !currentStore) {
      continue;
    }
    for (const [profileId, credential] of Object.entries(store.profiles)) {
      const previousCredential = previousStore.profiles[profileId];
      const candidateCredential = candidateStore.profiles[profileId];
      const currentCredential = currentStore.profiles[profileId];
      if (
        credential.type === "api_key" &&
        previousCredential?.type === "api_key" &&
        candidateCredential?.type === "api_key" &&
        currentCredential?.type === "api_key" &&
        isSecretRef(credential.keyRef) &&
        isDeepStrictEqual(credential.keyRef, previousCredential.keyRef) &&
        isDeepStrictEqual(credential.keyRef, candidateCredential.keyRef) &&
        isDeepStrictEqual(credential.keyRef, currentCredential.keyRef) &&
        hasSameSecretProviderDefinition(credential.keyRef, [
          previousConfig,
          candidateConfig,
          currentConfig,
        ]) &&
        currentCredential.key !== undefined
      ) {
        store.profiles[profileId] = { ...credential, key: currentCredential.key };
      } else if (
        credential.type === "token" &&
        previousCredential?.type === "token" &&
        candidateCredential?.type === "token" &&
        currentCredential?.type === "token" &&
        isSecretRef(credential.tokenRef) &&
        isDeepStrictEqual(credential.tokenRef, previousCredential.tokenRef) &&
        isDeepStrictEqual(credential.tokenRef, candidateCredential.tokenRef) &&
        isDeepStrictEqual(credential.tokenRef, currentCredential.tokenRef) &&
        hasSameSecretProviderDefinition(credential.tokenRef, [
          previousConfig,
          candidateConfig,
          currentConfig,
        ]) &&
        currentCredential.token !== undefined
      ) {
        store.profiles[profileId] = { ...credential, token: currentCredential.token };
      }
    }
  }
  return next;
}

function preserveLiveAuthStoreBookkeeping(
  restored: Record<string, AuthProfileStore>,
  current: Record<string, AuthProfileStore>,
): Record<string, AuthProfileStore> {
  const next = structuredClone(restored);
  for (const [agentDir, store] of Object.entries(next)) {
    const currentStore = current[agentDir];
    if (!currentStore) {
      continue;
    }
    if (currentStore.order === undefined) {
      delete store.order;
    } else {
      store.order = structuredClone(currentStore.order);
    }
    if (currentStore.lastGood === undefined) {
      delete store.lastGood;
    } else {
      store.lastGood = structuredClone(currentStore.lastGood);
    }
    if (currentStore.usageStats === undefined) {
      delete store.usageStats;
    } else {
      store.usageStats = structuredClone(currentStore.usageStats);
    }
  }
  return next;
}

function credentialSecretRef(credential: AuthProfileCredential | undefined): SecretRef | null {
  if (credential?.type === "api_key" && isSecretRef(credential.keyRef)) {
    return credential.keyRef;
  }
  if (credential?.type === "token" && isSecretRef(credential.tokenRef)) {
    return credential.tokenRef;
  }
  return null;
}

function rebuildSelectedRuntimeProfileMetadata(
  store: RuntimeAuthProfileStore,
  selectedSources: Map<string, RuntimeAuthProfileStore>,
): void {
  const profileIdsFor = (
    field: "runtimeExternalProfileIds" | "runtimeLocalProfileIds" | "runtimePersistedProfileIds",
  ) =>
    [...selectedSources]
      .flatMap(([profileId, source]) => (source[field]?.includes(profileId) ? [profileId] : []))
      .toSorted();
  const persistedProfileIds = profileIdsFor("runtimePersistedProfileIds");
  store.runtimePersistedProfileIds =
    persistedProfileIds.length > 0 ? persistedProfileIds : undefined;
  const localProfileIds = profileIdsFor("runtimeLocalProfileIds");
  store.runtimeLocalProfileIds = localProfileIds.length > 0 ? localProfileIds : undefined;
  const externalProfileIds = profileIdsFor("runtimeExternalProfileIds");
  // Authority is store-wide three-way state; profile selection must not import it
  // from an unrelated credential source.
  const externalAuthoritative = store.runtimeExternalProfileIdsAuthoritative === true;
  store.runtimeExternalProfileIds =
    externalProfileIds.length > 0 || externalAuthoritative ? externalProfileIds : undefined;
  store.runtimeExternalProfileIdsAuthoritative = externalAuthoritative ? true : undefined;
}

function compareMutationTokens(
  captured: RuntimeAuthProfileStoreMutationToken,
  current: RuntimeAuthProfileStoreMutationToken,
): "mutated" | "unchanged" | "unknown" {
  if (!captured.known || !current.known) {
    return "unknown";
  }
  return captured.revision === current.revision ? "unchanged" : "mutated";
}

function readProfileOwnerMutationToken(
  agentDir: string,
  profileId: string,
  owner: ProfileOwner,
): RuntimeAuthProfileStoreMutationToken {
  return owner === "external"
    ? { revision: 0, known: true }
    : getRuntimeAuthProfileStoreCredentialMutationToken(agentDir, profileId, {
        includeMain: owner === "absent" || owner === "inherited",
      });
}

function getProfileMutationDecision(params: {
  agentDir: string;
  profileId: string;
  mutationLineage: typeof activeSnapshotLineageAuthMutations;
}): {
  baselineOwner: ProfileOwner;
  candidateOwner: ProfileOwner;
  candidateStatus: "mutated" | "unchanged" | "unknown";
  ownerChanged: boolean;
  status: "mutated" | "unchanged" | "unknown";
} {
  const captured = params.mutationLineage[params.agentDir]?.profiles[params.profileId];
  if (!captured) {
    return {
      baselineOwner: "absent",
      candidateOwner: "absent",
      candidateStatus: "mutated",
      ownerChanged: false,
      status: "mutated",
    };
  }
  const ownerChanged = captured.baseline.owner !== captured.candidate.owner;
  const relevant = ownerChanged ? captured.baseline : captured.candidate;
  return {
    baselineOwner: captured.baseline.owner,
    candidateOwner: captured.candidate.owner,
    candidateStatus: compareMutationTokens(
      captured.candidate.token,
      readProfileOwnerMutationToken(params.agentDir, params.profileId, captured.candidate.owner),
    ),
    ownerChanged,
    status: compareMutationTokens(
      relevant.token,
      readProfileOwnerMutationToken(params.agentDir, params.profileId, relevant.owner),
    ),
  };
}

function mergeRollbackAuthStoreCredentials(
  baseline: Record<string, AuthProfileStore>,
  candidate: Record<string, AuthProfileStore>,
  current: Record<string, AuthProfileStore>,
  restored: Record<string, AuthProfileStore>,
  configs: [OpenClawConfig, OpenClawConfig, OpenClawConfig],
  mutationLineage: typeof activeSnapshotLineageAuthMutations,
): Record<string, AuthProfileStore> {
  const next = structuredClone(restored);
  const agentDirs = new Set([
    ...Object.keys(baseline),
    ...Object.keys(candidate),
    ...Object.keys(current),
  ]);
  for (const agentDir of agentDirs) {
    let invalidateStore = false;
    const baselineStore = baseline[agentDir];
    const candidateStore = candidate[agentDir];
    const currentStore = current[agentDir];
    const currentStoreMutationStatus = (lineage: StoreMutationLineage | undefined) => {
      const ownerStatus = compareMutationTokens(
        lineage?.token ?? { revision: 0, known: true },
        getRuntimeAuthProfileStoreCredentialMutationToken(agentDir),
      );
      const mainProfileSetStatus = lineage?.mainProfileSetToken
        ? compareMutationTokens(
            lineage.mainProfileSetToken,
            getRuntimeAuthProfileStoreProfileSetMutationToken(),
          )
        : "unchanged";
      return ownerStatus === "mutated" || mainProfileSetStatus === "mutated"
        ? "mutated"
        : ownerStatus === "unknown" || mainProfileSetStatus === "unknown"
          ? "unknown"
          : "unchanged";
    };
    const baselineStoreMutationStatus = currentStoreMutationStatus(
      mutationLineage[agentDir]?.store.baseline,
    );
    const candidateStoreMutationStatus = currentStoreMutationStatus(
      mutationLineage[agentDir]?.store.candidate,
    );
    const stateMutationStatus = compareMutationTokens(
      mutationLineage[agentDir]?.state.token ?? { revision: 0, known: true },
      getRuntimeAuthProfileStoreStateMutationToken(agentDir, {
        includeMain: mutationLineage[agentDir]?.state.includeMain === true,
      }),
    );
    const profileOwnerMutated = Object.keys(baselineStore?.profiles ?? {}).some((profileId) => {
      const decision = getProfileMutationDecision({
        agentDir,
        profileId,
        mutationLineage,
      });
      return decision.status !== "unchanged" || decision.candidateStatus !== "unchanged";
    });
    if (!currentStore) {
      if (
        !candidateStore &&
        baselineStore &&
        baselineStoreMutationStatus === "unchanged" &&
        candidateStoreMutationStatus === "unchanged" &&
        stateMutationStatus === "unchanged" &&
        !profileOwnerMutated
      ) {
        next[agentDir] = structuredClone(baselineStore);
      } else {
        delete next[agentDir];
      }
      continue;
    }
    const store = next[agentDir] ?? structuredClone(baselineStore ?? currentStore);
    const profiles: AuthProfileStore["profiles"] = {};
    const selectedSources = new Map<string, AuthProfileStore>();
    const profileIds = new Set([
      ...Object.keys(baselineStore?.profiles ?? {}),
      ...Object.keys(candidateStore?.profiles ?? {}),
      ...Object.keys(currentStore.profiles),
    ]);
    for (const profileId of profileIds) {
      const baselineCredential = baselineStore?.profiles[profileId];
      const candidateCredential = candidateStore?.profiles[profileId];
      const currentCredential = currentStore.profiles[profileId];
      const profileMutationDecision = getProfileMutationDecision({
        agentDir,
        profileId,
        mutationLineage,
      });
      const profileMutationStatus = profileMutationDecision.status;
      const profileMutated = profileMutationStatus === "mutated";
      const currentOwner = profileOwner(currentStore, profileId);
      let credential: AuthProfileCredential | undefined;
      let selectedSource: AuthProfileStore | undefined;
      if (currentOwner !== profileMutationDecision.candidateOwner) {
        credential = currentCredential;
        selectedSource = currentStore;
      } else if (profileMutationDecision.ownerChanged) {
        if (
          profileMutationStatus !== "unchanged" ||
          profileMutationDecision.candidateStatus !== "unchanged"
        ) {
          invalidateStore = true;
        } else {
          credential = baselineCredential;
          selectedSource = baselineStore;
        }
      } else if (profileMutationStatus === "unknown") {
        if (isDeepStrictEqual(baselineCredential, candidateCredential)) {
          credential = currentCredential;
          selectedSource = currentStore;
        } else {
          invalidateStore = true;
        }
      } else {
        if (isDeepStrictEqual(currentCredential, candidateCredential)) {
          if (profileMutated) {
            credential = currentCredential;
            selectedSource = currentStore;
          } else {
            credential = baselineCredential;
            selectedSource = baselineStore;
          }
        } else {
          credential = currentCredential;
          selectedSource = currentStore;
        }
      }
      const baselineRef = credentialSecretRef(baselineCredential);
      const candidateRef = credentialSecretRef(candidateCredential);
      const currentRef = credentialSecretRef(currentCredential);
      if (
        currentOwner === profileMutationDecision.candidateOwner &&
        profileMutationStatus === "unchanged" &&
        candidateRef &&
        currentRef &&
        isDeepStrictEqual(candidateRef, currentRef) &&
        !isDeepStrictEqual(baselineRef, candidateRef)
      ) {
        // Candidate activation owns the ref transition. Descendant resolution may refresh the
        // literal, but without a persisted write rollback still restores the previous owner/ref.
        credential = baselineCredential;
        selectedSource = baselineStore;
      }
      if (
        baselineRef &&
        candidateRef &&
        currentRef &&
        isDeepStrictEqual(baselineRef, candidateRef) &&
        isDeepStrictEqual(baselineRef, currentRef) &&
        !hasSameSecretProviderDefinition(baselineRef, configs)
      ) {
        if (
          currentOwner !== profileMutationDecision.candidateOwner ||
          profileMutationStatus !== "unchanged"
        ) {
          invalidateStore = true;
          credential = undefined;
          selectedSource = undefined;
        } else {
          credential = baselineCredential;
          selectedSource = baselineStore;
        }
      }
      const selectedRef = credentialSecretRef(credential);
      if (
        selectedSource === currentStore &&
        selectedRef &&
        !hasSameSecretProviderDefinition(selectedRef, [configs[0], configs[1]])
      ) {
        invalidateStore = true;
        credential = undefined;
        selectedSource = undefined;
      }
      if (credential && selectedSource) {
        profiles[profileId] = structuredClone(credential);
        selectedSources.set(profileId, selectedSource);
      }
    }
    if (invalidateStore) {
      // Exact persisted ownership was evicted. Remove the runtime store so the
      // next auth load reads durable truth instead of publishing a partial clone.
      delete next[agentDir];
      continue;
    }
    if (!baselineStore && Object.keys(profiles).length === 0) {
      delete next[agentDir];
      continue;
    }
    store.profiles = profiles;
    rebuildSelectedRuntimeProfileMetadata(store, selectedSources);
    next[agentDir] = store;
  }
  return next;
}

/**
 * Associates a prepared snapshot with the refresh context needed after activation.
 */
export function setPreparedSecretsRuntimeSnapshotRefreshContext(
  snapshot: PreparedSecretsRuntimeSnapshot,
  context: SecretsRuntimeRefreshContext,
): void {
  preparedSnapshotRefreshContext.set(snapshot, cloneSecretsRuntimeRefreshContext(context));
}

/**
 * Returns the refresh context stored for a prepared snapshot, if any.
 */
export function getPreparedSecretsRuntimeSnapshotRefreshContext(
  snapshot: PreparedSecretsRuntimeSnapshot,
): SecretsRuntimeRefreshContext | null {
  const context = preparedSnapshotRefreshContext.get(snapshot);
  return context ? cloneSecretsRuntimeRefreshContext(context) : null;
}

/**
 * Returns the active refresh context without exposing mutable runtime state.
 */
export function getActiveSecretsRuntimeRefreshContext(): SecretsRuntimeRefreshContext | null {
  return activeRefreshContext ? cloneSecretsRuntimeRefreshContext(activeRefreshContext) : null;
}

/** Retain live auth state when a one-shot config write intentionally skips auth-store refs. */
export function graftActiveSecretsRuntimeAuthState(snapshot: PreparedSecretsRuntimeSnapshot): void {
  if (!activeRefreshContext) {
    return;
  }
  snapshot.authStores = getLiveSecretsRuntimeAuthStores();
  snapshot.authStoreCredentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
  setPreparedSecretsRuntimeSnapshotRefreshContext(snapshot, activeRefreshContext);
}

/**
 * Returns the env used by the active runtime snapshot, falling back to process env.
 */
export function getActiveSecretsRuntimeEnv(): NodeJS.ProcessEnv {
  return {
    ...(activeRefreshContext?.env ?? process.env),
  } as NodeJS.ProcessEnv;
}

/**
 * Registers cleanup hooks that run whenever the active secrets runtime snapshot is cleared.
 */
export function registerSecretsRuntimeStateClearHook(clearHook: () => void): void {
  clearHooks.add(clearHook);
}

/**
 * Atomically activates a prepared secrets snapshot across config, auth-store, and web-tool state.
 */
export function activateSecretsRuntimeSnapshotState(params: {
  snapshot: PreparedSecretsRuntimeSnapshot;
  refreshContext: SecretsRuntimeRefreshContext | null;
  refreshHandler: RuntimeConfigSnapshotRefreshHandler | null;
  mergeLiveAuthBookkeeping?: boolean;
  preserveActivationLineage?: boolean;
}): void {
  if (!hasCurrentAuthStoreCredentialsRevision(params.snapshot)) {
    throw new Error(
      "Cannot activate stale secrets runtime snapshot: auth credentials changed during preparation.",
    );
  }
  const next = cloneSnapshot(params.snapshot);
  if (params.mergeLiveAuthBookkeeping !== false) {
    next.authStores = mergeLiveAuthStoreBookkeeping(next.authStores);
  }
  const activationAuthStores = structuredClone(listRuntimeAuthProfileStoreSnapshots());
  const previousLineageAuthStores = activeSnapshotLineageAuthStores;
  const activationAuthMutations = captureAuthStoreMutationLineage(
    activationAuthStores,
    next.authStores,
  );
  const previousLineageAuthMutations = activeSnapshotLineageAuthMutations;
  const nextRefreshContext = params.refreshContext
    ? cloneSecretsRuntimeRefreshContext(params.refreshContext)
    : null;
  setRuntimeConfigSnapshot(next.config, next.sourceConfig);
  replaceRuntimeAuthProfileStoreSnapshots(next.authStores);
  next.authStoreCredentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
  const previousLineageStartRevision = activeSnapshotLineageStartRevision;
  activeSnapshot = next;
  activeSnapshotRevision += 1;
  activeSnapshotLineageStartRevision = params.preserveActivationLineage
    ? previousLineageStartRevision
    : activeSnapshotRevision;
  activeSnapshotLineageAuthStores = params.preserveActivationLineage
    ? previousLineageAuthStores
    : activationAuthStores;
  activeSnapshotLineageAuthMutations = params.preserveActivationLineage
    ? previousLineageAuthMutations
    : activationAuthMutations;
  activeRefreshContext = nextRefreshContext;
  if (nextRefreshContext) {
    preparedSnapshotRefreshContext.set(next, cloneSecretsRuntimeRefreshContext(nextRefreshContext));
  }
  setActiveRuntimeWebToolsMetadata(next.webTools);
  setRuntimeConfigSnapshotRefreshHandler(params.refreshHandler);
}

/** Whether a prepared snapshot still owns the credential state it cloned. */
export function hasCurrentAuthStoreCredentialsRevision(
  snapshot: PreparedSecretsRuntimeSnapshot,
): boolean {
  return snapshot.authStoreCredentialsRevision === getRuntimeAuthProfileStoreCredentialsRevision();
}

/** Activates only while the caller still owns the snapshot revision it prepared against. */
export function activateSecretsRuntimeSnapshotStateIfCurrent(
  params: Parameters<typeof activateSecretsRuntimeSnapshotState>[0] & {
    expectedRevision: number;
  },
): boolean {
  if (
    activeSnapshotRevision !== params.expectedRevision ||
    !hasCurrentAuthStoreCredentialsRevision(params.snapshot)
  ) {
    return false;
  }
  activateSecretsRuntimeSnapshotState(params);
  return true;
}

/** Restores an owned predecessor while retaining changes after candidate preparation. */
export function restoreSecretsRuntimeSnapshotStateIfCurrent(
  params: Parameters<typeof activateSecretsRuntimeSnapshotState>[0] & {
    expectedRevision: number;
    ownedSnapshot: PreparedSecretsRuntimeSnapshot;
  },
): boolean {
  if (!activeSnapshot || activeSnapshotLineageStartRevision !== params.expectedRevision) {
    return false;
  }
  const baselineAuthStores = Object.fromEntries(
    activeSnapshotLineageAuthStores.map((entry) => [entry.agentDir, entry.store]),
  );
  const candidateAuthStores = Object.fromEntries(
    params.ownedSnapshot.authStores.map((entry) => [entry.agentDir, entry.store]),
  );
  const currentAuthStores = Object.fromEntries(
    listRuntimeAuthProfileStoreSnapshots().map((entry) => [entry.agentDir, entry.store]),
  );
  const mergedAuthStores = mergeRollbackAuthStoreCredentials(
    baselineAuthStores,
    candidateAuthStores,
    currentAuthStores,
    mergeRollbackValue(baselineAuthStores, candidateAuthStores, currentAuthStores) as Record<
      string,
      AuthProfileStore
    >,
    [params.snapshot.sourceConfig, params.ownedSnapshot.sourceConfig, activeSnapshot.sourceConfig],
    activeSnapshotLineageAuthMutations,
  );
  const currentCredentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
  const restoredAuthStores = preserveLiveAuthStoreBookkeeping(
    preserveResolvedAuthStoreSecretValues(
      baselineAuthStores,
      candidateAuthStores,
      mergedAuthStores,
      currentAuthStores,
      params.snapshot.sourceConfig,
      params.ownedSnapshot.sourceConfig,
      activeSnapshot.sourceConfig,
    ),
    currentAuthStores,
  );
  const restoredSourceConfig = mergeRollbackValue(
    params.snapshot.sourceConfig,
    params.ownedSnapshot.sourceConfig,
    activeSnapshot.sourceConfig,
  ) as OpenClawConfig;
  const restoredConfig = preserveResolvedSecretRefValues(
    restoredSourceConfig,
    activeSnapshot.sourceConfig,
    activeSnapshot.config,
    mergeRollbackValue(params.snapshot.config, params.ownedSnapshot.config, activeSnapshot.config),
    restoredSourceConfig,
    activeSnapshot.sourceConfig,
  ) as OpenClawConfig;
  return activateSecretsRuntimeSnapshotStateIfCurrent({
    ...params,
    snapshot: {
      ...params.snapshot,
      sourceConfig: restoredSourceConfig,
      config: restoredConfig,
      authStores: Object.entries(restoredAuthStores)
        .map(([agentDir, store]) => ({ agentDir, store }))
        .toSorted((left, right) => left.agentDir.localeCompare(right.agentDir)),
      authStoreCredentialsRevision: currentCredentialsRevision,
    },
    mergeLiveAuthBookkeeping: false,
    preserveActivationLineage: false,
    expectedRevision: activeSnapshotRevision,
  });
}

/**
 * Returns a cloned active secrets runtime snapshot for callers that need mutable data.
 */
export function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null {
  if (!activeSnapshot) {
    return null;
  }
  const snapshot = cloneSnapshot(activeSnapshot);
  snapshot.authStores = listRuntimeAuthProfileStoreSnapshots();
  snapshot.authStoreCredentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
  if (activeRefreshContext) {
    preparedSnapshotRefreshContext.set(
      snapshot,
      cloneSecretsRuntimeRefreshContext(activeRefreshContext),
    );
  }
  return snapshot;
}

/** Stable token for compare-and-activate ownership across cloned snapshot reads. */
export function getActiveSecretsRuntimeSnapshotRevision(): number {
  return activeSnapshotRevision;
}

/** Advance canonical source ownership without replacing resolved runtime or auth bytes. */
export function setSecretsRuntimeSourceSnapshotIfCurrent(params: {
  expectedSecretsRevision: number;
  expectedRuntimeConfigRevision: number;
  runtimeSourceConfig: OpenClawConfig;
  secretsSourceConfig: OpenClawConfig;
}): boolean {
  if (activeSnapshotRevision !== params.expectedSecretsRevision) {
    return false;
  }
  const nextRuntimeSourceConfig = structuredClone(params.runtimeSourceConfig);
  const nextSecretsSourceConfig = structuredClone(params.secretsSourceConfig);
  const currentAuthStores = structuredClone(listRuntimeAuthProfileStoreSnapshots());
  const nextAuthMutations = captureAuthStoreMutationLineage(currentAuthStores, currentAuthStores);
  if (
    !setRuntimeConfigSourceSnapshotIfCurrent({
      expectedRevision: params.expectedRuntimeConfigRevision,
      sourceConfig: nextRuntimeSourceConfig,
    })
  ) {
    return false;
  }
  if (activeSnapshot) {
    activeSnapshot.sourceConfig = nextSecretsSourceConfig;
    activeSnapshotRevision += 1;
    activeSnapshotLineageStartRevision = activeSnapshotRevision;
    activeSnapshotLineageAuthStores = currentAuthStores;
    activeSnapshotLineageAuthMutations = nextAuthMutations;
  }
  return true;
}

// Hot-path readers only need the config pair for availability decisions.
// Return the active references and keep full snapshot clone isolation on
// getActiveSecretsRuntimeSnapshot() for callers that need mutable data.
export function getActiveSecretsRuntimeConfigSnapshot(): Pick<
  PreparedSecretsRuntimeSnapshot,
  "config" | "sourceConfig"
> | null {
  if (!activeSnapshot) {
    return null;
  }
  return {
    config: activeSnapshot.config,
    sourceConfig: activeSnapshot.sourceConfig,
  };
}

/**
 * Returns current auth stores, preferring live auth-store snapshots over activation-time clones.
 */
export function getLiveSecretsRuntimeAuthStores(): PreparedSecretsRuntimeSnapshot["authStores"] {
  if (!activeSnapshot) {
    return [];
  }
  return activeSnapshot.authStores.flatMap((entry) => {
    const store = getRuntimeAuthProfileStoreSnapshot(entry.agentDir);
    return store ? [{ agentDir: entry.agentDir, store }] : [];
  });
}

/**
 * Clears active secrets runtime state and all linked config/auth/web-tool snapshots.
 */
export function clearSecretsRuntimeSnapshot(): void {
  activeSnapshotRevision += 1;
  activeSnapshotLineageStartRevision = 0;
  activeSnapshotLineageAuthStores = [];
  activeSnapshotLineageAuthMutations = {};
  activeSnapshot = null;
  activeRefreshContext = null;
  clearActiveRuntimeWebToolsMetadata();
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
  for (const clearHook of clearHooks) {
    clearHook();
  }
}
