// Keep the runtime class on the public package specifier so OpenClaw and
// external consumers share one constructor identity.
import { EventStream as LlmEventStream } from "@openclaw/ai/event-stream";
import { replaceCompactionReplayOwnerContent } from "@openclaw/ai/transports";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  EventStream,
  ToolResultMessage,
  EventStream as SourceEventStream,
} from "@openclaw/llm-core";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { TranscriptNotContinuableError } from "./errors.js";
import { uuidv7 } from "./harness/session/uuid.js";
import {
  getInternalToolExecutionPreparer,
  getInternalSyncSteeringGetter,
  type InternalToolExecutionPreparation,
  takeInternalToolBatchLifecycle,
  type InternalToolBatchLifecycle,
} from "./internal-hooks.js";
import { resolveAgentReasoningOption } from "./reasoning.js";
import { type AgentCoreStreamRuntimeDeps, resolveAgentCoreStreamFn } from "./runtime-deps.js";
import {
  type AgentToolExecutionContext,
  runWithAgentToolExecutionContext,
} from "./tool-execution-context.js";
import {
  appendInterruptedTurnMessage,
  createFailureMessage,
  createInterruptedTurnMessage,
  isTurnHandoffAbort,
  normalizeCoreContextMessages,
} from "./turn-interruption.js";
import type {
  ToolResultContentSource,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  StreamFn,
  ToolLoopIntervention,
} from "./types.js";
import { validateToolArguments } from "./validation.js";

/** Callback used by synchronous loop runners to publish agent lifecycle events. */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

const EventStreamConstructor: typeof SourceEventStream = LlmEventStream;

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

const TOOL_LOOP_RECOVERY_TERMINATED_MESSAGE =
  "OpenClaw stopped this run because tool-loop recovery encountered another critical loop. No blocked tool action was executed.";
const STEERING_TOOL_SKIP_MESSAGE = "Skipped due to queued user message.";

function getSteeringAtCheckpoint(
  config: AgentLoopConfig,
): AgentMessage[] | Promise<AgentMessage[]> {
  const callback = config.getSteeringMessages;
  if (!callback) {
    return [];
  }
  return getInternalSyncSteeringGetter(callback)?.() ?? callback.call(config);
}

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
  const content = message.content.filter((item) => item.type !== "toolCall");
  return content.length === message.content.length
    ? message
    : replaceCompactionReplayOwnerContent(message, content);
}

function ensureToolTurnIdentity(message: AssistantMessage): AssistantMessage {
  if (message.stopReason !== "toolUse" || message.responseId?.trim() || message.turnId?.trim()) {
    return message;
  }
  // message_end persists this local identity before any tool can execute.
  return { ...message, turnId: uuidv7() };
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();

  void runAgentLoop(
    prompts,
    context,
    config,
    async (event) => {
      stream.push(event);
    },
    signal,
    streamFn,
    runtime,
  )
    .then((messages) => {
      stream.end(messages);
    })
    .catch((error: unknown) => {
      pushLoopFailure(stream, config, error, signal);
    });

  return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): EventStream<AgentEvent, AgentMessage[]> {
  const lastMessage = context.messages.at(-1);
  if (!lastMessage) {
    throw new Error("Cannot continue: no messages in context");
  }

  if (lastMessage.role === "assistant") {
    throw new TranscriptNotContinuableError(lastMessage.role);
  }

  const stream = createAgentStream();

  void runAgentLoopContinue(
    context,
    config,
    async (event) => {
      stream.push(event);
    },
    signal,
    streamFn,
    runtime,
  )
    .then((messages) => {
      stream.end(messages);
    })
    .catch((error: unknown) => {
      pushLoopFailure(stream, config, error, signal);
    });

  return stream;
}

/** Run a prompt-started loop and emit events through a caller-owned sink. */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn, runtime);
  return newMessages;
}

/** Continue an existing loop context and emit only newly produced messages. */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<AgentMessage[]> {
  const lastMessage = context.messages.at(-1);
  if (!lastMessage) {
    throw new Error("Cannot continue: no messages in context");
  }

  if (lastMessage.role === "assistant") {
    throw new TranscriptNotContinuableError(lastMessage.role);
  }

  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn, runtime);
  return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStreamConstructor<AgentEvent, AgentMessage[]>(
    (event: AgentEvent) => event.type === "agent_end",
    (event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
  );
}

