/** Exact recovered-parent Stop owns its descendants, not other turns or queues. */
import { expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  clearEmbeddedAgentRunAbortabilityForRunId,
  isEmbeddedAgentRunAbortableForRunId,
  resolveActiveEmbeddedRunOwnerByRunId,
  retainEmbeddedAgentRunAbortabilityForRunId,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import {
  writeSubagentSessionEntry,
  settleSubagentRegistryPersistenceWork,
} from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  enqueueSwarmRun,
  releaseSwarmRun,
  isSwarmRunActive,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { registerChatAbortController } from "../chat-abort.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { createChatAbortContext } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

const fixture = useChatAbortRegistryFixture();
const parentKey = "agent:main:direct:embedded-parent";
const parentId = "embedded-parent-session";
const childKey = (id: string) => `agent:main:subagent:${id}`;

async function stopParent(runId = "parent") {
  const context = createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  expect(context.chatAbortControllers.size).toBe(0);
  const respond = vi.fn();
  await sessionAbortHandlers["sessions.abort"]!({
    req: { type: "req", id: "stop", method: "sessions.abort" },
    params: { key: parentKey, runId },
    respond,
    context: context as never,
    client: {
      connId: "operator",
      connect: { scopes: ["operator.read", "operator.write"] },
    } as never,
    isWebchatConnect: () => false,
  });
  return respond;
}

async function seedChild(id: string, turn: string, queued = true, requester = parentKey) {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childKey(id),
    defaultSessionId: id,
  });
  registerSubagentRun({
    runId: id,
    childSessionKey: childKey(id),
    requesterSessionKey: requester,
    requesterAgentId: "main",
    requesterDisplayKey: requester,
    requesterTurnRunId: turn,
    task: id,
    collect: true,
    queued,
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
}

it("exact embedded Stop cancels running and queued collectors without dispatching the queued sibling", async () => {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: parentKey,
    defaultSessionId: parentId,
  });
  await seedChild("running", "parent", false);
  await seedChild("queued", "parent");
  await seedChild("other-turn", "other-parent");
  await seedChild("other-session", "parent", true, "agent:main:direct:other");
  const queuedDispatch = vi.fn(async () => {});
  const otherTurnDispatch = vi.fn(async () => {});
  const otherSessionDispatch = vi.fn(async () => {});
  for (const [runId, start] of [
    ["queued", queuedDispatch],
    ["other-turn", otherTurnDispatch],
  ] as const) {
    enqueueSwarmRun({
      groupId: "selected",
      runId,
      start,
      activeRunIds: ["running"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
  }
  enqueueSwarmRun({
    groupId: "unrelated",
    runId: "other-session",
    start: otherSessionDispatch,
    activeRunIds: ["unrelated-capacity"],
    maxConcurrent: 1,
    onStartFailure: () => true,
  });
  const parentAbort = vi.fn(() => {
    emitAgentEvent({
      runId: "parent",
      sessionKey: parentKey,
      sessionId: parentId,
      stream: "lifecycle",
      data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
    });
  });
  const childAbort = vi.fn(() => {
    // The real lifecycle listener/cleanup releases the active collector slot.
    emitAgentEvent({
      runId: "running",
      sessionKey: childKey("running"),
      sessionId: "running",
      stream: "lifecycle",
      data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
    });
  });
  const parent = createEmbeddedRunHandle({ runId: "parent", abort: parentAbort });
  const child = createEmbeddedRunHandle({ runId: "running", abort: childAbort });
  setActiveEmbeddedRun(parentId, parent, parentKey);
  setActiveEmbeddedRun("running", child, childKey("running"));
  try {
    const respond = await stopParent();
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      abortedRunId: "parent",
      status: "aborted",
    });
    expect(parentAbort).toHaveBeenCalledOnce();
    await settleSubagentRegistryPersistenceWork();
    for (const id of ["running", "queued"]) {
      expect(getSubagentRunByChildSessionKey(childKey(id)), id).toMatchObject({
        endedReason: "subagent-killed",
      });
    }
    expect(childAbort).toHaveBeenCalledOnce();
    expect(queuedDispatch).not.toHaveBeenCalled();
    expect(isSwarmRunActive("running")).toBe(false);
    await vi.waitFor(() => expect(otherTurnDispatch).toHaveBeenCalledOnce());
    for (const id of ["other-turn", "other-session"]) {
      expect(getSubagentRunByChildSessionKey(childKey(id))?.endedReason).toBeUndefined();
    }
    expect(otherSessionDispatch).not.toHaveBeenCalled();
    expect(releaseSwarmRun("unrelated-capacity")).toBe(true);
    await vi.waitFor(() => expect(otherSessionDispatch).toHaveBeenCalledOnce());
  } finally {
    clearActiveEmbeddedRun(parentId, parent, parentKey);
    clearActiveEmbeddedRun("running", child, childKey("running"));
  }
});

