// E2E: ordinary embedded Gateway turns preserve raw transcript cursor continuity.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { readSessionTranscriptRawDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listSessionEntries, loadSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const MODEL_REF = "cursor-settlement/cursor-settlement";
const SESSION_KEY = "agent:main:main";
const GATEWAY_TOKEN_OPTION = "token";

type MockModelServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const instances: OpenClawTestInstance[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("embedded transcript cursor settlement", () => {
  it(
    "resumes a public raw cursor across /new and the next Gateway turn",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startMockModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "embedded-transcript-cursor",
        config: createTestConfig(modelServer.baseUrl),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined },
      });
      instances.push(instance);
      await instance.startGateway();

      const client = await connectGatewayClient({
        url: instance.url,
        [GATEWAY_TOKEN_OPTION]: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        await runAgentTurn(client, instance, "first cursor turn");
        const storePath = path.join(instance.state.sessionsDir("main"), "sessions.json");
        const sessionId = await waitForSessionId(storePath);
        expect(
          listSessionEntries({ agentId: "main", storePath }).map((entry) => entry.sessionKey),
          instance.logs(),
        ).toEqual([SESSION_KEY]);
        const target = { agentId: "main", sessionId, sessionKey: SESSION_KEY, storePath };
        const bootstrap = await readSessionTranscriptRawDelta({
          ...target,
          maxBytes: 1_000_000,
          maxEvents: 100,
        });
        expect(bootstrap.kind, instance.logs()).toBe("page");
        if (bootstrap.kind !== "page") {
          throw new Error(`expected bootstrap page, got ${bootstrap.kind}`);
        }
        expect(bootstrap.hasMore).toBe(false);

        const reset = await runAgentTurn(client, instance, "/new");
        expect(
          (reset as { result?: { meta?: { agentMeta?: { sessionId?: string } } } }).result?.meta
            ?.agentMeta?.sessionId,
          instance.logs(),
        ).toBe(sessionId);
        expect(await waitForSessionId(storePath), instance.logs()).toBe(sessionId);
        await runAgentTurn(client, instance, "post-reset cursor turn");
        const resumed = await readSessionTranscriptRawDelta({
          ...target,
          cursor: bootstrap.cursor,
          maxBytes: 1_000_000,
          maxEvents: 100,
        });

        expect(resumed.kind, `${JSON.stringify(resumed)}\n${instance.logs()}`).toBe("page");
        if (resumed.kind !== "page") {
          throw new Error(`expected resumed page, got ${resumed.kind}`);
        }
        expect(resumed.hasMore).toBe(false);
        expect(
          resumed.events.some(
            (row) =>
              row.event &&
              typeof row.event === "object" &&
              (row.event as { type?: unknown }).type === "reset",
          ),
        ).toBe(true);
        const messageTexts = resumed.events.flatMap((row) => readMessageText(row.event));
        expect(messageTexts).toContain("post-reset cursor turn");
        expect(messageTexts).toContain("cursor settlement response 2");
        expect(messageTexts).not.toContain("first cursor turn");
        expect(messageTexts).not.toContain("cursor settlement response 1");
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        "cursor-settlement": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "cursor-settlement",
              name: "cursor-settlement",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
}

async function runAgentTurn(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  instance: OpenClawTestInstance,
  message: string,
): Promise<{ runId?: string; status?: string }> {
  const requestedRunId = randomUUID();
  const started = await client.request<{ runId?: string; status?: string }>("agent", {
    sessionKey: SESSION_KEY,
    message,
    deliver: false,
    idempotencyKey: requestedRunId,
  });
  if (started.status === "ok") {
    return started;
  }
  expect(started.status).toBe("accepted");
  const completed = await client.request<{ error?: unknown; status?: string }>(
    "agent.wait",
    { runId: started.runId ?? requestedRunId, timeoutMs: 120_000 },
    { timeoutMs: 125_000 },
  );
  expect(completed.status, `${JSON.stringify(completed)}\n${instance.logs()}`).toBe("ok");
  return started;
}

async function waitForSessionId(storePath: string): Promise<string> {
  let sessionId: string | undefined;
  await vi.waitFor(
    () => {
      sessionId = loadSessionEntry({
        agentId: "main",
        readConsistency: "latest",
        sessionKey: SESSION_KEY,
        storePath,
      })?.sessionId;
      expect(sessionId).toBeTruthy();
    },
    { interval: 20, timeout: 30_000 },
  );
  if (!sessionId) {
    throw new Error(`session id was not persisted for ${SESSION_KEY}`);
  }
  return sessionId;
}

function readMessageText(event: unknown): string[] {
  if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "message") {
    return [];
  }
  const message = (event as { message?: { content?: unknown } }).message;
  if (typeof message?.content === "string") {
    return [message.content];
  }
  if (!Array.isArray(message?.content)) {
    return [];
  }
  return message.content.flatMap((part) =>
    part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [],
  );
}

async function startMockModelServer(): Promise<MockModelServer> {
  let responseCount = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "cursor-settlement", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      await drainRequest(request);
      responseCount += 1;
      writeModelResponse(response, responseCount);
    })().catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("cursor settlement model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function drainRequest(request: IncomingMessage): Promise<void> {
  for await (const chunk of request) {
    void chunk;
  }
}

function writeModelResponse(response: ServerResponse, sequence: number): void {
  const text = `cursor settlement response ${sequence}`;
  const message = {
    type: "message",
    id: `cursor-settlement-message-${sequence}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `cursor-settlement-response-${sequence}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}
