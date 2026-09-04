/** Pending native spawn must transfer only live invocation authority to the child owner. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { readAgentRuntimeExecutionLineage } from "../../../gateway/agent-runtime-execution-lineage.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "../../../gateway/server-methods.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import {
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionDeleteHandlers } from "../../../gateway/server-methods/sessions-delete.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../../infra/agent-run-registry.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
} from "../../../sessions/session-lifecycle-admission.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import { cancelTaskById, findTaskByRunId, getTaskById } from "../../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import {
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  resetTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { createAgentHarnessHostCapabilities } from "../../harness/host-capability.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  readSubagentSessionStore,
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import {
  resetSubagentRegistryForTests,
  testing as registryTesting,
} from "../registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

type AgentTurnService = ReturnType<
  typeof import("../../../gateway/agent-turn/agent-turn-service.js").createAgentTurnService
>;

const agentTurnServiceMocks = vi.hoisted(() => ({
  startTurn: vi.fn<AgentTurnService["startTurn"]>(),
  waitForTurn: vi.fn<AgentTurnService["waitForTurn"]>(),
}));

vi.mock("../../../gateway/agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => agentTurnServiceMocks,
}));

const parentSessionKey = "agent:main:subagent:pending-spawn-parent";
const parentRunId = "pending-spawn-parent";
const groupId = "pending-spawn";
const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir = "";

async function writeTestConfig(params?: {
  maxSpawnDepth?: number;
  allowAgents?: string[];
  executionIdentity?: boolean;
}) {
  const subagents = {
    ...(params?.maxSpawnDepth !== undefined ? { maxSpawnDepth: params.maxSpawnDepth } : {}),
    ...(params?.allowAgents ? { allowAgents: params.allowAgents } : {}),
  };
  await writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      logging: {
        audit: {
          enabled: params?.executionIdentity === true,
          executionIdentity: params?.executionIdentity === true,
        },
      },
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: {
        ownership: "explicit",
        defaults: {
          workspace: stateDir,
          systemAgent: { agentId: "main" },
          ...(Object.keys(subagents).length > 0 ? { subagents } : {}),
        },
        entries: {
          main: { workspace: stateDir },
          worker: { workspace: stateDir },
        },
      },
    }),
  );
  clearConfigCache();
  clearRuntimeConfigSnapshot();
}

beforeEach(async () => {
  agentTurnServiceMocks.startTurn.mockReset();
  agentTurnServiceMocks.waitForTurn.mockReset();
  stateDir = tempDirs.make("openclaw-spawn-authority-");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  await writeTestConfig();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  // The source test supplies the real ESM owner through the existing CJS runtime seam.
  setTaskRegistryControlRuntimeForTests(taskControlRuntime);
  registryTesting.setDepsForTest({
    loadAgentRuntimePluginRegistryHandle: () => undefined,
    callGateway: async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error(`Unexpected registry RPC ${request.method}`);
      }
      return await new Promise<never>(() => {});
    },
  });
});

afterEach(async () => {
  await settleSubagentRegistryPersistenceWork();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  schedulerTesting.reset();
  resetTaskRegistryControlRuntimeForTests();
  await cleanupSessionStateForTest({ stateDir });
  registryTesting.setDepsForTest();
  spawnTesting.setDepsForTest();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await flushLogger();
  resetLogger();
  env.restore();
});

async function createBoundParent(runtime: "embedded" | "plugin-harness" = "embedded") {
  const cfg = getRuntimeConfig();
  const storePath = await writeSubagentSessionEntry({
    stateDir,
    agentId: "main",
    sessionKey: parentSessionKey,
    defaultSessionId: "parent-session",
  });
  const context = createChatAbortContext({
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
  });
  const admission = prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(parentRunId),
    facts: {
      runId: parentRunId,
      agentId: "main",
      ingress: { kind: "system", boundary: "spawn-authority-test", state: "present" },
    },
  });
  const parent = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: parentRunId,
    sessionKey: parentSessionKey,
    sessionId: "parent-session",
    agentId: "main",
    ownerConnId: "owner-connection",
    timeoutMs: 60_000,
    operationalRunInstance: admission.operationalRunInstance,
  });
  const admitted = await admission.admit(runtime);
  // Match agent-run-execution-phase: bind the admitted owner before tools run.
  bindGatewayContextResolver(admitted, () => context as unknown as GatewayRequestContext);
  const authority = getAdmittedRunDelegatedAuthority(admitted)!;
  parent.bindAgentRunDelegatedAuthority(authority);
  expect(parent.entry?.operationalRunInstance).toBe(admitted.operationalRunInstance);
  expect(parent.entry?.agentRunDelegatedAuthority).toBe(authority);
  if (cfg.logging?.audit?.executionIdentity === true) {
    expect(admitted.executionIdentityToken).toBeDefined();
  } else {
    expect(admitted.executionIdentityToken).toBeUndefined();
  }

  return { cfg, storePath, context, admission, parent, admitted, authority };
}

function createBoundSpawnInvocation(bound: Awaited<ReturnType<typeof createBoundParent>>) {
  const source = createSessionsSpawnTool({
    config: bound.cfg,
    agentSessionKey: parentSessionKey,
    requesterRunId: parentRunId,
    requesterTurnRunId: parentRunId,
  });
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: bound.admitted,
    agentId: "main",
    sessionKey: parentSessionKey,
  });
  return (args: Record<string, unknown> = {}) =>
    withPluginRuntimeGatewayRequestScope(
      {
        context: bound.context as unknown as GatewayRequestContext,
        isWebchatConnect: () => false,
      },
      () =>
        withGatewayToolCallerIdentity(caller, () =>
          source.execute!("spawn-authority-boundary", { task: "bounded child", ...args }),
        ),
    );
}

describe("pending spawn invocation authority", () => {
  it("launches an upgraded descendant through the production Gateway dispatch boundary", async () => {
    await writeTestConfig({ executionIdentity: true });
    const bound = await createBoundParent();
    const context = bound.context as unknown as GatewayRequestContext;
    const methodRegistry = createRequestGatewayMethodRegistry();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => methodRegistry,
      isDispatchAvailable: () => true,
    });
    context.createAgentTurnFacade = runtime.createAgentTurnFacade;
    context.getGatewayMethodRegistry = () => methodRegistry;
    let observedPrincipal: Parameters<AgentTurnService["startTurn"]>[0]["principal"] | undefined;
    let observedRequest:
      | Parameters<AgentTurnService["startTurn"]>[0]["preflight"]["request"]
      | undefined;
    agentTurnServiceMocks.startTurn.mockImplementation(
      async ({ preflight, principal, io, onRunObserved }) => {
        // Stop only at the model-turn boundary, after the production Gateway facade has
        // authorized the synthetic native-subagent principal and constructed the turn.
        observedPrincipal = principal;
        observedRequest = preflight.request;
        onRunObserved?.(preflight.runId);
        io.emitAcceptance(
          [
            true,
            {
              runId: preflight.runId,
              status: "accepted",
              sessionKey: preflight.request.sessionKey,
              agentId: "main",
            },
            undefined,
          ],
          { runId: preflight.runId },
        );
      },
    );
    try {
      const result = await createBoundSpawnInvocation(bound)();
      expect(result).toMatchObject({
        details: {
          status: "accepted",
          childSessionKey: expect.any(String),
          runId: expect.any(String),
        },
      });
      const details = result.details as { childSessionKey: string; runId: string };
      expect(agentTurnServiceMocks.startTurn).toHaveBeenCalledOnce();
      expect(observedRequest?.sessionKey).toBe(details.childSessionKey);
      expect(observedPrincipal?.internal?.agentRunTracking).toBe("native_subagent");
      const runtimeIdentity = observedPrincipal?.internal?.agentRuntimeIdentity;
      expect(runtimeIdentity).toMatchObject({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: parentSessionKey,
      });
      expect(readAgentRuntimeExecutionLineage(runtimeIdentity?.sessionSpawnContext)).toMatchObject({
        relation: "sessions_spawn",
        requesterRef: parentSessionKey,
        controllerRef: parentSessionKey,
        depth: 2,
        applicableGrantRefs: ["tool:sessions_spawn"],
        runtimeAssuranceRefs: ["spawn-runtime:subagent"],
      });
      expect(
        loadSessionEntry({ storePath: bound.storePath, sessionKey: details.childSessionKey }),
      ).toMatchObject({
        spawnedBy: parentSessionKey,
        spawnDepth: 2,
      });
      expect(subagentRuns.get(details.runId)).toMatchObject({
        childSessionKey: details.childSessionKey,
        requesterSessionKey: parentSessionKey,
        execution: { status: "running" },
      });
    } finally {
      runtime.close();
      bound.admission.close();
      bound.parent.cleanup();
    }
  });

  it.each([
    {
      label: "finite depth cap",
      configure: () => writeTestConfig({ maxSpawnDepth: 1 }),
      args: {},
    },
    {
      label: "target-agent policy denial",
      configure: () => writeTestConfig({ allowAgents: ["main"] }),
      args: { agentId: "worker" },
    },
  ])(
    "rejects descendant spawn before persistence or dispatch: $label",
    async ({ configure, args }) => {
      await configure();
      const bound = await createBoundParent();
      const agentDispatch = vi.fn();
      spawnTesting.setDepsForTest({
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
        ) => {
          agentDispatch(method, params);
          return { runId: params.idempotencyKey, status: "accepted" } as T;
        },
      });
      try {
        const before = await readSubagentSessionStore(bound.storePath);
        const result = await createBoundSpawnInvocation(bound)(args);
        expect(result).toMatchObject({ details: { status: "forbidden" } });
        expect(await readSubagentSessionStore(bound.storePath)).toEqual(before);
        expect(agentDispatch).not.toHaveBeenCalled();
        expect(subagentRuns.size).toBe(0);
      } finally {
        bound.admission.close();
        bound.parent.cleanup();
      }
    },
  );

  it.each(["delegated authority revoked", "admission closed"])(
    "rejects descendant spawn before persistence or dispatch when %s",
    async (closure) => {
      const bound = await createBoundParent();
      const invoke = createBoundSpawnInvocation(bound);
      const agentDispatch = vi.fn();
      spawnTesting.setDepsForTest({
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
        ) => {
          agentDispatch(method, params);
          return { runId: params.idempotencyKey, status: "accepted" } as T;
        },
      });
      try {
        const before = await readSubagentSessionStore(bound.storePath);
        if (closure === "delegated authority revoked") {
          releaseAgentRunDelegatedAuthority(bound.authority);
        } else {
          bound.admission.close();
        }
        // The provider wrapper may reject or serialize the same stale-authority error.
        const outcome = await invoke().then(
          (value) => value,
          (error: unknown) => error,
        );
        const outcomeText = outcome instanceof Error ? outcome.message : JSON.stringify(outcome);
        expect(outcomeText).toContain("tool invocation authority is no longer active");
        expect(await readSubagentSessionStore(bound.storePath)).toEqual(before);
        expect(agentDispatch).not.toHaveBeenCalled();
        expect(subagentRuns.size).toBe(0);
      } finally {
        bound.admission.close();
        bound.parent.cleanup();
      }
    },
  );

  it.each([
    "native abort",
    "native acceptance",
    "native call signal",
    "native construction signal",
    "native claim loss",
    "native replacement",
    "native lifecycle rotation",
    "native admission close",
    "projected close",
    "projected claim loss",
  ])("rolls back an untransferred native spawn: %s", async (closure) => {
    const { cfg, storePath, context, admission, parent, admitted, authority } =
      await createBoundParent(closure.startsWith("projected") ? "plugin-harness" : "embedded");
    const acceptedGate = createDeferred();
    const acceptedEntered = createDeferred();
    let childController: ReturnType<typeof registerChatAbortController> | undefined;
    const entered = createDeferred<string>();
    const release = createDeferred();
    const rollback = vi.fn(async () => {});
    const agentDispatch = vi.fn();
    const deleted: string[] = [];
    spawnTesting.setDepsForTest({
      resolveContextEngine: async () =>
        Object.assign(new LegacyContextEngine(), {
          prepareSubagentSpawn: async ({ childSessionKey }: { childSessionKey: string }) => {
            entered.resolve(childSessionKey);
            await release.promise;
            return { rollback };
          },
        }),
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        if (method === "agent") {
          agentDispatch(params);
          if (closure === "native acceptance") {
            const childSessionKey = params.sessionKey as string;
            const child = loadSessionEntry({ storePath, sessionKey: childSessionKey })!;
            childController = registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId: params.idempotencyKey as string,
              sessionKey: childSessionKey,
              sessionId: child.sessionId,
              agentId: "main",
              timeoutMs: 60_000,
            });
            acceptedEntered.resolve();
            await acceptedGate.promise;
          }
          return { runId: params.idempotencyKey, status: "accepted" } as T;
        }
        if (method === "chat.abort") {
          const respond = await invokeChatAbortHandler({
            handler: handleChatAbortRequest,
            context,
            request: params as { sessionKey: string; runId: string },
            client: createSyntheticPluginRuntimeClient(),
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ aborted: true, runIds: [params.runId] }),
          );
          return respond.mock.calls[0]![1] as T;
        }
        if (method !== "sessions.delete") {
          throw new Error(`Unexpected spawn RPC ${method}`);
        }
        let payload: unknown;
        await sessionDeleteHandlers["sessions.delete"]!({
          req: {} as never,
          params,
          context: context as unknown as GatewayRequestContext,
          client: createSyntheticPluginRuntimeClient(),
          isWebchatConnect: () => false,
          respond: (ok, result, error) => {
            if (!ok) {
              throw new Error(error?.message ?? "delete failed");
            }
            payload = result;
          },
        });
        deleted.push(params.key as string);
        return payload as T;
      },
    });
    const invocationAbort = new AbortController();
    let replacementAuthority: ReturnType<typeof claimAgentRunDelegatedAuthority> | undefined;
    const host = closure.startsWith("projected")
      ? createAgentHarnessHostCapabilities({
          attempt: {
            admittedRunContext: admitted,
            runId: parentRunId,
            config: cfg,
            agentId: "main",
            sessionKey: parentSessionKey,
            abortSignal: parent.controller.signal,
          },
          pluginId: "test-harness",
        })
      : undefined;
    const source = createSessionsSpawnTool({
      config: cfg,
      agentSessionKey: parentSessionKey,
      requesterRunId: parentRunId,
      requesterTurnRunId: parentRunId,
      signal: closure === "native construction signal" ? invocationAbort.signal : undefined,
    });
    let forwarded: Promise<unknown> | undefined;
    const observed: AnyAgentTool = {
      ...source,
      execute: (...args) => {
        const pending = source.execute!(...args);
        // Observe, but still forward the real source promise through the native wrappers.
        forwarded = pending.then(
          (result) => result,
          (error: unknown) => error,
        );
        return pending;
      },
    };
    const [tool] = host
      ? host.capabilities.bindToolSurface([observed])
      : finalizeAgentTools({
          tools: [observed],
          hookContext: {
            config: cfg,
            agentId: "main",
            sessionKey: parentSessionKey,
            runId: parentRunId,
          },
          abortSignal: parent.controller.signal,
        });
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: parentSessionKey,
    });
    const wrapped = withPluginRuntimeGatewayRequestScope(
      { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
      () =>
        withGatewayToolCallerIdentity(caller, () =>
          tool!.execute!(
            "spawn-pending",
            {
              task: "bounded child",
              collect: closure !== "native acceptance",
              context: "isolated",
              groupId: closure === "native acceptance" ? undefined : groupId,
            },
            closure === "native call signal" ? invocationAbort.signal : undefined,
          ),
        ),
    );
    const wrappedOutcome = wrapped.then(
      (result) => result,
      (error: unknown) => error,
    );
    try {
      const childSessionKey = await entered.promise;
      expect(subagentRuns.size, "no ownership transfer before preparation resolves").toBe(0);
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeDefined();
      if (closure === "native acceptance") {
        release.resolve();
        await acceptedEntered.promise;
        expect(subagentRuns.size, "accepted local run still awaits source registration").toBe(0);
        expect(childController?.controller.signal.aborted).toBe(false);
      }
      if (closure === "native abort" || closure === "native acceptance") {
        const reply = await invokeChatAbortHandler({
          handler: handleChatAbortRequest,
          context,
          request: { sessionKey: parentSessionKey, runId: parentRunId },
          client: {
            connId: "owner-connection",
            connect: { scopes: ["operator.read", "operator.write"] },
          },
        });
        expect(reply).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [parentRunId],
        });
        expect(parent.controller.signal.aborted).toBe(true);
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
        expect(await wrappedOutcome).toBeInstanceOf(Error);
      } else {
        if (closure.endsWith("claim loss")) {
          releaseAgentRunDelegatedAuthority(authority);
        } else if (closure.endsWith("replacement")) {
          replacementAuthority = claimAgentRunDelegatedAuthority(
            createOperationalRunInstanceRef(parentRunId),
          );
        } else if (closure.endsWith("lifecycle rotation")) {
          rotateAgentRunRegistryLifecycleGeneration();
        } else if (closure === "projected close") {
          host!.close();
        } else if (closure.endsWith("signal")) {
          invocationAbort.abort();
        } else {
          admission.close();
        }
        expect(
          parent.controller.signal.aborted,
          "claim/capability closure is independent of parent signal",
        ).toBe(false);
      }
      release.resolve();
      acceptedGate.resolve();
      await forwarded;
      if (closure === "native acceptance") {
        expect(agentDispatch).toHaveBeenCalledOnce();
        expect(
          childController?.controller.signal.aborted,
          "exact accepted local child aborted before deletion",
        ).toBe(true);
      } else {
        expect(agentDispatch, "cancelled source never dispatches a child").not.toHaveBeenCalled();
      }
      expect(subagentRuns.size, "cancelled source never registers runnable work").toBe(0);
      expect(rollback).toHaveBeenCalledOnce();
      expect(deleted).toEqual([childSessionKey]);
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeUndefined();
      const survivor = vi.fn(async () => {});
      enqueueSwarmRun({
        groupId: JSON.stringify([parentSessionKey, groupId]),
        runId: "surviving-reservation",
        maxConcurrent: 1,
        activeRunIds: [],
        start: survivor,
        onStartFailure: () => true,
      });
      await vi.waitFor(() => expect(survivor).toHaveBeenCalledOnce());
    } finally {
      release.resolve();
      acceptedGate.resolve();
      await forwarded;
      childController?.cleanup();
      await wrappedOutcome;
      host?.close();
      if (replacementAuthority) {
        releaseAgentRunDelegatedAuthority(replacementAuthority);
      }
      admission.close();
      parent.cleanup();
    }
  });

  it.each(["complete", "abort", "abort during registration"])(
    "preserves child ownership when the parent closes after registration: %s",
    async (closure) => {
      const { cfg, context, admission, parent, admitted } = await createBoundParent();
      const blockerStarted = createDeferred();
      enqueueSwarmRun({
        groupId: JSON.stringify([parentSessionKey, groupId]),
        runId: "handoff-blocker",
        maxConcurrent: 1,
        activeRunIds: [],
        start: async () => {
          blockerStarted.resolve();
        },
        onStartFailure: () => true,
      });
      await blockerStarted.promise;
      let cancellation: ReturnType<typeof invokeChatAbortHandler> | undefined;
      const abortParent = () =>
        invokeChatAbortHandler({
          handler: handleChatAbortRequest,
          context,
          request: { sessionKey: parentSessionKey, runId: parentRunId },
          client: {
            connId: "owner-connection",
            connect: { scopes: ["operator.read", "operator.write"] },
          },
        });
      if (closure === "abort during registration") {
        configureTaskRegistryRuntime({
          observers: {
            onEvent: (event) => {
              if (event.kind === "upserted" && event.task.runtime === "subagent" && !cancellation) {
                cancellation = abortParent();
              }
            },
          },
        });
      }
      const rollback = vi.fn(async () => {});
      const dispatch = vi.fn();
      spawnTesting.setDepsForTest({
        resolveContextEngine: async () =>
          Object.assign(new LegacyContextEngine(), {
            prepareSubagentSpawn: async () => ({ rollback }),
          }),
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
        ) => {
          expect(method).toBe("agent");
          dispatch(params.idempotencyKey);
          return { runId: params.idempotencyKey, status: "accepted" } as T;
        },
      });
      const source = createSessionsSpawnTool({
        config: cfg,
        agentSessionKey: parentSessionKey,
        requesterRunId: parentRunId,
        requesterTurnRunId: parentRunId,
      });
      let forwarded: Promise<unknown> | undefined;
      const observed: AnyAgentTool = {
        ...source,
        execute: (...args) => {
          const pending = source.execute!(...args);
          forwarded = pending.then(
            (value) => value,
            (error: unknown) => error,
          );
          return pending;
        },
      };
      const [tool] = finalizeAgentTools({
        tools: [observed],
        hookContext: {
          config: cfg,
          agentId: "main",
          sessionKey: parentSessionKey,
          runId: parentRunId,
        },
        abortSignal: parent.controller.signal,
      });
      const pending = withPluginRuntimeGatewayRequestScope(
        { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
        () =>
          withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: "main",
              sessionKey: parentSessionKey,
            }),
            () =>
              tool!.execute!("spawn-handoff", {
                task: "independent after handoff",
                collect: true,
                context: "isolated",
                groupId,
              }),
          ),
      ).then(
        (value) => value,
        (error: unknown) => error,
      );
      try {
        const sourceResult = await pending;
        // The source can finish its handoff even when the outer native wrapper is aborted.
        const accepted = await forwarded;
        expect(accepted).toMatchObject({ details: { status: "accepted" } });
        const { runId } = (accepted as { details: { runId: string } }).details;
        expect(subagentRuns.get(runId)?.requesterTurnRunId).toBe(parentRunId);
        expect(dispatch).not.toHaveBeenCalled();
        if (closure !== "complete") {
          cancellation ??= abortParent();
          const respond = await cancellation;
          expect(respond).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [parentRunId],
          });
        } else {
          expect(sourceResult).toMatchObject({ details: { status: "accepted", runId } });
          expect(subagentRuns.get(runId)?.execution.status).toBe("queued");
          expect(findTaskByRunId(runId)?.status).toBe("queued");
          admission.close();
          parent.cleanup();
          expect(parent.controller.signal.aborted).toBe(false);
        }
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
        // Capacity is released by Gateway-owned work, outside the completed parent's caller.
        withPluginRuntimeGatewayRequestScope(
          { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
          () => releaseSwarmRun("handoff-blocker"),
        );
        if (closure !== "complete") {
          expect(dispatch).not.toHaveBeenCalled();
          expect(findTaskByRunId(runId)?.status).toBe("cancelled");
          expect(subagentRuns.get(runId)).toMatchObject({
            collectorCompletion: { status: "killed" },
          });
        } else {
          expect(sourceResult).toMatchObject({ details: { status: "accepted", runId } });
          await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(runId));
          expect(rollback).not.toHaveBeenCalled();
          expect(subagentRuns.get(runId)).toMatchObject({ execution: { status: "running" } });
        }
      } finally {
        configureTaskRegistryRuntime({ observers: null });
        releaseSwarmRun("handoff-blocker");
        await cancellation;
        await forwarded;
        await pending;
        admission.close();
        parent.cleanup();
      }
    },
  );

  it("cancels the task's captured row when delayed acceptance rekeys it during the drain", async () => {
    const { cfg, storePath, context, admission, parent } = await createBoundParent();
    const response = createDeferred();
    const dispatchEntered = createDeferred();
    spawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(method: string) => {
        expect(method).toBe("agent");
        dispatchEntered.resolve();
        await response.promise;
        return { runId: "accepted-task-run", status: "accepted" } as T;
      },
    });
    let lease: ReturnType<typeof consumeSessionWorkAdmissionHandoff>;
    let cancellation: ReturnType<typeof cancelTaskById> | undefined;
    try {
      const spawned = await withPluginRuntimeGatewayRequestScope(
        { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
        () =>
          spawnSubagentDirect(
            {
              task: "acceptance rekey",
              collect: true,
              context: "isolated",
              lightContext: true,
              groupId,
            },
            { agentSessionKey: parentSessionKey, requesterRunId: parentRunId },
          ),
      );
      expect(spawned.status).toBe("accepted");
      await dispatchEntered.promise;
      const entry = subagentRuns.get(spawned.runId!)!;
      const task = findTaskByRunId(spawned.runId!)!;
      expect(task).toMatchObject({ runId: spawned.runId, runtime: "subagent", status: "queued" });
      const child = loadSessionEntry({ storePath, sessionKey: spawned.childSessionKey! })!;
      const identities = [spawned.childSessionKey!, child.sessionId];
      const work = await beginSessionWorkAdmission({
        scope: storePath,
        identities,
        assertAllowed: () => {},
      });
      const interrupted = createDeferred();
      lease = consumeSessionWorkAdmissionHandoff({
        scope: storePath,
        identities,
        handoffId: work.createHandoff(),
        onInterrupt: () => interrupted.resolve(),
      });
      const generation = entry.generation;
      const createdAt = entry.createdAt;
      const taskRunId = entry.taskRunId;
      const schedulerSlotId = entry.schedulerSlotId;
      cancellation = cancelTaskById({ cfg, taskId: task.taskId });
      await Promise.race([
        interrupted.promise,
        cancellation.then((result) => {
          throw new Error(`Cancellation returned before drain: ${JSON.stringify(result)}`);
        }),
      ]);
      response.resolve();
      await vi.waitFor(() => expect(subagentRuns.get("accepted-task-run")).toBe(entry));
      expect(entry).toMatchObject({ generation, createdAt, taskRunId, schedulerSlotId });
      lease?.release();
      const result = await cancellation;
      expect(result).toMatchObject({ found: true, cancelled: true });
      expect(getTaskById(task.taskId)).toMatchObject({ status: "cancelled" });
    } finally {
      response.resolve();
      lease?.release();
      await cancellation;
      admission.close();
      parent.cleanup();
    }
  });
});
