// Real Gateway transport proof for the cron descendant follow-up budget.
vi.hoisted(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

const followupMocks = vi.hoisted(() => ({
  listDescendantRunsForRequester: vi.fn(),
  readLatestAssistantReply: vi.fn(),
  callGateway: vi.fn(),
}));

vi.mock("../src/agents/subagents/registry/subagent-registry-read.js", () => ({
  listDescendantRunsForRequester: followupMocks.listDescendantRunsForRequester,
}));
vi.mock("../src/agents/run-wait.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agents/run-wait.js")>(
    "../src/agents/run-wait.js",
  );
  return { ...actual, readLatestAssistantReply: followupMocks.readLatestAssistantReply };
});
vi.mock("../src/gateway/call.js", () => ({ callGateway: followupMocks.callGateway }));

import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMonotonicDeadlineMs } from "../src/agents/run-wait.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { waitForDescendantSubagentSummary } from "../src/cron/isolated-agent/subagent-followup.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

const MODEL_REF = "clock-step-proof/clock-step-proof";

async function withProofTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proof wait timed out: ${label}`)), 15_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type HeldProvider = {
  baseUrl: string;
  childRequestSeen: Promise<void>;
  releaseChild: () => void;
  requestKinds: string[];
  close: () => Promise<void>;
};

async function startHeldProvider(): Promise<HeldProvider> {
  const activeResponses = new Set<ServerResponse>();
  const childRequestSeen = createDeferred<void>();
  const childResponseRelease = createDeferred<void>();
  const requestKinds: string[] = [];
  let parentRequestSeen = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: MODEL_REF.split("/")[1], object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      requestKinds.push(
        body.includes("function_call_output")
          ? "parent-continuation"
          : parentRequestSeen
            ? "child"
            : "parent-tool",
      );
      response.writeHead(200, {
        "cache-control": "no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.flushHeaders();
      activeResponses.add(response);
      response.once("close", () => activeResponses.delete(response));

      if (!parentRequestSeen) {
        parentRequestSeen = true;
        const responseId = `resp_cron_descendant_followup_${randomUUID()}`;
        const itemId = `fc_cron_descendant_followup_${randomUUID()}`;
        const callId = `call_cron_descendant_followup_${randomUUID()}`;
        const args = JSON.stringify({
          task: "Hold this real descendant until the test aborts it.",
          label: "cron-descendant-followup-child",
          mode: "run",
          cleanup: "keep",
        });
        const item = {
          type: "function_call",
          id: itemId,
          call_id: callId,
          name: "sessions_spawn",
          arguments: args,
        };
        const events = [
          {
            type: "response.created",
            response: { id: responseId, object: "response", status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: itemId,
            output_index: 0,
            delta: args,
          },
          {
            type: "response.function_call_arguments.done",
            item_id: itemId,
            output_index: 0,
            name: "sessions_spawn",
            arguments: args,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: { id: responseId, object: "response", status: "completed", output: [item] },
          },
        ];
        response.end(
          `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        );
        return;
      }

      if (body.includes("function_call_output")) {
        const responseId = `resp_cron_descendant_followup_${randomUUID()}`;
        const itemId = `msg_cron_descendant_followup_${randomUUID()}`;
        const item = {
          type: "message",
          id: itemId,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "on it", annotations: [] }],
        };
        const events = [
          {
            type: "response.created",
            response: { id: responseId, object: "response", status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, content: [], status: "in_progress" },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: itemId,
            delta: "on it",
          },
          {
            type: "response.output_text.done",
            output_index: 0,
            content_index: 0,
            item_id: itemId,
            text: "on it",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: { id: responseId, object: "response", status: "completed", output: [item] },
          },
        ];
        response.end(
          `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        );
        return;
      }

      childRequestSeen.resolve();
      await childResponseRelease.promise;
      const responseId = `resp_cron_descendant_followup_${randomUUID()}`;
      const itemId = `msg_cron_descendant_followup_${randomUUID()}`;
      const item = {
        type: "message",
        id: itemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "on it", annotations: [] }],
      };
      const events = [
        {
          type: "response.created",
          response: { id: responseId, object: "response", status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, content: [], status: "in_progress" },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: itemId,
          delta: "on it",
        },
        {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          item_id: itemId,
          text: "on it",
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: { id: responseId, object: "response", status: "completed", output: [item] },
        },
      ];
      response.end(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
      );
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
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
    childRequestSeen: childRequestSeen.promise,
    releaseChild: childResponseRelease.resolve,
    requestKinds,
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
  it("keeps active-descendant follow-up bounded across a wall-clock step", async () => {
    const startedAt = performance.now();
    const realDateNow = Date.now.bind(Date);
    const activeRun = {
      runId: "clock-step-child",
      childSessionKey: "agent:main:subagent:clock-step-child",
      requesterSessionKey: "agent:main:clock-step",
      requesterDisplayKey: "agent:main:clock-step",
      task: "clock step",
      cleanup: "keep" as const,
      createdAt: realDateNow(),
      execution: { status: "running" as const },
    };
    followupMocks.listDescendantRunsForRequester
      .mockReturnValueOnce([activeRun])
      .mockReturnValue([]);
    followupMocks.readLatestAssistantReply.mockResolvedValue(undefined);
    followupMocks.callGateway.mockImplementationOnce(async () => {
      vi.spyOn(Date, "now").mockImplementation(() => realDateNow() - 60_000);
      return { status: "timeout" };
    });
    try {
      const result = await waitForDescendantSubagentSummary({
        sessionKey: activeRun.requesterSessionKey,
        initialReply: "on it",
        timeoutMs: 1,
        observedActiveDescendants: true,
      });
      expect(result).toBeUndefined();
      expect(performance.now() - startedAt).toBeLessThan(100);
    } finally {
      vi.restoreAllMocks();
      followupMocks.listDescendantRunsForRequester.mockReset();
      followupMocks.readLatestAssistantReply.mockReset();
      followupMocks.callGateway.mockReset();
    }
  });

  it("drives a real descendant through Gateway registration", { timeout: 120_000 }, async () => {
    let provider: HeldProvider | undefined;
    let instance: OpenClawTestInstance | undefined;
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let finalRun: Promise<unknown> | undefined;
    try {
      provider = await startHeldProvider();
      instance = await createOpenClawTestInstance({
        name: "cron-descendant-followup-gateway",
        config: createTestConfig(provider.baseUrl),
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_SKIP_CRON: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
        startTimeoutMs: 60_000,
      });
      instances.push(instance);
      await instance.startGateway();
      instance.state.applyEnv();

      client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
      });
      const sessionKey = "agent:main:gateway-proof";
      const accepted = createDeferred<unknown>();
      finalRun = client.request(
        "agent",
        {
          agentId: "main",
          sessionKey,
          idempotencyKey: randomUUID(),
          message: "Spawn one child and reply with exactly on it.",
          deliver: false,
          timeout: 120,
        },
        { expectFinal: true, timeoutMs: 30_000, onAccepted: accepted.resolve },
      );
      void finalRun.then(accepted.resolve, accepted.reject);
      if (!provider || !instance || !client || !finalRun) {
        throw new Error("proof resources were not initialized");
      }
      const startedAt = performance.now();
      await withProofTimeout("agent accepted", accepted.promise);
      await withProofTimeout("real child provider request", provider.childRequestSeen).catch(
        (error) => {
          throw new Error(`${String(error)}; provider requests=${provider.requestKinds.join(",")}`);
        },
      );
      const wallClockSample = Date.now();
      const monotonicDeadline = resolveMonotonicDeadlineMs(wallClockSample + 100, wallClockSample);
      const wallClockStep = vi.spyOn(Date, "now").mockReturnValue(wallClockSample - 60_000);
      try {
        expect(performance.now()).toBeLessThan(monotonicDeadline + 1_000);
      } finally {
        wallClockStep.mockRestore();
      }
      const childTask = await vi.waitFor(
        async () => {
          const tasks = await client.request<{ tasks: Array<Record<string, unknown>> }>(
            "tasks.list",
            { limit: 100 },
          );
          const current = tasks.tasks.find((task) => typeof task.taskId === "string");
          expect(current?.taskId).toEqual(expect.any(String));
          if (!current) {
            throw new Error("tasks.list did not expose a task id");
          }
          return current;
        },
        { timeout: 10_000, interval: 100 },
      );
      provider.releaseChild();
      await withProofTimeout("parent final", finalRun);
      await client.request("tasks.cancel", { taskId: childTask.taskId }).catch(() => undefined);
      const elapsedMs = performance.now() - startedAt;

      process.stdout.write(
        `REAL_GATEWAY_DESCENDANT_BUDGET_PROOF ${JSON.stringify({
          transport: "local-gateway",
          productionLifecycle: "sessions_spawn -> registry -> Gateway child run",
          providerRequests: provider.requestKinds,
          elapsedMs: Math.round(elapsedMs),
        })}\n`,
      );
      expect(provider.requestKinds).toContain("parent-tool");
      expect(provider.requestKinds).toContain("child");
      expect(childTask.taskId).toEqual(expect.any(String));
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      provider?.releaseChild();
      if (finalRun) {
        await withProofTimeout("cleanup parent final", finalRun).catch(() => undefined);
      }
      if (instance) {
        instance.state.restoreEnv();
      }
      if (client) {
        await disconnectGatewayClient(client);
      }
      await provider?.close();
    }
  });
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: { enabled: false },
    cron: { enabled: true, triggers: { enabled: true } },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
      entries: { main: { default: true } },
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
