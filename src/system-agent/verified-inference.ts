import { isDeepStrictEqual } from "node:util";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import {
  resolveCliAuthBindingFingerprint,
  resolveCliRuntimeArtifactFingerprint,
  resolveCliRuntimeOwnerFingerprint,
} from "../agents/cli-auth-epoch.js";
import {
  fingerprintAuthProfileOwnerShape,
  fingerprintAuthProfileCredential,
  fingerprintAwsSdkRuntimeOwner,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
  type AgentExecutionAuthBinding,
  type OpaqueRuntimeOwnerKind,
} from "../agents/execution-auth-binding.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarnessRuntimeArtifactBinding } from "../agents/harness/runtime-artifact.types.js";
import type { ExpectedAgentHarnessRuntimeArtifact } from "../agents/harness/runtime-artifact.types.js";
import { resolveAgentHarnessOwnerPluginIds } from "../agents/harness/runtime-plugin.js";
import type { AgentHarnessAuthBindingFingerprintParams } from "../agents/harness/types.js";
import type { ResolvedProviderAuth } from "../agents/model-auth-runtime-shared.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import type { OpenClawPackageBuild } from "../plugins/manifest.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { loadPluginRegistrySnapshot } from "../plugins/plugin-registry.js";
import {
  fingerprintPluginRuntimeArtifact,
  type PluginRuntimeArtifactIdentitySource,
} from "../plugins/plugin-runtime-artifact-identity.js";
import {
  resolveOwningPluginIdsForModelRefs,
  resolveOwningPluginIdsForProviderRef,
} from "../plugins/providers.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
  type SystemAgentConfiguredRouteDeps,
} from "./inference-route.js";
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type SystemAgentConfiguredRouteIdentity = DistributiveOmit<
  SystemAgentConfiguredRoute,
  "runConfig" | "authProfileId"
>;

type SystemAgentVerifiedExecutionFingerprint = {
  route: unknown;
  defaultSelection: unknown;
  auth: unknown;
  models: unknown;
  defaults: unknown;
  agent?: unknown;
  plugins: unknown;
  ownerPluginRuntimes: readonly SystemAgentOwnerPluginRuntimeIdentity[];
};

type SystemAgentOwnerPluginRuntimeIdentity = Readonly<{
  pluginId: string;
  origin: string;
  rootDir: string;
  manifestPath: string;
  manifestHash: string;
  source: string | null;
  packageName: string | null;
  packageVersion: string | null;
  installRecordHash: string | null;
  packageJson: Readonly<{ path: string; hash: string }> | null;
}>;

type SystemAgentOwnerPluginArtifactIdentity = Readonly<{
  pluginId: string;
  fingerprint: string;
}>;

export type SystemAgentOwnerPluginArtifactSnapshot = Readonly<{
  ownerPluginIds: readonly string[];
  ownerPluginArtifacts: readonly SystemAgentOwnerPluginArtifactIdentity[];
}>;

type SystemAgentOwnerPluginRegistryRecord = {
  pluginId: string;
  origin: PluginOrigin;
  rootDir: string;
  manifestPath: string;
  manifestHash: string;
  source?: string;
  packageName?: string;
  packageVersion?: string;
  installRecordHash?: string;
  packageJson?: { path: string; hash: string };
  packageBuild?: OpenClawPackageBuild;
};

type SystemAgentOwnerPluginRegistryLoader = (params: {
  config: OpenClawConfig;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
}) => { plugins: readonly SystemAgentOwnerPluginRegistryRecord[] };

/** Server-local proof returned only after the exact route completes a live turn. */
export type SystemAgentVerifiedInferenceBinding = Readonly<{
  configuredRoute: SystemAgentConfiguredRouteIdentity;
  execution: SystemAgentConfiguredRoute;
  executionFingerprint: SystemAgentVerifiedExecutionFingerprint;
  ownerPluginIds: readonly string[];
  ownerPluginArtifacts: readonly SystemAgentOwnerPluginArtifactIdentity[];
  auth: Readonly<{
    authProfileId?: string;
    agentHarnessId?: string;
    modelId?: string;
    modelApi?: string;
    authFingerprint: string;
    proofKind?: "runtime-owner";
    runtimeOwnerKind?: OpaqueRuntimeOwnerKind;
    runtimeOwnerId?: string;
    runtimeArtifactFingerprint?: string;
    runtimeArtifactId?: string;
    skipLocalCredential?: true;
  }>;
}>;

