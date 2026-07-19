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
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { subagentRuns } from "./subagent-registry-memory.js";
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
        tools: { swarm: true },
        agents: {
          defaults: { workspace: stateDir },
          list: [{ id: "main", workspace: stateDir }],
        },
      })}\n`,
    );
    clearConfigCache();
  });

  afterEach(async () => {
    clearFallbackGatewayContext();
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

  it("hands a registered collector launch to Gateway as the host", async () => {
    const gatewayContext = makeGatewayContext();
    const dispatchOptions: Array<{
      method: string;
      forceSyntheticClient?: boolean;
      allowSyntheticModelOverride?: boolean;
    }> = [];
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
        dispatchOptions.push({
          method,
          forceSyntheticClient: options?.forceSyntheticClient,
          allowSyntheticModelOverride: options?.allowSyntheticModelOverride,
        });

        const externalRespond = vi.fn();
        const externalPreflight = prepareAgentRequestPreflight({
          params,
          respond: externalRespond,
          context: gatewayContext,
          client: externalCliClient(),
        } as never);

        const hostRespond = vi.fn();
        const client = options?.forceSyntheticClient
          ? createSyntheticPluginRuntimeClient({
              allowModelOverride: options.allowSyntheticModelOverride,
              scopes: options.syntheticScopes,
            })
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
      expect(dispatchOptions).toEqual([
        {
          method: "agent",
          forceSyntheticClient: true,
          allowSyntheticModelOverride: true,
        },
      ]);
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
