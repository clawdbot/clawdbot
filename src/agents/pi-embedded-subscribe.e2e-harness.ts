import type { AssistantMessage } from "@mariozechner/pi-ai";
import { expect } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type SubscribeEmbeddedPiSession = typeof subscribeEmbeddedPiSession;
type SubscribeEmbeddedPiSessionParams = Parameters<SubscribeEmbeddedPiSession>[0];
type PiSession = Parameters<SubscribeEmbeddedPiSession>[0]["session"];
type OnBlockReply = NonNullable<SubscribeEmbeddedPiSessionParams["onBlockReply"]>;
type BlockReplyChunking = NonNullable<SubscribeEmbeddedPiSessionParams["blockReplyChunking"]>;

export const THINKING_TAG_CASES = [
  { tag: "think", open: "<think>", close: "</think>" },
  { tag: "thinking", open: "<thinking>", close: "</thinking>" },
  { tag: "thought", open: "<thought>", close: "</thought>" },
  { tag: "antthinking", open: "<antthinking>", close: "</antthinking>" },
  { tag: "antml:thinking", open: "<antml:thinking>", close: "</antml:thinking>" },
] as const;

export function createStubSessionHarness(): {
  session: PiSession;
  emit: (evt: unknown) => void;
} {
  let handler: ((evt: unknown) => void) | undefined;
  const session = {
    subscribe: (fn: (evt: unknown) => void) => {
      handler = fn;
      return () => {};
    },
  } as unknown as PiSession;

  return { session, emit: (evt: unknown) => handler?.(evt) };
}

export function createSubscribedSessionHarness(
  params: Omit<Parameters<SubscribeEmbeddedPiSession>[0], "session"> & {
    sessionExtras?: Partial<PiSession>;
  },
): {
  emit: (evt: unknown) => void;
  session: PiSession;
  subscription: ReturnType<SubscribeEmbeddedPiSession>;
} {
  const { sessionExtras, ...subscribeParams } = params;
  const { session, emit } = createStubSessionHarness();
  const mergedSession = Object.assign(session, sessionExtras ?? {});
  const subscription = subscribeEmbeddedPiSession({
    ...subscribeParams,
    session: mergedSession,
  });
  return { emit, session: mergedSession, subscription };
}

export function createParagraphChunkedBlockReplyHarness(params: {
  chunking: { minChars: number; maxChars: number };
  onBlockReply?: OnBlockReply;
  runId?: string;
}): {
  emit: (evt: unknown) => void;
  onBlockReply: OnBlockReply;
  subscription: ReturnType<SubscribeEmbeddedPiSession>;
} {
  const onBlockReply: OnBlockReply = params.onBlockReply ?? (() => {});
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: params.runId ?? "run",
    onBlockReply,
    blockReplyBreak: "message_end",
    blockReplyChunking: {
      ...params.chunking,
      breakPreference: "paragraph",
    },
  });
  return { emit, onBlockReply, subscription };
}

export function createTextEndBlockReplyHarness(params?: {
  onBlockReply?: OnBlockReply;
  runId?: string;
  blockReplyChunking?: BlockReplyChunking;
}): {
  emit: (evt: unknown) => void;
  onBlockReply: OnBlockReply;
  subscription: ReturnType<SubscribeEmbeddedPiSession>;
} {
  const onBlockReply: OnBlockReply = params?.onBlockReply ?? (() => {});
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: params?.runId ?? "run",
    onBlockReply,
    blockReplyBreak: "text_end",
    blockReplyChunking: params?.blockReplyChunking,
  });
  return { emit, onBlockReply, subscription };
}

export function extractAgentEventPayloads(calls: Array<unknown[]>): Array<Record<string, unknown>> {
  return calls
    .map((call) => {
      const first = call?.[0] as { data?: unknown } | undefined;
      const data = first?.data;
      return data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
    })
    .filter((value): value is Record<string, unknown> => Boolean(value));
}

export function extractTextPayloads(calls: Array<unknown[]>): string[] {
  return calls
    .map((call) => {
      const payload = call?.[0] as { text?: unknown } | undefined;
      return typeof payload?.text === "string" ? payload.text : undefined;
    })
    .filter((text): text is string => Boolean(text));
}

export function emitMessageStartAndEndForAssistantText(params: {
  emit: (evt: unknown) => void;
  text: string;
}): void {
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
  } as AssistantMessage;
  params.emit({ type: "message_start", message: assistantMessage });
  params.emit({ type: "message_end", message: assistantMessage });
}

export function emitAssistantTextDeltaAndEnd(params: {
  emit: (evt: unknown) => void;
  text: string;
}): void {
  params.emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: {
      type: "text_delta",
      delta: params.text,
    },
  });
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
  } as AssistantMessage;
  params.emit({ type: "message_end", message: assistantMessage });
}

export function emitAssistantTextDelta(params: {
  emit: (evt: unknown) => void;
  delta: string;
}): void {
  params.emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: params.delta },
  });
}

export function emitAssistantTextEnd(params: {
  emit: (evt: unknown) => void;
  content?: string;
}): void {
  params.emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent:
      typeof params.content === "string"
        ? { type: "text_end", content: params.content }
        : { type: "text_end" },
  });
}

export function emitAssistantLifecycleErrorAndEnd(params: {
  emit: (evt: unknown) => void;
  errorMessage: string;
  provider?: string;
  model?: string;
}): void {
  const assistantMessage = {
    role: "assistant",
    stopReason: "error",
    errorMessage: params.errorMessage,
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.model ? { model: params.model } : {}),
  } as AssistantMessage;
  params.emit({ type: "message_update", message: assistantMessage });
  params.emit({ type: "agent_end" });
}

export function createReasoningFinalAnswerMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Because it helps" },
      { type: "text", text: "Final answer" },
    ],
  } as AssistantMessage;
}

type LifecycleErrorAgentEvent = {
  stream?: unknown;
  data?: {
    phase?: unknown;
    error?: unknown;
  };
};

export function findLifecycleErrorAgentEvent(
  calls: Array<unknown[]>,
): LifecycleErrorAgentEvent | undefined {
  for (const call of calls) {
    const event = call?.[0] as LifecycleErrorAgentEvent | undefined;
    if (event?.stream === "lifecycle" && event?.data?.phase === "error") {
      return event;
    }
  }
  return undefined;
}

export function expectFencedChunks(calls: Array<unknown[]>, expectedPrefix: string): void {
  expect(calls.length).toBeGreaterThan(1);
  for (const call of calls) {
    const chunk = (call[0] as { text?: unknown } | undefined)?.text;
    expect(typeof chunk === "string" && chunk.startsWith(expectedPrefix)).toBe(true);
    const fenceCount = typeof chunk === "string" ? (chunk.match(/```/g)?.length ?? 0) : 0;
    expect(fenceCount).toBeGreaterThanOrEqual(2);
  }
}

export function expectSingleAgentEventText(calls: Array<unknown[]>, text: string): void {
  const payloads = extractAgentEventPayloads(calls);
  expect(payloads).toHaveLength(1);
  expect(payloads[0]?.text).toBe(text);
  expect(payloads[0]?.delta).toBe(text);
}
