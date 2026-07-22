// Provider entry contracts define provider plugin hooks, model catalogs, and runtime adapters.
import type { UnifiedModelCatalogEntry } from "@openclaw/model-catalog-core/model-catalog-types";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "../../packages/normalization-core/src/string-normalization.js";
import { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
import { projectProviderCatalogResultToUnifiedTextRows } from "../plugins/provider-catalog-unified-text.js";
import type {
  ProviderPlugin,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderAuthMethod,
  ProviderPluginCatalog,
  UnifiedModelCatalogProviderContext,
  ProviderPluginWizardSetup,
} from "../plugins/types.js";
import {
  copyArrayEntries,
  isRecordWithoutThrowing,
  readRecordValue,
} from "../shared/safe-record.js";
import { definePluginEntry } from "./plugin-entry.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
} from "./plugin-entry.js";
import {
  buildOpenAICompatibleProviderCatalog,
  type OpenAICompatibleModelDiscoveryOptions,
} from "./provider-catalog-live-runtime.js";
import { buildSingleProviderApiKeyCatalog } from "./provider-catalog-shared.js";

type ApiKeyAuthMethodOptions = Parameters<typeof createProviderApiKeyAuthMethod>[0];

/**
 * API-key auth options for single-provider plugins, with provider id filled in by the entry helper.
 */
export type SingleProviderPluginApiKeyAuthOptions = Omit<
  ApiKeyAuthMethodOptions,
  "providerId" | "expectedProviders" | "wizard"
> & {
  /**
   * Provider ids this auth method is allowed to satisfy; defaults to the single
   * provider id declared by the plugin entry.
   */
  expectedProviders?: string[];
  /**
   * Wizard metadata for setup flows, or `false` when the method should be
   * registered without an onboarding choice.
   */
  wizard?: false | ProviderPluginWizardSetup;
};

/**
 * Catalog configuration accepted by the single-provider entry helper.
 */
export type SingleProviderPluginCatalogOptions =
  | {
      /**
       * Builds the live provider catalog through the shared API-key catalog path.
       */
      buildProvider: Parameters<typeof buildSingleProviderApiKeyCatalog>[0]["buildProvider"];
      /**
       * Builds a static catalog for cheap model discovery before credentials are resolved.
       */
      buildStaticProvider?: Parameters<typeof buildSingleProviderApiKeyCatalog>[0]["buildProvider"];
      /**
       * Allows operator-configured base URLs to override the provider catalog base URL.
       */
      allowExplicitBaseUrl?: boolean;
      /**
       * Discovers text/chat models from the provider's OpenAI-compatible model-list endpoint.
       */
      liveModelDiscovery?: true | OpenAICompatibleModelDiscoveryOptions;
      run?: never;
      order?: never;
      staticRun?: never;
    }
  | {
      /**
       * Runs a fully custom provider catalog implementation.
       */
      run: ProviderPluginCatalog["run"];
      /**
       * Optional static variant for custom catalog implementations.
       */
      staticRun?: ProviderPluginCatalog["run"];
      /**
       * Catalog ordering contract forwarded to the core provider registry.
       */
      order?: ProviderPluginCatalog["order"];
      buildProvider?: never;
      buildStaticProvider?: never;
      allowExplicitBaseUrl?: never;
      liveModelDiscovery?: never;
    };

/**
 * Defines one provider plugin plus optional extra registration hooks.
 */
