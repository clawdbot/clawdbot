import { replaceCompactionReplayOwnerContent } from "@openclaw/ai/transports";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ToolResultMessage,
} from "@openclaw/llm-core";
import { uuidv7 } from "./harness/session/uuid.js";
import { type AgentCoreStreamRuntimeDeps, resolveAgentCoreStreamFn } from "./runtime-deps.js";
import { createStreamSteering } from "./stream-steering.js";
import { normalizeCoreContextMessages } from "./turn-interruption.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentToolCall,
  StreamFn,
  ToolLoopIntervention,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export type AsyncToolBatchScheduling = {
  waitForPrevious: () => Promise<void>;
  onParallelStarted: () => void;
};

export type ExecutedToolCallBatch = {
  messages: ToolResultMessage[];
  steeringMessages: AgentMessage[];
  terminate: boolean;
  terminateRun: boolean;
  intervention?: ToolLoopIntervention;
  fatal?: { error: unknown };
};

type AssistantMessageUpdateEvent = Extract<
  AssistantMessageEvent,
  {
    type:
      | "text_start"
      | "text_delta"
      | "text_end"
      | "thinking_start"
      | "thinking_delta"
      | "thinking_end"
      | "toolcall_start"
      | "toolcall_delta"
      | "toolcall_end";
  }
>;

function appendTextDeltaToAssistantMessage(
  message: AssistantMessage,
  contentIndex: number,
  delta: string,
): AssistantMessage {
  const content = [...message.content];
  const currentContent = content[contentIndex];
  content[contentIndex] =
    currentContent?.type === "text"
      ? { ...currentContent, text: currentContent.text + delta }
      : { type: "text", text: delta };
  return { ...message, content };
}

function resolveAssistantMessageUpdate(
  event: AssistantMessageUpdateEvent,
  currentMessage: AssistantMessage,
): AssistantMessage {
  if ("partial" in event && event.partial) {
    return event.partial;
  }
  if (event.type === "text_delta") {
    return appendTextDeltaToAssistantMessage(currentMessage, event.contentIndex, event.delta);
  }
  return currentMessage;
}

function removeNonExecutableToolCalls(message: AssistantMessage): AssistantMessage {
  if (message.stopReason === "toolUse") {
    return message;
  }
  const content = message.content.filter((item) => item.type !== "toolCall" || item.async);
  return content.length === message.content.length
    ? message
    : replaceCompactionReplayOwnerContent(message, content);
}

function ensureToolTurnIdentity(message: AssistantMessage): AssistantMessage {
  const executable =
    message.stopReason === "toolUse" ||
    ((message.stopReason === "stop" || message.stopReason === "length") &&
      message.content.some((item) => item.type === "toolCall" && item.async));
  if (!executable || message.responseId?.trim() || message.turnId?.trim()) {
    return message;
  }
  // message_end persists this local identity before any tool can execute.
  return { ...message, turnId: uuidv7() };
}

