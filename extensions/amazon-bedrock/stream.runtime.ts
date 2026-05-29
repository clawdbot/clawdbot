import {
  CachePointType,
  CacheTTL,
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
  BedrockRuntimeServiceException,
  type ContentBlock,
  type ContentBlockDeltaEvent,
  type ContentBlockStartEvent,
  type ContentBlockStopEvent,
  ConversationRole,
  ConverseStreamCommand,
  type ConverseStreamMetadataEvent,
  ImageFormat,
  type Message,
  StopReason as BedrockStopReason,
  type SystemContentBlock,
  type Tool as BedrockTool,
  type ToolChoice,
  type ToolConfiguration,
  ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { DocumentType } from "@smithy/types";
import {
  adjustMaxTokensForThinking,
  AssistantMessageEventStream,
  buildBaseOptions,
  calculateCost,
  clampReasoning,
  createHttpProxyAgentsForTarget,
  parseStreamingJson,
  sanitizeSurrogates,
  transformMessages,
  type Api,
  type AssistantMessage,
  type CacheRetention,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type StreamFunction,
  type TextContent,
  type ThinkingContent,
  type ThinkingLevel,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "openclaw/plugin-sdk/llm";
import { supportsBedrockPromptCaching, type BedrockOptions } from "./bedrock-options.js";

type Block = (TextContent | ThinkingContent | ToolCall) & { index?: number; partialJson?: string };

export const streamBedrock: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
  model: Model<"bedrock-converse-stream">,
  context: Context,
  options: BedrockOptions = {},
) => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "bedrock-converse-stream" as Api,
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

    const blocks = output.content as Block[];

    const config: BedrockRuntimeClientConfig = {
      profile: options.profile,
    };
    const configuredRegion = getConfiguredBedrockRegion(options);
    const hasConfiguredProfile = hasConfiguredBedrockProfile(options);
    const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
    const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(
      model.baseUrl,
      configuredRegion,
      hasConfiguredProfile,
    );

    // Only pin standard AWS Bedrock runtime endpoints when no region/profile is configured.
    // This preserves custom endpoints (VPC/proxy) from #3402 without forcing built-in
    // catalog defaults such as us-east-1 to override AWS_REGION/AWS_PROFILE.
    if (useExplicitEndpoint) {
      config.endpoint = model.baseUrl;
    }

    // Resolve bearer token for Bedrock API key auth.
    const bearerToken = options.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;
    const useBearerToken = bearerToken !== undefined && process.env.AWS_BEDROCK_SKIP_AUTH !== "1";

    // in Node.js/Bun environment only
    if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
      // Region resolution: explicit option > env vars > SDK default chain.
      // When AWS_PROFILE is set, we leave region undefined so the SDK can
      // resovle it from aws profile configs. Otherwise fall back to us-east-1.
      if (configuredRegion) {
        config.region = configuredRegion;
      } else if (endpointRegion && useExplicitEndpoint) {
        config.region = endpointRegion;
      } else if (!hasConfiguredProfile) {
        config.region = "us-east-1";
      }

      // Support proxies that don't need authentication
      if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") {
        config.credentials = {
          accessKeyId: "dummy-access-key",
          secretAccessKey: "dummy-secret-key",
        };
      }

      const proxyAgents = createHttpProxyAgentsForTarget(model.baseUrl);
      if (proxyAgents) {
        // Bedrock runtime uses NodeHttp2Handler by default since v3.798.0, which is based
        // on `http2` module and has no support for http agent.
        // Use NodeHttpHandler to support HTTP(S) proxy agents.
        config.requestHandler = new NodeHttpHandler(proxyAgents);
      } else if (process.env.AWS_BEDROCK_FORCE_HTTP1 === "1") {
        // Some custom endpoints require HTTP/1.1 instead of HTTP/2
        config.requestHandler = new NodeHttpHandler();
      }
    } else {
      // Non-Node environment (browser): fall back to us-east-1 since
      // there's no config file resolution available.
      config.region =
        configuredRegion ||
        (endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) ||
        "us-east-1";
    }

    if (useBearerToken) {
      config.token = { token: bearerToken };
      config.authSchemePreference = ["httpBearerAuth"];
    }

    try {
      const client = new BedrockRuntimeClient(config);
      const cacheRetention = resolveCacheRetention(options.cacheRetention);
      let commandInput = {
        modelId: model.id,
        messages: convertMessages(context, model, cacheRetention),
        system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
        inferenceConfig: {
          ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
          ...(options.temperature !== undefined && { temperature: options.temperature }),
        },
        toolConfig: convertToolConfig(context.tools, options.toolChoice),
        additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
        ...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
      };
      const nextCommandInput = await options?.onPayload?.(commandInput, model);
      if (nextCommandInput !== undefined) {
        commandInput = nextCommandInput as typeof commandInput;
      }
      const command = new ConverseStreamCommand(commandInput);

      const response = await client.send(command, { abortSignal: options.signal });
      if (response.$metadata.httpStatusCode !== undefined) {
        const responseHeaders: Record<string, string> = {};
        if (response.$metadata.requestId) {
          responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
        }
        await options?.onResponse?.(
          { status: response.$metadata.httpStatusCode, headers: responseHeaders },
          model,
        );
      }

      for await (const item of response.stream!) {
        if (item.messageStart) {
          if (item.messageStart.role !== ConversationRole.ASSISTANT) {
            throw new Error(
              "Unexpected assistant message start but got user message start instead",
            );
          }
          stream.push({ type: "start", partial: output });
        } else if (item.contentBlockStart) {
          handleContentBlockStart(item.contentBlockStart, blocks, output, stream);
        } else if (item.contentBlockDelta) {
          handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
        } else if (item.contentBlockStop) {
          handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
        } else if (item.messageStop) {
          output.stopReason = mapStopReason(item.messageStop.stopReason);
        } else if (item.metadata) {
          handleMetadata(item.metadata, model, output);
        } else if (item.internalServerException) {
          throw item.internalServerException;
        } else if (item.modelStreamErrorException) {
          throw item.modelStreamErrorException;
        } else if (item.validationException) {
          throw item.validationException;
        } else if (item.throttlingException) {
          throw item.throttlingException;
        } else if (item.serviceUnavailableException) {
          throw item.serviceUnavailableException;
        }
      }

      if (options.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error("An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as Block).index;
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as Block).partialJson;
      }
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatBedrockError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

/**
 * Human-readable prefixes for Bedrock SDK exception names.
 * The downstream retry logic in agent-session matches patterns like
 * `server.?error` and `service.?unavailable`, so we preserve the legacy
 * prefix format rather than using the raw SDK exception name.
 */
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
  InternalServerException: "Internal server error",
  ModelStreamErrorException: "Model stream error",
  ValidationException: "Validation error",
  ThrottlingException: "Throttling error",
  ServiceUnavailableException: "Service unavailable",
};

