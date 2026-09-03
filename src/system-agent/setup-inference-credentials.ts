// Credential-side staging for one setup candidate: sign in through the provider's own method,
// save what it returns, and hand back the starter model plus the provider-configured config.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  applyProviderPluginAuthMethodResultConfig,
  runProviderPluginAuthMethod,
} from "../plugins/provider-auth-choice.js";
import {
  type ProviderAuthChoiceMetadata,
  resolveManifestProviderAuthChoice,
} from "../plugins/provider-auth-choices.js";
import { persistProviderAuthProfileBatch } from "../plugins/provider-auth-persistence.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";
import type { ProviderAuthMethod, ProviderAuthResult } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import { createQuickstartNotePrompter } from "./setup-apply.js";
import {
  supportsSetupManualSecret,
  supportsSetupTextInference,
} from "./setup-inference-auth-options.js";
import {
  type ActivateSetupInferenceParams,
  type SetupInferenceDeps,
  SetupInferenceCancelledError,
  throwIfSetupInferenceCancelled,
  waitForProviderAuth,
} from "./setup-inference-core.js";

export type StagedCandidate = {
  /** Model to write as the default, already spelled with its durable provider. */
  modelRef: string;
  agentRuntimeId?: string;
  /** Config carrying the credential-side changes (provider config, plugin enablement). */
  config: OpenClawConfig;
};

export type StageFailure = { error: string };

export type StageContext = {
  params: ActivateSetupInferenceParams;
  deps: SetupInferenceDeps;
  cfg: OpenClawConfig;
  routeAgentId: string;
  agentDir: string;
  workspace: string;
  beforePersistentEffect: () => Promise<void>;
};

