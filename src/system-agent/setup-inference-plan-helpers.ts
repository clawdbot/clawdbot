import { randomUUID } from "node:crypto";
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentRunResultView } from "../agents/agent-run-result.js";
import { listAgentEntries, resolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import {
  buildModelAliasIndex,
  legacyModelKey,
  modelKey,
  normalizeProviderId,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { buildAgentRuntimeAuthPlan } from "../agents/runtime-plan/auth.js";
import { GEMINI_CLI_DEFAULT_MODEL_REF } from "../commands/onboard-inference.js";
import { createMergePatch } from "../config/merge-patch.js";
import { mergeAgentModelEntryForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { ProviderAuthResult, ProviderPlugin } from "../plugins/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  type ActivateSetupInferenceDeps,
  type ActivateSetupInferenceParams,
  type SetupInferenceFailureStatus,
  parseProviderAutoSetupChoiceId,
} from "./setup-inference-core.js";

export type SetupInferenceTestPlan = {
  runner: "cli" | "embedded";
  /** Runtime selected by the provider's prepared model metadata. */
  selectedAgentRuntimeId?: string;
  provider: string;
  model: string;
  modelRef: string;
  /** Authored/staged config used for route, auth, and persistence decisions. */
  config: OpenClawConfig;
  /** Installer-owned preparation facts, separate from provider-authored config patches. */
  pendingPluginInstalls?: Record<string, PluginInstallRecord>;
  /** Execution-only projection that admits the reserved OpenClaw agent. */
  executionConfig?: OpenClawConfig;
  /** Execution identity used by the real OpenClaw turn. */
  agentId?: string;
  /** Default-agent owner whose model/runtime config is being selected. */
  routeAgentId?: string;
  agentDir?: string;
  agentHarnessRuntimeOverride?: string;
  cleanupBundleMcpOnRunEnd?: boolean;
  authProfileId?: string;
  /** Model to persist as default on success; undefined keeps the current one. */
  persistModelRef?: string;
  manualAuth?: {
    profiles: ProviderAuthResult["profiles"];
    sourceConfigBase: OpenClawConfig;
    configPatch: unknown;
    pluginId?: string;
  };
};

export function configureCodexCliPreparedAuth(
  cfg: OpenClawConfig,
  homeScope: "agent" | "user",
): Result<OpenClawConfig, string> {
  const entry = cfg.plugins?.entries?.codex;
  const pluginConfig = entry?.config ?? {};
  const appServer =
    pluginConfig.appServer && typeof pluginConfig.appServer === "object"
      ? pluginConfig.appServer
      : {};
  // Prepared sign-in owns a local stdio app-server; silently rewriting an
  // explicit remote transport would move the credential boundary onto this host.
  const transport = "transport" in appServer ? appServer.transport : undefined;
  if (typeof transport === "string" && transport !== "stdio") {
    return err(
      `Codex setup needs a local stdio app-server for prepared sign-in, but plugins.entries.codex.config.appServer.transport is "${transport}". Remove that transport override to let setup manage a local Codex, or finish Codex sign-in on the remote app-server host and retry.`,
    );
  }
  return ok({
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        codex: {
          ...entry,
          config: {
            ...pluginConfig,
            appServer: { ...appServer, transport: "stdio", homeScope },
          },
        },
      },
    },
  });
}

export async function extractRunWinnerError(
  plan: SetupInferenceTestPlan,
  result: AgentRunResultView,
): Promise<string | undefined> {
  const winnerProvider = result.meta?.executionTrace?.winnerProvider?.trim();
  const winnerModel = result.meta?.executionTrace?.winnerModel?.trim();
  if (!winnerProvider || !winnerModel) {
    return "The inference run did not report which provider and model produced its reply.";
  }
  if (winnerProvider === plan.provider) {
    if (winnerModel === plan.model) {
      return undefined;
    }
    const { resolveDirectBundledProviderPolicySurface } =
      await import("../plugins/provider-policy-surface.js");
    if (
      resolveDirectBundledProviderPolicySurface(plan.provider)?.isResponseModelEquivalent?.({
        provider: plan.provider,
        requestedModelId: plan.model,
        responseModelId: winnerModel,
      }) === true
    ) {
      return undefined;
    }
  }
  return `The inference run answered through ${winnerProvider}/${winnerModel} instead of the requested ${plan.provider}/${plan.model}. Disable model-routing overrides or choose the working route directly, then retry.`;
}

