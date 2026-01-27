import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GatewayClient } from "../src/gateway/client.js";
import { startGatewayServer } from "../src/gateway/server.js";
import { getDeterministicFreePortBlock } from "../src/test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";

type OpenAIResponseStreamEvent =
  | { type: "response.output_item.added"; item: Record<string, unknown> }
  | { type: "response.output_item.done"; item: Record<string, unknown> }
  | {
      type: "response.completed";
      response: {
        status: "completed";
        usage: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
        };
      };
    };

function buildOpenAIResponsesSse(text: string): Response {
  const events: OpenAIResponseStreamEvent[] = [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "msg_test_1",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_test_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ];

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
      clientDisplayName: "vitest-timeout-fallback",
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

async function getFreeGatewayPort(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });
}

describe("provider timeouts (e2e)", () => {
  it(
    "falls back when the primary provider aborts with a timeout-like AbortError",
    { timeout: 60_000 },
    async () => {
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
      const primaryBaseUrl = "https://primary.example/v1";
      const fallbackBaseUrl = "https://fallback.example/v1";
      const counts = { primary: 0, fallback: 0 };
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.startsWith(`${primaryBaseUrl}/responses`)) {
          counts.primary += 1;
          const err = new Error("request was aborted");
          err.name = "AbortError";
          throw err;
        }

        if (url.startsWith(`${fallbackBaseUrl}/responses`)) {
          counts.fallback += 1;
          return buildOpenAIResponsesSse("fallback-ok");
        }

        if (!originalFetch) throw new Error(`fetch is not available (url=${url})`);
        return await originalFetch(input, init);
      };
      (globalThis as unknown as { fetch: unknown }).fetch = fetchImpl;

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-timeout-e2e-"));
      process.env.HOME = tempHome;
      process.env.CLAWDBOT_SKIP_CHANNELS = "1";
      process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
      process.env.CLAWDBOT_SKIP_CRON = "1";
      process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";

      const token = `test-${randomUUID()}`;
      process.env.CLAWDBOT_GATEWAY_TOKEN = token;

      const configDir = path.join(tempHome, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "moltbot.json");

      const cfg = {
        agents: {
          defaults: {
            model: {
              primary: "primary/gpt-5.2",
              fallbacks: ["fallback/gpt-5.2"],
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            primary: {
              baseUrl: primaryBaseUrl,
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
            fallback: {
              baseUrl: fallbackBaseUrl,
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
        const sessionKey = "agent:dev:timeout-fallback";
        await client.request<Record<string, unknown>>("sessions.patch", {
          key: sessionKey,
          model: "primary/gpt-5.2",
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
            message: "say fallback-ok",
            deliver: false,
          },
          { expectFinal: true },
        );

        expect(payload?.status).toBe("ok");
        const text = extractPayloadText(payload?.result);
        expect(text).toContain("fallback-ok");
        expect(counts.primary).toBeGreaterThan(0);
        expect(counts.fallback).toBeGreaterThan(0);
      } finally {
        client.stop();
        await server.close({ reason: "timeout fallback test complete" });
        await fs.rm(tempHome, { recursive: true, force: true });
        (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
        if (prev.home === undefined) delete process.env.HOME;
        else process.env.HOME = prev.home;
        if (prev.configPath === undefined) delete process.env.CLAWDBOT_CONFIG_PATH;
        else process.env.CLAWDBOT_CONFIG_PATH = prev.configPath;
        if (prev.token === undefined) delete process.env.CLAWDBOT_GATEWAY_TOKEN;
        else process.env.CLAWDBOT_GATEWAY_TOKEN = prev.token;
        if (prev.skipChannels === undefined) delete process.env.CLAWDBOT_SKIP_CHANNELS;
        else process.env.CLAWDBOT_SKIP_CHANNELS = prev.skipChannels;
        if (prev.skipGmail === undefined) delete process.env.CLAWDBOT_SKIP_GMAIL_WATCHER;
        else process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = prev.skipGmail;
        if (prev.skipCron === undefined) delete process.env.CLAWDBOT_SKIP_CRON;
        else process.env.CLAWDBOT_SKIP_CRON = prev.skipCron;
        if (prev.skipCanvas === undefined) delete process.env.CLAWDBOT_SKIP_CANVAS_HOST;
        else process.env.CLAWDBOT_SKIP_CANVAS_HOST = prev.skipCanvas;
      }
    },
  );
});