export function parseRef(modelRef: string): { provider: string; model: string } {
  const slash = modelRef.indexOf("/");
  return slash === -1
    ? { provider: modelRef, model: "" }
    : { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

async function loadProviderAuthMethod(
  ctx: StageContext,
  choice: ProviderAuthChoiceMetadata,
): Promise<
  | { config: OpenClawConfig; providerId: string; label: string; method: ProviderAuthMethod }
  | StageFailure
> {
  // Carry callable auth methods past the lease, never an unbound enabled config.
  return await withPluginLifecycleLease({}, async () => {
    const enabled = await enablePluginWithCapabilityConsent(ctx.cfg, choice.pluginId, {
      workspaceDir: ctx.workspace,
      onCapabilityConsent: ctx.params.prompter
        ? createPluginCapabilityConsentPrompter(ctx.params.prompter, () =>
            throwIfSetupInferenceCancelled(ctx.params),
          )
        : undefined,
    });
    if (!enabled.enabled) {
      return { error: `${choice.choiceLabel} is disabled (${enabled.reason ?? "blocked"}).` };
    }
    const providers = (ctx.deps.resolvePluginProviders ?? resolvePluginProvidersCore)({
      config: enabled.config,
      workspaceDir: ctx.workspace,
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
    if (!provider || !method || !supportsSetupTextInference(method.wizard?.onboardingScopes)) {
      return { error: "That provider setup is not available on this Gateway." };
    }
    return { config: enabled.config, providerId: provider.id, label: provider.label, method };
  });
}

function resolveStarterModel(
  label: string,
  result: { defaultModel?: string },
): string | StageFailure {
  const modelRef = result.defaultModel ? normalizeAgentModelRefForConfig(result.defaultModel) : "";
  if (!modelRef || !parseRef(modelRef).model) {
    return { error: `${label} does not expose a starter model for app-guided setup.` };
  }
  return modelRef;
}

/** Providers without a plugin-owned secret writer take the pasted key through their CLI path. */
async function runProviderManualSecretMethod(
  ctx: StageContext,
  choice: ProviderAuthChoiceMetadata,
  method: ProviderAuthMethod,
  config: OpenClawConfig,
  apiKey: string,
): Promise<{ result: ProviderAuthResult; config: OpenClawConfig }> {
  const optionKey = choice.optionKey;
  const runNonInteractive = method.runNonInteractive;
  if (!optionKey || !choice.cliOption || !runNonInteractive) {
    throw new Error("Provider does not expose app-guided secret setup.");
  }
  let methodError = "";
  const isolatedRuntime: RuntimeEnv = {
    log: () => {},
    error: (...args) => {
      methodError = args.map(String).join(" ");
    },
    // Provider CLI methods use exit for validation failures; keep them request-local.
    exit: (code) => {
      throw new Error(methodError || `Provider setup exited with code ${code}.`);
    },
  };
  const configured = await runNonInteractive({
    authChoice: choice.choiceId,
    config,
    baseConfig: ctx.cfg,
    opts: { [optionKey]: apiKey, secretInputMode: "plaintext" },
    runtime: isolatedRuntime,
    agentDir: ctx.agentDir,
    workspaceDir: ctx.workspace,
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
  const configuredModel = configured.agents?.defaults?.model;
  const defaultModel = typeof configuredModel === "string" ? configuredModel : method.starterModel;
  if (!defaultModel) {
    throw new Error("Provider setup did not produce a starter model.");
  }
  return { result: { profiles: [], defaultModel }, config: configured };
}

export async function stageProviderAutoCandidate(
  ctx: StageContext,
  choiceId: string,
): Promise<StagedCandidate | StageFailure> {
  const choice = (ctx.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice)(
    choiceId,
    {
      config: ctx.cfg,
      workspaceDir: ctx.workspace,
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    },
  );
  if (
    !choice ||
    choice.appGuidedDiscovery !== true ||
    !supportsSetupTextInference(choice.onboardingScopes)
  ) {
    return { error: "That detected provider is no longer available on this Gateway." };
  }
  const loaded = await loadProviderAuthMethod(ctx, choice);
  if ("error" in loaded) {
    return loaded;
  }
  const guidedSetup = loaded.method.appGuidedSetup;
  const modelRef = ctx.params.modelRef?.trim();
  if (!guidedSetup || !modelRef) {
    return { error: "The detected provider model is missing. Run detection again." };
  }
  const prepared = await guidedSetup.prepare({
    config: loaded.config,
    env: process.env,
    workspaceDir: ctx.workspace,
    modelRef,
    ...(ctx.params.signal ? { signal: ctx.params.signal } : {}),
  });
  const preparedModelRef = prepared?.defaultModel
    ? normalizeAgentModelRefForConfig(prepared.defaultModel)
    : "";
  if (!prepared || preparedModelRef !== modelRef) {
    return {
      error: `${choice.choiceLabel} could not prepare the detected model. Run detection again.`,
    };
  }
  const config = applyProviderPluginAuthMethodResultConfig({
    config: loaded.config,
    result: prepared,
  });
  if (prepared.profiles.length > 0) {
    await ctx.beforePersistentEffect();
    await persistProviderAuthProfileBatch({
      profiles: prepared.profiles,
      config,
      agentDir: ctx.agentDir,
    });
  }
  return { modelRef, agentRuntimeId: "openclaw", config };
}

export async function stageProviderAuthCandidate(
  ctx: StageContext,
  interactive: boolean,
): Promise<StagedCandidate | StageFailure> {
  const { params } = ctx;
  const apiKey = params.apiKey?.trim();
  if (!interactive && !apiKey) {
    return { error: "Enter an API key or token first." };
  }
  const authChoice = params.authChoice?.trim();
  if (interactive && authChoice === "custom-api-key") {
    if (params.surface === "gateway") {
      return { error: "For a custom provider, run openclaw onboard on the Gateway host." };
    }
    if (!params.prompter) {
      return { error: "Custom provider setup requires an interactive CLI session." };
    }
    const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
    throwIfSetupInferenceCancelled(params);
    const prepared = await waitForProviderAuth(
      promptCustomApiConfig({
        config: ctx.cfg,
        runtime: params.runtime,
        prompter: params.prompter,
        target: { agentId: ctx.routeAgentId, agentDir: ctx.agentDir, workspaceDir: ctx.workspace },
        // Endpoint verification prepares config; only the live turn may select it.
        setAsPrimary: false,
      }),
      params.signal,
    );
    throwIfSetupInferenceCancelled(params);
    return {
      modelRef: `${prepared.providerId}/${prepared.modelId}`,
      agentRuntimeId: "openclaw",
      config: prepared.config,
    };
  }
  const choice = authChoice
    ? (ctx.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice)(
        authChoice,
        {
          config: ctx.cfg,
          workspaceDir: ctx.workspace,
          includeUntrustedWorkspacePlugins: false,
          includeWorkspacePlugins: false,
        },
      )
    : undefined;
  const unavailable = interactive
    ? "That provider setup is not available on this Gateway."
    : "That key-based provider is not available on this Gateway.";
  if (
    !choice ||
    !supportsSetupTextInference(choice.onboardingScopes) ||
    (!interactive && !supportsSetupManualSecret(choice)) ||
    (interactive &&
      (choice.assistantVisibility === "manual-only" ||
        (!choice.appGuidedAuth && choice.appGuidedDiscovery !== true)))
  ) {
    return { error: unavailable };
  }
  const loaded = await loadProviderAuthMethod(ctx, choice);
  if ("error" in loaded) {
    return loaded;
  }
  const { method } = loaded;
  if (
    interactive &&
    choice.appGuidedDiscovery !== true &&
    method.kind !== "oauth" &&
    method.kind !== "device_code"
  ) {
    return { error: unavailable };
  }
  const shared = {
    runtime: params.runtime,
    method,
    agentDir: ctx.agentDir,
    agentId: ctx.routeAgentId,
    workspaceDir: ctx.workspace,
    beforePersistentEffect: ctx.beforePersistentEffect,
  };
  try {
    if (interactive) {
      if (!params.prompter) {
        return { error: "This provider login requires an interactive setup session." };
      }
      throwIfSetupInferenceCancelled(params);
      const login = await waitForProviderAuth(
        runProviderPluginAuthMethod({
          ...shared,
          config: loaded.config,
          prompter: params.prompter,
          ...(params.signal ? { signal: params.signal } : {}),
          isRemote: params.surface === "gateway",
        }),
        params.signal,
      );
      throwIfSetupInferenceCancelled(params);
      if (choice.appGuidedDiscovery !== true) {
        const modelRef = resolveStarterModel(loaded.label, login);
        return typeof modelRef === "string"
          ? { modelRef, agentRuntimeId: "openclaw", config: login.config }
          : modelRef;
      }
      const guidedSetup = method.appGuidedSetup;
      if (!guidedSetup) {
        return { error: unavailable };
      }
      const candidate = login.defaultModel
        ? { modelRef: login.defaultModel }
        : await guidedSetup.detect({
            config: login.config,
            env: process.env,
            workspaceDir: ctx.workspace,
            ...(params.signal ? { signal: params.signal } : {}),
          });
      if (!candidate) {
        return {
          error: `${loaded.label} setup completed, but no compatible model was found. Add a compatible model and try again.`,
        };
      }
      const prepared = await guidedSetup.prepare({
        config: login.config,
        env: process.env,
        workspaceDir: ctx.workspace,
        modelRef: candidate.modelRef,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const modelRef = prepared ? resolveStarterModel(loaded.label, prepared) : undefined;
      if (!prepared || typeof modelRef !== "string" || modelRef !== candidate.modelRef) {
        return { error: `${loaded.label} could not prepare its detected model. Try setup again.` };
      }
      const config = applyProviderPluginAuthMethodResultConfig({
        config: login.config,
        result: prepared,
      });
      if (prepared.profiles.length > 0) {
        await persistProviderAuthProfileBatch({
          profiles: prepared.profiles,
          config,
          agentDir: ctx.agentDir,
        });
      }
      return { modelRef, agentRuntimeId: "openclaw", config };
    }
    if (method.kind === "api_key" || method.kind === "token") {
      const saved = await runProviderPluginAuthMethod({
        ...shared,
        config: loaded.config,
        prompter: createQuickstartNotePrompter(params.runtime),
        secretInputMode: "plaintext",
        allowSecretRefPrompt: false,
        opts: { token: apiKey!, tokenProvider: loaded.providerId },
      });
      const modelRef = resolveStarterModel(loaded.label, saved);
      return typeof modelRef === "string"
        ? { modelRef, agentRuntimeId: "openclaw", config: saved.config }
        : modelRef;
    }
    await ctx.beforePersistentEffect();
    const manual = await runProviderManualSecretMethod(ctx, choice, method, loaded.config, apiKey!);
    const modelRef = resolveStarterModel(loaded.label, manual.result);
    return typeof modelRef === "string"
      ? { modelRef, agentRuntimeId: "openclaw", config: manual.config }
      : modelRef;
  } catch (error) {
    if (error instanceof SetupInferenceCancelledError || params.signal?.aborted) {
      return { error: "Provider login was cancelled." };
    }
    return {
      error: `${loaded.label} could not prepare this ${interactive ? "login" : "credential"} for app-guided setup: ${formatErrorMessage(error)}`,
    };
  }
}