it.each(["missing", "replaced", "finalizing", "throwing", "unreadable child"])(
  "%s embedded Stop leaves descendants eligible",
  async (state) => {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: parentKey,
      defaultSessionId: parentId,
    });
    await seedChild("queued", "parent");
    const dispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "declined",
      runId: "queued",
      start: dispatch,
      activeRunIds: ["capacity"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
    const abort = vi.fn(() => {
      throw new Error("parent refused Stop");
    });
    const parent = createEmbeddedRunHandle({
      runId: "parent",
      abort,
      isAbortable: state !== "finalizing" && state !== "unreadable child",
    });
    const replacementAbort = vi.fn();
    const replacement = createEmbeddedRunHandle({ runId: "replacement", abort: replacementAbort });
    if (state !== "missing") {
      setActiveEmbeddedRun(parentId, parent, parentKey);
    }
    if (state === "replaced") {
      setActiveEmbeddedRun(parentId, replacement, parentKey);
    }
    const exactRead = sessions.loadExactSessionEntryReadOnly;
    const failedRead = vi.fn();
    const reader = vi
      .spyOn(sessions, "loadExactSessionEntryReadOnly")
      .mockImplementation((scope) => {
        if (state === "unreadable child" && scope.sessionKey === childKey("queued")) {
          failedRead();
          throw new Error("preparatory child read failed");
        }
        return exactRead(scope);
      });
    try {
      const respond = await stopParent();
      if (state === "unreadable child") {
        expect(failedRead).toHaveBeenCalled();
      }
      expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        { ok: true, abortedRunId: null, status: "no-active-run" },
      ]);
      expect(abort).toHaveBeenCalledTimes(state === "throwing" ? 1 : 0);
      expect(replacementAbort).not.toHaveBeenCalled();
      expect(getSubagentRunByChildSessionKey(childKey("queued"))).toMatchObject({
        execution: { status: "queued" },
      });
      expect(getSubagentRunByChildSessionKey(childKey("queued"))?.killIntent).toBeUndefined();
      expect(dispatch).not.toHaveBeenCalled();
      expect(releaseSwarmRun("capacity")).toBe(true);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    } finally {
      reader.mockRestore();
      clearActiveEmbeddedRun(parentId, state === "replaced" ? replacement : parent, parentKey);
    }
  },
);

