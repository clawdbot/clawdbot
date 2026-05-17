import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { hasUsableCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../agents/openai-codex-routing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { buildProviderAuthRecoveryHint } from "./provider-auth-guidance.js";

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
  const hasAuth =
    authProviders.some((provider) => listProfilesForProvider(store, provider).length > 0) ||
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
