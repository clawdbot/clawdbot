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
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { TranscriptNotContinuableError } from "./errors.js";
import { uuidv7 } from "./harness/session/uuid.js";
import {
  copyInternalToolResultAcknowledgement,
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
const REPEATED_TOOL_ERROR_LIMIT = 2;

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

type RepeatedToolErrorState = {
  lastKey?: string;
  repeatCount: number;
};

type RepeatedToolErrorArgumentSummary = {
  normalizedHash: string;
  normalizedLength: number;
};

type RepeatedToolErrorDiagnostic = {
  toolName: string;
  argumentSummary: RepeatedToolErrorArgumentSummary;
  error: string;
  repeatCount: number;
};

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

function normalizeToolErrorValue(value: unknown): unknown {
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeToolErrorValue(entry)]),
    );
  }
  if (Array.isArray(value)) {
    return value.map(normalizeToolErrorValue);
  }
  return value;
}

function stringifyNormalizedToolErrorValue(value: unknown): string {
  return JSON.stringify(normalizeToolErrorValue(value)) ?? "null";
}

function toSnakeCaseToolArgKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function readToolArg(record: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(record, key)) {
    return record[key];
  }
  const snakeKey = toSnakeCaseToolArgKey(key);
  return snakeKey !== key && Object.hasOwn(record, snakeKey) ? record[snakeKey] : undefined;
}

function normalizeOptionalToolString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalToolNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOptionalToolStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return value === undefined ? undefined : [`<${typeof value}>`];
  }
  const normalized = value.flatMap((entry) => {
    const text = normalizeOptionalToolString(entry);
    return text ? [text] : [];
  });
  return normalized.length > 0 ? [...new Set(normalized)].toSorted() : undefined;
}

function normalizeContinueDelegateToolErrorArguments(args: unknown): unknown {
  if (!isRecord(args)) {
    return normalizeToolErrorValue(args);
  }

  const record = args;
  const task = normalizeOptionalToolString(readToolArg(record, "task"));
  const delaySeconds = normalizeOptionalToolNumber(readToolArg(record, "delaySeconds"));
  const mode = normalizeOptionalToolString(readToolArg(record, "mode"))?.toLowerCase();
  const targetSessionKey = normalizeOptionalToolString(readToolArg(record, "targetSessionKey"));
  const targetSessionKeys = normalizeOptionalToolStringArray(
    readToolArg(record, "targetSessionKeys"),
  );
  const fanoutMode = normalizeOptionalToolString(readToolArg(record, "fanoutMode"))?.toLowerCase();
  const model = normalizeOptionalToolString(readToolArg(record, "model"));

  return normalizeToolErrorValue({
    ...(task ? { task } : {}),
    ...(delaySeconds !== undefined ? { delaySeconds } : {}),
    ...(mode && mode !== "normal" ? { mode } : {}),
    ...(targetSessionKey ? { targetSessionKey } : {}),
    ...(targetSessionKeys ? { targetSessionKeys } : {}),
    ...(fanoutMode ? { fanoutMode } : {}),
    ...(model && model.toLowerCase() !== "default" ? { model } : {}),
  });
}

function normalizeToolErrorArguments(toolName: string, args: unknown): unknown {
  if (toolName === "continue_delegate") {
    return normalizeContinueDelegateToolErrorArguments(args);
  }
  return normalizeToolErrorValue(args);
}

