// Resolves the configured default agent route shared by Crestodian inference calls.
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../agents/cli-execution-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type CrestodianConfiguredRoute = {
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
      agentHarnessRuntimeOverride: string;
    }
);

export type CrestodianConfiguredRouteDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type DefaultInferenceRouteProjection = {
  route: DistributiveOmit<CrestodianConfiguredRoute, "runConfig"> | null;
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

const CRESTODIAN_EXECUTION_AGENT_ID = "crestodian";

function projectCrestodianExecutionConfig(
  config: OpenClawConfig,
  routeAgentId: string,
): OpenClawConfig {
  const agents = config.agents?.list;
  if (!agents) {
    return config;
  }
  const routeAgent =
    routeAgentId === CRESTODIAN_EXECUTION_AGENT_ID
      ? undefined
      : agents.find((agent) => normalizeAgentId(agent.id) === routeAgentId);
  const retainedAgents = agents.filter(
    (agent) => normalizeAgentId(agent.id) !== CRESTODIAN_EXECUTION_AGENT_ID,
  );
  const hasProjectedSettings = routeAgent?.params !== undefined || routeAgent?.tools !== undefined;
  if (retainedAgents.length === agents.length && !hasProjectedSettings) {
    return config;
  }
  return {
    ...config,
    agents: {
      ...config.agents,
      list: [
        ...retainedAgents,
        ...(hasProjectedSettings
          ? [
              {
                id: CRESTODIAN_EXECUTION_AGENT_ID,
                ...(routeAgent?.params !== undefined
                  ? { params: structuredClone(routeAgent.params) }
                  : {}),
                ...(routeAgent?.tools !== undefined
                  ? { tools: structuredClone(routeAgent.tools) }
                  : {}),
              },
            ]
          : []),
      ],
    },
  };
}

/** Return the authored default-agent route; never synthesize the product fallback model. */
export async function resolveCrestodianConfiguredRoute(
  deps: CrestodianConfiguredRouteDeps = {},
): Promise<CrestodianConfiguredRoute | null> {
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    return null;
  }
  const runConfig = snapshot.runtimeConfig ?? snapshot.config ?? {};
  return await resolveCrestodianConfiguredRouteFromConfig(runConfig);
}

export async function resolveCrestodianConfiguredRouteFromConfig(
  runConfig: OpenClawConfig,
): Promise<CrestodianConfiguredRoute | null> {
  const [agentScope, modelSelection, modelRuntimeAliases, simpleCompletion, harnessPolicy] =
    await Promise.all([
      import("../agents/agent-scope.js"),
      import("../agents/model-selection.js"),
      import("../agents/model-runtime-aliases.js"),
      import("../agents/simple-completion-runtime.js"),
      import("../agents/harness/policy.js"),
    ]);
  const modelOwnerAgentId = agentScope.resolveDefaultAgentId(runConfig);
  if (!agentScope.resolveAgentEffectiveModelPrimary(runConfig, modelOwnerAgentId)) {
    return null;
  }
  const selection = simpleCompletion.resolveSimpleCompletionSelectionForAgent({
    cfg: runConfig,
    agentId: modelOwnerAgentId,
  });
  if (!selection) {
    return null;
  }
  const cliExecutionProvider = modelRuntimeAliases.resolveCliRuntimeExecutionProvider({
    provider: selection.provider,
    cfg: runConfig,
    agentId: modelOwnerAgentId,
    modelId: selection.modelId,
    ...(selection.profileId ? { authProfileId: selection.profileId } : {}),
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
      })
    : undefined;
  const authProfileId = allowCliAuthProfileForwarding ? cliAuthProfileId : selection.profileId;
  const executionConfig = projectCrestodianExecutionConfig(runConfig, modelOwnerAgentId);
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
  const runtime = harnessPolicy.resolveAgentHarnessPolicy({
    config: runConfig,
    agentId: modelOwnerAgentId,
    provider: selection.provider,
    modelId: selection.modelId,
  }).runtime;
  return { runner: "embedded", agentHarnessRuntimeOverride: runtime, ...base };
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
): Promise<DefaultInferenceRouteProjection> {
  const [{ resolveDefaultAgentId }, { resolveProviderIdForAuth }] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../agents/provider-auth-aliases.js"),
  ]);
  const defaultAgentId = resolveDefaultAgentId(config);
  const route = await resolveCrestodianConfiguredRouteFromConfig(config);
  const list = config.agents?.list ?? [];
  const agent = list.find((entry) => normalizeAgentId(entry.id) === defaultAgentId);
  const executionAgent = route?.runConfig.agents?.list?.find(
    (entry) => normalizeAgentId(entry.id) === CRESTODIAN_EXECUTION_AGENT_ID,
  );
  const defaults = config.agents?.defaults;
  const logicalProvider = normalizeProviderId(route?.modelLabel.split("/", 1)[0] ?? "");
  const providerIds = new Set(
    [logicalProvider, normalizeProviderId(route?.provider ?? "")].filter(Boolean),
  );
  const authProviderIds = new Set(
    [...providerIds].map((provider) => resolveProviderIdForAuth(provider, { config })),
  );
  const authProfiles = Object.fromEntries(
    Object.entries(config.auth?.profiles ?? {}).filter(([, profile]) =>
      authProviderIds.has(resolveProviderIdForAuth(profile.provider, { config })),
    ),
  );
  const authOrder = Object.fromEntries(
    Object.entries(config.auth?.order ?? {}).filter(([provider]) =>
      authProviderIds.has(resolveProviderIdForAuth(provider, { config })),
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
  const explicitDefaultIds = list
    .filter((entry) => entry.default)
    .map((entry) => normalizeAgentId(entry.id));
  return {
    route: projectedRoute,
    defaultSelection: {
      explicitIds: explicitDefaultIds,
      ...(explicitDefaultIds.length === 0 && list[0]?.id
        ? { fallbackId: normalizeAgentId(list[0].id) }
        : {}),
    },
    auth: {
      profiles: authProfiles,
      order: authOrder,
      cooldowns: structuredClone(config.auth?.cooldowns),
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
      cliBackends: Object.fromEntries(
        Object.entries(defaults?.cliBackends ?? {}).filter(([provider]) =>
          providerIds.has(normalizeProviderId(provider)),
        ),
      ),
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
            id: CRESTODIAN_EXECUTION_AGENT_ID,
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
