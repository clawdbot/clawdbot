import {
  type Content,
  FunctionCallingConfigMode,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type ThinkingConfig,
  ThinkingLevel,
} from "@google/genai";
/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */
import { clampThinkingLevel } from "../model-utils.js";
import { transformProviderMessages as transformMessages } from "../provider-transcript-transform.js";
import { googleFlashSupportsMinimalThinking } from "../transports/google-thinking-level.js";
import {
  assignTransportErrorDetails,
  notifyProviderStreamOpened,
  transportAbortError,
} from "../transports/transport-stream-shared.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingBudgets,
  ThinkingLevel as AgentThinkingLevel,
  StreamOptions,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  projectGoogleMessages,
  requiresGoogleToolCallId,
  convertGoogleTools,
} from "./google-messages.js";
import { consumeGoogleGenerateContentStream } from "./google-stream.js";

type GoogleApiType = "google-generative-ai" | "google-vertex";

type GoogleThinkingLevel = `${ThinkingLevel}`;

type GoogleToolChoice = "auto" | "none" | "any";

type GoogleThinkingOptions = {
  enabled: boolean;
  budgetTokens?: number;
  level?: GoogleThinkingLevel;
};

export type GoogleProviderOptions = StreamOptions & {
  toolChoice?: GoogleToolChoice;
  thinking?: GoogleThinkingOptions;
};

type GoogleGenerateContentClient = {
  models: {
    generateContentStream(
      params: GenerateContentParameters,
    ): Promise<AsyncIterable<GenerateContentResponse>> | AsyncIterable<GenerateContentResponse>;
  };
};

type ClampedGoogleThinkingLevel = Exclude<AgentThinkingLevel, "xhigh" | "max">;

function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
  return projectGoogleMessages({
    model,
    messages: transformMessages(context.messages, model, (id) =>
      requiresGoogleToolCallId(model.id) ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : id,
    ),
    replay: "signed-parts",
    requiresToolCallSignature:
      model.provider !== "google-gemini-cli" &&
      (isGemini3ProModel(model) || isGemini3FlashModel(model)),
  });
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 * @internal Directly tested provider implementation detail.
 */
function mapToolChoice(choice: string): FunctionCallingConfigMode {
  switch (choice) {
    case "auto":
      return FunctionCallingConfigMode.AUTO;
    case "none":
      return FunctionCallingConfigMode.NONE;
    case "any":
      return FunctionCallingConfigMode.ANY;
    default:
      return FunctionCallingConfigMode.AUTO;
  }
}

