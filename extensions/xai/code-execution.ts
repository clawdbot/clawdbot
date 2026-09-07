// Xai plugin module implements code execution behavior.
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  buildMissingCodeExecutionApiKeyPayload,
  createCodeExecutionToolDefinition,
} from "./code-execution-tool-shared.js";
import {
  readCodeExecutionConfigRecord,
  readPluginCodeExecutionConfig,
  resolveCodeExecutionEnabled,
} from "./src/code-execution-config.js";
import {
  buildXaiCodeExecutionPayload,
  requestXaiCodeExecution,
  resolveXaiCodeExecutionMaxTurns,
  resolveXaiCodeExecutionModel,
} from "./src/code-execution-shared.js";
import { resolveXaiToolApiKeyWithAuth, type XaiToolAuthContext } from "./src/tool-auth-shared.js";

export function createCodeExecutionTool(options?: {
  config?: unknown;
  runtimeConfig?: Record<string, unknown> | null;
  auth?: XaiToolAuthContext;
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
      auth: options?.auth,
    })
  ) {
    return null;
  }

  return createCodeExecutionToolDefinition(
    async (_toolCallId: string, args: Record<string, unknown>) => {
      const apiKey = await resolveXaiToolApiKeyWithAuth({
        runtimeConfig: (runtimeConfig ?? undefined) as never,
        sourceConfig: options?.config as never,
        auth: options?.auth,
      });
      if (!apiKey) {
        return jsonResult(buildMissingCodeExecutionApiKeyPayload());
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
  );
}
