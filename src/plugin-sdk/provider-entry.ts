import type { UnifiedModelCatalogEntry } from "../model-catalog/types.js";
import { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
import type {
  ProviderPlugin,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPluginCatalog,
  UnifiedModelCatalogProviderContext,
  ProviderPluginWizardSetup,
} from "../plugins/types.js";
import { definePluginEntry } from "./plugin-entry.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
} from "./plugin-entry.js";
import { buildSingleProviderApiKeyCatalog } from "./provider-catalog-shared.js";

type ApiKeyAuthMethodOptions = Parameters<typeof createProviderApiKeyAuthMethod>[0];

export type SingleProviderPluginApiKeyAuthOptions = Omit<
  ApiKeyAuthMethodOptions,
  "providerId" | "expectedProviders" | "wizard"
> & {
  expectedProviders?: string[];
  wizard?: false | ProviderPluginWizardSetup;
};

export type SingleProviderPluginCatalogOptions =
  | {
      buildProvider: Parameters<typeof buildSingleProviderApiKeyCatalog>[0]["buildProvider"];
      buildStaticProvider?: Parameters<typeof buildSingleProviderApiKeyCatalog>[0]["buildProvider"];
      allowExplicitBaseUrl?: boolean;
      run?: never;
      order?: never;
      staticRun?: never;
    }
  | {
      run: ProviderPluginCatalog["run"];
      staticRun?: ProviderPluginCatalog["run"];
      order?: ProviderPluginCatalog["order"];
      buildProvider?: never;
      buildStaticProvider?: never;
      allowExplicitBaseUrl?: never;
    };

export type SingleProviderPluginOptions = {
  id: string;
  name: string;
  description: string;
  /**
   * @deprecated Declare exclusive plugin kind in `openclaw.plugin.json` via
   * manifest `kind`. Runtime-entry `kind` remains only as a compatibility
   * fallback for older plugins.
   */
  kind?: OpenClawPluginDefinition["kind"];
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  provider?: {
    id?: string;
    label: string;
    docsPath: string;
    aliases?: string[];
    envVars?: string[];
    auth?: SingleProviderPluginApiKeyAuthOptions[];
    catalog: SingleProviderPluginCatalogOptions;
  } & Omit<
    ProviderPlugin,
    "id" | "label" | "docsPath" | "aliases" | "envVars" | "auth" | "catalog" | "staticCatalog"
  >;
  register?: (api: OpenClawPluginApi) => void;
};

function resolveWizardSetup(params: {
  providerId: string;
  providerLabel: string;
  auth: SingleProviderPluginApiKeyAuthOptions;
}): ProviderPluginWizardSetup | undefined {
  if (params.auth.wizard === false) {
    return undefined;
  }
  const wizard = params.auth.wizard ?? {};
  const methodId = params.auth.methodId.trim();
  return {
    choiceId: wizard.choiceId ?? `${params.providerId}-${methodId}`,
    choiceLabel: wizard.choiceLabel ?? params.auth.label,
    ...(wizard.choiceHint ? { choiceHint: wizard.choiceHint } : {}),
    groupId: wizard.groupId ?? params.providerId,
    groupLabel: wizard.groupLabel ?? params.providerLabel,
    ...((wizard.groupHint ?? params.auth.hint)
      ? { groupHint: wizard.groupHint ?? params.auth.hint }
      : {}),
    methodId,
    ...(wizard.onboardingScopes ? { onboardingScopes: wizard.onboardingScopes } : {}),
    ...(wizard.modelAllowlist ? { modelAllowlist: wizard.modelAllowlist } : {}),
  };
}

function resolveEnvVars(params: {
  envVars?: string[];
  auth?: SingleProviderPluginApiKeyAuthOptions[];
}): string[] | undefined {
  const combined = [
    ...(params.envVars ?? []),
    ...(params.auth ?? []).map((entry) => entry.envVar).filter(Boolean),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return combined.length > 0 ? [...new Set(combined)] : undefined;
}

function projectProviderCatalogResultToUnifiedTextRows(params: {
  providerId: string;
  result: ProviderCatalogResult;
  source: UnifiedModelCatalogEntry["source"];
}): UnifiedModelCatalogEntry[] {
  if (!params.result) {
    return [];
  }
  const providers =
    "provider" in params.result
      ? { [params.providerId]: params.result.provider }
      : params.result.providers;
  const rows: UnifiedModelCatalogEntry[] = [];
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    for (const model of providerConfig.models ?? []) {
      rows.push({
        kind: "text",
        provider: providerId,
        model: model.id,
        ...(model.name ? { label: model.name } : {}),
        source: params.source,
      });
    }
  }
  return rows;
}