/**
 * Format a Bedrock error with a human-readable prefix.
 * AWS SDK exceptions (both from `client.send()` and from stream event items)
 * extend BedrockRuntimeServiceException. We map the `.name` to a stable
 * human-readable prefix so downstream consumers (retry logic, context-overflow
 * detection) can distinguish error categories via simple string matching.
 */
function formatBedrockError(error: unknown): string {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  if (error instanceof BedrockRuntimeServiceException) {
    const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
    return `${prefix}: ${message}`;
  }
  return message;
}

export const streamSimpleBedrock: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
  model: Model<"bedrock-converse-stream">,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  const base = buildBaseOptions(model, options, undefined);
  if (!options?.reasoning) {
    return streamBedrock(model, context, {
      ...base,
      reasoning: undefined,
    } satisfies BedrockOptions);
  }

  if (isAnthropicClaudeModel(model)) {
    if (supportsAdaptiveThinking(model.id, model.name)) {
      return streamBedrock(model, context, {
        ...base,
        reasoning: options.reasoning,
        thinkingBudgets: options.thinkingBudgets,
      } satisfies BedrockOptions);
    }

    // Undefined means the caller did not request an output cap; let the helper use the model cap.
    // Do not coerce to 0 here, or the thinking budget would become the entire maxTokens value.
    const adjusted = adjustMaxTokensForThinking(
      base.maxTokens,
      model.maxTokens,
      options.reasoning,
      options.thinkingBudgets,
    );

    return streamBedrock(model, context, {
      ...base,
      maxTokens: adjusted.maxTokens,
      reasoning: options.reasoning,
      thinkingBudgets: {
        ...options.thinkingBudgets,
        [clampReasoning(options.reasoning)!]: adjusted.thinkingBudget,
      },
    } satisfies BedrockOptions);
  }

  return streamBedrock(model, context, {
    ...base,
    reasoning: options.reasoning,
    thinkingBudgets: options.thinkingBudgets,
  } satisfies BedrockOptions);
};

