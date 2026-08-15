// E2E: hook dispatch uses every free slot inside the shared cron budget.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

const TEST_TIMEOUT_MS = 180_000;
const MODEL_REF = "hook-concurrency/hook-concurrency";
const SHARED_BUDGET = 8;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type HookResponse = {
  body: string;
  status: number;
};

type HeldModelServer = {
  active: () => number;
  close: () => Promise<void>;
  hold: () => void;
  peak: () => number;
  releaseAll: () => void;
  requestCount: () => number;
  url: string;
};

const instances: OpenClawTestInstance[] = [];
const modelServers: HeldModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("Gateway hook concurrency", () => {
  it(
    "admits eight hooks, times out the queued ninth, then admits after release",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startHeldModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "gateway-hook-concurrency",
        config: createTestConfig(modelServer.url),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined },
      });
      instances.push(instance);
      await instance.startGateway();

      // Pay the one-time plugin, session, and model-runtime preparation cost
      // before measuring steady-state lane admission.
      await warmGatewayHook(instance, modelServer);
      modelServer.hold();

      const responses: Array<HookResponse | undefined> = Array.from({
        length: SHARED_BUDGET + 1,
      });
      const requests = responses.map((_, index) =>
        postHook(instance, index).then((response) => {
          responses[index] = response;
          return response;
        }),
      );
      await vi.waitFor(
        () =>
          expect(responses.filter((response) => response?.status === 200)).toHaveLength(
            SHARED_BUDGET,
          ),
        { interval: 20, timeout: 30_000 },
      );
      await vi.waitFor(() => expect(responses.every(Boolean)).toBe(true), {
        interval: 20,
        timeout: 30_000,
      });

      expect(responses.filter((response) => response?.status === 200)).toHaveLength(SHARED_BUDGET);
      const timedOut = responses.find((response) => response?.status === 503);
      expect(timedOut?.status).toBe(503);
      expect(JSON.parse(timedOut?.body ?? "{}")).toMatchObject({
        ok: false,
        error: "hook agent run did not start before admission timeout",
        runId: expect.any(String),
      });
      await vi.waitFor(() => expect(modelServer.active(), instance.logs()).toBeGreaterThan(0), {
        interval: 20,
        timeout: 30_000,
      });
      expect(modelServer.peak(), instance.logs()).toBeLessThanOrEqual(SHARED_BUDGET);
      expect(modelServer.requestCount(), instance.logs()).toBeLessThanOrEqual(SHARED_BUDGET + 1);

      // Completing the admitted work frees shared capacity. A fresh request
      // must then cross the same real Gateway admission fence.
      const requestCountBeforeRelease = modelServer.requestCount();
      modelServer.releaseAll();
      await expect(Promise.all(requests)).resolves.toHaveLength(SHARED_BUDGET + 1);
      const afterRelease = await postHook(instance, SHARED_BUDGET + 1);
      expect(afterRelease.status, afterRelease.body).toBe(200);
      await vi.waitFor(
        () => expect(modelServer.requestCount()).toBeGreaterThan(requestCountBeforeRelease),
        { interval: 20, timeout: 30_000 },
      );
      await vi.waitFor(() => expect(modelServer.active()).toBe(0), {
        interval: 20,
        timeout: 30_000,
      });
    },
  );
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: { slots: { memory: "none" } },
    hooks: {
      enabled: true,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
    },
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
        "hook-concurrency": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "hook-concurrency",
              name: "hook-concurrency",
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

async function warmGatewayHook(
  instance: OpenClawTestInstance,
  modelServer: HeldModelServer,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestCountBefore = modelServer.requestCount();
    const response = await postHook(instance, -(attempt + 1));
    if (response.status === 200) {
      await vi.waitFor(
        () => expect(modelServer.requestCount()).toBeGreaterThan(requestCountBefore),
        { interval: 20, timeout: 30_000 },
      );
      await vi.waitFor(() => expect(modelServer.active()).toBe(0), {
        interval: 20,
        timeout: 30_000,
      });
      return;
    }
    expect(response.status, response.body).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: "hook agent run did not start before admission timeout",
    });
  }
  throw new Error("Gateway hook warmup did not reach the model after three attempts");
}

async function postHook(instance: OpenClawTestInstance, index: number): Promise<HookResponse> {
  const response = await fetch(`http://127.0.0.1:${instance.port}/hooks/agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${instance.hookToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `hook-concurrency-${index}`,
    },
    body: JSON.stringify({
      message: `hook concurrency request ${index}`,
      name: `Hook concurrency ${index}`,
      sessionKey: `hook:concurrency:${index}`,
      sessionMode: "persistent",
      deliver: false,
    }),
  });
  return {
    body: await response.text(),
    status: response.status,
  };
}

async function startHeldModelServer(): Promise<HeldModelServer> {
  const releases: Deferred[] = [];
  let holdRequests = false;
  let active = 0;
  let peak = 0;
  let requestCount = 0;
  const server = createServer((request, response) => {
    void handleModelRequest(request, response).catch((error: unknown) => {
      if (response.destroyed) {
        return;
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  async function handleModelRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "hook-concurrency", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }

    await drainRequest(request);
    const index = requestCount;
    requestCount += 1;
    const release = createDeferred();
    releases[index] = release;
    if (!holdRequests) {
      release.resolve();
    }
    active += 1;
    peak = Math.max(peak, active);
    try {
      await release.promise;
      if (!response.destroyed) {
        writeModelResponse(response, index);
      }
    } finally {
      active -= 1;
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("hook concurrency model server did not bind");
  }

  const releaseAll = () => {
    holdRequests = false;
    for (const release of releases) {
      release?.resolve();
    }
  };
  return {
    active: () => active,
    hold: () => {
      holdRequests = true;
    },
    peak: () => peak,
    releaseAll,
    requestCount: () => requestCount,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      releaseAll();
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
  const text = `hook concurrency response ${sequence}`;
  const message = {
    type: "message",
    id: `hook-concurrency-message-${sequence}`,
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
        id: `hook-concurrency-response-${sequence}`,
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
