// Keep the runtime class on the public package specifier so OpenClaw and
// external consumers share one constructor identity.
import { EventStream as LlmEventStream } from "@openclaw/ai/event-stream";
import type {
  AssistantMessage,
  EventStream,
  ToolResultMessage,
  EventStream as SourceEventStream,
} from "@openclaw/llm-core";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  streamAgentResponse,
  type AgentEventSink,
  type AsyncToolBatchScheduling,
  type ExecutedToolCallBatch,
} from "./agent-stream-response.js";
import { TranscriptNotContinuableError } from "./errors.js";
import {
  appendToolLoopWarning,
  copyInternalToolResultState,
  getInternalToolExecutionPreparer,
  getInternalSyncSteeringGetter,
  type InternalToolExecutionPreparation,
  takeInternalToolBatchLifecycle,
  type InternalToolBatchLifecycle,
} from "./internal-hooks.js";
import { resolveAgentReasoningOption } from "./reasoning.js";
import type { AgentCoreStreamRuntimeDeps } from "./runtime-deps.js";
import {
  type AgentToolExecutionContext,
  runWithAgentToolExecutionContext,
} from "./tool-execution-context.js";
import {
  appendInterruptedTurnMessage,
  createFailureMessage,
  createInterruptedTurnMessage,
  isTurnHandoffAbort,
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
  ToolLoopWarning,
} from "./types.js";
import { validateToolArguments } from "./validation.js";

/** Callback used by synchronous loop runners to publish agent lifecycle events. */
export type { AgentEventSink } from "./agent-stream-response.js";

const EventStreamConstructor: typeof SourceEventStream = LlmEventStream;

const TOOL_LOOP_RECOVERY_TERMINATED_MESSAGE =
  "OpenClaw stopped this run because tool-loop recovery encountered another critical loop. No blocked tool action was executed.";
const STEERING_TOOL_SKIP_MESSAGE = "Skipped due to queued user message.";
const TOOL_ADMISSION_FAILURE_MESSAGE = "Tool execution was blocked before launch.";
const TOOL_ADMISSION_FAILURE_DETAILS = {
  status: "blocked",
  deniedReason: "tool-admission",
} as const;

function getSteeringAtCheckpoint(
  config: AgentLoopConfig,
): AgentMessage[] | Promise<AgentMessage[]> {
  const callback = config.getSteeringMessages;
  if (!callback) {
    return [];
  }
  return getInternalSyncSteeringGetter(callback)?.() ?? callback.call(config);
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
  return streamAgentRun(
    (emit) => runAgentLoop(prompts, context, config, emit, signal, streamFn, runtime),
    config,
    signal,
  );
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
  assertContinuableContext(context);
  return streamAgentRun(
    (emit) => runAgentLoopContinue(context, config, emit, signal, streamFn, runtime),
    config,
    signal,
  );
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
  return runAgentLoopCore(prompts, context, config, emit, signal, streamFn, runtime);
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
  assertContinuableContext(context);
  return runAgentLoopCore([], context, config, emit, signal, streamFn, runtime);
}

function assertContinuableContext(context: AgentContext): void {
  const lastMessage = context.messages.at(-1);
  if (!lastMessage) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (lastMessage.role === "assistant") {
    throw new TranscriptNotContinuableError(lastMessage.role);
  }
}

function streamAgentRun(
  run: (emit: AgentEventSink) => Promise<AgentMessage[]>,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();
  void run((event) => stream.push(event))
    .then((messages) => stream.end(messages))
    .catch((error: unknown) => pushLoopFailure(stream, config, error, signal));
  return stream;
}

