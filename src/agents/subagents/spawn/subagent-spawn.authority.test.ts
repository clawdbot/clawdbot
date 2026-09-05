/** Registered native children retain their own lifecycle after spawn handoff. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import { invokeChatAbortHandler } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
} from "../../../sessions/session-lifecycle-admission.js";
import { cancelTaskById, findTaskByRunId, getTaskById } from "../../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
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
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { installSpawnAuthorityFixture } from "./subagent-spawn.authority.test-support.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const fixture = installSpawnAuthorityFixture();
const { parentSessionKey, parentRunId, groupId, createBoundParent } = fixture;

describe("pending spawn invocation authority", () => {
  it.each(["sibling", "nested sibling"] as const)(
    "stops a fresh spawn below a completed persistent sibling while a %s drain remains pending",
    async (slowBranch) => {
      const originalConfig = getRuntimeConfig();
      await writeFile(
        path.join(fixture.stateDir, "openclaw.json"),
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
          stateDir: fixture.stateDir,
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
      // The lifecycle end settles through root-work admission plus SQLite persistence;
      // on a two-CPU hosted runner that chain exceeds vi.waitFor's 1s default.
      await vi.waitFor(() => expect(findTaskByRunId("b")?.status).toBe("succeeded"), {
        timeout: 15_000,
      });
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
