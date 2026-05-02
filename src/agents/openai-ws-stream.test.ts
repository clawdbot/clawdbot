/**
 * Unit tests for openai-ws-stream.ts
 *
 * Covers:
 *  - Message format converters (convertMessagesToInputItems, convertTools)
 *  - Response → AssistantMessage parser (buildAssistantMessageFromResponse)
 *  - createOpenAIWebSocketStreamFn behaviour (connect, send, receive, fallback)
 *  - Session registry helpers (releaseWsSession, hasWsSession)
 */

import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponseObject } from "./openai-ws-connection.js";
import {
  buildOpenAIWebSocketResponseCreatePayload,
  planOpenAIWebSocketRequestPayload,
} from "./openai-ws-request.js";
import {
  __testing as openAIWsStreamTesting,
  buildAssistantMessageFromResponse,
  convertMessagesToInputItems,
  convertTools,
  createOpenAIWebSocketStreamFn,
  hasWsSession,
  planTurnInput,
  releaseWsSession,
} from "./openai-ws-stream.js";
import type { InputItem, ResponseCreateEvent } from "./openai-ws-types.js";
import { log } from "./pi-embedded-runner/logger.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock OpenAIWebSocketManager
// ─────────────────────────────────────────────────────────────────────────────

// We mock the entire openai-ws-connection module so no real WebSocket is opened.
const { MockManager } = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  type AnyFn = (...args: unknown[]) => void;

  // Shared mutable flag so inner class can see it
  let _globalConnectShouldFail = false;
  let _globalSendFailuresRemaining = 0;

  class MockManager extends EventEmitter {
    private _listeners: AnyFn[] = [];
    private _previousResponseId: string | null = null;
    private _connected = false;
    private _broken = false;
    private _lastCloseInfo: { code: number; reason: string; retryable: boolean } | null = null;

    sentEvents: unknown[] = [];
    connectCallCount = 0;
    connectApiKeys: string[] = [];
    closeCallCount = 0;
    options: unknown;

    // Allow tests to override connect/send behaviour
    connectShouldFail = false;
    sendShouldFail = false;

    constructor(options?: unknown) {
      super();
      this.options = options;
    }

    get previousResponseId(): string | null {
      return this._previousResponseId;
    }

    get lastCloseInfo(): { code: number; reason: string; retryable: boolean } | null {
      return this._lastCloseInfo;
    }

    async connect(_apiKey: string): Promise<void> {
      this.connectCallCount++;
      this.connectApiKeys.push(_apiKey);
      if (this.connectShouldFail || _globalConnectShouldFail) {
        throw new Error("Mock connect failure");
      }
      this._connected = true;
    }

    isConnected(): boolean {
      return this._connected && !this._broken;
    }

    send(event: unknown): void {
      if (!this._connected) {
        throw new Error("cannot send — not connected");
      }
      if (this.sendShouldFail || _globalSendFailuresRemaining > 0) {
        if (_globalSendFailuresRemaining > 0) {
          _globalSendFailuresRemaining--;
        }
        throw new Error("Mock send failure");
      }
      this.sentEvents.push(event);
      const maybeEvent = event as { type?: string; generate?: boolean; model?: string } | null;
      // Auto-complete warm-up events so warm-up-enabled tests don't hang waiting
      // for the warm-up terminal event.
      if (maybeEvent?.type === "response.create" && maybeEvent.generate === false) {
        queueMicrotask(() => {
          this.simulateEvent({
            type: "response.completed",
            response: makeResponseObject(`warmup-${Date.now()}`),
          });
        });
      }
    }

    warmUp(params: { model: string; tools?: unknown[]; instructions?: string }): void {
      this.send({
        type: "response.create",
        generate: false,
        model: params.model,
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.instructions ? { instructions: params.instructions } : {}),
      });
    }

    onMessage(handler: (event: unknown) => void): () => void {
      this._listeners.push(handler as AnyFn);
      return () => {
        this._listeners = this._listeners.filter((l) => l !== handler);
      };
    }

    close(): void {
      this.closeCallCount++;
      this._connected = false;
      this._lastCloseInfo = {
        code: 1000,
        reason: "closed",
        retryable: false,
      };
      this.emit("close", 1000, "closed");
    }

    // Test helper: simulate WebSocket connection drop mid-request
    simulateClose(code = 1006, reason = "connection lost"): void {
      this._connected = false;
      this._lastCloseInfo = {
        code,
        reason,
        retryable:
          code === 1001 ||
          code === 1005 ||
          code === 1006 ||
          code === 1011 ||
          code === 1012 ||
          code === 1013,
      };
      this.emit("close", code, reason);
    }

    // Test helper: simulate a server event
    simulateEvent(event: unknown): void {
      const maybeEvent = event as { type?: string; response?: { id?: string } };
      if (maybeEvent.type === "response.completed" && maybeEvent.response?.id) {
        this._previousResponseId = maybeEvent.response.id;
      }
      for (const fn of this._listeners) {
        fn(event);
      }
    }

    // Test helper: simulate connection being broken
    simulateBroken(): void {
      this._connected = false;
      this._broken = true;
    }

    // Test helper: set the previous response ID as if a turn completed
    setPreviousResponseId(id: string): void {
      this._previousResponseId = id;
    }

    static lastInstance: MockManager | null = null;
    static instances: MockManager[] = [];

    static reset(): void {
      MockManager.lastInstance = null;
      MockManager.instances = [];
    }
  }

  // Patch constructor to track instances
  const OriginalMockManager = MockManager;
  class TrackedMockManager extends OriginalMockManager {
    constructor(...args: ConstructorParameters<typeof OriginalMockManager>) {
      super(...args);
      TrackedMockManager.lastInstance = this;
      TrackedMockManager.instances.push(this);
    }

    static lastInstance: TrackedMockManager | null = null;
    static instances: TrackedMockManager[] = [];

    /** Class-level flag: make ALL new instances fail on connect(). */
    static get globalConnectShouldFail(): boolean {
      return _globalConnectShouldFail;
    }
    static set globalConnectShouldFail(v: boolean) {
      _globalConnectShouldFail = v;
    }

    static get globalSendFailuresRemaining(): number {
      return _globalSendFailuresRemaining;
    }
    static set globalSendFailuresRemaining(v: number) {
      _globalSendFailuresRemaining = v;
    }

    static reset(): void {
      TrackedMockManager.lastInstance = null;
      TrackedMockManager.instances = [];
      _globalConnectShouldFail = false;
      _globalSendFailuresRemaining = 0;
    }
  }

  return { MockManager: TrackedMockManager };
});

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderTransportTurnStateWithPlugin: () => undefined,
  resolveProviderWebSocketSessionPolicyWithPlugin: () => undefined,
}));

// Track if streamSimple (HTTP fallback) was called
const streamSimpleCalls: Array<{ model: unknown; context: unknown; options?: unknown }> = [];
const mockStreamSimple = vi.fn((model: unknown, context: unknown, options?: unknown) => {
  streamSimpleCalls.push({ model, context, options });
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const msg = makeFakeAssistantMessage("http fallback response");
    stream.push({ type: "done", reason: "stop", message: msg });
    stream.end();
  });
  return stream;
});
const mockCreateHttpFallbackStreamFn = vi.fn(() => mockStreamSimple as never);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a StreamFn return value (which may be a Promise) to an AsyncIterable. */
async function resolveStream(
  stream: ReturnType<ReturnType<typeof createOpenAIWebSocketStreamFn>>,
): Promise<AsyncIterable<unknown>> {
  return stream instanceof Promise ? await stream : stream;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

type FakeMessage =
  | { role: "user"; content: string | unknown[]; timestamp: number }
  | {
      role: "assistant";
      content: unknown[];
      phase?: "commentary" | "final_answer";
      stopReason: string;
      api: string;
      provider: string;
      model: string;
      usage: unknown;
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: unknown[];
      isError: boolean;
      timestamp: number;
    };

function userMsg(text: string): FakeMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistantMsg(
  textBlocks: string[],
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [],
  phase?: "commentary" | "final_answer",
): FakeMessage {
  const content: unknown[] = [];
  for (const t of textBlocks) {
    content.push({ type: "text", text: t });
  }
  for (const tc of toolCalls) {
    content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.args });
  }
  return {
    role: "assistant",
    content,
    phase,
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {},
    timestamp: 0,
  };
}

function toolResultMsg(callId: string, output: string): FakeMessage {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "test_tool",
    content: [{ type: "text", text: output }],
    isError: false,
    timestamp: 0,
  };
}

function makeFakeAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