function handleContentBlockStart(
  event: ContentBlockStartEvent,
  blocks: Block[],
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const index = event.contentBlockIndex!;
  const start = event.start;

  if (start?.toolUse) {
    const block: Block = {
      type: "toolCall",
      id: start.toolUse.toolUseId || "",
      name: start.toolUse.name || "",
      arguments: {},
      partialJson: "",
      index,
    };
    output.content.push(block);
    stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
  }
}

function handleContentBlockDelta(
  event: ContentBlockDeltaEvent,
  blocks: Block[],
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const contentBlockIndex = event.contentBlockIndex!;
  const delta = event.delta;
  let index = blocks.findIndex((b) => b.index === contentBlockIndex);
  let block = blocks[index];

  if (delta?.text !== undefined) {
    // If no text block exists yet, create one, as `handleContentBlockStart` is not sent for text blocks
    if (!block) {
      const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
      output.content.push(newBlock);
      index = blocks.length - 1;
      block = blocks[index];
      stream.push({ type: "text_start", contentIndex: index, partial: output });
    }
    if (block.type === "text") {
      block.text += delta.text;
      stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
    }
  } else if (delta?.toolUse && block?.type === "toolCall") {
    block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
    block.arguments = parseStreamingJson(block.partialJson);
    stream.push({
      type: "toolcall_delta",
      contentIndex: index,
      delta: delta.toolUse.input || "",
      partial: output,
    });
  } else if (delta?.reasoningContent) {
    let thinkingBlock = block;
    let thinkingIndex = index;

    if (!thinkingBlock) {
      const newBlock: Block = {
        type: "thinking",
        thinking: "",
        thinkingSignature: "",
        index: contentBlockIndex,
      };
      output.content.push(newBlock);
      thinkingIndex = blocks.length - 1;
      thinkingBlock = blocks[thinkingIndex];
      stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
    }

    if (thinkingBlock?.type === "thinking") {
      if (delta.reasoningContent.text) {
        thinkingBlock.thinking += delta.reasoningContent.text;
        stream.push({
          type: "thinking_delta",
          contentIndex: thinkingIndex,
          delta: delta.reasoningContent.text,
          partial: output,
        });
      }
      if (delta.reasoningContent.signature) {
        thinkingBlock.thinkingSignature =
          (thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
      }
    }
  }
}

function handleMetadata(
  event: ConverseStreamMetadataEvent,
  model: Model<"bedrock-converse-stream">,
  output: AssistantMessage,
): void {
  if (event.usage) {
    output.usage.input = event.usage.inputTokens || 0;
    output.usage.output = event.usage.outputTokens || 0;
    output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
    output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
    output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
    calculateCost(model, output.usage);
  }
}

function handleContentBlockStop(
  event: ContentBlockStopEvent,
  blocks: Block[],
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
  const block = blocks[index];
  if (!block) {
    return;
  }
  delete block.index;

  switch (block.type) {
    case "text":
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
      break;
    case "thinking":
      stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: output,
      });
      break;
    case "toolCall":
      block.arguments = parseStreamingJson(block.partialJson);
      // Finalize in-place and strip the scratch buffer so replay only
      // carries parsed arguments.
      delete (block as Block).partialJson;
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
      break;
  }
}