function pushLoopFailure(
  stream: EventStream<AgentEvent, AgentMessage[]>,
  config: AgentLoopConfig,
  error: unknown,
  signal: AbortSignal | undefined,
): void {
  const aborted = signal?.aborted === true;
  const failureMessage = createFailureMessage(config.model, error, aborted);
  stream.push({ type: "message_start", message: failureMessage });
  stream.push({ type: "message_end", message: failureMessage });
  stream.push({ type: "turn_end", message: failureMessage, toolResults: [] });
  const messages: AgentMessage[] = [failureMessage];
  if (aborted && !isTurnHandoffAbort(signal)) {
    const interruption = createInterruptedTurnMessage();
    messages.push(interruption);
    stream.push({ type: "message_start", message: interruption });
    stream.push({ type: "message_end", message: interruption });
  }
  stream.push({ type: "agent_end", messages });
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<void> {
  let currentContext = initialContext;
  let config = initialConfig;
  let firstTurn = true;
  let turnOpen = true;
  let turnTainted = isActiveTurnTainted(initialContext.messages);
  const toolLoopRecoveryState = initialConfig.toolLoopRecoveryState ?? {
    criticalToolLoopSeen: false,
  };
  // Check for steering messages at start (user may have typed while waiting)
  const initialSteering = getSteeringAtCheckpoint(config);
  let pendingMessages: AgentMessage[] = Array.isArray(initialSteering)
    ? initialSteering
    : await initialSteering;
  const stopIfAborted = async (): Promise<boolean> => {
    if (!signal?.aborted) {
      return false;
    }
    // Persist an aborted assistant outcome so session post-processing does not
    // compact or continue from the preceding toolUse message.
    const abortedMessage = withAssistantTurnTaint(
      createFailureMessage(
        config.model,
        signal.reason instanceof Error ? signal.reason : new Error("Agent run aborted"),
        true,
      ),
      turnTainted,
    );
    newMessages.push(abortedMessage);
    if (!turnOpen) {
      await emit({ type: "turn_start" });
      turnOpen = true;
    }
    await emit({ type: "message_start", message: abortedMessage });
    await emit({ type: "message_end", message: abortedMessage });
    await emit({ type: "turn_end", message: abortedMessage, toolResults: [] });
    turnOpen = false;
    if (!isTurnHandoffAbort(signal)) {
      await appendInterruptedTurnMessage(newMessages, emit);
    }
    await emit({ type: "agent_end", messages: newMessages });
    return true;
  };

  // Outer loop: continues when queued follow-up messages arrive after agent would stop
  while (true) {
    let hasMoreToolCalls = true;

    // Inner loop: process tool calls and steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (await stopIfAborted()) {
        return;
      }

      if (!firstTurn) {
        await emit({ type: "turn_start" });
        turnOpen = true;
      } else {
        firstTurn = false;
      }

      // Process pending messages (inject before next assistant response)
      if (pendingMessages.length > 0) {
        const messagesToInject = pendingMessages;
        pendingMessages = [];
        for (const message of messagesToInject) {
          if (message.role === "user") {
            turnTainted = false;
          }
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
      }

      if (await stopIfAborted()) {
        return;
      }

      // Stream assistant response
      const message = await streamAssistantResponse(
        currentContext,
        config,
        signal,
        emit,
        streamFn,
        runtime,
        turnTainted,
      );
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        if (message.stopReason === "aborted" && signal?.aborted && !isTurnHandoffAbort(signal)) {
          await appendInterruptedTurnMessage(newMessages, emit);
        }
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Only completed toolUse turns dispatch; length/stop can carry partial stream blocks.
      const toolCalls = message.content.filter((c) => c.type === "toolCall");

      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;
      let terminateRun = false;
      if (message.stopReason === "toolUse" && toolCalls.length > 0) {
        const executedToolBatch = await executeToolCalls(
          currentContext,
          message,
          config,
          signal,
          emit,
          toolLoopRecoveryState.criticalToolLoopSeen,
        );
        toolResults.push(...executedToolBatch.messages);
        turnTainted ||= toolResults.some(toolResultTaintsTurn);
        hasMoreToolCalls = !executedToolBatch.terminate;
        pendingMessages = executedToolBatch.steeringMessages;
        if (executedToolBatch.intervention) {
          toolLoopRecoveryState.criticalToolLoopSeen = true;
        }
        terminateRun = executedToolBatch.terminateRun;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });
      turnOpen = false;
      if (await stopIfAborted()) {
        return;
      }
      if (terminateRun) {
        const terminalMessage = {
          ...createFailureMessage(
            config.model,
            new Error(TOOL_LOOP_RECOVERY_TERMINATED_MESSAGE),
            false,
          ),
          content: [{ type: "text" as const, text: TOOL_LOOP_RECOVERY_TERMINATED_MESSAGE }],
        };
        currentContext.messages.push(terminalMessage);
        newMessages.push(terminalMessage);
        await emit({ type: "turn_start" });
        turnOpen = true;
        await emit({ type: "message_start", message: terminalMessage });
        await emit({ type: "message_end", message: terminalMessage });
        await emit({ type: "turn_end", message: terminalMessage, toolResults: [] });
        turnOpen = false;
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      const nextTurnContext = {
        message,
        toolResults,
        context: currentContext,
        newMessages,
      };
      const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
      if (nextTurnSnapshot) {
        currentContext = nextTurnSnapshot.context ?? currentContext;
        const nextModel = nextTurnSnapshot.model ?? config.model;
        const nextThinkingLevel = nextTurnSnapshot.thinkingLevel ?? config.thinkingLevel;
        const shouldResolveReasoning =
          nextTurnSnapshot.thinkingLevel !== undefined ||
          (nextTurnSnapshot.model !== undefined && nextThinkingLevel !== undefined);
        const nextReasoning =
          shouldResolveReasoning && nextThinkingLevel !== undefined
            ? resolveAgentReasoningOption(nextModel, nextThinkingLevel)
            : config.reasoning;
        config = Object.assign({}, config, {
          model: nextModel,
          thinkingLevel: nextThinkingLevel,
          reasoning: nextReasoning,
        });
      }
      if (await stopIfAborted()) {
        return;
      }

      if (pendingMessages.length === 0) {
        if (
          await config.shouldStopAfterTurn?.({
            message,
            toolResults,
            context: currentContext,
            newMessages,
          })
        ) {
          await emit({ type: "agent_end", messages: newMessages });
          return;
        }

        const steering = getSteeringAtCheckpoint(config);
        pendingMessages = Array.isArray(steering) ? steering : await steering;
      }
      if (await stopIfAborted()) {
        return;
      }
    }

    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      // Follow-up messages arrive after a turn would otherwise end; route them through the
      // same pending-message path so event ordering matches steering messages.
      pendingMessages = followUpMessages;
      continue;
    }

    // No more messages, exit
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
  turnTainted = false,
): Promise<AssistantMessage> {
  // Apply context transform if configured (AgentMessage[] → AgentMessage[])
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }
  messages = normalizeCoreContextMessages(messages);

  // Convert to LLM-compatible messages (AgentMessage[] → Message[])
  const llmMessages = await config.convertToLlm(messages);

  // Build LLM context
  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  const streamFunction = resolveAgentCoreStreamFn(runtime, streamFn);

  // Resolve API key (important for expiring tokens)
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start": {
        const message = event.partial;
        partialMessage = message;
        context.messages.push(message);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...message } });
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
          context.messages[context.messages.length - 1] = message;
          await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...message },
          });
        }
        break;

      case "done":
      case "error":
        return await finalizeAssistantMessage();
    }
  }

  // Stream ended without a terminal event: result() either carries an explicit
  // end(result) value or rejects with the EventStream terminal-contract error,
  // so a contract-violating producer surfaces loudly instead of hanging here.
  return await finalizeAssistantMessage();

  async function finalizeAssistantMessage(): Promise<AssistantMessage> {
    const finalMessage = withAssistantTurnTaint(
      ensureToolTurnIdentity(removeNonExecutableToolCalls(await response.result())),
      turnTainted,
    );
    if (addedPartial) {
      context.messages[context.messages.length - 1] = finalMessage;
    } else {
      context.messages.push(finalMessage);
      await emit({ type: "message_start", message: { ...finalMessage } });
    }
    await emit({ type: "message_end", message: finalMessage });
    return finalMessage;
  }
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  criticalToolLoopSeen: boolean,
): Promise<ExecutedToolCallBatch> {
  const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
  const resolvedToolCalls = new Map<AgentToolCall, ResolvedToolCallOutcome>();
  const validatedToolCalls = new Map<AgentToolCall, ValidatedToolCallOutcome>();
  let batchLifecycle: InternalToolBatchLifecycle | undefined;
  if (config.beforeToolBatch) {
    for (const toolCall of toolCalls) {
      if (signal?.aborted) {
        // Cancellation during an early async resolver must not stall behind
        // the remaining resolvers. Skipped calls stay uncached and complete
        // through the executors' normal aborted-call lifecycle.
        break;
      }
      validatedToolCalls.set(
        toolCall,
        await validateToolCallForBatchAdmission(
          currentContext,
          assistantMessage,
          toolCall,
          config,
          signal,
          resolvedToolCalls,
        ),
      );
    }
    const calls = toolCalls.flatMap((toolCall) => {
      const validation = validatedToolCalls.get(toolCall);
      return validation?.kind === "validated"
        ? [{ toolCall, args: validation.prepared.args, tool: validation.prepared.tool }]
        : [];
    });
    if (calls.length > 0 && !signal?.aborted) {
      const admission = await config.beforeToolBatch(
        { assistantMessage, calls, context: currentContext },
        signal,
      );
      if (admission?.intervention) {
        return await completeToolLoopInterventionBatch({
          currentContext,
          assistantMessage,
          toolCalls,
          resolvedToolCalls,
          validatedToolCalls,
          config,
          signal,
          emit,
          intervention: admission.intervention,
          terminal: criticalToolLoopSeen,
        });
      }
      batchLifecycle = admission ? takeInternalToolBatchLifecycle(admission) : undefined;
    }
  }
  let hasSequentialToolCall = false;
  if (config.toolExecution !== "sequential") {
    for (const toolCall of toolCalls) {
      if (signal?.aborted) {
        break;
      }
      const resolution = await resolveToolCallTool(
        currentContext,
        assistantMessage,
        toolCall,
        config,
        signal,
        resolvedToolCalls,
      );
      if (resolution.kind === "resolved" && resolution.tool?.executionMode === "sequential") {
        hasSequentialToolCall = true;
        break;
      }
    }
  }
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(
      currentContext,
      assistantMessage,
      toolCalls,
      resolvedToolCalls,
      validatedToolCalls,
      batchLifecycle,
      config,
      signal,
      emit,
    );
  }
  return executeToolCallsParallel(
    currentContext,
    assistantMessage,
    toolCalls,
    resolvedToolCalls,
    validatedToolCalls,
    batchLifecycle,
    config,
    signal,
    emit,
  );
}

