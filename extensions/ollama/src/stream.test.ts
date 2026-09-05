// Ollama tests cover stream plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { onLlmRequestActivity } from "openclaw/plugin-sdk/provider-stream-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  buildAssistantMessage,
  createOllamaStreamFn,
  isOllamaCompatProvider,
} from "./stream-api.js";

function makeOllamaResponse(params: {
  content?: string;
  thinking?: string;
  reasoning?: string;
  done_reason?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}) {
  return {
    model: "qwen3.5",
    created_at: new Date().toISOString(),
    message: {
      role: "assistant" as const,
      content: params.content ?? "",
      ...(params.thinking != null ? { thinking: params.thinking } : {}),
      ...(params.reasoning != null ? { reasoning: params.reasoning } : {}),
      ...(params.tool_calls ? { tool_calls: params.tool_calls } : {}),
    },
    done: true,
    ...(params.done_reason ? { done_reason: params.done_reason } : {}),
    prompt_eval_count: 100,
    eval_count: 50,
  };
}

const MODEL_INFO = { api: "ollama", provider: "ollama", id: "qwen3.5" };
const STREAM_MODEL = {
  api: "ollama",
  provider: "ollama",
  id: "qwen3.5",
  input: ["text"],
  contextWindow: 65536,
} as const;

describe("isOllamaCompatProvider", () => {
  it.each([
    ["http://localhost:11434", true],
    ["http://127.0.0.1:11434", true],
    ["http://127.0.0.2:11434", true],
    ["http://127.255.255.254:11434", true],
    ["http://[::1]:11434", true],
    ["http://[::ffff:127.0.0.2]:11434", true],
    ["http://128.0.0.1:11434", false],
    ["http://10.0.0.1:11434", false],
    ["http://127.0.0.1.evil.com:11434", false],
  ] as const)("classifies %s as Ollama-compatible=%s", (baseUrl, expected) => {
    expect(isOllamaCompatProvider({ provider: "custom", baseUrl })).toBe(expected);
  });
});