export type SingleProviderPluginOptions = {
  /**
   * Plugin id and default provider id when `provider.id` is omitted.
   */
  id: string;
  /**
   * Display name registered for the plugin entry.
   */
  name: string;
  /**
   * Short plugin description surfaced by plugin registries and setup flows.
   */
  description: string;
  /**
   * @deprecated Declare exclusive plugin kind in `openclaw.plugin.json` via
   * manifest `kind`. Runtime-entry `kind` remains only as a compatibility
   * fallback for older plugins.
   */
  kind?: OpenClawPluginDefinition["kind"];
  /**
   * Optional plugin configuration schema or lazy schema factory.
   */
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  /**
   * Primary provider registration. Extra provider fields are forwarded after
   * the helper-owned id/auth/catalog fields are normalized.
   */
  provider?: {
    /**
     * Provider id override when the runtime provider id differs from the plugin id.
     */
    id?: string;
    /**
     * Human-readable provider label.
     */
    label: string;
    /**
     * Documentation route used by provider setup and diagnostics.
     */
    docsPath: string;
    /**
     * Alternate provider ids accepted by routing and configuration lookups.
     */
    aliases?: string[];
    /**
     * Explicit environment variables advertised for credentials.
     */
    envVars?: string[];
    /**
     * API-key auth methods converted through the shared provider auth helper.
     */
    auth?: SingleProviderPluginApiKeyAuthOptions[];
    /**
     * Non-API-key auth methods appended after generated API-key methods.
     */
    extraAuth?: ProviderAuthMethod[];
    /**
     * Live/static catalog implementation for this provider.
     */
    catalog: SingleProviderPluginCatalogOptions;
  } & Omit<
    ProviderPlugin,
    "id" | "label" | "docsPath" | "aliases" | "envVars" | "auth" | "catalog" | "staticCatalog"
  >;
  /**
   * Optional hook for registering companion capabilities with the same plugin entry.
   */
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

function copyProviderAuthOptions(value: unknown): SingleProviderPluginApiKeyAuthOptions[] {
  return copyArrayEntries(value).filter(
    isRecordWithoutThrowing,
  ) as SingleProviderPluginApiKeyAuthOptions[];
}

function copyProviderAuthMethods(value: unknown): ProviderAuthMethod[] {
  return copyArrayEntries(value).filter(isRecordWithoutThrowing) as ProviderAuthMethod[];
}

function resolveEnvVars(params: {
  envVars?: unknown;
  auth?: SingleProviderPluginApiKeyAuthOptions[];
}): string[] | undefined {
  const combined = normalizeStringEntries([
    ...copyArrayEntries(params.envVars),
    ...(params.auth ?? []).map((entry) => readRecordValue(entry, "envVar")).filter(Boolean),
  ]);
  return combined.length > 0 ? uniqueStrings(combined) : undefined;
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

/**
 * Builds a plugin entry for providers whose runtime exports exactly one primary model provider.
 */
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
        const providerAuth = copyProviderAuthOptions(provider.auth);
        const acceptedProviderAuth: SingleProviderPluginApiKeyAuthOptions[] = [];
        const auth = providerAuth.flatMap((entry) => {
          try {
            const { wizard: _wizard, ...authParams } = entry;
            const wizard = resolveWizardSetup({
              providerId,
              providerLabel: provider.label,
              auth: entry,
            });
            const method = createProviderApiKeyAuthMethod({
              ...authParams,
              providerId,
              expectedProviders: entry.expectedProviders ?? [providerId],
              ...(wizard ? { wizard } : {}),
            });
            acceptedProviderAuth.push(entry);
            return [method];
          } catch {
            // Fuzzed or partially unreadable auth rows should not prevent the
            // provider from registering its remaining healthy auth methods.
            return [];
          }
        });
        const envVars = resolveEnvVars({
          envVars: provider.envVars,
          auth: acceptedProviderAuth,
        });
        auth.push(...copyProviderAuthMethods(provider.extraAuth));
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
              provider.catalog.liveModelDiscovery
                ? buildOpenAICompatibleProviderCatalog({
                    ctx,
                    providerId,
                    buildProvider,
                    ...(provider.catalog.allowExplicitBaseUrl
                      ? { allowExplicitBaseUrl: true }
                      : {}),
                    ...(provider.catalog.liveModelDiscovery === true
                      ? {}
                      : { modelDiscovery: provider.catalog.liveModelDiscovery }),
                  })
                : buildSingleProviderApiKeyCatalog({
                    ctx,
                    providerId,
                    buildProvider,
                    ...(provider.catalog.allowExplicitBaseUrl
                      ? { allowExplicitBaseUrl: true }
                      : {}),
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
          // Preserve additional provider capabilities while keeping helper-owned
          // auth/catalog/id fields canonical.
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
                  "extraAuth",
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