async function runAgentLoopCore(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [];
  const state = { context: { ...context, messages: [...context.messages] } };
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    if (config.consumeQueuedMessageCancellation?.(prompt)) {
      continue;
    }
    await emit({ type: "message_start", message: prompt });
    if (config.consumeQueuedMessageCancellation?.(prompt)) {
      continue;
    }
    await emit({ type: "message_end", message: prompt });
    state.context.messages.push(prompt);
    newMessages.push(prompt);
  }
  if (prompts.length > 0 && newMessages.length === 0) {
    // A drained queue batch can be cancelled while turn_start listeners settle.
    // Close without a provider call so cancelled input cannot become an empty continuation.
    await emit({ type: "agent_end", messages: [] });
    return [];
  }
  return runLoop(state, newMessages, config, signal, emit, streamFn, runtime);
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
 * Own one replaceable context slot so this async frame does not retain earlier
 * contexts after a next-turn hook replaces them.
 */
async function runLoop(
  state: { context: AgentContext },
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<AgentMessage[]> {
  let config = initialConfig;
  let firstTurn = true;
  let turnOpen = true;
  let turnTainted = isActiveTurnTainted(state.context.messages);
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
        return newMessages;
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
        let injectedMessage = false;
        pendingMessages = [];
        for (const message of messagesToInject) {
          if (config.consumeQueuedMessageCancellation?.(message)) {
            continue;
          }
          await emit({ type: "message_start", message });
          if (config.consumeQueuedMessageCancellation?.(message)) {
            continue;
          }
          if (message.role === "user") {
            turnTainted = false;
          }
          await emit({ type: "message_end", message });
          state.context.messages.push(message);
          newMessages.push(message);
          injectedMessage = true;
        }
        if (!injectedMessage && !hasMoreToolCalls) {
          // The entire drained batch was cancelled before transcript commit.
          // Re-evaluate the loop instead of issuing an empty provider continuation.
          continue;
        }
      }

      if (await stopIfAborted()) {
        return newMessages;
      }

      // Stream assistant response
      let streamedSteering: AgentMessage[] = [];
      const streamedConfig: AgentLoopConfig = {
        ...config,
        getSteeringMessages: async () => {
          if (streamedSteering.length === 0) {
            streamedSteering = await getSteeringAtCheckpoint(config);
          }
          return streamedSteering;
        },
      };
      const streamed = await streamAgentResponse(
        state.context,
        config,
        signal,
        emit,
        newMessages,
        async (assistantMessage, toolCalls, executionSignal, toolEmit, scheduling) => {
          const batch = await executeToolCalls(
            state.context,
            assistantMessage,
            streamedConfig,
            executionSignal,
            toolEmit,
            toolLoopRecoveryState.criticalToolLoopSeen,
            toolCalls,
            scheduling,
          );
          if (batch.intervention) {
            toolLoopRecoveryState.criticalToolLoopSeen = true;
          }
          return batch;
        },
        (message) => withAssistantTurnTaint(message, turnTainted),
        streamFn,
        runtime,
      );
      const { message } = streamed;

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({
          type: "turn_end",
          message,
          toolResults: streamed.batches.flatMap((batch) => batch.messages),
        });
        if (message.stopReason === "aborted" && signal?.aborted && !isTurnHandoffAbort(signal)) {
          await appendInterruptedTurnMessage(newMessages, emit);
        }
        await emit({ type: "agent_end", messages: newMessages });
        return newMessages;
      }

      const remainingToolCalls = message.content.filter(
        (item): item is AgentToolCall =>
          item.type === "toolCall" &&
          !streamed.executedIds.has(item.id) &&
          (message.stopReason === "toolUse" || item.async === true),
      );
      const terminalToolBatch =
        remainingToolCalls.length > 0
          ? await executeToolCalls(
              state.context,
              message,
              streamedSteering.length > 0 ? streamedConfig : config,
              signal,
              emit,
              toolLoopRecoveryState.criticalToolLoopSeen,
              remainingToolCalls,
            )
          : undefined;
      const batches = [...streamed.batches, ...(terminalToolBatch ? [terminalToolBatch] : [])];
      const executedToolBatch: ExecutedToolCallBatch | undefined = batches.length
        ? {
            messages: batches.flatMap((batch) => batch.messages),
            steeringMessages: [...new Set(batches.flatMap((batch) => batch.steeringMessages))],
            terminate: batches.every((batch) => batch.terminate),
            terminateRun: batches.some((batch) => batch.terminateRun),
            intervention: batches.find((batch) => batch.intervention)?.intervention,
            fatal: batches.find((batch) => batch.fatal)?.fatal,
          }
        : undefined;
      const toolResults = executedToolBatch?.messages ?? [];
      turnTainted ||= toolResults.some(toolResultTaintsTurn);
      hasMoreToolCalls =
        streamed.continuationRequired ||
        (executedToolBatch !== undefined && !executedToolBatch.terminate);
      pendingMessages = executedToolBatch?.steeringMessages ?? [];
      if (executedToolBatch?.intervention) {
        toolLoopRecoveryState.criticalToolLoopSeen = true;
      }
      for (const result of terminalToolBatch?.messages ?? []) {
        state.context.messages.push(result);
        newMessages.push(result);
      }

      await emit({ type: "turn_end", message, toolResults });
      turnOpen = false;
      if (executedToolBatch?.fatal) {
        throw executedToolBatch.fatal.error;
      }
      if (await stopIfAborted()) {
        return newMessages;
      }
      if (executedToolBatch?.terminateRun) {
        const terminalMessage = {
          ...createFailureMessage(
            config.model,
            new Error(TOOL_LOOP_RECOVERY_TERMINATED_MESSAGE),
            false,
          ),
          content: [{ type: "text" as const, text: TOOL_LOOP_RECOVERY_TERMINATED_MESSAGE }],
        };
        state.context.messages.push(terminalMessage);
        newMessages.push(terminalMessage);
        await emit({ type: "turn_start" });
        turnOpen = true;
        await emit({ type: "message_start", message: terminalMessage });
        await emit({ type: "message_end", message: terminalMessage });
        await emit({ type: "turn_end", message: terminalMessage, toolResults: [] });
        turnOpen = false;
        await emit({ type: "agent_end", messages: newMessages });
        return newMessages;
      }

      const nextTurnSnapshot = await config.prepareNextTurn?.({
        message,
        toolResults,
        context: state.context,
        newMessages,
      });
      if (nextTurnSnapshot) {
        state.context = nextTurnSnapshot.context ?? state.context;
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
        return newMessages;
      }

      if (pendingMessages.length === 0) {
        if (
          await config.shouldStopAfterTurn?.({
            message,
            toolResults,
            context: state.context,
            newMessages,
          })
        ) {
          await emit({ type: "agent_end", messages: newMessages });
          return newMessages;
        }

        const steering = getSteeringAtCheckpoint(config);
        pendingMessages = Array.isArray(steering) ? steering : await steering;
      }
      if (await stopIfAborted()) {
        return newMessages;
      }
    }

    pendingMessages = (await config.getFollowUpMessages?.()) || [];
    if (pendingMessages.length === 0) {
      // Recheck after the awaited follow-up drain so agent_end cannot strand an accepted steer.
      const finalSteering = getSteeringAtCheckpoint(config);
      pendingMessages = Array.isArray(finalSteering) ? finalSteering : await finalSteering;
    }
    if (pendingMessages.length === 0) {
      break;
    }
  }

  await emit({ type: "agent_end", messages: newMessages });
  return newMessages;
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
  toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall"),
  scheduling?: AsyncToolBatchScheduling,
): Promise<ExecutedToolCallBatch> {
  const batch: ToolBatchContext = {
    currentContext,
    assistantMessage,
    config,
    signal,
    emit,
    resolved: new Map(),
    validated: new Map(),
    onParallelStarted: scheduling?.onParallelStarted,
  };
  if (config.beforeToolBatch) {
    for (const toolCall of toolCalls) {
      if (signal?.aborted) {
        // Cancellation during an early async resolver must not stall behind
        // the remaining resolvers. Skipped calls stay uncached and complete
        // through the executors' normal aborted-call lifecycle.
        break;
      }
      batch.validated.set(toolCall, await validateToolCallForBatchAdmission(batch, toolCall));
    }
    const calls = toolCalls.flatMap((toolCall) => {
      const validation = batch.validated.get(toolCall);
      return validation?.kind === "prepared"
        ? [{ toolCall, args: validation.args, tool: validation.tool }]
        : [];
    });
    if (calls.length > 0 && !signal?.aborted) {
      const admission = await config.beforeToolBatch(
        { assistantMessage, calls, context: currentContext },
        signal,
      );
      if (admission?.intervention) {
        return await completeToolLoopInterventionBatch(batch, {
          toolCalls,
          intervention: admission.intervention,
          terminal: criticalToolLoopSeen,
        });
      }
      batch.lifecycle = admission ? takeInternalToolBatchLifecycle(admission) : undefined;
      batch.warnings = admission?.warnings;
    }
  }
  let hasSequentialToolCall = false;
  if (config.toolExecution !== "sequential") {
    for (const toolCall of toolCalls) {
      if (signal?.aborted) {
        break;
      }
      const resolution = await resolveToolCallTool(batch, toolCall);
      if (resolution.kind === "resolved" && resolution.tool?.executionMode === "sequential") {
        hasSequentialToolCall = true;
        break;
      }
    }
  }
  const sequential = config.toolExecution === "sequential" || hasSequentialToolCall;
  if (sequential && scheduling) {
    await scheduling.waitForPrevious();
  }
  return executeToolCallGroups(batch, toolCalls, sequential);
}