export type SystemAgentVerifiedInferenceDeps = SystemAgentConfiguredRouteDeps & {
  ensureAuthProfileStore?: typeof ensureAuthProfileStore;
  resolveCliAuthBindingFingerprint?: typeof resolveCliAuthBindingFingerprint;
  resolveCliRuntimeOwnerFingerprint?: typeof resolveCliRuntimeOwnerFingerprint;
  resolveCliRuntimeArtifactFingerprint?: typeof resolveCliRuntimeArtifactFingerprint;
  resolveApiKeyForProvider?: typeof resolveApiKeyForProvider;
  validateAgentHarnessRuntimeArtifact?: (params: {
    harnessId: string;
    artifact: AgentHarnessRuntimeArtifactBinding;
  }) => Promise<boolean>;
  resolveAgentHarnessAuthBindingFingerprint?: (
    params: AgentHarnessAuthBindingFingerprintParams & { harnessId: string },
  ) => Promise<string | undefined>;
  loadPluginRegistrySnapshot?: SystemAgentOwnerPluginRegistryLoader;
  fingerprintPluginRuntimeArtifact?: (record: PluginRuntimeArtifactIdentitySource) => string;
};

/** Exact child harness artifact every verified embedded OpenClaw call must carry. */
export function resolveSystemAgentExpectedAgentHarnessRuntimeArtifact(
  binding: SystemAgentVerifiedInferenceBinding,
): ExpectedAgentHarnessRuntimeArtifact | undefined {
  if (
    binding.execution.runner !== "embedded" ||
    binding.execution.agentHarnessRuntimeOverride === "openclaw"
  ) {
    return undefined;
  }
  const harnessId = binding.execution.agentHarnessRuntimeOverride;
  const artifactId = binding.auth.runtimeArtifactId?.trim();
  const fingerprint = binding.auth.runtimeArtifactFingerprint;
  if (binding.auth.agentHarnessId !== harnessId || !artifactId || !fingerprint) {
    throw new Error("The verified inference harness artifact is incomplete.");
  }
  return {
    harnessId,
    artifact: { id: artifactId, fingerprint },
  };
}

async function validateAgentHarnessRuntimeArtifact(params: {
  harnessId: string;
  artifact: AgentHarnessRuntimeArtifactBinding;
  deps: SystemAgentVerifiedInferenceDeps;
}): Promise<boolean> {
  try {
    if (params.deps.validateAgentHarnessRuntimeArtifact) {
      return await params.deps.validateAgentHarnessRuntimeArtifact({
        harnessId: params.harnessId,
        artifact: params.artifact,
      });
    }
    const harness = getRegisteredAgentHarness(params.harnessId)?.harness;
    return (await harness?.runtimeArtifact?.validate(params.artifact)) === true;
  } catch {
    return false;
  }
}

async function resolveAgentHarnessAuthBindingFingerprint(params: {
  harnessId: string;
  authProfileId: string;
  authProfileStore: AgentHarnessAuthBindingFingerprintParams["authProfileStore"];
  agentDir: string;
  config: OpenClawConfig;
  deps: SystemAgentVerifiedInferenceDeps;
}): Promise<string | undefined> {
  const input = {
    harnessId: params.harnessId,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  };
  if (params.deps.resolveAgentHarnessAuthBindingFingerprint) {
    return params.deps.resolveAgentHarnessAuthBindingFingerprint(input);
  }
  return getRegisteredAgentHarness(params.harnessId)?.harness.authBinding?.fingerprint(input);
}

function systemAgentRouteIdentity(
  route: SystemAgentConfiguredRoute,
): SystemAgentConfiguredRouteIdentity {
  const { runConfig: _runConfig, authProfileId: _authProfileId, ...identity } = route;
  return identity;
}

