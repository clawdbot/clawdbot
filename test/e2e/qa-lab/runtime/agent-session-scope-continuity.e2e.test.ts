import { createServer, type ServerResponse } from "node:http";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const TEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const SESSION_A_KEY = "agent:qa:qa:session-scope-continuity-a";
const SESSION_B_KEY = "agent:qa:qa:session-scope-continuity-b";
const SESSION_A_USER_1 = "SESSION-SCOPE-A-USER-1";
const SESSION_A_ASSISTANT_1 = "SESSION-SCOPE-A-ASSISTANT-1";
const SESSION_A_USER_2 = "SESSION-SCOPE-A-USER-2";
const SESSION_A_ASSISTANT_2 = "SESSION-SCOPE-A-ASSISTANT-2";
const SESSION_B_USER_1 = "SESSION-SCOPE-B-USER-1";
const SESSION_B_ASSISTANT_1 = "SESSION-SCOPE-B-ASSISTANT-1";
const MARKERS = [
  SESSION_A_USER_1,
  SESSION_A_ASSISTANT_1,
  SESSION_A_USER_2,
  SESSION_A_ASSISTANT_2,
  SESSION_B_USER_1,
  SESSION_B_ASSISTANT_1,
] as const;

type GatewayHandle = QaGatewayChild;
type AgentResult = {
  runId?: string;
  status?: string;
  result?: {
    payloads?: Array<{ text?: string }>;
  };
};
type SessionRow = {
  key?: string;
  sessionId?: string;
};
type ChatHistory = {
  sessionId?: string;
  messages?: unknown[];
};
type CanonicalTurn = {
  role: "user" | "assistant";
  marker: (typeof MARKERS)[number];
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "session scope continuity cleanup failed");
  }
});

function writeResponsesEvents(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function writeAssistantResponse(response: ServerResponse, text: string, index: number): void {
  const message = {
    type: "message",
    id: `qa-session-scope-message-${index}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeResponsesEvents(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `qa-session-scope-response-${index}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

async function startDeterministicProvider() {
  const requests: Array<Record<string, unknown>> = [];
  const replies = [SESSION_A_ASSISTANT_1, SESSION_A_ASSISTANT_2, SESSION_B_ASSISTANT_1];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [{ id: "gpt-5.6-luna", object: "model" }],
          }),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(body);
      const reply = replies[requests.length - 1];
      if (!reply) {
        response.writeHead(500).end("unexpected provider call");
        return;
      }
      writeAssistantResponse(response, reply, requests.length);
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("deterministic provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function connectOperator(gateway: GatewayHandle): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
        return;
      }
      resolve(client);
    };
    const client = new GatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      env: gateway.runtimeEnv,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Session scope continuity client",
      clientVersion: "1.0.0",
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      deviceIdentity: null,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () => finish(new Error(`Gateway client connection timed out:\n${gateway.logs()}`)),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    client.start();
  });
}

function messageRole(message: unknown): "user" | "assistant" | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "assistant" ? role : undefined;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}

function markerTurns(messages: unknown[]): CanonicalTurn[] {
  return messages.flatMap((message) => {
    const role = messageRole(message);
    if (!role) {
      return [];
    }
    const text = messageText(message);
    const markers = MARKERS.filter((marker) => text.includes(marker));
    if (markers.length > 0) {
      expect(markers).toHaveLength(1);
    }
    return markers.map((marker) => ({ role, marker }));
  });
}

function providerMarkerTurns(request: Record<string, unknown>): CanonicalTurn[] {
  return markerTurns(Array.isArray(request.input) ? request.input : []);
}