type ExecutedToolCallBatch = {
  messages: ToolResultMessage[];
  steeringMessages: AgentMessage[];
  terminate: boolean;
  terminateRun: boolean;
  intervention?: ToolLoopIntervention;
};

type ResolvedToolCallOutcome =
  | { kind: "resolved"; tool?: AgentTool }
  | { kind: "error"; error: unknown };

function hidesToolCallFromChannelProgress(
  context: AgentContext,
  toolCall: AgentToolCall,
  resolvedToolCalls: Map<AgentToolCall, ResolvedToolCallOutcome>,
): boolean {
  const resolution = resolvedToolCalls.get(toolCall);
  const tool =
    resolution?.kind === "resolved"
      ? resolution.tool
      : context.tools?.find((candidate) => candidate.name === toolCall.name);
  return tool?.hideFromChannelProgress === true;
}

async function executeToolCallsSequential(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  resolvedToolCalls: Map<AgentToolCall, ResolvedToolCallOutcome>,
  validatedToolCalls: Map<AgentToolCall, ValidatedToolCallOutcome>,
  batchLifecycle: InternalToolBatchLifecycle | undefined,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];
  let steeringMessages: AgentMessage[] = [];
  let skippedReady: { args: unknown; startEmitted: true } | undefined;
  let skippedStartIndex = toolCalls.length;

  for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
    const toolCall = toolCalls[callIndex];
    if (!toolCall) {
      continue;
    }
    if (!signal?.aborted) {
      const steering = getSteeringAtCheckpoint(config);
      steeringMessages = Array.isArray(steering) ? steering : await steering;
    }
    if (steeringMessages.length > 0) {
      skippedStartIndex = callIndex;
      break;
    }
    const hideFromChannelProgress = hidesToolCallFromChannelProgress(
      currentContext,
      toolCall,
      resolvedToolCalls,
    );
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
      resolvedToolCalls,
      validatedToolCalls,
    );
    let finalized: FinalizedToolCallOutcome;
    if (preparation.kind === "immediate") {
      finalized = await finalizeToolCallOutcome(
        currentContext,
        assistantMessage,
        {
          toolCall,
          result: preparation.result,
          isError: preparation.isError,
          executionStarted: false,
          ...(preparation.errorKind ? { errorKind: preparation.errorKind } : {}),
          ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
        },
        toolCall.arguments,
        config,
        signal,
      );
    } else {
      const execution = await prepareToolCallExecution(
        preparation,
        { assistantMessage, toolCall: preparation.toolCall },
        signal,
        emit,
      );
      if (execution.kind === "immediate") {
        finalized = await finalizeExecutedToolCall(
          currentContext,
          assistantMessage,
          preparation,
          execution.outcome,
          preparation.args,
          config,
          signal,
        );
      } else {
        try {
          if (!signal?.aborted) {
            const steering = getSteeringAtCheckpoint(config);
            steeringMessages = Array.isArray(steering) ? steering : await steering;
          }
          if (steeringMessages.length > 0) {
            skippedReady = { args: execution.args, startEmitted: true };
            skippedStartIndex = callIndex;
            break;
          }
          const executed = await execution.execute(() =>
            batchLifecycle?.commitReadyCalls([{ toolCallId: toolCall.id, args: execution.args }]),
          );
          finalized = await finalizeExecutedToolCall(
            currentContext,
            assistantMessage,
            preparation,
            executed,
            execution.args,
            config,
            signal,
          );
        } finally {
          execution.dispose();
        }
      }
    }

    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    finalizedCalls.push(finalized);
    messages.push(toolResultMessage);

    if (signal?.aborted) {
      skippedStartIndex = callIndex + 1;
      break;
    }
  }

  // A steer accepted during the final call's awaited preflight or execution
  // must outrank shouldStopAfterTurn even when there is no remaining tail.
  if (!signal?.aborted && steeringMessages.length === 0 && skippedStartIndex === toolCalls.length) {
    const steering = getSteeringAtCheckpoint(config);
    steeringMessages = Array.isArray(steering) ? steering : await steering;
  }

  // Complete the unstarted tail through one lifecycle path so committed tool
  // calls remain paired and outcome hooks observe every synthetic result.
  if (steeringMessages.length > 0) {
    batchLifecycle?.releaseSkippedCalls(
      toolCalls
        .slice(skippedStartIndex)
        .filter((toolCall) => validatedToolCalls.get(toolCall)?.kind === "validated")
        .map((toolCall) => toolCall.id),
    );
  }
  for (let i = skippedStartIndex; i < toolCalls.length; i++) {
    const skippedToolCall = toolCalls[i];
    if (!skippedToolCall) {
      continue;
    }
    const isSteeringSkip = steeringMessages.length > 0;
    const completed = await completeUnstartedToolCall(
      currentContext,
      assistantMessage,
      skippedToolCall,
      resolvedToolCalls,
      config,
      signal,
      emit,
      {
        ...(i === skippedStartIndex && skippedReady ? skippedReady : {}),
        ...(isSteeringSkip
          ? {
              details: { status: "skipped", deniedReason: "steering" },
              message: STEERING_TOOL_SKIP_MESSAGE,
            }
          : {}),
      },
    );
    await emitToolResultMessage(completed.message, emit);
    finalizedCalls.push(completed.finalized);
    messages.push(completed.message);
  }

  return {
    messages,
    steeringMessages,
    terminate: shouldTerminateToolBatch(finalizedCalls),
    terminateRun: false,
  };
}

