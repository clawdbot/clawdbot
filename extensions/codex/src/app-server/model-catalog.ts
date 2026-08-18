import type { AgentHarnessModelCatalogParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { requestOptions } from "../command-rpc.js";
import {
  listAllCodexAppServerModels,
  type CodexAppServerModel,
  type CodexAppServerModelListResult,
} from "./models.js";

const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
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
  listModels: (
    options: ReturnType<typeof requestOptions>,
  ) => Promise<CodexAppServerModelListResult> = listAllCodexAppServerModels,
): Promise<ModelCatalogEntry[]> {
  const options = requestOptions(pluginConfig, 100, params.config, params.agentDir);
  const result = await listModels(options);
  return codexAppServerModelsToCatalogEntries(result.models);
}
