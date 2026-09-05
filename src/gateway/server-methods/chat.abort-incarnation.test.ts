/** Cancellation binds session incarnations and retains exact durable dispatch fences. */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { onSubagentRegistryPersisted } from "../../agents/subagents/registry/subagent-registry-state.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { isPathInside } from "../../infra/path-guards.js";
import * as sessionLifecycle from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabaseByPath,
  listOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";

const fixture = useChatAbortRegistryFixture();
const parentKey = "agent:main:main";

afterEach(() => {
  clearAgentRunContext("active");
  clearAgentRunContext("ended");
});

function abortParent() {
  const context = createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  const parent = createActiveRun(parentKey, { agentId: "main", owner: { connId: "owner" } });
  context.chatAbortControllers.set("parent", parent);
  return {
    context,
    parent,
    pending: invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey: parentKey, runId: "parent" },
      client: { connId: "owner", connect: { scopes: ["operator.read", "operator.write"] } },
    }),
  };
}

it.each([false, true].flatMap((reset) => [true, false].map((completed) => ({ reset, completed }))))(
  "exact parent cancellation fences late descendants across an idle ancestor reset=$reset completed=$completed",
  async ({ reset, completed }) => {
    const activeKey = "agent:main:subagent:active";
    const endedKey = "agent:main:subagent:ended";
    const grandchildKey = "agent:main:subagent:grandchild";
    let storePath = "";
    for (const [runId, childSessionKey] of [
      ["active", activeKey],
      ["ended", endedKey],
    ] as const) {
      storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: `${runId}-session`,
        lifecycleRevision: "original",
      });
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: parentKey,
        requesterAgentId: "main",
        requesterDisplayKey: parentKey,
        requesterTurnRunId: "parent",
        task: runId,
        cleanup: "keep",
        collect: true,
        expectsCompletionMessage: false,
      });
      // Running fixture turns need real ownership so cold lifecycle setup cannot
      // let the registry sweeper mistake them for lost executions.
      registerAgentRunContext(runId, {
        sessionKey: childSessionKey,
        sessionId: `${runId}-session`,
      });
    }
    const ended = subagentRuns.get("ended")!;
    if (completed) {
      emitAgentEvent({
        runId: "ended",
        sessionKey: endedKey,
        stream: "lifecycle",
        data: { phase: "end", endedAt: Date.now() },
      });
      await vi.waitFor(() => expect(ended.execution.status).toBe("terminal"));
      clearAgentRunContext("ended");
      await settleSubagentRegistryPersistenceWork();
      expect(ended.endedReason).toBe("subagent-complete");
    }
    expect(subagentRuns.get("ended")).toBe(ended);
    const entered = createDeferred();
    const resume = createDeferred();
    const admission = await sessionLifecycle.beginSessionWorkAdmission({
      scope: storePath,
      identities: [activeKey, "active-session"],
      assertAllowed: () => {},
      onInterrupt: () => admission.release(),
    });
    const interruptAdmissions = sessionLifecycle.interruptSessionWorkAdmissions;
    const drain = vi
      .spyOn(sessionLifecycle, "interruptSessionWorkAdmissions")
      .mockImplementation(async (params) => {
        const released = await interruptAdmissions(params);
        if (params.scope === storePath && Array.from(params.identities).includes(activeKey)) {
          expect(released).toBe(true);
          // Keep the captured kill scope pending after the real drain. A cold
          // sibling reset must not consume the active admission's deadline.
          entered.resolve();
          await resume.promise;
        }
        return released;
      });
    const abort = abortParent();
    const dispatch = vi.fn(async () => {});
    const interrupted = vi.fn();
    let newAdmission:
      | Awaited<ReturnType<typeof sessionLifecycle.beginSessionWorkAdmission>>
      | undefined;
    try {
      await Promise.race([
        entered.promise,
        abort.pending.then(() => {
          throw new Error("abort missed admission drain");
        }),
      ]);
      expect(abort.parent.controller.signal.aborted).toBe(true);
      expect(sessionLifecycle.isSessionWorkAdmissionActive(storePath, [activeKey])).toBe(false);
      if (reset) {
        const respond = vi.fn();
        await sessionMutationHandlers["sessions.reset"]!({
          params: { key: endedKey },
          context: abort.context as never,
          respond,
          client: { connect: { scopes: ["operator.admin"] } } as never,
          req: { type: "req", id: "reset", method: "sessions.reset" } as never,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ ok: true }),
          undefined,
        );
      }
      const session = loadExactSessionEntryReadOnly({ storePath, sessionKey: endedKey })?.entry;
      expect(session?.sessionId).toBe("ended-session");
      expect(session?.lifecycleRevision === "original").toBe(!reset);
      expect(subagentRuns.get("ended")).toBe(ended);
      if (!completed) {
        newAdmission = await sessionLifecycle.beginSessionWorkAdmission({
          scope: storePath,
          identities: [endedKey, "ended-session"],
          assertAllowed: () => {},
          onInterrupt: () => {
            interrupted();
            newAdmission?.release();
          },
        });
      }
      registerSubagentRun({
        runId: "grandchild",
        childSessionKey: grandchildKey,
        requesterSessionKey: endedKey,
        requesterAgentId: "main",
        requesterDisplayKey: endedKey,
        requesterTurnRunId: "new-turn",
        task: "grandchild",
        cleanup: "keep",
        collect: true,
        queued: true,
        expectsCompletionMessage: false,
      });
      enqueueSwarmRun({
        groupId: "late",
        runId: "grandchild",
        maxConcurrent: 1,
        activeRunIds: ["capacity"],
        start: dispatch,
        onStartFailure: () => true,
      });
      resume.resolve();
      const respond = await abort.pending;
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ aborted: true }));
      expect(subagentRuns.get("active")?.endedReason).toBe("subagent-killed");
      expect(subagentRuns.get("grandchild")?.execution.status).toBe(reset ? "queued" : "terminal");
      if (!completed) {
        expect(interrupted).toHaveBeenCalledTimes(reset ? 0 : 1);
        expect(ended.execution.status).toBe(reset ? "running" : "terminal");
      }
      releaseSwarmRun("capacity");
      if (reset) {
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      } else {
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
      }
    } finally {
      newAdmission?.release();
      resume.resolve();
      admission.release();
      try {
        await abort.pending;
      } finally {
        drain.mockRestore();
        releaseSwarmRun("capacity");
        releaseSwarmRun("grandchild");
      }
    }
  },
);

