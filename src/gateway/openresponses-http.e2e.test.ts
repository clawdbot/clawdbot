import { describe, expect, it } from "vitest";

import { HISTORY_CONTEXT_MARKER } from "../auto-reply/reply/history.js";
import { CURRENT_MESSAGE_MARKER } from "../auto-reply/reply/mentions.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { agentCommand, getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks();

async function startServerWithDefaultConfig(port: number) {
  const { startGatewayServer } = await import("./server.js");
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
  });
}

async function startServer(port: number, opts?: { openResponsesEnabled?: boolean }) {
  const { startGatewayServer } = await import("./server.js");
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openResponsesEnabled: opts?.openResponsesEnabled ?? true,
  });
}

async function postResponses(port: number, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return res;
}

function parseSseEvents(text: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  const lines = text.split("\n");
  let currentEvent: string | undefined;
  let currentData: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice("event: ".length);
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice("data: ".length));
    } else if (line.trim() === "" && currentData.length > 0) {
      events.push({ event: currentEvent, data: currentData.join("\n") });
      currentEvent = undefined;
      currentData = [];
    }
  }

  return events;
}

describe("OpenResponses HTTP API (e2e)", () => {
  it("is disabled by default (requires config)", async () => {
    const port = await getFreePort();
    const server = await startServerWithDefaultConfig(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: "hi",
      });
      expect(res.status).toBe(404);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("can be disabled via config (404)", async () => {
    const port = await getFreePort();
    const server = await startServer(port, {
      openResponsesEnabled: false,
    });
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: "hi",
      });
      expect(res.status).toBe(404);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("rejects non-POST", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "GET",
        headers: { authorization: "Bearer secret" },
      });
      expect(res.status).toBe(405);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("rejects missing auth", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "clawdbot", input: "hi" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("rejects invalid request body (missing model)", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, { input: "hi" });
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect((json.error as Record<string, unknown> | undefined)?.type).toBe(
        "invalid_request_error",
      );
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("routes to a specific agent via header", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(
        port,
        { model: "clawdbot", input: "hi" },
        { "x-clawdbot-agent-id": "beta" },
      );
      expect(res.status).toBe(200);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect((opts as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
        /^agent:beta:/,
      );
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("routes to a specific agent via model (no custom headers)", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot:beta",
        input: "hi",
      });
      expect(res.status).toBe(200);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect((opts as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
        /^agent:beta:/,
      );
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("uses OpenResponses user for a stable session key", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        user: "alice",
        model: "clawdbot",
        input: "hi",
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect((opts as { sessionKey?: string } | undefined)?.sessionKey ?? "").toContain(
        "openresponses-user:alice",
      );
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("accepts string input", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: "hello world",
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect((opts as { message?: string } | undefined)?.message).toBe("hello world");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("accepts array input with message items", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: [{ type: "message", role: "user", content: "hello there" }],
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect((opts as { message?: string } | undefined)?.message).toBe("hello there");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("extracts system and developer messages as extraSystemPrompt", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: [
          { type: "message", role: "system", content: "You are a helpful assistant." },
          { type: "message", role: "developer", content: "Be concise." },
          { type: "message", role: "user", content: "Hello" },
        ],
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      const extraSystemPrompt =
        (opts as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ?? "";
      expect(extraSystemPrompt).toContain("You are a helpful assistant.");
      expect(extraSystemPrompt).toContain("Be concise.");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("includes instructions in extraSystemPrompt", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: "hi",
        instructions: "Always respond in French.",
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      const extraSystemPrompt =
        (opts as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ?? "";
      expect(extraSystemPrompt).toContain("Always respond in French.");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("includes conversation history when multiple messages are provided", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "I am Claude" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: [
          { type: "message", role: "system", content: "You are a helpful assistant." },
          { type: "message", role: "user", content: "Hello, who are you?" },
          { type: "message", role: "assistant", content: "I am Claude." },
          { type: "message", role: "user", content: "What did I just ask you?" },
        ],
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      const message = (opts as { message?: string } | undefined)?.message ?? "";
      expect(message).toContain(HISTORY_CONTEXT_MARKER);
      expect(message).toContain("User: Hello, who are you?");
      expect(message).toContain("Assistant: I am Claude.");
      expect(message).toContain(CURRENT_MESSAGE_MARKER);
      expect(message).toContain("User: What did I just ask you?");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("includes function_call_output when it is the latest item", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: [
          { type: "message", role: "user", content: "What's the weather?" },
          { type: "function_call_output", call_id: "call_1", output: "Sunny, 70F." },
        ],
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      const message = (opts as { message?: string } | undefined)?.message ?? "";
      expect(message).toContain("Sunny, 70F.");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("moves input_file content into extraSystemPrompt", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "read this" },
              {
                type: "input_file",
                source: {
                  type: "base64",
                  media_type: "text/plain",
                  data: Buffer.from("hello").toString("base64"),
                  filename: "hello.txt",
                },
              },
            ],
          },
        ],
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      const message = (opts as { message?: string } | undefined)?.message ?? "";
      const extraSystemPrompt =
        (opts as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ?? "";
      expect(message).toBe("read this");
      expect(extraSystemPrompt).toContain('<file name="hello.txt">');
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("applies tool_choice=none by dropping tools", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: "hi",
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
        ],
        tool_choice: "none",
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect((opts as { clientTools?: unknown[] } | undefined)?.clientTools).toBeUndefined();
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("applies tool_choice to a specific tool", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: "hi",
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
          {
            type: "function",
            function: { name: "get_time", description: "Get time" },
          },
        ],
        tool_choice: { type: "function", function: { name: "get_time" } },
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      const clientTools =
        (opts as { clientTools?: Array<{ function?: { name?: string } }> })?.clientTools ?? [];
      expect(clientTools).toHaveLength(1);
      expect(clientTools[0]?.function?.name).toBe("get_time");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("rejects tool_choice that references an unknown tool", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: "hi",
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
        ],
        tool_choice: { type: "function", function: { name: "unknown_tool" } },
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("passes max_output_tokens through to the agent stream params", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: "hi",
        max_output_tokens: 123,
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect(
        (opts as { streamParams?: { maxTokens?: number } } | undefined)?.streamParams?.maxTokens,
      ).toBe(123);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("returns usage when available", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          usage: { input: 3, output: 5, cacheRead: 1, cacheWrite: 1 },
        },
      },
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        stream: false,
        model: "clawdbot",
        input: "hi",
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.usage).toEqual({ input_tokens: 3, output_tokens: 5, total_tokens: 10 });
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("returns a non-streaming response with correct shape", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        stream: false,
        model: "clawdbot",
        input: "hi",
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.object).toBe("response");
      expect(json.status).toBe("completed");
      expect(Array.isArray(json.output)).toBe(true);

      const output = json.output as Array<Record<string, unknown>>;
      expect(output.length).toBe(1);
      const item = output[0] ?? {};
      expect(item.type).toBe("message");
      expect(item.role).toBe("assistant");

      const content = item.content as Array<Record<string, unknown>>;
      expect(content.length).toBe(1);
      expect(content[0]?.type).toBe("output_text");
      expect(content[0]?.text).toBe("hello");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("requires a user message in input", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "clawdbot",
        input: [{ type: "message", role: "system", content: "yo" }],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect((json.error as Record<string, unknown> | undefined)?.type).toBe(
        "invalid_request_error",
      );
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("streams SSE events when stream=true (delta events)", async () => {
    agentCommand.mockImplementationOnce(async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "he" } });
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "llo" } });
      return { payloads: [{ text: "hello" }] } as never;
    });

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        stream: true,
        model: "clawdbot",
        input: "hi",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

      const text = await res.text();
      const events = parseSseEvents(text);

      // Check for required event types
      const eventTypes = events.map((e) => e.event).filter(Boolean);
      expect(eventTypes).toContain("response.created");
      expect(eventTypes).toContain("response.output_item.added");
      expect(eventTypes).toContain("response.in_progress");
      expect(eventTypes).toContain("response.content_part.added");
      expect(eventTypes).toContain("response.output_text.delta");
      expect(eventTypes).toContain("response.output_text.done");
      expect(eventTypes).toContain("response.content_part.done");
      expect(eventTypes).toContain("response.completed");

      // Check for [DONE] terminal event
      expect(events.some((e) => e.data === "[DONE]")).toBe(true);

      // Verify delta content
      const deltaEvents = events.filter((e) => e.event === "response.output_text.delta");
      const allDeltas = deltaEvents
        .map((e) => {
          const parsed = JSON.parse(e.data) as { delta?: string };
          return parsed.delta ?? "";
        })
        .join("");
      expect(allDeltas).toBe("hello");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("streams SSE events when stream=true (fallback when no deltas)", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        stream: true,
        model: "clawdbot",
        input: "hi",
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("[DONE]");
      expect(text).toContain("hello");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("event type matches JSON type field", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        stream: true,
        model: "clawdbot",
        input: "hi",
      });
      expect(res.status).toBe(200);

      const text = await res.text();
      const events = parseSseEvents(text);

      for (const event of events) {
        if (event.data === "[DONE]") continue;
        const parsed = JSON.parse(event.data) as { type?: string };
        expect(event.event).toBe(parsed.type);
      }
    } finally {
      await server.close({ reason: "test done" });
    }
  });
});