type ToolBatchContext = {
  currentContext: AgentContext;
  assistantMessage: AssistantMessage;
  config: AgentLoopConfig;
  signal: AbortSignal | undefined;
  emit: AgentEventSink;
  resolved: Map<AgentToolCall, ResolvedToolCallOutcome>;
  validated: Map<AgentToolCall, ValidatedToolCallOutcome>;
  lifecycle?: InternalToolBatchLifecycle;
  warnings?: ToolLoopWarning[];
  onParallelStarted?: () => void;
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

function validatedToolCallIds(batch: ToolBatchContext, calls: AgentToolCall[]): string[] {
  return calls
    .filter((call) => batch.validated.get(call)?.kind === "prepared")
    .map((call) => call.id);
}

async function executeToolCallGroups(
  batch: ToolBatchContext,
  toolCalls: AgentToolCall[],
  sequential: boolean,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];
  let steeringMessages: AgentMessage[] = [];
  let cursor = 0;
  let fatal: ExecutedToolCallBatch["fatal"];

  while (cursor < toolCalls.length) {
    if (sequential && !batch.signal?.aborted) {
      const steering = getSteeringAtCheckpoint(batch.config);
      steeringMessages = Array.isArray(steering) ? steering : await steering;
    }
    if (steeringMessages.length > 0) {
      batch.lifecycle?.releaseSkippedCalls(validatedToolCallIds(batch, toolCalls.slice(cursor)));
      break;
    }

    const entries: FinalizedToolCallEntry[] = [];
    try {
      // Sequential groups commit before preparing the next call. Parallel groups
      // prepare together, then commit in source order after their started work settles.
      while (cursor < toolCalls.length) {
        const toolCall = toolCalls[cursor++];
        if (!toolCall) {
          continue;
        }
        const entry = await prepareToolCallEntry(batch, toolCall);
        entries.push(entry);
        if (!("kind" in entry)) {
          await emitToolExecutionEnd(entry, batch.emit);
        }
        if (sequential || batch.signal?.aborted) {
          break;
        }
      }

      const hasReady = entries.some((entry) => "kind" in entry);
      if (!batch.signal?.aborted && (!sequential || hasReady)) {
        const steering = getSteeringAtCheckpoint(batch.config);
        steeringMessages = Array.isArray(steering) ? steering : await steering;
      }
      const ordered: Array<FinalizedToolCallOutcome | undefined> = entries.map((entry) =>
        "kind" in entry ? undefined : entry,
      );
      const settle = async (
        index: number,
        entry: ReadyPreparedToolCall,
        outcome: ExecutedToolCallOutcome,
      ) => {
        try {
          const finalized = await finalizeExecutedToolCall(
            batch,
            entry,
            outcome,
            entry.execution.args,
          );
          if (sequential) {
            entry.execution.dispose();
          }
          await emitToolExecutionEnd(finalized, batch.emit);
          ordered[index] = finalized;
        } finally {
          entry.execution.dispose();
        }
      };

      const launched =
        steeringMessages.length > 0 || (sequential && !hasReady)
          ? undefined
          : await launchParallelToolCalls(entries, batch.lifecycle);
      // Streamed batches serialize admission until source execution begins.
      // Parallel bodies may overlap; exclusive tools retain the gate until finalization.
      if (!sequential && launched?.started.length && !launched.rejected) {
        batch.onParallelStarted?.();
      }
      for (const { index, entry, outcome } of launched?.completed ?? []) {
        await settle(index, entry, outcome);
      }
      fatal = launched?.rejected ? { error: launched.rejected.error } : undefined;
      const skippedIndex =
        steeringMessages.length > 0 ? 0 : (launched?.rejected?.index ?? entries.length);
      if (sequential && steeringMessages.length > 0) {
        for (const entry of entries) {
          if ("kind" in entry) {
            entry.execution.dispose();
          }
        }
      }
      if (steeringMessages.length > 0 || fatal) {
        const skippedIds = [
          ...entries
            .slice(skippedIndex)
            .flatMap((entry) => ("kind" in entry ? [entry.toolCall.id] : [])),
          ...validatedToolCallIds(batch, toolCalls.slice(cursor)),
        ];
        if (sequential || fatal || skippedIds.length > 0) {
          batch.lifecycle?.releaseSkippedCalls(skippedIds);
        }
      }
      for (let index = skippedIndex; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry || !("kind" in entry)) {
          continue;
        }
        // A sequential admission failure retains preparation until its synthetic
        // transcript commits; parallel and steering skips release before outcome hooks.
        if (!sequential) {
          entry.execution.dispose();
        }
        ordered[index] = await completeUnstartedToolCall(batch, entry.toolCall, {
          reason: fatal ? "admission" : "steering",
          args: entry.execution.args,
          startEmitted: true,
        });
      }
      if (launched) {
        // A later admission rejection cannot settle the batch before its active prefix.
        await Promise.all(
          launched.started.map(async ({ index, entry, outcome }) =>
            settle(index, entry, await outcome),
          ),
        );
      }
      for (const finalized of ordered) {
        if (finalized) {
          messages.push(await emitToolResultMessage(finalized, batch.emit));
          finalizedCalls.push(finalized);
        }
      }
    } finally {
      for (const entry of entries) {
        if ("kind" in entry) {
          entry.execution.dispose();
        }
      }
    }
    if (steeringMessages.length > 0 || fatal || batch.signal?.aborted) {
      break;
    }
  }

  // Steering accepted during the last sequential call must outrank the stop hook,
  // even when there is no unstarted tail. Parallel batches retain their single poll.
  if (sequential && !fatal && !batch.signal?.aborted && steeringMessages.length === 0) {
    const steering = getSteeringAtCheckpoint(batch.config);
    steeringMessages = Array.isArray(steering) ? steering : await steering;
    if (steeringMessages.length > 0) {
      batch.lifecycle?.releaseSkippedCalls([]);
    }
  }
  const skippedReason = fatal ? "admission" : steeringMessages.length > 0 ? "steering" : undefined;
  for (; cursor < toolCalls.length; cursor++) {
    const toolCall = toolCalls[cursor];
    if (!toolCall) {
      continue;
    }
    const finalized = await completeUnstartedToolCall(batch, toolCall, { reason: skippedReason });
    messages.push(await emitToolResultMessage(finalized, batch.emit));
    finalizedCalls.push(finalized);
  }

  return {
    messages,
    steeringMessages,
    terminate: shouldTerminateToolBatch(finalizedCalls),
    terminateRun: false,
    ...(fatal ? { fatal } : {}),
  };
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

