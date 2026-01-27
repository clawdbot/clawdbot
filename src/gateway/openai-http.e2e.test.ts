import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HISTORY_CONTEXT_MARKER } from "../auto-reply/reply/history.js";
import { CURRENT_MESSAGE_MARKER } from "../auto-reply/reply/mentions.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { agentCommand, getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let enabledServer: Awaited<ReturnType<typeof startServer>>;
let enabledPort: number;

beforeAll(async () => {
  enabledPort = await getFreePort();
  enabledServer = await startServer(enabledPort);
});

afterAll(async () => {
  await enabledServer.close({ reason: "openai http enabled suite done" });
});

async function startServerWithDefaultConfig(port: number) {
  const { startGatewayServer } = await import("./server.js");
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: false,
  });
}

async function startServer(port: number, opts?: { openAiChatCompletionsEnabled?: boolean }) {
  const { startGatewayServer } = await import("./server.js");
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: opts?.openAiChatCompletionsEnabled ?? true,
  });
}

async function postChatCompletions(port: number, body: unknown, headers?: Record<string, string>) {
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
  it("rejects when disabled (default + config)", { timeout: 120_000 }, async () => {
    {
      const port = await getFreePort();
      const server = await startServerWithDefaultConfig(port);
      try {
        const res = await postChatCompletions(port, {
          model: "moltbot",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(404);
      } finally {
        await server.close({ reason: "test done" });
      }
    }

    {
      const port = await getFreePort();
      const server = await startServer(port, {
        openAiChatCompletionsEnabled: false,
      });
      try {
        const res = await postChatCompletions(port, {
          model: "moltbot",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(404);
      } finally {
        await server.close({ reason: "test done" });
      }
    }
  });

  it("handles request validation and routing", async () => {
    const port = enabledPort;
    const mockAgentOnce = (payloads: Array<{ text: string }>) => {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({ payloads } as never);
    };

    try {
      {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "GET",
          headers: { authorization: "Bearer secret" },
        });
        expect(res.status).toBe(405);
        await res.text();
      }

      {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(401);
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          { model: "moltbot", messages: [{ role: "user", content: "hi" }] },
          { "x-moltbot-agent-id": "beta" },
        );
        expect(res.status).toBe(200);

        expect(agentCommand).toHaveBeenCalledTimes(1);
        const [opts] = agentCommand.mock.calls[0] ?? [];
        expect((opts as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
          /^agent:beta:/,
        );
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          model: "moltbot:beta",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(200);

        expect(agentCommand).toHaveBeenCalledTimes(1);
        const [opts] = agentCommand.mock.calls[0] ?? [];
        expect((opts as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
          /^agent:beta:/,
        );
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          {
            model: "moltbot:beta",
            messages: [{ role: "user", content: "hi" }],
          },
          { "x-moltbot-agent-id": "alpha" },
        );
        expect(res.status).toBe(200);

        expect(agentCommand).toHaveBeenCalledTimes(1);
        const [opts] = agentCommand.mock.calls[0] ?? [];
        expect((opts as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
          /^agent:alpha:/,
        );
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          { model: "moltbot", messages: [{ role: "user", content: "hi" }] },
          {
            "x-moltbot-agent-id": "beta",
            "x-moltbot-session-key": "agent:beta:openai:custom",
          },
        );
        expect(res.status).toBe(200);

        const [opts] = agentCommand.mock.calls[0] ?? [];
        expect((opts as { sessionKey?: string } | undefined)?.sessionKey).toBe(
          "agent:beta:openai:custom",
        );
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          user: "alice",
          model: "moltbot",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(200);

        const [opts] = agentCommand.mock.calls[0] ?? [];
        expect((opts as { sessionKey?: string } | undefined)?.sessionKey ?? "").toContain(
          "openai-user:alice",
        );
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          model: "moltbot",
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
        expect((opts as { message?: string } | undefined)?.message).toBe("hello\nworld");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "I am Claude" }]);
        const res = await postChatCompletions(port, {
          model: "moltbot",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello, who are you?" },
            { role: "assistant", content: "I am Claude." },
            { role: "user", content: "What did I just ask you?" },
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
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          model: "moltbot",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello" },
          ],
        });
        expect(res.status).toBe(200);

        const [opts] = agentCommand.mock.calls[0] ?? [];
        const message = (opts as { message?: string } | undefined)?.message ?? "";
        expect(message).not.toContain(HISTORY_CONTEXT_MARKER);
        expect(message).not.toContain(CURRENT_MESSAGE_MARKER);
        expect(message).toBe("Hello");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          model: "moltbot",
          messages: [
            { role: "developer", content: "You are a helpful assistant." },
            { role: "user", content: "Hello" },
          ],
        });
        expect(res.status).toBe(200);

        const [opts] = agentCommand.mock.calls[0] ?? [];
        const extraSystemPrompt =
          (opts as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ?? "";
        expect(extraSystemPrompt).toBe("You are a helpful assistant.");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "ok" }]);
        const res = await postChatCompletions(port, {
          model: "moltbot",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "What's the weather?" },
            { role: "assistant", content: "Checking the weather." },
            { role: "tool", content: "Sunny, 70F." },
          ],
        });
        expect(res.status).toBe(200);

        const [opts] = agentCommand.mock.calls[0] ?? [];
        const message = (opts as { message?: string } | undefined)?.message ?? "";
        expect(message).toContain(HISTORY_CONTEXT_MARKER);
        expect(message).toContain("User: What's the weather?");
        expect(message).toContain("Assistant: Checking the weather.");
        expect(message).toContain(CURRENT_MESSAGE_MARKER);
        expect(message).toContain("Tool: Sunny, 70F.");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          stream: false,
          model: "moltbot",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json.object).toBe("chat.completion");
        expect(Array.isArray(json.choices)).toBe(true);
        const choice0 = (json.choices as Array<Record<string, unknown>>)[0] ?? {};
        const msg = (choice0.message as Record<string, unknown> | undefined) ?? {};
        expect(msg.role).toBe("assistant");
        expect(msg.content).toBe("hello");
      }

      {
        const res = await postChatCompletions(port, {
          model: "moltbot",
          messages: [{ role: "system", content: "yo" }],
        });
        expect(res.status).toBe(400);
        const missingUserJson = (await res.json()) as Record<string, unknown>;
        expect((missingUserJson.error as Record<string, unknown> | undefined)?.type).toBe(
          "invalid_request_error",
        );
      }
    } finally {
      // shared server
    }
  });

  it("streams SSE chunks when stream=true", async () => {
    const port = enabledPort;
    try {
      {
        agentCommand.mockReset();
        agentCommand.mockImplementationOnce(async (opts: unknown) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "he" } });
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "llo" } });
          return { payloads: [{ text: "hello" }] } as never;
        });

        const res = await postChatCompletions(port, {
          stream: true,
          model: "moltbot",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

        const text = await res.text();
        const data = parseSseDataLines(text);
        expect(data[data.length - 1]).toBe("[DONE]");

        const jsonChunks = data
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        expect(jsonChunks.some((c) => c.object === "chat.completion.chunk")).toBe(true);
        const allContent = jsonChunks
          .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
          .filter((v): v is string => typeof v === "string")
          .join("");
        expect(allContent).toBe("hello");
      }

      {
        agentCommand.mockReset();
        agentCommand.mockImplementationOnce(async (opts: unknown) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "hi" } });
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "hi" } });
          return { payloads: [{ text: "hihi" }] } as never;
        });

        const repeatedRes = await postChatCompletions(port, {
          stream: true,
          model: "moltbot",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(repeatedRes.status).toBe(200);
        const repeatedText = await repeatedRes.text();
        const repeatedData = parseSseDataLines(repeatedText);
        const repeatedChunks = repeatedData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const repeatedContent = repeatedChunks
          .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
          .filter((v): v is string => typeof v === "string")
          .join("");
        expect(repeatedContent).toBe("hihi");
      }

      {
        agentCommand.mockReset();
        agentCommand.mockResolvedValueOnce({
          payloads: [{ text: "hello" }],
        } as never);

        const fallbackRes = await postChatCompletions(port, {
          stream: true,
          model: "moltbot",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(fallbackRes.status).toBe(200);
        const fallbackText = await fallbackRes.text();
        expect(fallbackText).toContain("[DONE]");
        expect(fallbackText).toContain("hello");
      }
    } finally {
      // shared server
    }
  });
});
