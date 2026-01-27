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
  await enabledServer.close({ reason: "openresponses enabled suite done" });
});

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

async function ensureResponseConsumed(res: Response) {
  if (res.bodyUsed) return;
  try {
    await res.text();
  } catch {
    // Ignore drain failures; best-effort to release keep-alive sockets in tests.
  }
}

describe("OpenResponses HTTP API (e2e)", () => {
  it("rejects when disabled (default + config)", { timeout: 120_000 }, async () => {
    const port = await getFreePort();
    const _server = await startServerWithDefaultConfig(port);
    try {
      const res = await postResponses(port, {
        model: "moltbot",
        input: "hi",
      });
      expect(res.status).toBe(404);
      await ensureResponseConsumed(res);
    } finally {
      // shared server
    }

    const disabledPort = await getFreePort();
    const disabledServer = await startServer(disabledPort, {
      openResponsesEnabled: false,
    });
    try {
      const res = await postResponses(disabledPort, {
        model: "moltbot",
        input: "hi",
      });
      expect(res.status).toBe(404);
      await ensureResponseConsumed(res);
    } finally {
      await disabledServer.close({ reason: "test done" });
    }
  });

  it("handles OpenResponses request parsing and validation", async () => {
    const port = enabledPort;
    const mockAgentOnce = (payloads: Array<{ text: string }>, meta?: unknown) => {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({ payloads, meta } as never);
    };

    try {
      const resNonPost = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "GET",
        headers: { authorization: "Bearer secret" },
      });
      expect(resNonPost.status).toBe(405);
      await ensureResponseConsumed(resNonPost);

      const resMissingAuth = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "moltbot", input: "hi" }),
      });
      expect(resMissingAuth.status).toBe(401);
      await ensureResponseConsumed(resMissingAuth);

      const resMissingModel = await postResponses(port, { input: "hi" });
      expect(resMissingModel.status).toBe(400);
      const missingModelJson = (await resMissingModel.json()) as Record<string, unknown>;
      expect((missingModelJson.error as Record<string, unknown> | undefined)?.type).toBe(
        "invalid_request_error",
      );
      await ensureResponseConsumed(resMissingModel);

      mockAgentOnce([{ text: "hello" }]);
      const resHeader = await postResponses(
        port,
        { model: "moltbot", input: "hi" },
        { "x-moltbot-agent-id": "beta" },
      );
      expect(resHeader.status).toBe(200);
      const [optsHeader] = agentCommand.mock.calls[0] ?? [];
      expect((optsHeader as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
        /^agent:beta:/,
      );
      await ensureResponseConsumed(resHeader);

      mockAgentOnce([{ text: "hello" }]);
      const resModel = await postResponses(port, { model: "moltbot:beta", input: "hi" });
      expect(resModel.status).toBe(200);
      const [optsModel] = agentCommand.mock.calls[0] ?? [];
      expect((optsModel as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
        /^agent:beta:/,
      );
      await ensureResponseConsumed(resModel);

      mockAgentOnce([{ text: "hello" }]);
      const resUser = await postResponses(port, {
        user: "alice",
        model: "moltbot",
        input: "hi",
      });
      expect(resUser.status).toBe(200);
      const [optsUser] = agentCommand.mock.calls[0] ?? [];
      expect((optsUser as { sessionKey?: string } | undefined)?.sessionKey ?? "").toContain(
        "openresponses-user:alice",
      );
      await ensureResponseConsumed(resUser);

      mockAgentOnce([{ text: "hello" }]);
      const resString = await postResponses(port, {
        model: "moltbot",
        input: "hello world",
      });
      expect(resString.status).toBe(200);
      const [optsString] = agentCommand.mock.calls[0] ?? [];
      expect((optsString as { message?: string } | undefined)?.message).toBe("hello world");
      await ensureResponseConsumed(resString);

      mockAgentOnce([{ text: "hello" }]);
      const resArray = await postResponses(port, {
        model: "moltbot",
        input: [{ type: "message", role: "user", content: "hello there" }],
      });
      expect(resArray.status).toBe(200);
      const [optsArray] = agentCommand.mock.calls[0] ?? [];
      expect((optsArray as { message?: string } | undefined)?.message).toBe("hello there");
      await ensureResponseConsumed(resArray);

      mockAgentOnce([{ text: "hello" }]);
      const resSystemDeveloper = await postResponses(port, {
        model: "moltbot",
        input: [
          { type: "message", role: "system", content: "You are a helpful assistant." },
          { type: "message", role: "developer", content: "Be concise." },
          { type: "message", role: "user", content: "Hello" },
        ],
      });
      expect(resSystemDeveloper.status).toBe(200);
      const [optsSystemDeveloper] = agentCommand.mock.calls[0] ?? [];
      const extraSystemPrompt =
        (optsSystemDeveloper as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ??
        "";
      expect(extraSystemPrompt).toContain("You are a helpful assistant.");
      expect(extraSystemPrompt).toContain("Be concise.");
      await ensureResponseConsumed(resSystemDeveloper);

      mockAgentOnce([{ text: "hello" }]);
      const resInstructions = await postResponses(port, {
        model: "moltbot",
        input: "hi",
        instructions: "Always respond in French.",
      });
      expect(resInstructions.status).toBe(200);
      const [optsInstructions] = agentCommand.mock.calls[0] ?? [];
      const instructionPrompt =
        (optsInstructions as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ?? "";
      expect(instructionPrompt).toContain("Always respond in French.");
      await ensureResponseConsumed(resInstructions);

      mockAgentOnce([{ text: "I am Claude" }]);
      const resHistory = await postResponses(port, {
        model: "moltbot",
        input: [
          { type: "message", role: "system", content: "You are a helpful assistant." },
          { type: "message", role: "user", content: "Hello, who are you?" },
          { type: "message", role: "assistant", content: "I am Claude." },
          { type: "message", role: "user", content: "What did I just ask you?" },
        ],
      });
      expect(resHistory.status).toBe(200);
      const [optsHistory] = agentCommand.mock.calls[0] ?? [];
      const historyMessage = (optsHistory as { message?: string } | undefined)?.message ?? "";
      expect(historyMessage).toContain(HISTORY_CONTEXT_MARKER);
      expect(historyMessage).toContain("User: Hello, who are you?");
      expect(historyMessage).toContain("Assistant: I am Claude.");
      expect(historyMessage).toContain(CURRENT_MESSAGE_MARKER);
      expect(historyMessage).toContain("User: What did I just ask you?");
      await ensureResponseConsumed(resHistory);

      mockAgentOnce([{ text: "ok" }]);
      const resFunctionOutput = await postResponses(port, {
        model: "moltbot",
        input: [
          { type: "message", role: "user", content: "What's the weather?" },
          { type: "function_call_output", call_id: "call_1", output: "Sunny, 70F." },
        ],
      });
      expect(resFunctionOutput.status).toBe(200);
      const [optsFunctionOutput] = agentCommand.mock.calls[0] ?? [];
      const functionOutputMessage =
        (optsFunctionOutput as { message?: string } | undefined)?.message ?? "";
      expect(functionOutputMessage).toContain("Sunny, 70F.");
      await ensureResponseConsumed(resFunctionOutput);

      mockAgentOnce([{ text: "ok" }]);
      const resInputFile = await postResponses(port, {
        model: "moltbot",
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
      expect(resInputFile.status).toBe(200);
      const [optsInputFile] = agentCommand.mock.calls[0] ?? [];
      const inputFileMessage = (optsInputFile as { message?: string } | undefined)?.message ?? "";
      const inputFilePrompt =
        (optsInputFile as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ?? "";
      expect(inputFileMessage).toBe("read this");
      expect(inputFilePrompt).toContain('<file name="hello.txt">');
      await ensureResponseConsumed(resInputFile);

      mockAgentOnce([{ text: "ok" }]);
      const resToolNone = await postResponses(port, {
        model: "moltbot",
        input: "hi",
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
        ],
        tool_choice: "none",
      });
      expect(resToolNone.status).toBe(200);
      const [optsToolNone] = agentCommand.mock.calls[0] ?? [];
      expect(
        (optsToolNone as { clientTools?: unknown[] } | undefined)?.clientTools,
      ).toBeUndefined();
      await ensureResponseConsumed(resToolNone);

      mockAgentOnce([{ text: "ok" }]);
      const resToolChoice = await postResponses(port, {
        model: "moltbot",
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
      expect(resToolChoice.status).toBe(200);
      const [optsToolChoice] = agentCommand.mock.calls[0] ?? [];
      const clientTools =
        (optsToolChoice as { clientTools?: Array<{ function?: { name?: string } }> })
          ?.clientTools ?? [];
      expect(clientTools).toHaveLength(1);
      expect(clientTools[0]?.function?.name).toBe("get_time");
      await ensureResponseConsumed(resToolChoice);

      const resUnknownTool = await postResponses(port, {
        model: "moltbot",
        input: "hi",
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
        ],
        tool_choice: { type: "function", function: { name: "unknown_tool" } },
      });
      expect(resUnknownTool.status).toBe(400);
      await ensureResponseConsumed(resUnknownTool);

      mockAgentOnce([{ text: "ok" }]);
      const resMaxTokens = await postResponses(port, {
        model: "moltbot",
        input: "hi",
        max_output_tokens: 123,
      });
      expect(resMaxTokens.status).toBe(200);
      const [optsMaxTokens] = agentCommand.mock.calls[0] ?? [];
      expect(
        (optsMaxTokens as { streamParams?: { maxTokens?: number } } | undefined)?.streamParams
          ?.maxTokens,
      ).toBe(123);
      await ensureResponseConsumed(resMaxTokens);

      mockAgentOnce([{ text: "ok" }], {
        agentMeta: {
          usage: { input: 3, output: 5, cacheRead: 1, cacheWrite: 1 },
        },
      });
      const resUsage = await postResponses(port, {
        stream: false,
        model: "moltbot",
        input: "hi",
      });
      expect(resUsage.status).toBe(200);
      const usageJson = (await resUsage.json()) as Record<string, unknown>;
      expect(usageJson.usage).toEqual({ input_tokens: 3, output_tokens: 5, total_tokens: 10 });
      await ensureResponseConsumed(resUsage);

      mockAgentOnce([{ text: "hello" }]);
      const resShape = await postResponses(port, {
        stream: false,
        model: "moltbot",
        input: "hi",
      });
      expect(resShape.status).toBe(200);
      const shapeJson = (await resShape.json()) as Record<string, unknown>;
      expect(shapeJson.object).toBe("response");
      expect(shapeJson.status).toBe("completed");
      expect(Array.isArray(shapeJson.output)).toBe(true);

      const output = shapeJson.output as Array<Record<string, unknown>>;
      expect(output.length).toBe(1);
      const item = output[0] ?? {};
      expect(item.type).toBe("message");
      expect(item.role).toBe("assistant");

      const content = item.content as Array<Record<string, unknown>>;
      expect(content.length).toBe(1);
      expect(content[0]?.type).toBe("output_text");
      expect(content[0]?.text).toBe("hello");
      await ensureResponseConsumed(resShape);

      const resNoUser = await postResponses(port, {
        model: "moltbot",
        input: [{ type: "message", role: "system", content: "yo" }],
      });
      expect(resNoUser.status).toBe(400);
      const noUserJson = (await resNoUser.json()) as Record<string, unknown>;
      expect((noUserJson.error as Record<string, unknown> | undefined)?.type).toBe(
        "invalid_request_error",
      );
      await ensureResponseConsumed(resNoUser);
    } finally {
      // shared server
    }
  });

  it("streams OpenResponses SSE events", async () => {
    const port = enabledPort;
    try {
      agentCommand.mockReset();
      agentCommand.mockImplementationOnce(async (opts: unknown) => {
        const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
        emitAgentEvent({ runId, stream: "assistant", data: { delta: "he" } });
        emitAgentEvent({ runId, stream: "assistant", data: { delta: "llo" } });
        return { payloads: [{ text: "hello" }] } as never;
      });

      const resDelta = await postResponses(port, {
        stream: true,
        model: "moltbot",
        input: "hi",
      });
      expect(resDelta.status).toBe(200);
      expect(resDelta.headers.get("content-type") ?? "").toContain("text/event-stream");

      const deltaText = await resDelta.text();
      const deltaEvents = parseSseEvents(deltaText);

      const eventTypes = deltaEvents.map((e) => e.event).filter(Boolean);
      expect(eventTypes).toContain("response.created");
      expect(eventTypes).toContain("response.output_item.added");
      expect(eventTypes).toContain("response.in_progress");
      expect(eventTypes).toContain("response.content_part.added");
      expect(eventTypes).toContain("response.output_text.delta");
      expect(eventTypes).toContain("response.output_text.done");
      expect(eventTypes).toContain("response.content_part.done");
      expect(eventTypes).toContain("response.completed");
      expect(deltaEvents.some((e) => e.data === "[DONE]")).toBe(true);

      const deltas = deltaEvents
        .filter((e) => e.event === "response.output_text.delta")
        .map((e) => {
          const parsed = JSON.parse(e.data) as { delta?: string };
          return parsed.delta ?? "";
        })
        .join("");
      expect(deltas).toBe("hello");

      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "hello" }],
      } as never);

      const resFallback = await postResponses(port, {
        stream: true,
        model: "moltbot",
        input: "hi",
      });
      expect(resFallback.status).toBe(200);
      const fallbackText = await resFallback.text();
      expect(fallbackText).toContain("[DONE]");
      expect(fallbackText).toContain("hello");

      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "hello" }],
      } as never);

      const resTypeMatch = await postResponses(port, {
        stream: true,
        model: "moltbot",
        input: "hi",
      });
      expect(resTypeMatch.status).toBe(200);

      const typeText = await resTypeMatch.text();
      const typeEvents = parseSseEvents(typeText);
      for (const event of typeEvents) {
        if (event.data === "[DONE]") continue;
        const parsed = JSON.parse(event.data) as { type?: string };
        expect(event.event).toBe(parsed.type);
      }
    } finally {
      // shared server
    }
  });
});
