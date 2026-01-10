import { describe, expect, it } from "vitest";

import { emitAgentEvent } from "../infra/agent-events.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
} from "./test-helpers.js";

installGatewayTestHooks();

async function startServerWithDefaultConfig(port: number) {
  const { startGatewayServer } = await import("./server.js");
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
  });
}

async function startServer(
  port: number,
  opts?: { openAiChatCompletionsEnabled?: boolean },
) {
  const { startGatewayServer } = await import("./server.js");
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: opts?.openAiChatCompletionsEnabled ?? true,
  });
}

async function postChatCompletions(
  port: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
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

function parseSseDataLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

describe("OpenAI-compatible HTTP API (e2e)", () => {
  it("is disabled by default (requires config)", async () => {
    const port = await getFreePort();
    const server = await startServerWithDefaultConfig(port);
    try {
      const res = await postChatCompletions(port, {
        model: "clawdbot",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(404);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("can be disabled via config (404)", async () => {
    const port = await getFreePort();
    const server = await startServer(port, {
      openAiChatCompletionsEnabled: false,
    });
    try {
      const res = await postChatCompletions(port, {
        model: "clawdbot",
        messages: [{ role: "user", content: "hi" }],
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
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
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
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(401);
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
      const res = await postChatCompletions(
        port,
        { model: "clawdbot", messages: [{ role: "user", content: "hi" }] },
        { "x-clawdbot-agent-id": "beta" },
      );
      expect(res.status).toBe(200);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect(
        (opts as { sessionKey?: string } | undefined)?.sessionKey ?? "",
      ).toMatch(/^agent:beta:/);
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
      const res = await postChatCompletions(port, {
        model: "clawdbot:beta",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect(
        (opts as { sessionKey?: string } | undefined)?.sessionKey ?? "",
      ).toMatch(/^agent:beta:/);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("prefers explicit header agent over model agent", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postChatCompletions(
        port,
        {
          model: "clawdbot:beta",
          messages: [{ role: "user", content: "hi" }],
        },
        { "x-clawdbot-agent-id": "alpha" },
      );
      expect(res.status).toBe(200);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect(
        (opts as { sessionKey?: string } | undefined)?.sessionKey ?? "",
      ).toMatch(/^agent:alpha:/);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("honors x-clawdbot-session-key override", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postChatCompletions(
        port,
        { model: "clawdbot", messages: [{ role: "user", content: "hi" }] },
        {
          "x-clawdbot-agent-id": "beta",
          "x-clawdbot-session-key": "agent:beta:openai:custom",
        },
      );
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect((opts as { sessionKey?: string } | undefined)?.sessionKey).toBe(
        "agent:beta:openai:custom",
      );
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("uses OpenAI user for a stable session key", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postChatCompletions(port, {
        user: "alice",
        model: "clawdbot",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect(
        (opts as { sessionKey?: string } | undefined)?.sessionKey ?? "",
      ).toContain("openai-user:alice");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("extracts user message text from array content", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postChatCompletions(port, {
        model: "clawdbot",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "input_text", text: "world" },
            ],
          },
        ],
      });
      expect(res.status).toBe(200);

      const [opts] = agentCommand.mock.calls[0] ?? [];
      expect((opts as { message?: string } | undefined)?.message).toBe(
        "hello\nworld",
      );
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("returns a non-streaming OpenAI chat.completion response", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postChatCompletions(port, {
        stream: false,
        model: "clawdbot",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.object).toBe("chat.completion");
      expect(Array.isArray(json.choices)).toBe(true);
      const choice0 = (json.choices as Array<Record<string, unknown>>)[0] ?? {};
      const msg =
        (choice0.message as Record<string, unknown> | undefined) ?? {};
      expect(msg.role).toBe("assistant");
      expect(msg.content).toBe("hello");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("requires a user message", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postChatCompletions(port, {
        model: "clawdbot",
        messages: [{ role: "system", content: "yo" }],
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

  it("streams SSE chunks when stream=true (delta events)", async () => {
    agentCommand.mockImplementationOnce(async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "he" } });
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "llo" } });
      return { payloads: [{ text: "hello" }] } as never;
    });

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postChatCompletions(port, {
        stream: true,
        model: "clawdbot",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain(
        "text/event-stream",
      );

      const text = await res.text();
      const data = parseSseDataLines(text);
      expect(data[data.length - 1]).toBe("[DONE]");

      const jsonChunks = data
        .filter((d) => d !== "[DONE]")
        .map((d) => JSON.parse(d) as Record<string, unknown>);
      expect(jsonChunks.some((c) => c.object === "chat.completion.chunk")).toBe(
        true,
      );
      const allContent = jsonChunks
        .flatMap(
          (c) =>
            (c.choices as Array<Record<string, unknown>> | undefined) ?? [],
        )
        .map(
          (choice) =>
            (choice.delta as Record<string, unknown> | undefined)?.content,
        )
        .filter((v): v is string => typeof v === "string")
        .join("");
      expect(allContent).toBe("hello");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("streams SSE chunks when stream=true (fallback when no deltas)", async () => {
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
    } as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postChatCompletions(port, {
        stream: true,
        model: "clawdbot",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("[DONE]");
      expect(text).toContain("hello");
    } finally {
      await server.close({ reason: "test done" });
    }
  });
});
