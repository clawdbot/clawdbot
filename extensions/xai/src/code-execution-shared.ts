import { postTrustedWebToolsJson } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildXaiResponsesToolBody,
  resolveXaiResponseTextAndCitations,
  XAI_RESPONSES_ENDPOINT,
} from "./responses-tool-shared.js";
import {
  coerceXaiToolConfig,
  resolveNormalizedXaiToolModel,
  resolvePositiveIntegerToolConfig,
} from "./tool-config-shared.js";
import { type XaiWebSearchResponse } from "./web-search-shared.js";

export const XAI_CODE_EXECUTION_ENDPOINT = XAI_RESPONSES_ENDPOINT;
export const XAI_DEFAULT_CODE_EXECUTION_MODEL = "grok-4-1-fast";

export type XaiCodeExecutionConfig = {
  apiKey?: unknown;
  model?: unknown;
  maxTurns?: unknown;
};

export type XaiCodeExecutionResponse = XaiWebSearchResponse & {
  output?: Array<{
    type?: string;
  }>;
};

export type XaiCodeExecutionResult = {
  content: string;
  citations: string[];
  usedCodeExecution: boolean;
  outputTypes: string[];
};

export function resolveXaiCodeExecutionConfig(
  config?: Record<string, unknown>,
): XaiCodeExecutionConfig {
  return coerceXaiToolConfig(config) as XaiCodeExecutionConfig;
}

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
  return await postTrustedWebToolsJson(
    {
      url: XAI_CODE_EXECUTION_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      apiKey: params.apiKey,
      body: buildXaiResponsesToolBody({
        model: params.model,
        inputText: params.task,
        tools: [{ type: "code_interpreter" }],
        maxTurns: params.maxTurns,
      }),
      errorLabel: "xAI",
    },
    async (response) => {
      const data = (await response.json()) as XaiCodeExecutionResponse;
      const { content, citations } = resolveXaiResponseTextAndCitations(data);
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

export const __testing = {
  buildXaiCodeExecutionPayload,
  requestXaiCodeExecution,
  resolveXaiCodeExecutionConfig,
  resolveXaiCodeExecutionMaxTurns,
  resolveXaiCodeExecutionModel,
  XAI_DEFAULT_CODE_EXECUTION_MODEL,
} as const;
