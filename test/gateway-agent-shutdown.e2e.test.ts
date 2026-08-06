// E2E: a real Gateway process must finish an active agent turn before SIGTERM exit.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const MODEL_REF = "sigterm-drain/sigterm-drain";
const SESSION_KEY = "agent:main:main";
const TEST_TIMEOUT_MS = 180_000;
const WAIT_OPTIONS = { timeout: 10_000, interval: 25 } as const;

type ChatEventPayload = {
  runId?: string;
  state?: string;
  [key: string]: unknown;
};

type DelayedModelServer = {
  baseUrl: string;
  close: () => Promise<void>;
  releaseResponse: () => void;
  requestStarted: Promise<void>;
};

const instances: OpenClawTestInstance[] = [];
const modelServers: DelayedModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("Gateway agent shutdown", () => {
  it(
    "delivers an active turn before exiting after an operating-system SIGTERM",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startDelayedModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "agent-sigterm-drain",
        config: createTestConfig(modelServer.baseUrl),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined },
        stopTimeoutMs: 30_000,
      });
      instances.push(instance);
      await instance.startGateway();

      const runId = randomUUID();
      let resolveFinalEvent: ((payload: ChatEventPayload) => void) | undefined;
      const finalEvent = new Promise<ChatEventPayload>((resolve) => {
        resolveFinalEvent = resolve;
      });
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => {
          if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
            return;
          }
          const payload = event.payload as ChatEventPayload;
          if (payload.runId === runId && payload.state === "final") {
            resolveFinalEvent?.(payload);
          }
        },
      });

      try {
        const started = await client.request<{ runId?: string; status?: string }>("agent", {
          sessionKey: SESSION_KEY,
          message: "finish this turn during SIGTERM drain",
          deliver: false,
          idempotencyKey: runId,
        });
        expect(started).toMatchObject({ runId, status: "accepted" });
        const providerStart = await waitForProofStep(
          Promise.race([
            modelServer.requestStarted.then(() => ({ kind: "request" as const })),
            finalEvent.then((payload) => ({ kind: "final" as const, payload })),
          ]),
          30_000,
          () => `model request did not start\n${instance.logs()}`,
        );
        if (providerStart.kind === "final") {
          throw new Error(
            `agent finished before the model request started: ${JSON.stringify(providerStart.payload)}\n${instance.logs()}`,
          );
        }

        const child = instance.child;
        if (!child) {
          throw new Error("Gateway process exited before SIGTERM proof started");
        }
        let exitedEarly = false;
        const exited = once(child, "exit") as Promise<
          [code: number | null, signal: NodeJS.Signals | null]
        >;
        void exited.then(() => {
          exitedEarly = true;
        });
        expect(child.kill("SIGTERM")).toBe(true);

        await vi.waitFor(() => {
          expect(instance.logs()).toContain("before shutdown with timeout 50000ms");
        }, WAIT_OPTIONS);
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        expect(exitedEarly, instance.logs()).toBe(false);

        modelServer.releaseResponse();

        await expect(
          waitForProofStep(
            finalEvent,
            30_000,
            () => `agent did not emit a final event after model completion\n${instance.logs()}`,
          ),
        ).resolves.toMatchObject({ runId, state: "final" });
        await expect(
          waitForProofStep(
            exited,
            30_000,
            () => `gateway did not exit after its active turn completed\n${instance.logs()}`,
          ),
        ).resolves.toEqual([0, null]);
        expect(instance.logs()).toContain("all active work drained");
      } finally {
        modelServer.releaseResponse();
        await disconnectGatewayClient(client).catch(() => undefined);
      }
    },
  );
});

async function waitForProofStep<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage())), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

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
        "sigterm-drain": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "sigterm-drain",
              name: "sigterm-drain",
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

async function startDelayedModelServer(): Promise<DelayedModelServer> {
  let markRequestStarted: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  let releaseResponse: (() => void) | undefined;
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const server = createServer((request, response) => {
    void handleModelRequest(request, response, {
      markRequestStarted: () => markRequestStarted?.(),
      responseReleased,
    }).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
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
    throw new Error("SIGTERM drain model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestStarted,
    releaseResponse: () => releaseResponse?.(),
    close: async () => {
      releaseResponse?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function handleModelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  controls: { markRequestStarted: () => void; responseReleased: Promise<void> },
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "sigterm-drain", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  await drainRequest(request);
  controls.markRequestStarted();
  await controls.responseReleased;
  writeModelResponse(response);
}

async function drainRequest(request: IncomingMessage): Promise<void> {
  for await (const chunk of request) {
    void chunk;
  }
}

function writeModelResponse(response: ServerResponse): void {
  const text = "SIGTERM drain completed";
  const message = {
    type: "message",
    id: "sigterm-drain-message",
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
        id: "sigterm-drain-response",
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
