import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import "./models-config.plan.js";
import type { PreparedModelsConfigContext } from "./models-config.plan.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

type ResolveImplicitProvidersForModelsJson = (params: {
  agentDir: string;
  config: OpenClawConfig;
  discoveryAuthConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  explicitProviders: Record<string, ProviderConfig>;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
}) => Promise<Record<string, ProviderConfig>>;

type PreparedPlanParams = Parameters<
  typeof import("./models-config.plan.js").planOpenClawModelsJson
>[0];
type FlatPreparedContext = Omit<
  PreparedModelsConfigContext,
  "discoveryAuthConfig" | "sourceConfigForSecrets" | "envFingerprint"
> & {
  discoveryAuthConfig?: OpenClawConfig;
  sourceConfigForSecrets?: OpenClawConfig;
};
type PlanParams = Omit<PreparedPlanParams, "context"> & FlatPreparedContext;
type PlanResult = Awaited<
  ReturnType<typeof import("./models-config.plan.js").planOpenClawModelsJson>
>;
type ResolveProvidersParams = FlatPreparedContext & { authStore?: PreparedPlanParams["authStore"] };
type PlanDeps = { resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson };

type ModelsConfigPlanTestApi = {
  planOpenClawModelsJsonWithDeps(params: PreparedPlanParams, deps?: PlanDeps): Promise<PlanResult>;
  resolveProvidersForModelsJsonWithDeps(
    params: Pick<PreparedPlanParams, "context" | "authStore">,
    deps?: PlanDeps,
  ): Promise<Record<string, ProviderConfig>>;
};

function getTestApi(): ModelsConfigPlanTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.modelsConfigPlanTestApi")
  ] as ModelsConfigPlanTestApi;
}

function prepareTestContext(params: FlatPreparedContext): PreparedModelsConfigContext {
  return {
    ...params,
    discoveryAuthConfig: params.discoveryAuthConfig ?? params.cfg,
    sourceConfigForSecrets: params.sourceConfigForSecrets ?? params.cfg,
    envFingerprint: params.env,
  };
}

export const planOpenClawModelsJsonWithDeps = async (
  params: PlanParams,
  deps?: PlanDeps,
): Promise<PlanResult> => {
  const { authStore, existingRaw, existingParsed, ...contextParams } = params;
  return await getTestApi().planOpenClawModelsJsonWithDeps(
    {
      context: prepareTestContext(contextParams),
      ...(authStore ? { authStore } : {}),
      existingRaw,
      existingParsed,
    },
    deps,
  );
};

export const resolveProvidersForModelsJsonWithDeps = async (
  params: ResolveProvidersParams,
  deps?: PlanDeps,
): Promise<Record<string, ProviderConfig>> => {
  const { authStore, ...contextParams } = params;
  return await getTestApi().resolveProvidersForModelsJsonWithDeps(
    {
      context: prepareTestContext(contextParams),
      ...(authStore ? { authStore } : {}),
    },
    deps,
  );
};