async function runAgentTurn(params: {
  client: GatewayClient;
  sessionKey: string;
  userText: string;
  runId: string;
}): Promise<void> {
  const accepted = await params.client.request<AgentResult>("agent", {
    sessionKey: params.sessionKey,
    message: params.userText,
    deliver: false,
    idempotencyKey: params.runId,
  });
  expect(accepted).toMatchObject({
    status: "accepted",
    runId: params.runId,
  });
  const terminal = await params.client.request<AgentResult>(
    "agent.wait",
    { runId: params.runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
  expect(terminal).toMatchObject({
    status: "ok",
    runId: params.runId,
  });
}

async function readSession(client: GatewayClient, sessionKey: string): Promise<SessionRow> {
  const result = await client.request<{ sessions?: SessionRow[] }>("sessions.list", {
    agentId: "qa",
    includeGlobal: true,
    limit: 200,
  });
  const session = result.sessions?.find((candidate) => candidate.key === sessionKey);
  expect(session, `expected sessions.list row for ${sessionKey}`).toBeDefined();
  expect(session?.sessionId).toEqual(expect.any(String));
  return session ?? {};
}

async function readHistory(client: GatewayClient, sessionKey: string): Promise<ChatHistory> {
  return await client.request<ChatHistory>("chat.history", {
    sessionKey,
    limit: 20,
  });
}

describe("agent session scope continuity", () => {
  it(
    "reuses one session across fresh turns without leaking history into another key",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const provider = await startDeterministicProvider();
      cleanups.push(() => provider.stop());
      const gatewayOwner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
      const gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: ["--import", "tsx", "src/entry.ts"],
          cwd: process.cwd(),
          usePackagedPlugins: true,
        },
        providerBaseUrl: `${provider.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL_REF,
        alternateModel: MODEL_REF,
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        fastMode: true,
        runtimeEnvPatch: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        },
        mutateConfig: ({ plugins: _plugins, ...config }) => config,
      });
      const client = await connectOperator(gateway);
      cleanups.push(() => client.stopAndWait({ timeoutMs: 1_000 }));

      await runAgentTurn({
        client,
        sessionKey: SESSION_A_KEY,
        userText: SESSION_A_USER_1,
        runId: "qa-session-scope-a-turn-1",
      });
      const sessionAAfterTurn1 = await readSession(client, SESSION_A_KEY);

      await runAgentTurn({
        client,
        sessionKey: SESSION_A_KEY,
        userText: SESSION_A_USER_2,
        runId: "qa-session-scope-a-turn-2",
      });
      const sessionAAfterTurn2 = await readSession(client, SESSION_A_KEY);
      expect(sessionAAfterTurn2.sessionId).toBe(sessionAAfterTurn1.sessionId);

      const historyA = await readHistory(client, SESSION_A_KEY);
      expect(historyA.sessionId).toBe(sessionAAfterTurn1.sessionId);
      expect(markerTurns(historyA.messages ?? [])).toEqual([
        { role: "user", marker: SESSION_A_USER_1 },
        { role: "assistant", marker: SESSION_A_ASSISTANT_1 },
        { role: "user", marker: SESSION_A_USER_2 },
        { role: "assistant", marker: SESSION_A_ASSISTANT_2 },
      ]);
      expect(providerMarkerTurns(provider.requests[1] ?? {})).toEqual([
        { role: "user", marker: SESSION_A_USER_1 },
        { role: "assistant", marker: SESSION_A_ASSISTANT_1 },
        { role: "user", marker: SESSION_A_USER_2 },
      ]);

      await runAgentTurn({
        client,
        sessionKey: SESSION_B_KEY,
        userText: SESSION_B_USER_1,
        runId: "qa-session-scope-b-turn-1",
      });
      const sessionB = await readSession(client, SESSION_B_KEY);
      expect(sessionB.sessionId).not.toBe(sessionAAfterTurn1.sessionId);

      const historyB = await readHistory(client, SESSION_B_KEY);
      expect(historyB.sessionId).toBe(sessionB.sessionId);
      expect(markerTurns(historyB.messages ?? [])).toEqual([
        { role: "user", marker: SESSION_B_USER_1 },
        { role: "assistant", marker: SESSION_B_ASSISTANT_1 },
      ]);
      expect(providerMarkerTurns(provider.requests[2] ?? {})).toEqual([
        { role: "user", marker: SESSION_B_USER_1 },
      ]);
      expect(JSON.stringify(provider.requests[2])).not.toContain("SESSION-SCOPE-A-");
      expect(provider.requests).toHaveLength(3);
    },
  );
});
