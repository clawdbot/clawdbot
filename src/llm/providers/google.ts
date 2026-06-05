// Google provider adapts Gemini streams and tools to the agent runtime.
import { type GenerateContentParameters, GoogleGenAI } from "@google/genai";
import { getEnvApiKey } from "../env-api-keys.js";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  buildGoogleGenerateContentParams,
  buildGoogleSimpleThinking,
  createGoogleAssistantOutput,
  getDisabledGoogleThinkingConfig,
  type GoogleProviderOptions,
  runGoogleGenerateContentLifecycle,
} from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

export type GoogleOptions = GoogleProviderOptions;

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions> = (
  model: Model<"google-generative-ai">,
  context: Context,
  options?: GoogleOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const output = createGoogleAssistantOutput(model, "google-generative-ai");

  void runGoogleGenerateContentLifecycle({
    stream,
    model,
    output,
    options,
    createClient: () => {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      return createClient(model, apiKey, options?.headers);
    },
    buildParams: () => buildParams(model, context, options),
    nextToolCallId: (name) => `${name}_${Date.now()}_${++toolCallCounter}`,
  });

  return stream;
};

export const streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
  model: Model<"google-generative-ai">,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  return streamGoogle(model, context, {
    ...base,
    thinking: buildGoogleSimpleThinking(model, options, {
      includeGemma4ThinkingLevel: true,
      useFlashLiteBudgets: true,
    }),
  } satisfies GoogleOptions);
};

function createClient(
  model: Model<"google-generative-ai">,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
): GoogleGenAI {
  const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } =
    {};
  if (model.baseUrl) {
    httpOptions.baseUrl = model.baseUrl;
    httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
  }
  if (model.headers || optionsHeaders) {
    httpOptions.headers = { ...model.headers, ...optionsHeaders };
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
  });
}

function buildParams(
  model: Model<"google-generative-ai">,
  context: Context,
  options: GoogleOptions = {},
): GenerateContentParameters {
  return buildGoogleGenerateContentParams(model, context, options, {
    getDisabledThinkingConfig: (modelLocal) =>
      getDisabledGoogleThinkingConfig(modelLocal, { includeGemma4: true }),
  });
}