export async function streamAgentResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  newMessages: AgentMessage[],
  executeAsyncTools: (
    message: AssistantMessage,
    calls: AgentToolCall[],
    signal: AbortSignal,
    emit: AgentEventSink,
    scheduling: AsyncToolBatchScheduling,
  ) => Promise<ExecutedToolCallBatch>,
  prepareAssistantMessage: (message: AssistantMessage) => AssistantMessage,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<{
  message: AssistantMessage;
  executedIds: Set<string>;
  batches: ExecutedToolCallBatch[];
  continuationRequired: boolean;
}> {
  const sourceMessages = [...context.messages];
  const convertMessages = async (messages: AgentMessage[], projectionSignal = signal) => {
    const transformed = config.transformContext
      ? await config.transformContext(messages, projectionSignal)
      : messages;
    return config.convertToLlm(normalizeCoreContextMessages(transformed));
  };
  const llmMessages = await convertMessages(sourceMessages);
  let requestPrefix: string | undefined;

  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  const streamFunction = resolveAgentCoreStreamFn(runtime, streamFn);

  // Resolve API key (important for expiring tokens)
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

  const executionAbort = new AbortController();
  const executionSignal = signal
    ? AbortSignal.any([signal, executionAbort.signal])
    : executionAbort.signal;
  const abortFailedResponse = (message?: AssistantMessage) => {
    if (message?.stopReason === "error" || message?.stopReason === "aborted") {
      executionAbort.abort(new Error(message.errorMessage ?? "Model response interrupted"));
    }
  };
  const steering = createStreamSteering(config, executionSignal, async (pending) => {
    requestPrefix ??= JSON.stringify(llmMessages);
    const projected = await convertMessages([...sourceMessages, ...pending], executionSignal);
    // Live input can only append to the active request. Pruning or rewriting
    // its prefix needs ordinary queued delivery through a fresh request.
    if (JSON.stringify(projected.slice(0, llmMessages.length)) !== requestPrefix) {
      return [];
    }
    return projected.slice(llmMessages.length);
  });
  const executedIds = new Set<string>();
  const batches: ExecutedToolCallBatch[] = [];
  let executions = Promise.resolve();
  let admissions = Promise.resolve();
  let executionFailure: { error: unknown } | undefined;
  const emitToolEvent: AgentEventSink = async (event) => {
    if (event.type === "message_end" && event.message.role === "toolResult") {
      context.messages.push(event.message);
      newMessages.push(event.message);
    }
    await emit(event);
  };
  const enqueueTools = (message: AssistantMessage) => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return;
    }
    const calls = message.content.filter(
      (item): item is AgentToolCall =>
        item.type === "toolCall" &&
        !executedIds.has(item.id) &&
        (message.stopReason === "toolUse" || item.async === true),
    );
    if (calls.length === 0) {
      return;
    }
    for (const call of calls) {
      executedIds.add(call.id);
    }
    const previousExecutions = executions;
    const previousAdmission = admissions;
    // SAFETY: Promise construction assigns the admission release synchronously.
    let releaseAdmission!: () => void;
    admissions = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const execution = previousAdmission
      .then(async () => {
        const batch = await executeAsyncTools(message, calls, executionSignal, emitToolEvent, {
          waitForPrevious: () => previousExecutions,
          onParallelStarted: releaseAdmission,
        });
        batches.push(batch);
        if (batch.fatal || batch.terminateRun) {
          executionAbort.abort(batch.fatal?.error ?? new Error("Tool batch terminated"));
        }
      })
      .catch((error: unknown) => {
        executionFailure ??= { error };
        executionAbort.abort(error);
      })
      .finally(releaseAdmission);
    executions = Promise.all([previousExecutions, execution]).then(() => {});
  };
  try {
    const response = await streamFunction(config.model, llmContext, {
      ...config,
      apiKey: resolvedApiKey,
      signal: executionSignal,
      onActiveResponse: steering.onActiveResponse,
      asyncToolExecution: true,
    });

    let partialMessage: AssistantMessage | null = null;
    let partialIndex: number | undefined;
    let committedContentCount = 0;
    let streamedTurnId: string | undefined;

    // Result wrappers bind ownership to unchanged content. Only split actual async fragments.
    const remainingFragment = (message: AssistantMessage) =>
      committedContentCount === 0
        ? message
        : replaceCompactionReplayOwnerContent(
            message,
            message.content.slice(committedContentCount),
          );
    const updatePartial = async (message: AssistantMessage) => {
      const fragment = remainingFragment(message);
      if (partialIndex === undefined) {
        partialIndex = context.messages.length;
        context.messages.push(fragment);
        await emit({ type: "message_start", message: { ...fragment } });
      } else {
        context.messages[partialIndex] = fragment;
      }
      return fragment;
    };

    const commitFragment = async (message: AssistantMessage) => {
      if (partialIndex === undefined) {
        context.messages.push(message);
        await emit({ type: "message_start", message: { ...message } });
      } else {
        context.messages.splice(partialIndex, 1);
        context.messages.push(message);
      }
      partialIndex = undefined;
      newMessages.push(message);
      await emit({ type: "message_end", message });
    };

    for await (const event of response) {
      switch (event.type) {
        case "start": {
          const message = event.partial;
          partialMessage = message;
          await updatePartial(message);
          break;
        }

        case "text_start":
        case "text_delta":
        case "text_end":
        case "thinking_start":
        case "thinking_delta":
        case "thinking_end":
        case "toolcall_start":
        case "toolcall_delta":
        case "toolcall_end":
          if (partialMessage) {
            const message = resolveAssistantMessageUpdate(event, partialMessage);
            partialMessage = message;
            if (event.contentIndex < committedContentCount) {
              break;
            }
            const fragment = await updatePartial(message);
            const fragmentEvent = {
              ...event,
              contentIndex: event.contentIndex - committedContentCount,
              ...("partial" in event ? { partial: fragment } : {}),
            };
            await emit({
              type: "message_update",
              assistantMessageEvent: fragmentEvent,
              message: { ...fragment },
            });
            if (
              event.type === "toolcall_end" &&
              event.toolCall.async &&
              !executedIds.has(event.toolCall.id) &&
              message.content
                .slice(committedContentCount, event.contentIndex)
                .every((item) => item.type !== "toolCall" || item.async === true)
            ) {
              const prefix = prepareAssistantMessage(
                ensureToolTurnIdentity({
                  ...replaceCompactionReplayOwnerContent(
                    message,
                    message.content.slice(committedContentCount, event.contentIndex + 1),
                  ),
                  ...(streamedTurnId ? { turnId: streamedTurnId } : {}),
                  stopReason: "toolUse",
                  // Usage belongs to the terminal fragment, once per provider response.
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                }),
              );
              streamedTurnId ??= prefix.turnId;
              // Await transcript persistence before admitting side effects. The model
              // may keep sampling, but every executed call has a durable owner.
              await commitFragment(prefix);
              committedContentCount = event.contentIndex + 1;
              enqueueTools(prefix);
            }
          }
          break;

        case "done":
        case "error":
          return await finalizeAssistantMessage(
            event.type === "done" ? event.message : event.error,
          );
      }
    }

    // Stream ended without a terminal event: result() either carries an explicit
    // end(result) value or rejects with the EventStream terminal-contract error,
    // so a contract-violating producer surfaces loudly instead of hanging here.
    return await finalizeAssistantMessage();

    async function finalizeAssistantMessage(terminal?: AssistantMessage) {
      // Fence queued side effects before result hooks or transcript persistence can yield.
      abortFailedResponse(terminal);
      const result = await response.result();
      abortFailedResponse(result);
      const finalMessage = prepareAssistantMessage(
        ensureToolTurnIdentity(
          removeNonExecutableToolCalls({
            ...remainingFragment(result),
            ...(streamedTurnId ? { turnId: streamedTurnId } : {}),
          }),
        ),
      );
      await commitFragment(finalMessage);
      if (executedIds.size > 0) {
        enqueueTools(finalMessage);
      }
      await executions;
      if (executionFailure) {
        throw executionFailure.error;
      }
      const continuationRequired = await steering.finish();
      return { message: finalMessage, executedIds, batches, continuationRequired };
    }
  } finally {
    executionAbort.abort(new Error("Model response closed"));
    await executions;
    await steering.finish();
  }
}
