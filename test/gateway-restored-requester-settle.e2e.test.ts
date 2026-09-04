// E2E: the shipped Gateway process bounds requester wakes restored from SQLite.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSubagentSessionEntry } from "../src/agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { saveSubagentRegistryToSqlite } from "../src/agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { Deferred } from "../src/shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

const TEST_TIMEOUT_MS = 180_000;
const MODEL_REF = "restored-settle/restored-settle";
const PROBE_MARKER = "restored wake ordering probe";
const RESTORED_WAKE_MARKER = "Every subagent spawned from this session has now settled";

type HeldModelServer = {
  active: () => number;
  close: () => Promise<void>;
  countRequestsContaining: (marker: string) => number;
  peakRestored: () => number;
  release: (index: number) => void;
  releaseAll: () => void;
  requestCount: () => number;
  url: string;
};

const instances: OpenClawTestInstance[] = [];
const modelServers: HeldModelServer[] = [];

afterEach(async () => {
  for (const server of modelServers) {
    server.releaseAll();
  }
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("Gateway restored requester settlement", () => {
  it(
    "runs at most two restored wakes while leaving the third queued",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startHeldModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "gateway-restored-requester-settle",
        config: createTestConfig(modelServer.url),
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      instances.push(instance);

      instance.state.applyEnv();
      try {
        const endedAt = Date.now();
        const restoredRuns = Array.from({ length: 3 }, (_, index): SubagentRunRecord => {
          const runId = `run-gateway-restored-settle-${index}`;
          return {
            runId,
            childSessionKey: `agent:main:subagent:gateway-restored-settle-${index}`,
            requesterSessionKey: `agent:main:gateway-restored-requester-${index}`,
            requesterDisplayKey: `gateway-restored-requester-${index}`,
            task: "resume a durable requester wake through the Gateway CLI",
            cleanup: "keep",
            createdAt: endedAt - 1_000,
            endedReason: "subagent-complete",
            execution: {
              status: "terminal",
              startedAt: endedAt - 500,
              endedAt,
              outcome: { status: "ok" },
            },
            expectsCompletionMessage: true,
            completion: { required: true, resultText: "done", capturedAt: endedAt },
            delivery: { status: "delivered", deliveredAt: endedAt },
            cleanupHandled: true,
            cleanupCompletedAt: endedAt,
            requesterSettleWake: {
              status: "pending",
              attemptCount: 0,
              batchRunIds: [runId],
              requesterYieldBatch: true,
              afterRequesterYield: true,
              rearmGeneration: 1,
            },
          };
        });
        saveSubagentRegistryToSqlite(
          new Map(restoredRuns.map((entry) => [entry.runId, entry] as const)),
        );
        for (const [index, entry] of restoredRuns.entries()) {
          await writeSubagentSessionEntry({
            stateDir: instance.stateDir,
            agentId: "main",
            sessionKey: entry.requesterSessionKey,
            sessionId: `gateway-restored-requester-${index}`,
            defaultSessionId: `gateway-restored-requester-${index}`,
          });
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
        instance.state.restoreEnv();
      }

      await instance.startGateway();
      await vi.waitFor(
        () => expect(modelServer.countRequestsContaining(RESTORED_WAKE_MARKER)).toBe(2),
        { interval: 20, timeout: 30_000 },
      );
      expect(modelServer.active(), instance.logs()).toBe(2);
      expect(modelServer.peakRestored(), instance.logs()).toBe(2);

      const probe = instance.cli(["agent", "--message", PROBE_MARKER, "--json"]);
      await vi.waitFor(() => expect(modelServer.countRequestsContaining(PROBE_MARKER)).toBe(1), {
        interval: 20,
        timeout: 30_000,
      });
      expect(modelServer.countRequestsContaining(RESTORED_WAKE_MARKER)).toBe(2);

      modelServer.release(0);
      await vi.waitFor(
        () => expect(modelServer.countRequestsContaining(RESTORED_WAKE_MARKER)).toBe(3),
        { interval: 20, timeout: 30_000 },
      );
      expect(modelServer.peakRestored(), instance.logs()).toBe(2);
      modelServer.releaseAll();
      await expect(probe).resolves.toMatchObject({ code: 0 });
    },
  );
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        maxConcurrent: 8,
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
        "restored-settle": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "restored-settle",
              name: "restored-settle",
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

async function startHeldModelServer(): Promise<HeldModelServer> {
  const releases: Deferred[] = [];
  const requestBodies: string[] = [];
  let active = 0;
  let activeRestored = 0;
  let peakRestored = 0;
  let requestCount = 0;
  const server = createServer((request, response) => {
    void handleModelRequest(request, response).catch((error: unknown) => {
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
      response.end(JSON.stringify({ data: [{ id: "restored-settle", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    for await (const chunk of request) {
      body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    }
    const index = requestCount;
    requestCount += 1;
    requestBodies[index] = body;
    const release = createDeferred();
    releases[index] = release;
    active += 1;
    const isRestored = body.includes(RESTORED_WAKE_MARKER);
    if (isRestored) {
      activeRestored += 1;
      peakRestored = Math.max(peakRestored, activeRestored);
    }
    try {
      await release.promise;
      writeModelResponse(response, index);
    } finally {
      active -= 1;
      if (isRestored) {
        activeRestored -= 1;
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const releaseAll = () => {
    for (const release of releases) {
      release?.resolve(undefined);
    }
  };
  return {
    active: () => active,
    countRequestsContaining: (marker) =>
      requestBodies.filter((body) => body.includes(marker)).length,
    peakRestored: () => peakRestored,
    release: (index) => releases[index]?.resolve(undefined),
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

function writeModelResponse(response: ServerResponse, sequence: number): void {
  const text = `restored requester response ${sequence}`;
  const message = {
    type: "message",
    id: `restored-requester-message-${sequence}`,
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
        id: `restored-requester-response-${sequence}`,
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
