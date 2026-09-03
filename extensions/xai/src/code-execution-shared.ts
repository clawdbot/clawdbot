// Xai plugin module implements code execution shared behavior.
import { XAI_DEFAULT_MODEL_ID } from "../model-definitions.js";
import {
  requestXaiResponsesTool,
  requireXaiResponseTextAndCitations,
  XAI_RESPONSES_ENDPOINT,
} from "./responses-tool-shared.js";
import {
  resolveNormalizedXaiToolModel,
  resolvePositiveIntegerToolConfig,
} from "./tool-config-shared.js";

const XAI_CODE_EXECUTION_ENDPOINT = XAI_RESPONSES_ENDPOINT;
const XAI_DEFAULT_CODE_EXECUTION_MODEL = XAI_DEFAULT_MODEL_ID;

type XaiCodeExecutionResult = {
  content: string;
  citations: string[];
  usedCodeExecution: boolean;
  outputTypes: string[];
};

export function resolveXaiCodeExecutionModel(config?: Record<string, unknown>): string {
  return resolveNormalizedXaiToolModel({
    config,
    defaultModel: XAI_DEFAULT_CODE_EXECUTION_MODEL,
  });
}

export function resolveXaiCodeExecutionMaxTurns(
  config?: Record<string, unknown>,
): number | undefined {
  return resolvePositiveIntegerToolConfig(config, "maxTurns");
}

export function buildXaiCodeExecutionPayload(params: {
  task: string;
  model: string;
  tookMs: number;
  content: string;
  citations: string[];
  usedCodeExecution: boolean;
  outputTypes: string[];
}): Record<string, unknown> {
  return {
    task: params.task,
    provider: "xai",
    model: params.model,
    tookMs: params.tookMs,
    content: params.content,
    citations: params.citations,
    usedCodeExecution: params.usedCodeExecution,
    outputTypes: params.outputTypes,
  };
}

export async function requestXaiCodeExecution(params: {
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  maxTurns?: number;
  task: string;
}): Promise<XaiCodeExecutionResult> {
  return await requestXaiResponsesTool(
    {
      ...params,
      endpoint: XAI_CODE_EXECUTION_ENDPOINT,
      inputText: params.task,
      tools: [{ type: "code_interpreter" }],
      reasoningEffort: params.model === XAI_DEFAULT_CODE_EXECUTION_MODEL ? "low" : undefined,
      errorLabel: "xAI code execution failed",
    },
    (data) => {
      const { content, citations } = requireXaiResponseTextAndCitations(
        data,
        "xAI code execution failed",
      );
      const outputTypes = Array.isArray(data.output)
        ? [
            ...new Set(
              data.output
                .map((entry) => entry?.type)
                .filter((value): value is string => Boolean(value)),
            ),
          ]
        : [];
      return {
        content,
        citations,
        usedCodeExecution: outputTypes.includes("code_interpreter_call"),
        outputTypes,
      };
    },
  );
}
