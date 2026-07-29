import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import {
  resetSubagentRegistryForTests,
  testing as registryTesting,
} from "../subagent-registry.test-helpers.js";
import "../subagent-registry.mocks.shared.js";
import { testing as spawnTesting } from "../subagent-spawn.test-support.js";
import { testing as swarmSchedulerTesting } from "../swarm-scheduler.test-support.js";
import { createAgentsWaitTool } from "./agents-wait-tool.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";
import { testing as structuredOutputTesting } from "./structured-output-tool.test-support.js";

const requesterSessionKey = "agent:main:main";
const config: OpenClawConfig = {
  session: { mainKey: "main", scope: "per-sender" },
  tools: { swarm: true },
  agents: {
    defaults: {
      workspace: os.tmpdir(),
      model: { primary: "openai/gpt-5.4" },
      subagents: { archiveAfterMinutes: 0 },
    },
  },
};

function requestParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const params = (value as { params?: unknown }).params;
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

describe("swarm tools integration", () => {
  const completionResolvers = new Map<string, () => void>();

  beforeEach(() => {
    completionResolvers.clear();
    resetSubagentRegistryForTests({ persist: false });
    structuredOutputTesting.reset();
    swarmSchedulerTesting.reset();
  });

  afterEach(() => {
    spawnTesting.setDepsForTest();
    registryTesting.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    structuredOutputTesting.reset();
    swarmSchedulerTesting.reset();
    vi.unstubAllEnvs();
  });

  it("spawns three mock-model collectors and drains them in first-completion order", async () => {
    await withTempDir({ prefix: "openclaw-swarm-tools-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const publicToGateway = new Map<string, string>();
      const resultTextBySession = new Map<string, string>();
      const modelStructuredCalls: number[] = [];
      let launchCount = 0;
      const launchGateway = vi.fn(async (request: unknown) => {
        const method =
          request && typeof request === "object"
            ? (request as { method?: unknown }).method
            : undefined;
        if (method !== "agent") {
          return {};
        }
        const params = requestParams(request);
        const publicRunId = String(params.idempotencyKey);
        const childSessionKey = String(params.sessionKey);
        const outputSchema = params.swarmOutputSchema as Record<string, unknown>;
        const index = ++launchCount;
        const gatewayRunId = `gateway-${index}`;
        const structuredOutput = createOpenClawTools({
          agentSessionKey: childSessionKey,
          runId: publicRunId,
          config,
          disableMessageTool: true,
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
          swarmCollector: true,
          swarmOutputSchema: outputSchema,
        }).find((tool) => tool.name === "structured_output");
        expect(structuredOutput).toBeDefined();
        await structuredOutput?.execute("mock-model-output", { result: { index } });
        modelStructuredCalls.push(index);
        publicToGateway.set(publicRunId, gatewayRunId);
        resultTextBySession.set(childSessionKey, `result-${index}`);
        return { runId: gatewayRunId, status: "accepted", acceptedAt: Date.now() };
      });
      spawnTesting.setDepsForTest({
        callGateway: launchGateway as never,
        getGlobalHookRunner: () => null,
        getRuntimeConfig: () => config,
        hasInProcessGatewayContext: () => false,
        ensureContextEnginesInitialized: vi.fn(),
        loadPreparedModelCatalog: vi.fn(async () => []),
        resolveContextEngine: vi.fn(async () => ({
          info: { id: "test", name: "Test", version: "0.0.1" },
          ingest: vi.fn(async () => ({ ingested: false })),
          assemble: vi.fn(async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          })),
          compact: vi.fn(async () => ({ ok: false, compacted: false })),
        })) as never,
      });
      registryTesting.setDepsForTest({
        callGateway: vi.fn(async (request: unknown) => {
          const runId = String(requestParams(request).runId);
          await new Promise<void>((resolve) => {
            completionResolvers.set(runId, resolve);
          });
          return { status: "ok", startedAt: 1, endedAt: Date.now() };
        }) as never,
        captureSubagentCompletionReply: vi.fn(async (sessionKey: string) => {
          return resultTextBySession.get(sessionKey) ?? "";
        }) as never,
        cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => undefined),
        getGatewayRecoveryRuntime: () => undefined,
        getRuntimeConfig: () => config,
        maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async () => false),
        onAgentEvent: vi.fn(() => () => undefined) as never,
        persistSubagentRunsToDisk: vi.fn(),
        persistSubagentRunsToDiskOrThrow: vi.fn(),
        resolveAgentTimeoutMs: () => 1_000,
        restoreSubagentRunsFromDisk: vi.fn(() => 0),
        runSubagentAnnounceFlow: vi.fn(async () => true),
        ensureContextEnginesInitialized: vi.fn(),
        ensureRuntimePluginsLoaded: vi.fn(),
        resolveContextEngine: vi.fn(async () => ({
          info: { id: "test", name: "Test", version: "0.0.1" },
          ingest: vi.fn(async () => ({ ingested: false })),
          assemble: vi.fn(async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          })),
          compact: vi.fn(async () => ({ ok: false, compacted: false })),
        })) as never,
      });

      const spawn = createSessionsSpawnTool({
        agentSessionKey: requesterSessionKey,
        requesterRunId: "parent-run",
        config,
      });
      const runIds: string[] = [];
      for (const index of [1, 2, 3]) {
        const result = await spawn.execute(`spawn-${index}`, {
          task: `collector-${index}`,
          collect: true,
          outputSchema: {
            type: "object",
            properties: { index: { type: "number" } },
            required: ["index"],
          },
        });
        const details = result.details as { status: string; runId?: string };
        expect(details.status).toBe("accepted");
        expect(details.runId).toBeTruthy();
        runIds.push(details.runId ?? "");
      }
      await vi.waitFor(() => expect(completionResolvers.size).toBe(3));
      expect(modelStructuredCalls).toEqual([1, 2, 3]);

      const wait = createAgentsWaitTool({
        agentSessionKey: requesterSessionKey,
        agentId: "main",
        config,
      });
      const pending = new Set(runIds);
      const completionOrder: string[] = [];
      for (const publicRunId of [runIds[1] ?? "", runIds[2] ?? "", runIds[0] ?? ""]) {
        const gatewayRunId = publicToGateway.get(publicRunId);
        expect(gatewayRunId).toBeTruthy();
        completionResolvers.get(gatewayRunId ?? "")?.();
        const result = await wait.execute("wait", {
          ids: [...pending],
          timeoutSeconds: 1,
        });
        const details = result.details as {
          completed: Array<{ runId: string; structured?: unknown }>;
        };
        for (const completed of details.completed) {
          completionOrder.push(completed.runId);
          pending.delete(completed.runId);
        }
      }

      expect(completionOrder).toEqual([runIds[1], runIds[2], runIds[0]]);
      expect(pending.size).toBe(0);
      for (const runId of runIds) {
        expect(structuredOutputTesting.readSwarmStructuredOutput(runId)).toBeUndefined();
      }
    });
  });
});