async function executeToolCallsParallel(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  resolvedToolCalls: Map<AgentToolCall, ResolvedToolCallOutcome>,
  validatedToolCalls: Map<AgentToolCall, ValidatedToolCallOutcome>,
  batchLifecycle: InternalToolBatchLifecycle | undefined,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallEntry[] = [];
  const pendingExecutions = new Set<ReadyToolCallExecution>();

  try {
    for (const toolCall of toolCalls) {
      const hideFromChannelProgress = hidesToolCallFromChannelProgress(
        currentContext,
        toolCall,
        resolvedToolCalls,
      );
      await emit({
        type: "tool_execution_start",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.arguments,
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      });

      const preparation = await prepareToolCall(
        currentContext,
        assistantMessage,
        toolCall,
        config,
        signal,
        resolvedToolCalls,
        validatedToolCalls,
      );
      if (preparation.kind === "immediate") {
        const finalized = await finalizeToolCallOutcome(
          currentContext,
          assistantMessage,
          {
            toolCall,
            result: preparation.result,
            isError: preparation.isError,
            executionStarted: false,
            ...(preparation.errorKind ? { errorKind: preparation.errorKind } : {}),
            ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
          },
          toolCall.arguments,
          config,
          signal,
        );
        await emitToolExecutionEnd(finalized, emit);
        finalizedCalls.push(finalized);
        if (signal?.aborted) {
          break;
        }
        continue;
      }

      const execution = await prepareToolCallExecution(
        preparation,
        { assistantMessage, toolCall: preparation.toolCall },
        signal,
        emit,
      );
      if (execution.kind === "immediate") {
        const finalized = await finalizeExecutedToolCall(
          currentContext,
          assistantMessage,
          preparation,
          execution.outcome,
          preparation.args,
          config,
          signal,
        );
        await emitToolExecutionEnd(finalized, emit);
        finalizedCalls.push(finalized);
        if (signal?.aborted) {
          break;
        }
        continue;
      }

      pendingExecutions.add(execution);
      finalizedCalls.push({ ...preparation, execution });
      if (signal?.aborted) {
        break;
      }
    }

    const steering = signal?.aborted ? [] : getSteeringAtCheckpoint(config);
    const steeringMessages = Array.isArray(steering) ? steering : await steering;
    const skippedToolCallIds = [
      ...(steeringMessages.length > 0
        ? finalizedCalls.flatMap((entry) => ("kind" in entry ? [entry.toolCall.id] : []))
        : []),
      ...(steeringMessages.length > 0
        ? toolCalls.slice(finalizedCalls.length).map((toolCall) => toolCall.id)
        : []),
    ];
    if (skippedToolCallIds.length > 0) {
      batchLifecycle?.releaseSkippedCalls(skippedToolCallIds);
    }
    const orderedFinalizedCalls: FinalizedToolCallOutcome[] = [];
    if (steeringMessages.length > 0) {
      for (const entry of finalizedCalls) {
        if (!("kind" in entry)) {
          orderedFinalizedCalls.push(entry);
          continue;
        }
        entry.execution.dispose();
        pendingExecutions.delete(entry.execution);
        const completed = await completeUnstartedToolCall(
          currentContext,
          assistantMessage,
          entry.toolCall,
          resolvedToolCalls,
          config,
          signal,
          emit,
          {
            args: entry.execution.args,
            details: { status: "skipped", deniedReason: "steering" },
            message: STEERING_TOOL_SKIP_MESSAGE,
            startEmitted: true,
          },
        );
        orderedFinalizedCalls.push(completed.finalized);
      }
    } else {
      orderedFinalizedCalls.push(
        ...(await Promise.all(
          finalizedCalls.map(async (entry) => {
            if (!("kind" in entry)) {
              return entry;
            }
            try {
              const executed = await entry.execution.execute(() =>
                batchLifecycle?.commitReadyCalls([
                  { toolCallId: entry.toolCall.id, args: entry.execution.args },
                ]),
              );
              const finalized = await finalizeExecutedToolCall(
                currentContext,
                assistantMessage,
                entry,
                executed,
                entry.execution.args,
                config,
                signal,
              );
              await emitToolExecutionEnd(finalized, emit);
              return finalized;
            } finally {
              entry.execution.dispose();
              pendingExecutions.delete(entry.execution);
            }
          }),
        )),
      );
    }
    const messages: ToolResultMessage[] = [];
    for (const finalized of orderedFinalizedCalls) {
      const toolResultMessage = createToolResultMessage(finalized);
      await emitToolResultMessage(toolResultMessage, emit);
      messages.push(toolResultMessage);
    }

    // Complete calls skipped before queueing through the same lifecycle contract
    // as the sequential path.
    if (signal?.aborted && orderedFinalizedCalls.length < toolCalls.length) {
      for (let i = orderedFinalizedCalls.length; i < toolCalls.length; i++) {
        const skippedToolCall = toolCalls[i];
        if (!skippedToolCall) {
          continue;
        }
        const completed = await completeUnstartedToolCall(
          currentContext,
          assistantMessage,
          skippedToolCall,
          resolvedToolCalls,
          config,
          signal,
          emit,
        );
        await emitToolResultMessage(completed.message, emit);
        orderedFinalizedCalls.push(completed.finalized);
        messages.push(completed.message);
      }
    }

    return {
      messages,
      steeringMessages,
      terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
      terminateRun: false,
    };
  } finally {
    for (const execution of pendingExecutions) {
      execution.dispose();
    }
  }
}

