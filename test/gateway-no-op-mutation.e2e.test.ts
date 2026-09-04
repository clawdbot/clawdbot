// E2E: a Gateway agent turn continues after a real no-op write tool call.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { writeOpenAiResponsesSse } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const MODEL_REF = "no-op-proof/no-op-proof";
const SESSION_KEY = "agent:main:no-op-proof";
const VISIBLE_MARKER = "NO_OP_WRITE_VISIBLE_ANSWER";

type CapturedRequest = { input?: unknown[] };

type MockModelServer = {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

const instances: OpenClawTestInstance[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("Gateway no-op mutation continuation", () => {
  it(
    "returns a visible answer after the first tool call is a no-op write",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startMockModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "gateway-no-op-mutation",
        config: createTestConfig(modelServer.baseUrl),
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      instances.push(instance);
      const notePath = path.join(instance.homeDir, ".openclaw", "workspace", "note.txt");
      await fs.mkdir(path.dirname(notePath), { recursive: true });
      await fs.writeFile(notePath, "done\n", "utf8");
      await instance.startGateway();

      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        const runId = randomUUID();
        const response = await client.request<{
          runId?: string;
          status?: string;
          result?: { payloads?: Array<{ text?: string; isError?: boolean }> };
        }>(
          "agent",
          {
            sessionKey: SESSION_KEY,
            message: "Write note.txt with exactly done, then report the result.",
            deliver: false,
            idempotencyKey: runId,
          },
          { expectFinal: true, timeoutMs: 120_000 },
        );

        expect(response.status).toBe("ok");
        expect(response.runId).toBe(runId);
        expect(response.result?.payloads).toContainEqual(
          expect.objectContaining({ text: VISIBLE_MARKER }),
        );
        expect(modelServer.requests).toHaveLength(2);
        expect(JSON.stringify(modelServer.requests[1]?.input)).toContain("function_call_output");
        expect(JSON.stringify(modelServer.requests[1]?.input)).toContain("No changes made");
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe("done\n");
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
    tools: { profile: "coding" },
    models: {
      mode: "replace",
      providers: {
        "no-op-proof": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "no-op-proof",
              name: "no-op-proof",
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
    throw new Error("no-op proof model server did not bind");
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
    response.end(JSON.stringify({ data: [{ id: "no-op-proof", object: "model" }] }));
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
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
  requests.push(body);
  if (requests.length === 1) {
    writeToolResponse(response);
    return;
  }
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_no_op_visible",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_no_op_visible",
      output_index: 0,
      content_index: 0,
      delta: VISIBLE_MARKER,
    },
    {
      type: "response.output_text.done",
      item_id: "msg_no_op_visible",
      output_index: 0,
      content_index: 0,
      text: VISIBLE_MARKER,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_no_op_visible",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: VISIBLE_MARKER, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_no_op_visible",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_no_op_visible",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: VISIBLE_MARKER, annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);
}

function writeToolResponse(response: ServerResponse): void {
  const item = {
    type: "function_call",
    id: "fc_no_op_write",
    call_id: "call_no_op_write",
    name: "write",
    arguments: JSON.stringify({ path: "note.txt", content: "done\n" }),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_no_op_write",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);
}
