import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPrepareDynamicModelContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { getCachedLiveCatalogValue } from "openclaw/plugin-sdk/provider-catalog-shared";
import { resolveFirstGithubToken } from "./auth.js";
import { resolveGithubCopilotDomain } from "./domain.js";
import {
  PROVIDER_ID,
  fetchCopilotModelCatalog,
  resolveCopilotForwardCompatModel,
} from "./models.js";

type GithubCopilotCatalogContext = {
  agentDir?: string;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  profileId?: string;
  authProfileMode?: ProviderPrepareDynamicModelContext["authProfileMode"];
};

function dynamicModelScope(
  profileId?: string,
  authProfileMode?: ProviderPrepareDynamicModelContext["authProfileMode"],
): string {
  const normalizedProfileId = profileId?.trim();
  return normalizedProfileId
    ? `profile:${normalizedProfileId}`
    : authProfileMode
      ? `direct:${authProfileMode}`
      : "unscoped";
}

async function loadGithubCopilotRuntime() {
  return await import("./register.runtime.js");
}

export function createGithubCopilotDynamicModelHooks(params: {
  discoveryEnabled(config?: OpenClawConfig): boolean;
}) {
  const preparedDynamicModels = new WeakMap<
    object,
    Map<string, ReadonlyMap<string, ProviderRuntimeModel>>
  >();

  async function resolveCatalog(ctx: GithubCopilotCatalogContext) {
    if (!params.discoveryEnabled(ctx.config)) {
      return null;
    }
    const { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotApiToken } =
      await loadGithubCopilotRuntime();
    const { githubToken, hasProfile } = await resolveFirstGithubToken({
      agentDir: ctx.agentDir,
      env: ctx.env,
      ...(ctx.config ? { config: ctx.config } : {}),
      ...(ctx.profileId ? { profileId: ctx.profileId } : {}),
      ...(ctx.authProfileMode ? { authProfileMode: ctx.authProfileMode } : {}),
    });
    if (!hasProfile && !githubToken) {
      return null;
    }
    let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
    let copilotApiToken: string | undefined;
    if (githubToken) {
      try {
        const token = await resolveCopilotApiToken({
          githubToken,
          env: ctx.env,
          githubDomain: resolveGithubCopilotDomain({ env: ctx.env, config: ctx.config }),
        });
        baseUrl = token.baseUrl;
        copilotApiToken = token.token;
      } catch {
        baseUrl = DEFAULT_COPILOT_API_BASE_URL;
      }
    }
    // Live metadata follows account entitlements and context limits. Static
    // manifest models remain the visible fallback when exchange or discovery fails.
    let discoveredModels: Awaited<ReturnType<typeof fetchCopilotModelCatalog>> = [];
    if (copilotApiToken) {
      try {
        discoveredModels = await getCachedLiveCatalogValue({
          keyParts: [PROVIDER_ID, "models", baseUrl, copilotApiToken],
          load: async () => await fetchCopilotModelCatalog({ copilotApiToken, baseUrl }),
        });
      } catch {
        discoveredModels = [];
      }
    }
    return { baseUrl, models: discoveredModels };
  }

  async function runCatalog(ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> {
    const catalog = await resolveCatalog(ctx);
    return catalog ? { provider: catalog } : null;
  }

  async function prepareDynamicModel(ctx: ProviderPrepareDynamicModelContext): Promise<void> {
    const catalog = await resolveCatalog({
      agentDir: ctx.agentDir,
      env: process.env,
      ...(ctx.config ? { config: ctx.config } : {}),
      ...(ctx.authProfileId ? { profileId: ctx.authProfileId } : {}),
      ...(ctx.authProfileMode ? { authProfileMode: ctx.authProfileMode } : {}),
    });
    const models = new Map<string, ProviderRuntimeModel>();
    if (catalog) {
      for (const model of catalog.models) {
        models.set(model.id, {
          ...model,
          provider: PROVIDER_ID,
          baseUrl: catalog.baseUrl,
        });
      }
    }
    let scopedModels = preparedDynamicModels.get(ctx.modelRegistry);
    if (!scopedModels) {
      scopedModels = new Map();
      preparedDynamicModels.set(ctx.modelRegistry, scopedModels);
    }
    scopedModels.set(dynamicModelScope(ctx.authProfileId, ctx.authProfileMode), models);
  }

  function resolveDynamicModel(ctx: ProviderResolveDynamicModelContext) {
    return (
      preparedDynamicModels
        .get(ctx.modelRegistry)
        ?.get(dynamicModelScope(ctx.authProfileId, ctx.authProfileMode))
        ?.get(ctx.modelId) ?? resolveCopilotForwardCompatModel(ctx)
    );
  }

  return {
    prepareDynamicModel,
    resolveDynamicModel,
    runCatalog,
    preferRuntimeResolvedModel: ({ config }: { config?: OpenClawConfig }) =>
      params.discoveryEnabled(config),
  };
}
