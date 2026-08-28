import type { AgentHarnessModelCatalogParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { readCodexPluginConfig } from "./config-parsing.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import { buildCodexRuntimeModelParams } from "./model-runtime.js";
import { listAllCodexAppServerModels, type CodexAppServerModel } from "./models.js";
import { isJsonObject, type CodexGetAccountResponse } from "./protocol.js";
import { withCodexAppServerJsonClient } from "./request.js";
import { captureSharedCodexAppServerCatalogLifetime } from "./shared-client.js";

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
  type Observation = {
    pluginConfig: unknown;
    models?: ReadonlySet<string>;
    accountType?: "apiKey" | "chatgpt";
    isCurrent?: () => boolean;
  };
  const scopes = new WeakMap<AgentHarnessModelCatalogParams["config"], Map<string, Observation>>();
  const scopeKey = (params: AgentHarnessModelCatalogParams) =>
    JSON.stringify([params.agentId, params.agentDir, params.workspaceDir]);
  let disposed = false;
  return {
    dispose() {
      disposed = true;
    },
    read(
      params: AgentHarnessModelCatalogParams & { provider: string; modelId: string },
      pluginConfig: unknown,
    ) {
      const observation = scopes.get(params.config)?.get(scopeKey(params));
      return !disposed &&
        params.provider === "openai" &&
        observation !== undefined &&
        observation.pluginConfig === pluginConfig &&
        observation.models?.has(params.modelId) &&
        observation.accountType &&
        observation.isCurrent?.()
        ? { accountType: observation.accountType }
        : undefined;
    },
    async load(
      params: AgentHarnessModelCatalogParams,
      pluginConfig: unknown,
    ): Promise<ModelCatalogEntry[]> {
      if (disposed) {
        return [];
      }
      let observations = scopes.get(params.config);
      if (!observations) {
        observations = new Map();
        scopes.set(params.config, observations);
      }
      const key = scopeKey(params);
      const observation: Observation = { pluginConfig };
      // Revoke before any await, including failed/disabled refreshes and superseded reads.
      observations.set(key, observation);
      const discovery = readCodexPluginConfig(pluginConfig).discovery;
      if (discovery?.enabled === false) {
        return [];
      }
      const { start } = resolveCodexAppServerRuntimeOptions({ pluginConfig });
      const timeoutMs = discovery?.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
      const result = await withCodexAppServerJsonClient(
        { startOptions: start, config: params.config, agentDir: params.agentDir, timeoutMs },
        async (request, client) => {
          const isCurrent = captureSharedCodexAppServerCatalogLifetime(client);
          const listed = await listAllCodexAppServerModels({ request, limit: 100 });
          const account = await request<CodexGetAccountResponse>({
            method: "account/read",
            requestParams: { refreshToken: false },
          });
          const observedType = isJsonObject(account.account) ? account.account.type : undefined;
          const accountType =
            account.requiresOpenaiAuth === true
              ? observedType === "apiKey" || observedType === "chatgpt"
                ? observedType
                : undefined
              : undefined;
          return { models: listed.models, isCurrent, accountType } as const;
        },
      );
      // Publish only after the bounded operation settles; a late timed-out callback cannot publish.
      if (disposed || observations.get(key) !== observation || !result.isCurrent()) {
        return [];
      }
      observation.models = new Set(result.models.map((model) => model.id));
      observation.accountType = result.accountType;
      observation.isCurrent = result.isCurrent;
      return codexAppServerModelsToCatalogEntries(result.models, runtime);
    },
  };
}