type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool;
  args: unknown;
};

type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: AgentToolResult<unknown>;
  isError: boolean;
  errorKind?: "argument-validation";
};

type ValidatedToolCallOutcome =
  | { kind: "validated"; prepared: PreparedToolCall }
  | { kind: "immediate"; outcome: ImmediateToolCallOutcome };

type ExecutedToolCallOutcome = {
  result: AgentToolResult<unknown>;
  isError: boolean;
  executionStarted: boolean;
  callerCancelled?: true;
};

type ReadyToolCallExecution = {
  kind: "ready";
  args: unknown;
  execute: (onImplementationStart?: () => void) => Promise<ExecutedToolCallOutcome>;
  dispose: () => void;
};

type PreparedToolCallExecution =
  | { kind: "immediate"; outcome: ExecutedToolCallOutcome }
  | ReadyToolCallExecution;

type ReadyPreparedToolCall = PreparedToolCall & { execution: ReadyToolCallExecution };

type FinalizedToolCallOutcome = {
  toolCall: AgentToolCall;
  result: AgentToolResult<unknown>;
  isError: boolean;
  executionStarted: boolean;
  errorKind?: "argument-validation";
  hideFromChannelProgress?: boolean;
  resultContentSource?: ToolResultContentSource;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | ReadyPreparedToolCall;

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
  return (
    finalizedCalls.length > 0 &&
    finalizedCalls.every((finalized) => finalized.result.terminate === true)
  );
}

function prepareToolCallArguments(tool: AgentTool, toolCall: AgentToolCall): AgentToolCall {
  if (!tool.prepareArguments) {
    return toolCall;
  }
  const preparedArguments = tool.prepareArguments(toolCall.arguments);
  if (preparedArguments === toolCall.arguments) {
    return toolCall;
  }
  return {
    ...toolCall,
    arguments: preparedArguments as Record<string, unknown>,
  };
}

