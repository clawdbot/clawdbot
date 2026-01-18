import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";

import { GatewayClient } from "./client.js";
import { startGatewayServer } from "./server.js";

type OpenAIResponsesParams = {
  input?: unknown[];
};

type OpenAIResponseStreamEvent =
  | { type: "response.output_item.added"; item: Record<string, unknown> }
  | { type: "response.function_call_arguments.delta"; delta: string }
  | { type: "response.output_item.done"; item: Record<string, unknown> }
  | {
      type: "response.completed";
      response: {
        status: "completed";
        usage: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
          input_tokens_details?: { cached_tokens?: number };
        };
      };
    };

function extractLastUserText(input: unknown[]): string {
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i] as Record<string, unknown> | undefined;
    if (!item || item.role !== "user") continue;
    const content = item.content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (c): c is { type: "input_text"; text: string } =>
            !!c &&
            typeof c === "object" &&
            (c as { type?: unknown }).type === "input_text" &&
            typeof (c as { text?: unknown }).text === "string",
        )
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

function extractToolOutput(input: unknown[]): string {
  for (const itemRaw of input) {
    const item = itemRaw as Record<string, unknown> | undefined;
    if (!item || item.type !== "function_call_output") continue;
    return typeof item.output === "string" ? item.output : "";
  }
  return "";
}

async function* fakeOpenAIResponsesStream(
  params: OpenAIResponsesParams,
): AsyncGenerator<OpenAIResponseStreamEvent> {
  const input = Array.isArray(params.input) ? params.input : [];
  const toolOutput = extractToolOutput(input);

  // Turn 1: return a tool call to `read`.
  if (!toolOutput) {
    const prompt = extractLastUserText(input);
    const quoted = /"([^"]+)"/.exec(prompt)?.[1];
    const toolPath = quoted ?? "package.json";
    const argsJson = JSON.stringify({ path: toolPath });

    yield {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_test_1",
        call_id: "call_test_1",
        name: "read",
        arguments: "",
      },
    };
    yield { type: "response.function_call_arguments.delta", delta: argsJson };
    yield {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_test_1",
        call_id: "call_test_1",
        name: "read",
        arguments: argsJson,
      },
    };
    yield {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    };
    return;
  }

  // Turn 2: echo the nonces extracted from the Read tool output.
  const nonceA = /nonceA=([^\s]+)/.exec(toolOutput)?.[1] ?? "";
  const nonceB = /nonceB=([^\s]+)/.exec(toolOutput)?.[1] ?? "";
  const reply = `${nonceA} ${nonceB}`.trim();

  yield {
    type: "response.output_item.added",
    item: {
      type: "message",
      id: "msg_test_1",
      role: "assistant",
      content: [],
      status: "in_progress",
    },
  };
  yield {
    type: "response.output_item.done",
    item: {
      type: "message",
      id: "msg_test_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: reply, annotations: [] }],
    },
  };
  yield {
    type: "response.completed",
    response: {
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    },
  };
}

function decodeBodyText(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body)).toString("utf8");
  return "";
}

async function buildOpenAIResponsesSse(params: OpenAIResponsesParams): Promise<Response> {
  const events: OpenAIResponseStreamEvent[] = [];
  for await (const event of fakeOpenAIResponsesStream(params)) {
    events.push(event);
  }

  const sse = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function getFreeGatewayPort(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });
}

function extractPayloadText(result: unknown): string {
  const record = result as Record<string, unknown>;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).text : undefined))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  return texts.join("\n").trim();
}

async function connectClient(params: { url: string; token: string }) {
  return await new Promise<InstanceType<typeof GatewayClient>>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, client?: InstanceType<typeof GatewayClient>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(client as InstanceType<typeof GatewayClient>);
    };
    const client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: "vitest-mock-openai",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
      onHelloOk: () => stop(undefined, client),
      onConnectError: (err) => stop(err),
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
    });
    const timer = setTimeout(() => stop(new Error("gateway connect timeout")), 10_000);
    timer.unref();
    client.start();
  });
}

