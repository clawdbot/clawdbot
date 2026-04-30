import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import {
  buildConfiguredModelCatalog,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { normalizeThinkLevel, resolveThinkingProfile } from "../../auto-reply/thinking.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionFilePath, resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore, saveSessionStore } from "../../config/sessions/store.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { defineCachedValue } from "./runtime-cache.js";
import type { PluginRuntime } from "./types.js";

const loadEmbeddedPiRuntime = createLazyRuntimeModule(
  () => import("./runtime-embedded-pi.runtime.js"),
);

function resolveRuntimeThinkingCatalog(
  params: Parameters<PluginRuntime["agent"]["resolveThinkingPolicy"]>[0],
) {
  if (params.catalog) {
    return params.catalog;
  }
  const configuredCatalog = buildConfiguredModelCatalog({ cfg: getRuntimeConfig() });
  return configuredCatalog.length > 0 ? configuredCatalog : undefined;
}

export function createRuntimeAgent(): PluginRuntime["agent"] {
  const agentRuntime = {
    defaults: {
      model: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
    },
    resolveAgentDir,
    resolveAgentWorkspaceDir,
    resolveAgentIdentity,
    resolveThinkingDefault,
    normalizeThinkingLevel: normalizeThinkLevel,
    resolveThinkingPolicy: (params) => {
      const profile = resolveThinkingProfile({
        ...params,
        catalog: resolveRuntimeThinkingCatalog(params),
      });
      const policy: Omit<
        ReturnType<PluginRuntime["agent"]["resolveThinkingPolicy"]>,
        "defaultLevel"
      > = {
        levels: profile.levels.map(({ id, label }) => ({ id, label })),
      };
      return profile.defaultLevel ? { ...policy, defaultLevel: profile.defaultLevel } : policy;
    },
    resolveAgentTimeoutMs,
    ensureAgentWorkspace,
  } satisfies Omit<PluginRuntime["agent"], "runEmbeddedAgent" | "runEmbeddedPiAgent" | "session"> &
    Partial<Pick<PluginRuntime["agent"], "runEmbeddedAgent" | "runEmbeddedPiAgent" | "session">>;

  defineCachedValue(agentRuntime, "runEmbeddedAgent", () =>
    createLazyRuntimeMethod(loadEmbeddedPiRuntime, (runtime) => runtime.runEmbeddedAgent),
  );
  defineCachedValue(agentRuntime, "runEmbeddedPiAgent", () =>
    createLazyRuntimeMethod(loadEmbeddedPiRuntime, (runtime) => runtime.runEmbeddedPiAgent),
  );
  defineCachedValue(agentRuntime, "session", () => ({
    resolveStorePath,
    loadSessionStore,
    saveSessionStore,
    resolveSessionFilePath,
  }));

  return agentRuntime as PluginRuntime["agent"];
}
