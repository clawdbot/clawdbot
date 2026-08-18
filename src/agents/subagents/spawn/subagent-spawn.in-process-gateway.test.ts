import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { readAgentRuntimeExecutionLineage } from "../../../gateway/agent-runtime-execution-lineage.js";
import type { AgentRuntimeIdentity } from "../../../gateway/agent-runtime-identity-token.js";
import { prepareAgentRequestPreflight } from "../../../gateway/agent-turn/agent-request-preflight.js";
import { createAgentTurnIo } from "../../../gateway/agent-turn/io.js";
import { readInProcessAgentRuntimeIdentity } from "../../../gateway/in-process-agent-runtime-identity.js";
import { resolveGatewayAgentTaskTrackingMode } from "../../../gateway/server-methods/agent-task-tracking.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  clearFallbackGatewayContext,
  type dispatchGatewayMethodInProcess,
} from "../../../gateway/server-plugins.js";
import type { WorkerSessionTurnClaim } from "../../../gateway/worker-environments/placement-record.js";
import type {
  WorkerTurnExecutionIdentity,
  WorkerTurnExecutionIdentityCapability,
} from "../../../gateway/worker-environments/placement-turn-claim-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../../tasks/detached-task-runtime.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { createOperationalRunInstanceRef } from "../../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { markSubagentRunTerminated } from "../registry/subagent-registry.js";
import {
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../registry/subagent-registry.test-helpers.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { withParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import { buildSubagentExecutionSessionSpawnContext } from "./subagent-spawn-execution-identity.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagent-spawn.test-support.js";

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
  it("does not construct private lineage while identity collection is disabled", () => {
    expect(
      buildSubagentExecutionSessionSpawnContext({
        enabled: false,
        backend: "subagent",
        parentAgentId: "main",
        requesterRef: "agent:main:main",
        controllerRef: "agent:main:main",
        depth: 1,
        targetAgentId: "main",
        sandbox: "inherit",
      }),
    ).toBeUndefined();
  });

  it("canonicalizes set-like inherited policy inputs in lineage references", () => {
    const build = (allow: string[], deny: string[]) =>
      readAgentRuntimeExecutionLineage(
        buildSubagentExecutionSessionSpawnContext({
          enabled: true,
          backend: "subagent",
          parentAgentId: "main",
          requesterRef: "agent:main:main",
          controllerRef: "agent:main:main",
          depth: 1,
          targetAgentId: "worker",
          sandbox: "inherit",
          inheritedToolAllowlist: allow,
          inheritedToolDenylist: deny,
        }),
      )?.localPolicyRefs;

    expect(build(["read", "write"], ["exec", "browser"])).toEqual(
      build(["write", "read"], ["browser", "exec"]),
    );
  });

  beforeEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    clearFallbackGatewayContext();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    subagentRegistryTesting.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {},
      restoreSubagentRunsFromDisk: () => 0,
    });

    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-swarm-gateway-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify({
        logging: { audit: { enabled: true, executionIdentity: true } },
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

  it("leaves shared agent dispatches unmarked unless native spawn claims the task row", async () => {
    const dispatchOptions: Array<
      NonNullable<Parameters<typeof dispatchGatewayMethodInProcess>[2]> | undefined
    > = [];
    subagentSpawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess: async <T>(
        _method: string,
        _params: Record<string, unknown>,
        options?: NonNullable<Parameters<typeof dispatchGatewayMethodInProcess>[2]>,
      ) => {
        dispatchOptions.push(options);
        return { runId: "shared-agent-run", status: "accepted" } as T;
      },
    });

    await callSubagentGateway({ method: "agent", params: { sessionKey: "agent:main:acp:test" } });

    expect(dispatchOptions).toHaveLength(1);
    expect(dispatchOptions[0]?.forceSyntheticClient).toBe(true);
    expect(dispatchOptions[0]?.agentRunTracking).toBeUndefined();
  });

  afterEach(async () => {
    clearFallbackGatewayContext();
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest();
    subagentSpawnTesting.setDepsForTest();
    resetDetachedTaskLifecycleRuntimeForTests();
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

  it("consumes the exact private parent token in the child Gateway identity", async () => {
    const parentToken = createExecutionIdentityAdmissionToken("parent-run", {
      contextId: "parent-context",
      executionId: "parent-execution",
    });
    const operationalRunInstance = createOperationalRunInstanceRef("parent-run");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    let childIdentity: AgentRuntimeIdentity | undefined;
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        _method: string,
        params: Record<string, unknown>,
        options?: NonNullable<Parameters<typeof dispatchGatewayMethodInProcess>[2]>,
      ) => {
        childIdentity = readInProcessAgentRuntimeIdentity(options);
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      },
    });

    try {
      const result = await withPluginRuntimeGatewayRequestScope(
        {
          context: makeGatewayContext(),
          client: externalCliClient(),
          isWebchatConnect: () => false,
        },
        () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:main",
              operationalRunInstance,
              executionIdentityToken: parentToken,
            },
            () =>
              spawnSubagentDirect(
                { task: "inspect lineage", context: "isolated", lightContext: true },
                withParentExecutionIdentity({ agentSessionKey: "agent:main:main" }, parentToken),
              ),
          ),
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe("accepted");
      expect(childIdentity?.executionIdentity).toBe(parentToken);
      expect(readAgentRuntimeExecutionLineage(childIdentity?.sessionSpawnContext)).toMatchObject({
        relation: "sessions_spawn",
        requesterRef: "agent:main:main",
        controllerRef: "agent:main:main",
        depth: 1,
        applicableGrantRefs: ["tool:sessions_spawn"],
        externalNativeActions: "observable",
      });
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it("revalidates the worker capability at the child Gateway admission boundary", async () => {
    const parentToken = createExecutionIdentityAdmissionToken("parent-run", {
      contextId: "parent-context",
      executionId: "parent-execution",
    });
    const operationalRunInstance = createOperationalRunInstanceRef("parent-run");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const turnClaim = {
      sessionId: "parent-session-id",
      runId: "parent-run",
      claimId: "parent-claim",
      placementGeneration: 4,
      owner: { kind: "worker", environmentId: "worker-env", ownerEpoch: 7 },
    } satisfies WorkerSessionTurnClaim;
    const identity: WorkerTurnExecutionIdentity = {
      agentId: "main",
      delegatedAuthority: authority,
      executionIdentityToken: parentToken,
      operationalRunInstance,
      sessionKey: "agent:main:main",
      turnClaim,
    };
    let validations = 0;
    const capability: WorkerTurnExecutionIdentityCapability = {
      async run<T>(callback: (current: WorkerTurnExecutionIdentity) => Promise<T> | T) {
        validations += 1;
        return await callback(identity);
      },
    };
    let childIdentity: AgentRuntimeIdentity | undefined;
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        _method: string,
        params: Record<string, unknown>,
        options?: NonNullable<Parameters<typeof dispatchGatewayMethodInProcess>[2]>,
      ) => {
        childIdentity = readInProcessAgentRuntimeIdentity(options);
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      },
    });

    try {
      const result = await withPluginRuntimeGatewayRequestScope(
        {
          context: makeGatewayContext(),
          client: externalCliClient(),
          isWebchatConnect: () => false,
        },
        () =>
          capability.run((current) =>
            withGatewayToolCallerIdentity(
              {
                agentId: current.agentId,
                sessionKey: current.sessionKey,
                operationalRunInstance: current.operationalRunInstance,
                executionIdentityToken: current.executionIdentityToken,
                workerTurnClaim: current.turnClaim,
                workerTurnExecutionIdentityCapability: capability,
              },
              () =>
                spawnSubagentDirect(
                  { task: "inspect worker lineage", context: "isolated", lightContext: true },
                  withParentExecutionIdentity(
                    { agentSessionKey: current.sessionKey },
                    current.executionIdentityToken,
                  ),
                ),
            ),
          ),
      );

      expect(result.status).toBe("accepted");
      expect(validations).toBe(2);
      expect(childIdentity?.delegatedAuthority).toMatchObject({
        kind: "worker",
        turnClaim,
      });
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
    }
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
          request: params,
          io: createAgentTurnIo(externalRespond),
          context: gatewayContext,
          client: externalCliClient(),
        } as never);

        const hostRespond = vi.fn();
        const client = options?.forceSyntheticClient
          ? createSyntheticPluginRuntimeClient({ scopes: options.syntheticScopes })
          : externalCliClient();
        const hostPreflight = prepareAgentRequestPreflight({
          request: params,
          io: createAgentTurnIo(hostRespond),
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

  it("aborts the accepted child run when registry registration fails", async () => {
    const gatewayContext = makeGatewayContext();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        requests.push({ method, params });
        if (method === "agent") {
          return { runId: "gateway-accepted-run", status: "accepted" } as T;
        }
        if (method === "chat.abort") {
          return { aborted: true, runIds: [params.runId] } as T;
        }
        return {} as T;
      },
    });
    // The registry never takes ownership, which is exactly when the suppressed
    // gateway CLI row would have been the only record of the accepted run.
    subagentRegistryTesting.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {
        throw new Error("state db unavailable");
      },
      restoreSubagentRunsFromDisk: () => 0,
    });

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: gatewayContext,
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          { task: "orphan me", context: "isolated", lightContext: true },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("error");
    expect(result.error ?? "").toContain("Failed to register subagent run");
    // No registry row exists, so an unaborted run would execute with no task row at all.
    expect(
      requests.some(
        (request) =>
          request.method === "chat.abort" && request.params.runId === "gateway-accepted-run",
      ),
    ).toBe(true);
  });

  // The registry entry only counts as ownership once the canonical `subagent` task row
  // exists. A task runtime is plugin-replaceable and may legally create no row, so both
  // fault shapes have to fail registration and abort — otherwise the accepted child keeps
  // running with the gateway CLI row suppressed and nothing in the tasks rail.
  const taskRowFaults: Array<[label: string, createTaskRun: () => null]> = [
    ["creates no task row", () => null],
    [
      "throws while creating the task row",
      () => {
        throw new Error("task store unavailable");
      },
    ],
  ];
  it.each(taskRowFaults)(
    "aborts the accepted child run when the task runtime %s",
    async (_label, createTaskRun) => {
      const gatewayContext = makeGatewayContext();
      const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
      subagentSpawnTesting.setDepsForTest({
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
        ) => {
          requests.push({ method, params });
          if (method === "agent") {
            return { runId: "gateway-accepted-run", status: "accepted" } as T;
          }
          if (method === "chat.abort") {
            return { aborted: true, runIds: [params.runId] } as T;
          }
          return {} as T;
        },
      });
      // Registry persistence succeeds here; only the task row is missing.
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        createQueuedTaskRun: createTaskRun,
        createRunningTaskRun: createTaskRun,
      });

      const result = await withPluginRuntimeGatewayRequestScope(
        {
          context: gatewayContext,
          client: externalCliClient(),
          isWebchatConnect: () => false,
        },
        () =>
          spawnSubagentDirect(
            { task: "orphan me", context: "isolated", lightContext: true },
            { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
          ),
      );

      expect(result.status).toBe("error");
      expect(
        requests.some(
          (request) =>
            request.method === "chat.abort" && request.params.runId === "gateway-accepted-run",
        ),
      ).toBe(true);
      // Rolled back rather than half-registered: a retained entry would report a live run
      // that owns no task row.
      expect(subagentRuns.size).toBe(0);
    },
  );

  it("keeps the Gateway-owned task row on an out-of-process fallback", async () => {
    const gatewayContext = makeGatewayContext();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const createTaskRun = vi.fn(() => {
      throw new Error("registry task creation must be skipped");
    });
    subagentSpawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => false,
      callGateway: async <T>(request: { method: string; params?: unknown }) => {
        requests.push({
          method: request.method,
          params: (request.params ?? {}) as Record<string, unknown>,
        });
        return {
          runId: request.method === "agent" ? "gateway-owned-run" : undefined,
          status: "accepted",
        } as T;
      },
    });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      createQueuedTaskRun: createTaskRun,
      createRunningTaskRun: createTaskRun,
    });

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: gatewayContext,
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          { task: "use the remote gateway row", context: "isolated", lightContext: true },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("accepted");
    expect(result.runId).toBe("gateway-owned-run");
    expect(createTaskRun).not.toHaveBeenCalled();
    expect(subagentRuns.get("gateway-owned-run")).toMatchObject({
      childSessionKey: result.childSessionKey,
    });
    expect(requests.filter((request) => request.method === "agent")).toHaveLength(1);
    expect(requests.some((request) => request.method === "chat.abort")).toBe(false);
  });

  it("keeps the queued registry row when a collector starts out of process", async () => {
    const gatewayContext = makeGatewayContext();
    const trackingModes: string[] = [];
    subagentSpawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => false,
      callGateway: async <T>(request: { method: string; params?: unknown }) => {
        const requestParams = (request.params ?? {}) as Record<string, unknown>;
        if (request.method === "agent") {
          const client = createSyntheticPluginRuntimeClient();
          expect(client.internal?.agentRunTracking).toBeUndefined();
          trackingModes.push(
            resolveGatewayAgentTaskTrackingMode({
              client,
              sessionKey: requestParams.sessionKey as string,
              runId: requestParams.idempotencyKey as string,
            }),
          );
        }
        return {
          runId: requestParams.idempotencyKey,
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
            task: "start after registry ownership",
            collect: true,
            context: "isolated",
            lightContext: true,
            groupId: "swarm-out-of-process",
            swarmLaunchReplayKey: "code-mode:agentSpawn:out-of-process",
          },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("accepted");
    await waitForAssertion(() => {
      expect(trackingModes).toEqual(["none"]);
      expect(subagentRuns.get(result.runId!)).toMatchObject({
        collect: true,
        swarmLaunchPending: false,
      });
    });
  });

  it("does not abort an out-of-process run when registry persistence fails", async () => {
    const gatewayContext = makeGatewayContext();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    subagentSpawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => false,
      callGateway: async <T>(request: { method: string; params?: unknown }) => {
        requests.push({
          method: request.method,
          params: (request.params ?? {}) as Record<string, unknown>,
        });
        return {
          runId: request.method === "agent" ? "gateway-owned-unregistered-run" : undefined,
          status: "accepted",
        } as T;
      },
    });
    subagentRegistryTesting.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {
        throw new Error("state db unavailable");
      },
      restoreSubagentRunsFromDisk: () => 0,
    });

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: gatewayContext,
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          { task: "keep remote ownership", context: "isolated", lightContext: true },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("error");
    expect(result.error ?? "").toContain("Failed to register subagent run");
    expect(requests.some((request) => request.method === "chat.abort")).toBe(false);
  });

  it("launches child runs as a Gateway client that does not own a second task row", async () => {
    const gatewayContext = makeGatewayContext();
    const agentDispatches: Array<{
      params: Record<string, unknown>;
      options?: NonNullable<Parameters<typeof dispatchGatewayMethodInProcess>[2]>;
    }> = [];
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
        options?: NonNullable<Parameters<typeof dispatchGatewayMethodInProcess>[2]>,
      ) => {
        if (method === "agent") {
          agentDispatches.push({ params, options });
        }
        return { runId: params.idempotencyKey as string, status: "accepted" } as T;
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
            task: "summarize the repository",
            context: "isolated",
            lightContext: true,
          },
          {
            agentSessionKey: "agent:main:main",
            requesterRunId: "parent-run",
          },
        ),
    );

    expect(result.status).toBe("accepted");
    const runId = result.runId ?? "";
    expect(runId).toBeTruthy();
    // The registry owns the canonical `subagent` task row for this run.
    await waitForAssertion(() => {
      expect(subagentRuns.get(runId)).toMatchObject({
        childSessionKey: result.childSessionKey,
      });
    });

    const dispatch = agentDispatches[0];
    expect(dispatch).toBeDefined();
    // Rebuild the exact client the Gateway sees for this launch, then ask the
    // real resolver whether it would write its own `cli` task row for the run.
    const gatewayClient = createSyntheticPluginRuntimeClient({
      ...(dispatch?.options?.agentRunTracking
        ? { agentRunTracking: dispatch.options.agentRunTracking }
        : {}),
      ...(dispatch?.options?.syntheticScopes ? { scopes: dispatch.options.syntheticScopes } : {}),
    });
    expect(
      resolveGatewayAgentTaskTrackingMode({
        client: gatewayClient,
        sessionKey: dispatch?.params.sessionKey as string,
      }),
    ).toBe("none");
  });
});
