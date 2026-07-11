// First-run inference activation: detect candidates, live-test, persist only on success.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeAuthProfileCredential } from "../agents/auth-profiles/credential-normalize.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  loadAuthProfileStoreForRuntime,
  updateAuthProfileStoreWithLock,
} from "../agents/auth-profiles/store.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { describeFailoverError } from "../agents/failover-error.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  buildModelAliasIndex,
  legacyModelKey,
  modelKey,
  normalizeProviderId,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { buildAgentRuntimeAuthPlan } from "../agents/runtime-plan/auth.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
  detectInferenceBackends,
  type InferenceBackendKind,
} from "../commands/onboard-inference.js";
import { createMergePatch } from "../config/io.write-prepare.js";
import { applyMergePatch } from "../config/merge-patch.js";
import {
  normalizeAgentModelRefForConfig,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import {
  applyProviderPluginAuthMethodResultConfig,
  runProviderPluginAuthMethodUnpersisted,
} from "../plugins/provider-auth-choice.js";
import {
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
  type ProviderAuthChoiceMetadata,
} from "../plugins/provider-auth-choices.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
import type { ProviderAuthMethod, ProviderAuthResult } from "../plugins/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { appendCrestodianAuditEntry } from "./audit.js";
import {
  projectDefaultInferenceRoute,
  resolveCrestodianConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
  type CrestodianConfiguredRoute,
} from "./inference-route.js";
import { loadAuthoredSetupConfig } from "./onboarding-welcome.js";
import {
  applyCrestodianModelSelection,
  createCrestodianModelSelectionUpdater,
  createQuickstartNotePrompter,
} from "./setup-apply.js";
import {
  captureCrestodianOwnerPluginArtifacts,
  createCrestodianVerifiedInferenceBinding,
  hasCurrentCrestodianOwnerPluginArtifacts,
  resolveCrestodianVerifiedInferenceRoute,
  type CrestodianVerifiedInferenceBinding,
  type CrestodianVerifiedInferenceDeps,
  type CrestodianOwnerPluginArtifactSnapshot,
} from "./verified-inference.js";

const log = createSubsystemLogger("crestodian/setup-inference");

/**
 * Inference is the one required onboarding step (docs/cli/crestodian.md
 * "Setup bootstrap"). This module gives structured clients (macOS app) the
 * same ladder the conversation uses, with one hard guarantee: a candidate is
 * persisted as the default model only after a real completion round-trips.
 * A failing candidate must never leave config pointing at a broken model.
 */
export const SETUP_INFERENCE_TEST_TIMEOUT_MS = 90_000;
const SETUP_INFERENCE_TEST_PROMPT = "Reply with the single word OK. Do not use tools.";
const SETUP_INFERENCE_TEST_MAX_TOKENS = 32;

export type SetupInferenceCandidate = {
  kind: InferenceBackendKind;
  label: string;
  detail: string;
  modelRef: string;
  /** @deprecated Gateway wire compatibility for older macOS clients. Always false. */
  recommended: false;
  credentials?: boolean;
};

export type SetupInferenceManualProvider = {
  /** Provider-auth choice id sent back to `crestodian.setup.activate`. */
  id: string;
  label: string;
  hint?: string;
};

export type SetupInferenceDetection = {
  candidates: SetupInferenceCandidate[];
  /** Text-inference key/token methods exposed by installed provider manifests. */
  manualProviders: SetupInferenceManualProvider[];
  /** Resolved workspace the setup apply would use (display + default). */
  workspace: string;
  configuredModel?: string;
  /** The connected Gateway already has a configured default-agent model. */
  setupComplete: boolean;
};

export type SetupInferenceStatus =
  | "ok"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unavailable"
  | "unknown";

export type SetupInferenceFailureStatus = Exclude<SetupInferenceStatus, "ok">;

export type ActivateSetupInferenceResult =
  | { ok: true; modelRef: string; latencyMs: number; lines: string[] }
  | { ok: false; status: SetupInferenceFailureStatus; error: string };

/**
 * The config commit may have happened, so callers must verify current setup
 * instead of treating this like a definitive candidate failure and retrying.
 */
export class SetupInferenceActivationIndeterminateError extends Error {
  override name = "SetupInferenceActivationIndeterminateError";
}

class SetupInferenceActivationUnavailableError extends Error {
  override name = "SetupInferenceActivationUnavailableError";
}

export type VerifySetupInferenceResult =
  | { ok: true; modelRef: string; latencyMs: number }
  | { ok: false; status: SetupInferenceFailureStatus; error: string };

export type BoundVerifySetupInferenceResult =
  | {
      ok: true;
      modelRef: string;
      latencyMs: number;
      binding: CrestodianVerifiedInferenceBinding;
    }
  | { ok: false; status: SetupInferenceFailureStatus; error: string };

export type ActivateSetupInferenceParams = {
  kind: InferenceBackendKind | "api-key";
  /** Exact explicit model to probe and persist instead of the route's starter model. */
  modelRef?: string;
  /** Manual step only: provider-auth choice returned by detection. */
  authChoice?: string;
  /** Manual step only: the pasted API key or token. Never logged. */
  apiKey?: string;
  workspace?: string;
  surface: "cli" | "gateway";
  /** False when an enclosing persistent-operation boundary owns the setup audit. */
  recordSetupAudit?: boolean;
  runtime: RuntimeEnv;
  deps?: ActivateSetupInferenceDeps;
};

type SetupInferenceRunEmbeddedAgent = (
  params: Parameters<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>[0] & {
    onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
    authProfileStateMode?: "read-write" | "read-only";
  },
) => ReturnType<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>;

export type ActivateSetupInferenceDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  runEmbeddedAgent?: SetupInferenceRunEmbeddedAgent;
  runCliAgent?: typeof import("../agents/cli-runner.js").runCliAgent;
  ensureCodexRuntimePlugin?: typeof import("../commands/codex-runtime-plugin-install.js").ensureCodexRuntimePluginForModelSelection;
  ensureSelectedAgentHarnessPlugin?: typeof import("../agents/harness/runtime-plugin.js").ensureSelectedAgentHarnessPlugin;
  transformConfigWithPendingPluginInstalls?: typeof import("../plugins/install-record-commit.js").transformConfigWithPendingPluginInstalls;
  refreshPluginRegistryAfterConfigMutation?: typeof import("../plugins/registry-refresh.js").refreshPluginRegistryAfterConfigMutation;
  ensurePluginRegistryLoaded?: typeof import("../plugins/runtime/runtime-registry-loader.js").ensurePluginRegistryLoaded;
  resolvePluginProviders?: typeof resolvePluginProviders;
  resolveManifestProviderAuthChoice?: typeof resolveManifestProviderAuthChoice;
  enablePluginInConfig?: typeof enablePluginInConfig;
  updateAuthProfileStoreWithLock?: typeof updateAuthProfileStoreWithLock;
  loadPersistedAuthProfileStore?: typeof loadPersistedAuthProfileStore;
  loadAuthProfileStoreForRuntime?: typeof loadAuthProfileStoreForRuntime;
  ensureAuthProfileStore?: typeof import("../agents/auth-profiles/store.js").ensureAuthProfileStore;
  resolveCliAuthBindingFingerprint?: typeof import("../agents/cli-auth-epoch.js").resolveCliAuthBindingFingerprint;
  resolveCliRuntimeArtifactFingerprint?: typeof import("../agents/cli-auth-epoch.js").resolveCliRuntimeArtifactFingerprint;
  resolveCliRuntimeOwnerFingerprint?: typeof import("../agents/cli-auth-epoch.js").resolveCliRuntimeOwnerFingerprint;
  resolveApiKeyForProvider?: typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
  loadPluginRegistrySnapshot?: CrestodianVerifiedInferenceDeps["loadPluginRegistrySnapshot"];
  fingerprintPluginRuntimeArtifact?: CrestodianVerifiedInferenceDeps["fingerprintPluginRuntimeArtifact"];
  captureCrestodianOwnerPluginArtifacts?: typeof captureCrestodianOwnerPluginArtifacts;
  createCrestodianVerifiedInferenceBinding?: typeof createCrestodianVerifiedInferenceBinding;
  readPersistedInstalledPluginIndexInstallRecords?: typeof import("../plugins/installed-plugin-index-records.js").readPersistedInstalledPluginIndexInstallRecords;
  markRetainedManagedNpmInstall?: typeof import("../plugins/managed-npm-retention.js").markRetainedManagedNpmInstall;
  clearLoadInstalledPluginIndexInstallRecordsCache?: typeof import("../plugins/installed-plugin-index-records.js").clearLoadInstalledPluginIndexInstallRecordsCache;
  clearPluginMetadataLifecycleCaches?: typeof import("../plugins/plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;
  invalidatePluginRuntimeDiscoveryAfterConfigMutation?: typeof import("../plugins/registry-refresh.js").invalidatePluginRuntimeDiscoveryAfterConfigMutation;
  disposeOpenClawAgentDatabaseByPath?: typeof import("../state/openclaw-agent-db.js").disposeOpenClawAgentDatabaseByPath;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
  timeoutMs?: number;
};

export type DetectSetupInferenceDeps = {
  resolveManifestProviderAuthChoices?: typeof resolveManifestProviderAuthChoices;
};

function invalidSetupConfigError(snapshot: {
  path: string;
  issues?: Array<{ path?: string; message: string }>;
}): string {
  const issue = snapshot.issues?.[0];
  const detail = issue ? ` (${issue.path ? `${issue.path}: ` : ""}${issue.message})` : "";
  return `OpenClaw config ${snapshot.path} is invalid${detail}. Fix it before running setup.`;
}

async function resolveSetupInferenceWorkspace(params: {
  configExists: boolean;
  configValid: boolean;
}): Promise<{ workspace: string; hasAuthoredSetup: boolean }> {
  const { authoredConfig, hasAuthoredSetup } = await loadAuthoredSetupConfig(params);
  const { DEFAULT_WORKSPACE } = await import("../commands/onboard-helpers.js");
  return {
    workspace: resolveUserPath(
      authoredConfig?.agents?.defaults?.workspace?.trim() || DEFAULT_WORKSPACE,
    ),
    hasAuthoredSetup,
  };
}

function supportsTextInference(scopes?: ProviderAuthChoiceMetadata["onboardingScopes"]): boolean {
  return !scopes || scopes.includes("text-inference");
}

function supportsManualSecret(choice: ProviderAuthChoiceMetadata): boolean {
  return supportsTextInference(choice.onboardingScopes) && choice.appGuidedSecret === true;
}

export function listSetupInferenceManualProviders(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferenceManualProvider[] {
  const choices = new Map<string, SetupInferenceManualProvider>();
  for (const choice of authChoices) {
    const id = choice.choiceId.trim();
    if (!id || choices.has(id) || !supportsManualSecret(choice)) {
      continue;
    }
    choices.set(id, {
      id,
      label: choice.choiceLabel,
      ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
    });
  }
  return [...choices.values()].toSorted(
    (a, b) => a.label.localeCompare(b.label, "en") || a.id.localeCompare(b.id, "en"),
  );
}

export async function detectSetupInference(
  deps: DetectSetupInferenceDeps = {},
): Promise<SetupInferenceDetection> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(invalidSetupConfigError(snapshot));
  }
  const cfg = snapshot.exists && snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const detected = await detectInferenceBackends({ config: cfg });
  // Gemini CLI has no hard tool-off mode: wildcard exclusions can be
  // overridden by admin policy and do not stop discovery or MCP startup.
  // Keep normal agent support, but never offer it for the setup safety probe.
  const raw = detected.filter((candidate) => candidate.kind !== "gemini-cli");
  const candidates = raw.map((candidate) =>
    // Released macOS clients require this field. Keep it false so the wire
    // contract remains decodable without expressing a provider preference.
    Object.assign(candidate, { recommended: false as const }),
  );
  const { workspace } = await resolveSetupInferenceWorkspace({
    configExists: snapshot.exists,
    configValid: snapshot.valid,
  });
  const configuredModel = candidates.find(
    (candidate) => candidate.kind === "existing-model",
  )?.modelRef;
  const authChoices = (
    deps.resolveManifestProviderAuthChoices ?? resolveManifestProviderAuthChoices
  )({
    config: cfg,
    workspaceDir: workspace,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  }).filter((choice) => enablePluginInConfig(cfg, choice.pluginId).enabled);
  return {
    candidates,
    manualProviders: listSetupInferenceManualProviders(authChoices),
    workspace,
    ...(configuredModel ? { configuredModel } : {}),
    setupComplete: Boolean(configuredModel),
  };
}

