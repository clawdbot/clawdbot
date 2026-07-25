import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../config/config.js";
import { prepareAgentRequestPreflight } from "../gateway/server-methods/agent-request-preflight.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import {
  clearFallbackGatewayContext,
  type dispatchGatewayMethodInProcess,
} from "../gateway/server-plugins.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunTerminated } from "./subagent-registry.js";
import {
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "./subagent-registry.test-helpers.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagent-spawn.test-support.js";
import { testing as swarmSchedulerTesting } from "./swarm-scheduler.test-support.js";

const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
let stateDir = "";

function makeGatewayContext(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatDeltaLastBroadcastText: new Map(),
    agentDeltaSentAt: new Map(),
    bufferedAgentEvents: new Map(),
    chatAbortedRuns: new Map(),
    clearChatRunState: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    getRuntimeConfig,
  } as unknown as GatewayRequestContext;
}

function externalCliClient(): GatewayRequestOptions["client"] {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "cli",
        version: "test",
        platform: "test",
        mode: "cli",
      },
      scopes: ["operator.write"],
    },
  } as GatewayRequestOptions["client"];
}

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  let lastError: unknown;
  for (let elapsed = 0; elapsed <= timeoutMs; elapsed += 10) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw lastError;
}

describe("spawnSubagentDirect in-process Gateway collector launch", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    clearFallbackGatewayContext();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    subagentRegistryTesting.setDepsForTest({
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {},
      restoreSubagentRunsFromDisk: () => 0,
      ensureRuntimePluginsLoaded: () => {},
    });

    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-swarm-gateway-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify({
        session: { mainKey: "main", scope: "per-sender" },
        tools: { swarm: { enabled: true, maxConcurrent: 1 } },
        agents: {
          defaults: { workspace: stateDir },
          entries: { main: { workspace: stateDir } },
        },
      })}\n`,
    );
    clearConfigCache();
  });

  afterEach(async () => {
    clearFallbackGatewayContext();
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest();
    subagentSpawnTesting.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    envSnapshot.restore();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
  });

  it("launches queued collectors after the parent admission lease is released", async () => {
    const gatewayContext = makeGatewayContext();
    let releaseFirstLaunch!: () => void;
    const firstLaunchGate = new Promise<void>((resolve) => {
      releaseFirstLaunch = resolve;
    });
    const subordinateAdmissionStates: boolean[] = [];
    let launchCount = 0;
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        _method: string,
        params: Record<string, unknown>,
      ) => {
        subordinateAdmissionStates.push(isGatewaySubordinateWorkAdmissionClosed());
        launchCount += 1;
        if (launchCount === 1) {
          await firstLaunchGate;
        }
        return {
          runId: params.idempotencyKey as string,
          status: "accepted",
        } as T;
      },
    });

    const parentAdmission = tryBeginGatewayRootWorkAdmission();
    expect(parentAdmission).not.toBeNull();
    const results = await parentAdmission!.run(() =>
      withPluginRuntimeGatewayRequestScope(
        {
          context: gatewayContext,
          client: externalCliClient(),
          isWebchatConnect: () => false,
        },
        () =>
          Promise.all([
            spawnSubagentDirect(
              {
                task: "first collector",
                collect: true,
                context: "isolated",
                lightContext: true,
                groupId: "swarm-queued-launch",
                swarmLaunchReplayKey: "code-mode:agentSpawn:1",
              },
              {
                agentSessionKey: "agent:main:main",
                requesterRunId: "parent-run",
              },
            ),
            spawnSubagentDirect(
              {
                task: "second collector",
                collect: true,
                context: "isolated",
                lightContext: true,
                groupId: "swarm-queued-launch",
                swarmLaunchReplayKey: "code-mode:agentSpawn:2",
              },
              {
                agentSessionKey: "agent:main:main",
                requesterRunId: "parent-run",
              },
            ),
          ]),
      ),
    );
    parentAdmission!.release();

    expect(results.map((result) => result.status)).toEqual(["accepted", "accepted"]);
    await waitForAssertion(() => {
      expect(launchCount).toBe(1);
    });
    releaseFirstLaunch();
    await waitForAssertion(() => {
      expect(launchCount).toBe(2);
      for (const result of results) {
        expect(subagentRuns.get(result.runId!)).toMatchObject({
          collect: true,
          swarmLaunchPending: false,
        });
      }
    });
    expect(subordinateAdmissionStates).toEqual([false, false]);
  });

  it("aborts a collector cancelled while Gateway acceptance is in flight", async () => {
    const gatewayContext = makeGatewayContext();
    let releaseFirstLaunch!: () => void;
    const firstLaunchGate = new Promise<void>((resolve) => {
      releaseFirstLaunch = resolve;
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let launchCount = 0;
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        requests.push({ method, params });
        if (method === "agent") {
          launchCount += 1;
          if (launchCount === 1) {
            await firstLaunchGate;
          }
          return { runId: `gateway-run-${launchCount}`, status: "accepted" } as T;
        }
        return {} as T;
      },
    });

    const parentAdmission = tryBeginGatewayRootWorkAdmission();
    expect(parentAdmission).not.toBeNull();
    const results = await parentAdmission!.run(() =>
      withPluginRuntimeGatewayRequestScope(
        {
          context: gatewayContext,
          client: externalCliClient(),
          isWebchatConnect: () => false,
        },
        () =>
          Promise.all([
            spawnSubagentDirect(
              {
                task: "cancelled collector",
                collect: true,
                context: "isolated",
                lightContext: true,
                groupId: "swarm-cancel-launch",
                swarmLaunchReplayKey: "code-mode:agentSpawn:cancelled",
              },
              { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
            ),
            spawnSubagentDirect(
              {
                task: "next collector",
                collect: true,
                context: "isolated",
                lightContext: true,
                groupId: "swarm-cancel-launch",
                swarmLaunchReplayKey: "code-mode:agentSpawn:next",
              },
              { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
            ),
          ]),
      ),
    );
    parentAdmission!.release();
    const firstRunId = results[0]?.runId;
    expect(firstRunId).toBeTruthy();
    await waitForAssertion(() => expect(launchCount).toBe(1));

    expect(markSubagentRunTerminated({ runId: firstRunId, reason: "manual kill" })).toBe(1);
    releaseFirstLaunch();

    await waitForAssertion(() => {
      expect(
        requests.some(
          (request) => request.method === "chat.abort" && request.params.runId === "gateway-run-1",
        ),
      ).toBe(true);
      expect(launchCount).toBe(2);
      expect(subagentRuns.get(firstRunId!)).toMatchObject({
        collectorCompletion: { status: "killed" },
      });
      expect(subagentRuns.get("gateway-run-2")).toMatchObject({
        swarmRunId: results[1]!.runId,
        swarmLaunchPending: false,
      });
    });
  });

  it("hands a registered collector launch to Gateway as the host", async () => {
    const gatewayContext = makeGatewayContext();
    const dispatchOptions: Array<{ method: string; forceSyntheticClient?: boolean }> = [];
    const preflightResults: Array<{
      externalAccepted: boolean;
      externalError?: string;
      hostAccepted: boolean;
      hostResponded: boolean;
    }> = [];
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
        options?: NonNullable<Parameters<typeof dispatchGatewayMethodInProcess>[2]>,
      ) => {
        dispatchOptions.push({ method, forceSyntheticClient: options?.forceSyntheticClient });

        const externalRespond = vi.fn();
        const externalPreflight = prepareAgentRequestPreflight({
          params,
          respond: externalRespond,
          context: gatewayContext,
          client: externalCliClient(),
        } as never);

        const hostRespond = vi.fn();
        const client = options?.forceSyntheticClient
          ? createSyntheticPluginRuntimeClient({ scopes: options.syntheticScopes })
          : externalCliClient();
        const hostPreflight = prepareAgentRequestPreflight({
          params,
          respond: hostRespond,
          context: gatewayContext,
          client,
        } as never);
        preflightResults.push({
          externalAccepted: externalPreflight !== undefined,
          externalError: (externalRespond.mock.calls[0]?.[2] as { message?: string } | undefined)
            ?.message,
          hostAccepted: hostPreflight !== undefined,
          hostResponded: hostRespond.mock.calls.length > 0,
        });
        return {
          runId: params.idempotencyKey as string,
          status: "accepted",
        } as T;
      },
    });
    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: gatewayContext,
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          {
            task: "return a collector result",
            collect: true,
            context: "isolated",
            lightContext: true,
            groupId: "swarm-live-launch",
            swarmLaunchReplayKey: "code-mode:agentSpawn:1",
          },
          {
            agentSessionKey: "agent:main:main",
            requesterRunId: "parent-run",
          },
        ),
    );

    expect(result.status).toBe("accepted");
    expect(result.runId).toBeTruthy();
    await waitForAssertion(() => {
      expect(dispatchOptions).toEqual([{ method: "agent", forceSyntheticClient: true }]);
      expect(preflightResults).toEqual([
        {
          externalAccepted: false,
          externalError: "swarm collector fields require an enabled, host-registered collector run",
          hostAccepted: true,
          hostResponded: false,
        },
      ]);
      expect(subagentRuns.get(result.runId!)).toMatchObject({
        childSessionKey: result.childSessionKey,
        collect: true,
        swarmLaunchIdempotencyKey: result.runId,
        swarmLaunchPending: false,
      });
    });
  });
});