function makeResponseObject(
  id: string,
  outputText?: string,
  toolCallName?: string,
  phase?: "commentary" | "final_answer",
): ResponseObject {
  const output: ResponseObject["output"] = [];
  if (outputText) {
    output.push({
      type: "message",
      id: "item_1",
      role: "assistant",
      content: [{ type: "output_text", text: outputText }],
      phase,
    });
  }
  if (toolCallName) {
    output.push({
      type: "function_call",
      id: "item_2",
      call_id: "call_abc",
      name: toolCallName,
      arguments: '{"arg":"value"}',
    });
  }
  return {
    id,
    object: "response",
    created_at: Date.now(),
    status: "completed",
    model: "gpt-5.4",
    output,
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("convertTools", () => {
  it("returns empty array for undefined tools", () => {
    expect(convertTools(undefined)).toEqual([]);
  });

  it("returns empty array for empty tools", () => {
    expect(convertTools([])).toEqual([]);
  });

  it("converts tools to FunctionToolDefinition format", () => {
    const tools = [
      {
        name: "exec",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "function",
      name: "exec",
      description: "Run a command",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    });
  });

  it("handles tools without description", () => {
    const tools = [{ name: "ping", description: "", parameters: {} }];
    const result = convertTools(tools as Parameters<typeof convertTools>[0]);
    expect(result[0]?.name).toBe("ping");
  });

  it("normalizes truly empty parameter schemas for parameter-free tools", () => {
    const tools = [{ name: "ping", description: "No params", parameters: {} }];
    const result = convertTools(tools as Parameters<typeof convertTools>[0]);
    expect(result[0]?.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("injects properties:{} for type:object schemas missing properties (MCP no-param tools)", () => {
    const tools = [
      { name: "list_regions", description: "List AWS regions", parameters: { type: "object" } },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "function",
      name: "list_regions",
      description: "List AWS regions",
      parameters: { type: "object", properties: {} },
    });
  });

  it("adds missing top-level type for raw object-ish MCP schemas", () => {
    const tools = [
      {
        name: "query",
        description: "Run a query",
        parameters: { properties: { q: { type: "string" } }, required: ["q"] },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result[0]?.parameters).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
  });

  it("flattens raw top-level anyOf MCP schemas into one object schema", () => {
    const tools = [
      {
        name: "dispatch",
        description: "Dispatch an action",
        parameters: {
          anyOf: [
            {
              type: "object",
              properties: { action: { const: "ping" } },
              required: ["action"],
            },
            {
              type: "object",
              properties: {
                action: { const: "echo" },
                text: { type: "string" },
              },
              required: ["action", "text"],
            },
          ],
        },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result[0]?.parameters).toEqual({
      type: "object",
      properties: {
        action: { type: "string", enum: ["ping", "echo"] },
        text: { type: "string" },
      },
      required: ["action"],
      additionalProperties: true,
    });
  });

  it("leaves top-level allOf schemas unchanged", () => {
    const tools = [
      {
        name: "conditional",
        description: "Conditional schema",
        parameters: {
          allOf: [{ type: "object", properties: { id: { type: "string" } } }],
        },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result[0]?.parameters).toEqual({
      allOf: [{ type: "object", properties: { id: { type: "string" } } }],
    });
  });

  it("preserves existing properties on type:object schemas", () => {
    const tools = [
      {
        name: "exec",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result[0]?.parameters).toEqual({
      type: "object",
      properties: { cmd: { type: "string" } },
    });
  });

  it("adds strict:true and required:[] for native strict-compatible no-param tools", () => {
    const tools = [
      {
        name: "ping",
        description: "No params",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0], {
      strict: true,
    });

    expect(result[0]).toEqual({
      type: "function",
      name: "ping",
      description: "No params",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
        required: [],
      },
      strict: true,
    });
  });

  it("falls back to strict:false for native tools with non-strict-compatible schemas", () => {
    const tools = [
      {
        name: "read",
        description: "Read file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          additionalProperties: false,
        },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0], {
      strict: true,
    });

    expect(result[0]).toEqual({
      type: "function",
      name: "read",
      description: "Read file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
      strict: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("convertMessagesToInputItems", () => {
  it("converts a simple user text message", () => {
    const items = convertMessagesToInputItems([userMsg("Hello!")] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "message", role: "user", content: "Hello!" });
  });

  it("uses image_url parts for OpenAI-compatible user images", () => {
    const msg: FakeMessage = {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
      ],
      timestamp: 0,
    };
    const items = convertMessagesToInputItems(
      [msg] as Parameters<typeof convertMessagesToInputItems>[0],
      { api: "openai-completions", input: ["text", "image"] },
    );

    expect(items).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
  });

  it("keeps input_image parts for Responses user images", () => {
    const msg: FakeMessage = {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
      timestamp: 0,
    };
    const items = convertMessagesToInputItems(
      [msg] as Parameters<typeof convertMessagesToInputItems>[0],
      { api: "openai-responses", input: ["text", "image"] },
    );

    expect(items).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
    ]);
  });

  it("converts an assistant text-only message", () => {
    const items = convertMessagesToInputItems([assistantMsg(["Hi there."])] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "message", role: "assistant", content: "Hi there." });
  });

  it("preserves assistant phase on replayed assistant messages", () => {
    const items = convertMessagesToInputItems([
      assistantMsg(["Working on it."], [], "commentary"),
    ] as Parameters<typeof convertMessagesToInputItems>[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "message",
      role: "assistant",
      content: "Working on it.",
      phase: "commentary",
    });
  });

  it("converts an assistant message with a tool call", () => {
    const msg = assistantMsg(
      ["Let me run that."],
      [{ id: "call_1", name: "exec", args: { cmd: "ls" } }],
    );
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    // Should produce a text message and a function_call item
    const textItem = items.find((i) => i.type === "message");
    const fcItem = items.find((i) => i.type === "function_call");
    expect(textItem).toBeDefined();
    expect(fcItem).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "exec",
    });
    expect(textItem).not.toHaveProperty("phase");
    const fc = fcItem as { arguments: string };
    expect(JSON.parse(fc.arguments)).toEqual({ cmd: "ls" });
  });

  it("preserves assistant phase on commentary text before tool calls", () => {
    const msg = assistantMsg(
      ["Let me run that."],
      [{ id: "call_1", name: "exec", args: { cmd: "ls" } }],
      "commentary",
    );
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    const textItem = items.find((i) => i.type === "message");
    expect(textItem).toMatchObject({
      type: "message",
      role: "assistant",
      content: "Let me run that.",
      phase: "commentary",
    });
  });

  it("preserves assistant phase from textSignature metadata without local phase field", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "Working on it.",
          textSignature: JSON.stringify({ v: 1, id: "msg_sig", phase: "commentary" }),
        },
      ],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {},
      timestamp: 0,
    };
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "message",
      role: "assistant",
      content: "Working on it.",
      phase: "commentary",
    });
  });

  it("splits replayed assistant text on phase changes from block signatures", () => {
    const msg = {
      role: "assistant" as const,
      phase: "final_answer" as const,
      content: [
        {
          type: "text" as const,
          text: "Working... ",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text" as const,
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      usage: {},
      timestamp: 0,
    };

    expect(
      convertMessagesToInputItems([msg] as unknown as Parameters<
        typeof convertMessagesToInputItems
      >[0]),
    ).toEqual([
      {
        type: "message",
        role: "assistant",
        content: "Working... ",
        phase: "commentary",
      },
      {
        type: "message",
        role: "assistant",
        content: "Done.",
        phase: "final_answer",
      },
    ]);
  });

  it("inherits message-level phase for id-only textSignature blocks, merging with phased text", () => {
    const msg = {
      role: "assistant" as const,
      phase: "final_answer" as const,
      content: [
        {
          type: "text" as const,
          text: "Replay. ",
          textSignature: JSON.stringify({ v: 1, id: "item_pending_phase" }),
        },
        {
          type: "text" as const,
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      usage: {},
      timestamp: 0,
    };

    expect(
      convertMessagesToInputItems([msg] as unknown as Parameters<
        typeof convertMessagesToInputItems
      >[0]),
    ).toEqual([
      {
        type: "message",
        role: "assistant",
        content: "Replay. Done.",
        phase: "final_answer",
      },
    ]);
  });

  it("keeps truly unsigned legacy blocks separate when phased siblings are present", () => {
    const msg = {
      role: "assistant" as const,
      phase: "final_answer" as const,
      content: [
        {
          type: "text" as const,
          text: "Legacy. ",
        },
        {
          type: "text" as const,
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      usage: {},
      timestamp: 0,
    };

    expect(
      convertMessagesToInputItems([msg] as unknown as Parameters<
        typeof convertMessagesToInputItems
      >[0]),
    ).toEqual([
      {
        type: "message",
        role: "assistant",
        content: "Legacy. ",
      },
      {
        type: "message",
        role: "assistant",
        content: "Done.",
        phase: "final_answer",
      },
    ]);
  });

  it("preserves ordering when commentary text, tool calls, and final answer share one stored assistant message", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "Working... ",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "toolCall" as const,
          id: "call_1|fc_1",
          name: "exec",
          arguments: { cmd: "ls" },
        },
        {
          type: "text" as const,
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
      stopReason: "toolUse",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      usage: {},
      timestamp: 0,
    };

    expect(
      convertMessagesToInputItems([msg] as Parameters<typeof convertMessagesToInputItems>[0]),
    ).toEqual([
      {
        type: "message",
        role: "assistant",
        content: "Working... ",
        phase: "commentary",
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "exec",
        arguments: JSON.stringify({ cmd: "ls" }),
      },
      {
        type: "message",
        role: "assistant",
        content: "Done.",
        phase: "final_answer",
      },
    ]);
  });

  it("converts a tool result message", () => {
    const items = convertMessagesToInputItems([toolResultMsg("call_1", "file.txt")] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
      output: "file.txt",
    });
  });

  it("preserves OpenAI-compatible tool-result images as follow-up image_url parts", () => {
    const msg: FakeMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
      isError: false,
      timestamp: 0,
    };
    const items = convertMessagesToInputItems(
      [msg] as Parameters<typeof convertMessagesToInputItems>[0],
      { api: "openai-completions", input: ["text", "image"] },
    );

    expect(items).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "(see attached image)",
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Attached image(s) from tool result:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
  });

  it("drops tool result messages with empty tool call id", () => {
    const msg = {
      role: "toolResult" as const,
      toolCallId: "   ",
      toolName: "test_tool",
      content: [{ type: "text", text: "output" }],
      isError: false,
      timestamp: 0,
    };
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toEqual([]);
  });

  it("falls back to toolUseId when toolCallId is missing", () => {
    const msg = {
      role: "toolResult" as const,
      toolUseId: "call_from_tool_use",
      toolName: "test_tool",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 0,
    };
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "function_call_output",
      call_id: "call_from_tool_use",
      output: "ok",
    });
  });

  it("converts a full multi-turn conversation", () => {
    const messages: FakeMessage[] = [
      userMsg("Run ls"),
      assistantMsg([], [{ id: "call_1", name: "exec", args: { cmd: "ls" } }]),
      toolResultMsg("call_1", "file.txt\nfoo.ts"),
    ];
    const items = convertMessagesToInputItems(
      messages as Parameters<typeof convertMessagesToInputItems>[0],
    );

    const userItem = items.find(
      (i) => i.type === "message" && (i as { role?: string }).role === "user",
    );
    const fcItem = items.find((i) => i.type === "function_call");
    const outputItem = items.find((i) => i.type === "function_call_output");

    expect(userItem).toBeDefined();
    expect(fcItem).toBeDefined();
    expect(outputItem).toBeDefined();
  });

  it("handles assistant messages with only tool calls (no text)", () => {
    const msg = assistantMsg([], [{ id: "call_2", name: "read", args: { path: "/etc/hosts" } }]);
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("function_call");
  });

  it("drops assistant tool calls with empty ids", () => {
    const msg = assistantMsg([], [{ id: "   ", name: "read", args: { path: "/tmp/a" } }]);
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toEqual([]);
  });

  it("skips thinking blocks in assistant messages", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        { type: "thinking", thinking: "internal reasoning..." },
        { type: "text", text: "Here is my answer." },
      ],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {},
      timestamp: 0,
    };
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect((items[0] as { content?: unknown }).content).toBe("Here is my answer.");
  });

  it("replays reasoning blocks from thinking signatures", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        {
          type: "thinking" as const,
          thinking: "internal reasoning...",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_test",
            summary: [],
          }),
        },
        { type: "text" as const, text: "Here is my answer." },
      ],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {},
      timestamp: 0,
    };
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items.map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(items[0]).toMatchObject({ type: "reasoning", id: "rs_test", summary: [] });
  });

  it("replays encrypted reasoning content from thinking signatures", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        {
          type: "thinking" as const,
          thinking: "",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_encrypted",
            encrypted_content: "encrypted-payload",
            summary: [],
          }),
        },
        { type: "text" as const, text: "Here is my answer." },
      ],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {},
      timestamp: 0,
    };
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items.map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(items[0]).toMatchObject({
      type: "reasoning",
      id: "rs_encrypted",
      encrypted_content: "encrypted-payload",
      summary: [],
    });
  });

  it("replays reasoning blocks when signature type is reasoning.*", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        {
          type: "thinking" as const,
          thinking: "internal reasoning...",
          thinkingSignature: JSON.stringify({
            type: "reasoning.summary",
            id: "rs_summary",
          }),
        },
        { type: "text" as const, text: "Here is my answer." },
      ],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {},
      timestamp: 0,
    };
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items.map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(items[0]).toMatchObject({ type: "reasoning", id: "rs_summary" });
  });

  it("drops reasoning replay ids that do not match OpenAI reasoning ids", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        {
          type: "thinking" as const,
          thinking: "internal reasoning...",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "  bad-id  ",
          }),
        },
        { type: "text" as const, text: "Here is my answer." },
      ],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {},
      timestamp: 0,
    };
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toEqual([
      {
        type: "reasoning",
      },
      {
        type: "message",
        role: "assistant",
        content: "Here is my answer.",
      },
    ]);
  });

  it("returns empty array for empty messages", () => {
    expect(convertMessagesToInputItems([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("buildAssistantMessageFromResponse", () => {
  const modelInfo = { api: "openai-responses", provider: "openai", id: "gpt-5.4" };

  it("extracts text content from a message output item", () => {
    const response = makeResponseObject("resp_1", "Hello from assistant");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content).toHaveLength(1);
    const textBlock = msg.content[0] as { type: string; text: string };
    expect(textBlock.type).toBe("text");
    expect(textBlock.text).toBe("Hello from assistant");
  });

  it("sets stopReason to 'stop' for text-only responses", () => {
    const response = makeResponseObject("resp_1", "Just text");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.stopReason).toBe("stop");
  });

  it("extracts tool call from function_call output item", () => {
    const response = makeResponseObject("resp_2", undefined, "exec");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    const tc = msg.content.find((c) => c.type === "toolCall") as {
      type: string;
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(tc).toBeDefined();
    expect(tc.name).toBe("exec");
    expect(tc.id).toBe("call_abc|item_2");
    expect(tc.arguments).toEqual({ arg: "value" });
  });

  it("preserves malformed function-call arguments as the raw string", () => {
    const response: ResponseObject = {
      id: "resp_malformed",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "function_call",
          id: "item_bad_args",
          call_id: "call_bad",
          name: "exec",
          arguments: "not valid json",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    const tc = msg.content.find((c) => c.type === "toolCall") as {
      type: string;
      name: string;
      arguments: unknown;
    };

    expect(tc).toBeDefined();
    expect(tc.name).toBe("exec");
    expect(tc.arguments).toBe("not valid json");
  });

  it("sets stopReason to 'toolUse' when tool calls are present", () => {
    const response = makeResponseObject("resp_3", undefined, "exec");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.stopReason).toBe("toolUse");
  });

  it("includes both text and tool calls when both present", () => {
    const response = makeResponseObject("resp_4", "Running...", "exec");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content.some((c) => c.type === "text")).toBe(true);
    expect(msg.content.some((c) => c.type === "toolCall")).toBe(true);
    expect(msg.stopReason).toBe("toolUse");
  });

  it("maps usage tokens correctly", () => {
    const response = makeResponseObject("resp_5", "Hello");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.usage.input).toBe(100);
    expect(msg.usage.output).toBe(50);
    expect(msg.usage.totalTokens).toBe(150);
  });

  it("maps prompt_tokens and completion_tokens usage aliases", () => {
    const response = makeResponseObject("resp_5b", "Hello");
    response.usage = {
      prompt_tokens: 44,
      completion_tokens: 11,
      total_tokens: 55,
    };

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.usage.input).toBe(44);
    expect(msg.usage.output).toBe(11);
    expect(msg.usage.totalTokens).toBe(55);
  });

  it("falls back to normalized input and output when total_tokens is missing", () => {
    const response = makeResponseObject("resp_5c", "Hello");
    response.usage = {
      prompt_tokens: 10,
      completion_tokens: 5,
    };

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.usage.input).toBe(10);
    expect(msg.usage.output).toBe(5);
    expect(msg.usage.totalTokens).toBe(15);
  });

  it("falls back to normalized input and output when total_tokens is zero", () => {
    const response = makeResponseObject("resp_5d", "Hello");
    response.usage = {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 0,
    };

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.usage.input).toBe(10);
    expect(msg.usage.output).toBe(5);
    expect(msg.usage.totalTokens).toBe(15);
  });

  it("sets model/provider/api from modelInfo", () => {
    const response = makeResponseObject("resp_6", "Hi");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.api).toBe("openai-responses");
    expect(msg.provider).toBe("openai");
    expect(msg.model).toBe("gpt-5.4");
  });

  it("handles empty output gracefully", () => {
    const response = makeResponseObject("resp_7");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content).toEqual([]);
    expect(msg.stopReason).toBe("stop");
  });

  it("preserves phase from assistant message output items", () => {
    const response = makeResponseObject("resp_8", "Final answer", undefined, "final_answer");
    const msg = buildAssistantMessageFromResponse(response, modelInfo) as {
      phase?: string;
      content: Array<{ type: string; text?: string }>;
    };
    expect(msg.phase).toBe("final_answer");
    expect(msg.content[0]?.text).toBe("Final answer");
  });

  it("keeps only final-answer text when a response contains mixed assistant phases", () => {
    const response = {
      id: "resp_mixed_phase",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.2",
      output: [
        {
          type: "message",
          id: "item_commentary",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Working... " }],
        },
        {
          type: "message",
          id: "item_final",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Done." }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo) as {
      phase?: string;
      content: Array<{ type: string; text?: string; textSignature?: string }>;
    };

    expect(msg.phase).toBe("final_answer");
    expect(msg.content).toMatchObject([
      {
        type: "text",
        text: "Done.",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);
  });

  it("keeps only phased final text when unphased legacy text and phased final text coexist", () => {
    const response = {
      id: "resp_unphased_plus_final",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.2",
      output: [
        {
          type: "message",
          id: "item_legacy",
          role: "assistant",
          content: [{ type: "output_text", text: "Legacy. " }],
        },
        {
          type: "message",
          id: "item_final",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Done." }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo) as {
      phase?: string;
      content: Array<{ type: string; text?: string; textSignature?: string }>;
    };

    expect(msg.phase).toBe("final_answer");
    expect(msg.content).toMatchObject([
      {
        type: "text",
        text: "Done.",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);
  });

  it("drops commentary-only text from completed assistant messages but keeps tool calls", () => {
    const response = {
      id: "resp_commentary_only_tool",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.2",
      output: [
        {
          type: "message",
          id: "item_commentary",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Working... " }],
        },
        {
          type: "function_call",
          id: "item_tool",
          call_id: "call_abc",
          name: "exec",
          arguments: '{"arg":"value"}',
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo) as {
      phase?: string;
      content: Array<{ type: string; text?: string; name?: string }>;
      stopReason: string;
    };

    expect(msg.phase).toBeUndefined();
    expect(msg.content.some((part) => part.type === "text")).toBe(false);
    expect(msg.content).toMatchObject([{ type: "toolCall", name: "exec" }]);
    expect(msg.stopReason).toBe("toolUse");
  });

  it("maps reasoning output items to thinking blocks with signature", () => {
    const response = {
      id: "resp_reasoning",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "reasoning",
          id: "rs_123",
          summary: [{ text: "Plan step A" }, { text: "Plan step B" }],
        },
        {
          type: "message",
          id: "item_1",
          role: "assistant",
          content: [{ type: "output_text", text: "Final answer" }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    const thinkingBlock = msg.content.find((c) => c.type === "thinking") as
      | { type: "thinking"; thinking: string; thinkingSignature?: string }
      | undefined;
    expect(thinkingBlock?.thinking).toBe("Plan step A\nPlan step B");
    expect(thinkingBlock?.thinkingSignature).toBe(
      JSON.stringify({
        type: "reasoning",
        id: "rs_123",
        summary: [{ text: "Plan step A" }, { text: "Plan step B" }],
      }),
    );
  });

  it("maps reasoning.* output items to thinking blocks", () => {
    const response = {
      id: "resp_reasoning_kind",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "reasoning.summary",
          id: "rs_456",
          content: "Derived hidden reasoning",
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    const thinkingBlock = msg.content[0] as
      | { type: "thinking"; thinking: string; thinkingSignature?: string }
      | undefined;
    expect(thinkingBlock?.type).toBe("thinking");
    expect(thinkingBlock?.thinking).toBe("Derived hidden reasoning");
    expect(JSON.parse(thinkingBlock?.thinkingSignature ?? "{}")).toEqual({
      type: "reasoning.summary",
      id: "rs_456",
      content: "Derived hidden reasoning",
    });
  });

  it("prefers reasoning summary text over fallback content and preserves item order", () => {
    const response = {
      id: "resp_reasoning_order",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "reasoning.summary",
          id: "rs_789",
          summary: ["Plan A", { text: "Plan B" }, { nope: true }],
          content: "hidden fallback content",
        },
        {
          type: "function_call",
          id: "fc_789",
          call_id: "call_789",
          name: "exec",
          arguments: '{"arg":"value"}',
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content.map((block) => block.type)).toEqual(["thinking", "toolCall"]);
    const thinkingBlock = msg.content[0] as
      | { type: "thinking"; thinking: string; thinkingSignature?: string }
      | undefined;
    expect(thinkingBlock?.thinking).toBe("Plan A\nPlan B");
    expect(JSON.parse(thinkingBlock?.thinkingSignature ?? "{}")).toEqual({
      type: "reasoning.summary",
      id: "rs_789",
      content: "hidden fallback content",
      summary: ["Plan A", { text: "Plan B" }, { nope: true }],
    });
  });

  it("drops invalid reasoning ids from thinking signatures while preserving the visible block", () => {
    const response = {
      id: "resp_invalid_reasoning_id",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "reasoning",
          id: "invalid_reasoning_id",
          content: "Hidden reasoning",
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content).toEqual([{ type: "thinking", thinking: "Hidden reasoning" }]);
  });

  it("preserves encrypted-only reasoning items with empty visible thinking", () => {
    const response = {
      id: "resp_encrypted_reasoning",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "reasoning",
          id: "rs_encrypted_empty",
          encrypted_content: "encrypted-payload",
          summary: [],
        },
        {
          type: "message",
          id: "msg_encrypted_empty",
          role: "assistant",
          content: [{ type: "output_text", text: "NO_REPLY" }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as unknown as ResponseObject;

    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content.map((block) => block.type)).toEqual(["thinking", "text"]);
    const thinkingBlock = msg.content[0] as {
      type: "thinking";
      thinking: string;
      thinkingSignature?: string;
    };
    expect(thinkingBlock.thinking).toBe("");
    expect(JSON.parse(thinkingBlock.thinkingSignature ?? "{}")).toEqual({
      encrypted_content: "encrypted-payload",
      id: "rs_encrypted_empty",
      summary: [],
      type: "reasoning",
    });

    const replayItems = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(replayItems.map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(replayItems[0]).toMatchObject({
      type: "reasoning",
      id: "rs_encrypted_empty",
      encrypted_content: "encrypted-payload",
      summary: [],
    });
  });

  it("preserves function call item ids for replay when reasoning is present", () => {
    const response = {
      id: "resp_tool_reasoning",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "reasoning",
          id: "rs_tool",
          content: "Thinking before tool call",
        },
        {
          type: "function_call",
          id: "fc_tool",
          call_id: "call_tool",
          name: "exec",
          arguments: '{"arg":"value"}',
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as ResponseObject;

    const assistant = buildAssistantMessageFromResponse(response, modelInfo);
    const toolCall = assistant.content.find((item) => item.type === "toolCall") as
      | { type: "toolCall"; id: string }
      | undefined;
    expect(toolCall?.id).toBe("call_tool|fc_tool");

    const replayItems = convertMessagesToInputItems([assistant] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(replayItems.map((item) => item.type)).toEqual(["reasoning", "function_call"]);
    expect(replayItems[1]).toMatchObject({
      type: "function_call",
      call_id: "call_tool",
      id: "fc_tool",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("planTurnInput", () => {
  const replayModel = { input: ["text"] };

  it("uses incremental tool result replay when a previous response id and new tool results exist", () => {
    const context = {
      systemPrompt: "You are helpful.",
      messages: [
        userMsg("Run ls"),
        assistantMsg([], [{ id: "call_1|fc_1", name: "exec", args: { cmd: "ls" } }]),
        toolResultMsg("call_1|fc_1", "file.txt"),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const turnInput = planTurnInput({
      context,
      model: replayModel,
      previousResponseId: "resp_prev",
      lastContextLength: 2,
    });

    expect(turnInput.mode).toBe("incremental_tool_results");
    expect(turnInput.previousResponseId).toBe("resp_prev");
    expect(turnInput.inputItems).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "file.txt",
      },
    ]);
  });

  it("restarts with full context when follow-up turns have no new tool results", () => {
    const turn1Response = {
      id: "resp_turn1_reasoning",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "reasoning",
          id: "rs_turn1",
          content: "Thinking before tool call",
        },
        {
          type: "function_call",
          id: "fc_turn1",
          call_id: "call_turn1",
          name: "exec",
          arguments: '{"cmd":"ls"}',
        },
      ],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    } as ResponseObject;

    const context = {
      systemPrompt: "You are helpful.",
      messages: [
        userMsg("Run ls"),
        buildAssistantMessageFromResponse(turn1Response, {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        }),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const turnInput = planTurnInput({
      context,
      model: replayModel,
      previousResponseId: "resp_turn1_reasoning",
      lastContextLength: context.messages.length,
    });

    expect(turnInput.mode).toBe("full_context_restart");
    expect(turnInput.previousResponseId).toBeUndefined();
    expect(turnInput.inputItems.map((item) => item.type)).toEqual([
      "message",
      "reasoning",
      "function_call",
    ]);
    expect(turnInput.inputItems[1]).toMatchObject({ type: "reasoning", id: "rs_turn1" });
    expect(turnInput.inputItems[2]).toMatchObject({
      type: "function_call",
      call_id: "call_turn1",
      id: "fc_turn1",
    });
  });

  it("uses full context on the initial turn", () => {
    const context = {
      systemPrompt: "You are helpful.",
      messages: [userMsg("Hello!")] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const turnInput = planTurnInput({
      context,
      model: replayModel,
      previousResponseId: null,
      lastContextLength: 0,
    });

    expect(turnInput).toMatchObject({
      mode: "full_context_initial",
      inputItems: [{ type: "message", role: "user", content: "Hello!" }],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("planOpenAIWebSocketRequestPayload", () => {
  it("sends only the strict suffix when the full input extends the prior response chain", () => {
    const previousInputItems: InputItem[] = [{ type: "message", role: "user", content: "Hello" }];
    const previousRequest: ResponseCreateEvent = {
      type: "response.create",
      model: "gpt-5.4",
      store: false,
      instructions: "You are helpful.",
      input: previousInputItems,
    };
    const previousResponseInputItems: InputItem[] = [
      { type: "message", role: "assistant", content: "Hi" },
    ];
    const fullPayload: ResponseCreateEvent = {
      type: "response.create",
      model: "gpt-5.4",
      store: false,
      instructions: "You are helpful.",
      input: [
        ...previousInputItems,
        ...previousResponseInputItems,
        { type: "message", role: "user", content: "Next" },
      ],
    };

    const plan = planOpenAIWebSocketRequestPayload({
      fullPayload,
      previousRequestPayload: previousRequest,
      previousResponseId: "resp_prev",
      previousResponseInputItems: [...previousResponseInputItems],
    });

    expect(plan.mode).toBe("incremental");
    expect(plan.payload.previous_response_id).toBe("resp_prev");
    expect(plan.payload.input).toEqual([{ type: "message", role: "user", content: "Next" }]);
  });

  it("falls back to full context when non-input fields differ", () => {
    const previousInputItems: InputItem[] = [{ type: "message", role: "user", content: "Hello" }];
    const previousRequest: ResponseCreateEvent = {
      type: "response.create",
      model: "gpt-5.4",
      store: false,
      instructions: "Old instructions",
      input: previousInputItems,
    };
    const fullPayload: ResponseCreateEvent = {
      ...previousRequest,
      instructions: "New instructions",
      input: [
        ...previousInputItems,
        { type: "message", role: "assistant", content: "Hi" },
        { type: "message", role: "user", content: "Next" },
      ],
    };

    const plan = planOpenAIWebSocketRequestPayload({
      fullPayload,
      previousRequestPayload: previousRequest,
      previousResponseId: "resp_prev",
      previousResponseInputItems: [{ type: "message", role: "assistant", content: "Hi" }],
    });

    expect(plan.mode).toBe("full_context");
    expect(plan.payload.previous_response_id).toBeUndefined();
    expect(plan.payload.input).toEqual(fullPayload.input);
  });

  it("falls back to full context when the input is not a strict response-chain extension", () => {
    const previousRequest: ResponseCreateEvent = {
      type: "response.create",
      model: "gpt-5.4",
      store: false,
      input: [{ type: "message", role: "user", content: "Hello" }],
    };
    const fullPayload: ResponseCreateEvent = {
      ...previousRequest,
      input: [{ type: "message", role: "user", content: "Different" }],
    };

    const plan = planOpenAIWebSocketRequestPayload({
      fullPayload,
      previousRequestPayload: previousRequest,
      previousResponseId: "resp_prev",
      previousResponseInputItems: [{ type: "message", role: "assistant", content: "Hi" }],
    });

    expect(plan.mode).toBe("full_context");
    expect(plan.payload.previous_response_id).toBeUndefined();
    expect(plan.payload.input).toEqual(fullPayload.input);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenAIWebSocketStreamFn", () => {
  const modelStub = {
    api: "openai-responses",
    provider: "openai",
    id: "gpt-5.4",
    contextWindow: 128000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    name: "GPT-5.2",
  };

  const contextStub = {
    systemPrompt: "You are helpful.",
    messages: [userMsg("Hello!") as Parameters<typeof convertMessagesToInputItems>[0][number]],
    tools: [],
  };

  beforeEach(() => {
    MockManager.reset();
    streamSimpleCalls.length = 0;
    mockCreateHttpFallbackStreamFn.mockReset();
    mockCreateHttpFallbackStreamFn.mockReturnValue(mockStreamSimple as never);
    openAIWsStreamTesting.setDepsForTest({
      createManager: ((options?: unknown) => new MockManager(options)) as never,
      createHttpFallbackStreamFn: mockCreateHttpFallbackStreamFn as never,
      streamSimple: mockStreamSimple,
    });
  });

  afterEach(() => {
    // Clean up any sessions created in tests to avoid cross-test pollution
    MockManager.instances.forEach((_, i) => {
      // Session IDs used in tests follow a predictable pattern
      releaseWsSession(`test-session-${i}`);
    });
    releaseWsSession("sess-1");
    releaseWsSession("sess-2");
    releaseWsSession("sess-boundary");
    releaseWsSession("sess-fallback");
    releaseWsSession("sess-explicit-sse");
    releaseWsSession("sess-boundary-http-fallback");
    releaseWsSession("sess-full-context-replay");
    releaseWsSession("sess-encrypted-full-context-replay");
    releaseWsSession("sess-incremental");
    releaseWsSession("sess-full");
    releaseWsSession("sess-onpayload");
    releaseWsSession("sess-onpayload-async");
    releaseWsSession("sess-phase");
    releaseWsSession("sess-phase-stream");
    releaseWsSession("sess-phase-late-map");
    releaseWsSession("sess-reason");
    releaseWsSession("sess-reason-none");
    releaseWsSession("sess-tools");
    releaseWsSession("sess-store-default");
    releaseWsSession("sess-store-compat");
    releaseWsSession("sess-store-proxy");
    releaseWsSession("sess-max-tokens-zero");
    releaseWsSession("sess-runtime-fallback-nested");
    releaseWsSession("sess-runtime-fallback");
    releaseWsSession("sess-runtime-retry");
    releaseWsSession("sess-send-fail-reset");
    releaseWsSession("sess-temp");
    releaseWsSession("sess-text-verbosity");
    releaseWsSession("sess-text-verbosity-invalid");
    releaseWsSession("sess-topp");
    releaseWsSession("sess-turn-metadata-retry");
    releaseWsSession("sess-warmup-disabled");
    releaseWsSession("sess-warmup-enabled");
    releaseWsSession("sess-degraded-cooldown");
    releaseWsSession("sess-drop");
    openAIWsStreamTesting.setWsDegradeCooldownMsForTest();
    openAIWsStreamTesting.setDepsForTest();
  });

  it("connects to the WebSocket on first call", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-1");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    // Give the microtask queue time to run
    await new Promise((r) => setImmediate(r));

    const manager = MockManager.lastInstance;
    expect(manager?.connectCallCount).toBe(1);
    releaseWsSession("sess-1");
    for await (const _ of await resolveStream(stream)) {
      // consume
    }
  });

  it("sends a response.create event on first turn (full context)", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-full");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const completed = new Promise<void>((res, rej) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          const manager = MockManager.lastInstance!;

          // Simulate the server completing the response
          manager.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp_1", "Hello!"),
          });

          for await (const _ of await resolveStream(stream)) {
            // consume events
          }
          res();
        } catch (e) {
          rej(e);
        }
      });
    });

    await completed;

    const manager = MockManager.lastInstance!;
    expect(manager.sentEvents).toHaveLength(1);
    const sent = manager.sentEvents[0] as { type: string; model: string; input: unknown[] };
    expect(sent.type).toBe("response.create");
    expect(sent.model).toBe("gpt-5.4");
    expect(Array.isArray(sent.input)).toBe(true);
  });

  it("includes store:false by default", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-store-default");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const completed = new Promise<void>((res, rej) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          const manager = MockManager.lastInstance!;
          manager.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp_store_default", "ok"),
          });
          for await (const _ of await resolveStream(stream)) {
            // consume
          }
          res();
        } catch (e) {
          rej(e);
        }
      });
    });
    await completed;

    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.store).toBe(false);
  });

  it("omits store when compat.supportsStore is false (#39086)", async () => {
    releaseWsSession("sess-store-compat");
    const noStoreModel = {
      ...modelStub,
      compat: { supportsStore: false },
    };
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-store-compat");
    const stream = streamFn(
      noStoreModel as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const completed = new Promise<void>((res, rej) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          const manager = MockManager.lastInstance!;
          manager.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp_no_store", "ok"),
          });
          for await (const _ of await resolveStream(stream)) {
            // consume
          }
          res();
        } catch (e) {
          rej(e);
        }
      });
    });
    await completed;

    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("store");
  });

  it("keeps store=false for proxied openai-responses routes when store is still supported", () => {
    const proxiedModel = {
      ...modelStub,
      baseUrl: "https://proxy.example.com/v1",
    };
    const turnInput = planTurnInput({
      context: contextStub as Parameters<typeof planTurnInput>[0]["context"],
      model: proxiedModel as Parameters<typeof planTurnInput>[0]["model"],
      previousResponseId: null,
      lastContextLength: 0,
    });
    const sent = buildOpenAIWebSocketResponseCreatePayload({
      model: proxiedModel as Parameters<
        typeof buildOpenAIWebSocketResponseCreatePayload
      >[0]["model"],
      context: contextStub as Parameters<
        typeof buildOpenAIWebSocketResponseCreatePayload
      >[0]["context"],
      turnInput,
      tools: [],
    }) as Record<string, unknown>;
    expect(sent.store).toBe(false);
  });

  it("emits an AssistantMessage on response.completed", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-2");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: unknown[] = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_hello", "Hello back!"),
    });

    await done;

    const doneEvent = events.find((e) => (e as { type?: string }).type === "done") as
      | {
          type: string;
          reason: string;
          message: { content: Array<{ text: string }> };
        }
      | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.message.content[0]?.text).toBe("Hello back!");
  });

  it("suppresses commentary-only text on completed WebSocket responses", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phase");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: unknown[] = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_phase", "Working...", "exec", "commentary"),
    });

    await done;

    const doneEvent = events.find((e) => (e as { type?: string }).type === "done") as
      | {
          type: string;
          reason: string;
          message: { phase?: string; stopReason: string; content?: Array<{ type?: string }> };
        }
      | undefined;
    expect(doneEvent?.message.phase).toBeUndefined();
    expect(doneEvent?.message.content?.some((part) => part.type === "text")).toBe(false);
    expect(doneEvent?.message.stopReason).toBe("toolUse");
  });

  it("emits accumulated phase-aware partials when output item mapping is available", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phase-stream");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: Array<{
      type?: string;
      delta?: string;
      partial?: { phase?: string; content?: unknown[] };
    }> = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev as (typeof events)[number]);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "item_commentary",
        role: "assistant",
        phase: "commentary",
        content: [],
      },
    });
    manager.simulateEvent({
      type: "response.output_text.delta",
      item_id: "item_commentary",
      output_index: 0,
      content_index: 0,
      delta: "Working",
    });
    manager.simulateEvent({
      type: "response.output_text.delta",
      item_id: "item_commentary",
      output_index: 0,
      content_index: 0,
      delta: "...",
    });
    manager.simulateEvent({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "message",
        id: "item_final",
        role: "assistant",
        phase: "final_answer",
        content: [],
      },
    });
    manager.simulateEvent({
      type: "response.output_text.delta",
      item_id: "item_final",
      output_index: 1,
      content_index: 0,
      delta: "Done.",
    });
    manager.simulateEvent({
      type: "response.completed",
      response: {
        id: "resp_phase_stream",
        object: "response",
        created_at: Date.now(),
        status: "completed",
        model: "gpt-5.2",
        output: [
          {
            type: "message",
            id: "item_commentary",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Working..." }],
          },
          {
            type: "message",
            id: "item_final",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Done." }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    });

    await done;

    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas).toHaveLength(3);
    expect(deltas[0]).toMatchObject({ delta: "Working" });
    expect(deltas[0]?.partial?.phase).toBe("commentary");
    expect(deltas[0]?.partial?.content).toEqual([
      {
        type: "text",
        text: "Working",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
    ]);
    expect(deltas[1]).toMatchObject({ delta: "..." });
    expect(deltas[1]?.partial?.phase).toBe("commentary");
    expect(deltas[1]?.partial?.content).toEqual([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
    ]);
    expect(deltas[2]).toMatchObject({ delta: "Done." });
    expect(deltas[2]?.partial?.phase).toBe("final_answer");
    expect(deltas[2]?.partial?.content).toEqual([
      {
        type: "text",
        text: "Done.",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);
  });

  it("buffers text deltas until item mapping is available", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phase-late-map");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: Array<{
      type?: string;
      delta?: string;
      partial?: { phase?: string; content?: unknown[] };
    }> = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev as (typeof events)[number]);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.output_text.delta",
      item_id: "item_late",
      output_index: 0,
      content_index: 0,
      delta: "Working",
    });
    manager.simulateEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "item_late",
        role: "assistant",
        phase: "commentary",
        content: [],
      },
    });
    manager.simulateEvent({
      type: "response.output_text.delta",
      item_id: "item_late",
      output_index: 0,
      content_index: 0,
      delta: "...",
    });
    manager.simulateEvent({
      type: "response.completed",
      response: {
        id: "resp_phase_late_map",
        object: "response",
        created_at: Date.now(),
        status: "completed",
        model: "gpt-5.2",
        output: [
          {
            type: "message",
            id: "item_late",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Working..." }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    });

    await done;

    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ delta: "Working" });
    expect(deltas[0]?.partial?.phase).toBe("commentary");
    expect(deltas[0]?.partial?.content).toEqual([
      {
        type: "text",
        text: "Working",
        textSignature: JSON.stringify({ v: 1, id: "item_late", phase: "commentary" }),
      },
    ]);
    expect(deltas[1]).toMatchObject({ delta: "..." });
    expect(deltas[1]?.partial?.phase).toBe("commentary");
    expect(deltas[1]?.partial?.content).toEqual([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_late", phase: "commentary" }),
      },
    ]);
  });

  it("keeps buffering text deltas until item phase is defined", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phase-late-map-undefined");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: Array<{
      type?: string;
      delta?: string;
      partial?: { phase?: string; content?: unknown[] };
    }> = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev as (typeof events)[number]);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.output_text.delta",
      item_id: "item_late_undefined",
      output_index: 0,
      content_index: 0,
      delta: "Working",
    });
    manager.simulateEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "item_late_undefined",
        role: "assistant",
        content: [],
      },
    });
    manager.simulateEvent({
      type: "response.output_text.delta",
      item_id: "item_late_undefined",
      output_index: 0,
      content_index: 0,
      delta: "...",
    });

    await new Promise((r) => setImmediate(r));
    const prematureDeltas = events.filter((event) => event.type === "text_delta");
    expect(prematureDeltas).toHaveLength(0);

    manager.simulateEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "item_late_undefined",
        role: "assistant",
        phase: "commentary",
        content: [],
      },
    });
    manager.simulateEvent({
      type: "response.completed",
      response: {
        id: "resp_phase_late_map_undefined",
        object: "response",
        created_at: Date.now(),
        status: "completed",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            id: "item_late_undefined",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Working..." }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    });

    await done;

    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ delta: "Working..." });
    expect(deltas[0]?.partial?.phase).toBe("commentary");
    expect(deltas[0]?.partial?.content).toEqual([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({
          v: 1,
          id: "item_late_undefined",
          phase: "commentary",
        }),
      },
    ]);
  });
  it("buffers text when output_item.added arrives without phase metadata", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phaseless-gate");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: Array<{
      type?: string;
      delta?: string;
      partial?: { phase?: string; content?: unknown[] };
    }> = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev as (typeof events)[number]);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;

    // output_item.added WITHOUT phase — simulates phaseless announcement
    manager.simulateEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "item_phaseless",
        role: "assistant",
        content: [],
      },
    });

    // Text delta arrives while phase is still unknown
    manager.simulateEvent({
      type: "response.output_text.delta",
      item_id: "item_phaseless",
      output_index: 0,
      content_index: 0,
      delta: "Leaked?",
    });

    // Yield to let any would-be emissions propagate
    await new Promise((r) => setImmediate(r));
    const prematureDeltas = events.filter((e) => e.type === "text_delta");
    expect(prematureDeltas).toHaveLength(0);

    // output_item.done delivers the actual phase — should flush buffered text
    manager.simulateEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "item_phaseless",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Leaked?" }],
      },
    });

    manager.simulateEvent({
      type: "response.completed",
      response: {
        id: "resp_phaseless_gate",
        object: "response",
        created_at: Date.now(),
        status: "completed",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            id: "item_phaseless",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Leaked?" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    });

    await done;

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ delta: "Leaked?" });
    expect(deltas[0]?.partial?.phase).toBe("commentary");
  });

  it("buffers output_text.done until item phase is defined", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-phaseless-done-gate");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: Array<{
      type?: string;
      delta?: string;
      partial?: { phase?: string; content?: unknown[] };
    }> = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev as (typeof events)[number]);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;

    manager.simulateEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "item_phaseless_done",
        role: "assistant",
        content: [],
      },
    });
    manager.simulateEvent({
      type: "response.output_text.done",
      item_id: "item_phaseless_done",
      output_index: 0,
      content_index: 0,
      text: "Buffered final text",
    });

    await new Promise((r) => setImmediate(r));
    const prematureDeltas = events.filter((event) => event.type === "text_delta");
    expect(prematureDeltas).toHaveLength(0);

    manager.simulateEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "item_phaseless_done",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Buffered final text" }],
      },
    });
    manager.simulateEvent({
      type: "response.completed",
      response: {
        id: "resp_phaseless_done_gate",
        object: "response",
        created_at: Date.now(),
        status: "completed",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            id: "item_phaseless_done",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Buffered final text" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    });

    await done;

    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ delta: "Buffered final text" });
    expect(deltas[0]?.partial?.phase).toBe("commentary");
  });

  it("falls back to HTTP when WebSocket connect fails (session pre-broken via flag)", async () => {
    // Set the class-level flag BEFORE calling streamFn so the new instance
    // fails on connect().  We patch the static default via MockManager directly.
    MockManager.globalConnectShouldFail = true;

    try {
      const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-fallback");
      const stream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
      );

      // Consume — should fall back to HTTP (streamSimple mock).
      const messages: unknown[] = [];
      for await (const ev of await resolveStream(stream)) {
        messages.push(ev);
      }

      // streamSimple was called as part of HTTP fallback
      expect(streamSimpleCalls.length).toBeGreaterThanOrEqual(1);

      // The failed manager is closed before the replacement session manager is installed.
      expect(MockManager.instances.some((instance) => instance.closeCallCount >= 1)).toBe(true);
    } finally {
      MockManager.globalConnectShouldFail = false;
    }
  });

  it("ends the HTTP fallback stream when explicit SSE transport is selected", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-explicit-sse");
    const stream = await resolveStream(
      streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
        { transport: "sse" } as Parameters<typeof streamFn>[2],
      ),
    );

    await expect(
      Promise.race([
        (
          stream as unknown as {
            result: () => Promise<{ content?: Array<{ text?: string }> }>;
          }
        ).result(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("SSE fallback result timed out")), 100),
        ),
      ]),
    ).resolves.toMatchObject({
      content: [{ text: "http fallback response" }],
    });
    expect(streamSimpleCalls).toHaveLength(1);
  });

  it("falls back to HTTP when WebSocket errors before any output in auto mode", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-runtime-fallback");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "auto" } as Parameters<typeof streamFn>[2],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "error",
      message: "temporary upstream glitch",
      code: "ws_runtime_error",
    });

    const events: Array<{ type?: string; message?: { content?: Array<{ text?: string }> } }> = [];
    for await (const ev of await resolveStream(stream)) {
      events.push(ev as { type?: string; message?: { content?: Array<{ text?: string }> } });
    }

    expect(streamSimpleCalls.length).toBeGreaterThanOrEqual(1);
    expect(manager.closeCallCount).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent?.message?.content?.[0]?.text).toBe("http fallback response");
  });

  it("falls back to HTTP when OpenAI sends a nested websocket error payload", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-runtime-fallback-nested");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "auto" } as Parameters<typeof streamFn>[2],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        code: "previous_response_not_found",
        message: "Previous response with id 'resp_abc' not found.",
        param: "previous_response_id",
      },
    });

    const events: Array<{ type?: string; message?: { content?: Array<{ text?: string }> } }> = [];
    for await (const ev of await resolveStream(stream)) {
      events.push(ev as { type?: string; message?: { content?: Array<{ text?: string }> } });
    }

    expect(streamSimpleCalls.length).toBeGreaterThanOrEqual(1);
    expect(manager.closeCallCount).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent?.message?.content?.[0]?.text).toBe("http fallback response");
  });

  it("retries one retryable mid-request close before falling back in auto mode", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-runtime-retry");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "auto" } as Parameters<typeof streamFn>[2],
    );

    await new Promise((r) => setImmediate(r));
    const firstManager = MockManager.lastInstance!;
    firstManager.simulateClose(1006, "connection lost");

    await new Promise((r) => setImmediate(r));
    const secondManager = MockManager.lastInstance!;
    expect(secondManager).not.toBe(firstManager);
    expect(secondManager.connectCallCount).toBe(1);

    secondManager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp-retried", "retry succeeded"),
    });

    const events: Array<{ type?: string; message?: { content?: Array<{ text?: string }> } }> = [];
    for await (const ev of await resolveStream(stream)) {
      events.push(ev as { type?: string; message?: { content?: Array<{ text?: string }> } });
    }

    expect(streamSimpleCalls).toHaveLength(0);
    expect(firstManager.closeCallCount).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent?.message?.content?.[0]?.text).toBe("retry succeeded");
  });

  it("keeps native turn metadata stable across websocket retries and increments attempt", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-turn-metadata-retry");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "auto" } as Parameters<typeof streamFn>[2],
    );

    await new Promise((r) => setImmediate(r));
    const firstManager = MockManager.lastInstance!;
    firstManager.simulateClose(1006, "connection lost");

    await new Promise((r) => setImmediate(r));
    const secondManager = MockManager.lastInstance!;
    secondManager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp-retried-meta", "retry succeeded"),
    });

    for await (const _ of await resolveStream(stream)) {
      // consume
    }

    const firstPayload = firstManager.sentEvents[0] as { metadata?: Record<string, string> };
    const secondPayload = secondManager.sentEvents[0] as { metadata?: Record<string, string> };
    expect(firstPayload.metadata?.openclaw_session_id).toBe("sess-turn-metadata-retry");
    expect(firstPayload.metadata?.openclaw_transport).toBe("websocket");
    expect(firstPayload.metadata?.openclaw_turn_id).toBeTruthy();
    expect(secondPayload.metadata?.openclaw_turn_id).toBe(firstPayload.metadata?.openclaw_turn_id);
    expect(firstPayload.metadata?.openclaw_turn_attempt).toBe("1");
    expect(secondPayload.metadata?.openclaw_turn_attempt).toBe("2");
  });

  it("does not attach native OpenAI session headers or metadata for custom responses endpoints", async () => {
    const sessionId = "sess-custom-openai-endpoint";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);
    const customEndpointModel = {
      ...modelStub,
      baseUrl: "http://127.0.0.1:4100/v1",
    };
    const stream = streamFn(
      customEndpointModel as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "websocket" } as Parameters<typeof streamFn>[2],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp-custom-endpoint", "custom endpoint"),
    });

    for await (const _ of await resolveStream(stream)) {
      // consume
    }

    expect((manager.options as { headers?: Record<string, string> } | undefined)?.headers).toBe(
      undefined,
    );
    const payload = manager.sentEvents[0] as { metadata?: Record<string, string> };
    expect(payload.metadata?.openclaw_session_id).toBeUndefined();
    expect(payload.metadata?.openclaw_transport).toBeUndefined();
    releaseWsSession(sessionId);
  });

  it("keeps websocket degraded for the session until the cool-down expires", async () => {
    openAIWsStreamTesting.setWsDegradeCooldownMsForTest(50);
    MockManager.globalConnectShouldFail = true;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);

    try {
      const sessionId = "sess-degraded-cooldown";
      const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

      const firstStream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
        { transport: "auto" } as Parameters<typeof streamFn>[2],
      );
      void firstStream;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(streamSimpleCalls.length).toBe(1);
      expect(MockManager.instances).toHaveLength(2);
      const cooledManager = MockManager.lastInstance!;
      expect(cooledManager.connectCallCount).toBe(0);

      MockManager.globalConnectShouldFail = false;

      const secondStream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
        { transport: "auto" } as Parameters<typeof streamFn>[2],
      );
      void secondStream;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(streamSimpleCalls.length).toBe(2);
      expect(MockManager.instances).toHaveLength(2);
      expect(cooledManager.connectCallCount).toBe(0);

      nowSpy.mockReturnValue(1_060);

      const thirdStream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
        { transport: "auto" } as Parameters<typeof streamFn>[2],
      );

      void thirdStream;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(cooledManager.connectCallCount).toBe(1);
      expect(streamSimpleCalls.length).toBe(2);
      cooledManager.simulateEvent({
        type: "response.completed",
        response: makeResponseObject("resp-after-cooldown", "ws recovered"),
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      nowSpy.mockRestore();
      MockManager.globalConnectShouldFail = false;
      openAIWsStreamTesting.setWsDegradeCooldownMsForTest();
      releaseWsSession("sess-degraded-cooldown");
      releaseWsSession("sess-turn-metadata-retry");
    }
  });

  it("tracks previous_response_id across turns (incremental send)", async () => {
    const sessionId = "sess-incremental";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    // ── Turn 1: full context ─────────────────────────────────────────────
    const ctx1 = {
      systemPrompt: "You are helpful.",
      messages: [userMsg("Run ls")] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx1 as Parameters<typeof streamFn>[1],
    );

    const events1: unknown[] = [];
    const done1 = (async () => {
      for await (const ev of await resolveStream(stream1)) {
        events1.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;

    // Server responds with a tool call
    const turn1Response = makeResponseObject("resp_turn1", undefined, "exec");
    manager.simulateEvent({ type: "response.completed", response: turn1Response });
    await done1;

    // ── Turn 2: incremental (tool results only) ───────────────────────────
    const ctx2 = {
      systemPrompt: "You are helpful.",
      messages: [
        userMsg("Run ls"),
        buildAssistantMessageFromResponse(turn1Response, modelStub),
        toolResultMsg("call_abc|item_2", "file.txt"),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx2 as Parameters<typeof streamFn>[1],
    );

    const events2: unknown[] = [];
    const done2 = (async () => {
      for await (const ev of await resolveStream(stream2)) {
        events2.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_turn2", "Here are the files."),
    });
    await done2;

    // Turn 2 should have sent previous_response_id and only tool results
    expect(manager.sentEvents).toHaveLength(2);
    const sent2 = manager.sentEvents[1] as {
      previous_response_id?: string;
      input: Array<{ type: string }>;
    };
    expect(sent2.previous_response_id).toBe("resp_turn1");
    // Input should only contain tool results, not the full history
    const inputTypes = (sent2.input ?? []).map((i) => i.type);
    expect(inputTypes.every((t) => t === "function_call_output")).toBe(true);
    expect(inputTypes).toHaveLength(1);
  });

  it("sends only a follow-up user message when the full context is a strict extension", async () => {
    const sessionId = "sess-user-delta";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    const ctx1 = {
      systemPrompt: "You are helpful.",
      messages: [userMsg("Hello")] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx1 as Parameters<typeof streamFn>[1],
    );
    const done1 = (async () => {
      for await (const _ of await resolveStream(stream1)) {
        /* consume */
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    const turn1Response = makeResponseObject("resp_turn1_text", "Hi there.");
    manager.simulateEvent({ type: "response.completed", response: turn1Response });
    await done1;

    const ctx2 = {
      systemPrompt: "You are helpful.",
      messages: [
        userMsg("Hello"),
        buildAssistantMessageFromResponse(turn1Response, modelStub),
        userMsg("What can you do?"),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx2 as Parameters<typeof streamFn>[1],
    );
    const done2 = (async () => {
      for await (const _ of await resolveStream(stream2)) {
        /* consume */
      }
    })();

    await new Promise((r) => setImmediate(r));
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_turn2_text", "I can help."),
    });
    await done2;

    const sent2 = manager.sentEvents[1] as {
      previous_response_id?: string;
      input: Array<{ type: string; role?: string; content?: unknown }>;
    };
    expect(sent2.previous_response_id).toBe("resp_turn1_text");
    expect(sent2.input).toEqual([{ type: "message", role: "user", content: "What can you do?" }]);
  });

  it("uses an empty incremental payload when replay context exactly matches the response chain", async () => {
    const sessionId = "sess-full-context-replay";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    const ctx1 = {
      systemPrompt: "You are helpful.",
      messages: [userMsg("Run ls")] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const turn1Response = {
      id: "resp_turn1_reasoning",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "reasoning",
          id: "rs_turn1",
          content: "Thinking before tool call",
        },
        {
          type: "function_call",
          id: "fc_turn1",
          call_id: "call_turn1",
          name: "exec",
          arguments: '{"cmd":"ls"}',
        },
      ],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    } as ResponseObject;

    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx1 as Parameters<typeof streamFn>[1],
    );
    const done1 = (async () => {
      for await (const _ of await resolveStream(stream1)) {
        /* consume */
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({ type: "response.completed", response: turn1Response });
    await done1;

    const ctx2 = {
      systemPrompt: "You are helpful.",
      messages: [
        userMsg("Run ls"),
        buildAssistantMessageFromResponse(turn1Response, modelStub),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx2 as Parameters<typeof streamFn>[1],
    );
    const done2 = (async () => {
      for await (const _ of await resolveStream(stream2)) {
        /* consume */
      }
    })();

    await new Promise((r) => setImmediate(r));
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_turn2", "Done"),
    });
    await done2;

    const sent2 = manager.sentEvents[1] as {
      previous_response_id?: string;
      input: Array<{ type: string; id?: string; call_id?: string }>;
    };
    expect(sent2.previous_response_id).toBe("resp_turn1_reasoning");
    expect(sent2.input).toEqual([]);
  });

  it("replays encrypted-only reasoning when websocket must send full context", async () => {
    const sessionId = "sess-encrypted-full-context-replay";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    const ctx1 = {
      systemPrompt: "You are helpful.",
      messages: [userMsg("Run ls")] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };
    const turn1Response = {
      id: "resp_turn1_encrypted_reasoning",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "reasoning",
          id: "rs_turn1_encrypted",
          encrypted_content: "encrypted-payload",
          summary: [],
        },
        {
          type: "function_call",
          id: "fc_turn1",
          call_id: "call_turn1",
          name: "exec",
          arguments: '{"cmd":"ls"}',
        },
      ],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    } as ResponseObject;

    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx1 as Parameters<typeof streamFn>[1],
    );
    const done1 = (async () => {
      for await (const _ of await resolveStream(stream1)) {
        /* consume */
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({ type: "response.completed", response: turn1Response });
    await done1;

    const ctx2 = {
      systemPrompt: "You are helpful. Use the updated instruction.",
      messages: [
        userMsg("Run ls"),
        buildAssistantMessageFromResponse(turn1Response, modelStub),
        toolResultMsg("call_turn1|fc_turn1", "TOOL_OK"),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx2 as Parameters<typeof streamFn>[1],
    );
    const done2 = (async () => {
      for await (const _ of await resolveStream(stream2)) {
        /* consume */
      }
    })();

    await new Promise((r) => setImmediate(r));
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_turn2", "Done"),
    });
    await done2;

    const sent2 = manager.sentEvents[1] as {
      previous_response_id?: string;
      input: Array<Record<string, unknown>>;
    };
    expect(sent2.previous_response_id).toBeUndefined();
    expect(sent2.input).toEqual([
      { type: "message", role: "user", content: "Run ls" },
      {
        type: "reasoning",
        id: "rs_turn1_encrypted",
        encrypted_content: "encrypted-payload",
        summary: [],
      },
      {
        type: "function_call",
        id: "fc_turn1",
        call_id: "call_turn1",
        name: "exec",
        arguments: '{"cmd":"ls"}',
      },
      { type: "function_call_output", call_id: "call_turn1", output: "TOOL_OK" },
    ]);
  });

  it("sends instructions (system prompt) in each request", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-tools");
    const ctx = {
      systemPrompt: "Be concise.",
      messages: [userMsg("Hello")] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [{ name: "exec", description: "run", parameters: {} }],
    };

    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_x", "ok"),
    });

    for await (const _ of await resolveStream(stream)) {
      // consume
    }

    const sent = manager.sentEvents[0] as {
      instructions?: string;
      tools?: unknown[];
    };
    expect(sent.instructions).toBe("Be concise.");
    expect(Array.isArray(sent.tools)).toBe(true);
    expect((sent.tools ?? []).length).toBeGreaterThan(0);
  });

  it("strips the internal cache boundary from websocket instructions", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-boundary");
    const ctx = {
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
      messages: [userMsg("Hello")] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_boundary", "ok"),
    });

    for await (const _ of await resolveStream(stream)) {
      // consume
    }

    const sent = manager.sentEvents[0] as {
      instructions?: string;
    };
    expect(sent.instructions).toBe("Stable prefix\nDynamic suffix");
  });

  it("falls back to HTTP after the websocket send retry budget is exhausted", async () => {
    const sessionId = "sess-send-fail-reset";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    // 1. Run a successful first turn to populate the registry
    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-ok", "OK"),
          });
          for await (const _ of await resolveStream(stream1)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    expect(hasWsSession(sessionId)).toBe(true);

    // 2. Exhaust both websocket send attempts so auto mode must fall back.
    MockManager.globalSendFailuresRemaining = 2;
    const callsBefore = streamSimpleCalls.length;

    // 3. Second call: send throws → must fall back to HTTP and clear registry
    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );
    for await (const _ of await resolveStream(stream2)) {
      /* consume */
    }

    // Registry cleared after retry budget exhaustion + HTTP fallback
    expect(hasWsSession(sessionId)).toBe(false);
    // HTTP fallback invoked
    expect(streamSimpleCalls.length).toBeGreaterThan(callsBefore);
  });

  it("routes websocket HTTP fallback through the configured HTTP fallback builder", async () => {
    const httpFallbackCalls: Array<{ model: unknown; context: unknown; options?: unknown }> = [];
    const httpFallbackStreamFn = vi.fn((model: unknown, context: unknown, options?: unknown) => {
      httpFallbackCalls.push({ model, context, options });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const msg = makeFakeAssistantMessage("boundary-safe fallback");
        stream.push({ type: "done", reason: "stop", message: msg });
        stream.end();
      });
      return stream;
    });
    mockCreateHttpFallbackStreamFn.mockReturnValue(httpFallbackStreamFn as never);
    const sessionId = "sess-boundary-http-fallback";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-ok", "OK"),
          });
          for await (const _ of await resolveStream(stream1)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    MockManager.globalSendFailuresRemaining = 2;
    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      {
        ...contextStub,
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
      } as Parameters<typeof streamFn>[1],
    );
    for await (const _ of await resolveStream(stream2)) {
      /* consume */
    }

    expect(mockCreateHttpFallbackStreamFn).toHaveBeenCalled();
    expect(streamSimpleCalls).toHaveLength(0);
    expect(httpFallbackCalls).toHaveLength(1);
    expect(httpFallbackCalls[0]?.context).toMatchObject({
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
    });
  });

  it("keeps the default websocket HTTP fallback on the OpenClaw transport", () => {
    expect(
      openAIWsStreamTesting.getDefaultHttpFallbackStreamFnForTest(modelStub as never),
    ).toBeTypeOf("function");
  });

  it("forwards temperature and maxTokens to response.create", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-temp");
    const opts = { temperature: 0.3, maxTokens: 256 };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-temp", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.temperature).toBe(0.3);
    expect(sent.max_output_tokens).toBe(256);
  });

  it("forwards maxTokens: 0 to response.create as max_output_tokens", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-max-tokens-zero");
    const opts = { maxTokens: 0 };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-max-zero", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.max_output_tokens).toBe(0);
  });

  it("forwards text verbosity to response.create text block", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-text-verbosity");
    const opts = { textVerbosity: "low" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-text-verbosity", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.text).toEqual({ verbosity: "low" });
  });

  it("warns and skips invalid text verbosity in the websocket path", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-text-verbosity-invalid");
      const opts = { textVerbosity: "loud" };
      const stream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
        opts as unknown as Parameters<typeof streamFn>[2],
      );
      await new Promise<void>((resolve, reject) => {
        queueMicrotask(async () => {
          try {
            await new Promise((r) => setImmediate(r));
            MockManager.lastInstance!.simulateEvent({
              type: "response.completed",
              response: makeResponseObject("resp-text-verbosity-invalid", "Done"),
            });
            for await (const _ of await resolveStream(stream)) {
              /* consume */
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
      const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
      expect(sent.type).toBe("response.create");
      expect(sent).not.toHaveProperty("text");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid OpenAI text verbosity param: loud");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("forwards reasoningEffort/reasoningSummary to response.create reasoning block", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-reason");
    const opts = { reasoningEffort: "high", reasoningSummary: "auto" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-reason", "Deep thought"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(sent.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("defaults response.create reasoning effort to high for reasoning models", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-reason-default");
    const stream = streamFn(
      { ...modelStub, reasoning: true } as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      undefined,
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-reason-default", "Default thought"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "high" });
    expect(sent.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("forwards shared reasoning to response.create reasoning effort", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-reason-shared");
    const opts = { reasoning: "medium" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-reason-shared", "Shared thought"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "medium" });
  });

  it("maps minimal shared reasoning to low in response.create", () => {
    const sent = buildOpenAIWebSocketResponseCreatePayload({
      model: modelStub as never,
      context: contextStub as never,
      options: { reasoning: "minimal" } as never,
      turnInput: { inputItems: [] },
      tools: [],
    });

    expect(sent.reasoning).toEqual({ effort: "low" });
  });

  it("maps low reasoning to medium for Codex mini websocket requests", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-reason-codex-mini");
    const opts = { reasoning: "low" };
    const stream = streamFn(
      {
        ...modelStub,
        id: "gpt-5.1-codex-mini",
        name: "gpt-5.1-codex-mini",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
      } as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-reason-codex-mini", "Mini thought"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "medium" });
  });

  it("sends response.create reasoning none when the model supports it", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-reason-none");
    const opts = { reasoningEffort: "none" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-reason-none", "Short answer"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "none" });
  });

  it("applies onPayload mutations before sending response.create", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-onpayload");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      {
        onPayload: (payload: unknown) => {
          const request = payload as Record<string, unknown>;
          request.reasoning = { effort: "none" };
          request.text = { verbosity: "low" };
          request.service_tier = "priority";
          return undefined;
        },
      } as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-onpayload", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "none" });
    expect(sent.text).toEqual({ verbosity: "low" });
    expect(sent.service_tier).toBe("priority");
  });

  it("awaits async onPayload mutations before sending response.create", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-onpayload-async");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      {
        onPayload: async (payload: unknown) => {
          const request = payload as Record<string, unknown>;
          await Promise.resolve();
          request.metadata = { async_hook: "applied" };
          return undefined;
        },
      } as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-onpayload-async", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.metadata).toMatchObject({ async_hook: "applied" });
  });
  it("forwards topP and toolChoice to response.create", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-topp");
    const opts = { topP: 0.9, toolChoice: "auto" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-topp", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.top_p).toBe(0.9);
    expect(sent.tool_choice).toBe("auto");
  });

  it("keeps explicit websocket mode surfacing mid-request drops", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-drop");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { transport: "websocket" } as Parameters<typeof streamFn>[2],
    );
    // Let the send go through, then simulate connection drop before response.completed
    await new Promise<void>((resolve) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          // Simulate a connection drop instead of sending response.completed
          MockManager.lastInstance!.simulateClose(1006, "connection lost");
          const events: unknown[] = [];
          for await (const ev of await resolveStream(stream)) {
            events.push(ev);
          }
          // Should have gotten an error event, not hung forever
          const hasError = events.some(
            (e) => typeof e === "object" && e !== null && (e as { type: string }).type === "error",
          );
          expect(hasError).toBe(true);
          resolve();
        } catch {
          // The error propagation is also acceptable — promise rejected
          resolve();
        }
      });
    });
  });

  it("sends warm-up event before first request when openaiWsWarmup=true", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-warmup-enabled");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { openaiWsWarmup: true } as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-warm", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            // consume
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(2);
    expect(sent[0]?.type).toBe("response.create");
    expect(sent[0]?.generate).toBe(false);
    expect(sent[1]?.type).toBe("response.create");
  });

  it("skips warm-up when openaiWsWarmup=false", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-warmup-disabled");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { openaiWsWarmup: false } as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-nowarm", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            // consume
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("response.create");
    expect(sent[0]?.generate).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("releaseWsSession / hasWsSession", () => {
  beforeEach(() => {
    MockManager.reset();
    openAIWsStreamTesting.setDepsForTest({
      createManager: (() => new MockManager()) as never,
      createHttpFallbackStreamFn: mockCreateHttpFallbackStreamFn as never,
      streamSimple: mockStreamSimple,
    });
  });

  afterEach(() => {
    releaseWsSession("registry-test");
    openAIWsStreamTesting.setDepsForTest();
  });

  it("hasWsSession returns false for unknown session", () => {
    expect(hasWsSession("nonexistent-session")).toBe(false);
  });

  it("hasWsSession returns true after a session is created", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "registry-test");
    const stream = streamFn(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "GPT-5.2",
      } as Parameters<typeof streamFn>[0],
      {
        systemPrompt: "test",
        messages: [userMsg("Hi") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        tools: [],
      } as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    // Session should be registered and connected
    expect(hasWsSession("registry-test")).toBe(true);

    // Clean up
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_z", "done"),
    });
    for await (const _ of await resolveStream(stream)) {
      // consume
    }
  });

  it("releaseWsSession closes the connection and removes the session", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "registry-test");
    const stream = streamFn(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "GPT-5.2",
      } as Parameters<typeof streamFn>[0],
      {
        systemPrompt: "test",
        messages: [userMsg("Hi") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        tools: [],
      } as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_zz", "done"),
    });
    for await (const _ of await resolveStream(stream)) {
      // consume
    }

    releaseWsSession("registry-test");
    expect(hasWsSession("registry-test")).toBe(false);
    expect(manager.closeCallCount).toBe(1);
  });

  it("pools cleanly released sessions behind the explicit pool flag", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "registry-test");
    const stream = streamFn(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "GPT-5.4",
      } as Parameters<typeof streamFn>[0],
      {
        systemPrompt: "test",
        messages: [userMsg("Hi") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        tools: [],
      } as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp-pooled", "done"),
    });
    for await (const _ of await resolveStream(stream)) {
      // consume
    }

    vi.useFakeTimers();
    try {
      releaseWsSession("registry-test", {
        allowPool: true,
        env: {
          OPENCLAW_OPENAI_WS_POOL: "1",
          OPENCLAW_OPENAI_WS_SESSION_POOL_IDLE_MS: "1000",
        } as NodeJS.ProcessEnv,
      });

      expect(hasWsSession("registry-test")).toBe(true);
      expect(manager.closeCallCount).toBe(0);

      await vi.advanceTimersByTimeAsync(999);
      expect(hasWsSession("registry-test")).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(hasWsSession("registry-test")).toBe(false);
      expect(manager.closeCallCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releaseWsSession is a no-op for unknown sessions", () => {
    expect(() => releaseWsSession("nonexistent-session")).not.toThrow();
  });

  it("recreates the cached manager when request overrides change for the same session", async () => {
    const sessionId = "registry-test";
    const firstStreamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId, {
      managerOptions: {
        request: {
          headers: { "x-test": "one" },
        },
      },
    });
    const firstStream = firstStreamFn(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "GPT-5.4",
      } as Parameters<typeof firstStreamFn>[0],
      {
        systemPrompt: "test",
        messages: [userMsg("Hi") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        tools: [],
      } as Parameters<typeof firstStreamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const firstManager = MockManager.lastInstance!;
    firstManager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp-first", "done"),
    });
    for await (const _ of await resolveStream(firstStream)) {
      // consume
    }

    const secondStreamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId, {
      managerOptions: {
        request: {
          headers: { "x-test": "two" },
          allowPrivateNetwork: true,
        },
      },
    });
    const secondStream = secondStreamFn(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "GPT-5.4",
      } as Parameters<typeof secondStreamFn>[0],
      {
        systemPrompt: "test",
        messages: [userMsg("Again") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        tools: [],
      } as Parameters<typeof secondStreamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    expect(MockManager.instances).toHaveLength(2);
    expect(firstManager.closeCallCount).toBe(1);
    const secondManager = MockManager.lastInstance!;
    expect(secondManager).not.toBe(firstManager);
    expect(secondManager.connectCallCount).toBe(1);

    secondManager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp-second", "done"),
    });
    for await (const _ of await resolveStream(secondStream)) {
      // consume
    }
  });

  it("recreates the cached manager when the API key changes for the same session", async () => {
    const sessionId = "registry-test";
    const firstStreamFn = createOpenAIWebSocketStreamFn("sk-first", sessionId);
    const firstStream = firstStreamFn(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "GPT-5.4",
      } as Parameters<typeof firstStreamFn>[0],
      {
        systemPrompt: "test",
        messages: [userMsg("Hi") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        tools: [],
      } as Parameters<typeof firstStreamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const firstManager = MockManager.lastInstance!;
    expect(firstManager.connectApiKeys).toEqual(["sk-first"]);
    firstManager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp-first-key", "done"),
    });
    for await (const _ of await resolveStream(firstStream)) {
      // consume
    }

    const secondStreamFn = createOpenAIWebSocketStreamFn("sk-second", sessionId);
    const secondStream = secondStreamFn(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "GPT-5.4",
      } as Parameters<typeof secondStreamFn>[0],
      {
        systemPrompt: "test",
        messages: [userMsg("Again") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        tools: [],
      } as Parameters<typeof secondStreamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    expect(MockManager.instances).toHaveLength(2);
    expect(firstManager.closeCallCount).toBe(1);
    const secondManager = MockManager.lastInstance!;
    expect(secondManager).not.toBe(firstManager);
    expect(secondManager.connectApiKeys).toEqual(["sk-second"]);

    secondManager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp-second-key", "done"),
    });
    for await (const _ of await resolveStream(secondStream)) {
      // consume
    }
  });
});

