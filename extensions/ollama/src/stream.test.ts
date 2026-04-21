import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { buildAssistantMessage, createOllamaStreamFn } from "./stream.js";

function makeOllamaResponse(params: {
  content?: string;
  thinking?: string;
  reasoning?: string;
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
    prompt_eval_count: 100,
    eval_count: 50,
  };
}

const MODEL_INFO = { api: "ollama", provider: "ollama", id: "qwen3.5" };

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
});

describe("createOllamaStreamFn thinking events", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
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
  ): Promise<Array<{ type: string; [key: string]: unknown }>> {
    const body = makeNdjsonBody(chunks);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      { api: "ollama", provider: "ollama", id: "qwen3.5", contextWindow: 65536 } as never,
      { messages: [{ role: "user", content: "test" }] } as never,
      {},
    );

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
    expect(thinkingDeltas[0].delta).toBe("Step 1");
    expect(thinkingDeltas[1].delta).toBe(" and step 2");

    const thinkingStart = events.find((e) => e.type === "thinking_start");
    expect(thinkingStart?.contentIndex).toBe(0);
    const textStart = events.find((e) => e.type === "text_start");
    expect(textStart?.contentIndex).toBe(1);

    const done = events.find((e) => e.type === "done") as { message?: { content: unknown[] } };
    const content = done?.message?.content ?? [];
    expect(content[0]).toMatchObject({ type: "thinking", thinking: "Step 1 and step 2" });
    expect(content[1]).toMatchObject({ type: "text", text: "The answer" });
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
});
