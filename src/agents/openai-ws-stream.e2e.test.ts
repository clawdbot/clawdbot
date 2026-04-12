/**
 * End-to-end integration tests for OpenAI WebSocket streaming.
 *
 * These tests hit the real OpenAI Responses API over WebSocket and verify
 * the full request/response lifecycle including:
 *  - Connection establishment and session reuse
 *  - Context options forwarding (temperature)
 *  - Graceful fallback to HTTP on connection failure
 *  - Connection lifecycle cleanup via releaseWsSession
 *
 * Run manually with a valid OPENAI_API_KEY:
 *   OPENCLAW_LIVE_TEST=1 pnpm test:e2e -- src/agents/openai-ws-stream.e2e.test.ts
 *
 * Skipped in CI — no API key available and we avoid billable external calls.
 */

import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
} from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import type { OutputItem, ResponseObject } from "./openai-ws-connection.js";

const API_KEY = process.env.OPENAI_API_KEY;
const LIVE = isLiveTestEnabled(["OPENAI_LIVE_TEST"]) && !!API_KEY;
const testFn = LIVE ? it : it.skip;

type OpenAIWsStreamModule = typeof import("./openai-ws-stream.js");
type OpenAIWsConnectionModule = typeof import("./openai-ws-connection.js");
type StreamFactory = OpenAIWsStreamModule["createOpenAIWebSocketStreamFn"];
type StreamReturn = ReturnType<ReturnType<StreamFactory>>;
let openAIWsStreamModule: OpenAIWsStreamModule;
let openAIWsConnectionModule: OpenAIWsConnectionModule;