it.each(["child", "ancestor"])(
  "retained durable intent prevents queued dispatch when the %s identity read fails",
  async (faultOwner) => {
    const childAgent = faultOwner === "ancestor" ? "worker" : "broken";
    const badKey = `agent:${childAgent}:subagent:bad`;
    const healthyKey = "agent:main:subagent:healthy";
    const ancestorKey = "agent:broken:subagent:ancestor";
    if (faultOwner === "ancestor") {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "broken",
        sessionKey: ancestorKey,
        defaultSessionId: "ancestor-session",
      });
      registerSubagentRun({
        runId: "ancestor",
        childSessionKey: ancestorKey,
        requesterSessionKey: parentKey,
        requesterAgentId: "main",
        requesterDisplayKey: parentKey,
        requesterTurnRunId: "parent",
        task: "ancestor",
        cleanup: "keep",
        collect: true,
        queued: true,
        expectsCompletionMessage: false,
      });
    }
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: childAgent,
      sessionKey: badKey,
      defaultSessionId: "bad-session",
    });
    for (const [runId, childSessionKey] of [
      ["bad", badKey],
      ["healthy", healthyKey],
    ] as const) {
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: faultOwner === "ancestor" && runId === "bad" ? ancestorKey : parentKey,
        requesterAgentId: faultOwner === "ancestor" && runId === "bad" ? "broken" : "main",
        requesterDisplayKey: parentKey,
        requesterTurnRunId: "parent",
        task: runId,
        cleanup: "keep",
        collect: true,
        queued: true,
        expectsCompletionMessage: false,
      });
    }
    const database = listOpenClawAgentDatabasesForTest().find(
      (item) => item.agentId === "broken" && isPathInside(fixture.stateDir, item.path),
    )!;
    expect(database).toBeDefined();
    let original: Buffer | undefined;
    let fault: unknown;
    const unsubscribe = onSubagentRegistryPersisted(() => {
      if (original || !subagentRuns.get("bad")?.killIntent) {
        return;
      }
      try {
        expect(loadSubagentRegistryFromSqlite().get("bad")?.killIntent).toBeDefined();
        expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        original = readFileSync(database.path);
        writeFileSync(database.path, "not a SQLite database");
      } catch (error) {
        fault = error;
      }
    });
    const badDispatch = vi.fn(async () => {});
    const healthyDispatch = vi.fn(async () => {});
    const survivorDispatch = vi.fn(async () => {});
    for (const [runId, start] of [
      ["bad", badDispatch],
      ["healthy", healthyDispatch],
      ["survivor", survivorDispatch],
    ] as const) {
      enqueueSwarmRun({
        groupId: "read-failure",
        runId,
        maxConcurrent: 1,
        activeRunIds: [],
        start,
        onStartFailure: () => true,
      });
    }
    try {
      const { parent, pending } = abortParent();
      const respond = await pending;
      expect(fault).toBeUndefined();
      expect(original).toBeDefined();
      expect(parent.controller.signal.aborted).toBe(true);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("descendant cancellation was incomplete"),
        }),
      );
      expect(() =>
        loadExactSessionEntryReadOnly({
          sessionKey: faultOwner === "ancestor" ? ancestorKey : badKey,
        }),
      ).toThrow();
      if (faultOwner === "ancestor") {
        expect(
          loadExactSessionEntryReadOnly({ storePath, sessionKey: badKey })?.entry.sessionId,
        ).toBe("bad-session");
      }
      expect(loadSubagentRegistryFromSqlite().get("bad")?.killIntent).toMatchObject({
        reason: "killed",
      });
      expect(subagentRuns.get("healthy")?.endedReason).toBe("subagent-killed");
      expect(healthyDispatch).not.toHaveBeenCalled();
      expect(
        badDispatch,
        "retained durable intent must withdraw its exact never-started reservation",
      ).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(survivorDispatch).toHaveBeenCalledOnce());
    } finally {
      unsubscribe();
      if (original) {
        writeFileSync(database.path, original);
      }
      releaseSwarmRun("bad");
      releaseSwarmRun("survivor");
    }
  },
);
