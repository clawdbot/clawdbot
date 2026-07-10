// First-run inference activation: detect candidates, live-test, persist only on success.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeAuthProfileCredential } from "../agents/auth-profiles/credential-normalize.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import { describeFailoverError } from "../agents/failover-error.js";
import {
  isCliProvider,
  normalizeProviderId,
  resolveDefaultModelForAgent,
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
import { createMergePatch } from "../config/io.write-prepare.js";
import { applyMergePatch } from "../config/merge-patch.js";
import {
  normalizeAgentModelRefForConfig,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  recommended: boolean;
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
  /** Manual step only: provider-auth choice returned by detection. */
  authChoice?: string;
  /** Manual step only: the pasted API key or token. Never logged. */
  apiKey?: string;
  workspace?: string;
  surface: "cli" | "gateway";
  runtime: RuntimeEnv;
  deps?: ActivateSetupInferenceDeps;
};

export type ActivateSetupInferenceDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  runEmbeddedAgent?: typeof import("../agents/embedded-agent.js").runEmbeddedAgent;
  runCliAgent?: typeof import("../agents/cli-runner.js").runCliAgent;
  applySetup?: typeof applyCrestodianSetup;
  ensureCodexRuntimePlugin?: typeof import("../commands/codex-runtime-plugin-install.js").ensureCodexRuntimePluginForModelSelection;
  transformConfigWithPendingPluginInstalls?: typeof import("../cli/plugins-install-record-commit.js").transformConfigWithPendingPluginInstalls;
  updateConfig?: typeof import("../commands/models/shared.js").updateConfig;
  refreshPluginRegistryAfterConfigMutation?: typeof import("../cli/plugins-registry-refresh.js").refreshPluginRegistryAfterConfigMutation;
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
  const cfg = snapshot.exists && snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const raw = await detectInferenceBackends({ config: cfg });
  // Recommended = the first candidate setup itself would bootstrap with; a
  // definitively logged-out CLI never gets the badge.
  const recommendedIndex = raw.findIndex((candidate) => candidate.credentials !== false);
  const candidates = raw.map((candidate, index) => ({
    ...candidate,
    recommended: index === recommendedIndex,
  }));
  const { workspace, hasAuthoredSetup } = await resolveSetupInferenceWorkspace({
    configExists: snapshot.exists,
    configValid: snapshot.valid,
  });
  const configuredModel = raw.find((candidate) => candidate.kind === "existing-model")?.modelRef;
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

async function buildTestPlan(params: {
  kind: InferenceBackendKind | "api-key";
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
  switch (kind) {
    case "existing-model": {
      const ref = resolveDefaultModelForAgent({ cfg, agentId: resolveDefaultAgentId(cfg) });
      const modelRef = `${ref.provider}/${ref.model}`;
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
      const ref = parseRef(CLAUDE_CLI_DEFAULT_MODEL_REF);
      return {
        runner: "cli",
        ...ref,
        modelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
        config: cfg,
        agentId: resolveDefaultAgentId(cfg),
        persistModelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      };
    }
    case "gemini-cli": {
      const ref = parseRef(GEMINI_CLI_DEFAULT_MODEL_REF);
      return {
        runner: "cli",
        ...ref,
        modelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
        config: cfg,
        agentId: resolveDefaultAgentId(cfg),
        persistModelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      };
    }
    case "codex-cli": {
      const ref = parseRef(CODEX_APP_SERVER_DEFAULT_MODEL_REF);
      return {
        runner: "embedded",
        ...ref,
        modelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
        config: cfg,
        agentId: resolveDefaultAgentId(cfg),
        agentDir: params.agentDir,
        cleanupBundleMcpOnRunEnd: true,
        persistModelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
      };
    }
    case "openai-api-key": {
      const ref = parseRef(OPENAI_API_DEFAULT_MODEL_REF);
      return {
        runner: "embedded",
        ...ref,
        modelRef: OPENAI_API_DEFAULT_MODEL_REF,
        config: cfg,
        agentId: resolveDefaultAgentId(cfg),
        persistModelRef: OPENAI_API_DEFAULT_MODEL_REF,
      };
    }
    case "anthropic-api-key": {
      const ref = parseRef(ANTHROPIC_API_DEFAULT_MODEL_REF);
      return {
        runner: "embedded",
        ...ref,
        modelRef: ANTHROPIC_API_DEFAULT_MODEL_REF,
        config: cfg,
        agentId: resolveDefaultAgentId(cfg),
        persistModelRef: ANTHROPIC_API_DEFAULT_MODEL_REF,
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
      } catch {
        return {
          error: `${resolved.provider.label} could not prepare this credential for app-guided setup.`,
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
 * copied into the real agent store only after success, so failures leave no trace.
 */
export async function activateSetupInference(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  try {
    const result = await activateSetupInferenceUnredacted(params);
    if (result.ok) {
      return result;
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
  const cfg: OpenClawConfig =
    snapshot.exists && snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
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
  const agentDir = (deps.resolveAgentDir ?? resolveAgentDir)(cfg, resolveDefaultAgentId(cfg));
  const testAgentDir = path.join(tempDir, "agent");
  try {
    const plan = await buildTestPlan({
      kind: params.kind,
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
      const stagedConfig = await applyCrestodianModelSelection({
        config: plan.config,
        model: plan.persistModelRef,
        ...(params.kind === "codex-cli" ? { agentRuntimeId: "codex" } : {}),
      });
      testPlan = {
        ...plan,
        config: stagedConfig,
        agentId: resolveDefaultAgentId(stagedConfig),
      };
    }

    let codexPluginPatch: unknown;
    if (params.kind === "codex-cli") {
      const { stripPendingPluginInstallRecords } =
        await import("../cli/plugins-install-record-commit.js");
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
          (await import("../cli/plugins-install-record-commit.js"))
            .transformConfigWithPendingPluginInstalls;
        await transformConfig({
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
      }
      const enabledCodex = enablePluginInConfig(ensured.cfg, "codex");
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
      codexPluginPatch = createMergePatch(cfg, stagedCodexConfig);
      testPlan = {
        ...testPlan,
        config: applyMergePatch(stagedCodexConfig, {
          tools: { exec: { mode: "full" } },
        }) as OpenClawConfig,
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

    if (codexPluginPatch !== undefined) {
      // Persist success-gated enablement and the model-scoped runtime pin. The managed
      // install record was committed before the live probe.
      const { stripPendingPluginInstallRecords } =
        await import("../cli/plugins-install-record-commit.js");
      const transformConfig =
        deps.transformConfigWithPendingPluginInstalls ??
        (await import("../cli/plugins-install-record-commit.js"))
          .transformConfigWithPendingPluginInstalls;
      const committed = await transformConfig({
        // Keep the setup RPC alive until the final model/setup write completes. The explicit
        // registry refresh below makes the newly installed plugin available without a restart.
        afterWrite: { mode: "none", reason: "Crestodian setup finalizes config after refresh" },
        transform: (current) => ({
          nextConfig: applyMergePatch(
            stripPendingPluginInstallRecords(current),
            codexPluginPatch,
          ) as OpenClawConfig,
        }),
      });
      const refreshPluginRegistry =
        deps.refreshPluginRegistryAfterConfigMutation ??
        (await import("../cli/plugins-registry-refresh.js"))
          .refreshPluginRegistryAfterConfigMutation;
      await refreshPluginRegistry({
        config: committed.nextConfig,
        reason: "source-changed",
        workspaceDir: workspace,
        logger: { warn: (message) => params.runtime.log?.(message) },
      });
    }
    if (plan.manualAuth) {
      const manualAuth = plan.manualAuth;
      const persisted = await persistManualAuthProfiles(manualAuth.profiles, agentDir);
      if (!persisted) {
        return {
          ok: false,
          status: "unknown",
          error: "Could not update the auth profile store; try again in a moment.",
        };
      }
      const updateConfig =
        deps.updateConfig ?? (await import("../commands/models/shared.js")).updateConfig;
      await updateConfig((current) => applyManualAuthConfig(current, manualAuth));
    }

    const applySetup = deps.applySetup ?? applyCrestodianSetup;
    const applied = await applySetup({
      workspace,
      ...(plan.persistModelRef ? { model: plan.persistModelRef } : {}),
      surface: params.surface,
      runtime: params.runtime,
    });
    return { ok: true, modelRef: plan.modelRef, latencyMs: test.latencyMs, lines: applied.lines };
  } finally {
    await (deps.removeTempDir ?? ((dir: string) => fs.rm(dir, { recursive: true, force: true })))(
      tempDir,
    );
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
  const cfg: OpenClawConfig =
    snapshot.exists && snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
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
    await (deps.removeTempDir ?? ((dir: string) => fs.rm(dir, { recursive: true, force: true })))(
      tempDir,
    );
  }
}

function applyManualAuthConfig(
  config: OpenClawConfig,
  manualAuth: NonNullable<SetupInferenceTestPlan["manualAuth"]>,
): OpenClawConfig {
  let enabledConfig = config;
  if (manualAuth.pluginId) {
    const enableResult = enablePluginInConfig(config, manualAuth.pluginId);
    if (!enableResult.enabled) {
      throw new Error(`Provider plugin ${manualAuth.pluginId} is ${enableResult.reason}.`);
    }
    enabledConfig = enableResult.config;
  }
  return applyMergePatch(enabledConfig, manualAuth.configPatch) as OpenClawConfig;
}

async function persistManualAuthProfiles(
  profiles: ProviderAuthResult["profiles"],
  agentDir: string,
): Promise<boolean> {
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater: (store) => {
      for (const profile of profiles) {
        store.profiles[profile.profileId] = normalizeAuthProfileCredential(profile.credential);
      }
      return true;
    },
  });
  return updated !== null;
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