export function createGoogleAssistantOutput<T extends GoogleApiType>(
  model: Model<T>,
  api: Api = model.api,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export async function runGoogleGenerateContentLifecycle<T extends GoogleApiType>(params: {
  stream: AssistantMessageEventStream;
  model: Model<T>;
  output: AssistantMessage;
  options?: Pick<StreamOptions, "signal" | "onPayload">;
  createClient: () => GoogleGenerateContentClient;
  buildParams: () => GenerateContentParameters;
  nextToolCallId: (name: string | undefined) => string;
}): Promise<void> {
  const { stream, model, output, options } = params;

  try {
    const client = params.createClient();
    let requestParams = params.buildParams();
    const nextParams = await options?.onPayload?.(requestParams, model);
    if (nextParams !== undefined) {
      requestParams = nextParams as GenerateContentParameters;
    }
    const googleStream = await client.models.generateContentStream(requestParams);
    const googleIterator = googleStream[Symbol.asyncIterator]();
    await notifyProviderStreamOpened({
      options,
      cancelStream: async () => {
        await googleIterator.return?.();
      },
    });
    await consumeGoogleGenerateContentStream({
      chunks: { [Symbol.asyncIterator]: () => googleIterator },
      model,
      output,
      stream,
      signal: options?.signal,
      nextToolCallId: params.nextToolCallId,
    });
  } catch (error) {
    for (const block of output.content) {
      if ("index" in block) {
        delete (block as { index?: number }).index;
      }
    }
    const failure = options?.signal?.aborted ? transportAbortError(options.signal) : error;
    assignTransportErrorDetails(output, failure, options?.signal);
    stream.push({
      type: "error",
      reason: output.stopReason === "aborted" ? "aborted" : "error",
      error: output,
    });
    stream.end();
  }
}

export function buildGoogleGenerateContentParams<T extends GoogleApiType>(
  model: Model<T>,
  context: Context,
  options: GoogleProviderOptions = {},
): Omit<GenerateContentParameters, "contents"> & { contents: Content[] } {
  const contents = convertMessages(model, context);

  const generationConfig: GenerateContentConfig = {};
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  if (options.stop !== undefined && options.stop.length > 0) {
    generationConfig.stopSequences = options.stop;
  }

  const config: GenerateContentConfig = {
    ...(Object.keys(generationConfig).length > 0 && generationConfig),
    ...(context.systemPrompt && {
      systemInstruction: sanitizeSurrogates(stripSystemPromptCacheBoundary(context.systemPrompt)),
    }),
    ...(context.tools && context.tools.length > 0 && { tools: convertGoogleTools(context.tools) }),
  };

  if (context.tools && context.tools.length > 0 && options.toolChoice) {
    config.toolConfig = {
      functionCallingConfig: {
        mode: mapToolChoice(options.toolChoice),
      },
    };
  } else {
    config.toolConfig = undefined;
  }

  if (options.thinking?.enabled && model.reasoning) {
    const thinkingConfig: ThinkingConfig = { includeThoughts: true };
    if (options.thinking.level !== undefined) {
      thinkingConfig.thinkingLevel = ThinkingLevel[options.thinking.level];
    } else if (options.thinking.budgetTokens !== undefined) {
      thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
    }
    config.thinkingConfig = thinkingConfig;
  } else if (model.reasoning && options.thinking && !options.thinking.enabled) {
    const disabledThinkingConfig = getDisabledGoogleThinkingConfig(model);
    if (Object.keys(disabledThinkingConfig).length > 0) {
      config.thinkingConfig = disabledThinkingConfig;
    }
  }

  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error("Request aborted");
    }
    config.abortSignal = options.signal;
  }

  return {
    model: model.id,
    contents,
    config,
  };
}

function isAdaptiveGoogleReasoningLevel(value: unknown): value is "adaptive" {
  return value === "adaptive";
}

export function buildGoogleSimpleThinking<T extends GoogleApiType>(
  model: Model<T>,
  options: SimpleStreamOptions | undefined,
  config?: {
    includeGemma4ThinkingLevel?: boolean;
    useFlashLiteBudgets?: boolean;
  },
): GoogleThinkingOptions {
  if (!options?.reasoning || options.reasoning === "off") {
    return { enabled: false };
  }
  if (isAdaptiveGoogleReasoningLevel(options.reasoning)) {
    if (!model.reasoning) {
      return { enabled: false };
    }
    if (isGemma4Model(model)) {
      return { enabled: true, level: ThinkingLevel.HIGH };
    }
    return isGemini3ProModel(model) || isGemini3FlashModel(model)
      ? { enabled: true }
      : { enabled: true, budgetTokens: -1 };
  }

  const clampedReasoning = clampThinkingLevel(model, options.reasoning);
  if (clampedReasoning === "off") {
    return { enabled: false };
  }
  const effort = (
    clampedReasoning === "max" ? "high" : clampedReasoning
  ) as ClampedGoogleThinkingLevel;

  if (
    isGemini3ProModel(model) ||
    isGemini3FlashModel(model) ||
    (config?.includeGemma4ThinkingLevel && isGemma4Model(model))
  ) {
    return {
      enabled: true,
      level: getGoogleThinkingLevel(effort, model, {
        includeGemma4: config?.includeGemma4ThinkingLevel,
      }),
    };
  }

  return {
    enabled: true,
    budgetTokens: getGoogleBudget(model, effort, options.thinkingBudgets, {
      useFlashLiteBudgets: config?.useFlashLiteBudgets,
    }),
  };
}

