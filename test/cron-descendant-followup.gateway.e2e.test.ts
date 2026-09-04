// Real Gateway transport proof for the cron descendant follow-up budget.
vi.hoisted(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "../src/agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { waitForDescendantSubagentSummary } from "../src/cron/isolated-agent/subagent-followup.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

const MODEL_REF = "clock-step-proof/clock-step-proof";

type HeldProvider = {
  baseUrl: string;
  requestSeen: Promise<void>;
  close: () => Promise<void>;
};

async function startHeldProvider(): Promise<HeldProvider> {
  const activeResponses = new Set<ServerResponse>();
  const requestSeen = createDeferred<void>();
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: MODEL_REF.split("/")[1], object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.flushHeaders();
    activeResponses.add(response);
    response.once("close", () => activeResponses.delete(response));
    requestSeen.resolve();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("held proof provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestSeen: requestSeen.promise,
    close: async () => {
      for (const response of activeResponses) {
        response.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

const instances: OpenClawTestInstance[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
});

describe("cron descendant follow-up Gateway transport", () => {
  it(
    "keeps the bounded follow-up on one monotonic budget after a wall-clock step",
    { timeout: 120_000 },
    async () => {
      const provider = await startHeldProvider();
      const instance = await createOpenClawTestInstance({
        name: "cron-descendant-followup-gateway",
        config: createTestConfig(provider.baseUrl),
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      instances.push(instance);
      await instance.startGateway();
      instance.state.applyEnv();

      const runId = randomUUID();
      const sessionKey = "agent:main:cron:gateway-proof";
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
      });
      const accepted = createDeferred<unknown>();
      const finalRun = client.request(
        "agent",
        {
          agentId: "main",
          sessionKey,
          idempotencyKey: runId,
          message: "Hold this run until the test aborts it.",
          deliver: false,
          timeout: 120,
        },
        { expectFinal: true, timeoutMs: 30_000, onAccepted: accepted.resolve },
      );
      await accepted.promise;
      await provider.requestSeen;

      const now = Date.now();
      const run: SubagentRunRecord = {
        runId,
        childSessionKey: "agent:main:subagent:gateway-proof",
        requesterSessionKey: sessionKey,
        requesterDisplayKey: sessionKey,
        task: "gateway transport proof",
        cleanup: "keep",
        createdAt: now,
        execution: { status: "running", startedAt: now },
      };
      subagentRuns.set(runId, run);

      const realDateNow = Date.now.bind(Date);
      let dateSamples = 0;
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
        dateSamples += 1;
        const current = realDateNow();
        return dateSamples <= 2 ? current : current - 60_000;
      });

      try {
        const startedAt = performance.now();
        const result = await waitForDescendantSubagentSummary({
          sessionKey,
          initialReply: "on it",
          timeoutMs: 1,
          observedActiveDescendants: true,
        });
        const elapsedMs = performance.now() - startedAt;

        process.stdout.write(
          `REAL_GATEWAY_DESCENDANT_BUDGET_PROOF ${JSON.stringify({
            transport: "local-gateway",
            rpc: ["agent.wait", "chat.history"],
            result: result ?? null,
            wallClockStepMs: 60_000,
            elapsedMs: Math.round(elapsedMs),
          })}\n`,
        );
        expect(result).toBeUndefined();
        expect(elapsedMs).toBeLessThan(100);
      } finally {
        dateNow.mockRestore();
        subagentRuns.delete(runId);
        instance.state.restoreEnv();
        await client.request("chat.abort", { sessionKey, runId }).catch(() => undefined);
        await finalRun.catch(() => undefined);
        await disconnectGatewayClient(client);
        await provider.close();
      }
    },
  );
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: { enabled: false },
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
        "clock-step-proof": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: MODEL_REF.split("/")[1],
              name: MODEL_REF.split("/")[1],
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
