// First-run inference activation: detect candidates, live-test, persist only on success.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeAuthProfileCredential } from "../agents/auth-profiles/credential-normalize.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import { describeFailoverError } from "../agents/failover-error.js";
import {
  buildModelAliasIndex,
  isCliProvider,
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
  detectInferenceBackends,
  type InferenceBackendKind,
} from "../commands/onboard-inference.js";
import { resolveConfigSnapshotHash } from "../config/config.js";
import { createMergePatch } from "../config/io.write-prepare.js";
import {
  normalizeAgentModelRefForConfig,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
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
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { appendCrestodianAuditEntry } from "./audit.js";
import { loadAuthoredSetupConfig } from "./onboarding-welcome.js";
import {
  applyCrestodianModelSelection,
  applyCrestodianSetup,
  createQuickstartNotePrompter,
} from "./setup-apply.js";

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
  /** Config already carries authored setup and a default model. */
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

export type ActivateSetupInferenceResult =
  | { ok: true; modelRef: string; latencyMs: number; lines: string[] }
  | { ok: false; status: SetupInferenceStatus; error: string };

export type VerifySetupInferenceResult =
  | { ok: true; modelRef: string; latencyMs: number }
  | { ok: false; status: SetupInferenceStatus; error: string };

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

export type ActivateSetupInferenceDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  runEmbeddedAgent?: typeof import("../agents/embedded-agent.js").runEmbeddedAgent;
  runCliAgent?: typeof import("../agents/cli-runner.js").runCliAgent;
  applySetup?: typeof applyCrestodianSetup;
  ensureCodexRuntimePlugin?: typeof import("../commands/codex-runtime-plugin-install.js").ensureCodexRuntimePluginForModelSelection;
  transformConfigWithPendingPluginInstalls?: typeof import("../plugins/install-record-commit.js").transformConfigWithPendingPluginInstalls;
  resolvePluginProviders?: typeof resolvePluginProviders;
  resolveManifestProviderAuthChoice?: typeof resolveManifestProviderAuthChoice;
  enablePluginInConfig?: typeof enablePluginInConfig;
  resolveAgentDir?: typeof resolveAgentDir;
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

function probedTargetChangedError(params: {
  config: OpenClawConfig;
  expectedAgentId?: string;
  expectedModelRef?: string;
}): string | undefined {
  const currentAgentId = resolveDefaultAgentId(params.config);
  if (params.expectedAgentId && currentAgentId !== params.expectedAgentId) {
    return "The default agent changed while AI access was being tested. Try setup again.";
  }
  if (params.expectedModelRef) {
    const current = resolveDefaultModelForAgent({ cfg: params.config, agentId: currentAgentId });
    if (`${current.provider}/${current.model}` !== params.expectedModelRef) {
      return "The default model changed while AI access was being tested. Try setup again.";
    }
  }
  return undefined;
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
  const candidates = (await detectInferenceBackends({ config: cfg })).map((candidate) =>
    // Released macOS clients require this field. Keep it false so the wire
    // contract remains decodable without expressing a provider preference.
    Object.assign(candidate, { recommended: false as const }),
  );
  const { workspace, hasAuthoredSetup } = await resolveSetupInferenceWorkspace({
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
    setupComplete: hasAuthoredSetup && Boolean(configuredModel),
  };
}

type SetupInferenceTestPlan = {
  runner: "cli" | "embedded";
  provider: string;
  model: string;
  modelRef: string;
  config: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  cleanupBundleMcpOnRunEnd?: boolean;
  authProfileId?: string;
  /** Model to persist as default on success; undefined keeps the current one. */
  persistModelRef?: string;
  manualAuth?: {
    profiles: ProviderAuthResult["profiles"];
    configPatch: unknown;
    pluginId?: string;
  };
};

type RunResult = {
  payloads?: Array<{ text?: string }>;
  meta?: { finalAssistantVisibleText?: string; finalAssistantRawText?: string };
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

function parseRef(modelRef: string): { provider: string; model: string } {
  const slash = modelRef.indexOf("/");
  return slash === -1
    ? { provider: modelRef, model: "" }
    : { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

function mapFailoverReasonToSetupStatus(reason?: string | null): SetupInferenceStatus {
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

function agentRuntimeIdForSetupKind(
  kind: ActivateSetupInferenceParams["kind"],
): "codex" | "openclaw" | undefined {
  if (kind === "codex-cli") {
    return "codex";
  }
  if (kind === "openai-api-key" || kind === "anthropic-api-key" || kind === "api-key") {
    return "openclaw";
  }
  return undefined;
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
      const ref = resolveDefaultModelForAgent({ cfg, agentId: resolveDefaultAgentId(cfg) });
      const modelRef = `${ref.provider}/${ref.model}`;
      const requestedModelRef = params.modelRef?.trim();
      const requestedTarget = requestedModelRef
        ? canonicalizeSetupModelRef({ cfg, raw: requestedModelRef, defaultProvider: ref.provider })
        : undefined;
      if (requestedModelRef && requestedTarget !== modelRef) {
        return {
          error: `The configured default model changed from ${requestedModelRef} to ${modelRef}. Try setup again.`,
        };
      }
      return {
        runner: isCliProvider(ref.provider, cfg) ? "cli" : "embedded",
        provider: ref.provider,
        model: ref.model,
        modelRef,
        config: cfg,
        agentId: resolveDefaultAgentId(cfg),
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
        agentId: resolveDefaultAgentId(cfg),
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
        agentId: resolveDefaultAgentId(cfg),
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
        config: cfg,
        agentId: resolveDefaultAgentId(cfg),
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
        agentId: resolveDefaultAgentId(cfg),
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
        agentId: resolveDefaultAgentId(cfg),
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
      const matchingProfile =
        result.profiles.find(
          (profile) =>
            normalizeProviderId(profile.credential.provider) === normalizeProviderId(ref.provider),
        ) ?? result.profiles[0];
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        agentDir: params.agentDir,
        config: preparedConfig,
        agentId: resolveDefaultAgentId(preparedConfig),
        authProfileId: matchingProfile.profileId,
        persistModelRef: modelRef,
        manualAuth: {
          profiles: result.profiles,
          configPatch: createMergePatch(enableResult.config, preparedConfig),
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
    // oxlint-disable-next-line preserve-caught-error -- The original cause can contain the submitted setup secret.
    throw new Error(await redactSetupInferenceError(message, params.apiKey));
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
  let probedConfigHash = resolveConfigSnapshotHash(snapshot);
  const cfg: OpenClawConfig = snapshot.exists ? (snapshot.runtimeConfig ?? snapshot.config) : {};
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
  const setupWarnings: string[] = [];
  const testAgentDir = path.join(tempDir, "agent");
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

    const agentRuntimeId = agentRuntimeIdForSetupKind(params.kind);
    let testPlan = plan;
    if (plan.persistModelRef) {
      const stagedConfig = await applyCrestodianModelSelection({
        config: plan.config,
        model: plan.persistModelRef,
        ...(agentRuntimeId ? { agentRuntimeId } : {}),
      });
      testPlan = {
        ...plan,
        config: stagedConfig,
        agentId: resolveDefaultAgentId(stagedConfig),
      };
    }

    if (params.kind === "codex-cli") {
      const { stripPendingPluginInstallRecords } =
        await import("../plugins/install-record-commit.js");
      // This explicit Codex CLI choice owns its runtime independently of the
      // user's existing OpenAI provider route (which may use a custom base URL).
      const codexInstallBase = stripPendingPluginInstallRecords(testPlan.config);
      const enabledCodexBase = enablePluginInConfig(codexInstallBase, "codex");
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
        agentId: testPlan.agentId,
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
      const pendingCodexInstall = ensured.cfg.plugins?.installs?.codex;
      if (pendingCodexInstall) {
        // The package is already in the managed global root. Record ownership now so a
        // failed or abandoned live probe cannot leave an untracked install behind.
        const transformConfig =
          deps.transformConfigWithPendingPluginInstalls ??
          (await import("../plugins/install-record-commit.js"))
            .transformConfigWithPendingPluginInstalls;
        const committed = await transformConfig({
          afterWrite: {
            mode: "none",
            reason: "Crestodian records the installed Codex runtime before probing",
          },
          transform: (current) => {
            const strippedCurrent = stripPendingPluginInstallRecords(current);
            return {
              nextConfig: {
                ...strippedCurrent,
                plugins: {
                  ...strippedCurrent.plugins,
                  installs: { codex: pendingCodexInstall },
                },
              },
            };
          },
        });
        try {
          await appendCrestodianAuditEntry({
            operation: "plugin.install",
            summary: "Installed Codex runtime plugin",
            configPath: committed.path,
            configHashBefore: committed.previousHash,
            configHashAfter: committed.persistedHash,
            details: { pluginId: "codex", via: "crestodian.setup" },
          });
        } catch (error) {
          const warning = `Codex was installed, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`;
          params.runtime.error?.(warning);
          setupWarnings.push(warning);
        }
      }

      // Installation can take several minutes. Rebuild the probe input from
      // the current config so a concurrent policy or agent edit is never
      // replaced by the pre-install snapshot returned from the installer.
      const codexSnapshot = await readSnapshot();
      if (codexSnapshot.exists && !codexSnapshot.valid) {
        throw new Error(invalidSetupConfigError(codexSnapshot));
      }
      probedConfigHash = resolveConfigSnapshotHash(codexSnapshot);
      const currentCodexConfig: OpenClawConfig = codexSnapshot.exists
        ? (codexSnapshot.runtimeConfig ?? codexSnapshot.config)
        : {};
      const targetError = probedTargetChangedError({
        config: currentCodexConfig,
        ...(testPlan.agentId ? { expectedAgentId: testPlan.agentId } : {}),
      });
      if (targetError) {
        throw new Error(targetError);
      }
      const currentCodexSelection = plan.persistModelRef
        ? await applyCrestodianModelSelection({
            config: currentCodexConfig,
            model: plan.persistModelRef,
            ...(agentRuntimeId ? { agentRuntimeId } : {}),
          })
        : currentCodexConfig;
      const enabledCodex = enablePluginInConfig(currentCodexSelection, "codex");
      if (!enabledCodex.enabled) {
        return {
          ok: false,
          status: "unavailable",
          error: `Could not enable the Codex runtime plugin: ${enabledCodex.reason ?? "plugin disabled"}.`,
        };
      }
      // Enablement and the model-scoped runtime pin remain transient probe inputs.
      // Persist them only after completion; the managed install record is durable above.
      const stagedCodexConfig = stripPendingPluginInstallRecords(enabledCodex.config);
      testPlan = {
        ...testPlan,
        // Probe the policy that will actually persist. Codex rejects deny and
        // allowlist exec modes during initialization; masking that here would
        // pass onboarding and fail the user's first normal run.
        config: stagedCodexConfig,
        agentId: resolveDefaultAgentId(stagedCodexConfig),
      };
    }

    if (plan.manualAuth) {
      const staged = await persistManualAuthProfiles(plan.manualAuth.profiles, testAgentDir);
      if (!staged) {
        return {
          ok: false,
          status: "unknown",
          error: "Could not update the auth profile store; try again in a moment.",
        };
      }
    }

    const test = await runSetupInferenceTest({ plan: testPlan, tempDir, deps });
    if (!test.ok) {
      return test;
    }

    // The probe is agent-scoped. A concurrent default-agent switch would make
    // the final setup write target an untested agent (and potentially a
    // different credential store), so fail cleanly and let the user retry.
    const latestSnapshot = await readSnapshot();
    if (latestSnapshot.exists && !latestSnapshot.valid) {
      throw new Error(invalidSetupConfigError(latestSnapshot));
    }
    if (resolveConfigSnapshotHash(latestSnapshot) !== probedConfigHash) {
      throw new Error("OpenClaw config changed while AI access was being tested. Try setup again.");
    }
    const latestConfig: OpenClawConfig = latestSnapshot.exists
      ? (latestSnapshot.runtimeConfig ?? latestSnapshot.config)
      : {};
    const postProbeTargetError = probedTargetChangedError({
      config: latestConfig,
      ...(testPlan.agentId ? { expectedAgentId: testPlan.agentId } : {}),
      ...(params.kind === "existing-model" ? { expectedModelRef: plan.modelRef } : {}),
    });
    if (postProbeTargetError) {
      throw new Error(postProbeTargetError);
    }

    let manualAuthWrite: ManualAuthWrite | undefined;
    let expectedAgentDir: string | undefined;
    if (plan.manualAuth) {
      // Resolve the durable path from current config because the same agent's
      // storage root can move while a 90-second live probe is running.
      expectedAgentDir = (deps.resolveAgentDir ?? resolveAgentDir)(
        latestConfig,
        resolveDefaultAgentId(latestConfig),
      );
      const persistedAuthWrite = await persistManualAuthProfiles(
        plan.manualAuth.profiles,
        expectedAgentDir,
      );
      if (!persistedAuthWrite) {
        return {
          ok: false,
          status: "unknown",
          error: "Could not update the auth profile store; try again in a moment.",
        };
      }
      manualAuthWrite = persistedAuthWrite;
    }

    const applySetup = deps.applySetup ?? applyCrestodianSetup;
    let applied: Awaited<ReturnType<typeof applyCrestodianSetup>>;
    try {
      applied = await applySetup({
        workspace,
        ...(plan.persistModelRef ? { model: plan.persistModelRef } : {}),
        ...(agentRuntimeId ? { agentRuntimeId } : {}),
        ...(testPlan.agentId ? { expectedAgentId: testPlan.agentId } : {}),
        ...(expectedAgentDir ? { expectedAgentDir } : {}),
        ...(params.kind === "existing-model" ? { expectedModelRef: plan.modelRef } : {}),
        expectedConfigHash: probedConfigHash,
        ...(plan.manualAuth ? { configPatch: plan.manualAuth.configPatch } : {}),
        ...(plan.manualAuth?.pluginId
          ? { enablePluginId: plan.manualAuth.pluginId }
          : params.kind === "codex-cli"
            ? { enablePluginId: "codex" }
            : {}),
        ...(params.kind === "codex-cli" ? { refreshPluginRegistry: true } : {}),
        ...(manualAuthWrite ? { assertCommitPreconditions: manualAuthWrite.assertUnchanged } : {}),
        surface: params.surface,
        runtime: params.runtime,
      });
    } catch (error) {
      if (manualAuthWrite) {
        try {
          await manualAuthWrite.rollback();
        } catch {
          params.runtime.error?.(
            "Setup failed and OpenClaw could not roll back the temporary auth profile update.",
          );
        }
      }
      throw error;
    }
    let lines = [...applied.lines, ...setupWarnings];
    if (params.surface === "gateway" && params.recordSetupAudit !== false) {
      try {
        await appendCrestodianAuditEntry({
          operation: "crestodian.setup",
          summary: "Configured AI access through Crestodian setup",
          configPath: applied.configPath,
          configHashBefore: applied.configHashBefore,
          configHashAfter: applied.configHashAfter,
          details: { modelRef: plan.modelRef, inferenceKind: params.kind },
        });
      } catch (error) {
        // The config commit is durable at this point. Report audit trouble as a
        // visible warning instead of claiming the already-applied setup failed.
        const warning = `Setup completed, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`;
        params.runtime.error?.(warning);
        lines = [...lines, warning];
      }
    }
    return { ok: true, modelRef: plan.modelRef, latencyMs: test.latencyMs, lines };
  } finally {
    await removeSetupInferenceTempDir(deps, tempDir, params.runtime);
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

/** Live-test the configured default model without changing config or auth state. */
export async function verifySetupInference(params: {
  kind?: "existing-model";
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: ActivateSetupInferenceDeps;
}): Promise<VerifySetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    return { ok: false, status: "format", error: invalidSetupConfigError(snapshot) };
  }
  const cfg: OpenClawConfig = snapshot.exists ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const tempDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  try {
    const plan = await buildTestPlan({
      kind: params.kind ?? "existing-model",
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
    const test = await runSetupInferenceTest({ plan, tempDir, deps });
    if (test.ok) {
      return { ...test, modelRef: plan.modelRef };
    }
    return {
      ...test,
      error: await redactSetupInferenceError(test.error),
    };
  } finally {
    await removeSetupInferenceTempDir(deps, tempDir, params.runtime);
  }
}

async function removeSetupInferenceTempDir(
  deps: ActivateSetupInferenceDeps,
  tempDir: string,
  runtime: RuntimeEnv,
): Promise<void> {
  try {
    await (deps.removeTempDir ?? ((dir: string) => fs.rm(dir, { recursive: true, force: true })))(
      tempDir,
    );
  } catch (error) {
    runtime.error?.(`Could not remove temporary AI setup files: ${formatErrorMessage(error)}`);
  }
}

type ManualAuthWrite = {
  assertUnchanged: () => void;
  rollback: () => Promise<void>;
};

async function persistManualAuthProfiles(
  profiles: ProviderAuthResult["profiles"],
  agentDir: string,
): Promise<ManualAuthWrite | null> {
  const writes = new Map(
    profiles.map((profile) => [
      profile.profileId,
      normalizeAuthProfileCredential(profile.credential),
    ]),
  );
  const previous = new Map<string, ProviderAuthResult["profiles"][number]["credential"]>();
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater: (store) => {
      for (const [profileId, credential] of writes) {
        const current = store.profiles[profileId];
        if (current !== undefined) {
          previous.set(profileId, structuredClone(current));
        }
        store.profiles[profileId] = structuredClone(credential);
      }
      return true;
    },
  });
  if (!updated) {
    return null;
  }
  const assertUnchanged = (): void => {
    const store = loadPersistedAuthProfileStore(agentDir);
    for (const [profileId, written] of writes) {
      if (!isDeepStrictEqual(store?.profiles[profileId], written)) {
        throw new Error("AI credentials changed while setup was being committed. Try setup again.");
      }
    }
  };
  const rollback = async (): Promise<void> => {
    const rolledBack = await updateAuthProfileStoreWithLock({
      agentDir,
      saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
      updater: (store) => {
        let changed = false;
        for (const [profileId, written] of writes) {
          if (!isDeepStrictEqual(store.profiles[profileId], written)) {
            continue;
          }
          const original = previous.get(profileId);
          if (original === undefined) {
            delete store.profiles[profileId];
          } else {
            store.profiles[profileId] = structuredClone(original);
          }
          changed = true;
        }
        return changed;
      },
    });
    if (!rolledBack) {
      throw new Error("Could not roll back auth profile update.");
    }
  };
  return { assertUnchanged, rollback };
}

async function runSetupInferenceTest(params: {
  plan: SetupInferenceTestPlan;
  tempDir: string;
  deps: ActivateSetupInferenceDeps;
}): Promise<
  { ok: true; latencyMs: number } | { ok: false; status: SetupInferenceStatus; error: string }
> {
  const { plan, tempDir, deps } = params;
  // Keep these probe prefixes aligned with logging/subsystem.ts and process/command-queue.ts
  // so expected setup failures stay off the interactive TTY.
  const runId = `probe-setup-inference-${randomUUID()}`;
  const sessionId = `${runId}-session`;
  const sessionFile = path.join(tempDir, "session.jsonl");
  const timeoutMs = deps.timeoutMs ?? SETUP_INFERENCE_TEST_TIMEOUT_MS;
  const started = Date.now();
  try {
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
        timeoutMs,
        runId,
        messageChannel: "crestodian",
        messageProvider: "crestodian",
        cleanupCliLiveSessionOnRunEnd: true,
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
        ...(plan.cleanupBundleMcpOnRunEnd ? { cleanupBundleMcpOnRunEnd: true } : {}),
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
      })) as RunResult;
    }
    const text = extractRunText(result)?.trim();
    if (!text) {
      return {
        ok: false,
        status: "format",
        error: "The model started but did not send a reply. Try again or pick another option.",
      };
    }
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    const described = describeFailoverError(error);
    return {
      ok: false,
      status: mapFailoverReasonToSetupStatus(described.reason),
      error: described.message,
    };
  }
}
