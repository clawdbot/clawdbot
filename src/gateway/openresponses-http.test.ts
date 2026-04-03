import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HISTORY_CONTEXT_MARKER } from "../auto-reply/reply/history.js";
import { CURRENT_MESSAGE_MARKER } from "../auto-reply/reply/mentions.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { buildAssistantDeltaResult } from "./test-helpers.agent-results.js";
import { agentCommand, getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let enabledServer: Awaited<ReturnType<typeof startServer>>;
let enabledPort: number;

beforeAll(async () => {
  enabledPort = await getFreePort();
  enabledServer = await startServer(enabledPort, { openResponsesEnabled: true });
});

afterAll(async () => {
  await enabledServer.close({ reason: "openresponses enabled suite done" });
});

async function startServer(port: number, opts?: { openResponsesEnabled?: boolean }) {
  const { startGatewayServer } = await import("./server.js");
  const serverOpts = {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
  } as const;
  return await startGatewayServer(
    port,
    opts?.openResponsesEnabled === undefined
      ? serverOpts
      : { ...serverOpts, openResponsesEnabled: opts.openResponsesEnabled },
  );
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway config tests");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
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
  if (res.bodyUsed) {
    return;
  }
  try {
    await res.text();
  } catch {
    // Ignore drain failures; best-effort to release keep-alive sockets in tests.
  }
}

const WEATHER_TOOL = [
  {
    type: "function",
    function: { name: "get_weather", description: "Get weather" },
  },
] as const;

function buildUrlInputMessage(params: {
  kind: "input_file" | "input_image";
  url: string;
  text?: string;
}) {
  return [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: params.text ?? "read this" },
        {
          type: params.kind,
          source: { type: "url", url: params.url },
        },
      ],
    },
  ];
}

function buildResponsesUrlPolicyConfig(maxUrlParts: number) {
  return {
    gateway: {
      http: {
        endpoints: {
          responses: {
            enabled: true,
            maxUrlParts,
            files: {
              allowUrl: true,
              urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
            },
            images: {
              allowUrl: true,
              urlAllowlist: ["images.example.com"],
            },
          },
        },
      },
    },
  };
}

async function expectInvalidRequest(
  res: Response,
  messagePattern: RegExp,
): Promise<{ type?: string; message?: string } | undefined> {
  expect(res.status).toBe(400);
  const json = (await res.json()) as { error?: { type?: string; message?: string } };
  expect(json.error?.type).toBe("invalid_request_error");
  expect(json.error?.message ?? "").toMatch(messagePattern);
  return json.error;
}