it.each([
  { method: "chat.abort", finalizing: true },
  { method: "sessions.abort", finalizing: true },
  { method: "chat.abort", finalizing: false },
  { method: "sessions.abort", finalizing: false },
] as const)(
  "$method controller-backed Stop respects parent acceptance (finalizing=$finalizing)",
  async ({ method, finalizing }) => {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: parentKey,
      defaultSessionId: parentId,
    });
    await seedChild("running", "parent", false);
    await seedChild("queued", "parent");
    const dispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "controller-backed",
      runId: "queued",
      start: dispatch,
      activeRunIds: ["running"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
    const context = createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
    });
    // Match native admission's retained abortability binding, including its
    // controller-removal cleanup; an absent native handle alone permits abort.
    expect(isEmbeddedAgentRunAbortableForRunId("parent")).toBe(true);
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: "parent",
      sessionId: parentId,
      sessionKey: parentKey,
      agentId: "main",
      ownerConnId: "operator",
      kind: "agent",
      timeoutMs: 30_000,
      isAbortable: () => isEmbeddedAgentRunAbortableForRunId("parent"),
      onRemoved: () => clearEmbeddedAgentRunAbortabilityForRunId("parent"),
    });
    expect(registration.registered).toBe(true);
    retainEmbeddedAgentRunAbortabilityForRunId("parent");
    const parentAbort = vi.fn();
    const parentState = { runId: "parent", abort: parentAbort, isAbortable: true };
    const parent = createEmbeddedRunHandle(parentState);
    const childAbort = vi.fn(() => {
      emitAgentEvent({
        runId: "running",
        sessionKey: childKey("running"),
        sessionId: "running",
        stream: "lifecycle",
        data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
      });
    });
    const child = createEmbeddedRunHandle({ runId: "running", abort: childAbort });
    registration.controller.signal.addEventListener("abort", parentAbort);
    setActiveEmbeddedRun(parentId, parent, parentKey);
    setActiveEmbeddedRun("running", child, childKey("running"));
    expect(registration.markExecutionStarted()).toBe(true);
    try {
      if (finalizing) {
        parentState.isAbortable = false;
        clearActiveEmbeddedRun(parentId, parent, parentKey);
        expect(resolveActiveEmbeddedRunOwnerByRunId("parent")).toBeUndefined();
      } else {
        expect(resolveActiveEmbeddedRunOwnerByRunId("parent")).toBeDefined();
      }
      expect(isEmbeddedAgentRunAbortableForRunId("parent")).toBe(!finalizing);
      expect(context.chatAbortControllers.get("parent")).toBe(registration.entry);
      const respond = vi.fn();
      const handler =
        method === "chat.abort" ? handleChatAbortRequest : sessionAbortHandlers[method]!;
      await handler({
        req: { type: "req", id: "stop", method },
        params: {
          ...(method === "chat.abort" ? { sessionKey: parentKey } : { key: parentKey }),
          runId: "parent",
        },
        respond,
        context: context as never,
        client: {
          connId: "operator",
          connect: { scopes: ["operator.read", "operator.write"] },
        } as never,
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        method === "chat.abort"
          ? { ok: true, aborted: !finalizing, runIds: finalizing ? [] : ["parent"] }
          : {
              ok: true,
              abortedRunId: finalizing ? null : "parent",
              status: finalizing ? "no-active-run" : "aborted",
            },
      ]);
      expect(registration.controller.signal.aborted).toBe(!finalizing);
      expect(parentAbort).toHaveBeenCalledTimes(finalizing ? 0 : 1);
      await settleSubagentRegistryPersistenceWork();
      expect.soft(childAbort).toHaveBeenCalledTimes(finalizing ? 0 : 1);
      expect(dispatch).not.toHaveBeenCalled();
      for (const id of ["running", "queued"]) {
        const run = getSubagentRunByChildSessionKey(childKey(id));
        if (finalizing) {
          expect.soft(run?.endedReason, id).toBeUndefined();
          expect.soft(run?.killIntent, id).toBeUndefined();
        } else {
          expect(run, id).toMatchObject({ endedReason: "subagent-killed" });
        }
      }
      if (finalizing) {
        expect.soft(getSubagentRunByChildSessionKey(childKey("queued"))).toMatchObject({
          execution: { status: "queued" },
        });
        releaseSwarmRun("running");
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      } else {
        expect(isSwarmRunActive("running")).toBe(false);
      }
    } finally {
      registration.controller.signal.removeEventListener("abort", parentAbort);
      clearActiveEmbeddedRun(parentId, parent, parentKey);
      clearActiveEmbeddedRun("running", child, childKey("running"));
      registration.cleanup();
      expect(isEmbeddedAgentRunAbortableForRunId("parent")).toBe(true);
    }
  },
);
