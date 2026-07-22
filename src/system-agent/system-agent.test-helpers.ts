import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
// OpenClaw test helpers build runtime environments for rescue tests.
import {
  fingerprintAuthProfileOwnerShape,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "../agents/execution-auth-binding.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

type SystemAgentVerifiedInferenceTestFixture = {
  binding: SystemAgentVerifiedInferenceBinding;
  deps: SystemAgentVerifiedInferenceDeps;
};

/** Build exact, revalidatable proof for a test config without reading host credentials. */
export async function createSystemAgentVerifiedInferenceTestFixture(
  config: OpenClawConfig,
): Promise<SystemAgentVerifiedInferenceTestFixture> {
  const routeAgentId = resolveDefaultAgentId(config);
  const selection = resolveSimpleCompletionSelectionForAgent({
    cfg: config,
    agentId: routeAgentId,
  });
  const selectedProfileId = selection?.profileId;
  const cliExecutionProvider = selection
    ? resolveCliRuntimeExecutionProvider({
        provider: selection.provider,
        cfg: config,
        agentId: routeAgentId,
        modelId: selection.modelId,
        ...(selectedProfileId ? { authProfileId: selectedProfileId } : {}),
      })
    : undefined;
  const selectedCredential =
    selectedProfileId && selection
      ? ({
          type: "api_key",
          provider: cliExecutionProvider ?? selection.runtimeProvider ?? selection.provider,
          key: "test-key",
        } as const)
      : undefined;
  const loadAuthProfileStoreForRuntime = (() => ({
    version: 1,
    profiles: selectedProfileId ? { [selectedProfileId]: selectedCredential } : {},
  })) as never;
  const configuredRoute = await resolveSystemAgentConfiguredRouteFromConfig(config, undefined, {
    loadAuthProfileStoreForRuntime,
  });
  if (!configuredRoute) {
    throw new Error("missing test route");
  }
  const profileId = configuredRoute.authProfileId;
  const credential = {
    type: "api_key" as const,
    provider: configuredRoute.provider,
    key: "test-key",
  };
  const resolvedAuth = {
    apiKey: "test-key",
    ...(profileId ? { profileId } : {}),
    source: profileId ? `profile:${profileId}` : "models.json",
    mode: "api-key" as const,
  };
  const configuredHarnessId =
    configuredRoute.runner === "embedded"
      ? configuredRoute.agentHarnessRuntimeOverride === "auto"
        ? "codex"
        : configuredRoute.agentHarnessRuntimeOverride
      : undefined;
  const testOwnerPluginIds = [
    configuredRoute.provider,
    configuredHarnessId,
    configuredRoute.provider === "openai" ? "codex" : undefined,
    configuredRoute.provider === "claude-cli" ? "anthropic" : undefined,
  ].filter((id, index, ids): id is string => Boolean(id) && ids.indexOf(id) === index);
  const deps: SystemAgentVerifiedInferenceDeps = {
    loadAuthProfileStoreForRuntime,
    ensureAuthProfileStore: (() => ({
      version: 1,
      profiles: profileId ? { [profileId]: credential } : {},
    })) as never,
    resolveApiKeyForProvider: async () => resolvedAuth,
    validateAgentHarnessRuntimeArtifact: async () => true,
    loadPluginRegistrySnapshot: (() => ({
      plugins: testOwnerPluginIds.map((pluginId) => ({
        pluginId,
        origin: "global",
        rootDir: `/plugins/${pluginId}`,
        manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
        manifestHash: `${pluginId}-manifest-v1`,
        source: `/plugins/${pluginId}/index.js`,
        packageName: `@openclaw/${pluginId}`,
        packageVersion: "1.0.0",
        installRecordHash: `${pluginId}-install-v1`,
        packageJson: {
          path: `/plugins/${pluginId}/package.json`,
          hash: `${pluginId}-package-v1`,
        },
      })),
    })) as never,
    fingerprintPluginRuntimeArtifact: (record) => `${record.pluginId}-test-runtime-v1`,
  };

  if (configuredRoute.runner === "cli") {
    const runtimeArtifactId = configuredRoute.provider;
    const runtimeArtifactFingerprint = `${runtimeArtifactId}-artifact-v1`;
    const authProfileOwnerFingerprint = profileId
      ? fingerprintAuthProfileOwnerShape({ profileId, credential })
      : undefined;
    const resolveRuntimeOwnerFingerprint = (currentConfig: OpenClawConfig) => {
      const backend = resolveCliBackendConfig(configuredRoute.provider, currentConfig, {
        agentId: "openclaw",
      });
      if (!backend || backend.id !== runtimeArtifactId) {
        return undefined;
      }
      return fingerprintOpaqueRuntimeOwner({
        kind: "cli-runtime",
        runner: "cli",
        provider: configuredRoute.provider,
        backendId: backend.id,
        backendConfig: {
          config: backend.config,
          bundleMcp: backend.bundleMcp,
          bundleMcpMode: backend.bundleMcpMode,
          authEpochMode: backend.authEpochMode,
          nativeToolMode: backend.nativeToolMode,
          sideQuestionToolMode: backend.sideQuestionToolMode,
        },
        ...(profileId ? { authProfileId: profileId } : {}),
        ...(authProfileOwnerFingerprint ? { authProfileOwnerFingerprint } : {}),
        runtimeArtifactFingerprint,
      });
    };
    const runtimeOwnerFingerprint = resolveRuntimeOwnerFingerprint(config);
    if (!runtimeOwnerFingerprint) {
      throw new Error("missing test CLI runtime owner fingerprint");
    }
    deps.resolveCliRuntimeArtifactFingerprint = async () => runtimeArtifactFingerprint;
    deps.resolveCliRuntimeOwnerFingerprint = async (params) =>
      params.runtimeArtifactFingerprint === runtimeArtifactFingerprint
        ? resolveRuntimeOwnerFingerprint(params.config)
        : undefined;
    const binding = await createSystemAgentVerifiedInferenceBinding({
      configuredRoute,
      executionRoute: configuredRoute,
      auth: {
        ...(profileId ? { authProfileId: profileId } : {}),
        runtimeOwnerFingerprint,
        runtimeOwnerKind: "cli-runtime",
        runtimeOwnerId: runtimeArtifactId,
        runtimeArtifactId,
        runtimeArtifactFingerprint,
      },
      deps,
    });
    return { binding, deps };
  }

  const agentHarnessId =
    configuredRoute.agentHarnessRuntimeOverride === "auto"
      ? "openclaw"
      : configuredRoute.agentHarnessRuntimeOverride;
  const authFingerprint =
    profileId && agentHarnessId !== "openclaw"
      ? fingerprintResolvedAuthProfileCredential({ profileId, credential, resolvedAuth })
      : fingerprintResolvedProviderAuth(resolvedAuth);
  if (!authFingerprint) {
    throw new Error("missing test embedded auth fingerprint");
  }
  deps.resolveAgentHarnessAuthBindingFingerprint = async () => authFingerprint;
  const binding = await createSystemAgentVerifiedInferenceBinding({
    configuredRoute,
    executionRoute: configuredRoute,
    auth: {
      ...(profileId ? { authProfileId: profileId } : {}),
      authFingerprint,
      agentHarnessId,
      modelId: configuredRoute.model,
      modelApi:
        configuredRoute.provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      ...(agentHarnessId === "openclaw"
        ? {}
        : {
            runtimeOwnerKind: "plugin-harness" as const,
            runtimeOwnerId: agentHarnessId,
            runtimeArtifactId: `${agentHarnessId}-test-artifact`,
            runtimeArtifactFingerprint: `${agentHarnessId}-test-fingerprint`,
          }),
    },
    deps,
  });
  return { binding, deps };
}

/**
 * Test helpers for capturing OpenClaw runtime output.
 *
 * Tests use this lightweight runtime instead of the real CLI runtime so exits
 * become thrown errors and logs are easy to assert.
 */
/** Create a RuntimeEnv that records log/error lines for tests. */
export function createSystemAgentTestRuntime(): { runtime: RuntimeEnv; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    runtime: {
      log: (...args) => lines.push(args.join(" ")),
      error: (...args) => lines.push(args.join(" ")),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
  };
}