type ValidatedToolCallOutcome = PreparedToolCall | ImmediateToolCallOutcome;

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

type StartedToolCall = {
  index: number;
  entry: ReadyPreparedToolCall;
  outcome: Promise<ExecutedToolCallOutcome>;
};

type ParallelToolCallLaunches = {
  started: StartedToolCall[];
  completed: Array<Omit<StartedToolCall, "outcome"> & { outcome: ExecutedToolCallOutcome }>;
  rejected?: { index: number; error: unknown };
};

async function prepareToolCallEntry(
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
): Promise<FinalizedToolCallEntry> {
  const hideFromChannelProgress = hidesToolCallFromChannelProgress(
    batch.currentContext,
    toolCall,
    batch.resolved,
  );
  await batch.emit({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
    ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
  });
  const preparation = await prepareToolCall(batch, toolCall);
  if (preparation.kind === "immediate") {
    return await finalizeToolCallOutcome(
      batch,
      {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
        executionStarted: false,
        ...(preparation.errorKind ? { errorKind: preparation.errorKind } : {}),
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
      toolCall.arguments,
    );
  }
  const execution = await prepareToolCallExecution(
    preparation,
    { assistantMessage: batch.assistantMessage, toolCall: preparation.toolCall },
    batch.signal,
    batch.emit,
  );
  return execution.kind === "immediate"
    ? await finalizeExecutedToolCall(batch, preparation, execution.outcome, preparation.args)
    : { ...preparation, execution };
}

async function launchParallelToolCalls(
  entries: FinalizedToolCallEntry[],
  batchLifecycle: InternalToolBatchLifecycle | undefined,
): Promise<ParallelToolCallLaunches> {
  const ready = entries.flatMap((entry, index) => ("kind" in entry ? [{ entry, index }] : []));
  const result: ParallelToolCallLaunches = { started: [], completed: [] };
  let cursor = 0;
  let finish!: () => void;
  let finished = false;
  const done = new Promise<void>((resolve) => {
    finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };
  });
  const launchNext = () => {
    const current = ready[cursor++];
    if (!current) {
      finish();
      return;
    }
    const launchState: { outcome?: Promise<ExecutedToolCallOutcome> } = {};
    let started = false;
    let rejected = false;
    const onStart = () => {
      try {
        batchLifecycle?.commitReadyCalls([
          { toolCallId: current.entry.toolCall.id, args: current.entry.execution.args },
        ]);
      } catch (error) {
        rejected = true;
        result.rejected = { index: current.index, error };
        finish();
        throw error;
      }
      started = true;
      if (launchState.outcome) {
        result.started.push({ ...current, outcome: launchState.outcome });
      }
      // Advance only from the final source-start callback so guard → commit → implementation stays
      // adjacent while started bodies overlap; pre-source completion advances below without commit.
      queueMicrotask(launchNext);
    };
    const outcome = current.entry.execution.execute(onStart);
    launchState.outcome = outcome;
    if (started) {
      result.started.push({ ...current, outcome });
    }
    void outcome.then(
      (completed) => {
        if (!started && !rejected) {
          result.completed.push({ ...current, outcome: completed });
          queueMicrotask(launchNext);
        }
      },
      (error: unknown) => {
        if (!rejected) {
          result.rejected = { index: current.index, error };
          finish();
        }
      },
    );
  };
  launchNext();
  await done;
  return result;
}

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
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
): Promise<ResolvedToolCallOutcome> {
  const cached = batch.resolved.get(toolCall);
  if (cached) {
    return cached;
  }
  let resolution: ResolvedToolCallOutcome;
  try {
    let tool = batch.currentContext.tools?.find((t) => t.name === toolCall.name);
    if (!tool) {
      const resolvedTool = await batch.config.resolveDeferredTool?.(
        {
          assistantMessage: batch.assistantMessage,
          toolCall,
          context: batch.currentContext,
        },
        batch.signal,
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
        batch.currentContext.tools = [...(batch.currentContext.tools ?? []), tool];
      }
    }
    resolution = { kind: "resolved", ...(tool ? { tool } : {}) };
  } catch (error) {
    resolution = { kind: "error", error };
  }
  batch.resolved.set(toolCall, resolution);
  return resolution;
}