async function resolveToolCallTool(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  resolvedToolCalls?: Map<AgentToolCall, ResolvedToolCallOutcome>,
): Promise<ResolvedToolCallOutcome> {
  const cached = resolvedToolCalls?.get(toolCall);
  if (cached) {
    return cached;
  }
  let resolution: ResolvedToolCallOutcome;
  try {
    let tool = currentContext.tools?.find((t) => t.name === toolCall.name);
    if (!tool) {
      const resolvedTool = await config.resolveDeferredTool?.(
        {
          assistantMessage,
          toolCall,
          context: currentContext,
        },
        signal,
      );
      // Keep execution and lifecycle/audit identity aligned with the original model call.
      if (resolvedTool && resolvedTool.name !== toolCall.name) {
        throw new Error(
          `Deferred tool resolver returned "${resolvedTool.name}" for requested "${toolCall.name}"`,
        );
      }
      tool = resolvedTool;
      if (tool) {
        // Make the recovered tool visible to later provider continuations in this run.
        currentContext.tools = [...(currentContext.tools ?? []), tool];
      }
    }
    resolution = { kind: "resolved", ...(tool ? { tool } : {}) };
  } catch (error) {
    resolution = { kind: "error", error };
  }
  resolvedToolCalls?.set(toolCall, resolution);
  return resolution;
}

async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  resolvedToolCalls: Map<AgentToolCall, ResolvedToolCallOutcome>,
  validatedToolCalls: Map<AgentToolCall, ValidatedToolCallOutcome>,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const cachedValidation = validatedToolCalls.get(toolCall);
  if (signal?.aborted && !cachedValidation) {
    // Execution cannot start after cancellation, so never begin validation
    // work (including deferred tool resolvers) for an uncached call.
    return {
      kind: "immediate",
      result: createErrorToolResult("Operation aborted"),
      isError: true,
    };
  }
  const validation =
    cachedValidation ??
    (await validateToolCallForBatchAdmission(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
      resolvedToolCalls,
    ));
  if (validation.kind === "immediate") {
    return validation.outcome;
  }
  const { args: validatedArgs } = validation.prepared;

  try {
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args: validatedArgs,
          context: currentContext,
        },
        signal,
      );
      if (signal?.aborted) {
        return {
          kind: "immediate",
          result: createErrorToolResult("Operation aborted"),
          isError: true,
        };
      }
      if (beforeResult?.block) {
        return {
          kind: "immediate",
          result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
          isError: true,
        };
      }
    }
    if (signal?.aborted) {
      return {
        kind: "immediate",
        result: createErrorToolResult("Operation aborted"),
        isError: true,
      };
    }
    return validation.prepared;
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(coerceErrorMessage(error)),
      isError: true,
    };
  }
}

async function validateToolCallForBatchAdmission(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  resolvedToolCalls: Map<AgentToolCall, ResolvedToolCallOutcome>,
): Promise<ValidatedToolCallOutcome> {
  const resolution = await resolveToolCallTool(
    currentContext,
    assistantMessage,
    toolCall,
    config,
    signal,
    resolvedToolCalls,
  );
  if (resolution.kind === "error") {
    return {
      kind: "immediate",
      outcome: {
        kind: "immediate",
        result: createErrorToolResult(
          signal?.aborted ? "Operation aborted" : coerceErrorMessage(resolution.error),
        ),
        isError: true,
      },
    };
  }
  const tool = resolution.tool;
  if (!tool) {
    return {
      kind: "immediate",
      outcome: {
        kind: "immediate",
        result: createErrorToolResult(`Tool ${toolCall.name} not found`),
        isError: true,
      },
    };
  }

  let preparedToolCall: AgentToolCall;
  try {
    preparedToolCall = prepareToolCallArguments(tool, toolCall);
  } catch (error) {
    return {
      kind: "immediate",
      outcome: {
        kind: "immediate",
        result: createErrorToolResult(coerceErrorMessage(error)),
        isError: true,
      },
    };
  }

  let validatedArgs: unknown;
  try {
    validatedArgs = validateToolArguments(tool, preparedToolCall);
  } catch (error) {
    return {
      kind: "immediate",
      outcome: {
        kind: "immediate",
        result: createErrorToolResult(coerceErrorMessage(error)),
        isError: true,
        errorKind: "argument-validation",
      },
    };
  }
  return {
    kind: "validated",
    prepared: { kind: "prepared", toolCall, tool, args: validatedArgs },
  };
}