type SetupInferenceTestPlan = {
  runner: "cli" | "embedded";
  provider: string;
  model: string;
  modelRef: string;
  config: OpenClawConfig;
  /** Execution identity used by the real Crestodian turn. */
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
    configBase: OpenClawConfig;
    configPatch: unknown;
    pluginId?: string;
  };
};

function configureCodexCliNativeAuth(cfg: OpenClawConfig): OpenClawConfig {
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
            appServer: { ...appServer, transport: "stdio", homeScope: "user" },
          },
        },
      },
    },
  };
}

type RunResult = {
  payloads?: Array<{ text?: string; isError?: boolean }>;
  meta?: {
    executionTrace?: { winnerProvider?: string; winnerModel?: string };
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
    livenessState?: string;
    error?: { kind?: string; message?: string };
  };
};

function extractRunText(result: RunResult): string | undefined {
  return (
    result.meta?.finalAssistantVisibleText ??
    result.meta?.finalAssistantRawText ??
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n")
  );
}

function extractRunTerminalError(result: RunResult): string | undefined {
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

function extractRunWinnerError(
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

function resolveToolFreeCliSetupError(plan: SetupInferenceTestPlan): string | undefined {
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

function resolveStrictSetupAuthProfileError(params: {
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

function parseRef(modelRef: string): { provider: string; model: string } {
  const slash = modelRef.indexOf("/");
  return slash === -1
    ? { provider: modelRef, model: "" }
    : { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

function projectSetupTargetModelMetadata(config: OpenClawConfig, modelRef: string): unknown {
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
  const agent = config.agents?.list?.find((entry) => normalizeAgentId(entry.id) === defaultAgentId);
  return {
    defaultAgentId,
    defaults: project(config.agents?.defaults?.models),
    agent: project(agent?.models),
  };
}

function resolveSetupAgentRuntimeId(
  kind: ActivateSetupInferenceParams["kind"],
): string | undefined {
  if (kind === "codex-cli") {
    return "codex";
  }
  if (kind === "openai-api-key" || kind === "anthropic-api-key" || kind === "api-key") {
    return "openclaw";
  }
  return undefined;
}

function mapFailoverReasonToSetupStatus(reason?: string | null): SetupInferenceFailureStatus {
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

function prepareManualAuthForActivation(params: {
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
          [params.modelRef]: structuredClone(preparedDefaultModels[params.modelRef]),
        },
      },
    };
  }

  const defaultAgentId = resolveDefaultAgentId(params.target);
  const preparedAgent = params.prepared.agents?.list?.find((agent) => agent.id === defaultAgentId);
  if (!preparedAgent?.models || !Object.hasOwn(preparedAgent.models, params.modelRef)) {
    return;
  }
  const targetAgents = params.target.agents?.list;
  const targetAgentIndex = targetAgents?.findIndex((agent) => agent.id === defaultAgentId) ?? -1;
  if (!targetAgents || targetAgentIndex < 0) {
    return;
  }
  const nextAgents = structuredClone(targetAgents);
  const targetAgent = nextAgents[targetAgentIndex];
  if (!targetAgent) {
    return;
  }
  targetAgent.models = {
    ...targetAgent.models,
    [params.modelRef]: structuredClone(preparedAgent.models[params.modelRef]),
  };
  params.target.agents = { ...params.target.agents, list: nextAgents };
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
 * inference route's config into the probe; Crestodian owns every other setup
 * surface after intelligence exists.
 */
function projectManualInferenceConfig(params: {
  baseConfig: OpenClawConfig;
  preparedConfig: OpenClawConfig;
  selectedProfile: ProviderAuthResult["profiles"][number];
  selectedProfileId: string;
  modelRef: string;
  providerId: string;
  pluginId?: string;
}): OpenClawConfig {
  const config = structuredClone(params.baseConfig);
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

  const providerConfigKey = findSelectedProviderConfigKey(params.preparedConfig, params.providerId);
  if (providerConfigKey) {
    config.models = {
      ...config.models,
      providers: {
        ...config.models?.providers,
        [providerConfigKey]: structuredClone(
          params.preparedConfig.models!.providers![providerConfigKey],
        ),
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

function canonicalizeSetupModelRef(params: {
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

async function buildTestPlan(params: {
  kind: InferenceBackendKind | "api-key";
  modelRef?: string;
  authChoice?: string;
  apiKey?: string;
  cfg: OpenClawConfig;
  workspaceDir: string;
  pluginWorkspaceDir: string;
  agentDir: string;
  runtime: RuntimeEnv;
  deps: ActivateSetupInferenceDeps;
}): Promise<SetupInferenceTestPlan | { error: string }> {
  const { kind, cfg, workspaceDir } = params;
  const resolveRouteModelRef = (defaultModelRef: string): string | { error: string } => {
    const modelRef = params.modelRef?.trim() || defaultModelRef;
    const selected = parseRef(modelRef);
    const expected = parseRef(defaultModelRef);
    if (
      !selected.model ||
      normalizeProviderId(selected.provider) !== normalizeProviderId(expected.provider)
    ) {
      return { error: `${modelRef} is not compatible with the ${kind} inference route.` };
    }
    return modelRef;
  };
  switch (kind) {
    case "existing-model": {
      const route = await resolveCrestodianConfiguredRouteFromConfig(cfg);
      if (!route) {
        return { error: "No configured default-agent inference route is available." };
      }
      const requestedModelRef = params.modelRef?.trim();
      const requestedTarget = requestedModelRef
        ? canonicalizeSetupModelRef({
            cfg,
            raw: requestedModelRef,
            defaultProvider: route.provider,
          })
        : undefined;
      if (requestedModelRef && requestedTarget !== route.modelLabel) {
        return {
          error: `The configured default model changed from ${requestedModelRef} to ${route.modelLabel}. Try setup again.`,
        };
      }
      return {
        runner: route.runner,
        provider: route.provider,
        model: route.model,
        modelRef: route.modelLabel,
        config: route.runConfig,
        agentId: "crestodian",
        routeAgentId: route.agentId,
        agentDir: route.agentDir,
        ...(route.runner === "embedded"
          ? { agentHarnessRuntimeOverride: route.agentHarnessRuntimeOverride }
          : {}),
        ...(route.authProfileId ? { authProfileId: route.authProfileId } : {}),
      };
    }
    case "claude-cli": {
      const modelRef = resolveRouteModelRef(CLAUDE_CLI_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      return {
        runner: "cli",
        ...ref,
        modelRef,
        config: cfg,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(cfg),
        persistModelRef: modelRef,
      };
    }
    case "gemini-cli": {
      const modelRef = resolveRouteModelRef(GEMINI_CLI_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      return {
        runner: "cli",
        ...ref,
        modelRef,
        config: cfg,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(cfg),
        persistModelRef: modelRef,
      };
    }
    case "codex-cli": {
      const modelRef = resolveRouteModelRef(CODEX_APP_SERVER_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        agentHarnessRuntimeOverride: "codex",
        config: cfg,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(cfg),
        agentDir: params.agentDir,
        cleanupBundleMcpOnRunEnd: true,
        persistModelRef: modelRef,
      };
    }
    case "openai-api-key": {
      const modelRef = resolveRouteModelRef(OPENAI_API_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        config: cfg,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(cfg),
        persistModelRef: modelRef,
      };
    }
    case "anthropic-api-key": {
      const modelRef = resolveRouteModelRef(ANTHROPIC_API_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        config: cfg,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(cfg),
        persistModelRef: modelRef,
      };
    }
    case "api-key": {
      const apiKey = params.apiKey?.trim();
      if (!apiKey) {
        return { error: "Enter an API key or token first." };
      }
      const authChoice = params.authChoice?.trim();
      const choice = authChoice
        ? (params.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice)(
            authChoice,
            {
              config: cfg,
              workspaceDir: params.pluginWorkspaceDir,
              includeUntrustedWorkspacePlugins: false,
              includeWorkspacePlugins: false,
            },
          )
        : undefined;
      if (!choice || !supportsManualSecret(choice)) {
        return { error: "That key-based provider is not available on this Gateway." };
      }
      const enableResult = (params.deps.enablePluginInConfig ?? enablePluginInConfig)(
        cfg,
        choice.pluginId,
      );
      if (!enableResult.enabled) {
        return {
          error: `${choice.choiceLabel} is disabled (${enableResult.reason ?? "blocked"}).`,
        };
      }
      const providers = (params.deps.resolvePluginProviders ?? resolvePluginProviders)({
        config: enableResult.config,
        workspaceDir: params.pluginWorkspaceDir,
        mode: "setup",
        includeUntrustedWorkspacePlugins: false,
        onlyPluginIds: [choice.pluginId],
      });
      const provider = providers.find(
        (candidate) =>
          candidate.pluginId === choice.pluginId &&
          normalizeProviderId(candidate.id) === normalizeProviderId(choice.providerId),
      );
      const method = provider?.auth.find((candidate) => candidate.id === choice.methodId);
      const resolved = provider && method ? { provider, method } : null;
      if (!resolved || !supportsTextInference(resolved.method.wizard?.onboardingScopes)) {
        return { error: "That key-based provider is not available on this Gateway." };
      }
      let result: ProviderAuthResult;
      let preparedConfig: OpenClawConfig;
      try {
        if (resolved.method.kind === "api_key" || resolved.method.kind === "token") {
          result = await runProviderPluginAuthMethodUnpersisted({
            config: enableResult.config,
            runtime: params.runtime,
            prompter: createQuickstartNotePrompter(params.runtime),
            method: resolved.method,
            agentDir: params.agentDir,
            workspaceDir,
            secretInputMode: "plaintext",
            allowSecretRefPrompt: false,
            opts: { token: apiKey, tokenProvider: resolved.provider.id },
          });
          preparedConfig = applyProviderPluginAuthMethodResultConfig({
            config: enableResult.config,
            result,
          });
        } else {
          const prepared = await runProviderManualSecretMethod({
            config: enableResult.config,
            baseConfig: cfg,
            choice,
            method: resolved.method,
            apiKey,
            agentDir: params.agentDir,
            workspaceDir,
          });
          result = prepared.result;
          preparedConfig = prepared.config;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          error: `${resolved.provider.label} could not prepare this credential for app-guided setup: ${detail}`,
        };
      }
      const modelRef = result.defaultModel
        ? normalizeAgentModelRefForConfig(result.defaultModel)
        : "";
      if (!modelRef || result.profiles.length === 0) {
        return {
          error: `${resolved.provider.label} does not expose a starter model for app-guided setup.`,
        };
      }
      const ref = parseRef(modelRef);
      if (!ref.model) {
        return {
          error: `${resolved.provider.label} returned an invalid starter model.`,
        };
      }
      const matchingProfile = result.profiles.find(
        (profile) =>
          normalizeProviderId(profile.credential.provider) === normalizeProviderId(ref.provider),
      );
      if (!matchingProfile) {
        return {
          error: `${resolved.provider.label} did not return credentials for its starter model.`,
        };
      }
      const preparedAuth = prepareManualAuthForActivation({
        baseConfig: enableResult.config,
        preparedConfig,
        profiles: result.profiles,
        selectedProfileId: matchingProfile.profileId,
        modelRef,
        providerId: ref.provider,
        ...(resolved.provider.pluginId ? { pluginId: resolved.provider.pluginId } : {}),
      });
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        agentDir: params.agentDir,
        config: preparedAuth.config,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(preparedAuth.config),
        authProfileId: preparedAuth.selectedProfileId,
        persistModelRef: modelRef,
        manualAuth: {
          profiles: preparedAuth.profiles,
          configBase: enableResult.config,
          configPatch: createMergePatch(enableResult.config, preparedAuth.config),
          ...(resolved.provider.pluginId ? { pluginId: resolved.provider.pluginId } : {}),
        },
      };
    }
    default:
      return { error: `Unknown inference choice "${String(kind)}".` };
  }
}

async function runProviderManualSecretMethod(params: {
  config: OpenClawConfig;
  baseConfig: OpenClawConfig;
  choice: ProviderAuthChoiceMetadata;
  method: ProviderAuthMethod;
  apiKey: string;
  agentDir: string;
  workspaceDir: string;
}): Promise<{ result: ProviderAuthResult; config: OpenClawConfig }> {
  const optionKey = params.choice.optionKey;
  const runNonInteractive = params.method.runNonInteractive;
  if (!optionKey || !params.choice.cliOption || !runNonInteractive) {
    throw new Error("Provider does not expose app-guided secret setup.");
  }

  let methodError = "";
  const isolatedRuntime: RuntimeEnv = {
    log: () => {},
    error: (...args) => {
      methodError = args.map(String).join(" ");
    },
    // Provider CLI methods use exit for validation failures. Convert it to a
    // request-local failure so app-guided setup can never stop the Gateway.
    exit: (code) => {
      throw new Error(methodError || `Provider setup exited with code ${code}.`);
    },
  };
  const configured = await runNonInteractive({
    authChoice: params.choice.choiceId,
    config: params.config,
    baseConfig: params.baseConfig,
    opts: { [optionKey]: params.apiKey, secretInputMode: "plaintext" },
    runtime: isolatedRuntime,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    resolveApiKey: async (input) =>
      typeof input.flagValue === "string" && input.flagValue.trim()
        ? { key: input.flagValue.trim(), source: "flag" }
        : null,
    toApiKeyCredential: ({ provider, resolved, email, metadata }) => ({
      type: "api_key",
      provider,
      key: resolved.key,
      ...(email ? { email } : {}),
      ...(metadata ? { metadata } : {}),
    }),
  });
  if (!configured) {
    throw new Error(methodError || "Provider setup did not produce a configuration.");
  }

  const store = loadPersistedAuthProfileStore(params.agentDir);
  const profiles = Object.entries(store?.profiles ?? {}).map(([profileId, credential]) => ({
    profileId,
    credential,
  }));
  const previousModel = resolveAgentModelPrimaryValue(params.config.agents?.defaults?.model);
  const configuredModel = resolveAgentModelPrimaryValue(configured.agents?.defaults?.model);
  const configuredProvider = configuredModel ? parseRef(configuredModel).provider : undefined;
  // Dynamic provider setup can rediscover the already-selected model while
  // repairing credentials. It is valid only when the provider still owns it.
  const configuredModelOwnedByProvider =
    configuredProvider !== undefined &&
    normalizeProviderId(configuredProvider) === normalizeProviderId(params.choice.providerId);
  const defaultModel =
    configuredModel && (configuredModel !== previousModel || configuredModelOwnedByProvider)
      ? configuredModel
      : params.method.starterModel;
  if (profiles.length === 0 || !defaultModel) {
    throw new Error("Provider setup did not produce credentials and a starter model.");
  }
  return {
    result: { profiles, defaultModel },
    config: configured,
  };
}

/**
 * Test one candidate with a real completion, then persist it as the setup
 * default. Manual credentials are tested from a temporary auth store and
 * copied into the real agent store only after success. A managed Codex install
 * record may remain after a failed probe because the installed package already exists.
 */
export async function activateSetupInference(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  try {
    const result = await activateSetupInferenceUnredacted(params);
    if (result.ok) {
      return {
        ...result,
        lines: await Promise.all(
          result.lines.map((line) => redactSetupInferenceError(line, params.apiKey)),
        ),
      };
    }
    return {
      ...result,
      error: await redactSetupInferenceError(result.error, params.apiKey),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = await redactSetupInferenceError(message, params.apiKey);
    if (error instanceof SetupInferenceActivationUnavailableError) {
      return { ok: false, status: "unavailable", error: redacted };
    }
    if (error instanceof SetupInferenceActivationIndeterminateError) {
      throw new SetupInferenceActivationIndeterminateError(redacted);
    }
    // oxlint-disable-next-line preserve-caught-error -- The original cause can contain the submitted setup secret.
    throw new Error(redacted);
  }
}

async function activateSetupInferenceUnredacted(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  const deps = params.deps ?? {};
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(invalidSetupConfigError(snapshot));
  }
  const cfg: OpenClawConfig = snapshot.exists ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const sourceCfg: OpenClawConfig = snapshot.exists
    ? (snapshot.sourceConfig ?? snapshot.config)
    : {};
  const workspace = params.workspace?.trim()
    ? resolveUserPath(params.workspace)
    : (
        await resolveSetupInferenceWorkspace({
          configExists: snapshot.exists,
          configValid: snapshot.valid,
        })
      ).workspace;

  const tempDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  const testAgentDir = path.join(tempDir, "agent");
  let pendingCodexInstall: PluginInstallRecord | undefined;
  let codexInstallOwnership: "unknown" | "owned" | "unowned" = "unknown";
  let codexRegistryNeedsReload = false;
  let codexRegistryReloaded = false;
  try {
    const plan = await buildTestPlan({
      kind: params.kind,
      ...(params.modelRef !== undefined ? { modelRef: params.modelRef } : {}),
      ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
      ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
      cfg,
      workspaceDir: tempDir,
      pluginWorkspaceDir: workspace,
      agentDir: testAgentDir,
      runtime: params.runtime,
      deps,
    });
    if ("error" in plan) {
      return { ok: false, status: "unavailable", error: plan.error };
    }

    let testPlan = plan;
    if (plan.persistModelRef) {
      const agentRuntimeId = resolveSetupAgentRuntimeId(params.kind);
      const stagedConfig = await applyCrestodianModelSelection({
        config: plan.config,
        model: plan.persistModelRef,
        ...(agentRuntimeId ? { agentRuntimeId } : {}),
        ...(plan.manualAuth && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
      });
      testPlan = {
        ...plan,
        config: stagedConfig,
        routeAgentId: resolveDefaultAgentId(stagedConfig),
      };
    }

    let codexPluginPatch: unknown;
    if (params.kind === "codex-cli") {
      const { stripPendingPluginInstallRecords } =
        await import("../plugins/install-record-commit.js");
      // This explicit Codex CLI choice owns its runtime independently of the
      // user's existing OpenAI provider route (which may use a custom base URL).
      const codexInstallBase = stripPendingPluginInstallRecords(testPlan.config);
      const enabledCodexBase = enablePluginInConfig(
        normalizePluginTargetConfig(codexInstallBase, "codex"),
        "codex",
      );
      if (!enabledCodexBase.enabled) {
        return {
          ok: false,
          status: "unavailable",
          error: `Could not enable the Codex runtime plugin: ${enabledCodexBase.reason ?? "plugin disabled"}.`,
        };
      }
      const ensureCodex =
        deps.ensureCodexRuntimePlugin ??
        (await import("../commands/codex-runtime-plugin-install.js"))
          .ensureCodexRuntimePluginForModelSelection;
      const ensured = await ensureCodex({
        cfg: enabledCodexBase.config,
        model: plan.modelRef,
        agentId: testPlan.routeAgentId,
        prompter: createQuickstartNotePrompter(params.runtime),
        runtime: params.runtime,
        workspaceDir: tempDir,
      });
      if (!ensured.installed) {
        return {
          ok: false,
          status: ensured.status === "timed_out" ? "timeout" : "unavailable",
          error:
            ensured.status === "timed_out"
              ? "Codex runtime plugin installation timed out. Try again."
              : ensured.reason
                ? `Could not enable the Codex runtime plugin: ${ensured.reason}.`
                : "Could not install the Codex runtime plugin. Try again once the plugin is available.",
        };
      }
      codexRegistryNeedsReload = true;
      pendingCodexInstall = ensured.cfg.plugins?.installs?.codex;
      if (pendingCodexInstall) {
        // The managed package exists before inference can run. Mark this
        // generation retained now so a process exit cannot strand unowned bytes.
        const codexInstallRetained = await retainUnownedCodexInstall({
          record: pendingCodexInstall,
          verifyOwnership: false,
          deps,
        });
        if (!codexInstallRetained) {
          return {
            ok: false,
            status: "unavailable",
            error:
              "Could not retain the staged Codex runtime safely. No inference route was changed; retry after checking the plugin storage directory.",
          };
        }
      }
      const normalizedCodexConfig = normalizePluginTargetConfig(ensured.cfg, "codex");
      const enabledCodex = enablePluginInConfig(
        configureCodexCliNativeAuth(normalizedCodexConfig),
        "codex",
      );
      if (!enabledCodex.enabled) {
        return {
          ok: false,
          status: "unavailable",
          error: `Could not enable the Codex runtime plugin: ${enabledCodex.reason ?? "plugin disabled"}.`,
        };
      }
      // Discovery needs the just-installed package record during the probe, but
      // install ownership remains transient until inference succeeds.
      const stagedCodexConfig = enabledCodex.config;
      codexPluginPatch = createMergePatch(
        codexInstallBase,
        stripPendingPluginInstallRecords(stagedCodexConfig),
      );
      testPlan = {
        ...testPlan,
        config: stagedCodexConfig,
      };

      // The Gateway registry predates a runtime installed by this request.
      // Refresh and load the exact Codex harness before auth snapshots it.
      const refreshPluginRegistry =
        deps.refreshPluginRegistryAfterConfigMutation ??
        (await import("../plugins/registry-refresh.js")).refreshPluginRegistryAfterConfigMutation;
      let registryRefreshWarning: string | undefined;
      await refreshPluginRegistry({
        config: testPlan.config,
        reason: "source-changed",
        workspaceDir: workspace,
        policyPluginIds: ["codex"],
        traceCommand: "crestodian-setup-probe",
        logger: { warn: (message) => (registryRefreshWarning = message) },
      });
      const ensureHarnessPlugin =
        deps.ensureSelectedAgentHarnessPlugin ??
        (await import("../agents/harness/runtime-plugin.js")).ensureSelectedAgentHarnessPlugin;
      try {
        await ensureHarnessPlugin({
          provider: testPlan.provider,
          modelId: testPlan.model,
          config: testPlan.config,
          agentId: testPlan.routeAgentId,
          agentHarnessRuntimeOverride: "codex",
          workspaceDir: tempDir,
        });
      } catch (error) {
        const loadError = `Could not load the Codex runtime plugin: ${formatErrorMessage(error)}`;
        return {
          ok: false,
          status: "unavailable",
          error: registryRefreshWarning ? `${registryRefreshWarning} ${loadError}` : loadError,
        };
      }
    }
    const baselineRoute = await projectDefaultInferenceRoute(cfg);
    const verifiedRoute = await projectDefaultInferenceRoute(testPlan.config);
    const stagedRoute = verifiedRoute.route;
    const stagedExecutionRoute = await resolveCrestodianConfiguredRouteFromConfig(testPlan.config);
    if (
      !stagedRoute ||
      !stagedExecutionRoute ||
      stagedRoute.runner !== testPlan.runner ||
      stagedRoute.provider !== testPlan.provider ||
      stagedRoute.model !== testPlan.model ||
      stagedRoute.modelLabel !== plan.modelRef ||
      (plan.manualAuth && stagedRoute.authProfileId !== plan.authProfileId)
    ) {
      return {
        ok: false,
        status: "unavailable",
        error:
          "The staged default-agent route does not match the requested inference candidate. Review model runtime policy and retry.",
      };
    }
    const baselineTargetModelMetadata = projectSetupTargetModelMetadata(
      cfg,
      stagedRoute.modelLabel,
    );
    const sourceTargetModelMetadata = projectSetupTargetModelMetadata(
      sourceCfg,
      stagedRoute.modelLabel,
    );
    // Crestodian executes through the reserved agent id but reuses the default
    // route's agent directory. Only a submitted key stays in the isolated store.
    if (testPlan.runner === "embedded" && stagedRoute.runner === "embedded") {
      testPlan = {
        ...testPlan,
        config: stagedExecutionRoute.runConfig,
        agentDir: plan.manualAuth ? testAgentDir : stagedRoute.agentDir,
        agentHarnessRuntimeOverride: stagedRoute.agentHarnessRuntimeOverride,
      };
    } else {
      testPlan = {
        ...testPlan,
        config: stagedExecutionRoute.runConfig,
        ...(!plan.manualAuth ? { agentDir: stagedRoute.agentDir } : {}),
      };
    }

    if (plan.manualAuth) {
      const staged = await persistManualAuthProfiles({
        profiles: plan.manualAuth.profiles,
        agentDir: testAgentDir,
        deps,
      });
      if (staged.status !== "persisted") {
        return {
          ok: false,
          status: "unknown",
          error:
            "Could not stage the credential for its live inference test; try again in a moment.",
        };
      }
    }

    let stagedOwnerPluginArtifacts: CrestodianOwnerPluginArtifactSnapshot;
    try {
      stagedOwnerPluginArtifacts = (
        deps.captureCrestodianOwnerPluginArtifacts ?? captureCrestodianOwnerPluginArtifacts
      )({
        config: stagedExecutionRoute.runConfig,
        executionRoute: stagedExecutionRoute,
        deps,
      });
    } catch {
      return {
        ok: false,
        status: "unavailable",
        error:
          "Could not bind the staged inference plugin runtime. Refresh or reinstall the plugin and retry.",
      };
    }

    const test = await runSetupInferenceTest({
      plan: testPlan,
      tempDir,
      deps,
      // The setup probe is evidence, not an auth-store mutation. Manual keys
      // already exist in the isolated store and every other route stays read-only.
      authProfileStateMode: "read-only",
      requireExecutionOwner: true,
    });
    if (!test.ok) {
      return test;
    }
    if (plan.authProfileId && test.auth.authProfileId !== plan.authProfileId) {
      return {
        ok: false,
        status: "auth",
        error: `The inference run used profile "${test.auth.authProfileId ?? "unknown"}" instead of the configured profile "${plan.authProfileId}". No model or credential route was saved.`,
      };
    }

    const needsPersistence =
      plan.persistModelRef !== undefined ||
      plan.manualAuth !== undefined ||
      codexPluginPatch !== undefined ||
      pendingCodexInstall !== undefined;
    if (
      !test.auth.authFingerprint &&
      (!test.auth.runtimeOwnerFingerprint ||
        !test.auth.runtimeOwnerKind ||
        !test.auth.runtimeOwnerId?.trim())
    ) {
      return {
        ok: false,
        status: "unknown",
        error:
          "Inference succeeded, but its runtime did not report an owner that Crestodian can safely reuse. No model or credential route was saved.",
      };
    }
    if (
      testPlan.runner === "cli" &&
      (!test.auth.runtimeArtifactFingerprint || !test.auth.runtimeArtifactId?.trim())
    ) {
      return {
        ok: false,
        status: "unknown",
        error:
          "Inference succeeded, but its CLI executable/package artifact could not be safely reused. No model or credential route was saved.",
      };
    }
    if (testPlan.runner === "embedded") {
      const successfulHarnessId = test.auth.agentHarnessId?.trim();
      if (
        !successfulHarnessId ||
        (testPlan.agentHarnessRuntimeOverride !== "auto" &&
          successfulHarnessId !== testPlan.agentHarnessRuntimeOverride)
      ) {
        return {
          ok: false,
          status: "unknown",
          error:
            "Inference succeeded, but its exact agent harness could not be safely reused. No model or credential route was saved.",
        };
      }
      if (
        successfulHarnessId !== "openclaw" &&
        (test.auth.runtimeOwnerKind !== "plugin-harness" ||
          test.auth.runtimeOwnerId?.trim() !== successfulHarnessId ||
          !test.auth.runtimeArtifactFingerprint ||
          !test.auth.runtimeArtifactId?.trim())
      ) {
        return {
          ok: false,
          status: "unknown",
          error:
            "Inference succeeded, but its agent harness artifact could not be safely reused. No model or credential route was saved.",
        };
      }
    }
    let committedConfig: OpenClawConfig | undefined;
    if (!needsPersistence) {
      const latestSnapshot = await readSnapshot();
      const latestRuntime =
        latestSnapshot.exists && latestSnapshot.valid
          ? (latestSnapshot.runtimeConfig ?? latestSnapshot.config)
          : undefined;
      const latestRoute = latestRuntime
        ? await projectDefaultInferenceRoute(latestRuntime)
        : undefined;
      if (!latestRoute || !sameDefaultInferenceRoute(latestRoute, verifiedRoute)) {
        return {
          ok: false,
          status: "unknown",
          error:
            "The default-agent inference route changed during its live test. Review the current model/auth/runtime settings and retry.",
        };
      }
      const latestResolvedRoute = latestRuntime
        ? await resolveCrestodianConfiguredRouteFromConfig(latestRuntime)
        : null;
      if (!latestResolvedRoute) {
        return {
          ok: false,
          status: "unknown",
          error:
            "The default-agent inference route could not be resolved after its live test. Review the current model/auth/runtime settings and retry.",
        };
      }
      try {
        const binding = await revalidateSetupInferenceOwner({
          route: latestResolvedRoute,
          auth: test.auth,
          deps,
        });
        if (!hasSameOwnerPluginArtifacts(binding, stagedOwnerPluginArtifacts)) {
          throw new Error("inference owner plugin runtime changed during its live test");
        }
      } catch {
        return {
          ok: false,
          status: "auth",
          error:
            "The verified inference owner changed before activation completed. Retry the inference check.",
        };
      }
    }
    if (needsPersistence) {
      const { stripPendingPluginInstallRecords } =
        await import("../plugins/install-record-commit.js");
      const agentRuntimeId = resolveSetupAgentRuntimeId(params.kind);
      const selectModel = plan.persistModelRef
        ? await createCrestodianModelSelectionUpdater({
            model: plan.persistModelRef,
            ...(agentRuntimeId ? { agentRuntimeId } : {}),
            ...(plan.manualAuth && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
          })
        : undefined;
      const stageCandidate = (current: OpenClawConfig): OpenClawConfig => {
        let next =
          codexPluginPatch === undefined ? current : stripPendingPluginInstallRecords(current);
        if (plan.manualAuth) {
          next = applyManualAuthConfig(
            next,
            plan.manualAuth,
            deps.enablePluginInConfig ?? enablePluginInConfig,
          );
        }
        if (codexPluginPatch !== undefined) {
          const patched = applyMergePatch(next, codexPluginPatch) as OpenClawConfig;
          const enabledCodex = enablePluginInConfig(
            normalizePluginTargetConfig(patched, "codex"),
            "codex",
          );
          if (!enabledCodex.enabled) {
            throw new SetupInferenceActivationUnavailableError(
              `Could not enable the Codex runtime plugin: ${enabledCodex.reason ?? "plugin disabled"}.`,
            );
          }
          next = enabledCodex.config;
        }
        next = selectModel ? selectModel(next) : next;
        if (!pendingCodexInstall) {
          return next;
        }
        return {
          ...next,
          plugins: {
            ...next.plugins,
            installs: { codex: pendingCodexInstall },
          },
        };
      };
      // Pending install records are probe-only discovery input. The config
      // writer moves them into the installed-plugin index before committing,
      // so post-write reconciliation must compare against the stripped route
      // and verify the exact index record separately below.
      const persistedRoute = pendingCodexInstall
        ? await projectDefaultInferenceRoute(stripPendingPluginInstallRecords(stageCandidate(cfg)))
        : verifiedRoute;
      // Runtime config may materialize provider defaults that are intentionally
      // absent from authored config. Compare source writes against the candidate
      // produced from the original source shape, without ignoring concurrent rows.
      const expectedSourceCandidateRoute = await projectDefaultInferenceRoute(
        stageCandidate(sourceCfg),
      );
      // Resolve every fallible config-commit dependency before writing a
      // credential into the real agent store. From this point onward, any
      // failure is inside the rollback boundary below.
      const transformConfig =
        deps.transformConfigWithPendingPluginInstalls ??
        (await import("../plugins/install-record-commit.js"))
          .transformConfigWithPendingPluginInstalls;
      let manualAuthReceipt: ManualAuthPersistenceReceipt | undefined;
      if (plan.manualAuth) {
        const initialCandidate = stageCandidate(cfg);
        const initialRoute = await projectDefaultInferenceRoute(initialCandidate);
        const resolvedRoute = await resolveCrestodianConfiguredRouteFromConfig(initialCandidate);
        if (
          !sameDefaultInferenceRoute(initialRoute, verifiedRoute) ||
          !resolvedRoute ||
          resolvedRoute.modelLabel !== plan.modelRef ||
          resolvedRoute.authProfileId !== plan.authProfileId
        ) {
          throw new Error(
            "The default-agent inference route changed during its live test, so the verified credential was not saved. Review the current model/auth/runtime settings and retry.",
          );
        }
        const persistedManualAuth = await persistManualAuthProfiles({
          profiles: plan.manualAuth.profiles,
          agentDir: resolvedRoute.agentDir,
          deps,
        });
        if (persistedManualAuth.status === "unknown") {
          const rolledBack = await rollbackManualAuthProfiles(persistedManualAuth.receipt, deps);
          if (rolledBack) {
            return {
              ok: false,
              status: "unknown",
              error:
                "Could not confirm the credential write, so it was rolled back. Try again in a moment.",
            };
          }
          throw new SetupInferenceActivationIndeterminateError(
            "Inference activation could not confirm whether its verified credential was saved or rolled back. No config commit was attempted; run openclaw doctor --fix before retrying.",
          );
        }
        if (persistedManualAuth.status === "not-persisted") {
          return {
            ok: false,
            status: "unknown",
            error: "Could not save the verified credential; try again in a moment.",
          };
        }
        manualAuthReceipt = persistedManualAuth.receipt;
      }
      let commitMayHaveStarted = false;
      try {
        const committed = await transformConfig({
          base: "source",
          // The transform stays side-effect free so a config conflict can retry
          // without replaying credential writes in another agent directory.
          afterWrite: { mode: "none", reason: "Crestodian activates verified inference" },
          transform: async (current, context) => {
            const latestRuntime = context.snapshot.runtimeConfig ?? context.snapshot.config;
            // Validate that the candidate is still admissible before reporting
            // broader route drift, so policy revocations retain their actionable error.
            const stagedRuntime = stageCandidate(latestRuntime);
            const latestBaseline = await projectDefaultInferenceRoute(latestRuntime);
            if (!sameDefaultInferenceRoute(latestBaseline, baselineRoute)) {
              throw new Error(
                "The default-agent inference route changed during its live test, so the verified candidate was not saved. Review the current model/auth/runtime settings and retry.",
              );
            }
            if (
              !isDeepStrictEqual(
                projectSetupTargetModelMetadata(latestRuntime, stagedRoute.modelLabel),
                baselineTargetModelMetadata,
              )
            ) {
              throw new Error(
                "The target model metadata changed during its live inference test, so the verified candidate was not saved. Review the current model settings and retry.",
              );
            }
            const currentRoute = await projectDefaultInferenceRoute(stagedRuntime);
            if (!sameDefaultInferenceRoute(currentRoute, verifiedRoute)) {
              throw new Error(
                "The default-agent inference route changed during its live test, so the verified candidate was not saved. Review the current model/auth/runtime settings and retry.",
              );
            }
            const resolvedRoute = await resolveCrestodianConfiguredRouteFromConfig(stagedRuntime);
            if (
              !resolvedRoute ||
              resolvedRoute.modelLabel !== plan.modelRef ||
              (plan.manualAuth && resolvedRoute.authProfileId !== plan.authProfileId)
            ) {
              throw new Error(
                "The latest default-agent route no longer matches the verified candidate, so it was not saved. Review the current config and retry.",
              );
            }
            if (
              !isDeepStrictEqual(
                projectSetupTargetModelMetadata(current, stagedRoute.modelLabel),
                sourceTargetModelMetadata,
              )
            ) {
              throw new Error(
                "The authored target model metadata changed during its live inference test, so the verified candidate was not saved. Review the current model settings and retry.",
              );
            }
            const nextConfig = stageCandidate(current);
            const nextRouteProjection = await projectDefaultInferenceRoute(nextConfig);
            const nextResolvedRoute = await resolveCrestodianConfiguredRouteFromConfig(nextConfig);
            if (
              !sameDefaultInferenceRoute(nextRouteProjection, expectedSourceCandidateRoute) ||
              !nextResolvedRoute ||
              nextResolvedRoute.modelLabel !== plan.modelRef ||
              (plan.manualAuth && nextResolvedRoute.authProfileId !== plan.authProfileId)
            ) {
              throw new Error(
                "The source config no longer matches the verified candidate, so it was not saved. Review the current config and retry.",
              );
            }
            const binding = await revalidateSetupInferenceOwner({
              route: nextResolvedRoute,
              auth: test.auth,
              deps,
            });
            if (!hasSameOwnerPluginArtifacts(binding, stagedOwnerPluginArtifacts)) {
              throw new Error("inference owner plugin runtime changed during its live test");
            }
            // Once this callback returns, the config writer owns the candidate.
            // Any later throw may be post-commit and needs reconciliation.
            commitMayHaveStarted = true;
            return { nextConfig };
          },
        });
        committedConfig = committed.nextConfig;
        if (pendingCodexInstall) {
          codexInstallOwnership = "owned";
        }
      } catch (error) {
        if (!commitMayHaveStarted) {
          if (manualAuthReceipt) {
            const rolledBack = await rollbackManualAuthProfiles(manualAuthReceipt, deps);
            if (!rolledBack) {
              throw new SetupInferenceActivationIndeterminateError(
                "Inference activation stopped before its config commit, but could not confirm removal of its staged credential. Run openclaw doctor --fix before retrying.",
              );
            }
          }
          throw error;
        }
        const reconciledSnapshot = await readSnapshot().catch(() => null);
        const reconciledRuntime =
          reconciledSnapshot?.exists && reconciledSnapshot.valid
            ? (reconciledSnapshot.runtimeConfig ?? reconciledSnapshot.config)
            : undefined;
        const reconciledRoute = reconciledRuntime
          ? await projectDefaultInferenceRoute(reconciledRuntime)
          : undefined;
        const codexInstallPersisted = pendingCodexInstall
          ? await isCodexInstallRecordPersisted(pendingCodexInstall, deps)
          : true;
        const committedDespiteError =
          reconciledRoute !== undefined &&
          sameDefaultInferenceRoute(reconciledRoute, persistedRoute) &&
          (!manualAuthReceipt || manualAuthProfilesPersisted(manualAuthReceipt, deps)) &&
          codexInstallPersisted;
        if (pendingCodexInstall) {
          codexInstallOwnership = committedDespiteError ? "owned" : "unowned";
        }
        if (!committedDespiteError) {
          if (manualAuthReceipt) {
            if (
              !reconciledRuntime ||
              configReferencesManualAuthProfiles(reconciledRuntime, manualAuthReceipt)
            ) {
              throw new SetupInferenceActivationIndeterminateError(
                "Inference activation could not confirm its config commit state. The verified credential was retained because the current config may reference it. Run openclaw doctor --fix before retrying.",
              );
            }
            const rolledBack = await rollbackManualAuthProfiles(manualAuthReceipt, deps);
            if (!rolledBack) {
              throw new SetupInferenceActivationIndeterminateError(
                "Inference activation failed and its staged credential could not be rolled back. Run openclaw doctor --fix before retrying.",
              );
            }
          }
          throw error;
        }
        committedConfig = reconciledSnapshot?.sourceConfig ?? reconciledRuntime;
        log.warn("Inference activation committed successfully despite a post-write cleanup error.");
      }
    }
    if (codexRegistryNeedsReload && committedConfig) {
      codexRegistryReloaded = await reloadCodexRegistryAfterActivation({
        readSnapshot,
        workspaceDir: workspace,
        deps,
      });
      if (!codexRegistryReloaded) {
        throw new SetupInferenceActivationIndeterminateError(
          "Inference activation committed, but the active plugin registry could not be reloaded. Restart the Gateway before using Codex inference.",
        );
      }
    }
    let lines = [`Inference verified: ${plan.modelRef}`];
    if (params.surface === "gateway" && params.recordSetupAudit !== false) {
      const after = await readSnapshot().catch(() => null);
      try {
        await appendCrestodianAuditEntry({
          operation: "crestodian.setup",
          summary: "Verified and configured AI access through Crestodian setup",
          configPath: after?.path ?? snapshot.path,
          configHashBefore: snapshot.hash ?? null,
          configHashAfter: after?.hash ?? null,
          details: { modelRef: plan.modelRef, inferenceKind: params.kind },
        });
      } catch (error) {
        // Inference is already verified and its route may already be durable.
        // Surface audit failure as a warning instead of misreporting setup failure.
        const warning = `Inference setup completed, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`;
        params.runtime.error?.(warning);
        lines = [...lines, warning];
      }
    }
    return {
      ok: true,
      modelRef: plan.modelRef,
      latencyMs: test.latencyMs,
      lines,
    };
  } finally {
    let codexCleanupError: SetupInferenceActivationIndeterminateError | undefined;
    if (pendingCodexInstall && codexInstallOwnership !== "owned") {
      // Reassert after probing: a partial install-index commit may have cleared
      // the early marker even though the matching model route never committed.
      const retained = await retainUnownedCodexInstall({
        record: pendingCodexInstall,
        verifyOwnership: false,
        deps,
      });
      if (!retained) {
        codexCleanupError = new SetupInferenceActivationIndeterminateError(
          "Inference activation stopped before its Codex runtime package could be retained safely. Restart the Gateway before retrying.",
        );
      }
    }
    if (codexRegistryNeedsReload && !codexRegistryReloaded) {
      // The probe loaded discovery against staged config. Restore the live
      // registry from the latest persisted config before another request runs.
      codexRegistryReloaded = await reloadCodexRegistryAfterActivation({
        readSnapshot,
        workspaceDir: workspace,
        deps,
      });
      if (!codexRegistryReloaded) {
        codexCleanupError = new SetupInferenceActivationIndeterminateError(
          "Inference activation could not restore the active plugin registry after its Codex probe. Restart the Gateway before retrying.",
        );
      }
    }
    await cleanupSetupInferenceTempDir({ tempDir, deps, runtime: params.runtime });
    if (codexCleanupError) {
      // oxlint-disable-next-line no-unsafe-finally -- an indeterminate plugin cleanup must supersede a stale success result
      throw codexCleanupError;
    }
  }
}

async function redactSetupInferenceError(message: string, apiKey?: string): Promise<string> {
  const secrets = new Set(
    [apiKey, apiKey?.trim()].filter((value): value is string => Boolean(value)),
  );
  let redacted = message;
  for (const secret of Array.from(secrets).toSorted((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  const { redactToolPayloadText } = await import("../logging/redact.js");
  return redactToolPayloadText(redacted);
}

async function revalidateSetupInferenceOwner(params: {
  route: NonNullable<Awaited<ReturnType<typeof resolveCrestodianConfiguredRouteFromConfig>>>;
  auth: AgentExecutionAuthBinding;
  deps: ActivateSetupInferenceDeps;
}): Promise<CrestodianVerifiedInferenceBinding> {
  const createBinding =
    params.deps.createCrestodianVerifiedInferenceBinding ??
    createCrestodianVerifiedInferenceBinding;
  return await createBinding({
    configuredRoute: params.route,
    executionRoute: params.route,
    auth: params.auth,
    deps: params.deps,
  });
}

function hasSameOwnerPluginArtifacts(
  binding: CrestodianVerifiedInferenceBinding,
  snapshot: CrestodianOwnerPluginArtifactSnapshot,
): boolean {
  return (
    isDeepStrictEqual(binding.ownerPluginIds, snapshot.ownerPluginIds) &&
    isDeepStrictEqual(binding.ownerPluginArtifacts, snapshot.ownerPluginArtifacts)
  );
}

type VerifySetupInferenceParams = {
  kind?: "existing-model";
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: ActivateSetupInferenceDeps;
};

/** Live-test the configured default model without changing config or auth state. */
export function verifySetupInference(
  params: VerifySetupInferenceParams & { bindSession: true },
): Promise<BoundVerifySetupInferenceResult>;
export function verifySetupInference(
  params: VerifySetupInferenceParams & { bindSession?: false },
): Promise<VerifySetupInferenceResult>;
export async function verifySetupInference(
  params: VerifySetupInferenceParams & { bindSession?: boolean },
): Promise<VerifySetupInferenceResult | BoundVerifySetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (!snapshot.exists) {
    return {
      ok: false,
      status: "unavailable",
      error: "No OpenClaw config exists. Run `openclaw onboard` first.",
    };
  }
  if (!snapshot.valid) {
    return {
      ok: false,
      status: "format",
      error: invalidSetupConfigError(snapshot),
    };
  }
  const cfg: OpenClawConfig = snapshot.runtimeConfig ?? snapshot.config;
  const baselineRoute = await projectDefaultInferenceRoute(cfg);
  let verifiedBinding: CrestodianVerifiedInferenceBinding | undefined;
  const verification = await verifySetupInferenceConfig({
    config: cfg,
    runtime: params.runtime,
    requireExecutionOwner: params.bindSession === true,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.deps ? { deps: params.deps } : {}),
    ...(params.bindSession
      ? {
          onVerifiedExecution: (
            _auth: AgentExecutionAuthBinding,
            binding: CrestodianVerifiedInferenceBinding,
          ) => {
            verifiedBinding = binding;
          },
        }
      : {}),
  });
  if (!verification.ok) {
    return verification;
  }
  const latestSnapshot = await readSnapshot().catch(() => null);
  const latestConfig =
    latestSnapshot?.exists && latestSnapshot.valid
      ? (latestSnapshot.runtimeConfig ?? latestSnapshot.config)
      : undefined;
  const latestRoute = latestConfig ? await projectDefaultInferenceRoute(latestConfig) : undefined;
  if (!latestRoute || !sameDefaultInferenceRoute(baselineRoute, latestRoute)) {
    return {
      ok: false,
      status: "unknown",
      error:
        "The default-agent inference route changed during its live test. Review the current model/auth/runtime settings and retry.",
    };
  }
  if (!params.bindSession) {
    return verification;
  }
  const configuredRoute = await resolveCrestodianConfiguredRouteFromConfig(cfg);
  if (!configuredRoute || !verifiedBinding) {
    return {
      ok: false,
      status: "unknown",
      error:
        "The successful inference run did not report an exact execution binding. Retry setup before starting Crestodian.",
    };
  }
  return { ...verification, binding: verifiedBinding };
}

type BoundSetupInferenceVerifier = (params: {
  runtime: RuntimeEnv;
  bindSession: true;
  deps?: ActivateSetupInferenceDeps;
}) => Promise<BoundVerifySetupInferenceResult>;

export type ResolveCrestodianInferenceForPersistentApplyDeps = CrestodianVerifiedInferenceDeps & {
  resolveVerifiedInferenceRoute?: typeof resolveCrestodianVerifiedInferenceRoute;
  hasCurrentOwnerPluginArtifacts?: typeof hasCurrentCrestodianOwnerPluginArtifacts;
  verifyBoundInference?: BoundSetupInferenceVerifier;
};

function executionRouteIdentity(route: CrestodianConfiguredRoute): unknown {
  const { runConfig: _runConfig, ...identity } = route;
  return identity;
}

/**
 * Strict credentials need only the static owner check. Opaque runtimes can
 * prove liveness only by completing another exact turn at the side-effect
 * boundary; the result must still be the original frozen route.
 */
export async function resolveCrestodianInferenceForPersistentApply(params: {
  binding: CrestodianVerifiedInferenceBinding;
  runtime: RuntimeEnv;
  deps?: ResolveCrestodianInferenceForPersistentApplyDeps;
}): Promise<CrestodianConfiguredRoute | null> {
  const deps = params.deps ?? {};
  const resolveVerified =
    deps.resolveVerifiedInferenceRoute ?? resolveCrestodianVerifiedInferenceRoute;
  const initialRoute = await resolveVerified(params.binding, deps);
  if (!initialRoute) {
    return null;
  }
  const hasCurrentOwnerPluginArtifacts =
    deps.hasCurrentOwnerPluginArtifacts ?? hasCurrentCrestodianOwnerPluginArtifacts;
  if (!(await hasCurrentOwnerPluginArtifacts(params.binding, deps))) {
    return null;
  }
  if (params.binding.auth.proofKind !== "runtime-owner") {
    return initialRoute;
  }

  const verifyBound = deps.verifyBoundInference ?? verifySetupInference;
  const live = await verifyBound({
    runtime: params.runtime,
    bindSession: true,
    deps,
  });
  if (
    !live.ok ||
    !isDeepStrictEqual(live.binding.configuredRoute, params.binding.configuredRoute) ||
    !isDeepStrictEqual(
      executionRouteIdentity(live.binding.execution),
      executionRouteIdentity(params.binding.execution),
    ) ||
    !isDeepStrictEqual(live.binding.executionFingerprint, params.binding.executionFingerprint) ||
    !isDeepStrictEqual(live.binding.ownerPluginIds, params.binding.ownerPluginIds) ||
    !isDeepStrictEqual(live.binding.ownerPluginArtifacts, params.binding.ownerPluginArtifacts) ||
    !isDeepStrictEqual(live.binding.auth, params.binding.auth)
  ) {
    return null;
  }
  // The live probe is not a lock. Recheck the authored route after it returns,
  // then keep using the original frozen execution snapshot.
  const finalRoute = await resolveVerified(params.binding, deps);
  if (!finalRoute || !(await hasCurrentOwnerPluginArtifacts(params.binding, deps))) {
    return null;
  }
  return finalRoute;
}

/** Live-test a staged default-agent route before any caller persists it. */
export async function verifySetupInferenceConfig(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: ActivateSetupInferenceDeps;
  /** Internal session gate: capture only the final exact successful credential. */
  onVerifiedExecution?: (
    auth: AgentExecutionAuthBinding,
    binding: CrestodianVerifiedInferenceBinding,
  ) => void;
  /** Reject a successful turn unless its runner reports the exact execution owner. */
  requireExecutionOwner?: boolean;
}): Promise<VerifySetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const cfg = params.config;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (!resolveAgentEffectiveModelPrimary(cfg, defaultAgentId)) {
    return {
      ok: false,
      status: "unavailable",
      error: "No default-agent model is configured. Run `openclaw onboard` first.",
    };
  }
  const tempDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  try {
    const plan = await buildTestPlan({
      kind: "existing-model",
      cfg,
      workspaceDir: tempDir,
      pluginWorkspaceDir: tempDir,
      agentDir: path.join(tempDir, "agent"),
      runtime: params.runtime,
      deps,
    });
    if ("error" in plan) {
      return { ok: false, status: "unavailable", error: plan.error };
    }
    const requiresExecutionOwner =
      params.requireExecutionOwner === true || params.onVerifiedExecution !== undefined;
    let configuredRoute:
      | NonNullable<Awaited<ReturnType<typeof resolveCrestodianConfiguredRouteFromConfig>>>
      | undefined;
    let stagedOwnerPluginArtifacts: CrestodianOwnerPluginArtifactSnapshot | undefined;
    if (requiresExecutionOwner) {
      configuredRoute = (await resolveCrestodianConfiguredRouteFromConfig(cfg)) ?? undefined;
      if (!configuredRoute) {
        return {
          ok: false,
          status: "unknown",
          error: "The verified inference route could not be resolved for owner validation.",
        };
      }
      try {
        stagedOwnerPluginArtifacts = (
          deps.captureCrestodianOwnerPluginArtifacts ?? captureCrestodianOwnerPluginArtifacts
        )({
          config: cfg,
          executionRoute: configuredRoute,
          deps,
        });
      } catch {
        return {
          ok: false,
          status: "unavailable",
          error:
            "Could not bind the configured inference plugin runtime. Refresh or reinstall the plugin and retry.",
        };
      }
    }
    let test = await runSetupInferenceTest({
      plan,
      tempDir,
      deps,
      authProfileStateMode: "read-only",
      requireExecutionOwner: requiresExecutionOwner,
    });
    if (test.ok) {
      const verifiedProfileId = test.auth.authProfileId;
      if (plan.authProfileId && verifiedProfileId !== plan.authProfileId) {
        return {
          ok: false,
          status: "auth",
          error: `The inference run used profile "${verifiedProfileId ?? "unknown"}" instead of the configured profile "${plan.authProfileId}".`,
        };
      }
      if (params.onVerifiedExecution && !plan.authProfileId && verifiedProfileId) {
        // Auto-selection may rotate through several profiles before succeeding.
        // Re-run once with the winner locked so the session proof cannot bind a
        // credential that never completed an exact, non-rotating turn.
        test = await runSetupInferenceTest({
          plan: { ...plan, authProfileId: verifiedProfileId },
          tempDir,
          deps,
          authProfileStateMode: "read-only",
          requireExecutionOwner: true,
        });
        if (!test.ok) {
          return {
            ...test,
            error: await redactSetupInferenceError(test.error),
          };
        }
        if (test.auth.authProfileId !== verifiedProfileId) {
          return {
            ok: false,
            status: "auth",
            error: "The selected inference credential changed during its locked verification.",
          };
        }
      }
      if (params.requireExecutionOwner || params.onVerifiedExecution) {
        try {
          const binding = await revalidateSetupInferenceOwner({
            route: configuredRoute!,
            auth: test.auth,
            deps,
          });
          if (
            !stagedOwnerPluginArtifacts ||
            !hasSameOwnerPluginArtifacts(binding, stagedOwnerPluginArtifacts)
          ) {
            throw new Error("inference owner plugin runtime changed during its live test");
          }
          params.onVerifiedExecution?.(test.auth, binding);
        } catch {
          return {
            ok: false,
            status: "auth",
            error:
              "The verified inference owner changed before validation completed. Retry the inference check.",
          };
        }
      }
      return { ok: true, latencyMs: test.latencyMs, modelRef: plan.modelRef };
    }
    return {
      ...test,
      error: await redactSetupInferenceError(test.error),
    };
  } finally {
    await cleanupSetupInferenceTempDir({ tempDir, deps, runtime: params.runtime });
  }
}

async function cleanupSetupInferenceTempDir(params: {
  tempDir: string;
  deps: ActivateSetupInferenceDeps;
  runtime?: RuntimeEnv;
}): Promise<void> {
  try {
    const disposeDatabase =
      params.deps.disposeOpenClawAgentDatabaseByPath ??
      (await import("../state/openclaw-agent-db.js")).disposeOpenClawAgentDatabaseByPath;
    disposeDatabase(path.join(params.tempDir, "agent", "openclaw-agent.sqlite"));
  } catch {
    // Windows cannot remove an open SQLite file. Keep cleanup nonfatal, but
    // always try the directory removal so callers do not retain probe secrets.
    log.warn("Could not dispose the temporary inference auth database.");
  }
  try {
    await (
      params.deps.removeTempDir ?? ((dir: string) => fs.rm(dir, { recursive: true, force: true }))
    )(params.tempDir);
  } catch (error) {
    // Cleanup happens after the inference result or durable activation. It must
    // never turn a verified/committed route into a failed client RPC.
    params.runtime?.error?.(
      `Could not remove temporary AI setup files: ${formatErrorMessage(error)}`,
    );
    log.warn("Could not remove the temporary inference test directory.");
  }
}

async function isCodexInstallRecordPersisted(
  record: PluginInstallRecord,
  deps: ActivateSetupInferenceDeps,
): Promise<boolean> {
  try {
    const readInstallRecords =
      deps.readPersistedInstalledPluginIndexInstallRecords ??
      (await import("../plugins/installed-plugin-index-records.js"))
        .readPersistedInstalledPluginIndexInstallRecords;
    const currentInstallRecords = await readInstallRecords();
    return currentInstallRecords !== null && isDeepStrictEqual(currentInstallRecords.codex, record);
  } catch {
    return false;
  }
}

async function retainUnownedCodexInstall(params: {
  record: PluginInstallRecord;
  verifyOwnership: boolean;
  deps: ActivateSetupInferenceDeps;
}): Promise<boolean> {
  if (params.verifyOwnership && (await isCodexInstallRecordPersisted(params.record, params.deps))) {
    return true;
  }
  if (params.record.source !== "npm" || !params.record.installPath?.trim()) {
    return true;
  }
  try {
    // Never delete an unowned generation: recovery/startup cleanup skips the
    // marker, a successful install commit clears it, and later install/GC may
    // safely reuse or remove the bytes.
    const markRetained =
      params.deps.markRetainedManagedNpmInstall ??
      (await import("../plugins/managed-npm-retention.js")).markRetainedManagedNpmInstall;
    const marked = await markRetained({
      packageDir: params.record.installPath,
      pluginId: "codex",
      reason: "crestodian-inference-activation-not-committed",
    });
    if (!marked) {
      log.warn("Could not retain the uncommitted Codex runtime package generation.");
    }
    return marked;
  } catch {
    // Retention is best effort and marker-after-adoption is non-destructive.
    // A later install or GC may still reuse or remove the unowned generation.
    log.warn("Could not retain the uncommitted Codex runtime package generation.");
    return false;
  } finally {
    await clearUnownedCodexInstallCaches(params.deps);
  }
}

async function clearUnownedCodexInstallCaches(deps: ActivateSetupInferenceDeps): Promise<void> {
  try {
    const clearInstallRecords =
      deps.clearLoadInstalledPluginIndexInstallRecordsCache ??
      (await import("../plugins/installed-plugin-index-records.js"))
        .clearLoadInstalledPluginIndexInstallRecordsCache;
    clearInstallRecords();
  } catch {
    log.warn("Could not clear the plugin install-record cache after failed Codex activation.");
  }
  try {
    const clearPluginMetadata =
      deps.clearPluginMetadataLifecycleCaches ??
      (await import("../plugins/plugin-metadata-lifecycle.js")).clearPluginMetadataLifecycleCaches;
    clearPluginMetadata();
  } catch {
    log.warn("Could not clear plugin metadata caches after failed Codex activation.");
  }
  try {
    const invalidateRuntimeDiscovery =
      deps.invalidatePluginRuntimeDiscoveryAfterConfigMutation ??
      (await import("../plugins/registry-refresh.js"))
        .invalidatePluginRuntimeDiscoveryAfterConfigMutation;
    await invalidateRuntimeDiscovery({ logger: log });
  } catch {
    log.warn("Could not clear plugin runtime discovery after failed Codex activation.");
  }
}

async function reloadCodexRegistryAfterActivation(params: {
  readSnapshot: () => Promise<
    Awaited<ReturnType<typeof import("../config/config.js").readConfigFileSnapshot>>
  >;
  workspaceDir: string;
  deps: ActivateSetupInferenceDeps;
}): Promise<boolean> {
  let snapshot: Awaited<ReturnType<typeof import("../config/config.js").readConfigFileSnapshot>>;
  try {
    snapshot = await params.readSnapshot();
  } catch {
    log.warn("Could not read config while reloading the plugin registry after Codex activation.");
    return false;
  }
  const runtimeConfig =
    snapshot.exists && snapshot.valid
      ? (snapshot.runtimeConfig ?? snapshot.config)
      : ({} satisfies OpenClawConfig);
  const sourceConfig =
    snapshot.exists && snapshot.valid
      ? (snapshot.sourceConfig ?? snapshot.config)
      : ({} satisfies OpenClawConfig);
  try {
    const refreshPluginRegistry =
      params.deps.refreshPluginRegistryAfterConfigMutation ??
      (await import("../plugins/registry-refresh.js")).refreshPluginRegistryAfterConfigMutation;
    await refreshPluginRegistry({
      config: sourceConfig,
      reason: "source-changed",
      workspaceDir: params.workspaceDir,
      logger: log,
    });
  } catch {
    log.warn("Could not refresh persisted plugin registry metadata after Codex activation.");
  }
  try {
    const ensurePluginRegistryLoaded =
      params.deps.ensurePluginRegistryLoaded ??
      (await import("../plugins/runtime/runtime-registry-loader.js")).ensurePluginRegistryLoaded;
    ensurePluginRegistryLoaded({
      scope: "all",
      config: runtimeConfig,
      activationSourceConfig: sourceConfig,
      workspaceDir: params.workspaceDir,
    });
    return true;
  } catch {
    log.warn("Could not reload the active plugin registry after Codex inference activation.");
    return false;
  }
}

function isMergePatchObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergePatchConflicts(base: unknown, current: unknown, patch: unknown): boolean {
  if (!isMergePatchObject(patch)) {
    return !isDeepStrictEqual(base, current);
  }
  const baseIsObject = isMergePatchObject(base);
  const currentIsObject = isMergePatchObject(current);
  if (baseIsObject !== currentIsObject) {
    return true;
  }
  if (!baseIsObject && !currentIsObject && !isDeepStrictEqual(base, current)) {
    return true;
  }
  const baseRecord = baseIsObject ? base : {};
  const currentRecord = currentIsObject ? current : {};
  return Object.entries(patch).some(([key, childPatch]) =>
    mergePatchConflicts(baseRecord[key], currentRecord[key], childPatch),
  );
}

function applyManualAuthConfig(
  config: OpenClawConfig,
  manualAuth: NonNullable<SetupInferenceTestPlan["manualAuth"]>,
  enablePlugin: typeof enablePluginInConfig = enablePluginInConfig,
): OpenClawConfig {
  let enabledConfig = config;
  if (manualAuth.pluginId) {
    const enableResult = enablePlugin(config, manualAuth.pluginId);
    if (!enableResult.enabled) {
      throw new Error(`Provider plugin ${manualAuth.pluginId} is ${enableResult.reason}.`);
    }
    enabledConfig = enableResult.config;
  }
  if (mergePatchConflicts(manualAuth.configBase, enabledConfig, manualAuth.configPatch)) {
    throw new Error(
      "Provider configuration changed during the live inference test, so the verified credential was not saved. Review the current provider settings and retry.",
    );
  }
  return applyMergePatch(enabledConfig, manualAuth.configPatch) as OpenClawConfig;
}

type ManualAuthPersistenceReceipt = {
  agentDir: string;
  profiles: Array<{
    profileId: string;
    credential: ReturnType<typeof normalizeAuthProfileCredential>;
  }>;
  /** Profiles created by this activation; rollback must not delete prior identical entries. */
  insertedProfileIds: ReadonlySet<string>;
};

type ManualAuthProfilesReadback = "present" | "absent" | "mismatch" | "unknown";

type ManualAuthPersistenceResult =
  | { status: "persisted"; receipt: ManualAuthPersistenceReceipt }
  | { status: "not-persisted" }
  | { status: "unknown"; receipt: ManualAuthPersistenceReceipt };

function modelSelectionReferencesProfile(value: unknown, profileIds: ReadonlySet<string>): boolean {
  if (typeof value === "string") {
    const profile = splitTrailingAuthProfile(value).profile;
    return profile !== undefined && profileIds.has(profile);
  }
  if (!isMergePatchObject(value)) {
    return false;
  }
  if (modelSelectionReferencesProfile(value.primary, profileIds)) {
    return true;
  }
  return (
    Array.isArray(value.fallbacks) &&
    value.fallbacks.some((fallback) => modelSelectionReferencesProfile(fallback, profileIds))
  );
}

function configReferencesManualAuthProfiles(
  config: OpenClawConfig,
  receipt: ManualAuthPersistenceReceipt,
): boolean {
  const profileIds = new Set(receipt.profiles.map((profile) => profile.profileId));
  if (Object.keys(config.auth?.profiles ?? {}).some((profileId) => profileIds.has(profileId))) {
    return true;
  }
  if (
    Object.values(config.auth?.order ?? {}).some((order) =>
      order.some((profileId) => profileIds.has(profileId)),
    )
  ) {
    return true;
  }
  if (modelSelectionReferencesProfile(config.agents?.defaults?.model, profileIds)) {
    return true;
  }
  return (config.agents?.list ?? []).some((agent) =>
    modelSelectionReferencesProfile(agent.model, profileIds),
  );
}

function readManualAuthProfiles(
  receipt: ManualAuthPersistenceReceipt,
  deps: ActivateSetupInferenceDeps,
): ManualAuthProfilesReadback {
  let store: ReturnType<typeof loadPersistedAuthProfileStore>;
  try {
    store = (deps.loadPersistedAuthProfileStore ?? loadPersistedAuthProfileStore)(receipt.agentDir);
  } catch {
    return "unknown";
  }
  if (!store) {
    return "unknown";
  }
  if (
    receipt.profiles.every((profile) =>
      isDeepStrictEqual(store.profiles[profile.profileId], profile.credential),
    )
  ) {
    return "present";
  }
  if (receipt.profiles.every((profile) => store.profiles[profile.profileId] === undefined)) {
    return "absent";
  }
  return "mismatch";
}

function manualAuthProfilesPersisted(
  receipt: ManualAuthPersistenceReceipt,
  deps: ActivateSetupInferenceDeps,
): boolean {
  return readManualAuthProfiles(receipt, deps) === "present";
}

async function persistManualAuthProfiles(params: {
  profiles: ProviderAuthResult["profiles"];
  agentDir: string;
  deps: ActivateSetupInferenceDeps;
}): Promise<ManualAuthPersistenceResult> {
  const profiles = params.profiles.map((profile) => ({
    profileId: profile.profileId,
    credential: normalizeAuthProfileCredential(profile.credential),
  }));
  const insertedProfileIds = new Set<string>();
  const receipt = { agentDir: params.agentDir, profiles, insertedProfileIds };
  let collision = false;
  const update = params.deps.updateAuthProfileStoreWithLock ?? updateAuthProfileStoreWithLock;
  const updated = await update({
    agentDir: params.agentDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater: (store) => {
      let changed = false;
      for (const profile of profiles) {
        const existing = store.profiles[profile.profileId];
        if (existing && !isDeepStrictEqual(existing, profile.credential)) {
          collision = true;
          return false;
        }
        if (!existing) {
          store.profiles[profile.profileId] = profile.credential;
          insertedProfileIds.add(profile.profileId);
          changed = true;
        }
      }
      return changed;
    },
  });
  if (collision) {
    return { status: "not-persisted" };
  }
  // The store helper can report a post-commit chmod failure as null. Read back
  // the exact unique profiles before deciding whether the transaction failed.
  const readback = readManualAuthProfiles(receipt, params.deps);
  if (updated !== null || readback === "present") {
    return { status: "persisted", receipt };
  }
  return readback === "absent" ? { status: "not-persisted" } : { status: "unknown", receipt };
}

async function rollbackManualAuthProfiles(
  receipt: ManualAuthPersistenceReceipt,
  deps: ActivateSetupInferenceDeps,
): Promise<boolean> {
  if (receipt.insertedProfileIds.size === 0) {
    return true;
  }
  const update = deps.updateAuthProfileStoreWithLock ?? updateAuthProfileStoreWithLock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let updated: Awaited<ReturnType<typeof update>> = null;
    try {
      updated = await update({
        agentDir: receipt.agentDir,
        saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
        updater: (store) => {
          let changed = false;
          for (const profile of receipt.profiles) {
            if (!receipt.insertedProfileIds.has(profile.profileId)) {
              continue;
            }
            if (isDeepStrictEqual(store.profiles[profile.profileId], profile.credential)) {
              delete store.profiles[profile.profileId];
              changed = true;
            }
          }
          return changed;
        },
      });
    } catch {
      // A thrown write may still have committed. Only readback or a later
      // locked attempt may prove removal; otherwise the caller reports the
      // activation as indeterminate.
    }
    if (
      updated &&
      receipt.profiles.every(
        (profile) =>
          !receipt.insertedProfileIds.has(profile.profileId) ||
          updated.profiles[profile.profileId] === undefined,
      )
    ) {
      return true;
    }
    let persistedStore: ReturnType<typeof loadPersistedAuthProfileStore>;
    try {
      persistedStore = (deps.loadPersistedAuthProfileStore ?? loadPersistedAuthProfileStore)(
        receipt.agentDir,
      );
    } catch {
      persistedStore = null;
    }
    if (
      persistedStore &&
      receipt.profiles.every(
        (profile) =>
          !receipt.insertedProfileIds.has(profile.profileId) ||
          persistedStore.profiles[profile.profileId] === undefined,
      )
    ) {
      return true;
    }
  }
  return false;
}

async function runSetupInferenceTest(params: {
  plan: SetupInferenceTestPlan;
  tempDir: string;
  deps: ActivateSetupInferenceDeps;
  authProfileStateMode: "read-write" | "read-only";
  requireExecutionOwner: boolean;
}): Promise<
  | { ok: true; latencyMs: number; auth: AgentExecutionAuthBinding }
  | {
      ok: false;
      status: SetupInferenceFailureStatus;
      error: string;
    }
> {
  const { plan, tempDir, deps, authProfileStateMode, requireExecutionOwner } = params;
  // Keep these probe prefixes aligned with logging/subsystem.ts and process/command-queue.ts
  // so expected setup failures stay off the interactive TTY.
  const runId = `probe-setup-inference-${randomUUID()}`;
  const sessionId = `${runId}-session`;
  const sessionFile = path.join(tempDir, "session.jsonl");
  const timeoutMs = deps.timeoutMs ?? SETUP_INFERENCE_TEST_TIMEOUT_MS;
  const started = Date.now();
  let successfulAuth: AgentExecutionAuthBinding | undefined;
  try {
    if (plan.runner === "cli") {
      const unsupportedError = resolveToolFreeCliSetupError(plan);
      if (unsupportedError) {
        return { ok: false, status: "unavailable", error: unsupportedError };
      }
    }
    const strictProfileError = resolveStrictSetupAuthProfileError({
      plan,
      workspaceDir: tempDir,
      deps,
    });
    if (strictProfileError) {
      return { ok: false, status: "auth", error: strictProfileError };
    }

    let result: RunResult;
    if (plan.runner === "cli") {
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      result = (await runCli({
        sessionId,
        sessionKey: `temp:setup-inference:${runId}`,
        agentId: plan.agentId ?? "crestodian",
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        config: plan.config,
        prompt: SETUP_INFERENCE_TEST_PROMPT,
        provider: plan.provider,
        model: plan.model,
        ...(plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
        timeoutMs,
        runId,
        messageChannel: "crestodian",
        messageProvider: "crestodian",
        executionMode: "side-question",
        disableTools: true,
        cleanupCliLiveSessionOnRunEnd: true,
        onSuccessfulAuthBinding: (binding) => {
          successfulAuth = binding;
        },
      })) as RunResult;
    } else {
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      result = (await runEmbedded({
        sessionId,
        sessionKey: `temp:setup-inference:${runId}`,
        agentId: plan.agentId ?? "crestodian",
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        config: plan.config,
        prompt: SETUP_INFERENCE_TEST_PROMPT,
        provider: plan.provider,
        model: plan.model,
        ...(plan.authProfileId
          ? { authProfileId: plan.authProfileId, authProfileIdSource: "user" as const }
          : {}),
        authProfileStateMode,
        ...(plan.cleanupBundleMcpOnRunEnd ? { cleanupBundleMcpOnRunEnd: true } : {}),
        ...(plan.agentHarnessRuntimeOverride
          ? { agentHarnessRuntimeOverride: plan.agentHarnessRuntimeOverride }
          : {}),
        timeoutMs,
        runId,
        lane: `session:probe-setup-inference:${plan.provider}`,
        thinkLevel: "off",
        reasoningLevel: "off",
        verboseLevel: "off",
        streamParams: { maxTokens: SETUP_INFERENCE_TEST_MAX_TOKENS },
        disableTools: true,
        modelRun: true,
        messageChannel: "crestodian",
        messageProvider: "crestodian",
        onSuccessfulAuthBinding: (binding) => {
          successfulAuth = binding;
        },
      })) as RunResult;
    }
    const terminalError = extractRunTerminalError(result);
    if (terminalError) {
      const described = describeFailoverError(new Error(terminalError));
      return {
        ok: false,
        status: mapFailoverReasonToSetupStatus(described.reason),
        error: described.message,
      };
    }
    const text = extractRunText(result)?.trim();
    if (!text) {
      return {
        ok: false,
        status: "format",
        error: "The model started but did not send a reply. Try again or pick another option.",
      };
    }
    const winnerError = extractRunWinnerError(plan, result);
    if (winnerError) {
      return { ok: false, status: "format", error: winnerError };
    }
    if (requireExecutionOwner && !successfulAuth) {
      return {
        ok: false,
        status: "unknown",
        error:
          "Inference succeeded, but its runtime did not report an owner that Crestodian can safely reuse.",
      };
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      auth:
        successfulAuth ??
        (!requireExecutionOwner && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
    };
  } catch (error) {
    const described = describeFailoverError(error);
    return {
      ok: false,
      status: mapFailoverReasonToSetupStatus(described.reason),
      error: described.message,
    };
  }
}