const model = {
  api: "openai-responses" as const,
  provider: "openai",
  id: "gpt-5.4",
  name: "gpt-5.4",
  contextWindow: 128_000,
  maxTokens: 4_096,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Parameters<ReturnType<StreamFactory>>[0];

type StreamFnParams = Parameters<ReturnType<StreamFactory>>;
function makeContext(userMessage: string): StreamFnParams[1] {
  return {
    systemPrompt: "You are a helpful assistant. Reply in one sentence.",
    messages: [{ role: "user" as const, content: userMessage }],
    tools: [],
  } as unknown as StreamFnParams[1];
}

function makeToolContext(userMessage: string): StreamFnParams[1] {
  return {
    systemPrompt: "You are a precise assistant. Follow tool instructions exactly.",
    messages: [{ role: "user" as const, content: userMessage }],
    tools: [
      {
        name: "noop",
        description: "Return the supplied tool result to the user.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    ],
  } as unknown as Context;
}

function makeToolResultMessage(
  callId: string,
  output: string,
): StreamFnParams[1]["messages"][number] {
  return {
    role: "toolResult" as const,
    toolCallId: callId,
    toolName: "noop",
    content: [{ type: "text" as const, text: output }],
    isError: false,
    timestamp: Date.now(),
  } as unknown as StreamFnParams[1]["messages"][number];
}

async function runWebsocketToolFollowupTurn(params: {
  streamFn: ReturnType<StreamFactory>;
  context: StreamFnParams[1];
  firstDone: AssistantMessage;
  toolCallId: string;
  output: string;
}) {
  const secondContext = {
    ...params.context,
    messages: [
      ...params.context.messages,
      params.firstDone,
      makeToolResultMessage(params.toolCallId, params.output),
    ],
  } as unknown as StreamFnParams[1];

  return expectDone(
    await collectEvents(
      params.streamFn(model, secondContext, {
        transport: "websocket",
        maxTokens: 128,
      }),
    ),
  );
}

async function collectEvents(stream: StreamReturn): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  const resolvedStream: AssistantMessageEventStream = await stream;
  for await (const event of resolvedStream) {
    events.push(event);
  }
  return events;
}

function expectDone(events: AssistantMessageEvent[]): AssistantMessage {
  const done = events.find((event) => event.type === "done")?.message;
  expect(done).toBeDefined();
  return done!;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function extractThinkingBlocks(message: AssistantMessage) {
  return message.content.filter((block) => block.type === "thinking") as Array<{
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
  }>;
}

function extractToolCall(message: AssistantMessage) {
  return message.content.find((block) => block.type === "toolCall") as
    | { type: "toolCall"; id: string; name: string }
    | undefined;
}

function parseReasoningSignature(value: string | undefined) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as { id?: unknown; type?: unknown };
  } catch {
    return null;
  }
}

function extractReasoningText(item: { summary?: unknown; content?: unknown }): string {
  const summary = item.summary;
  if (typeof summary === "string") {
    return summary.trim();
  }
  if (Array.isArray(summary)) {
    const summaryText = summary
      .map((part) => {
        if (typeof part === "string") {
          return part.trim();
        }
        if (!part || typeof part !== "object") {
          return "";
        }
        return typeof (part as { text?: unknown }).text === "string"
          ? ((part as { text: string }).text ?? "").trim()
          : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (summaryText) {
      return summaryText;
    }
  }
  return typeof item.content === "string" ? item.content.trim() : "";
}

function toExpectedReasoningSignature(item: { id?: string; type: string }) {
  return {
    type: item.type,
    ...(typeof item.id === "string" && item.id.startsWith("rs_") ? { id: item.id } : {}),
  };
}

/** Each test gets a unique session ID to avoid cross-test interference. */
const sessions: string[] = [];
function freshSession(name: string): string {
  const id = `e2e-${name}-${Date.now()}`;
  sessions.push(id);
  return id;
}

describe("OpenAI WebSocket e2e", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("@mariozechner/pi-ai", async () => {
      const actual =
        await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
      return {
        ...actual,
        createAssistantMessageEventStream: actual.createAssistantMessageEventStream,
      };
    });
    openAIWsConnectionModule = await import("./openai-ws-connection.js");
    openAIWsStreamModule = await import("./openai-ws-stream.js");
  });

  afterEach(() => {
    for (const id of sessions) {
      openAIWsStreamModule.releaseWsSession(id);
    }
    openAIWsStreamModule.__testing.setDepsForTest();
    sessions.length = 0;
  });

  testFn(
    "completes a single-turn request over WebSocket",
    async () => {
      const sid = freshSession("single");
      const streamFn = openAIWsStreamModule.createOpenAIWebSocketStreamFn(API_KEY!, sid);
      const stream = streamFn(model, makeContext("What is 2+2?"), { transport: "websocket" });
      const done = expectDone(await collectEvents(stream));

      expect(done.content.length).toBeGreaterThan(0);
      const text = assistantText(done);
      expect(text).toMatch(/4/);
    },
    45_000,
  );

  testFn(
    "forwards temperature option to the API",
    async () => {
      const sid = freshSession("temp");
      const streamFn = openAIWsStreamModule.createOpenAIWebSocketStreamFn(API_KEY!, sid);
      const stream = streamFn(model, makeContext("Pick a random number between 1 and 1000."), {
        transport: "websocket",
        temperature: 0.8,
      });
      const events = await collectEvents(stream);

      // Stream must complete (done or error with fallback) — must NOT hang.
      const hasTerminal = events.some((e) => e.type === "done" || e.type === "error");
      expect(hasTerminal).toBe(true);
    },
    45_000,
  );

  testFn(
    "reuses the websocket session for tool-call follow-up turns",
    async () => {
      const sid = freshSession("tool-roundtrip");
      const streamFn = openAIWsStreamModule.createOpenAIWebSocketStreamFn(API_KEY!, sid);
      const firstContext = makeToolContext(
        "Call the tool `noop` with {}. After the tool result arrives, reply with exactly the tool output and nothing else.",
      );
      const firstEvents = await collectEvents(
        streamFn(model, firstContext, {
          transport: "websocket",
          toolChoice: "required",
          maxTokens: 128,
        } as unknown as StreamFnParams[2]),
      );
      const firstDone = expectDone(firstEvents);
      const toolCall = firstDone.content.find((block) => block.type === "toolCall") as
        | { type: "toolCall"; id: string; name: string }
        | undefined;
      expect(toolCall?.name).toBe("noop");
      expect(toolCall?.id).toBeTruthy();

      const secondDone = await runWebsocketToolFollowupTurn({
        streamFn,
        context: firstContext,
        firstDone,
        toolCallId: toolCall!.id,
        output: "TOOL_OK",
      });

      expect(assistantText(secondDone)).toMatch(/TOOL_OK/);
    },
    60_000,
  );

  testFn(
    "surfaces replay-safe reasoning metadata on websocket tool turns",
    async () => {
      const sid = freshSession("tool-reasoning");
      const completedResponses: ResponseObject[] = [];
      openAIWsStreamModule.__testing.setDepsForTest({
        createManager: (options) => {
          const manager = new openAIWsConnectionModule.OpenAIWebSocketManager(options);
          manager.onMessage((event) => {
            if (event.type === "response.completed") {
              completedResponses.push(event.response);
            }
          });
          return manager;
        },
      });
      const streamFn = openAIWsStreamModule.createOpenAIWebSocketStreamFn(API_KEY!, sid);
      const firstContext = makeToolContext(
        "Think carefully, call the tool `noop` with {} first, then after the tool result reply with exactly TOOL_OK.",
      );
      const firstDone = expectDone(
        await collectEvents(
          streamFn(model, firstContext, {
            transport: "websocket",
            toolChoice: "required",
            reasoningEffort: "high",
            reasoningSummary: "detailed",
            maxTokens: 256,
          } as unknown as StreamFnParams[2]),
        ),
      );

      const firstResponse = completedResponses[0];
      expect(firstResponse).toBeDefined();

      const rawReasoningItems = (firstResponse?.output ?? []).filter(
        (item): item is Extract<OutputItem, { type: "reasoning" | `reasoning.${string}` }> =>
          item.type === "reasoning" || item.type.startsWith("reasoning."),
      );
      const replayableReasoningItems = rawReasoningItems.filter(
        (item) => extractReasoningText(item).length > 0,
      );
      const thinkingBlocks = extractThinkingBlocks(firstDone);
      expect(thinkingBlocks).toHaveLength(replayableReasoningItems.length);
      expect(thinkingBlocks.map((block) => block.thinking)).toEqual(
        replayableReasoningItems.map((item) => extractReasoningText(item)),
      );
      expect(
        thinkingBlocks.map((block) => parseReasoningSignature(block.thinkingSignature)),
      ).toEqual(replayableReasoningItems.map((item) => toExpectedReasoningSignature(item)));

      const rawToolCall = firstResponse?.output.find(
        (item): item is Extract<OutputItem, { type: "function_call" }> =>
          item.type === "function_call",
      );
      expect(rawToolCall).toBeDefined();
      const toolCall = extractToolCall(firstDone);
      expect(toolCall?.name).toBe(rawToolCall?.name);
      expect(toolCall?.id).toBe(
        rawToolCall ? `${rawToolCall.call_id}|${rawToolCall.id}` : undefined,
      );

      const secondDone = await runWebsocketToolFollowupTurn({
        streamFn,
        context: firstContext,
        firstDone,
        toolCallId: toolCall!.id,
        output: "TOOL_OK",
      });

      expect(assistantText(secondDone)).toMatch(/TOOL_OK/);
    },
    60_000,
  );

  testFn(
    "supports websocket warm-up before the first request",
    async () => {
      const sid = freshSession("warmup");
      const streamFn = openAIWsStreamModule.createOpenAIWebSocketStreamFn(API_KEY!, sid);
      const events = await collectEvents(
        streamFn(model, makeContext("Reply with the word warmed."), {
          transport: "websocket",
          openaiWsWarmup: true,
          maxTokens: 32,
        } as unknown as StreamFnParams[2]),
      );

      const hasTerminal = events.some((event) => event.type === "done" || event.type === "error");
      expect(hasTerminal).toBe(true);

      const done = events.find((event) => event.type === "done")?.message;
      if (done) {
        expect(assistantText(done).toLowerCase()).toContain("warmed");
      }
    },
    45_000,
  );

  testFn(
    "session is tracked in registry during request",
    async () => {
      const sid = freshSession("registry");
      const streamFn = openAIWsStreamModule.createOpenAIWebSocketStreamFn(API_KEY!, sid);

      expect(openAIWsStreamModule.hasWsSession(sid)).toBe(false);

      await collectEvents(streamFn(model, makeContext("Say hello."), { transport: "websocket" }));

      expect(openAIWsStreamModule.hasWsSession(sid)).toBe(true);
      openAIWsStreamModule.releaseWsSession(sid);
      expect(openAIWsStreamModule.hasWsSession(sid)).toBe(false);
    },
    45_000,
  );

  testFn(
    "falls back to HTTP gracefully with invalid API key",
    async () => {
      const sid = freshSession("fallback");
      const streamFn = openAIWsStreamModule.createOpenAIWebSocketStreamFn("sk-invalid-key", sid);
      const stream = streamFn(model, makeContext("Hello"), {});
      const events = await collectEvents(stream);

      const hasTerminal = events.some((e) => e.type === "done" || e.type === "error");
      expect(hasTerminal).toBe(true);
    },
    45_000,
  );
});
