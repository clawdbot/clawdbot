import type { MessageOptions, SessionEvent, SessionEventType } from "@github/copilot-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildCopilotAssistantUsage,
  normalizeCopilotUsage,
  type CopilotUsageSnapshot,
} from "./usage-bridge.js";

export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export type AssistantUsageSnapshot = CopilotUsageSnapshot;

export interface OnAssistantDeltaPayload {
  delta: string;
  sessionId?: string;
  text: string;
  usage?: AssistantUsageSnapshot;
}

export interface SessionLike {
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  id?: string;
  off?: (eventType: string, handler: (...args: unknown[]) => void) => void;
  on: {
    <K extends SessionEventType>(
      eventType: K,
      handler: (event: Extract<SessionEvent, { type: K }>) => void,
    ): (() => void) | void;
    (eventType: string, handler: (event: SessionEvent) => void): (() => void) | void;
  };
  sendAndWait(options: MessageOptions, timeout?: number): Promise<SessionEvent | undefined>;
  sessionId?: string;
}

export interface EventBridgeOptions {
  onAssistantDelta?: (payload: OnAssistantDeltaPayload) => void | Promise<void>;
  getSdkSessionId: () => string | undefined;
  isAborted: () => boolean;
}

export interface EventBridgeSnapshot {
  readonly assistantTexts: readonly string[];
  readonly completedCount: number;
  readonly lastAssistantEvent: Extract<SessionEvent, { type: "assistant.message" }> | undefined;
  readonly startedCount: number;
  readonly streamError: Error | undefined;
  readonly toolMetas: ReadonlyArray<{ meta?: string; toolName: string }>;
  readonly usage: AssistantUsageSnapshot | undefined;
}

export interface BuildAssistantMessageArgs {
  modelRef: { api?: string; id: string; provider: string };
  now: () => number;
}

export interface EventBridgeController {
  recordSendResult(result: SessionEvent | undefined): boolean;
  awaitDeltaChain(): Promise<void>;
  snapshot(): EventBridgeSnapshot;
  buildAssistantMessage(args: BuildAssistantMessageArgs): AssistantMessage | undefined;
  finalizeAssistantTexts(): string[];
  detach(): void;
}

type MessageAccumulator = { messageId: string; text: string };
type PromptErrorWithCode = Error & { code?: string; cause?: unknown };

export function attachEventBridge(
  session: SessionLike,
  options: EventBridgeOptions,
): EventBridgeController {
  const messageOrder: string[] = [];
  const messagesById = new Map<string, MessageAccumulator>();
  const reasoningOrder: string[] = [];
  const reasoningById = new Map<string, string>();
  let lastAssistantEvent: Extract<SessionEvent, { type: "assistant.message" }> | undefined;
  let usage: AssistantUsageSnapshot | undefined;
  let streamError: Error | undefined;
  const toolMetas: Array<{ meta?: string; toolName: string }> = [];
  const toolNamesByCallId = new Map<string, string>();
  let startedCount = 0;
  let completedCount = 0;
  let deltaQueue = Promise.resolve();
  let deltaChain = Promise.resolve();
  let firstDeltaError: unknown;
  let detached = false;
  const unsubscribeFns: Array<() => void> = [];

  registerListener(session, unsubscribeFns, "assistant.message_delta", (event) => {
    const messageId = readString(event.data.messageId) ?? "assistant-message";
    const delta = event.data.deltaContent;
    if (!delta) {
      return;
    }
    const entry = ensureMessageAccumulator(messagesById, messageOrder, messageId);
    entry.text += delta;
    const onAssistantDelta = options.onAssistantDelta;
    if (!onAssistantDelta) {
      return;
    }
    const payload: OnAssistantDeltaPayload = {
      delta,
      sessionId: options.getSdkSessionId(),
      text: entry.text,
      usage,
    };
    deltaQueue = deltaQueue
      .then(
        () => onAssistantDelta(payload),
        () => onAssistantDelta(payload),
      )
      .catch((error: unknown) => {
        firstDeltaError ??= error;
      });
    deltaChain = deltaQueue.then(() => {
      if (firstDeltaError !== undefined) {
        throw toLintErrorObject(firstDeltaError, "Non-Error thrown");
      }
    });
    void deltaChain.catch(() => undefined);
  });

  registerListener(session, unsubscribeFns, "assistant.reasoning_delta", (event) => {
    const reasoningId = readString(event.data.reasoningId) ?? "assistant-reasoning";
    const delta = event.data.deltaContent;
    if (!delta) {
      return;
    }
    if (!reasoningById.has(reasoningId)) {
      reasoningById.set(reasoningId, "");
      reasoningOrder.push(reasoningId);
    }
    reasoningById.set(reasoningId, `${reasoningById.get(reasoningId) ?? ""}${delta}`);
  });

  registerListener(session, unsubscribeFns, "assistant.message", (event) => {
    lastAssistantEvent = event;
    const entry = ensureMessageAccumulator(messagesById, messageOrder, event.data.messageId);
    if (typeof event.data.content === "string" && event.data.content.length >= entry.text.length) {
      entry.text = event.data.content;
    }
  });

  registerListener(session, unsubscribeFns, "assistant.usage", (event) => {
    usage = normalizeCopilotUsage(event.data);
  });

  registerListener(session, unsubscribeFns, "tool.execution_start", (event) => {
    startedCount += 1;
    toolNamesByCallId.set(event.data.toolCallId, event.data.toolName);
    toolMetas.push({ toolName: event.data.toolName });
  });

  registerListener(session, unsubscribeFns, "tool.execution_complete", (event) => {
    completedCount += 1;
    const toolName = toolNamesByCallId.get(event.data.toolCallId);
    const meta = event.data.success
      ? (event.data.result?.detailedContent ?? event.data.result?.content)
      : event.data.error?.message;
    if (toolName) {
      toolMetas.push({ meta, toolName });
    }
  });

  registerListener(session, unsubscribeFns, "session.error", (event) => {
    if (!options.isAborted()) {
      streamError = createPromptError(
        event.data.errorCode ?? event.data.errorType,
        event.data.message,
      );
    }
  });

  registerListener(session, unsubscribeFns, "abort", (event) => {
    if (!options.isAborted()) {
      streamError = createPromptError(
        "session_aborted",
        `[copilot-attempt] session aborted: ${event.data.reason}`,
      );
    }
  });

  return {
    recordSendResult(result) {
      if (!isAssistantMessageEvent(result)) {
        return false;
      }
      lastAssistantEvent = result;
      return true;
    },
    awaitDeltaChain() {
      return deltaChain;
    },
    snapshot() {
      return {
        assistantTexts: finalizeAssistantTexts(messageOrder, messagesById, lastAssistantEvent),
        completedCount,
        lastAssistantEvent,
        startedCount,
        streamError,
        toolMetas: toolMetas.map((toolMeta) => Object.assign({}, toolMeta)),
        usage: usage ? { ...usage } : undefined,
      };
    },
    buildAssistantMessage(args) {
      return buildAssistantMessage({
        event: lastAssistantEvent,
        modelRef: args.modelRef,
        now: args.now,
        reasoningById,
        reasoningOrder,
        usage,
        assistantTexts: finalizeAssistantTexts(messageOrder, messagesById, lastAssistantEvent),
      });
    },
    finalizeAssistantTexts() {
      return finalizeAssistantTexts(messageOrder, messagesById, lastAssistantEvent);
    },
    detach() {
      if (detached) {
        return;
      }
      detached = true;
      for (const unsubscribe of [...unsubscribeFns].toReversed()) {
        try {
          unsubscribe();
        } catch {
          // best-effort cleanup only
        }
      }
      unsubscribeFns.length = 0;
    },
  };
}

