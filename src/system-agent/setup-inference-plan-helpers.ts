import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { listAgentEntries, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  type ActivateSetupInferenceDeps,
  type ActivateSetupInferenceParams,
  type SetupInferenceFailureStatus,
  parseProviderAutoSetupChoiceId,
} from "./setup-inference-core.js";

export type SetupInferenceTestPlan = {
  runner: "cli" | "embedded";
  provider: string;
  model: string;
  modelRef: string;
  config: OpenClawConfig;
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
    runtimeConfigBase: OpenClawConfig;
    sourceConfigBase: OpenClawConfig;
    configPatch: unknown;
    pluginId?: string;
  };
};

export function configureCodexCliPreparedAuth(cfg: OpenClawConfig): OpenClawConfig {
  const entry = cfg.plugins?.entries?.codex;
  const pluginConfig = entry?.config ?? {};
  const appServer =
    pluginConfig.appServer && typeof pluginConfig.appServer === "object"
      ? pluginConfig.appServer
      : {};
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        codex: {
          ...entry,
          config: {
            ...pluginConfig,
            appServer: { ...appServer, transport: "stdio", homeScope: "agent" },
          },
        },
      },
    },
  };
}

export type RunResult = {
  payloads?: Array<{ text?: string; isError?: boolean }>;
  meta?: {
    executionTrace?: { winnerProvider?: string; winnerModel?: string };
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
    livenessState?: string;
    error?: { kind?: string; message?: string };
  };
};

export function extractRunText(result: RunResult): string | undefined {
  return (
    result.meta?.finalAssistantVisibleText ??
    result.meta?.finalAssistantRawText ??
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n")
  );
}

export function extractRunTerminalError(result: RunResult): string | undefined {
  const errorPayload = result.payloads?.find((payload) => payload.isError === true)?.text?.trim();
  const hasMetaError = result.meta?.error !== undefined;
  const metaError = result.meta?.error?.message?.trim();
  const livenessState = result.meta?.livenessState?.trim().toLowerCase();
  if (
    !errorPayload &&
    !hasMetaError &&
    livenessState !== "blocked" &&
    livenessState !== "abandoned"
  ) {
    return undefined;
  }
  return (
    metaError ||
    errorPayload ||
    (livenessState ? `Inference ended in the ${livenessState} state.` : "Inference failed.")
  );
}

export function extractRunWinnerError(
  plan: SetupInferenceTestPlan,
  result: RunResult,
): string | undefined {
  const winnerProvider = result.meta?.executionTrace?.winnerProvider?.trim();
  const winnerModel = result.meta?.executionTrace?.winnerModel?.trim();
  if (!winnerProvider || !winnerModel) {
    return "The inference run did not report which provider and model produced its reply.";
  }
  if (winnerProvider === plan.provider && winnerModel === plan.model) {
    return undefined;
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
      const profileProvider = resolveProviderIdForAuth(credential.provider, aliasContext);
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

export function projectSetupTargetModelMetadata(config: OpenClawConfig, modelRef: string): unknown {
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
  const defaultAgentId = resolveDefaultAgentId(config);
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

export function mapFailoverReasonToSetupStatus(
  reason?: string | null,
): SetupInferenceFailureStatus {
  if (reason === "auth" || reason === "auth_permanent") {
    return "auth";
  }
  if (reason === "rate_limit" || reason === "overloaded") {
    return "rate_limit";
  }
  if (reason === "billing") {
    return "billing";
  }
  if (reason === "timeout") {
    return "timeout";
  }
  if (reason === "format" || reason === "model_not_found") {
    return "format";
  }
  return "unknown";
}

export function prepareManualAuthForActivation(params: {
  baseConfig: OpenClawConfig;
  preparedConfig: OpenClawConfig;
  profiles: ProviderAuthResult["profiles"];
  selectedProfileId: string;
  modelRef: string;
  providerId: string;
  pluginId?: string;
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
}): void {
  const preparedDefaultModels = params.prepared.agents?.defaults?.models;
  if (preparedDefaultModels && Object.hasOwn(preparedDefaultModels, params.modelRef)) {
    params.target.agents = {
      ...params.target.agents,
      defaults: {
        ...params.target.agents?.defaults,
        models: {
          ...params.target.agents?.defaults?.models,
          [params.modelRef]: structuredClone(
            expectDefined(
              preparedDefaultModels[params.modelRef],
              "prepared default models entry at params.model ref",
            ),
          ),
        },
      },
    };
  }

  const defaultAgentId = resolveDefaultAgentId(params.target);
  const preparedAgent = listAgentEntries(params.prepared).find(
    (agent) => normalizeAgentId(agent.id) === defaultAgentId,
  );
  if (!preparedAgent?.models || !Object.hasOwn(preparedAgent.models, params.modelRef)) {
    return;
  }
  const targetEntryKey = Object.keys(params.target.agents?.entries ?? {}).find(
    (agentId) => normalizeAgentId(agentId) === defaultAgentId,
  );
  if (!targetEntryKey || !params.target.agents?.entries?.[targetEntryKey]) {
    return;
  }
  const nextEntries = structuredClone(params.target.agents.entries);
  const targetAgent = expectDefined(nextEntries[targetEntryKey], "target agent entry");
  targetAgent.models = {
    ...targetAgent.models,
    [params.modelRef]: structuredClone(
      expectDefined(preparedAgent.models[params.modelRef], "models entry at params.model ref"),
    ),
  };
  params.target.agents = { ...params.target.agents, entries: nextEntries };
}

function findSelectedProviderConfigKey(
  config: OpenClawConfig,
  providerId: string,
): string | undefined {
  const providers = config.models?.providers;
  if (!providers) {
    return undefined;
  }
  if (Object.hasOwn(providers, providerId)) {
    return providerId;
  }
  const normalizedProvider = normalizeProviderId(providerId);
  return Object.keys(providers).find(
    (candidate) => normalizeProviderId(candidate) === normalizedProvider,
  );
}

/**
 * Provider auth hooks are untrusted setup input. Carry only the selected
 * inference route's config into the probe; OpenClaw owns every other setup
 * surface after intelligence exists.
 */
export function projectManualInferenceConfig(params: {
  baseConfig: OpenClawConfig;
  preparedConfig: OpenClawConfig;
  selectedProfile?: ProviderAuthResult["profiles"][number];
  selectedProfileId?: string;
  modelRef: string;
  providerId: string;
  pluginId?: string;
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

  const providerConfigKey = findSelectedProviderConfigKey(params.preparedConfig, params.providerId);
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