async function resolveCurrentRuntimeOwnerFingerprint(params: {
  route: SystemAgentConfiguredRoute;
  kind: OpaqueRuntimeOwnerKind;
  runtimeOwnerId: string;
  authProfileId?: string;
  skipLocalCredential?: boolean;
  runtimeArtifactFingerprint?: string;
  deps: SystemAgentVerifiedInferenceDeps;
}): Promise<string | undefined> {
  if (params.route.runner === "cli") {
    if (params.kind !== "cli-runtime") {
      return undefined;
    }
    const resolveOwner =
      params.deps.resolveCliRuntimeOwnerFingerprint ?? resolveCliRuntimeOwnerFingerprint;
    return resolveOwner({
      provider: params.route.provider,
      config: params.route.runConfig,
      agentDir: params.route.agentDir,
      agentId: "openclaw",
      runtimeOwnerId: params.runtimeOwnerId,
      ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
      ...(params.skipLocalCredential ? { skipLocalCredential: true } : {}),
      ...(params.runtimeArtifactFingerprint
        ? { runtimeArtifactFingerprint: params.runtimeArtifactFingerprint }
        : {}),
    });
  }
  let authProfileOwnerFingerprint: string | undefined;
  if (params.authProfileId) {
    const ensureStore = params.deps.ensureAuthProfileStore ?? ensureAuthProfileStore;
    const store = ensureStore(params.route.agentDir, {
      readOnly: true,
      allowKeychainPrompt: false,
      config: params.route.runConfig,
      externalCliProviderIds: [params.route.provider],
    });
    authProfileOwnerFingerprint = fingerprintAuthProfileOwnerShape({
      profileId: params.authProfileId,
      credential: store.profiles[params.authProfileId],
    });
    if (!authProfileOwnerFingerprint) {
      return undefined;
    }
  }
  if (params.kind === "plugin-harness") {
    if (params.route.agentHarnessRuntimeOverride === "openclaw") {
      return undefined;
    }
    return fingerprintOpaqueRuntimeOwner({
      kind: "plugin-harness",
      runner: "embedded",
      provider: params.route.provider,
      backendId: params.route.agentHarnessRuntimeOverride,
      ...(params.runtimeArtifactFingerprint
        ? { runtimeArtifactFingerprint: params.runtimeArtifactFingerprint }
        : {}),
      ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
      ...(authProfileOwnerFingerprint ? { authProfileOwnerFingerprint } : {}),
    });
  }
  if (params.kind !== "aws-sdk") {
    return undefined;
  }
  const resolveAuth = params.deps.resolveApiKeyForProvider ?? resolveApiKeyForProvider;
  const auth = await resolveAuth({
    provider: params.route.provider,
    cfg: params.route.runConfig,
    agentDir: params.route.agentDir,
    workspaceDir: resolveAgentWorkspaceDir(
      params.route.runConfig,
      params.route.agentId,
      process.env,
    ),
    ...(params.authProfileId
      ? { profileId: params.authProfileId, lockedProfile: true as const }
      : {}),
    secretSentinels: true,
  });
  if (params.authProfileId && auth.profileId !== params.authProfileId) {
    return undefined;
  }
  return fingerprintAwsSdkRuntimeOwner({
    provider: params.route.provider,
    backendId: params.route.agentHarnessRuntimeOverride,
    auth,
  });
}

function projectRelevantPlugins(
  config: OpenClawConfig,
  route: SystemAgentConfiguredRouteIdentity | null,
  ownerPluginIds: readonly string[],
): unknown {
  if (!route || ownerPluginIds.length === 0) {
    return undefined;
  }
  const normalizedPlugins = normalizePluginsConfig(config.plugins);
  return Object.fromEntries(
    ownerPluginIds.map((id) => [
      id,
      {
        active: passesManifestOwnerBasePolicy({
          plugin: { id },
          normalizedConfig: normalizedPlugins,
        }),
        entry: normalizedPlugins.entries[id],
      },
    ]),
  );
}

function projectOwnerPluginRuntime(
  record: SystemAgentOwnerPluginRegistryRecord,
): SystemAgentOwnerPluginRuntimeIdentity {
  return {
    pluginId: record.pluginId,
    origin: record.origin,
    rootDir: record.rootDir,
    manifestPath: record.manifestPath,
    manifestHash: record.manifestHash,
    source: record.source ?? null,
    packageName: record.packageName ?? null,
    packageVersion: record.packageVersion ?? null,
    installRecordHash: record.installRecordHash ?? null,
    packageJson: record.packageJson
      ? { path: record.packageJson.path, hash: record.packageJson.hash }
      : null,
  };
}

// Plugin ids alone survive an in-place runtime replacement. Bind the selected
// installed source and package identity so a stale inference proof cannot write.
function projectOwnerPluginRuntimes(params: {
  config: OpenClawConfig;
  route: SystemAgentConfiguredRoute;
  ownerPluginIds: readonly string[];
  deps: SystemAgentVerifiedInferenceDeps;
}): SystemAgentOwnerPluginRuntimeIdentity[] {
  if (params.ownerPluginIds.length === 0) {
    return [];
  }
  const loadRegistry = params.deps.loadPluginRegistrySnapshot ?? loadPluginRegistrySnapshot;
  const workspaceDir = resolveAgentWorkspaceDir(params.config, params.route.agentId, process.env);
  const registry = loadRegistry({ config: params.config, workspaceDir, env: process.env });
  const recordsById = new Map(registry.plugins.map((record) => [record.pluginId, record]));
  return params.ownerPluginIds.map((pluginId) => {
    const record = recordsById.get(pluginId);
    if (!record) {
      throw new Error(`The inference owner plugin ${pluginId} is not installed.`);
    }
    return projectOwnerPluginRuntime(record);
  });
}