export function resolveToolFreeCliSetupError(plan: SetupInferenceTestPlan): string | undefined {
  if (plan.runner !== "cli") {
    return undefined;
  }
  const backend = resolveCliBackendConfig(
    plan.provider,
    plan.config,
    plan.agentId ? { agentId: plan.agentId } : {},
  );
  if (backend?.sideQuestionToolMode === "disabled") {
    return undefined;
  }
  const geminiCliProvider = parseRef(GEMINI_CLI_DEFAULT_MODEL_REF).provider;
  if (backend?.nativeToolMode === "none" && plan.provider !== geminiCliProvider) {
    return undefined;
  }
  return plan.provider === geminiCliProvider
    ? "Gemini CLI cannot be used for inference-gated setup because it has no hard tool-free mode. Choose Claude Code, Codex, or an API-key provider; normal Gemini CLI agent runs remain available after setup."
    : `CLI backend ${backend?.id ?? plan.provider} cannot be used for inference-gated setup because it has no hard tool-free mode. Choose another inference provider.`;
}

export function resolveStrictSetupAuthProfileError(params: {
  plan: SetupInferenceTestPlan;
  workspaceDir: string;
  deps: ActivateSetupInferenceDeps;
}): string | undefined {
  const profileId = params.plan.authProfileId?.trim();
  if (!profileId) {
    return undefined;
  }
  const loadStore = params.deps.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
  const store = loadStore(params.plan.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    config: params.plan.config,
    externalCliProviderIds: [params.plan.provider],
  });
  const credential = store.profiles[profileId];
  if (!credential) {
    return `No credentials found for the configured setup profile "${profileId}".`;
  }

  if (params.plan.runner === "embedded") {
    const authPlan = buildAgentRuntimeAuthPlan({
      provider: params.plan.provider,
      authProfileProvider: credential.provider,
      authProfileMode: credential.type,
      sessionAuthProfileId: profileId,
      config: params.plan.config,
      workspaceDir: params.workspaceDir,
      harnessId: params.plan.agentHarnessRuntimeOverride,
      harnessRuntime: params.plan.agentHarnessRuntimeOverride,
      allowHarnessAuthProfileForwarding: true,
    });
    if (authPlan.forwardedAuthProfileId === profileId) {
      return undefined;
    }
  } else {
    const aliasContext = {
      config: params.plan.config,
      workspaceDir: params.workspaceDir,
    };
    try {
      const runProvider = resolveProviderIdForAuth(params.plan.provider, aliasContext);
      const profileProvider = resolveProviderIdForAuth(credential.provider, {
        ...aliasContext,
        storedCredential: true,
      });
      if (runProvider === profileProvider) {
        return undefined;
      }
    } catch {
      return `Could not verify that configured setup profile "${profileId}" belongs to the selected ${params.plan.provider} inference route.`;
    }
  }

  return `Configured setup profile "${profileId}" belongs to ${credential.provider}, not the selected ${params.plan.provider} inference route.`;
}

