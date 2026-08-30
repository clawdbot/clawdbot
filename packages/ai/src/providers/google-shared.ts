/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

import {
  type Content,
  FinishReason,
  FunctionCallingConfigMode,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
  type ThinkingConfig,
  ThinkingLevel,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../model-utils.js";
import { transformProviderMessages as transformMessages } from "../provider-transcript-transform.js";
import { googleFlashSupportsMinimalThinking } from "../transports/google-thinking-level.js";
import {
  assignTransportErrorDetails,
  coerceTransportToolCallArguments,
  notifyProviderStreamOpened,
  transportAbortError,
} from "../transports/transport-stream-shared.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingBudgets,
  ThinkingContent,
  ThinkingLevel as AgentThinkingLevel,
  Tool,
  ToolCall,
  StreamOptions,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sortPromptCacheToolsByName } from "../utils/prompt-cache-stability.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
  isImageWithMediaPayload,
} from "./tool-result-text.js";

type GoogleApiType = "google-generative-ai" | "google-vertex";

// Google-owned SDK resource spellings identify the same model; other publishers do not.
const GOOGLE_MODEL_RESOURCE_PREFIX =
  /^(?:(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/google\/models\/|google\/|models\/)/u;

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

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
  return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 * @internal Directly tested provider implementation detail.
 */
function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (typeof incoming === "string" && incoming.length > 0) {
    return incoming;
  }
  return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
  if (!signature) {
    return false;
  }
  if (signature.length % 4 !== 0) {
    return false;
  }
  return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(
  isSameProviderAndModel: boolean,
  signature: string | undefined,
): string | undefined {
  return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 * @internal Directly tested provider implementation detail.
 */
function requiresToolCallId(modelId: string): boolean {
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function getGeminiMajorVersion(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/(?:^|\/)gemini(?:-live)?-(\d+)/);
  if (!match) {
    return undefined;
  }
  const majorVersion = match.at(1);
  return majorVersion === undefined ? undefined : Number.parseInt(majorVersion, 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const geminiMajorVersion = getGeminiMajorVersion(modelId);
  if (geminiMajorVersion !== undefined) {
    return geminiMajorVersion >= 3;
  }
  return true;
}

/**
 * Convert internal messages to Gemini Content[] format.
 * @internal Directly tested provider implementation detail.
 */
export function convertMessages<T extends GoogleApiType>(
  model: Model<T>,
  context: Context,
): Content[] {
  const contents: Content[] = [];
  const normalizeToolCallId = (id: string): string => {
    if (!requiresToolCallId(model.id)) {
      return id;
    }
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  };

  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
  const requiresToolCallThoughtSignature =
    model.provider !== "google-gemini-cli" &&
    (isGemini3ProModel(model) || isGemini3FlashModel(model));
  // Parallel calls need one immediate function-response turn. Gemini < 3 images cannot
  // live inside functionResponse, so hold them until the consecutive result run ends.
  const pendingToolResultImageTurns: Content[] = [];
  const sameRouteToolCallIds = new Set<string>();
  let activeToolResultParts: Part[] | undefined;
  const flushToolResultRun = (): void => {
    contents.push(...pendingToolResultImageTurns);
    pendingToolResultImageTurns.length = 0;
    activeToolResultParts = undefined;
  };

  for (const msg of transformedMessages) {
    if (msg.role !== "toolResult") {
      flushToolResultRun();
    }
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: sanitizeSurrogates(msg.content) || " " }],
        });
      } else {
        const parts: Part[] = msg.content.map((item) => {
          if (item.type === "text") {
            return { text: sanitizeSurrogates(item.text) || " " };
          }
          return {
            inlineData: {
              mimeType: item.mimeType,
              data: item.data,
            },
          };
        });
        if (parts.length === 0) {
          parts.push({ text: " " });
        }
        contents.push({
          role: "user",
          parts,
        });
      }
    } else if (msg.role === "assistant") {
      const parts: Part[] = [];
      let sawFunctionCall = false;
      // Check if message is from same provider and model - only then keep thinking blocks
      const isSameProviderAndModel =
        msg.provider === model.provider && msg.api === model.api && msg.model === model.id;

      for (const block of msg.content) {
        if (block.type === "text") {
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.textSignature,
          );
          if ((!block.text || block.text.trim() === "") && !thoughtSignature) {
            continue;
          }
          parts.push({
            text: sanitizeSurrogates(block.text),
            ...(thoughtSignature && { thoughtSignature }),
          });
        } else if (block.type === "thinking") {
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.thinkingSignature,
          );
          if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) {
            continue;
          }
          // Only keep as thinking block if same provider AND same model
          // Otherwise convert to plain text (no tags to avoid model mimicking them)
          if (isSameProviderAndModel) {
            parts.push({
              thought: true,
              text: sanitizeSurrogates(block.thinking),
              ...(thoughtSignature && { thoughtSignature }),
            });
          } else {
            parts.push({
              text: sanitizeSurrogates(block.thinking),
            });
          }
        } else if (block.type === "toolCall") {
          if (isSameProviderAndModel && model.provider !== "google-gemini-cli") {
            sameRouteToolCallIds.add(block.id);
          }
          const args = coerceTransportToolCallArguments(block.arguments);
          const ownSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.thoughtSignature,
          );
          const thoughtSignature =
            ownSignature ??
            (!sawFunctionCall && requiresToolCallThoughtSignature
              ? "skip_thought_signature_validator"
              : undefined);
          sawFunctionCall = true;
          const part: Part = {
            functionCall: {
              name: block.name,
              args,
              ...(sameRouteToolCallIds.has(block.id) || requiresToolCallId(model.id)
                ? { id: block.id }
                : {}),
            },
            ...(thoughtSignature && { thoughtSignature }),
          };
          parts.push(part);
        }
      }

      if (parts.length === 0) {
        continue;
      }
      contents.push({
        role: "model",
        parts,
      });
    } else if (msg.role === "toolResult") {
      // Extract text and image content
      const textResult = extractToolResultText(msg.content);
      const imageContent = model.input.includes("image")
        ? msg.content.filter(isImageWithMediaPayload)
        : [];

      const hasText = textResult.length > 0;
      const hasImages = imageContent.length > 0;
      const mediaPlaceholder = describeToolResultMediaPlaceholder(msg.content);

      // Gemini 3+ models support multimodal function responses with images nested inside
      // functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
      // Gemini < 3 still needs a separate user image turn.
      const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

      // Use "output" key for success, "error" key for errors as per SDK documentation
      const responseValue = hasText ? sanitizeSurrogates(textResult) : (mediaPlaceholder ?? "");

      const imageParts: Part[] = imageContent.map((imageBlock) => ({
        inlineData: {
          mimeType: imageBlock.mimeType,
          data: imageBlock.data,
        },
      }));

      const includeId = sameRouteToolCallIds.has(msg.toolCallId) || requiresToolCallId(model.id);
      const functionResponsePart: Part = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
          ...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
          ...(includeId ? { id: msg.toolCallId } : {}),
        },
      };

      // Cloud Code Assist API requires all function responses to be in a single user turn.
      if (activeToolResultParts) {
        activeToolResultParts.push(functionResponsePart);
      } else {
        activeToolResultParts = [functionResponsePart];
        contents.push({
          role: "user",
          parts: activeToolResultParts,
        });
      }

      // For Gemini < 3, add images in a separate user message
      if (hasImages && !modelSupportsMultimodalFunctionResponse) {
        pendingToolResultImageTurns.push({
          role: "user",
          parts: [{ text: "Tool result image:" }, ...imageParts],
        });
      }
    }
  }

  flushToolResultRun();
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: " " }] });
  }
  return contents;
}

