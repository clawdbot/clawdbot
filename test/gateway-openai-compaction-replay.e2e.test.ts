// E2E: persisted OpenAI Responses compaction state reaches the next Gateway request.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const MODEL_REF = "replay-proof/replay-proof";
const SESSION_KEY = "agent:main:compaction-replay";
const COMPACTION_ID = "cmp_gateway_replay";
const COMPACTION_DATA = "opaque-gateway-compaction";

type CapturedRequest = {
  body: { input?: unknown[] };
};

type MockModelServer = {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

type MockSseEvent = { type: string } & Record<string, unknown>;

const instances: OpenClawTestInstance[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("Gateway OpenAI Responses compaction replay", () => {
  it(
    "replays persisted provider state on the next embedded turn",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startMockModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "gateway-openai-compaction-replay",
        config: createTestConfig(modelServer.baseUrl),
        env: {
          OPENCLAW_DEBUG_MODEL_TRANSPORT: "1",
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      instances.push(instance);
      await instance.startGateway();

      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        await runAgentTurn(client, "capture compaction state");
        // The provider can terminate after emitting only a compaction item. The
        // runner must continue from that checkpoint before completing the turn.
        expect(modelServer.requests).toHaveLength(2);

        const session = await client.request<{
          sessions?: Array<{ key?: string; sessionId?: string }>;
        }>("sessions.list", { includeGlobal: true, limit: 20 });
        const sessionId = session.sessions?.find((row) => row.key === SESSION_KEY)?.sessionId;
        if (!sessionId) {
          throw new Error(`sessions.list omitted the durable id for ${SESSION_KEY}`);
        }
        const manager = SessionManager.open({
          agentId: "main",
          sessionId,
          sessionKey: SESSION_KEY,
          storePath: path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
        });
        const contextMessages = manager.buildSessionContext().messages;
        const persistedReplay = contextMessages.find(
          (message) => message.role === "assistant",
        )?.providerReplay;
        expect(persistedReplay).toMatchObject({
          v: 1,
          type: "openai-responses-compaction",
          id: COMPACTION_ID,
          data: COMPACTION_DATA,
          provider: "replay-proof",
          api: "openai-responses",
          model: "replay-proof",
          baseUrlHash: expect.any(String),
          sessionHash: expect.any(String),
        });
        expect(persistedReplay).not.toHaveProperty("authProfileHash");
        expectCompactionReplay(modelServer.requests[1]?.body.input ?? []);
        expect(JSON.stringify(modelServer.requests[1]?.body.input)).toContain(
          "Continue from the compacted transcript",
        );

        await runAgentTurn(client, "replay compaction state");
        expect(modelServer.requests).toHaveLength(3);
        const replayInput = modelServer.requests[2]?.body.input ?? [];
        expectCompactionReplay(replayInput);
        const compactionIndex = replayInput.findIndex(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { type?: unknown }).type === "compaction",
        );
        expect(compactionIndex).toBeGreaterThan(0);
        const instructionPrefixShape = replayInput.slice(0, compactionIndex).map((item) => {
          if (typeof item !== "object" || item === null) {
            return "unknown";
          }
          const record = item as { role?: unknown; type?: unknown };
          return `${String(record.type)}:${String(record.role)}`;
        });
        expect(
          instructionPrefixShape.every((item) => /^message:(developer|system)$/u.test(item)),
          `unexpected item before compaction: ${instructionPrefixShape.join(",")}`,
        ).toBe(true);
        const encodedReplayInput = JSON.stringify(replayInput);
        expect(encodedReplayInput).not.toContain("capture compaction state");
        expect(encodedReplayInput).toContain("gateway replay response 2");
        expect(encodedReplayInput).toContain("replay compaction state");
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
        "replay-proof": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "replay-proof",
              name: "replay-proof",
              api: "openai-responses",
              reasoning: true,
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
  message: string,
): Promise<string> {
  const runId = randomUUID();
  const response = await client.request<{ runId?: string; status?: string }>(
    "agent",
    {
      sessionKey: SESSION_KEY,
      message,
      deliver: false,
      idempotencyKey: runId,
    },
    { expectFinal: true, timeoutMs: 120_000 },
  );
  expect(response.status).toBe("ok");
  expect(response.runId).toBe(runId);
  return runId;
}

function expectCompactionReplay(input: unknown[]): void {
  expect(input).toContainEqual({
    type: "compaction",
    id: COMPACTION_ID,
    encrypted_content: COMPACTION_DATA,
  });
}

async function startMockModelServer(): Promise<MockModelServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response, requests).catch((error: unknown) => {
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
    throw new Error("compaction replay model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedRequest[],
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "replay-proof", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest["body"];
  requests.push({ body });
  writeModelResponse(response, requests.length);
}

function writeModelResponse(response: ServerResponse, sequence: number): void {
  if (sequence === 1) {
    const compaction = {
      type: "compaction",
      id: COMPACTION_ID,
      encrypted_content: COMPACTION_DATA,
    };
    writeSseEvents(response, [
      { type: "response.output_item.added", output_index: 0, item: compaction },
      { type: "response.output_item.done", output_index: 0, item: compaction },
      {
        type: "response.incomplete",
        response: {
          id: "resp_gateway_replay_1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [compaction],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      },
    ]);
    return;
  }
  const text = `gateway replay response ${sequence}`;
  const message = {
    type: "message",
    id: `msg_gateway_replay_${sequence}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const output = [message];
  const events: MockSseEvent[] = output.flatMap((item, outputIndex) => [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : item,
    },
    { type: "response.output_item.done", output_index: outputIndex, item },
  ]);
  events.push({
    type: "response.completed",
    response: {
      id: `resp_gateway_replay_${sequence}`,
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  });
  writeSseEvents(response, events);
}

function writeSseEvents(response: ServerResponse, events: MockSseEvent[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}