function projectOwnerPluginArtifacts(params: {
  config: OpenClawConfig;
  route: SystemAgentConfiguredRoute;
  ownerPluginIds: readonly string[];
  deps: SystemAgentVerifiedInferenceDeps;
}): SystemAgentOwnerPluginArtifactIdentity[] {
  if (params.ownerPluginIds.length === 0) {
    return [];
  }
  const loadRegistry = params.deps.loadPluginRegistrySnapshot ?? loadPluginRegistrySnapshot;
  const fingerprintArtifact =
    params.deps.fingerprintPluginRuntimeArtifact ?? fingerprintPluginRuntimeArtifact;
  const workspaceDir = resolveAgentWorkspaceDir(params.config, params.route.agentId, process.env);
  const registry = loadRegistry({ config: params.config, workspaceDir, env: process.env });
  const recordsById = new Map(registry.plugins.map((record) => [record.pluginId, record]));
  return params.ownerPluginIds.map((pluginId) => {
    const record = recordsById.get(pluginId);
    if (!record) {
      throw new Error(`The inference owner plugin ${pluginId} is not installed.`);
    }
    return {
      pluginId,
      fingerprint: fingerprintArtifact({
        pluginId,
        origin: record.origin,
        rootDir: record.rootDir,
        ...(record.source ? { source: record.source } : {}),
        ...(record.packageBuild ? { packageBuild: record.packageBuild } : {}),
      }),
    };
  });
}
async function projectVerifiedExecutionFingerprint(
  config: OpenClawConfig,
  route: SystemAgentConfiguredRoute,
  ownerPluginIds: readonly string[],
  deps: SystemAgentVerifiedInferenceDeps,
): Promise<SystemAgentVerifiedExecutionFingerprint> {
  const projection = await projectInferenceRoute(config, route.agentId, deps);
  return {
    route: projection.route
      ? (() => {
          const { authProfileId: _authProfileId, ...routeWithoutAuthProfile } = projection.route;
          return routeWithoutAuthProfile;
        })()
      : null,
    defaultSelection: projection.defaultSelection,
    auth: projection.auth,
    models: projection.models,
    defaults: projection.defaults,
    ...(projection.agent === undefined ? {} : { agent: projection.agent }),
    plugins: projectRelevantPlugins(config, projection.route, ownerPluginIds),
    ownerPluginRuntimes: projectOwnerPluginRuntimes({
      config,
      route,
      ownerPluginIds,
      deps,
    }),
  };
}

function resolveRouteHarnessOwnerPluginIds(
  config: OpenClawConfig,
  route: SystemAgentConfiguredRoute,
): string[] {
  if (route.runner !== "embedded" || route.agentHarnessRuntimeOverride === "openclaw") {
    return [];
  }
  const workspaceDir = resolveAgentWorkspaceDir(config, route.agentId, process.env);
  return resolveAgentHarnessOwnerPluginIds({
    runtime: route.agentHarnessRuntimeOverride,
    provider: route.provider,
    config,
    workspaceDir,
  });
}

function resolveRouteOwnerPluginIds(
  config: OpenClawConfig,
  route: SystemAgentConfiguredRoute,
): string[] {
  const workspaceDir = resolveAgentWorkspaceDir(config, route.agentId, process.env);
  return [
    ...resolveOwningPluginIdsForModelRefs({
      models: [route.modelLabel],
      config,
      workspaceDir,
      env: process.env,
    }),
    ...(resolveOwningPluginIdsForProviderRef({
      provider: route.provider,
      config,
      workspaceDir,
      env: process.env,
    }) ?? []),
    ...resolveRouteHarnessOwnerPluginIds(config, route),
  ]
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .toSorted();
}

/** Capture once immediately before a live setup turn. */
export function captureSystemAgentOwnerPluginArtifacts(params: {
  config: OpenClawConfig;
  executionRoute: SystemAgentConfiguredRoute;
  deps?: SystemAgentVerifiedInferenceDeps;
}): SystemAgentOwnerPluginArtifactSnapshot {
  const deps = params.deps ?? {};
  const ownerPluginIds = resolveRouteOwnerPluginIds(params.config, params.executionRoute);
  return {
    ownerPluginIds,
    ownerPluginArtifacts: projectOwnerPluginArtifacts({
      config: params.config,
      route: params.executionRoute,
      ownerPluginIds,
      deps,
    }),
  };
}

