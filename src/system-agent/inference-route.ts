// Resolves the configured default agent route shared by OpenClaw inference calls.
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  listAgentEntries,
  resolveSystemAgentTargetAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../agents/cli-execution-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { SYSTEM_AGENT_ID } from "./agent-id.js";

export type SystemAgentConfiguredRoute = {
  runConfig: OpenClawConfig;
  modelLabel: string;
  provider: string;
  model: string;
  agentDir: string;
  agentId: string;
  authProfileId?: string;
} & (
  | { runner: "cli" }
  | {
      runner: "embedded";
      agentHarnessRuntimeOverride?: string;
    }
);

export type SystemAgentConfiguredRouteDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  loadAuthProfileStoreForRuntime?: typeof import("../agents/auth-profiles/store.js").loadAuthProfileStoreForRuntime;
  pluginMetadataPlugins?: PluginMetadataSnapshot["plugins"];
};
type SystemAgentRouteProjectionDeps = Pick<
  SystemAgentConfiguredRouteDeps,
  "loadAuthProfileStoreForRuntime" | "pluginMetadataPlugins"
>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type DefaultInferenceRouteProjection = {
  route: DistributiveOmit<SystemAgentConfiguredRoute, "runConfig"> | null;
  defaultSelection: { explicitIds: string[]; fallbackId?: string };
  auth: unknown;
  models: unknown;
  defaults: unknown;
  agent?: unknown;
  executionAgent?: unknown;
  env: OpenClawConfig["env"];
  secrets: OpenClawConfig["secrets"];
  plugins: OpenClawConfig["plugins"];
  tools: OpenClawConfig["tools"];
};

function projectSystemAgentExecutionConfig(
  config: OpenClawConfig,
  routeAgentId: string,
): OpenClawConfig {
  const agents = listAgentEntries(config);
  const routeAgent = agents.find((agent) => normalizeAgentId(agent.id) === routeAgentId);
  const retainedAgents = agents.filter((agent) => normalizeAgentId(agent.id) !== SYSTEM_AGENT_ID);
  const projectedAgents = [
    ...retainedAgents,
    {
      id: SYSTEM_AGENT_ID,
      ...(routeAgent?.params !== undefined ? { params: structuredClone(routeAgent.params) } : {}),
      ...(routeAgent?.tools !== undefined ? { tools: structuredClone(routeAgent.tools) } : {}),
    },
  ];
  const { list: _legacyList, ...agentsConfig } = config.agents ?? {};
  return {
    ...config,
    agents: {
      ...agentsConfig,
      entries: toAgentEntriesRecord(projectedAgents),
    },
  };
}

