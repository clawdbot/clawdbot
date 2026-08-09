import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderAuthMethod, ProviderAuthResult } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { parseRef } from "./setup-inference-plan-helpers.js";

export async function runProviderManualSecretMethod(params: {
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
  const existingPrimary = resolveAgentModelPrimaryValue(params.config.agents?.defaults?.model);
  const existingProvider = existingPrimary ? parseRef(existingPrimary).provider : undefined;
  let providerSetupConfig = params.config;
  if (
    existingProvider &&
    normalizeProviderId(existingProvider) !== normalizeProviderId(params.choice.providerId)
  ) {
    const agents = params.config.agents;
    const defaults = agents?.defaults;
    const model = defaults?.model;
    if (defaults && model !== undefined) {
      const { model: _model, ...defaultsWithoutModel } = defaults;
      let modelWithoutPrimary: Exclude<typeof model, string> | undefined;
      if (typeof model === "object" && model !== null) {
        const { primary: _primary, ...remainingModelConfig } = model;
        modelWithoutPrimary = remainingModelConfig;
      }
      // App-guided setup needs this provider's verified candidate, not an
      // unrelated current default. The original config remains the merge base.
      providerSetupConfig = {
        ...params.config,
        agents: {
          ...agents,
          defaults:
            modelWithoutPrimary && Object.keys(modelWithoutPrimary).length > 0
              ? { ...defaultsWithoutModel, model: modelWithoutPrimary }
              : defaultsWithoutModel,
        },
      };
    }
  }

  const configured = await runNonInteractive({
    authChoice: params.choice.choiceId,
    config: providerSetupConfig,
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
