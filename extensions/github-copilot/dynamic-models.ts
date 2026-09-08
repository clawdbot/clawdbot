import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPrepareDynamicModelContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  LiveModelCatalogHttpError,
  runLiveProviderCatalog,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { getCachedLiveCatalogValue } from "openclaw/plugin-sdk/provider-catalog-shared";
import { resolveFirstGithubToken } from "./auth.js";
import { resolveGithubCopilotDomain } from "./domain.js";
import {
  PROVIDER_ID,
  fetchCopilotModelCatalog,
  isCopilotCatalogModelVisible,
  resolveCopilotForwardCompatModel,
} from "./models.js";
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";
import { buildCopilotRuntimeHeaders } from "./runtime-identity.js";

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

export function createGithubCopilotDynamicModelHooks(params: {
  discoveryEnabled(config?: OpenClawConfig): boolean;
}) {
  const preparedDynamicModels = new WeakMap<
    object,
    Map<string, ReadonlyMap<string, ProviderRuntimeModel>>
  >();

  async function resolveCatalogAuth(ctx: GithubCopilotCatalogContext) {
    if (!params.discoveryEnabled(ctx.config)) {
      return null;
    }
    const auth = await resolveFirstGithubToken(ctx);
    return auth.githubToken ? auth : null;
  }

  async function loadCatalog(
    ctx: GithubCopilotCatalogContext,
    auth: Awaited<ReturnType<typeof resolveFirstGithubToken>>,
    headers: ReturnType<typeof buildCopilotRuntimeHeaders>,
  ) {
    const { resolveCopilotRuntimeAuth } = await import("./register.runtime.js");
    const { apiKey: copilotApiToken, baseUrl } = await resolveCopilotRuntimeAuth({
      githubToken: auth.githubToken,
      env: ctx.env,
      githubDomain: resolveGithubCopilotDomain({
        env: ctx.env,
        explicit: auth.githubDomain,
        config: ctx.config,
      }),
    }).catch((error: unknown) => {
      if (error instanceof CopilotRuntimeAuthError && error.status !== undefined) {
        throw new LiveModelCatalogHttpError(PROVIDER_ID, error.status);
      }
      throw error;
    });
    const models = await getCachedLiveCatalogValue({
      keyParts: [
        PROVIDER_ID,
        "models",
        baseUrl,
        copilotApiToken,
        headers["Copilot-Integration-Id"],
      ],
      load: async () => await fetchCopilotModelCatalog({ copilotApiToken, baseUrl, headers }),
    });
    return { baseUrl, models };
  }

  async function runCatalog(ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> {
    const auth = await resolveCatalogAuth(ctx);
    if (!auth) {
      return null;
    }
    const headers = buildCopilotRuntimeHeaders({ config: ctx.config });
    return await runLiveProviderCatalog({
      providerId: PROVIDER_ID,
      profileId: auth.profileId,
      run: async () => {
        const catalog = await loadCatalog(ctx, auth, headers);
        return {
          provider: {
            ...catalog,
            models: catalog.models.filter(isCopilotCatalogModelVisible),
          },
        };
      },
    });
  }

  async function prepareDynamicModel(ctx: ProviderPrepareDynamicModelContext): Promise<void> {
    const catalogContext: GithubCopilotCatalogContext = {
      agentDir: ctx.agentDir,
      env: process.env,
      config: ctx.config,
      profileId: ctx.authProfileId,
      authProfileMode: ctx.authProfileMode,
    };
    const auth = await resolveCatalogAuth(catalogContext);
    // Request preparation can fall back to forward-compatible metadata without
    // claiming that live catalog discovery succeeded.
    const catalog = auth
      ? await loadCatalog(
          catalogContext,
          auth,
          buildCopilotRuntimeHeaders({ config: ctx.config }),
        ).catch(() => null)
      : null;
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