/**
 * Check if the model supports adaptive thinking (Opus 4.6+, Sonnet 4.6).
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, "-")];
  });
}

function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
  const candidates = getModelMatchCandidates(modelId, modelName);
  return candidates.some(
    (s) =>
      s.includes("opus-4-6") ||
      s.includes("opus-4-7") ||
      s.includes("opus-4-8") ||
      s.includes("sonnet-4-6"),
  );
}

function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
  const candidates = getModelMatchCandidates(model.id, model.name);
  return candidates.some((s) => s.includes("opus-4-7") || s.includes("opus-4-8"));
}

function mapThinkingLevelToEffort(
  model: Model<"bedrock-converse-stream">,
  level: SimpleStreamOptions["reasoning"],
): "low" | "medium" | "high" | "xhigh" | "max" {
  if (level === "xhigh" && supportsNativeXhighEffort(model)) {
    return "xhigh";
  }

  const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
  if (typeof mapped === "string") {
    return mapped as "low" | "medium" | "high" | "xhigh" | "max";
  }

  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return supportsNativeXhighEffort(model) ? "max" : "high";
    default:
      return "high";
  }
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses OPENCLAW_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.OPENCLAW_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

/**
 * Check if the model is an Anthropic Claude model on Bedrock.
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
  const id = model.id.toLowerCase();
  const name = model.name?.toLowerCase() ?? "";
  return (
    id.includes("anthropic.claude") ||
    id.includes("anthropic/claude") ||
    name.includes("anthropic.claude") ||
    name.includes("anthropic/claude") ||
    name.includes("claude")
  );
}

function supportsPromptCaching(model: Model<"bedrock-converse-stream">): boolean {
  return supportsBedrockPromptCaching(model.id, model.name);
}

/**
 * Check if the model supports thinking signatures in reasoningContent.
 * Only Anthropic Claude models support the signature field.
 * Other models (OpenAI, Qwen, Minimax, Moonshot, etc.) reject it with:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * Checks both model ID and model name to support application inference profiles.
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
  return isAnthropicClaudeModel(model);
}

function buildSystemPrompt(
  systemPrompt: string | undefined,
  model: Model<"bedrock-converse-stream">,
  cacheRetention: CacheRetention,
): SystemContentBlock[] | undefined {
  if (!systemPrompt) {
    return undefined;
  }

  const blocks: SystemContentBlock[] = [{ text: sanitizeSurrogates(systemPrompt) }];

  // Add cache point for supported Claude models when caching is enabled
  if (cacheRetention !== "none" && supportsPromptCaching(model)) {
    blocks.push({
      cachePoint: {
        type: CachePointType.DEFAULT,
        ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
      },
    });
  }

  return blocks;
}

function normalizeToolCallId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

function convertMessages(
  context: Context,
  model: Model<"bedrock-converse-stream">,
  cacheRetention: CacheRetention,
): Message[] {
  const result: Message[] = [];
  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

  for (let i = 0; i < transformedMessages.length; i++) {
    const m = transformedMessages[i];

    switch (m.role) {
      case "user": {
        const content: ContentBlock[] = [];
        if (typeof m.content === "string") {
          content.push({ text: sanitizeSurrogates(m.content) });
        } else {
          for (const c of m.content) {
            switch (c.type) {
              case "text":
                content.push({ text: sanitizeSurrogates(c.text) });
                break;
              case "image":
                content.push({ image: createImageBlock(c.mimeType, c.data) });
                break;
              default:
                continue;
            }
          }
        }
        if (content.length === 0) {
          continue;
        }
        result.push({
          role: ConversationRole.USER,
          content,
        });
        break;
      }
      case "assistant": {
        // Skip assistant messages with empty content (e.g., from aborted requests)
        // Bedrock rejects messages with empty content arrays
        if (m.content.length === 0) {
          continue;
        }
        const contentBlocks: ContentBlock[] = [];
        for (const c of m.content) {
          switch (c.type) {
            case "text":
              // Skip empty text blocks
              if (c.text.trim().length === 0) {
                continue;
              }
              contentBlocks.push({ text: sanitizeSurrogates(c.text) });
              break;
            case "toolCall":
              contentBlocks.push({
                toolUse: { toolUseId: c.id, name: c.name, input: c.arguments as DocumentType },
              });
              break;
            case "thinking":
              // Skip empty thinking blocks
              if (c.thinking.trim().length === 0) {
                continue;
              }
              // Only Anthropic models support the signature field in reasoningText.
              // For other models, we omit the signature to avoid errors like:
              // "This model doesn't support the reasoningContent.reasoningText.signature field"
              if (supportsThinkingSignature(model)) {
                // Signatures arrive after thinking deltas. If a partial or externally
                // persisted message lacks a signature, Bedrock rejects the replayed
                // reasoning block. Fall back to plain text, matching Anthropic.
                if (!c.thinkingSignature || c.thinkingSignature.trim().length === 0) {
                  contentBlocks.push({ text: sanitizeSurrogates(c.thinking) });
                } else {
                  contentBlocks.push({
                    reasoningContent: {
                      reasoningText: {
                        text: c.thinking,
                        signature: c.thinkingSignature,
                      },
                    },
                  });
                }
              } else {
                contentBlocks.push({ text: sanitizeSurrogates(c.thinking) });
              }
              break;
            default:
              continue;
          }
        }
        // Skip if all content blocks were filtered out
        if (contentBlocks.length === 0) {
          continue;
        }
        result.push({
          role: ConversationRole.ASSISTANT,
          content: contentBlocks,
        });
        break;
      }
      case "toolResult": {
        // Collect all consecutive toolResult messages into a single user message
        // Bedrock requires all tool results to be in one message
        const toolResults: ContentBlock.ToolResultMember[] = [];

        // Add current tool result with all content blocks combined
        toolResults.push({
          toolResult: {
            toolUseId: m.toolCallId,
            content: m.content.map((c) =>
              c.type === "image"
                ? { image: createImageBlock(c.mimeType, c.data) }
                : { text: sanitizeSurrogates(c.text) },
            ),
            status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
          },
        });

        // Look ahead for consecutive toolResult messages
        let j = i + 1;
        while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
          const nextMsg = transformedMessages[j] as ToolResultMessage;
          toolResults.push({
            toolResult: {
              toolUseId: nextMsg.toolCallId,
              content: nextMsg.content.map((c) =>
                c.type === "image"
                  ? { image: createImageBlock(c.mimeType, c.data) }
                  : { text: sanitizeSurrogates(c.text) },
              ),
              status: nextMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
            },
          });
          j++;
        }

        // Skip the messages we've already processed
        i = j - 1;

        result.push({
          role: ConversationRole.USER,
          content: toolResults,
        });
        break;
      }
      default:
        continue;
    }
  }

  // Add cache point to the last user message for supported Claude models when caching is enabled
  if (cacheRetention !== "none" && supportsPromptCaching(model) && result.length > 0) {
    const lastMessage = result[result.length - 1];
    if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
      lastMessage.content.push({
        cachePoint: {
          type: CachePointType.DEFAULT,
          ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
        },
      });
    }
  }

  return result;
}

function convertToolConfig(
  tools: Tool[] | undefined,
  toolChoice: BedrockOptions["toolChoice"],
): ToolConfiguration | undefined {
  if (!tools?.length || toolChoice === "none") {
    return undefined;
  }

  const bedrockTools: BedrockTool[] = tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters as unknown as DocumentType },
    },
  }));

  let bedrockToolChoice: ToolChoice | undefined;
  switch (toolChoice) {
    case "auto":
      bedrockToolChoice = { auto: {} };
      break;
    case "any":
      bedrockToolChoice = { any: {} };
      break;
    default:
      if (typeof toolChoice === "object" && toolChoice?.type === "tool") {
        bedrockToolChoice = { tool: { name: toolChoice.name } };
      }
  }

  return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case BedrockStopReason.END_TURN:
    case BedrockStopReason.STOP_SEQUENCE:
      return "stop";
    case BedrockStopReason.MAX_TOKENS:
    case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
      return "length";
    case BedrockStopReason.TOOL_USE:
      return "toolUse";
    default:
      return "error";
  }
}

function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
  if (typeof process === "undefined") {
    return options.region;
  }

  return options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
}

function hasConfiguredBedrockProfile(options: BedrockOptions): boolean {
  if (options.profile) {
    return true;
  }
  if (typeof process === "undefined") {
    return false;
  }

  return Boolean(process.env.AWS_PROFILE);
}

function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  try {
    const { hostname } = new URL(baseUrl);
    const match = hostname
      .toLowerCase()
      .match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function shouldUseExplicitBedrockEndpoint(
  baseUrl: string,
  configuredRegion: string | undefined,
  hasConfiguredProfile: boolean,
): boolean {
  const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
  if (!endpointRegion) {
    return true;
  }

  return !configuredRegion && !hasConfiguredProfile;
}

function isGovCloudBedrockTarget(
  model: Model<"bedrock-converse-stream">,
  options: BedrockOptions,
): boolean {
  const region = getConfiguredBedrockRegion(options);
  if (region?.toLowerCase().startsWith("us-gov-")) {
    return true;
  }

  const modelId = model.id.toLowerCase();
  return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

function buildAdditionalModelRequestFields(
  model: Model<"bedrock-converse-stream">,
  options: BedrockOptions,
): DocumentType | undefined {
  if (!options.reasoning || !model.reasoning) {
    return undefined;
  }

  if (isAnthropicClaudeModel(model)) {
    // GovCloud Bedrock currently rejects the Claude thinking.display field.
    // Omit it there until the GovCloud Converse schema catches up.
    const display = isGovCloudBedrockTarget(model, options)
      ? undefined
      : (options.thinkingDisplay ?? "summarized");
    const result: Record<string, unknown> = supportsAdaptiveThinking(model.id, model.name)
      ? {
          thinking: { type: "adaptive", ...(display !== undefined ? { display } : {}) },
          output_config: { effort: mapThinkingLevelToEffort(model, options.reasoning) },
        }
      : (() => {
          const defaultBudgets: Record<ThinkingLevel, number> = {
            minimal: 1024,
            low: 2048,
            medium: 8192,
            high: 16384,
            xhigh: 16384, // Claude doesn't support xhigh, clamp to high
            max: 16384,
          };

          // Custom budgets override defaults (xhigh not in ThinkingBudgets, use high)
          const level = options.reasoning === "xhigh" ? "high" : options.reasoning;
          const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

          return {
            thinking: {
              type: "enabled",
              budget_tokens: budget,
              ...(display !== undefined ? { display } : {}),
            },
          };
        })();

    if (!supportsAdaptiveThinking(model.id, model.name) && (options.interleavedThinking ?? true)) {
      result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
    }

    return result as DocumentType;
  }

  return undefined;
}

function createImageBlock(mimeType: string, data: string) {
  let format: ImageFormat;
  switch (mimeType) {
    case "image/jpeg":
    case "image/jpg":
      format = ImageFormat.JPEG;
      break;
    case "image/png":
      format = ImageFormat.PNG;
      break;
    case "image/gif":
      format = ImageFormat.GIF;
      break;
    case "image/webp":
      format = ImageFormat.WEBP;
      break;
    default:
      throw new Error(`Unknown image type: ${mimeType}`);
  }

  const binaryString = atob(data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return { source: { bytes }, format };
}

export const testing = {
  convertMessages,
  getConfiguredBedrockRegion,
  hasConfiguredBedrockProfile,
  mapThinkingLevelToEffort,
  shouldUseExplicitBedrockEndpoint,
};