describe("OpenResponses HTTP API (e2e)", () => {
  it("rejects when disabled (default + config)", { timeout: 15_000 }, async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "openclaw",
        input: "hi",
      });
      expect(res.status).toBe(404);
      await ensureResponseConsumed(res);
    } finally {
      await server.close({ reason: "test done" });
    }

    const disabledPort = await getFreePort();
    const disabledServer = await startServer(disabledPort, {
      openResponsesEnabled: false,
    });
    try {
      const res = await postResponses(disabledPort, {
        model: "openclaw",
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
      agentCommand.mockClear();
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
        body: JSON.stringify({ model: "openclaw", input: "hi" }),
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
        { model: "openclaw", input: "hi" },
        { "x-openclaw-agent-id": "beta" },
      );
      expect(resHeader.status).toBe(200);
      const optsHeader = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsHeader as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
        /^agent:beta:/,
      );
      expect((optsHeader as { messageChannel?: string } | undefined)?.messageChannel).toBe(
        "webchat",
      );
      await ensureResponseConsumed(resHeader);

      mockAgentOnce([{ text: "hello" }]);
      const resModel = await postResponses(port, { model: "openclaw:beta", input: "hi" });
      expect(resModel.status).toBe(200);
      const optsModel = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsModel as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
        /^agent:beta:/,
      );
      await ensureResponseConsumed(resModel);

      mockAgentOnce([{ text: "hello" }]);
      const resChannelHeader = await postResponses(
        port,
        { model: "openclaw", input: "hi" },
        { "x-openclaw-message-channel": "custom-client-channel" },
      );
      expect(resChannelHeader.status).toBe(200);
      const optsChannelHeader = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsChannelHeader as { messageChannel?: string } | undefined)?.messageChannel).toBe(
        "webchat",
      );
      await ensureResponseConsumed(resChannelHeader);

      mockAgentOnce([{ text: "hello" }]);
      const resUser = await postResponses(port, {
        user: "alice",
        model: "openclaw",
        input: "hi",
      });
      expect(resUser.status).toBe(200);
      const optsUser = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsUser as { sessionKey?: string } | undefined)?.sessionKey ?? "").toContain(
        "openresponses-user:alice",
      );
      await ensureResponseConsumed(resUser);

      mockAgentOnce([{ text: "hello" }]);
      const resString = await postResponses(port, {
        model: "openclaw",
        input: "hello world",
      });
      expect(resString.status).toBe(200);
      const optsString = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsString as { message?: string } | undefined)?.message).toBe("hello world");
      await ensureResponseConsumed(resString);

      mockAgentOnce([{ text: "hello" }]);
      const resArray = await postResponses(port, {
        model: "openclaw",
        input: [{ type: "message", role: "user", content: "hello there" }],
      });
      expect(resArray.status).toBe(200);
      const optsArray = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsArray as { message?: string } | undefined)?.message).toBe("hello there");
      await ensureResponseConsumed(resArray);

      mockAgentOnce([{ text: "hello" }]);
      const resSystemDeveloper = await postResponses(port, {
        model: "openclaw",
        input: [
          { type: "message", role: "system", content: "You are a helpful assistant." },
          { type: "message", role: "developer", content: "Be concise." },
          { type: "message", role: "user", content: "Hello" },
        ],
      });
      expect(resSystemDeveloper.status).toBe(200);
      const optsSystemDeveloper = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const extraSystemPrompt =
        (optsSystemDeveloper as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ??
        "";
      expect(extraSystemPrompt).toContain("You are a helpful assistant.");
      expect(extraSystemPrompt).toContain("Be concise.");
      await ensureResponseConsumed(resSystemDeveloper);

      mockAgentOnce([{ text: "hello" }]);
      const resInstructions = await postResponses(port, {
        model: "openclaw",
        input: "hi",
        instructions: "Always respond in French.",
      });
      expect(resInstructions.status).toBe(200);
      const optsInstructions = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const instructionPrompt =
        (optsInstructions as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ?? "";
      expect(instructionPrompt).toContain("Always respond in French.");
      await ensureResponseConsumed(resInstructions);

      mockAgentOnce([{ text: "I am Claude" }]);
      const resHistory = await postResponses(port, {
        model: "openclaw",
        input: [
          { type: "message", role: "system", content: "You are a helpful assistant." },
          { type: "message", role: "user", content: "Hello, who are you?" },
          { type: "message", role: "assistant", content: "I am Claude." },
          { type: "message", role: "user", content: "What did I just ask you?" },
        ],
      });
      expect(resHistory.status).toBe(200);
      const optsHistory = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const historyMessage = (optsHistory as { message?: string } | undefined)?.message ?? "";
      expect(historyMessage).toContain(HISTORY_CONTEXT_MARKER);
      expect(historyMessage).toContain("User: Hello, who are you?");
      expect(historyMessage).toContain("Assistant: I am Claude.");
      expect(historyMessage).toContain(CURRENT_MESSAGE_MARKER);
      expect(historyMessage).toContain("User: What did I just ask you?");
      await ensureResponseConsumed(resHistory);

      mockAgentOnce([{ text: "ok" }]);
      const resFunctionOutput = await postResponses(port, {
        model: "openclaw",
        input: [
          { type: "message", role: "user", content: "What's the weather?" },
          { type: "function_call_output", call_id: "call_1", output: "Sunny, 70F." },
        ],
      });
      expect(resFunctionOutput.status).toBe(200);
      const optsFunctionOutput = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const functionOutputMessage =
        (optsFunctionOutput as { message?: string } | undefined)?.message ?? "";
      expect(functionOutputMessage).toContain("Sunny, 70F.");
      await ensureResponseConsumed(resFunctionOutput);

      mockAgentOnce([{ text: "ok" }]);
      const resInputFile = await postResponses(port, {
        model: "openclaw",
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
      const optsInputFile = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const inputFileMessage = (optsInputFile as { message?: string } | undefined)?.message ?? "";
      const inputFilePrompt =
        (optsInputFile as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ?? "";
      expect(inputFileMessage).toBe("read this");
      expect(inputFilePrompt).toContain('<file name="hello.txt">');
      await ensureResponseConsumed(resInputFile);

      mockAgentOnce([{ text: "ok" }]);
      const resToolNone = await postResponses(port, {
        model: "openclaw",
        input: "hi",
        tools: WEATHER_TOOL,
        tool_choice: "none",
      });
      expect(resToolNone.status).toBe(200);
      const optsToolNone = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect(
        (optsToolNone as { clientTools?: unknown[] } | undefined)?.clientTools,
      ).toBeUndefined();
      await ensureResponseConsumed(resToolNone);

      mockAgentOnce([{ text: "ok" }]);
      const resToolChoice = await postResponses(port, {
        model: "openclaw",
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
      const optsToolChoice = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const clientTools =
        (optsToolChoice as { clientTools?: Array<{ function?: { name?: string } }> } | undefined)
          ?.clientTools ?? [];
      expect(clientTools).toHaveLength(1);
      expect(clientTools[0]?.function?.name).toBe("get_time");
      await ensureResponseConsumed(resToolChoice);

      const resUnknownTool = await postResponses(port, {
        model: "openclaw",
        input: "hi",
        tools: WEATHER_TOOL,
        tool_choice: { type: "function", function: { name: "unknown_tool" } },
      });
      expect(resUnknownTool.status).toBe(400);
      await ensureResponseConsumed(resUnknownTool);

      mockAgentOnce([{ text: "ok" }]);
      const resMaxTokens = await postResponses(port, {
        model: "openclaw",
        input: "hi",
        max_output_tokens: 123,
      });
      expect(resMaxTokens.status).toBe(200);
      const optsMaxTokens = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
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
        model: "openclaw",
        input: "hi",
      });
      expect(resUsage.status).toBe(200);
      const usageJson = (await resUsage.json()) as Record<string, unknown>;
      expect(usageJson.usage).toEqual({
        input_tokens: 3,
        output_tokens: 5,
        total_tokens: 10,
        cache_read_tokens: 1,
        cache_write_tokens: 1,
      });
      await ensureResponseConsumed(resUsage);

      // No cache — fields should be absent (not zero)
      mockAgentOnce([{ text: "ok" }], {
        agentMeta: {
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      });
      const resNoCache = await postResponses(port, {
        stream: false,
        model: "openclaw",
        input: "hi",
      });
      expect(resNoCache.status).toBe(200);
      const noCacheJson = (await resNoCache.json()) as Record<string, unknown>;
      const noCacheUsage = noCacheJson.usage as Record<string, unknown>;
      expect(noCacheUsage.input_tokens).toBe(10);
      expect(noCacheUsage.output_tokens).toBe(5);
      expect(noCacheUsage.total_tokens).toBe(15);
      expect(noCacheUsage.cache_read_tokens).toBeUndefined();
      expect(noCacheUsage.cache_write_tokens).toBeUndefined();
      await ensureResponseConsumed(resNoCache);

      mockAgentOnce([{ text: "hello" }]);
      const resShape = await postResponses(port, {
        stream: false,
        model: "openclaw",
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
        model: "openclaw",
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
      agentCommand.mockClear();
      agentCommand.mockImplementationOnce((async (opts: unknown) =>
        buildAssistantDeltaResult({
          opts,
          emit: emitAgentEvent,
          deltas: ["he", "llo"],
          text: "hello",
        })) as never);

      const resDelta = await postResponses(port, {
        stream: true,
        model: "openclaw",
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

      agentCommand.mockClear();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "hello" }],
      } as never);

      const resFallback = await postResponses(port, {
        stream: true,
        model: "openclaw",
        input: "hi",
      });
      expect(resFallback.status).toBe(200);
      const fallbackText = await resFallback.text();
      expect(fallbackText).toContain("[DONE]");
      expect(fallbackText).toContain("hello");

      agentCommand.mockClear();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "hello" }],
      } as never);

      const resTypeMatch = await postResponses(port, {
        stream: true,
        model: "openclaw",
        input: "hi",
      });
      expect(resTypeMatch.status).toBe(200);

      const typeText = await resTypeMatch.text();
      const typeEvents = parseSseEvents(typeText);
      for (const event of typeEvents) {
        if (event.data === "[DONE]") {
          continue;
        }
        const parsed = JSON.parse(event.data) as { type?: string };
        expect(event.event).toBe(parsed.type);
      }
    } finally {
      // shared server
    }
  });

  it("blocks unsafe URL-based file/image inputs", async () => {
    const port = enabledPort;
    agentCommand.mockClear();

    const blockedPrivate = await postResponses(port, {
      model: "openclaw",
      input: buildUrlInputMessage({
        kind: "input_file",
        url: "http://127.0.0.1:6379/info",
      }),
    });
    await expectInvalidRequest(blockedPrivate, /invalid request|private|internal|blocked/i);

    const blockedMetadata = await postResponses(port, {
      model: "openclaw",
      input: buildUrlInputMessage({
        kind: "input_image",
        url: "http://metadata.google.internal/computeMetadata/v1",
      }),
    });
    await expectInvalidRequest(blockedMetadata, /invalid request|blocked|metadata|internal/i);

    const blockedScheme = await postResponses(port, {
      model: "openclaw",
      input: buildUrlInputMessage({
        kind: "input_file",
        url: "file:///etc/passwd",
      }),
    });
    await expectInvalidRequest(blockedScheme, /invalid request|http or https/i);
    expect(agentCommand).not.toHaveBeenCalled();
  });

  it("enforces URL allowlist and URL part cap for responses inputs", async () => {
    const allowlistConfig = buildResponsesUrlPolicyConfig(1);
    await writeGatewayConfig(allowlistConfig);

    const allowlistPort = await getFreePort();
    const allowlistServer = await startServer(allowlistPort, { openResponsesEnabled: true });
    try {
      agentCommand.mockClear();

      const allowlistBlocked = await postResponses(allowlistPort, {
        model: "openclaw",
        input: buildUrlInputMessage({
          kind: "input_file",
          text: "fetch this",
          url: "https://evil.example.org/secret.txt",
        }),
      });
      await expectInvalidRequest(allowlistBlocked, /invalid request|allowlist|blocked/i);
    } finally {
      await allowlistServer.close({ reason: "responses allowlist hardening test done" });
    }

    const capConfig = buildResponsesUrlPolicyConfig(0);
    await writeGatewayConfig(capConfig);

    const capPort = await getFreePort();
    const capServer = await startServer(capPort, { openResponsesEnabled: true });
    try {
      agentCommand.mockClear();
      const maxUrlBlocked = await postResponses(capPort, {
        model: "openclaw",
        input: buildUrlInputMessage({
          kind: "input_file",
          text: "fetch this",
          url: "https://cdn.example.com/file-1.txt",
        }),
      });
      await expectInvalidRequest(
        maxUrlBlocked,
        /invalid request|Too many URL-based input sources/i,
      );
      expect(agentCommand).not.toHaveBeenCalled();
    } finally {
      await capServer.close({ reason: "responses url cap hardening test done" });
    }
  });
});