export function parseRef(modelRef: string): { provider: string; model: string } {
  const slash = modelRef.indexOf("/");
  return slash === -1
    ? { provider: modelRef, model: "" }
    : { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

export function projectSetupTargetModelMetadata(
  config: OpenClawConfig,
  modelRef: string,
  agentId?: string,
): unknown {
  const target = parseRef(modelRef);
  const canonicalKey = modelKey(target.provider, target.model);
  const keys = new Set(
    [
      canonicalKey,
      legacyModelKey(target.provider, target.model),
      `${target.provider}/${canonicalKey}`,
    ].filter((key): key is string => Boolean(key)),
  );
  const project = (models: Record<string, unknown> | undefined) =>
    Object.fromEntries(
      [...keys].map((key) => [
        key,
        Object.hasOwn(models ?? {}, key)
          ? { exists: true, value: structuredClone(models?.[key]) }
          : { exists: false },
      ]),
    );
  const defaultAgentId = resolveAmbientOwnerAgentId(config, agentId);
  const agent = listAgentEntries(config).find(
    (entry) => normalizeAgentId(entry.id) === defaultAgentId,
  );
  return {
    defaultAgentId,
    defaults: project(config.agents?.defaults?.models),
    agent: project(agent?.models),
  };
}

export function resolveSetupAgentRuntimeId(
  kind: ActivateSetupInferenceParams["kind"],
): string | undefined {
  if (kind === "claude-cli") {
    return "claude-cli";
  }
  if (kind === "codex-cli") {
    return "codex";
  }
  if (
    kind === "openai-api-key" ||
    kind === "anthropic-api-key" ||
    kind === "api-key" ||
    kind === "provider-auth" ||
    parseProviderAutoSetupChoiceId(kind) !== undefined
  ) {
    return "openclaw";
  }
  return undefined;
}

const SETUP_STATUS_BY_FAILOVER_REASON = {
  auth: "auth",
  auth_permanent: "auth",
  format: "format",
  rate_limit: "rate_limit",
  overloaded: "rate_limit",
  billing: "billing",
  server_error: "unknown",
  timeout: "timeout",
  tls_certificate: "unknown",
  context_overflow: "unknown",
  model_not_found: "format",
  session_expired: "unknown",
  empty_response: "unknown",
  no_error_details: "unknown",
  unclassified: "unknown",
  unknown: "unknown",
} satisfies Record<FailoverReason, SetupInferenceFailureStatus>;

export function mapFailoverReasonToSetupStatus(
  reason?: string | null,
): SetupInferenceFailureStatus {
  return reason
    ? (SETUP_STATUS_BY_FAILOVER_REASON[reason as FailoverReason] ?? "unknown")
    : "unknown";
}

export function prepareManualAuthForActivation(params: {
  baseConfig: OpenClawConfig;
  preparedConfig: OpenClawConfig;
  profiles: ProviderAuthResult["profiles"];
  selectedProfileId: string;
  modelRef: string;
  targetModelRef: string;
  providerId: string;
  pluginId?: string;
  agentId?: string;
}): {
  config: OpenClawConfig;
  profiles: ProviderAuthResult["profiles"];
  selectedProfileId: string;
} {
  const selectedProfile = params.profiles.find(
    (profile) => profile.profileId === params.selectedProfileId,
  );
  if (!selectedProfile) {
    throw new Error("The selected setup credential was not returned by its provider.");
  }
  const provider = normalizeProviderId(selectedProfile.credential.provider) || "provider";
  const selectedProfileId = `${provider}:setup-${randomUUID()}`;
  const profile = { ...selectedProfile, profileId: selectedProfileId };
  const config = projectManualInferenceConfig({
    ...params,
    selectedProfile,
    selectedProfileId,
  });
  return {
    config,
    profiles: [profile],
    selectedProfileId,
  };
}

function copySelectedModelMetadata(params: {
  target: OpenClawConfig;
  prepared: OpenClawConfig;
  modelRef: string;
  targetModelRef: string;
  agentId?: string;
}): void {
  const key = params.targetModelRef;
  const defaultEntry = params.prepared.agents?.defaults?.models?.[params.modelRef];
  // An alias can select an existing canonical row; unspecified settings must survive projection.
  if (defaultEntry !== undefined) {
    const defaults = ((params.target.agents ??= {}).defaults ??= {});
    const models = (defaults.models ??= {});
    models[key] = mergeAgentModelEntryForConfig(models[key], structuredClone(defaultEntry));
  }
  const defaultAgentId = resolveAmbientOwnerAgentId(params.target, params.agentId);
  const preparedAgent = listAgentEntries(params.prepared).find(
    (agent) => normalizeAgentId(agent.id) === defaultAgentId,
  );
  const selectedEntry = preparedAgent?.models?.[params.modelRef];
  const targetAgent = Object.entries(params.target.agents?.entries ?? {}).find(
    ([agentId]) => normalizeAgentId(agentId) === defaultAgentId,
  )?.[1];
  if (selectedEntry !== undefined && targetAgent) {
    const models = (targetAgent.models ??= {});
    models[key] = mergeAgentModelEntryForConfig(models[key], structuredClone(selectedEntry));
  }
}

/**
 * Provider auth hooks are untrusted setup input. Carry only the selected
 * inference route's config into the probe; OpenClaw owns every other setup
 * surface after intelligence exists.
 */
function projectManualInferenceConfig(params: {
  baseConfig: OpenClawConfig;
  preparedConfig: OpenClawConfig;
  selectedProfile?: ProviderAuthResult["profiles"][number];
  selectedProfileId?: string;
  modelRef: string;
  targetModelRef: string;
  providerId: string;
  pluginId?: string;
  agentId?: string;
}): OpenClawConfig {
  const config = structuredClone(params.baseConfig);
  if (params.selectedProfile && params.selectedProfileId) {
    const metadata = params.preparedConfig.auth?.profiles?.[params.selectedProfile.profileId] ?? {
      provider: params.selectedProfile.credential.provider,
      mode: params.selectedProfile.credential.type,
    };
    config.auth = {
      ...config.auth,
      profiles: {
        ...config.auth?.profiles,
        [params.selectedProfileId]: structuredClone(metadata),
      },
    };
  }

  const providers = params.preparedConfig.models?.providers;
  const providerConfigKey =
    providers && Object.hasOwn(providers, params.providerId)
      ? params.providerId
      : findNormalizedProviderKey(providers, params.providerId);
  if (providerConfigKey) {
    const preparedProvider = params.preparedConfig.models?.providers?.[providerConfigKey];
    if (preparedProvider === undefined) {
      throw new Error(`Prepared provider config missing for ${providerConfigKey}`);
    }
    config.models = {
      ...config.models,
      providers: {
        ...config.models?.providers,
        [providerConfigKey]: structuredClone(preparedProvider),
      },
    };
  }

  if (params.pluginId) {
    const preparedEntry = params.preparedConfig.plugins?.entries?.[params.pluginId];
    if (preparedEntry !== undefined) {
      config.plugins = {
        ...config.plugins,
        entries: {
          ...config.plugins?.entries,
          [params.pluginId]: structuredClone(preparedEntry),
        },
      };
    }
  }
  copySelectedModelMetadata({
    target: config,
    prepared: params.preparedConfig,
    modelRef: params.modelRef,
    targetModelRef: params.targetModelRef,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  return config;
}

export function canonicalizeSetupModelRef(params: {
  cfg: OpenClawConfig;
  raw: string;
  defaultProvider: string;
}): string {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw: params.raw,
    defaultProvider: params.defaultProvider,
    aliasIndex,
  });
  return resolved ? `${resolved.ref.provider}/${resolved.ref.model}` : params.raw;
}

export function buildPreparedProviderTestPlan(params: {
  cfg: OpenClawConfig;
  sourceCfg: OpenClawConfig;
  preparedConfig: OpenClawConfig;
  profiles: ProviderAuthResult["profiles"];
  providerPlugin?: ProviderPlugin;
  modelRef: string;
  pluginId?: string;
  routeAgentId: string;
  agentDir: string;
  pendingPluginInstalls?: Record<string, PluginInstallRecord>;
}): SetupInferenceTestPlan | { error: string } {
  const ref = parseRef(params.modelRef);
  // Auth starters are raw provider input; guided discovery already chose its canonical model.
  ref.model =
    normalizeOptionalString(
      params.providerPlugin?.normalizeModelId?.({
        provider: ref.provider,
        modelId: ref.model,
      }),
    ) ?? ref.model;
  const modelRef = `${ref.provider}/${ref.model}`;
  // Auth can return several providers; only the selected model's credential enters its plan.
  const providerId = normalizeProviderId(ref.provider);
  const matchingProfile = params.profiles.find(
    (profile) => normalizeProviderId(profile.credential.provider) === providerId,
  );
  if (params.profiles.length > 0 && !matchingProfile) {
    return {
      error: `${params.providerPlugin?.label ?? ref.provider} did not return credentials for "${modelRef}".`,
    };
  }
  const projection = {
    baseConfig: params.cfg,
    preparedConfig: params.preparedConfig,
    modelRef: params.modelRef,
    targetModelRef: modelRef,
    providerId: ref.provider,
    pluginId: params.pluginId,
    agentId: params.routeAgentId,
  };
  const prepared = matchingProfile
    ? prepareManualAuthForActivation({
        ...projection,
        profiles: params.profiles,
        selectedProfileId: matchingProfile.profileId,
      })
    : {
        config: projectManualInferenceConfig(projection),
        profiles: [],
        selectedProfileId: undefined,
      };
  if (params.pendingPluginInstalls) {
    prepared.config = {
      ...prepared.config,
      plugins: {
        ...prepared.config.plugins,
        installs: { ...params.cfg.plugins?.installs, ...params.pendingPluginInstalls },
      },
    };
  }
  const selectedAgentRuntimeId =
    resolveModelRuntimePolicy({
      config: prepared.config,
      provider: ref.provider,
      modelId: ref.model,
      agentId: params.routeAgentId,
    }).policy?.id ?? "openclaw";
  const cliProvider = resolveCliRuntimeExecutionProvider({
    cfg: prepared.config,
    provider: ref.provider,
    modelId: ref.model,
    agentId: params.routeAgentId,
    authProfileId: prepared.selectedProfileId,
  });
  return {
    runner: cliProvider ? "cli" : "embedded",
    ...ref,
    ...(cliProvider
      ? { provider: cliProvider }
      : { agentHarnessRuntimeOverride: selectedAgentRuntimeId }),
    selectedAgentRuntimeId,
    modelRef,
    agentDir: params.agentDir,
    config: prepared.config,
    ...(params.pendingPluginInstalls
      ? { pendingPluginInstalls: structuredClone(params.pendingPluginInstalls) }
      : {}),
    agentId: "openclaw",
    routeAgentId: params.routeAgentId,
    ...(prepared.selectedProfileId ? { authProfileId: prepared.selectedProfileId } : {}),
    persistModelRef: modelRef,
    manualAuth: {
      profiles: prepared.profiles,
      sourceConfigBase: params.sourceCfg,
      configPatch: createMergePatch(params.cfg, prepared.config),
      ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    },
  };
}
