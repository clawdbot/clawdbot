import { createServer, type ServerResponse } from "node:http";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const TEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const SESSION_KEY = "agent:qa:qa:session-dedup-reconnect";
const IDEMPOTENCY_KEY = "qa-session-dedup-reconnect";
const ORIGINAL_MESSAGE = "Return exactly SESSION-DEDUP-RECONNECT-OK.";
const CHANGED_MESSAGE = "This changed replay must not create another turn.";
const TERMINAL_TEXT = "SESSION-DEDUP-RECONNECT-OK";

type GatewayHandle = QaGatewayChild;
type AgentResult = {
  runId?: string;
  status?: string;
  result?: {
    payloads?: Array<{ text?: string }>;
  };
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
    throw new AggregateError(errors, "session dedup reconnect cleanup failed");
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

function writeAssistantResponse(response: ServerResponse): void {
  const message = {
    type: "message",
    id: "qa-session-dedup-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: TERMINAL_TEXT, annotations: [] }],
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
        id: "qa-session-dedup-response",
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

async function startControlledProvider() {
  let releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const requests: Array<Record<string, unknown>> = [];
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
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      await responseGate;
      writeAssistantResponse(response);
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
    throw new Error("controlled provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    release: () => releaseResponse?.(),
    stop: async () => {
      releaseResponse?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function connectOperator(
  gateway: GatewayHandle,
  displayName: string,
): Promise<GatewayClient> {
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
      clientDisplayName: displayName,
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

function messageRole(message: unknown): string | undefined {
  const role = message && typeof message === "object" ? (message as { role?: unknown }).role : null;
  return typeof role === "string" ? role : undefined;
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

describe("agent session deduplication across reconnect", () => {
  it(
    "replays one accepted run and one terminal transcript without a second provider call",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const provider = await startControlledProvider();
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

      const clientA = await connectOperator(gateway, "Session dedup client A");
      const acceptedA = await clientA.request<AgentResult>("agent", {
        sessionKey: SESSION_KEY,
        message: ORIGINAL_MESSAGE,
        deliver: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(acceptedA).toMatchObject({
        status: "accepted",
        runId: IDEMPOTENCY_KEY,
      });
      await vi.waitFor(() => expect(provider.requests).toHaveLength(1), {
        interval: 20,
        timeout: REQUEST_TIMEOUT_MS,
      });
      await clientA.stopAndWait({ timeoutMs: 1_000 });

      const clientB = await connectOperator(gateway, "Session dedup client B");
      cleanups.push(() => clientB.stopAndWait({ timeoutMs: 1_000 }));
      const acceptedB = await clientB.request<AgentResult>("agent", {
        sessionKey: SESSION_KEY,
        message: ORIGINAL_MESSAGE,
        deliver: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(acceptedB).toMatchObject({
        status: "in_flight",
        runId: acceptedA.runId,
        sessionKey: SESSION_KEY,
      });
      expect(provider.requests).toHaveLength(1);

      provider.release();
      const terminal = await clientB.request<AgentResult>(
        "agent.wait",
        { runId: IDEMPOTENCY_KEY, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(terminal).toMatchObject({
        status: "ok",
        runId: IDEMPOTENCY_KEY,
      });

      const cachedTerminal = await clientB.request<AgentResult>("agent", {
        sessionKey: SESSION_KEY,
        message: ORIGINAL_MESSAGE,
        deliver: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(cachedTerminal).toMatchObject({
        status: terminal.status,
        runId: terminal.runId,
        result: {
          payloads: [{ text: TERMINAL_TEXT }],
        },
      });
      const changedReplay = await clientB.request<AgentResult>("agent", {
        sessionKey: SESSION_KEY,
        message: CHANGED_MESSAGE,
        deliver: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(changedReplay).toEqual(cachedTerminal);
      expect(provider.requests).toHaveLength(1);

      const history = await clientB.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: SESSION_KEY,
        limit: 20,
      });
      const turns = (history.messages ?? []).filter((message) =>
        ["user", "assistant"].includes(messageRole(message) ?? ""),
      );
      expect(turns.map(messageRole)).toEqual(["user", "assistant"]);
      expect(messageText(turns[0])).toContain(ORIGINAL_MESSAGE);
      expect(messageText(turns[0])).not.toContain(CHANGED_MESSAGE);
      expect(messageText(turns[1])).toContain(TERMINAL_TEXT);
      expect(JSON.stringify(provider.requests[0])).toContain(ORIGINAL_MESSAGE);
      expect(JSON.stringify(provider.requests[0])).not.toContain(CHANGED_MESSAGE);
    },
  );
});