function sanitizeToolErrorText(error: string): string {
  return error
    .replace(/\bhttps?:\/\/[^\s"'`<>]+/gi, "[url]")
    .replace(/\bagent:[^\s,;)\]}]+/gi, "agent:[redacted]")
    .replace(
      /\bauthorization\s*[:=]\s*(?:(?:bearer|basic|bot|token)\s+)?[^\s,;]+/gi,
      "authorization=[redacted]",
    )
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization|credential|session(?:_id)?|traceparent)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/(^|[\s(["'=])((?:~|\.{1,2}|[A-Za-z]:)?\/[^\s"'`)>,;]+)/g, "$1[path]")
    .replace(/"[^"\n]{1,200}"/g, '"[redacted]"')
    .replace(/'[^'\n]{1,200}'/g, "'[redacted]'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1024);
}

function normalizeToolErrorKey(error: string): string {
  return sanitizeToolErrorText(error)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, "[id]")
    .replace(/\b\d{4,}\b/g, "[number]");
}

function summarizeNormalizedToolErrorArguments(
  normalizedArgs: string,
): RepeatedToolErrorArgumentSummary {
  const redactedArgs = sanitizeToolErrorText(normalizedArgs);
  let hash = 0x811c9dc5;
  for (let index = 0; index < redactedArgs.length; index += 1) {
    hash ^= redactedArgs.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return {
    normalizedHash: hash.toString(16).padStart(8, "0"),
    normalizedLength: redactedArgs.length,
  };
}

function extractToolResultErrorText(result: ToolResultMessage): string {
  const details = result.details;
  if (isRecord(details)) {
    if (typeof details.error === "string" && details.error.trim()) {
      return details.error.trim();
    }
    if (typeof details.message === "string" && details.message.trim()) {
      return details.message.trim();
    }
  }
  return result.content
    .flatMap((entry) => (entry.type === "text" ? [entry.text.trim()] : []))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function observeRepeatedToolError(params: {
  state: RepeatedToolErrorState;
  assistantMessage: AssistantMessage;
  toolResults: ToolResultMessage[];
}): RepeatedToolErrorDiagnostic | undefined {
  if (params.toolResults.length === 0) {
    params.state.lastKey = undefined;
    params.state.repeatCount = 0;
    return undefined;
  }

  const failures = params.toolResults
    .filter((result) => result.isError)
    .flatMap((result) => {
      const toolCall = params.assistantMessage.content.find(
        (entry): entry is AgentToolCall =>
          entry.type === "toolCall" &&
          entry.id === result.toolCallId &&
          entry.name === result.toolName,
      );
      const extractedError = extractToolResultErrorText(result);
      const sanitizedError = sanitizeToolErrorText(extractedError) || "Tool call failed.";
      return toolCall
        ? [
            {
              toolName: result.toolName,
              normalizedArgs: stringifyNormalizedToolErrorValue(
                normalizeToolErrorArguments(result.toolName, toolCall.arguments),
              ),
              error: sanitizedError,
              errorKey: normalizeToolErrorKey(extractedError || sanitizedError),
            },
          ]
        : [];
    });
  if (failures.length === 0) {
    params.state.lastKey = undefined;
    params.state.repeatCount = 0;
    return undefined;
  }
  const canonicalFailures = failures
    .map((failure) => ({
      toolName: failure.toolName,
      normalizedArgs: failure.normalizedArgs,
      errorKey: failure.errorKey,
    }))
    .toSorted((left, right) =>
      stringifyNormalizedToolErrorValue(left).localeCompare(
        stringifyNormalizedToolErrorValue(right),
      ),
    );
  const key = stringifyNormalizedToolErrorValue(canonicalFailures);
  params.state.repeatCount = params.state.lastKey === key ? params.state.repeatCount + 1 : 1;
  params.state.lastKey = key;
  if (params.state.repeatCount < REPEATED_TOOL_ERROR_LIMIT) {
    return undefined;
  }
  const primary = failures[0];
  if (!primary) {
    throw new Error("Expected at least one repeated tool error failure.");
  }
  const argumentSummarySource =
    failures.length === 1
      ? primary.normalizedArgs
      : stringifyNormalizedToolErrorValue(
          failures.map((failure) => failure.normalizedArgs).toSorted(),
        );
  return {
    toolName: failures.length === 1 ? primary.toolName : `${failures.length} tools`,
    argumentSummary: summarizeNormalizedToolErrorArguments(argumentSummarySource),
    error:
      failures.length === 1 ? primary.error : failures.map((failure) => failure.error).join("; "),
    repeatCount: params.state.repeatCount,
  };
}

function createRepeatedToolErrorAssistantMessage(
  config: AgentLoopConfig,
  diagnostic: RepeatedToolErrorDiagnostic,
): AssistantMessage {
  const text =
    `Stopped after ${diagnostic.repeatCount} identical failed ${diagnostic.toolName} tool calls. ` +
    diagnostic.error;
  const errorMessage = "Repeated tool-call failure loop.";
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: config.model.api,
    provider: config.model.provider,
    model: config.model.id,
    usage: createFailureMessage(config.model, errorMessage, false).usage,
    stopReason: "error",
    errorMessage,
    errorCode: "repeated_tool_error",
    errorType: "tool_error_loop",
    diagnostics: [
      {
        type: "repeated_tool_error",
        timestamp: Date.now(),
        error: {
          name: "RepeatedToolError",
          message: errorMessage,
          code: "repeated_tool_error",
        },
        details: {
          toolName: diagnostic.toolName,
          argumentSummary: diagnostic.argumentSummary,
          error: diagnostic.error,
          repeatCount: diagnostic.repeatCount,
          disposition: "terminated",
        },
      },
    ],
    timestamp: Date.now(),
  };
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
  const currentContext = { ...context, messages: [...context.messages] };
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
    currentContext.messages.push(prompt);
    newMessages.push(prompt);
  }
  if (prompts.length > 0 && newMessages.length === 0) {
    // A drained queue batch can be cancelled while turn_start listeners settle.
    // Close without a provider call so cancelled input cannot become an empty continuation.
    await emit({ type: "agent_end", messages: [] });
    return [];
  }
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
  let modelRequestOrdinal = 0;
  const repeatedToolErrorState: RepeatedToolErrorState = { repeatCount: 0 };
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
          currentContext.messages.push(message);
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
        () => ++modelRequestOrdinal,
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
      let fatalToolBatch: ExecutedToolCallBatch["fatal"];
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
        fatalToolBatch = executedToolBatch.fatal;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      } else if (message.stopReason !== "toolUse") {
        repeatedToolErrorState.lastKey = undefined;
        repeatedToolErrorState.repeatCount = 0;
      }

      await emit({ type: "turn_end", message, toolResults });
      turnOpen = false;
      if (fatalToolBatch) {
        throw fatalToolBatch.error;
      }
      const repeatedToolError = observeRepeatedToolError({
        state: repeatedToolErrorState,
        assistantMessage: message,
        toolResults,
      });
      if (repeatedToolError) {
        const terminalMessage = createRepeatedToolErrorAssistantMessage(config, repeatedToolError);
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
  nextModelRequestOrdinal?: () => number,
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
    requestId:
      config.requestId ??
      (config.sessionId && nextModelRequestOrdinal
        ? `${config.sessionId}:model:${nextModelRequestOrdinal()}`
        : undefined),
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
  const batch: ToolBatchContext = {
    currentContext,
    assistantMessage,
    config,
    signal,
    emit,
    resolved: new Map(),
    validated: new Map(),
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
        return await completeToolLoopInterventionBatch(batch, {
          toolCalls,
          intervention: admission.intervention,
          terminal: criticalToolLoopSeen,
        });
      }
      batch.lifecycle = admission ? takeInternalToolBatchLifecycle(admission) : undefined;
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
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(batch, toolCalls);
  }
  return executeToolCallsParallel(batch, toolCalls);
}

type ExecutedToolCallBatch = {
  messages: ToolResultMessage[];
  steeringMessages: AgentMessage[];
  terminate: boolean;
  terminateRun: boolean;
  intervention?: ToolLoopIntervention;
  fatal?: { error: unknown };
};

type ToolBatchContext = {
  currentContext: AgentContext;
  assistantMessage: AssistantMessage;
  config: AgentLoopConfig;
  signal: AbortSignal | undefined;
  emit: AgentEventSink;
  resolved: Map<AgentToolCall, ResolvedToolCallOutcome>;
  validated: Map<AgentToolCall, ValidatedToolCallOutcome>;
  lifecycle?: InternalToolBatchLifecycle;
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
    .filter((call) => batch.validated.get(call)?.kind === "validated")
    .map((call) => call.id);
}

async function executeToolCallsSequential(
  batch: ToolBatchContext,
  toolCalls: AgentToolCall[],
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];
  let steeringMessages: AgentMessage[] = [];
  let skippedReady: { args: unknown; startEmitted: true } | undefined;
  let skippedStartIndex = toolCalls.length;
  let fatal: ExecutedToolCallBatch["fatal"];

  for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
    const toolCall = toolCalls[callIndex];
    if (!toolCall) {
      continue;
    }
    if (!batch.signal?.aborted) {
      const steering = getSteeringAtCheckpoint(batch.config);
      steeringMessages = Array.isArray(steering) ? steering : await steering;
    }
    if (steeringMessages.length > 0) {
      skippedStartIndex = callIndex;
      break;
    }
    const entry = await prepareToolCallEntry(batch, toolCall);
    let finalized: FinalizedToolCallOutcome;
    if (!("kind" in entry)) {
      finalized = entry;
    } else {
      try {
        if (!batch.signal?.aborted) {
          const steering = getSteeringAtCheckpoint(batch.config);
          steeringMessages = Array.isArray(steering) ? steering : await steering;
        }
        if (steeringMessages.length > 0) {
          skippedReady = { args: entry.execution.args, startEmitted: true };
          skippedStartIndex = callIndex;
          break;
        }
        const launches = await launchParallelToolCalls([entry], batch.lifecycle);
        if (launches.rejected) {
          fatal = { error: launches.rejected.error };
          batch.lifecycle?.releaseSkippedCalls(
            validatedToolCallIds(batch, toolCalls.slice(callIndex)),
          );
          const completed = await completeUnstartedToolCall(batch, toolCall, {
            args: entry.execution.args,
            details: TOOL_ADMISSION_FAILURE_DETAILS,
            message: TOOL_ADMISSION_FAILURE_MESSAGE,
            startEmitted: true,
          });
          await emitToolResultMessage(completed.message, batch.emit);
          finalizedCalls.push(completed.finalized);
          messages.push(completed.message);
          skippedStartIndex = callIndex + 1;
          break;
        }
        let executed = launches.completed[0]?.outcome;
        if (!executed) {
          const startedOutcome = launches.started[0]?.outcome;
          if (!startedOutcome) {
            throw new Error("Tool launch finished without an outcome");
          }
          executed = await startedOutcome;
        }
        finalized = await finalizeExecutedToolCall(batch, entry, executed, entry.execution.args);
      } finally {
        entry.execution.dispose();
      }
    }

    await emitToolExecutionEnd(finalized, batch.emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, batch.emit);
    finalizedCalls.push(finalized);
    messages.push(toolResultMessage);

    if (batch.signal?.aborted) {
      skippedStartIndex = callIndex + 1;
      break;
    }
  }

  // A steer accepted during the final call's awaited preflight or execution
  // must outrank shouldStopAfterTurn even when there is no remaining tail.
  if (
    !fatal &&
    !batch.signal?.aborted &&
    steeringMessages.length === 0 &&
    skippedStartIndex === toolCalls.length
  ) {
    const steering = getSteeringAtCheckpoint(batch.config);
    steeringMessages = Array.isArray(steering) ? steering : await steering;
  }

  // Complete the unstarted tail through one lifecycle path so committed tool
  // calls remain paired and outcome hooks observe every synthetic result.
  if (steeringMessages.length > 0) {
    batch.lifecycle?.releaseSkippedCalls(
      validatedToolCallIds(batch, toolCalls.slice(skippedStartIndex)),
    );
  }
  for (let i = skippedStartIndex; i < toolCalls.length; i++) {
    const skippedToolCall = toolCalls[i];
    if (!skippedToolCall) {
      continue;
    }
    const isSteeringSkip = steeringMessages.length > 0;
    const completed = await completeUnstartedToolCall(batch, skippedToolCall, {
      ...(i === skippedStartIndex && skippedReady ? skippedReady : {}),
      ...(fatal
        ? {
            details: TOOL_ADMISSION_FAILURE_DETAILS,
            message: TOOL_ADMISSION_FAILURE_MESSAGE,
          }
        : isSteeringSkip
          ? {
              details: { status: "skipped", deniedReason: "steering" },
              message: STEERING_TOOL_SKIP_MESSAGE,
            }
          : {}),
    });
    await emitToolResultMessage(completed.message, batch.emit);
    finalizedCalls.push(completed.finalized);
    messages.push(completed.message);
  }

  return {
    messages,
    steeringMessages,
    terminate: shouldTerminateToolBatch(finalizedCalls),
    terminateRun: false,
    ...(fatal ? { fatal } : {}),
  };
}

