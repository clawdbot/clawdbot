/** Pending native spawn must transfer only live invocation authority to the child owner. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import {
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionDeleteHandlers } from "../../../gateway/server-methods/sessions-delete.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
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
import { finalizeAgentToolAvailability } from "../../agent-tool-availability.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { createAgentHarnessHostCapabilities } from "../../harness/host-capability.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { registerSubagentRun } from "../registry/subagent-registry.js";
import {
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

const parentSessionKey = "agent:main:main";
const parentRunId = "pending-spawn-parent";
const groupId = "pending-spawn";
const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
let stateDir = "";

beforeEach(async () => {
  stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-authority-")));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  await writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      logging: { audit: { enabled: false } },
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { defaults: { workspace: stateDir }, entries: { main: { workspace: stateDir } } },
    }),
  );
  clearConfigCache();
  clearRuntimeConfigSnapshot();
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
  await rm(stateDir, { recursive: true, force: true });
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
  expect(admitted.executionIdentityToken).toBeUndefined();

  return { cfg, storePath, context, admission, parent, admitted, authority };
}

describe("pending spawn invocation authority", () => {
  it.each(["sibling", "nested sibling"] as const)(
    "stops a fresh spawn below a completed persistent sibling while a %s drain remains pending",
    async (slowBranch) => {
      const originalConfig = getRuntimeConfig();
      await writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          ...originalConfig,
          agents: {
            ...originalConfig.agents,
            defaults: {
              ...originalConfig.agents?.defaults,
              subagents: { maxSpawnDepth: 2 },
            },
          },
        }),
      );
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      const { cfg, storePath, context, admission, parent } = await createBoundParent();
      const sessionLifecycle = await import("../../../sessions/session-lifecycle-admission.js");
      const key = (id: string) => `agent:main:subagent:${id}`;
      const ids = slowBranch === "sibling" ? ["a", "b"] : ["a", "b", "d"];
      const slowId = slowBranch === "sibling" ? "a" : "d";
      for (const id of ids) {
        await writeSubagentSessionEntry({
          stateDir,
          agentId: "main",
          sessionKey: key(id),
          defaultSessionId: `${id}-session`,
          lifecycleRevision: "original",
        });
        registerSubagentRun({
          runId: id,
          childSessionKey: key(id),
          controllerSessionKey: id === "d" ? key("a") : parentSessionKey,
          requesterSessionKey: id === "d" ? key("a") : parentSessionKey,
          requesterAgentId: "main",
          requesterDisplayKey: parentSessionKey,
          requesterTurnRunId: id === "d" ? "a" : parentRunId,
          task: id,
          cleanup: "keep",
          collect: id !== "b",
          spawnMode: id === "b" ? "session" : "run",
          expectsCompletionMessage: false,
        });
        registerAgentRunContext(id, { sessionKey: key(id), sessionId: `${id}-session` });
      }
      const completedB = subagentRuns.get("b")!;
      const completedGeneration = completedB.generation;
      emitAgentEvent({
        runId: "b",
        sessionKey: key("b"),
        stream: "lifecycle",
        data: { phase: "end", endedAt: Date.now() },
      });
      await vi.waitFor(() => expect(findTaskByRunId("b")?.status).toBe("succeeded"));
      clearAgentRunContext("b");
      await settleSubagentRegistryPersistenceWork();
      expect(completedB).toMatchObject({
        generation: completedGeneration,
        spawnMode: "session",
        execution: { status: "terminal" },
        endedReason: "subagent-complete",
      });
      expect(
        Array.from(subagentRuns.values()).some((entry) => entry.controllerSessionKey === key("b")),
      ).toBe(false);
      const entered = createDeferred();
      const resume = createDeferred();
      const slow = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [key(slowId), `${slowId}-session`],
        assertAllowed: () => {},
        onInterrupt: () => slow.release(),
      });
      const interrupt = sessionLifecycle.interruptSessionWorkAdmissions;
      const drain = vi
        .spyOn(sessionLifecycle, "interruptSessionWorkAdmissions")
        .mockImplementation(async (params) => {
          const released = await interrupt(params);
          if (params.scope === storePath && Array.from(params.identities).includes(key(slowId))) {
            expect(released).toBe(true);
            entered.resolve();
            await resume.promise;
          }
          return released;
        });
      const cancellation = invokeChatAbortHandler({
        handler: handleChatAbortRequest,
        context,
        request: { sessionKey: parentSessionKey, runId: parentRunId },
        client: { connId: "owner-connection", connect: { scopes: ["operator.write"] } },
      });
      const freshAdmission = prepareAgentRunAdmission({
        cfg,
        operationalRunInstance: createOperationalRunInstanceRef("fresh-b"),
        facts: {
          runId: "fresh-b",
          agentId: "main",
          ingress: { kind: "system", boundary: "spawn-authority-test", state: "present" },
        },
      });
      let fresh: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      const freshInterrupted = vi.fn();
      const dispatch = vi.fn();
      try {
        // Completed B visits its empty child list synchronously while the other
        // branch enters its asynchronous mutation/drain, before this barrier opens.
        await entered.promise;
        expect(subagentRuns.get("b")).toBe(completedB);
        expect(completedB.generation).toBe(completedGeneration);
        expect(findTaskByRunId("b")?.status).toBe("succeeded");
        const original = loadSessionEntry({ storePath, sessionKey: key("b") });
        expect(original).toMatchObject({ sessionId: "b-session", lifecycleRevision: "original" });
        const admitted = await freshAdmission.admit("embedded");
        bindGatewayContextResolver(admitted, () => context as unknown as GatewayRequestContext);
        fresh = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [key("b"), "b-session"],
          assertAllowed: () => {},
          onInterrupt: () => {
            freshInterrupted();
            fresh?.release();
          },
        });
        const blockerStarted = createDeferred();
        enqueueSwarmRun({
          groupId: JSON.stringify(["main", key("b"), groupId]),
          runId: "late-spawn-blocker",
          maxConcurrent: 1,
          activeRunIds: [],
          start: async () => blockerStarted.resolve(),
          onStartFailure: () => true,
        });
        await blockerStarted.promise;
        spawnTesting.setDepsForTest({
          resolveContextEngine: async () => new LegacyContextEngine(),
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
          agentSessionKey: key("b"),
          requesterRunId: "fresh-b",
          requesterTurnRunId: "fresh-b",
        });
        const [tool] = finalizeAgentTools({
          tools: [
            source,
            createAgentsWaitTool({ config: cfg, agentSessionKey: key("b"), agentId: "main" }),
          ],
          hookContext: { config: cfg, agentId: "main", sessionKey: key("b"), runId: "fresh-b" },
          abortSignal: new AbortController().signal,
        });
        const spawned = await fresh.run(() =>
          withPluginRuntimeGatewayRequestScope(
            { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
            () =>
              withGatewayToolCallerIdentity(
                createAdmittedGatewayToolCallerIdentity({
                  admittedRunContext: admitted,
                  agentId: "main",
                  sessionKey: key("b"),
                }),
                () =>
                  tool!.execute!("late-spawn", {
                    task: "late child",
                    collect: true,
                    context: "isolated",
                    groupId,
                  }),
              ),
          ),
        );
        expect(spawned).toMatchObject({ details: { status: "accepted" } });
        const { runId } = spawned.details as { runId: string };
        expect(subagentRuns.get(runId)).toMatchObject({
          controllerSessionKey: key("b"),
          requesterTurnRunId: "fresh-b",
          execution: { status: "queued" },
        });
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeDefined();
        resume.resolve();
        expect(await cancellation).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ aborted: true }),
        );
        expect(findTaskByRunId(runId)?.status).toBe("cancelled");
        expect(subagentRuns.get("b")).toBe(completedB);
        expect(completedB.generation).toBe(completedGeneration);
        expect(findTaskByRunId("b")?.status).toBe("succeeded");
        expect(loadSessionEntry({ storePath, sessionKey: key("b") })).toMatchObject({
          sessionId: "b-session",
          lifecycleRevision: "original",
        });
        expect(freshInterrupted).not.toHaveBeenCalled();
        expect(fresh.isActive()).toBe(true);
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeDefined();
        releaseSwarmRun("late-spawn-blocker");
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        slow.release();
        fresh?.release();
        try {
          await cancellation;
        } finally {
          drain.mockRestore();
          releaseSwarmRun("late-spawn-blocker");
          freshAdmission.close();
          admission.close();
          parent.cleanup();
          ids.forEach((id) => clearAgentRunContext(id));
        }
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
    const observed: AnyAgentTool = copyAgentToolMetadata(source, {
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
    });
    const wait = createAgentsWaitTool({
      config: cfg,
      agentSessionKey: parentSessionKey,
      agentId: "main",
    });
    const tools = [observed, wait];
    const [tool] = host
      ? finalizeAgentToolAvailability(host.capabilities.bindToolSurface(tools))
      : finalizeAgentTools({
          tools,
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
      // A rejected spawn never enters preparation; report it instead of waiting for the test timeout.
      const childSessionKey = await Promise.race([
        entered.promise,
        wrapped.then(() => {
          throw new Error("Spawn settled before entering context preparation");
        }),
      ]);
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
        groupId: JSON.stringify(["main", parentSessionKey, groupId]),
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
        groupId: JSON.stringify(["main", parentSessionKey, groupId]),
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
      const observed: AnyAgentTool = copyAgentToolMetadata(source, {
        ...source,
        execute: (...args) => {
          const pending = source.execute!(...args);
          forwarded = pending.then(
            (value) => value,
            (error: unknown) => error,
          );
          return pending;
        },
      });
      const wait = createAgentsWaitTool({
        config: cfg,
        agentSessionKey: parentSessionKey,
        agentId: "main",
      });
      const [tool] = finalizeAgentTools({
        tools: [observed, wait],
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
