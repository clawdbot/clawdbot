import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { Type } from "typebox";
import {
  buildXaiCodeExecutionPayload,
  requestXaiCodeExecution,
  resolveXaiCodeExecutionMaxTurns,
  resolveXaiCodeExecutionModel,
} from "./src/code-execution-shared.js";
import { isXaiToolEnabled, resolveXaiToolApiKey } from "./src/tool-auth-shared.js";

type CodeExecutionConfig = {
  enabled?: boolean;
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
};

function readCodeExecutionConfigRecord(
  config?: CodeExecutionConfig,
): Record<string, unknown> | undefined {
  return config && typeof config === "object" ? (config as Record<string, unknown>) : undefined;
}

function readPluginCodeExecutionConfig(cfg?: unknown): CodeExecutionConfig | undefined {
  if (!cfg || typeof cfg !== "object") {
    return undefined;
  }
  const entries = (cfg as Record<string, unknown>).plugins;
  const pluginEntries =
    entries && typeof entries === "object"
      ? ((entries as Record<string, unknown>).entries as Record<string, unknown> | undefined)
      : undefined;
  if (!pluginEntries) {
    return undefined;
  }
  const xaiEntry = pluginEntries.xai;
  if (!xaiEntry || typeof xaiEntry !== "object") {
    return undefined;
  }
  const config = (xaiEntry as Record<string, unknown>).config;
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const codeExecution = (config as Record<string, unknown>).codeExecution;
  if (!codeExecution || typeof codeExecution !== "object") {
    return undefined;
  }
  return codeExecution as CodeExecutionConfig;
}

function resolveCodeExecutionEnabled(params: {
  sourceConfig?: unknown;
  runtimeConfig?: unknown;
  config?: CodeExecutionConfig;
}): boolean {
  return isXaiToolEnabled({
    enabled: readCodeExecutionConfigRecord(params.config)?.enabled as boolean | undefined,
    runtimeConfig: params.runtimeConfig as never,
    sourceConfig: params.sourceConfig as never,
  });
}

export function createCodeExecutionTool(options?: {
  config?: unknown;
  runtimeConfig?: Record<string, unknown> | null;
}) {
  const runtimeConfig = options?.runtimeConfig ?? getRuntimeConfigSnapshot();
  const codeExecutionConfig =
    readPluginCodeExecutionConfig(runtimeConfig ?? undefined) ??
    readPluginCodeExecutionConfig(options?.config);
  if (
    !resolveCodeExecutionEnabled({
      sourceConfig: options?.config,
      runtimeConfig: runtimeConfig ?? undefined,
      config: codeExecutionConfig,
    })
  ) {
    return null;
  }

  return {
    label: "Code Execution",
    name: "code_execution",
    description:
      "Run sandboxed Python analysis with xAI. Use for calculations, tabulation, summaries, and chart-style analysis without local machine access.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "The full analysis task for xAI's remote Python sandbox. Include any data to analyze directly in the task.",
      }),
    }),
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const apiKey = resolveXaiToolApiKey({
        runtimeConfig: (runtimeConfig ?? undefined) as never,
        sourceConfig: options?.config as never,
      });
      if (!apiKey) {
        return jsonResult({
          error: "missing_xai_api_key",
          message:
            "code_execution needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
          docs: "https://docs.openclaw.ai/tools/code-execution",
        });
      }

      const task = readStringParam(args, "task", { required: true });
      const codeExecutionConfigRecord = readCodeExecutionConfigRecord(codeExecutionConfig);
      const model = resolveXaiCodeExecutionModel(codeExecutionConfigRecord);
      const maxTurns = resolveXaiCodeExecutionMaxTurns(codeExecutionConfigRecord);
      const timeoutSeconds =
        typeof codeExecutionConfigRecord?.timeoutSeconds === "number" &&
        Number.isFinite(codeExecutionConfigRecord.timeoutSeconds)
          ? codeExecutionConfigRecord.timeoutSeconds
          : 30;
      const startedAt = Date.now();
      const result = await requestXaiCodeExecution({
        apiKey,
        model,
        timeoutSeconds,
        maxTurns,
        task,
      });
      return jsonResult(
        buildXaiCodeExecutionPayload({
          task,
          model,
          tookMs: Date.now() - startedAt,
          content: result.content,
          citations: result.citations,
          usedCodeExecution: result.usedCodeExecution,
          outputTypes: result.outputTypes,
        }),
      );
    },
  };
}
