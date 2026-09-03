import type { AgentHarnessModelCatalogParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { readCodexPluginConfig } from "./config-parsing.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import { buildCodexRuntimeModelParams } from "./model-runtime.js";
import { listAllCodexAppServerModels, type CodexAppServerModel } from "./models.js";
import { withCodexAppServerJsonClient } from "./request.js";

// Manifest contract (openclaw.plugin.json discovery.timeoutMs default): live model
// discovery is bounded tightly so a wedged app-server degrades to the static catalog.
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 2500;
type ModelInputType = NonNullable<ModelCatalogEntry["input"]>[number];
const INPUT_TYPES: ReadonlySet<string> = new Set(["text", "image", "audio", "video", "document"]);

function isModelInputType(value: string): value is ModelInputType {
  return INPUT_TYPES.has(value);
}

function codexAppServerModelsToCatalogEntries(
  models: readonly CodexAppServerModel[],
  runtime: string,
): ModelCatalogEntry[] {
  return models.map((model, providerOrder) => {
    const input = model.inputModalities.filter(isModelInputType);
    const runtimeParams = buildCodexRuntimeModelParams(model.id, model.model);
    return {
      provider: "openai",
      id: model.id,
      name: model.displayName ?? model.id,
      providerOrder,
      nativeRuntime: runtime,
      reasoning: model.supportedReasoningEfforts.length > 0,
      ...(input.length > 0 ? { input } : {}),
      ...(runtimeParams ? { params: runtimeParams } : {}),
      compat: {
        supportsReasoningEffort: model.supportedReasoningEfforts.length > 0,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
      },
    };
  });
}

/** One harness registration owns its observations; none travel with worker snapshots. */
export function createCodexAppServerModelCatalog(runtime: string) {
  let disposed = false;
  return {
    dispose() {
      disposed = true;
    },
    async load(
      params: AgentHarnessModelCatalogParams,
      pluginConfig: unknown,
    ): Promise<ModelCatalogEntry[]> {
      if (disposed) {
        return [];
      }
      const discovery = readCodexPluginConfig(pluginConfig).discovery;
      if (discovery?.enabled === false) {
        return [];
      }
      const { start } = resolveCodexAppServerRuntimeOptions({
        pluginConfig,
        nativeAuth: params.runtime === "codex",
      });
      const timeoutMs = discovery?.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
      const result = await withCodexAppServerJsonClient(
        { startOptions: start, config: params.config, agentDir: params.agentDir, timeoutMs },
        async (request) => {
          const listed = await listAllCodexAppServerModels({
            request,
            limit: 100,
            includeHidden: true,
          });
          const models = listed.models.filter(
            (model) =>
              !model.hidden ||
              params.configuredModelRefs?.some(
                (ref) => ref.provider === "openai" && ref.model === model.id,
              ),
          );
          await request({
            method: "account/read",
            requestParams: { refreshToken: false },
          });
          return { models } as const;
        },
      );
      if (disposed) {
        return [];
      }
      return codexAppServerModelsToCatalogEntries(result.models, runtime);
    },
  };
}