function buildAssistantMessage(params: {
  assistantTexts: string[];
  event?: Extract<SessionEvent, { type: "assistant.message" }>;
  modelRef: { api?: string; id: string; provider: string };
  now: () => number;
  reasoningById: Map<string, string>;
  reasoningOrder: string[];
  usage?: AssistantUsageSnapshot;
}): AssistantMessage | undefined {
  const event = params.event;
  const text = event
    ? event.data.content || params.assistantTexts[params.assistantTexts.length - 1] || ""
    : "";
  const reasoningText =
    event?.data.reasoningText ?? joinReasoning(params.reasoningOrder, params.reasoningById);
  const toolRequests = event?.data.toolRequests ?? [];
  if (!text && !reasoningText && toolRequests.length === 0) {
    return undefined;
  }

  const content: AssistantMessage["content"] = [];
  if (reasoningText) {
    content.push({ thinking: reasoningText, type: "thinking" });
  }
  if (text) {
    content.push({ text, type: "text" });
  }
  for (const request of toolRequests) {
    content.push({
      arguments: request.arguments ?? {},
      id: request.toolCallId,
      name: request.name,
      type: "toolCall",
    });
  }

  return {
    api: params.modelRef.api ?? "openai-responses",
    content,
    model: event?.data.model ?? params.modelRef.id,
    provider: params.modelRef.provider,
    role: "assistant",
    stopReason: toolRequests.length > 0 ? "toolUse" : "stop",
    timestamp: params.now(),
    usage: buildCopilotAssistantUsage({
      fallbackOutputTokens: event?.data.outputTokens,
      usage: params.usage,
    }),
  };
}

function createPromptError(code: string, message: string, cause?: unknown): PromptErrorWithCode {
  const error = new Error(message) as PromptErrorWithCode;
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function ensureMessageAccumulator(
  messagesById: Map<string, MessageAccumulator>,
  messageOrder: string[],
  messageId: string,
): MessageAccumulator {
  let entry = messagesById.get(messageId);
  if (!entry) {
    entry = { messageId, text: "" };
    messagesById.set(messageId, entry);
    messageOrder.push(messageId);
  }
  return entry;
}

function finalizeAssistantTexts(
  messageOrder: string[],
  messagesById: Map<string, MessageAccumulator>,
  event?: Extract<SessionEvent, { type: "assistant.message" }>,
): string[] {
  const texts = messageOrder
    .map((messageId) => messagesById.get(messageId)?.text ?? "")
    .filter((text) => text.length > 0);
  if (texts.length > 0) {
    return texts;
  }
  if (event?.data.content) {
    return [event.data.content];
  }
  return [];
}

function isAssistantMessageEvent(
  event: SessionEvent | undefined,
): event is Extract<SessionEvent, { type: "assistant.message" }> {
  return event?.type === "assistant.message";
}

function joinReasoning(order: string[], reasoningById: Map<string, string>): string {
  return order.map((reasoningId) => reasoningById.get(reasoningId) ?? "").join("");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function registerListener<K extends SessionEventType>(
  session: SessionLike,
  unsubscribeFns: Array<() => void>,
  eventType: K,
  handler: (event: Extract<SessionEvent, { type: K }>) => void,
): void {
  const maybeUnsubscribe = session.on(eventType, handler);
  if (typeof maybeUnsubscribe === "function") {
    unsubscribeFns.push(maybeUnsubscribe);
    return;
  }
  unsubscribeFns.push(() => {
    session.off?.(eventType, handler as (...args: unknown[]) => void);
  });
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