async function executeToolCallsParallel(
  batch: ToolBatchContext,
  toolCalls: AgentToolCall[],
): Promise<ExecutedToolCallBatch> {
  const entries: FinalizedToolCallEntry[] = [];

  try {
    for (const toolCall of toolCalls) {
      const entry = await prepareToolCallEntry(batch, toolCall);
      entries.push(entry);
      if (!("kind" in entry)) {
        await emitToolExecutionEnd(entry, batch.emit);
      }
      if (batch.signal?.aborted) {
        break;
      }
    }

    const steering = batch.signal?.aborted ? [] : getSteeringAtCheckpoint(batch.config);
    const steeringMessages = Array.isArray(steering) ? steering : await steering;
    const skippedToolCallIds = [
      ...(steeringMessages.length > 0
        ? entries.flatMap((entry) => ("kind" in entry ? [entry.toolCall.id] : []))
        : []),
      ...(steeringMessages.length > 0
        ? toolCalls.slice(entries.length).map((toolCall) => toolCall.id)
        : []),
    ];
    if (skippedToolCallIds.length > 0) {
      batch.lifecycle?.releaseSkippedCalls(skippedToolCallIds);
    }
    const orderedFinalizedCalls: Array<FinalizedToolCallOutcome | undefined> = entries.map(
      (entry) => ("kind" in entry ? undefined : entry),
    );
    let fatal: ExecutedToolCallBatch["fatal"];
    if (steeringMessages.length > 0) {
      for (const [index, entry] of entries.entries()) {
        if (!("kind" in entry)) {
          continue;
        }
        entry.execution.dispose();
        const completed = await completeUnstartedToolCall(batch, entry.toolCall, {
          args: entry.execution.args,
          details: { status: "skipped", deniedReason: "steering" },
          message: STEERING_TOOL_SKIP_MESSAGE,
          startEmitted: true,
        });
        orderedFinalizedCalls[index] = completed.finalized;
      }
    } else {
      const launched = await launchParallelToolCalls(entries, batch.lifecycle);
      for (const { index, entry, outcome } of launched.completed) {
        const finalized = await finalizeExecutedToolCall(
          batch,
          entry,
          outcome,
          entry.execution.args,
        );
        await emitToolExecutionEnd(finalized, batch.emit);
        orderedFinalizedCalls[index] = finalized;
        entry.execution.dispose();
      }
      const rejectedIndex = launched.rejected?.index ?? -1;
      fatal = launched.rejected ? { error: launched.rejected.error } : undefined;
      if (fatal) {
        const unstartedIds = entries
          .slice(rejectedIndex)
          .flatMap((entry) => ("kind" in entry ? [entry.toolCall.id] : []));
        batch.lifecycle?.releaseSkippedCalls([
          ...unstartedIds,
          ...validatedToolCallIds(batch, toolCalls.slice(entries.length)),
        ]);
        for (let index = rejectedIndex; index < entries.length; index++) {
          const entry = entries[index];
          if (!entry || !("kind" in entry)) {
            continue;
          }
          entry.execution.dispose();
          const completed = await completeUnstartedToolCall(batch, entry.toolCall, {
            args: entry.execution.args,
            details: TOOL_ADMISSION_FAILURE_DETAILS,
            message: TOOL_ADMISSION_FAILURE_MESSAGE,
            startEmitted: true,
          });
          orderedFinalizedCalls[index] = completed.finalized;
        }
      }
      await Promise.all(
        launched.started.map(async ({ index, entry, outcome }) => {
          try {
            const finalized = await finalizeExecutedToolCall(
              batch,
              entry,
              await outcome,
              entry.execution.args,
            );
            await emitToolExecutionEnd(finalized, batch.emit);
            orderedFinalizedCalls[index] = finalized;
          } finally {
            entry.execution.dispose();
          }
        }),
      );
    }
    const messages: ToolResultMessage[] = [];
    for (const finalized of orderedFinalizedCalls) {
      if (!finalized) {
        continue;
      }
      const toolResultMessage = createToolResultMessage(finalized);
      await emitToolResultMessage(toolResultMessage, batch.emit);
      messages.push(toolResultMessage);
    }

    // Complete calls skipped before queueing through the same lifecycle contract
    // as the sequential path.
    if ((batch.signal?.aborted || fatal) && entries.length < toolCalls.length) {
      for (let i = entries.length; i < toolCalls.length; i++) {
        const skippedToolCall = toolCalls[i];
        if (!skippedToolCall) {
          continue;
        }
        const completed = await completeUnstartedToolCall(
          batch,
          skippedToolCall,
          fatal
            ? {
                details: TOOL_ADMISSION_FAILURE_DETAILS,
                message: TOOL_ADMISSION_FAILURE_MESSAGE,
              }
            : undefined,
        );
        await emitToolResultMessage(completed.message, batch.emit);
        orderedFinalizedCalls.push(completed.finalized);
        messages.push(completed.message);
      }
    }

    return {
      messages,
      steeringMessages,
      terminate: shouldTerminateToolBatch(
        orderedFinalizedCalls.filter(
          (entry): entry is FinalizedToolCallOutcome => entry !== undefined,
        ),
      ),
      terminateRun: false,
      ...(fatal ? { fatal } : {}),
    };
  } finally {
    for (const entry of entries) {
      if ("kind" in entry) {
        entry.execution.dispose();
      }
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
    return validation.outcome;
  }
  const { args: validatedArgs } = validation.prepared;

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
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
): Promise<ValidatedToolCallOutcome> {
  const resolution = await resolveToolCallTool(batch, toolCall);
  if (resolution.kind === "error") {
    return {
      kind: "immediate",
      outcome: {
        kind: "immediate",
        result: createErrorToolResult(
          batch.signal?.aborted ? "Operation aborted" : coerceErrorMessage(resolution.error),
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
        result = copyInternalToolResultAcknowledgement(result, {
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
      result: copyInternalToolResultAcknowledgement(finalized.result, {
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
      validation?.kind === "validated" ? validation.prepared.args : toolCall.arguments,
    );
    await emitToolExecutionEnd(finalized, batch.emit);
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, batch.emit);
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
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
  options: {
    args?: unknown;
    details?: unknown;
    message?: string;
    startEmitted?: boolean;
  } = {},
): Promise<{ finalized: FinalizedToolCallOutcome; message: ToolResultMessage }> {
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
      result: createErrorToolResult(options.message ?? "Operation aborted", options.details),
      isError: true,
      executionStarted: false,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    },
    "args" in options ? options.args : toolCall.arguments,
  );
  await emitToolExecutionEnd(finalized, batch.emit);
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
  return copyInternalToolResultAcknowledgement(
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