async function resolveCurrentAuthFingerprint(params: {
  route: SystemAgentConfiguredRoute;
  authProfileId?: string;
  modelId?: string;
  modelApi?: string;
  skipLocalCredential?: boolean;
  deps: SystemAgentVerifiedInferenceDeps;
}): Promise<string | undefined> {
  if (params.route.runner === "cli") {
    const resolveBinding =
      params.deps.resolveCliAuthBindingFingerprint ?? resolveCliAuthBindingFingerprint;
    let resolvedAuth: ResolvedProviderAuth | undefined;
    if (params.authProfileId) {
      const ensureStore = params.deps.ensureAuthProfileStore ?? ensureAuthProfileStore;
      const store = ensureStore(params.route.agentDir, {
        readOnly: true,
        allowKeychainPrompt: false,
        config: params.route.runConfig,
        externalCliProviderIds: [params.route.provider],
      });
      const authCredential = store.profiles[params.authProfileId];
      const needsMaterializedSecret =
        (authCredential?.type === "api_key" && !authCredential.key) ||
        (authCredential?.type === "token" && !authCredential.token);
      if (needsMaterializedSecret) {
        const resolveAuth = params.deps.resolveApiKeyForProvider ?? resolveApiKeyForProvider;
        resolvedAuth = await resolveAuth({
          provider: params.route.provider,
          cfg: params.route.runConfig,
          agentDir: params.route.agentDir,
          workspaceDir: resolveAgentWorkspaceDir(
            params.route.runConfig,
            params.route.agentId,
            process.env,
          ),
          profileId: params.authProfileId,
          lockedProfile: true,
          // The CLI bridge hashed the raw resolved value it forwarded. A
          // sentinel would describe the reference, not the executed secret.
          secretSentinels: false,
        });
        if (
          resolvedAuth.profileId !== params.authProfileId ||
          !resolvedAuth.apiKey ||
          !authCredential
        ) {
          return undefined;
        }
      }
    }
    return resolveBinding({
      provider: params.route.provider,
      config: params.route.runConfig,
      agentDir: params.route.agentDir,
      ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
      ...(resolvedAuth ? { resolvedAuth } : {}),
      ...(params.skipLocalCredential ? { skipLocalCredential: true } : {}),
    });
  }
  if (params.authProfileId) {
    const ensureStore = params.deps.ensureAuthProfileStore ?? ensureAuthProfileStore;
    const store = ensureStore(params.route.agentDir, {
      readOnly: true,
      allowKeychainPrompt: false,
      config: params.route.runConfig,
      externalCliProviderIds: [params.route.provider],
    });
    const credential = store.profiles[params.authProfileId];
    if (!credential) {
      return undefined;
    }
    if (
      credential.type === "oauth" ||
      (params.route.runner === "embedded" &&
        params.route.agentHarnessRuntimeOverride !== "openclaw")
    ) {
      if (credential.type === "oauth") {
        return fingerprintAuthProfileCredential({
          profileId: params.authProfileId,
          credential,
        });
      }
      const harnessId = params.route.agentHarnessRuntimeOverride;
      const harness = getRegisteredAgentHarness(harnessId)?.harness;
      if (harness?.authBootstrap === "harness") {
        return resolveAgentHarnessAuthBindingFingerprint({
          harnessId,
          authProfileId: params.authProfileId,
          authProfileStore: store,
          agentDir: params.route.agentDir,
          config: params.route.runConfig,
          deps: params.deps,
        });
      }
      if (!params.modelId || !params.modelApi) {
        return undefined;
      }
      const resolveAuth = params.deps.resolveApiKeyForProvider ?? resolveApiKeyForProvider;
      const auth = await resolveAuth({
        provider: params.route.provider,
        cfg: params.route.runConfig,
        agentDir: params.route.agentDir,
        workspaceDir: resolveAgentWorkspaceDir(
          params.route.runConfig,
          params.route.agentId,
          process.env,
        ),
        profileId: params.authProfileId,
        lockedProfile: true,
        modelId: params.modelId,
        modelApi: params.modelApi,
        secretSentinels: false,
      });
      if (auth.profileId !== params.authProfileId || !auth.apiKey) {
        return undefined;
      }
      return fingerprintResolvedAuthProfileCredential({
        profileId: params.authProfileId,
        credential,
        resolvedAuth: auth,
      });
    }
  }
  // Credential selection is transport-sensitive. Reuse the facts from the
  // successful run so this authority hot path cannot pick a different owner.
  if (!params.modelId || !params.modelApi) {
    return undefined;
  }
  const resolveAuth = params.deps.resolveApiKeyForProvider ?? resolveApiKeyForProvider;
  const auth = await resolveAuth({
    provider: params.route.provider,
    cfg: params.route.runConfig,
    agentDir: params.route.agentDir,
    workspaceDir: resolveAgentWorkspaceDir(
      params.route.runConfig,
      params.route.agentId,
      process.env,
    ),
    ...(params.authProfileId
      ? { profileId: params.authProfileId, lockedProfile: true as const }
      : {}),
    modelId: params.modelId,
    modelApi: params.modelApi,
    secretSentinels: true,
  });
  if (params.authProfileId && auth.profileId !== params.authProfileId) {
    return undefined;
  }
  return fingerprintResolvedProviderAuth(auth);
}

