// Post-selection model/auth sanity checks shown during onboarding and agent setup.
import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { hasUsableCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import {
  listOpenAIAuthProfileProvidersForAgentRuntime,
  openAIProviderUsesCodexRuntimeByDefault,
} from "../agents/openai-routing.js";
import { buildProviderAuthRecoveryHint } from "../agents/provider-auth-recovery-hint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";

function resolveAuthProviderCandidates(params: {
  config: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId?: string;
}): string[] {
  const harnessPolicy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
  });
  return [
    ...new Set([
      params.provider,
      ...listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: params.provider,
        harnessRuntime: harnessPolicy.runtime,
        config: params.config,
      }),
    ]),
  ];
}

function resolveAcceptedAuthProfileTypes(params: {
  config: OpenClawConfig;
  provider: string;
}): readonly AuthProfileCredential["type"][] | undefined {
  if (
    openAIProviderUsesCodexRuntimeByDefault({
      provider: params.provider,
      config: params.config,
    })
  ) {
    return undefined;
  }
  return params.provider === "openai" ? ["api_key"] : undefined;
}

function hasProfileForProvider(params: {
  store: ReturnType<typeof ensureAuthProfileStore>;
  provider: string;
  acceptedTypes?: readonly AuthProfileCredential["type"][];
}): boolean {
  const profileIds = listProfilesForProvider(params.store, params.provider);
  if (!params.acceptedTypes) {
    return profileIds.length > 0;
  }
  const acceptedTypes = new Set(params.acceptedTypes);
  return profileIds.some((profileId) => {
    const profile = params.store.profiles[profileId];
    return profile ? acceptedTypes.has(profile.type) : false;
  });
}

/** Warn when the selected default model is unknown or has no usable credentials. */
export async function warnIfModelConfigLooksOff(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  options?: { agentId?: string; agentDir?: string; validateCatalog?: boolean },
) {
  const ref = resolveDefaultModelForAgent({
    cfg: config,
    agentId: options?.agentId,
  });
  const warnings: string[] = [];
  if (options?.validateCatalog !== false) {
    const catalog = await loadModelCatalog({
      config,
      useCache: false,
    });
    if (catalog.length > 0) {
      const known = catalog.some(
        (entry) => entry.provider === ref.provider && entry.id === ref.model,
      );
      if (!known) {
        warnings.push(
          `Model not found: ${ref.provider}/${ref.model}. Update agents.defaults.model or run /models list.`,
        );
      }
    }
  }

  const store = ensureAuthProfileStore(options?.agentDir);
  const authProviders = resolveAuthProviderCandidates({
    config,
    provider: ref.provider,
    modelId: ref.model,
    agentId: options?.agentId,
  });
  const acceptedTypes = resolveAcceptedAuthProfileTypes({
    config,
    provider: ref.provider,
  });
  const hasAuth =
    authProviders.some((provider) => hasProfileForProvider({ store, provider, acceptedTypes })) ||
    authProviders.some((provider) => resolveEnvApiKey(provider)) ||
    authProviders.some((provider) => hasUsableCustomProviderApiKey(config, provider));
  if (!hasAuth) {
    warnings.push(
      `No auth configured for provider "${ref.provider}". The agent may fail until credentials are added. ${buildProviderAuthRecoveryHint(
        {
          provider: ref.provider,
          config,
          includeEnvVar: true,
        },
      )}`,
    );
  }

  if (warnings.length > 0) {
    await prompter.note(warnings.join("\n"), "Model check");
  }
}