describe("gateway (mock openai): tool calling", () => {
  it("runs a Read tool call end-to-end via gateway agent loop", { timeout: 90_000 }, async () => {
    const prev = {
      home: process.env.HOME,
      configPath: process.env.CLAWDBOT_CONFIG_PATH,
      token: process.env.CLAWDBOT_GATEWAY_TOKEN,
      skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
      skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
      skipCron: process.env.CLAWDBOT_SKIP_CRON,
      skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
    };

    const originalFetch = globalThis.fetch;
    const openaiBaseUrl = "https://api.openai.com/v1";
    const openaiResponsesUrl = `${openaiBaseUrl}/responses`;
    const isOpenAIResponsesRequest = (url: string) =>
      url === openaiResponsesUrl ||
      url.startsWith(`${openaiResponsesUrl}/`) ||
      url.startsWith(`${openaiResponsesUrl}?`);
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (isOpenAIResponsesRequest(url)) {
        const bodyText =
          typeof (init as { body?: unknown } | undefined)?.body !== "undefined"
            ? decodeBodyText((init as { body?: unknown }).body)
            : input instanceof Request
              ? await input.clone().text()
              : "";

        const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        const inputItems = Array.isArray(parsed.input) ? parsed.input : [];
        return await buildOpenAIResponsesSse({ input: inputItems });
      }
      if (url.startsWith(openaiBaseUrl)) {
        throw new Error(`unexpected OpenAI request in mock test: ${url}`);
      }

      if (!originalFetch) {
        throw new Error(`fetch is not available (url=${url})`);
      }
      return await originalFetch(input, init);
    };
    // TypeScript: Bun's fetch typing includes extra properties; keep this test portable.
    (globalThis as unknown as { fetch: unknown }).fetch = fetchImpl;

    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-mock-home-"));
    process.env.HOME = tempHome;
    process.env.CLAWDBOT_SKIP_CHANNELS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";

    const token = `test-${randomUUID()}`;
    process.env.CLAWDBOT_GATEWAY_TOKEN = token;

    const workspaceDir = path.join(tempHome, "clawd");
    await fs.mkdir(workspaceDir, { recursive: true });

    const nonceA = randomUUID();
    const nonceB = randomUUID();
    const toolProbePath = path.join(workspaceDir, `.clawdbot-tool-probe.${nonceA}.txt`);
    await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

    const configDir = path.join(tempHome, ".clawdbot");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "clawdbot.json");

    const cfg = {
      agents: { defaults: { workspace: workspaceDir } },
      models: {
        mode: "replace",
        providers: {
          openai: {
            baseUrl: openaiBaseUrl,
            apiKey: "test",
            api: "openai-responses",
            models: [
              {
                id: "gpt-5.2",
                name: "gpt-5.2",
                api: "openai-responses",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      gateway: { auth: { token } },
    };

    await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    process.env.CLAWDBOT_CONFIG_PATH = configPath;

    const port = await getFreeGatewayPort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });

    const client = await connectClient({
      url: `ws://127.0.0.1:${port}`,
      token,
    });

    try {
      const sessionKey = "agent:dev:mock-openai";

      await client.request<Record<string, unknown>>("sessions.patch", {
        key: sessionKey,
        model: "openai/gpt-5.2",
      });

      const runId = randomUUID();
      const payload = await client.request<{
        status?: unknown;
        result?: unknown;
      }>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `idem-${runId}`,
          message:
            `Call the read tool on "${toolProbePath}". ` +
            `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`,
          deliver: false,
        },
        { expectFinal: true },
      );

      expect(payload?.status).toBe("ok");
      const text = extractPayloadText(payload?.result);
      expect(text).toContain(nonceA);
      expect(text).toContain(nonceB);
    } finally {
      client.stop();
      await server.close({ reason: "mock openai test complete" });
      await fs.rm(tempHome, { recursive: true, force: true });
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
      process.env.HOME = prev.home;
      process.env.CLAWDBOT_CONFIG_PATH = prev.configPath;
      process.env.CLAWDBOT_GATEWAY_TOKEN = prev.token;
      process.env.CLAWDBOT_SKIP_CHANNELS = prev.skipChannels;
      process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = prev.skipGmail;
      process.env.CLAWDBOT_SKIP_CRON = prev.skipCron;
      process.env.CLAWDBOT_SKIP_CANVAS_HOST = prev.skipCanvas;
    }
  });
});