export async function createSystemAgentVerifiedInferenceBinding(params: {
  configuredRoute: SystemAgentConfiguredRoute;
  executionRoute: SystemAgentConfiguredRoute;
  auth: AgentExecutionAuthBinding;
  deps?: SystemAgentVerifiedInferenceDeps;
}): Promise<SystemAgentVerifiedInferenceBinding> {
  const deps = params.deps ?? {};
  const runConfig = structuredClone(params.executionRoute.runConfig);
  const execution = { ...params.executionRoute, runConfig } as SystemAgentConfiguredRoute;
  const authProfileId = params.auth.authProfileId ?? execution.authProfileId;
  const modelId = params.auth.modelId?.trim();
  const modelApi = params.auth.modelApi?.trim();
  if (authProfileId) {
    execution.authProfileId = authProfileId;
  }
  const proofKind = params.auth.runtimeOwnerFingerprint ? "runtime-owner" : "credential";
  if (
    (params.auth.authFingerprint && params.auth.runtimeOwnerFingerprint) ||
    (!params.auth.authFingerprint && !params.auth.runtimeOwnerFingerprint)
  ) {
    throw new Error("The successful inference run did not report one exact execution owner.");
  }
  const runtimeOwnerId = params.auth.runtimeOwnerId?.trim();
  if (proofKind === "runtime-owner" && (!params.auth.runtimeOwnerKind || !runtimeOwnerId)) {
    throw new Error("The successful inference run did not report its exact runtime owner.");
  }
  let successfulHarnessId: string | undefined;
  if (execution.runner === "embedded") {
    const configuredHarnessId = execution.agentHarnessRuntimeOverride.trim();
    const reportedHarnessId = params.auth.agentHarnessId?.trim();
    if (!configuredHarnessId) {
      throw new Error("The configured inference route did not select an agent harness.");
    }
    if (configuredHarnessId === "auto" && !reportedHarnessId) {
      throw new Error("The successful inference run did not report its exact agent harness.");
    }
    if (
      reportedHarnessId &&
      configuredHarnessId !== "auto" &&
      reportedHarnessId !== configuredHarnessId
    ) {
      throw new Error(
        `The successful inference run used agent harness "${reportedHarnessId}" instead of "${configuredHarnessId}".`,
      );
    }
    successfulHarnessId = reportedHarnessId ?? configuredHarnessId;
    execution.agentHarnessRuntimeOverride = successfulHarnessId;
  }
  let currentRuntimeArtifactFingerprint: string | undefined;
  if (execution.runner === "cli") {
    if (!params.auth.runtimeArtifactFingerprint || !params.auth.runtimeArtifactId?.trim()) {
      throw new Error("The successful CLI inference run did not report its runtime artifact.");
    }
    const resolveArtifact =
      deps.resolveCliRuntimeArtifactFingerprint ?? resolveCliRuntimeArtifactFingerprint;
    currentRuntimeArtifactFingerprint = await resolveArtifact({
      provider: execution.provider,
      config: execution.runConfig,
      agentId: "openclaw",
      runtimeArtifactId: params.auth.runtimeArtifactId.trim(),
    });
    if (currentRuntimeArtifactFingerprint !== params.auth.runtimeArtifactFingerprint) {
      throw new Error("The successful CLI runtime artifact is no longer active.");
    }
  }
  const pluginHarnessId =
    execution.runner === "embedded" && successfulHarnessId !== "openclaw"
      ? successfulHarnessId
      : undefined;
  if (pluginHarnessId) {
    if (
      params.auth.runtimeOwnerKind !== "plugin-harness" ||
      runtimeOwnerId !== pluginHarnessId ||
      !params.auth.runtimeArtifactId?.trim() ||
      !params.auth.runtimeArtifactFingerprint
    ) {
      throw new Error(
        "The successful inference harness did not report its exact runtime artifact.",
      );
    }
    const artifact = {
      id: params.auth.runtimeArtifactId.trim(),
      fingerprint: params.auth.runtimeArtifactFingerprint,
    };
    if (
      !(await validateAgentHarnessRuntimeArtifact({ harnessId: pluginHarnessId, artifact, deps }))
    ) {
      throw new Error("The successful inference harness runtime artifact is no longer active.");
    }
    currentRuntimeArtifactFingerprint = artifact.fingerprint;
  }
  const currentAuthFingerprint = await (proofKind === "runtime-owner"
    ? resolveCurrentRuntimeOwnerFingerprint({
        route: execution,
        kind: params.auth.runtimeOwnerKind!,
        runtimeOwnerId: params.auth.runtimeOwnerId!,
        ...(authProfileId ? { authProfileId } : {}),
        ...(params.auth.skipLocalCredential ? { skipLocalCredential: true } : {}),
        ...(currentRuntimeArtifactFingerprint
          ? { runtimeArtifactFingerprint: currentRuntimeArtifactFingerprint }
          : {}),
        deps,
      })
    : resolveCurrentAuthFingerprint({
        route: execution,
        ...(authProfileId ? { authProfileId } : {}),
        ...(modelId ? { modelId } : {}),
        ...(modelApi ? { modelApi } : {}),
        ...(params.auth.skipLocalCredential ? { skipLocalCredential: true } : {}),
        deps,
      }));
  const reportedAuthFingerprint =
    params.auth.authFingerprint ?? params.auth.runtimeOwnerFingerprint;
  if (!currentAuthFingerprint || reportedAuthFingerprint !== currentAuthFingerprint) {
    throw new Error("The successful inference credential is no longer the active route owner.");
  }
  const authFingerprint = reportedAuthFingerprint;
  if (!authFingerprint) {
    throw new Error("The successful inference run did not report an execution owner.");
  }
  if (
    pluginHarnessId &&
    resolveRouteHarnessOwnerPluginIds(params.configuredRoute.runConfig, execution).length === 0
  ) {
    throw new Error("The successful inference harness has no trusted manifest owner.");
  }
  const ownerPluginArtifactSnapshot = captureSystemAgentOwnerPluginArtifacts({
    config: params.configuredRoute.runConfig,
    executionRoute: execution,
    deps,
  });
  const { ownerPluginIds, ownerPluginArtifacts } = ownerPluginArtifactSnapshot;
  return {
    configuredRoute: systemAgentRouteIdentity(params.configuredRoute),
    execution,
    executionFingerprint: await projectVerifiedExecutionFingerprint(
      params.configuredRoute.runConfig,
      execution,
      ownerPluginIds,
      deps,
    ),
    ownerPluginIds,
    ownerPluginArtifacts,
    auth: {
      ...(authProfileId ? { authProfileId } : {}),
      ...(successfulHarnessId ? { agentHarnessId: successfulHarnessId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(modelApi ? { modelApi } : {}),
      authFingerprint,
      ...(proofKind === "runtime-owner" ? { proofKind } : {}),
      ...(params.auth.runtimeOwnerKind ? { runtimeOwnerKind: params.auth.runtimeOwnerKind } : {}),
      ...(runtimeOwnerId ? { runtimeOwnerId } : {}),
      ...(params.auth.runtimeArtifactFingerprint
        ? { runtimeArtifactFingerprint: params.auth.runtimeArtifactFingerprint }
        : {}),
      ...(params.auth.runtimeArtifactId
        ? { runtimeArtifactId: params.auth.runtimeArtifactId.trim() }
        : {}),
      ...(params.auth.skipLocalCredential ? { skipLocalCredential: true } : {}),
    },
  };
}

/** Re-hash plugin-owned runtime files only at a persistent side-effect boundary. */
export async function hasCurrentSystemAgentOwnerPluginArtifacts(
  binding: SystemAgentVerifiedInferenceBinding,
  deps: SystemAgentVerifiedInferenceDeps = {},
): Promise<boolean> {
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    return false;
  }
  const config = snapshot.runtimeConfig ?? snapshot.config;
  try {
    const ownerPluginIds = resolveRouteOwnerPluginIds(config, binding.execution);
    if (!isDeepStrictEqual(ownerPluginIds, binding.ownerPluginIds)) {
      return false;
    }
    return isDeepStrictEqual(
      projectOwnerPluginArtifacts({
        config,
        route: binding.execution,
        ownerPluginIds,
        deps,
      }),
      binding.ownerPluginArtifacts,
    );
  } catch {
    return false;
  }
}

/**
 * Re-check authored route ownership, then return only the frozen verified run.
 * Workspace/channel changes are excluded; broad plugin/env/tool config cannot
 * switch this frozen run, while relevant runtime plugin membership and the
 * actual selected credential are checked explicitly.
 */
export async function resolveSystemAgentVerifiedInferenceRoute(
  binding: SystemAgentVerifiedInferenceBinding,
  deps: SystemAgentVerifiedInferenceDeps = {},
): Promise<SystemAgentConfiguredRoute | null> {
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    return null;
  }
  const config = snapshot.runtimeConfig ?? snapshot.config;
  const currentRoute = await resolveSystemAgentConfiguredRouteFromConfig(
    config,
    binding.execution.agentId,
    deps,
  );
  if (
    !currentRoute ||
    !isDeepStrictEqual(systemAgentRouteIdentity(currentRoute), binding.configuredRoute)
  ) {
    return null;
  }
  // Keep the live-tested runner/harness selection frozen, but reproject its
  // owner through current config so policy/backend changes cannot reuse proof.
  const currentExecution: SystemAgentConfiguredRoute = {
    ...binding.execution,
    runConfig: currentRoute.runConfig,
  };
  let currentOwnerPluginIds: string[];
  let currentFingerprint: SystemAgentVerifiedExecutionFingerprint;
  try {
    currentOwnerPluginIds = resolveRouteOwnerPluginIds(config, currentExecution);
    if (!isDeepStrictEqual(currentOwnerPluginIds, binding.ownerPluginIds)) {
      return null;
    }
    currentFingerprint = await projectVerifiedExecutionFingerprint(
      config,
      currentExecution,
      currentOwnerPluginIds,
      deps,
    );
  } catch {
    return null;
  }
  if (!isDeepStrictEqual(currentFingerprint, binding.executionFingerprint)) {
    return null;
  }
  if (
    binding.execution.runner === "embedded" &&
    binding.auth.agentHarnessId !== binding.execution.agentHarnessRuntimeOverride
  ) {
    return null;
  }
  let currentRuntimeArtifactFingerprint: string | undefined;
  if (binding.execution.runner === "cli") {
    const resolveArtifact =
      deps.resolveCliRuntimeArtifactFingerprint ?? resolveCliRuntimeArtifactFingerprint;
    currentRuntimeArtifactFingerprint = await resolveArtifact({
      provider: currentExecution.provider,
      config: currentExecution.runConfig,
      agentId: "openclaw",
      runtimeArtifactId: binding.auth.runtimeArtifactId,
    }).catch(() => undefined);
    if (currentRuntimeArtifactFingerprint !== binding.auth.runtimeArtifactFingerprint) {
      return null;
    }
  } else if (
    binding.execution.runner === "embedded" &&
    binding.execution.agentHarnessRuntimeOverride !== "openclaw"
  ) {
    const harnessId = binding.execution.agentHarnessRuntimeOverride;
    const artifactId = binding.auth.runtimeArtifactId?.trim();
    const artifactFingerprint = binding.auth.runtimeArtifactFingerprint;
    if (!harnessId || !artifactId || !artifactFingerprint) {
      return null;
    }
    if (
      !(await validateAgentHarnessRuntimeArtifact({
        harnessId,
        artifact: { id: artifactId, fingerprint: artifactFingerprint },
        deps,
      }))
    ) {
      return null;
    }
    currentRuntimeArtifactFingerprint = artifactFingerprint;
  }
  const currentAuthFingerprint = await (
    binding.auth.proofKind === "runtime-owner"
      ? resolveCurrentRuntimeOwnerFingerprint({
          route: currentExecution,
          kind: binding.auth.runtimeOwnerKind!,
          runtimeOwnerId: binding.auth.runtimeOwnerId!,
          ...(binding.auth.authProfileId ? { authProfileId: binding.auth.authProfileId } : {}),
          ...(binding.auth.skipLocalCredential ? { skipLocalCredential: true } : {}),
          ...(currentRuntimeArtifactFingerprint
            ? { runtimeArtifactFingerprint: currentRuntimeArtifactFingerprint }
            : {}),
          deps,
        })
      : resolveCurrentAuthFingerprint({
          route: currentExecution,
          ...(binding.auth.authProfileId ? { authProfileId: binding.auth.authProfileId } : {}),
          ...(binding.auth.modelId ? { modelId: binding.auth.modelId } : {}),
          ...(binding.auth.modelApi ? { modelApi: binding.auth.modelApi } : {}),
          ...(binding.auth.skipLocalCredential ? { skipLocalCredential: true } : {}),
          deps,
        })
  ).catch(() => undefined);
  if (currentAuthFingerprint !== binding.auth.authFingerprint) {
    return null;
  }
  return binding.execution;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