async function prepareToolCall(
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const cachedValidation = batch.validated.get(toolCall);
  if (batch.signal?.aborted && !cachedValidation) {
    // Execution cannot start after cancellation, so never begin validation
    // work (including deferred tool resolvers) for an uncached call.
    return {
      kind: "immediate",
      result: createErrorToolResult("Operation aborted"),
      isError: true,
    };
  }
  const validation = cachedValidation ?? (await validateToolCallForBatchAdmission(batch, toolCall));
  if (validation.kind === "immediate") {
    return validation;
  }
  const { args: validatedArgs } = validation;

  try {
    if (batch.config.beforeToolCall) {
      const beforeResult = await batch.config.beforeToolCall(
        {
          assistantMessage: batch.assistantMessage,
          toolCall,
          args: validatedArgs,
          context: batch.currentContext,
        },
        batch.signal,
      );
      if (batch.signal?.aborted) {
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
    if (batch.signal?.aborted) {
      return {
        kind: "immediate",
        result: createErrorToolResult("Operation aborted"),
        isError: true,
      };
    }
    return validation;
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(coerceErrorMessage(error)),
      isError: true,
    };
  }
}

async function validateToolCallForBatchAdmission(
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
): Promise<ValidatedToolCallOutcome> {
  const resolution = await resolveToolCallTool(batch, toolCall);
  if (resolution.kind === "error") {
    return {
      kind: "immediate",
      result: createErrorToolResult(
        batch.signal?.aborted ? "Operation aborted" : coerceErrorMessage(resolution.error),
      ),
      isError: true,
    };
  }
  const tool = resolution.tool;
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
    };
  }

  let preparedToolCall: AgentToolCall;
  try {
    preparedToolCall = prepareToolCallArguments(tool, toolCall);
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(coerceErrorMessage(error)),
      isError: true,
    };
  }

  let validatedArgs: unknown;
  try {
    validatedArgs = validateToolArguments(tool, preparedToolCall);
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(coerceErrorMessage(error)),
      isError: true,
      errorKind: "argument-validation",
    };
  }
  return { kind: "prepared", toolCall, tool, args: validatedArgs };
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
        let executionStarted = false;
        let implementationStartError: { error: unknown } | undefined;
        try {
          if (signal?.aborted) {
            return {
              result: createErrorToolResult("Operation aborted"),
              isError: true,
              executionStarted: false,
            };
          }
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
            return { result, isError: false, executionStarted };
          } catch (error) {
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
          }
        } finally {
          await finishUpdates();
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
    return {
      kind: "immediate",
      outcome:
        internalPreparation.outcome.kind === "result"
          ? {
              result: internalPreparation.outcome.result,
              isError: internalPreparation.outcome.isError,
              executionStarted: false,
            }
          : {
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
  batch: ToolBatchContext,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  finalArgs: unknown,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (executed.executionStarted && batch.config.afterToolCall) {
    try {
      const afterResult = await batch.config.afterToolCall(
        {
          assistantMessage: batch.assistantMessage,
          toolCall: prepared.toolCall,
          args: finalArgs,
          result,
          isError,
          context: batch.currentContext,
        },
        batch.signal,
      );
      if (afterResult) {
        result = copyInternalToolResultState(result, {
          ...result,
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        });
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(coerceErrorMessage(error));
      isError = true;
    }
  }

  return await finalizeToolCallOutcome(
    batch,
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
  );
}

async function finalizeToolCallOutcome(
  batch: ToolBatchContext,
  finalized: FinalizedToolCallOutcome,
  args: unknown,
): Promise<FinalizedToolCallOutcome> {
  const outcome = await applyToolOutcomeHook(batch, finalized, args);
  const warning = batch.warnings?.find((entry) => entry.toolCallId === outcome.toolCall.id);
  return warning ? { ...outcome, result: appendToolLoopWarning(outcome.result, warning) } : outcome;
}

async function applyToolOutcomeHook(
  batch: ToolBatchContext,
  finalized: FinalizedToolCallOutcome,
  args: unknown,
): Promise<FinalizedToolCallOutcome> {
  if (!batch.config.afterToolOutcome) {
    return finalized;
  }
  try {
    const afterResult = await batch.config.afterToolOutcome(
      {
        assistantMessage: batch.assistantMessage,
        toolCall: finalized.toolCall,
        args,
        result: finalized.result,
        isError: finalized.isError,
        executionStarted: finalized.executionStarted,
        ...(finalized.errorKind ? { errorKind: finalized.errorKind } : {}),
        context: batch.currentContext,
      },
      batch.signal,
    );
    if (!afterResult) {
      return finalized;
    }
    return {
      ...finalized,
      result: copyInternalToolResultState(finalized.result, {
        ...finalized.result,
        content: afterResult.content ?? finalized.result.content,
        details: afterResult.details ?? finalized.result.details,
        terminate: afterResult.terminate ?? finalized.result.terminate,
      }),
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

async function completeToolLoopInterventionBatch(
  batch: ToolBatchContext,
  params: {
    toolCalls: AgentToolCall[];
    intervention: ToolLoopIntervention;
    terminal: boolean;
  },
): Promise<ExecutedToolCallBatch> {
  const messages: ToolResultMessage[] = [];
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  for (const toolCall of params.toolCalls) {
    const hideFromChannelProgress = hidesToolCallFromChannelProgress(
      batch.currentContext,
      toolCall,
      batch.resolved,
    );
    await batch.emit({
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
    const validation = batch.validated.get(toolCall);
    // Rejected calls never start executing, so they must not inherit the
    // resolved tool's result content source; that metadata is only truthful
    // after execution starts and would otherwise taint the recovery turn.
    const finalized = await finalizeToolCallOutcome(
      batch,
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
      validation?.kind === "prepared" ? validation.args : toolCall.arguments,
    );
    await emitToolExecutionEnd(finalized, batch.emit);
    messages.push(await emitToolResultMessage(finalized, batch.emit));
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
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
  options: {
    args?: unknown;
    reason?: "admission" | "steering";
    startEmitted?: boolean;
  } = {},
): Promise<FinalizedToolCallOutcome> {
  const hideFromChannelProgress = hidesToolCallFromChannelProgress(
    batch.currentContext,
    toolCall,
    batch.resolved,
  );
  if (!options.startEmitted) {
    await batch.emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    });
  }
  const finalized = await finalizeToolCallOutcome(
    batch,
    {
      toolCall,
      result: createErrorToolResult(
        options.reason === "admission"
          ? TOOL_ADMISSION_FAILURE_MESSAGE
          : options.reason === "steering"
            ? STEERING_TOOL_SKIP_MESSAGE
            : "Operation aborted",
        options.reason === "admission"
          ? TOOL_ADMISSION_FAILURE_DETAILS
          : options.reason === "steering"
            ? { status: "skipped", deniedReason: "steering" }
            : undefined,
      ),
      isError: true,
      executionStarted: false,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    },
    "args" in options ? options.args : toolCall.arguments,
  );
  await emitToolExecutionEnd(finalized, batch.emit);
  return finalized;
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

async function emitToolResultMessage(
  finalized: FinalizedToolCallOutcome,
  emit: AgentEventSink,
): Promise<ToolResultMessage> {
  const message = copyInternalToolResultState(
    finalized.result,
    withToolResultContentSource(
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
    ),
  );
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
  return message;
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