async function prepareToolCallExecution(
  prepared: PreparedToolCall,
  executionContext: AgentToolExecutionContext,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<PreparedToolCallExecution> {
  const updateEvents: Promise<void>[] = [];
  let acceptingUpdates = true;
  const onUpdate = (partialResult: AgentToolResult<unknown>) => {
    if (!acceptingUpdates) {
      return;
    }
    updateEvents.push(
      Promise.resolve(
        emit({
          type: "tool_execution_update",
          toolCallId: prepared.toolCall.id,
          toolName: prepared.toolCall.name,
          args: prepared.toolCall.arguments,
          partialResult,
          ...(prepared.tool.hideFromChannelProgress === true
            ? { hideFromChannelProgress: true }
            : {}),
        }),
      ),
    );
  };
  const finishUpdates = async () => {
    acceptingUpdates = false;
    await Promise.all(updateEvents);
  };
  const immediateError = async (error: unknown): Promise<PreparedToolCallExecution> => {
    await finishUpdates();
    return {
      kind: "immediate",
      outcome: {
        result: createErrorToolResult(coerceErrorMessage(error)),
        isError: true,
        executionStarted: false,
      },
    };
  };
  const readyExecution = (
    args: unknown,
    run: (onImplementationStart: () => void) => Promise<AgentToolResult<unknown>>,
    disposeSource: () => void = () => {},
  ): ReadyToolCallExecution => {
    let disposed = false;
    const dispose = () => {
      if (!disposed) {
        disposed = true;
        acceptingUpdates = false;
        disposeSource();
      }
    };
    return {
      kind: "ready",
      args,
      dispose,
      async execute(onImplementationStart) {
        if (signal?.aborted) {
          dispose();
          await finishUpdates();
          return {
            result: createErrorToolResult("Operation aborted"),
            isError: true,
            executionStarted: false,
          };
        }
        let executionStarted = false;
        let implementationStartError: { error: unknown } | undefined;
        try {
          const result = await run(() => {
            try {
              onImplementationStart?.();
            } catch (error) {
              implementationStartError = { error };
              throw error;
            }
            executionStarted = true;
          });
          if (implementationStartError) {
            throw implementationStartError.error;
          }
          await finishUpdates();
          return { result, isError: false, executionStarted };
        } catch (error) {
          await finishUpdates();
          if (implementationStartError) {
            throw implementationStartError.error;
          }
          return {
            result: createErrorToolResult(coerceErrorMessage(error)),
            isError: true,
            executionStarted,
            ...(executionStarted && signal?.aborted && error === signal.reason
              ? { callerCancelled: true }
              : {}),
          };
        } finally {
          dispose();
        }
      },
    };
  };
  const preparer = getInternalToolExecutionPreparer(prepared.tool);

  if (!preparer) {
    return readyExecution(prepared.args, async (onImplementationStart) => {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Operation aborted");
      }
      return await runWithAgentToolExecutionContext(executionContext, () => {
        onImplementationStart();
        return prepared.tool.execute(
          prepared.toolCall.id,
          prepared.args as never,
          signal,
          onUpdate,
        );
      });
    });
  }

  let internalPreparation: InternalToolExecutionPreparation;
  try {
    internalPreparation = await runWithAgentToolExecutionContext(executionContext, () =>
      preparer({
        toolCallId: prepared.toolCall.id,
        args: prepared.args,
        ...(signal ? { signal } : {}),
        onUpdate,
      }),
    );
  } catch (error) {
    return await immediateError(error);
  }

  if (internalPreparation.kind === "immediate") {
    internalPreparation.dispose();
    await finishUpdates();
    if (internalPreparation.outcome.kind === "result") {
      return {
        kind: "immediate",
        outcome: {
          result: internalPreparation.outcome.result,
          isError: internalPreparation.outcome.isError,
          executionStarted: false,
        },
      };
    }
    return {
      kind: "immediate",
      outcome: {
        result: createErrorToolResult(coerceErrorMessage(internalPreparation.outcome.error)),
        isError: true,
        executionStarted: false,
      },
    };
  }

  const readyPreparation = internalPreparation;
  return readyExecution(
    readyPreparation.args,
    (onImplementationStart) =>
      runWithAgentToolExecutionContext(executionContext, () =>
        readyPreparation.execute(onImplementationStart),
      ),
    readyPreparation.dispose,
  );
}

async function finalizeExecutedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  finalArgs: unknown,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (executed.executionStarted && config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: finalArgs,
          result,
          isError,
          context: currentContext,
        },
        signal,
      );
      if (afterResult) {
        result = {
          ...result,
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(coerceErrorMessage(error));
      isError = true;
    }
  }

  return await finalizeToolCallOutcome(
    currentContext,
    assistantMessage,
    {
      toolCall: prepared.toolCall,
      result,
      isError,
      executionStarted: executed.executionStarted,
      ...(prepared.tool.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
      ...(executed.executionStarted &&
      !executed.callerCancelled &&
      prepared.tool.resultContentSource
        ? { resultContentSource: prepared.tool.resultContentSource }
        : {}),
    },
    finalArgs,
    config,
    signal,
  );
}

async function finalizeToolCallOutcome(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  finalized: FinalizedToolCallOutcome,
  args: unknown,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
  if (!config.afterToolOutcome) {
    return finalized;
  }
  try {
    const afterResult = await config.afterToolOutcome(
      {
        assistantMessage,
        toolCall: finalized.toolCall,
        args,
        result: finalized.result,
        isError: finalized.isError,
        executionStarted: finalized.executionStarted,
        ...(finalized.errorKind ? { errorKind: finalized.errorKind } : {}),
        context: currentContext,
      },
      signal,
    );
    if (!afterResult) {
      return finalized;
    }
    return {
      ...finalized,
      result: {
        ...finalized.result,
        content: afterResult.content ?? finalized.result.content,
        details: afterResult.details ?? finalized.result.details,
        terminate: afterResult.terminate ?? finalized.result.terminate,
      },
      isError: afterResult.isError ?? finalized.isError,
    };
  } catch (error) {
    const errorResult = createErrorToolResult(coerceErrorMessage(error));
    return {
      ...finalized,
      result: {
        ...errorResult,
        ...(finalized.result.terminate === undefined
          ? {}
          : { terminate: finalized.result.terminate }),
      },
      isError: true,
    };
  }
}