export async function resolveSystemAgentConfiguredRouteFromConfig(
  runConfig: OpenClawConfig,
  requestedAgentId?: string,
  deps: SystemAgentRouteProjectionDeps = {},
): Promise<SystemAgentConfiguredRoute | null> {
  const [agentScope, modelSelection, modelRuntimeAliases, simpleCompletion, harnessPolicy] =
    await Promise.all([
      import("../agents/agent-scope.js"),
      import("../agents/model-selection.js"),
      import("../agents/model-runtime-aliases.js"),
      import("../agents/simple-completion-runtime.js"),
      import("../agents/harness/policy.js"),
    ]);
  const modelOwnerAgentId = resolveSystemAgentTargetAgentId(runConfig, requestedAgentId);
  if (!agentScope.resolveAgentEffectiveModelPrimary(runConfig, modelOwnerAgentId)) {
    return null;
  }
  const selection = simpleCompletion.resolveSimpleCompletionSelectionForAgent({
    cfg: runConfig,
    agentId: modelOwnerAgentId,
    manifestPlugins: deps.pluginMetadataPlugins,
  });
  if (!selection) {
    return null;
  }
  const metadataSnapshot = deps.pluginMetadataPlugins
    ? { plugins: deps.pluginMetadataPlugins }
    : undefined;
  const cliExecutionProvider = modelRuntimeAliases.resolveCliRuntimeExecutionProvider({
    provider: selection.provider,
    cfg: runConfig,
    agentId: modelOwnerAgentId,
    modelId: selection.modelId,
    ...(selection.profileId ? { authProfileId: selection.profileId } : {}),
    ...(metadataSnapshot ? { metadataSnapshot } : {}),
  });
  const executionProvider = cliExecutionProvider ?? selection.runtimeProvider ?? selection.provider;
  const isCliRoute = modelSelection.isCliProvider(executionProvider, runConfig);
  const allowCliAuthProfileForwarding =
    isCliRoute &&
    cliBackendAcceptsAuthProfileForwarding({
      provider: executionProvider,
      config: runConfig,
      agentId: modelOwnerAgentId,
    });
  const cliAuthProfileId = allowCliAuthProfileForwarding
    ? resolveCliExecutionAuthProfileId({
        cliExecutionProvider: executionProvider,
        authProfileProvider: selection.provider,
        config: runConfig,
        agentDir: selection.agentDir,
        ...(selection.profileId
          ? {
              selected: {
                authProfileId: selection.profileId,
                authProfileIdSource: "user",
              },
            }
          : {}),
        ...(deps.loadAuthProfileStoreForRuntime
          ? { loadAuthProfileStoreForRuntime: deps.loadAuthProfileStoreForRuntime }
          : {}),
      })
    : undefined;
  const authProfileId = allowCliAuthProfileForwarding ? cliAuthProfileId : selection.profileId;
  const executionConfig = projectSystemAgentExecutionConfig(runConfig, modelOwnerAgentId);
  const base = {
    runConfig: executionConfig,
    modelLabel: `${selection.provider}/${selection.modelId}`,
    provider: executionProvider,
    model: selection.modelId,
    agentDir: selection.agentDir,
    agentId: modelOwnerAgentId,
    ...(authProfileId ? { authProfileId } : {}),
  };
  if (isCliRoute) {
    return { runner: "cli", ...base };
  }
  const policy = harnessPolicy.resolveAgentHarnessPolicy({
    config: runConfig,
    agentId: modelOwnerAgentId,
    provider: selection.provider,
    modelId: selection.modelId,
  });
  return {
    runner: "embedded",
    ...(policy.runtimeSource === "implicit" ? {} : { agentHarnessRuntimeOverride: policy.runtime }),
    ...base,
  };
}

function projectRelevantModelMap(params: {
  models: Record<string, { alias?: string }> | undefined;
  providerIds: Set<string>;
  modelId: string | undefined;
  rawModel: string | undefined;
}): Record<string, unknown> | undefined {
  if (!params.models) {
    return undefined;
  }
  const relevant = Object.fromEntries(
    Object.entries(params.models).filter(([key, entry]) => {
      const slash = key.indexOf("/");
      const provider = slash > 0 ? normalizeProviderId(key.slice(0, slash)) : "";
      const model = slash > 0 ? key.slice(slash + 1) : key;
      return (
        (params.providerIds.has(provider) &&
          (model === params.modelId || model === "*" || key === params.rawModel)) ||
        entry.alias?.trim() === params.rawModel
      );
    }),
  );
  return Object.keys(relevant).length > 0 ? relevant : undefined;
}

/** Project every config input that can change the configured default-agent route. */
export async function projectDefaultInferenceRoute(
  config: OpenClawConfig,
  deps: SystemAgentRouteProjectionDeps = {},
): Promise<DefaultInferenceRouteProjection> {
  return await projectInferenceRoute(config, undefined, deps);
}