function getDisabledGoogleThinkingConfig<T extends GoogleApiType>(model: Model<T>): ThinkingConfig {
  // Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
  // do not support full thinking-off either. For Gemini 3 models, use the lowest supported
  // thinkingLevel without includeThoughts so hidden thinking remains invisible to OpenClaw.
  if (isGemini3ProModel(model)) {
    return { thinkingLevel: ThinkingLevel.LOW };
  }
  if (isGemini3FlashModel(model)) {
    return {
      thinkingLevel: googleFlashSupportsMinimalThinking(model.id)
        ? ThinkingLevel.MINIMAL
        : ThinkingLevel.LOW,
    };
  }
  if (isGemma4Model(model) || model.id.toLowerCase().includes("gemini-2.5-pro")) {
    return {};
  }

  // Gemini 2.x supports disabling via thinkingBudget = 0.
  return { thinkingBudget: 0 };
}

/** @internal Directly tested provider implementation detail. */
function isGemma4Model<T extends GoogleApiType>(model: Model<T>): boolean {
  return /gemma-?4/.test(model.id.toLowerCase());
}

function isGemini3ProModel<T extends GoogleApiType>(model: Model<T>): boolean {
  return /gemini-(?:3(?:\.\d+)?-pro|pro-latest)/.test(model.id.toLowerCase());
}

function isGemini3FlashModel<T extends GoogleApiType>(model: Model<T>): boolean {
  return /gemini-(?:3(?:\.\d+)?-flash|flash(?:-lite)?-latest)/.test(model.id.toLowerCase());
}

function getGoogleThinkingLevel<T extends GoogleApiType>(
  effort: ClampedGoogleThinkingLevel,
  model: Model<T>,
  config?: { includeGemma4?: boolean },
): ThinkingLevel {
  if (isGemini3ProModel(model)) {
    switch (effort) {
      case "minimal":
      case "low":
        return ThinkingLevel.LOW;
      case "medium":
      case "high":
        return ThinkingLevel.HIGH;
    }
  }
  if (config?.includeGemma4 && isGemma4Model(model)) {
    switch (effort) {
      case "minimal":
      case "low":
        return ThinkingLevel.MINIMAL;
      case "medium":
      case "high":
        return ThinkingLevel.HIGH;
    }
  }
  switch (effort) {
    case "minimal":
      return isGemini3FlashModel(model) && !googleFlashSupportsMinimalThinking(model.id)
        ? ThinkingLevel.LOW
        : ThinkingLevel.MINIMAL;
    case "low":
      return ThinkingLevel.LOW;
    case "medium":
      return ThinkingLevel.MEDIUM;
    case "high":
      return ThinkingLevel.HIGH;
  }
  return ThinkingLevel.HIGH;
}

function getGoogleBudget<T extends GoogleApiType>(
  model: Model<T>,
  effort: ClampedGoogleThinkingLevel,
  customBudgets?: ThinkingBudgets,
  config?: { useFlashLiteBudgets?: boolean },
): number {
  if (customBudgets?.[effort] !== undefined) {
    return customBudgets[effort];
  }

  if (model.id.includes("2.5-pro")) {
    const budgets: Record<ClampedGoogleThinkingLevel, number> = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 32768,
    };
    return budgets[effort];
  }

  if (config?.useFlashLiteBudgets && model.id.includes("2.5-flash-lite")) {
    const budgets: Record<ClampedGoogleThinkingLevel, number> = {
      minimal: 512,
      low: 2048,
      medium: 8192,
      high: 24576,
    };
    return budgets[effort];
  }

  if (model.id.includes("2.5-flash")) {
    const budgets: Record<ClampedGoogleThinkingLevel, number> = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 24576,
    };
    return budgets[effort];
  }

  return -1;
}