async function completeToolLoopInterventionBatch(params: {
  currentContext: AgentContext;
  assistantMessage: AssistantMessage;
  toolCalls: AgentToolCall[];
  resolvedToolCalls: Map<AgentToolCall, ResolvedToolCallOutcome>;
  validatedToolCalls: Map<AgentToolCall, ValidatedToolCallOutcome>;
  config: AgentLoopConfig;
  signal: AbortSignal | undefined;
  emit: AgentEventSink;
  intervention: ToolLoopIntervention;
  terminal: boolean;
}): Promise<ExecutedToolCallBatch> {
  const messages: ToolResultMessage[] = [];
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  for (const toolCall of params.toolCalls) {
    const hideFromChannelProgress = hidesToolCallFromChannelProgress(
      params.currentContext,
      toolCall,
      params.resolvedToolCalls,
    );
    await params.emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    });
    const isTrigger = toolCall.id === params.intervention.toolCallId;
    const text = params.terminal
      ? isTrigger
        ? `${params.intervention.reason}\n\nCritical tool-loop recovery failed because another critical loop was detected. This run is stopping now.`
        : "This tool was not executed because another call in the batch repeated a critical tool loop. This run is stopping now."
      : isTrigger
        ? `${params.intervention.reason}\n\nDo not repeat this exact tool action. Reassess the task. You may answer the user, ask for clarification, or continue with a different tool or different arguments.`
        : "This tool was not executed because another call in the batch triggered critical tool-loop recovery. Reassess the task before choosing the next action.";
    const validation = params.validatedToolCalls.get(toolCall);
    // Rejected calls never start executing, so they must not inherit the
    // resolved tool's result content source; that metadata is only truthful
    // after execution starts and would otherwise taint the recovery turn.
    const finalized = await finalizeToolCallOutcome(
      params.currentContext,
      params.assistantMessage,
      {
        toolCall,
        result: {
          content: [{ type: "text", text }],
          details: {
            status: "blocked",
            deniedReason: "tool-loop",
            intervention: params.intervention,
          },
          ...(params.terminal ? { terminate: true } : {}),
        },
        isError: true,
        executionStarted: false,
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
      validation?.kind === "validated" ? validation.prepared.args : toolCall.arguments,
      params.config,
      params.signal,
    );
    await emitToolExecutionEnd(finalized, params.emit);
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, params.emit);
    messages.push(message);
    finalizedCalls.push(finalized);
  }
  return {
    messages,
    steeringMessages: [],
    // A later critical loop always forces termination. During first recovery,
    // honor the outcome hooks: if every finalized outcome says terminate, the
    // batch ends without another provider turn.
    terminate: params.terminal || shouldTerminateToolBatch(finalizedCalls),
    terminateRun: params.terminal,
    intervention: params.intervention,
  };
}

async function completeUnstartedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  resolvedToolCalls: Map<AgentToolCall, ResolvedToolCallOutcome>,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  options: {
    args?: unknown;
    details?: unknown;
    message?: string;
    startEmitted?: boolean;
  } = {},
): Promise<{ finalized: FinalizedToolCallOutcome; message: ToolResultMessage }> {
  const hideFromChannelProgress = hidesToolCallFromChannelProgress(
    currentContext,
    toolCall,
    resolvedToolCalls,
  );
  if (!options.startEmitted) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    });
  }
  const finalized = await finalizeToolCallOutcome(
    currentContext,
    assistantMessage,
    {
      toolCall,
      result: createErrorToolResult(options.message ?? "Operation aborted", options.details),
      isError: true,
      executionStarted: false,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    },
    "args" in options ? options.args : toolCall.arguments,
    config,
    signal,
  );
  await emitToolExecutionEnd(finalized, emit);
  const message = createToolResultMessage(finalized);
  return { finalized, message };
}

function createErrorToolResult(message: string, details: unknown = {}): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}

async function emitToolExecutionEnd(
  finalized: FinalizedToolCallOutcome,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
    executionStarted: finalized.executionStarted,
    ...(finalized.errorKind ? { errorKind: finalized.errorKind } : {}),
    ...(finalized.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
  });
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
  return withToolResultContentSource(
    {
      role: "toolResult",
      toolCallId: finalized.toolCall.id,
      toolName: finalized.toolCall.name,
      content: finalized.result.content ?? [],
      details: finalized.result.details,
      isError: finalized.isError,
      timestamp: Date.now(),
    },
    finalized.resultContentSource,
  );
}

type TurnTaintMetadata = {
  resultContentSource?: ToolResultContentSource;
  turnTainted?: true;
};

function readTurnTaintMetadata(message: AgentMessage): TurnTaintMetadata | undefined {
  const metadata = Reflect.get(message, "__openclaw");
  const record = asOptionalRecord(metadata);
  if (!record) {
    return undefined;
  }
  return {
    ...(record.resultContentSource === "network"
      ? { resultContentSource: record.resultContentSource }
      : {}),
    ...(record.turnTainted === true ? { turnTainted: true } : {}),
  };
}

function toolResultTaintsTurn(message: ToolResultMessage): boolean {
  return readTurnTaintMetadata(message)?.resultContentSource === "network";
}

function isActiveTurnTainted(messages: readonly AgentMessage[]): boolean {
  for (const message of messages.toReversed()) {
    if (message.role === "user") {
      return false;
    }
    const metadata = readTurnTaintMetadata(message);
    if (metadata?.turnTainted === true || metadata?.resultContentSource === "network") {
      return true;
    }
  }
  return false;
}

function withAssistantTurnTaint(message: AssistantMessage, tainted: boolean): AssistantMessage {
  if (!tainted) {
    return message;
  }
  const taintedMessage = {
    ...message,
    __openclaw: { ...readTurnTaintMetadata(message), turnTainted: true },
  } satisfies AssistantMessage & { __openclaw: TurnTaintMetadata };
  return taintedMessage;
}

function withToolResultContentSource(
  message: ToolResultMessage,
  source: ToolResultContentSource | undefined,
): ToolResultMessage {
  if (!source) {
    return message;
  }
  return {
    ...message,
    __openclaw: { ...readTurnTaintMetadata(message), resultContentSource: source },
  } as ToolResultMessage;
}

async function emitToolResultMessage(
  toolResultMessage: ToolResultMessage,
  emit: AgentEventSink,
): Promise<void> {
  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