/** Project every config input that can change one configured agent route. */
export async function projectInferenceRoute(
  config: OpenClawConfig,
  requestedAgentId?: string,
  deps: SystemAgentRouteProjectionDeps = {},
): Promise<DefaultInferenceRouteProjection> {
  const { resolveProviderIdForAuth } = await import("../agents/provider-auth-aliases.js");
  const routeAgentId = resolveSystemAgentTargetAgentId(config, requestedAgentId);
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config, routeAgentId, deps);
  const list = listAgentEntries(config);
  const agent = list.find((entry) => normalizeAgentId(entry.id) === routeAgentId);
  const executionAgent = listAgentEntries(route?.runConfig ?? {}).find(
    (entry) => normalizeAgentId(entry.id) === SYSTEM_AGENT_ID,
  );
  const defaults = config.agents?.defaults;
  const logicalProvider = normalizeProviderId(route?.modelLabel.split("/", 1)[0] ?? "");
  const providerIds = new Set(
    [logicalProvider, normalizeProviderId(route?.provider ?? "")].filter(Boolean),
  );
  const metadataSnapshot = deps.pluginMetadataPlugins
    ? { plugins: deps.pluginMetadataPlugins }
    : undefined;
  const authAliasParams = {
    config,
    ...(metadataSnapshot ? { metadataSnapshot } : {}),
  };
  const authProviderIds = new Set(
    [...providerIds].map((provider) => resolveProviderIdForAuth(provider, authAliasParams)),
  );
  const authProfiles = Object.fromEntries(
    Object.entries(config.auth?.profiles ?? {}).filter(([, profile]) =>
      authProviderIds.has(resolveProviderIdForAuth(profile.provider, authAliasParams)),
    ),
  );
  const authOrder = Object.fromEntries(
    Object.entries(config.auth?.order ?? {}).filter(([provider]) =>
      authProviderIds.has(resolveProviderIdForAuth(provider, authAliasParams)),
    ),
  );
  const modelProviders = Object.fromEntries(
    Object.entries(config.models?.providers ?? {})
      .filter(([provider]) => providerIds.has(normalizeProviderId(provider)))
      // Provider model arrays are replaced as a unit by config patches. Keep
      // the whole active provider so concurrent catalog additions cannot be
      // silently erased, including hierarchical model ids.
      .map(([provider, providerConfig]) => [provider, structuredClone(providerConfig)]),
  );
  const rawModel =
    typeof agent?.model === "string"
      ? agent.model
      : agent?.model?.primary ||
        (typeof defaults?.model === "string" ? defaults.model : defaults?.model?.primary);
  let projectedRoute: DefaultInferenceRouteProjection["route"] = null;
  if (route) {
    const { runConfig: _runConfig, ...routeWithoutConfig } = route;
    projectedRoute = routeWithoutConfig;
  }
  return {
    route: projectedRoute,
    defaultSelection: {
      explicitIds: [routeAgentId],
    },
    auth: {
      profiles: authProfiles,
      order: authOrder,
    },
    models: {
      mode: config.models?.mode,
      providers: modelProviders,
    },
    defaults: {
      model: structuredClone(defaults?.model),
      params: structuredClone(defaults?.params),
      models: projectRelevantModelMap({
        models: defaults?.models,
        providerIds,
        modelId: route?.model,
        rawModel,
      }),
      agentRuntime: structuredClone(defaults?.agentRuntime),
    },
    ...(agent
      ? {
          agent: {
            id: normalizeAgentId(agent.id),
            agentDir: agent.agentDir,
            model: structuredClone(agent.model),
            params: structuredClone(agent.params),
            tools: structuredClone(agent.tools),
            models: projectRelevantModelMap({
              models: agent.models,
              providerIds,
              modelId: route?.model,
              rawModel,
            }),
            agentRuntime: structuredClone(agent.agentRuntime),
          },
        }
      : {}),
    ...(executionAgent
      ? {
          executionAgent: {
            id: SYSTEM_AGENT_ID,
            params: structuredClone(executionAgent.params),
            tools: structuredClone(executionAgent.tools),
          },
        }
      : {}),
    env: structuredClone(config.env),
    secrets: structuredClone(config.secrets),
    plugins: structuredClone(config.plugins),
    tools: structuredClone(config.tools),
  };
}

export function sameDefaultInferenceRoute(
  left: DefaultInferenceRouteProjection,
  right: DefaultInferenceRouteProjection,
): boolean {
  return isDeepStrictEqual(left, right);
}
