/** Builds isolated cron runner config from global defaults plus agent overrides. */
import type { resolveAgentConfig } from "../../agents/agent-scope.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../../config/config.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type ResolvedAgentConfig = NonNullable<ReturnType<typeof resolveAgentConfig>>;

/** Selects the active reloadable config when it descends from the cron caller's snapshot. */
export function resolveCronActiveRuntimeConfig(cfg: OpenClawConfig): OpenClawConfig {
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  if (!runtimeConfig || !runtimeSourceConfig) {
    return cfg;
  }
  return (
    selectApplicableRuntimeConfig({ inputConfig: cfg, runtimeConfig, runtimeSourceConfig }) ?? cfg
  );
}

function extractCronAgentDefaultsOverride(agentConfigOverride?: ResolvedAgentConfig) {
  const {
    model: overrideModel,
    sandbox: _agentSandboxOverride,
    memorySearch: _agentMemorySearchOverride,
    ...agentOverrideRest
  } = agentConfigOverride ?? {};
  return {
    overrideModel,
    definedOverrides: Object.fromEntries(
      Object.entries(agentOverrideRest).filter(([, value]) => value !== undefined),
    ) as Partial<AgentDefaultsConfig>,
  };
}

function mergeCronAgentModelOverride(params: {
  defaults: AgentDefaultsConfig;
  overrideModel: ResolvedAgentConfig["model"] | undefined;
}) {
  const nextDefaults: AgentDefaultsConfig = { ...params.defaults };
  const existingModel =
    nextDefaults.model && typeof nextDefaults.model === "object" ? nextDefaults.model : {};
  if (typeof params.overrideModel === "string") {
    nextDefaults.model = { ...existingModel, primary: params.overrideModel };
  } else if (params.overrideModel) {
    nextDefaults.model = { ...existingModel, ...params.overrideModel };
  }
  return nextDefaults;
}

/** Builds the agent defaults snapshot used by isolated cron runs. */
export function buildCronAgentDefaultsConfig(params: {
  defaults?: AgentDefaultsConfig;
  agentConfigOverride?: ResolvedAgentConfig;
}) {
  const { overrideModel, definedOverrides } = extractCronAgentDefaultsOverride(
    params.agentConfigOverride,
  );
  // Keep nested configs owned by agent-aware resolvers out of this flattened snapshot.
  // Copying a partial sandbox or memorySearch object into defaults destroys its global
  // fields before the resolver can merge the selected agent's override.
  // Model authorization likewise uses the unflattened config plus agent id; this
  // snapshot only carries the effective runtime metadata and explicit policy.
  return mergeCronAgentModelOverride({
    defaults: Object.assign({}, params.defaults, definedOverrides),
    overrideModel,
  });
}