describe("buildAssistantMessage", () => {
  it("includes thinking block when response has thinking field", () => {
    const response = makeOllamaResponse({
      thinking: "Let me think about this",
      content: "The answer is 42",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ type: "thinking", thinking: "Let me think about this" });
    expect(msg.content[1]).toEqual({ type: "text", text: "The answer is 42" });
  });

  it("includes thinking block when response has reasoning field", () => {
    const response = makeOllamaResponse({
      reasoning: "Step by step analysis",
      content: "Result is 7",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ type: "thinking", thinking: "Step by step analysis" });
    expect(msg.content[1]).toEqual({ type: "text", text: "Result is 7" });
  });

  it("prefers thinking over reasoning when both are present", () => {
    const response = makeOllamaResponse({
      thinking: "From thinking field",
      reasoning: "From reasoning field",
      content: "Answer",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content[0]).toEqual({ type: "thinking", thinking: "From thinking field" });
  });

  it("omits thinking block when no thinking or reasoning field", () => {
    const response = makeOllamaResponse({
      content: "Just text",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({ type: "text", text: "Just text" });
  });

  it("omits thinking block when thinking field is empty", () => {
    const response = makeOllamaResponse({
      thinking: "",
      content: "Just text",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({ type: "text", text: "Just text" });
  });

  it("preserves output-budget length stops", () => {
    const response = makeOllamaResponse({
      content: "Partial answer",
      done_reason: "length",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.stopReason).toBe("length");
  });

  it("keeps a length stop authoritative over complete-looking tool calls", () => {
    const response = makeOllamaResponse({
      done_reason: "length",
      tool_calls: [{ function: { name: "read", arguments: { path: "README.md" } } }],
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.stopReason).toBe("length");
  });
});

describe("createOllamaStreamFn thinking events", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.useRealTimers();
  });

  function makeNdjsonBody(chunks: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const lines = chunks.map((c) => JSON.stringify(c) + "\n").join("");
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines));
        controller.close();
      },
    });
  }

  async function streamOllamaEvents(
    chunks: Array<Record<string, unknown>>,
    options: Parameters<ReturnType<typeof createOllamaStreamFn>>[2] = {},
    context: Parameters<ReturnType<typeof createOllamaStreamFn>>[1] = {
      messages: [{ role: "user", content: "test" }],
    } as never,
  ): Promise<Array<{ type: string; [key: string]: unknown }>> {
    const body = makeNdjsonBody(chunks);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(STREAM_MODEL as never, context, options);

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of stream as AsyncIterable<{
      type: string;
      [key: string]: unknown;
    }>) {
      events.push(event);
    }
    return events;
  }

  it("emits thinking_start, thinking_delta, and thinking_end events for thinking content", async () => {
    const thinkingChunks = [
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: "", thinking: "Step 1" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:01Z",
        message: { role: "assistant", content: "", thinking: " and step 2" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:02Z",
        message: { role: "assistant", content: "The answer", thinking: "" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:03Z",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 5,
      },
    ];

    const events = await streamOllamaEvents(thinkingChunks);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("thinking_start");
    expect(eventTypes).toContain("thinking_delta");
    expect(eventTypes).toContain("thinking_end");
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("done");

    const thinkingStartIndex = eventTypes.indexOf("thinking_start");
    const textStartIndex = eventTypes.indexOf("text_start");
    expect(thinkingStartIndex).toBeLessThan(textStartIndex);

    const thinkingEndIndex = eventTypes.indexOf("thinking_end");
    expect(thinkingEndIndex).toBeLessThan(textStartIndex);

    const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingDeltas).toHaveLength(2);
    expect(expectDefined(thinkingDeltas[0], "first Ollama thinking delta").delta).toBe("Step 1");
    expect(expectDefined(thinkingDeltas[1], "second Ollama thinking delta").delta).toBe(
      " and step 2",
    );

    const thinkingStart = events.find((e) => e.type === "thinking_start");
    expect(thinkingStart?.contentIndex).toBe(0);
    const textStart = events.find((e) => e.type === "text_start");
    expect(textStart?.contentIndex).toBe(1);

    const done = events.find((e) => e.type === "done") as { message?: { content: unknown[] } };
    const content = done?.message?.content ?? [];
    expect(content[0]).toEqual({ type: "thinking", thinking: "Step 1 and step 2" });
    expect(content[1]).toEqual({ type: "text", text: "The answer" });
  });

  it("streams without thinking events when no thinking content is present", async () => {
    const chunks = [
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: "Hello" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:01Z",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 5,
      },
    ];

    const events = await streamOllamaEvents(chunks);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).not.toContain("thinking_start");
    expect(eventTypes).not.toContain("thinking_delta");
    expect(eventTypes).not.toContain("thinking_end");
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("done");

    const textStart = events.find((e) => e.type === "text_start") as { contentIndex?: number };
    expect(textStart?.contentIndex).toBe(0);
  });

  it("emits length for a token-limited native stream", async () => {
    const events = await streamOllamaEvents([
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: "Partial answer" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:01Z",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "length",
        prompt_eval_count: 10,
        eval_count: 5,
      },
    ]);

    const done = events.find((event) => event.type === "done") as {
      reason?: string;
      message?: { stopReason?: string };
    };
    expect(done.reason).toBe("length");
    expect(done.message?.stopReason).toBe("length");
  });

  it("preserves a native length stop when the partial response contains tool calls", async () => {
    const events = await streamOllamaEvents(
      [
        makeOllamaResponse({
          done_reason: "length",
          tool_calls: [{ function: { name: "read", arguments: { path: "README.md" } } }],
        }),
      ],
      {},
      {
        messages: [{ role: "user", content: "test" }],
        tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      } as never,
    );

    const done = events.find((event) => event.type === "done") as {
      reason?: string;
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
    };
    expect(done.reason).toBe("length");
    expect(done.message?.stopReason).toBe("length");
    expect(done.message?.content).toEqual([]);
  });

  it("uses generic stream timeout for Ollama request timeout", async () => {
    await streamOllamaEvents([makeOllamaResponse({ content: "ok" })], { timeoutMs: 2500 });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "http://localhost:11434/api/chat",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.5",
          messages: [{ role: "user", content: "test" }],
          stream: true,
          options: {},
        }),
      },
      policy: {
        allowPrivateNetwork: true,
        hostnameAllowlist: ["localhost"],
      },
      timeoutMs: 2500,
      auditContext: "ollama-stream.chat",
    });
  });

  it("promotes standalone bracketed local-model tool text to a structured tool call", async () => {
    const rawToolText = [
      "[mempalace_mempalace_search]",
      '{"query":"codename","wing":"personal","room":"identities"}',
      "[END_TOOL_REQUEST]",
    ].join("\n");

    const events = await streamOllamaEvents(
      [
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: rawToolText },
          done: false,
        },
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 5,
        },
      ],
      {},
      {
        messages: [{ role: "user", content: "test" }],
        tools: [
          {
            name: "mempalace_mempalace_search",
            description: "Search MemPalace",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
      reason?: string;
    };
    expect(done.reason).toBe("toolUse");
    expect(done.message?.stopReason).toBe("toolUse");
    expect(done.message?.content?.[0]).toMatchObject({
      type: "toolCall",
      name: "mempalace_mempalace_search",
      arguments: { query: "codename", wing: "personal", room: "identities" },
    });
  });

  it("promotes standalone Harmony local-model tool text to a structured tool call", async () => {
    const rawToolText =
      'commentary to=read code {"path":"/path/to/file","line_start":1,"line_end":400}';

    const events = await streamOllamaEvents(
      [
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: rawToolText },
          done: false,
        },
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 5,
        },
      ],
      {},
      {
        messages: [{ role: "user", content: "test" }],
        tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      } as never,
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
      reason?: string;
    };
    expect(done.reason).toBe("toolUse");
    expect(done.message?.content?.[0]).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "/path/to/file", line_start: 1, line_end: 400 },
    });
  });

  it("yields to the event loop while processing dense native stream chunks", async () => {
    const chunks = [
      ...Array.from({ length: 65 }, (_value, index) => ({
        model: "qwen3.5",
        created_at: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
        message: { role: "assistant" as const, content: "x" },
        done: false,
      })),
      makeOllamaResponse({ content: "" }),
    ];
    const body = makeNdjsonBody(chunks);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      STREAM_MODEL as never,
      { messages: [{ role: "user", content: "test" }] } as never,
      {},
    );

    let timerFired = false;
    const timerPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });
    let yieldedBeforeDone = false;
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      if (timerFired && event.type !== "done") {
        yieldedBeforeDone = true;
      }
    }
    await timerPromise;

    expect(yieldedBeforeDone).toBe(true);
  });

  it("refreshes the guarded-fetch idle timeout for each streamed Ollama response", async () => {
    const chunks = [
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:00Z",
        message: { role: "assistant" as const, content: "Hello" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:01Z",
        message: { role: "assistant" as const, content: " world" },
        done: false,
      },
      makeOllamaResponse({ content: "" }),
    ];
    const refreshTimeout = vi.fn();
    const controller = new AbortController();
    const onActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(controller.signal, onActivity);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(makeNdjsonBody(chunks), { status: 200 }),
      release: vi.fn(async () => undefined),
      refreshTimeout,
    });

    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      STREAM_MODEL as never,
      { messages: [{ role: "user", content: "test" }] } as never,
      { signal: controller.signal },
    );

    const events: Array<{ type: string }> = [];
    try {
      for await (const event of stream as AsyncIterable<{ type: string }>) {
        events.push(event);
      }
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(refreshTimeout).toHaveBeenCalledTimes(chunks.length);
    expect(onActivity).toHaveBeenCalledTimes(chunks.length);
  });

  it("redacts reflected credentials from a real non-2xx Ollama response", async () => {
    const configuredSecret = "stream-transport-configured-secret";
    const bearerCredential = "stream-transport-bearer-secret";
    let returnSuccess = false;
    let receivedConfiguredHeader: string | undefined;
    let receivedAuthorization: string | undefined;
    const server = createServer((request, response) => {
      const configuredHeader = request.headers["x-proxy-auth"];
      receivedConfiguredHeader =
        typeof configuredHeader === "string" ? configuredHeader : undefined;
      receivedAuthorization = request.headers.authorization;
      if (returnSuccess) {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(`${JSON.stringify(makeOllamaResponse({ content: "success control" }))}\n`);
        return;
      }
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: "rate limit exceeded",
          configuredEcho: configuredSecret,
          bearerEcho: bearerCredential,
        }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { fetchWithSsrFGuard } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/ssrf-runtime")
      >("openclaw/plugin-sdk/ssrf-runtime");
      fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);

      const address = server.address() as AddressInfo;
      const streamFn = createOllamaStreamFn(`http://127.0.0.1:${address.port}`, {
        "X-Proxy-Auth": configuredSecret,
      });
      const stream = streamFn(
        STREAM_MODEL as never,
        { messages: [{ role: "user", content: "test" }] } as never,
        { apiKey: bearerCredential },
      );

      const events: Array<{ type: string; error?: { errorMessage?: string } }> = [];
      for await (const event of stream as AsyncIterable<{
        type: string;
        error?: { errorMessage?: string };
      }>) {
        events.push(event);
      }

      const errorEvent = events.find((event) => event.type === "error");
      expect(receivedConfiguredHeader).toBe(configuredSecret);
      expect(receivedAuthorization).toBe(`Bearer ${bearerCredential}`);
      expect(errorEvent?.error?.errorMessage).toMatch(/^429\b/);
      expect(errorEvent?.error?.errorMessage).toContain("rate limit exceeded");
      expect(errorEvent?.error?.errorMessage).not.toContain(configuredSecret);
      expect(errorEvent?.error?.errorMessage).not.toContain(bearerCredential);

      returnSuccess = true;
      const successEvents: Array<{ type: string }> = [];
      for await (const event of streamFn(
        STREAM_MODEL as never,
        { messages: [{ role: "user", content: "test" }] } as never,
        { apiKey: bearerCredential },
      ) as AsyncIterable<{ type: string }>) {
        successEvents.push(event);
      }
      expect(successEvents.some((event) => event.type === "done")).toBe(true);
      console.info(
        "[ollama credential redaction proof] surface=stream status=429 safe-marker-present=true authorization-secret-absent=true custom-secret-absent=true success-control=true",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects incomplete UTF-8 after a real terminal Ollama response", async () => {
    let corrupted = true;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      const valid = Buffer.from(`${JSON.stringify(makeOllamaResponse({ content: "ok" }))}\n`);
      response.end(corrupted ? Buffer.concat([valid, Buffer.from([0xc3])]) : valid);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { fetchWithSsrFGuard } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/ssrf-runtime")
      >("openclaw/plugin-sdk/ssrf-runtime");
      fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);

      const address = server.address() as AddressInfo;
      const streamFn = createOllamaStreamFn(`http://127.0.0.1:${address.port}`);
      const readEventTypes = async () => {
        const events: string[] = [];
        for await (const event of streamFn(
          STREAM_MODEL as never,
          { messages: [{ role: "user", content: "test" }] } as never,
          {},
        ) as AsyncIterable<{ type: string }>) {
          events.push(event.type);
        }
        return events;
      };

      expect(await readEventTypes()).toContain("error");
      corrupted = false;
      expect(await readEventTypes()).toContain("done");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps a real slow native Ollama response alive while NDJSON chunks advance", async () => {
    const chunkCount = 24;
    const chunkDelayMs = 250;
    const requestTimeoutMs = 5_000;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });

      let chunkIndex = 0;
      let nextChunk: ReturnType<typeof setTimeout> | undefined;
      const sendChunk = () => {
        if (chunkIndex === chunkCount) {
          response.end(`${JSON.stringify(makeOllamaResponse({ content: "" }))}\n`);
          return;
        }
        response.write(
          `${JSON.stringify({
            model: "qwen3.5",
            created_at: "2026-01-01T00:00:00Z",
            message: { role: "assistant", content: String(chunkIndex) },
            done: false,
          })}\n`,
        );
        chunkIndex += 1;
        nextChunk = setTimeout(sendChunk, chunkDelayMs);
      };

      response.once("close", () => {
        if (nextChunk) {
          clearTimeout(nextChunk);
        }
      });
      sendChunk();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { fetchWithSsrFGuard } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/ssrf-runtime")
      >("openclaw/plugin-sdk/ssrf-runtime");
      fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);

      const address = server.address() as AddressInfo;
      const streamFn = createOllamaStreamFn(`http://127.0.0.1:${address.port}`);
      const stream = streamFn(
        STREAM_MODEL as never,
        { messages: [{ role: "user", content: "test" }] } as never,
        { requestTimeoutMs } as never,
      );

      const events: Array<{ type: string }> = [];
      for await (const event of stream as AsyncIterable<{ type: string }>) {
        events.push(event);
      }

      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.some((event) => event.type === "done")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 20_000);

  it("still times out a real native Ollama stream that stops making progress", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(
        `${JSON.stringify({
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: "partial" },
          done: false,
        })}\n`,
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { fetchWithSsrFGuard } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/ssrf-runtime")
      >("openclaw/plugin-sdk/ssrf-runtime");
      fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);

      const address = server.address() as AddressInfo;
      const streamFn = createOllamaStreamFn(`http://127.0.0.1:${address.port}`);
      const stream = streamFn(
        STREAM_MODEL as never,
        { messages: [{ role: "user", content: "test" }] } as never,
        { requestTimeoutMs: 120 } as never,
      );

      const events: Array<{ type: string }> = [];
      for await (const event of stream as AsyncIterable<{ type: string }>) {
        events.push(event);
      }

      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(events.some((event) => event.type === "done")).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("reports caller aborts during dense native stream processing as aborted", async () => {
    const chunks = [
      ...Array.from({ length: 65 }, (_value, index) => ({
        model: "qwen3.5",
        created_at: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
        message: { role: "assistant" as const, content: "x" },
        done: false,
      })),
      makeOllamaResponse({ content: "" }),
    ];
    const body = makeNdjsonBody(chunks);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const controller = new AbortController();
    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      STREAM_MODEL as never,
      { messages: [{ role: "user", content: "test" }] } as never,
      { signal: controller.signal },
    );

    setTimeout(() => {
      controller.abort();
    }, 0);

    const events: Array<{ type: string; reason?: string; error?: { stopReason?: string } }> = [];
    for await (const event of stream as AsyncIterable<{
      type: string;
      reason?: string;
      error?: { stopReason?: string };
    }>) {
      events.push(event);
    }

    const lastEvent = events.at(-1);
    expect(lastEvent).toMatchObject({
      type: "error",
      reason: "aborted",
      error: { stopReason: "aborted" },
    });
  });

  it("uses CJK-aware fallback usage while preserving missing cache provenance", async () => {
    const events = await streamOllamaEvents(
      [
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: "你好世界测试" },
          done: false,
        },
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
        },
      ],
      {},
      { messages: [{ role: "user", content: "这是一个测试用的句子呢" }] } as never,
    );

    const done = events.find((event) => event.type === "done") as {
      message?: {
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          cacheTelemetry?: { state: string };
        };
      };
    };
    expect(done?.message?.usage).toMatchObject({
      input: 12,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      cacheTelemetry: { state: "unavailable" },
    });
  });

  it("keeps provider usage authoritative over the CJK fallback", async () => {
    const events = await streamOllamaEvents(
      [
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: "你好世界测试" },
          done: false,
        },
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 77,
          eval_count: 19,
        },
      ],
      {},
      { messages: [{ role: "user", content: "这是一个测试用的句子呢" }] } as never,
    );

    const done = events.find((event) => event.type === "done") as {
      message?: { usage?: { input?: number; output?: number; cacheTelemetry?: { state: string } } };
    };
    expect(done?.message?.usage).toMatchObject({
      input: 77,
      output: 19,
      cacheTelemetry: { state: "unavailable" },
    });
  });

  it("keeps the existing fallback estimate for ASCII-only usage", async () => {
    const events = await streamOllamaEvents(
      [
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: "Hello world" },
          done: false,
        },
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
        },
      ],
      {},
      {
        messages: [{ role: "user", content: "The quick brown fox jumps over the lazy dog" }],
      } as never,
    );

    const done = events.find((event) => event.type === "done") as {
      message?: { usage?: { input?: number; output?: number } };
    };
    expect(done?.message?.usage).toMatchObject({ input: 11, output: 3 });
  });
});
