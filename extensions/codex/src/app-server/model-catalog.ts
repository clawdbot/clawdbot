import type { AgentHarnessModelCatalogParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { requestOptions } from "../command-rpc.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import { listAllCodexAppServerModels, type CodexAppServerModel } from "./models.js";

const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
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
): ModelCatalogEntry[] {
  return models.map((model, providerOrder) => {
    const input = model.inputModalities.filter(isModelInputType);
    return {
      provider: "openai",
      id: model.model,
      name: model.displayName ?? model.model,
      providerOrder,
      api: "openai-chatgpt-responses",
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: model.supportedReasoningEfforts.length > 0,
      ...(input.length > 0 ? { input } : {}),
      ...(model.supportedReasoningEfforts.length > 0
        ? {
            compat: {
              supportsReasoningEffort: true,
              supportedReasoningEfforts: model.supportedReasoningEfforts,
            },
          }
        : {}),
    };
  });
}

export async function loadCodexAppServerModelCatalog(
  params: AgentHarnessModelCatalogParams,
  pluginConfig: unknown,
): Promise<ModelCatalogEntry[]> {
  const discovery = readCodexPluginConfig(pluginConfig).discovery;
  if (discovery?.enabled === false) {
    // Disabled discovery keeps the harness on the bundled static catalog (manifest contract).
    return [];
  }
  const options = requestOptions(pluginConfig, 100, params.config, params.agentDir);
  const result = await listAllCodexAppServerModels({
    ...options,
    timeoutMs: discovery?.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
  });
  return codexAppServerModelsToCatalogEntries(result.models);
}