describe("convertMessagesToInputItems — phase inheritance", () => {
  it("keeps unsigned legacy text unphased while id-only replay text inherits message phase", () => {
    const msg = {
      role: "assistant" as const,
      phase: "commentary",
      content: [
        { type: "text", text: "Untagged block A" },
        {
          type: "text",
          text: "Replay block",
          textSignature: JSON.stringify({ v: 1, id: "s0" }),
        },
        {
          type: "text",
          text: "Explicitly final",
          textSignature: JSON.stringify({ v: 1, id: "s1", phase: "final_answer" }),
        },
        { type: "text", text: "Untagged block B" },
      ],
    };
    const items = convertMessagesToInputItems([msg] as unknown as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    const assistantItems = items.filter((i: Record<string, unknown>) => i.role === "assistant");
    expect(assistantItems).toHaveLength(4);
    expect(assistantItems[0]).toMatchObject({
      role: "assistant",
      content: "Untagged block A",
    });
    expect((assistantItems[0] as Record<string, unknown>).phase).toBeUndefined();
    expect(assistantItems[1]).toMatchObject({
      role: "assistant",
      content: "Replay block",
      phase: "commentary",
    });
    expect(assistantItems[2]).toMatchObject({
      role: "assistant",
      content: "Explicitly final",
      phase: "final_answer",
    });
    expect(assistantItems[3]).toMatchObject({
      role: "assistant",
      content: "Untagged block B",
    });
    expect((assistantItems[3] as Record<string, unknown>).phase).toBeUndefined();
  });
});