/**
 * Convert tools to Gemini function declarations format.
 * @internal Directly tested provider implementation detail.
 */
export function convertTools(
  tools: Tool[],
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: sortPromptCacheToolsByName(tools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
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
): GenerateContentParameters {
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
    ...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
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

/**
 * Map Gemini FinishReason to our StopReason.
 * @internal Directly tested provider implementation detail.
 */
function mapStopReason(reason: FinishReason): StopReason {
  switch (reason) {
    case FinishReason.STOP:
      return "stop";
    case FinishReason.MAX_TOKENS:
      return "length";
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
    case FinishReason.SAFETY:
    case FinishReason.IMAGE_SAFETY:
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case FinishReason.IMAGE_RECITATION:
    case FinishReason.IMAGE_OTHER:
    case FinishReason.RECITATION:
    case FinishReason.FINISH_REASON_UNSPECIFIED:
    case FinishReason.OTHER:
    case FinishReason.LANGUAGE:
    case FinishReason.MALFORMED_FUNCTION_CALL:
    case FinishReason.TOO_MANY_TOOL_CALLS:
    case FinishReason.UNEXPECTED_TOOL_CALL:
    case FinishReason.NO_IMAGE:
      return "error";
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled stop reason: ${String(exhaustive)}`);
    }
  }
}

/** @internal Directly tested provider implementation detail. */
export async function consumeGoogleGenerateContentStream<T extends GoogleApiType>(params: {
  chunks: AsyncIterable<GenerateContentResponse>;
  model: Model<T>;
  output: AssistantMessage;
  stream: AssistantMessageEventStream;
  signal?: AbortSignal;
  nextToolCallId: (name: string | undefined) => string;
}): Promise<void> {
  params.stream.push({ type: "start", partial: params.output });
  let currentBlock: TextContent | ThinkingContent | null = null;
  const blocks = params.output.content;
  let sawTerminalReason = false;
  let terminalGenerationError: (Error & { code: string; type: string }) | undefined;
  const knownUsage = {
    promptTokenCount: 0,
    cachedContentTokenCount: 0,
    toolUsePromptTokenCount: 0,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 0,
  };
  const toolCallIds = new Set<string>();
  for (const block of blocks) {
    if (block.type === "toolCall") {
      toolCallIds.add(block.id);
    }
  }
  const blockIndex = () => blocks.length - 1;

  const endCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }
    if (currentBlock.type === "text") {
      params.stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: currentBlock.text,
        partial: params.output,
      });
    } else {
      params.stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: currentBlock.thinking,
        partial: params.output,
      });
    }
    currentBlock = null;
  };

  for await (const chunk of params.chunks) {
    params.output.responseId ||= chunk.responseId;
    const responseModel = chunk.modelVersion?.trim();
    if (
      responseModel &&
      params.model.id.replace(GOOGLE_MODEL_RESOURCE_PREFIX, "") !==
        responseModel.replace(GOOGLE_MODEL_RESOURCE_PREFIX, "")
    ) {
      params.output.responseModel ||= responseModel;
    }
    if (chunk.usageMetadata) {
      for (const field of Object.keys(knownUsage) as Array<keyof typeof knownUsage>) {
        const value = chunk.usageMetadata[field];
        if (typeof value === "number") {
          knownUsage[field] = value;
        }
      }
      const promptTokens = knownUsage.promptTokenCount;
      const cacheRead = knownUsage.cachedContentTokenCount;
      const toolUsePromptTokens = knownUsage.toolUsePromptTokenCount;
      const outputTokens = knownUsage.candidatesTokenCount + knownUsage.thoughtsTokenCount;
      params.output.usage = {
        input: Math.max(0, promptTokens - cacheRead) + toolUsePromptTokens,
        output: outputTokens,
        cacheRead,
        cacheWrite: 0,
        totalTokens:
          chunk.usageMetadata.totalTokenCount ?? promptTokens + outputTokens + toolUsePromptTokens,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      };
      calculateCost(params.model, params.output.usage);
    }
    const candidate = chunk.candidates?.[0];
    const promptFeedback = chunk.promptFeedback;
    if (!candidate && promptFeedback) {
      const blockReason = promptFeedback.blockReason ?? "PROMPT_BLOCKED";
      const blockMessage = promptFeedback.blockReasonMessage?.trim();
      params.output.errorCode = blockReason;
      params.output.errorType = "google_prompt_blocked";
      throw new Error(
        `Google prompt blocked (${blockReason})${blockMessage ? `: ${blockMessage}` : ""}`,
      );
    }
    if (candidate?.content?.parts) {
      for (const [partIndex, part] of candidate.content.parts.entries()) {
        const text = part.text;
        const hasText = typeof text === "string";
        const hasThoughtSignature =
          typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0;
        const signatureOnly =
          hasThoughtSignature &&
          (!hasText || text.length === 0) &&
          Object.keys(part).every(
            (key) => key === "thought" || key === "thoughtSignature" || key === "text",
          );
        if (signatureOnly) {
          if (!hasText && part.thought !== true) {
            const latestBlock = blocks.at(-1);
            if (
              partIndex === 0 &&
              latestBlock?.type === "toolCall" &&
              !latestBlock.thoughtSignature
            ) {
              latestBlock.thoughtSignature = retainThoughtSignature(
                latestBlock.thoughtSignature,
                part.thoughtSignature,
              );
              continue;
            }
          }
          // Empty signed Parts have their own wire identity; merging moves an opaque signature.
          endCurrentBlock();
        }

        if (hasText || signatureOnly) {
          if (currentBlock && (hasThoughtSignature || partIndex > 0)) {
            const currentSignature =
              currentBlock.type === "thinking"
                ? currentBlock.thinkingSignature
                : currentBlock.textSignature;
            const currentText =
              currentBlock.type === "thinking" ? currentBlock.thinking : currentBlock.text;
            if (
              currentText.length > 0 &&
              (currentSignature !== part.thoughtSignature ||
                (partIndex > 0 && (currentSignature || hasThoughtSignature)))
            ) {
              endCurrentBlock();
            }
          }
          const isThinking = isThinkingPart(part);
          if (
            !currentBlock ||
            (isThinking && currentBlock.type !== "thinking") ||
            (!isThinking && currentBlock.type !== "text")
          ) {
            endCurrentBlock();
            if (isThinking) {
              currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
              params.output.content.push(currentBlock);
              params.stream.push({
                type: "thinking_start",
                contentIndex: blockIndex(),
                partial: params.output,
              });
            } else {
              currentBlock = { type: "text", text: "" };
              params.output.content.push(currentBlock);
              params.stream.push({
                type: "text_start",
                contentIndex: blockIndex(),
                partial: params.output,
              });
            }
          }
          const delta = hasText ? text : "";
          if (currentBlock.type === "thinking") {
            currentBlock.thinking += delta;
            currentBlock.thinkingSignature = retainThoughtSignature(
              currentBlock.thinkingSignature,
              part.thoughtSignature,
            );
            params.stream.push({
              type: "thinking_delta",
              contentIndex: blockIndex(),
              delta,
              partial: params.output,
            });
          } else {
            currentBlock.text += delta;
            currentBlock.textSignature = retainThoughtSignature(
              currentBlock.textSignature,
              part.thoughtSignature,
            );
            params.stream.push({
              type: "text_delta",
              contentIndex: blockIndex(),
              delta,
              partial: params.output,
            });
          }
          if (signatureOnly) {
            endCurrentBlock();
          }
        }

        if (part.functionCall) {
          endCurrentBlock();
          const providedId = part.functionCall.id;
          const needsNewId = !providedId || toolCallIds.has(providedId);
          const toolCall: ToolCall = {
            type: "toolCall",
            id: needsNewId ? params.nextToolCallId(part.functionCall.name) : providedId,
            name: part.functionCall.name || "",
            arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
            ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
          };

          params.output.content.push(toolCall);
          toolCallIds.add(toolCall.id);
          params.stream.push({
            type: "toolcall_start",
            contentIndex: blockIndex(),
            partial: params.output,
          });
          params.stream.push({
            type: "toolcall_delta",
            contentIndex: blockIndex(),
            delta: JSON.stringify(toolCall.arguments),
            partial: params.output,
          });
          params.stream.push({
            type: "toolcall_end",
            contentIndex: blockIndex(),
            toolCall,
            partial: params.output,
          });
        }
      }
    }

    if (
      candidate?.finishReason &&
      candidate.finishReason !== FinishReason.FINISH_REASON_UNSPECIFIED
    ) {
      sawTerminalReason = true;
      params.output.stopReason = mapStopReason(candidate.finishReason);
      if (params.output.stopReason === "error") {
        const finishMessage = candidate.finishMessage?.trim();
        terminalGenerationError = Object.assign(
          new Error(
            `Google generation stopped (${candidate.finishReason})${finishMessage ? `: ${finishMessage}` : ""}`,
          ),
          { code: candidate.finishReason, type: "google_generation_failed" },
        );
      }
      // MAX_TOKENS can leave a complete-looking partial call. Only a normal
      // Google stop may promote parsed calls into an executable tool-use turn.
      if (
        params.output.stopReason === "stop" &&
        params.output.content.some((block) => block.type === "toolCall")
      ) {
        params.output.stopReason = "toolUse";
      }
    }
  }

  endCurrentBlock();

  if (params.signal?.aborted) {
    throw transportAbortError(params.signal);
  }

  if (terminalGenerationError) {
    params.output.errorCode = terminalGenerationError.code;
    params.output.errorType = terminalGenerationError.type;
    throw terminalGenerationError;
  }

  if (!sawTerminalReason) {
    params.output.errorCode = "STREAM_INCOMPLETE";
    params.output.errorType = "google_incomplete_stream";
    throw new Error("Google stream ended before a terminal finish reason");
  }

  if (params.output.stopReason === "aborted" || params.output.stopReason === "error") {
    throw new Error("An unknown error occurred");
  }

  params.stream.push({
    type: "done",
    reason: params.output.stopReason,
    message: params.output,
  });
  params.stream.end();
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