async function runUnifiedTextCatalog(params: {
  providerId: string;
  catalog: ProviderPluginCatalog;
  ctx: UnifiedModelCatalogProviderContext;
  source: UnifiedModelCatalogEntry["source"];
}): Promise<UnifiedModelCatalogEntry[]> {
  const result = await params.catalog.run(params.ctx);
  return projectProviderCatalogResultToUnifiedTextRows({
    providerId: params.providerId,
    result,
    source: params.source,
  });
}

export function defineSingleProviderPluginEntry(options: SingleProviderPluginOptions) {
  return definePluginEntry({
    id: options.id,
    name: options.name,
    description: options.description,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.configSchema ? { configSchema: options.configSchema } : {}),
    register(api) {
      const provider = options.provider;
      if (provider) {
        const providerId = provider.id ?? options.id;
        const envVars = resolveEnvVars({
          envVars: provider.envVars,
          auth: provider.auth,
        });
        const auth = (provider.auth ?? []).map((entry) => {
          const { wizard: _wizard, ...authParams } = entry;
          const wizard = resolveWizardSetup({
            providerId,
            providerLabel: provider.label,
            auth: entry,
          });
          return createProviderApiKeyAuthMethod({
            ...authParams,
            providerId,
            expectedProviders: entry.expectedProviders ?? [providerId],
            ...(wizard ? { wizard } : {}),
          });
        });
        let catalog: ProviderPluginCatalog;
        if ("run" in provider.catalog) {
          const catalogRun = provider.catalog.run;
          catalog = {
            order: provider.catalog.order ?? "simple",
            run: catalogRun!,
          };
        } else {
          const buildProvider = provider.catalog.buildProvider;
          catalog = {
            order: "simple",
            run: (ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> =>
              buildSingleProviderApiKeyCatalog({
                ctx,
                providerId,
                buildProvider,
                ...(provider.catalog.allowExplicitBaseUrl ? { allowExplicitBaseUrl: true } : {}),
              }),
          };
        }
        const staticCatalog: ProviderPluginCatalog | undefined =
          "run" in provider.catalog
            ? provider.catalog.staticRun
              ? {
                  order: provider.catalog.order ?? "simple",
                  run: provider.catalog.staticRun,
                }
              : undefined
            : provider.catalog.buildStaticProvider
              ? {
                  order: "simple",
                  run: async () => ({
                    provider: await provider.catalog.buildStaticProvider!(),
                  }),
                }
              : undefined;
        api.registerProvider({
          id: providerId,
          label: provider.label,
          docsPath: provider.docsPath,
          ...(provider.aliases ? { aliases: provider.aliases } : {}),
          ...(envVars ? { envVars } : {}),
          auth,
          catalog,
          ...(staticCatalog ? { staticCatalog } : {}),
          ...Object.fromEntries(
            Object.entries(provider).filter(
              ([key]) =>
                ![
                  "id",
                  "label",
                  "docsPath",
                  "aliases",
                  "envVars",
                  "auth",
                  "catalog",
                  "staticCatalog",
                ].includes(key),
            ),
          ),
        });
        api.registerModelCatalogProvider({
          provider: providerId,
          kinds: ["text"],
          ...(staticCatalog
            ? {
                staticCatalog: (ctx: UnifiedModelCatalogProviderContext) =>
                  runUnifiedTextCatalog({
                    providerId,
                    catalog: staticCatalog,
                    ctx,
                    source: "static",
                  }),
              }
            : {}),
          liveCatalog: (ctx: UnifiedModelCatalogProviderContext) =>
            runUnifiedTextCatalog({
              providerId,
              catalog,
              ctx,
              source: "live",
            }),
        });
      }
      options.register?.(api);
    },
  });
}
