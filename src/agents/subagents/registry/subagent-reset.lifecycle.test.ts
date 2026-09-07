/** Explicit reset retires child work without erasing its durable conversations. */
import { expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../../../auto-reply/reply/inbound-context.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  getFollowupQueueDepth,
} from "../../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../../auto-reply/reply/queue.test-helpers.js";
import { createReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { initSessionState } from "../../../auto-reply/reply/session.js";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionMutationHandlers } from "../../../gateway/server-methods/sessions-mutations.js";
import { registerInternalHook, unregisterInternalHook } from "../../../hooks/internal-hooks.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { killAllControlledSubagentRuns, killSessionSubagentRuns } from "./subagent-control-kill.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRegistryDeps } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-manager.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();
const parentKey = "agent:main:main";
const controllerKey = "agent:main:telegram:default:direct:123";
const childKey = (id: string) => "agent:main:subagent:" + id;

it.each(
  (["chat", "rpc"] as const).flatMap((boundary) =>
    [false, true].map((failed) => ({ boundary, failed })),
  ),
)(
  "$boundary reset accounts for requester/controller-owned children (failed=$failed)",
  async ({ boundary, failed }) => {
    vi.spyOn(subagentRegistryDeps, "runSubagentAnnounceFlow").mockResolvedValue("delivered");
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: parentKey,
      defaultSessionId: "reset-parent-session",
    });
    await appendTranscriptMessage(
      { storePath, sessionKey: parentKey, sessionId: "reset-parent-session" },
      { message: { role: "user", content: "conversation before reset" } },
    );
    const previousTranscript = await loadTranscriptEvents({
      storePath,
      sessionId: "reset-parent-session",
    });
    const childTranscripts = new Map<string, Awaited<ReturnType<typeof loadTranscriptEvents>>>();
    for (const [id, requesterSessionKey, controllerSessionKey] of [
      ["requester-child", parentKey, controllerKey],
      ["controller-child", "agent:main:other-requester", parentKey],
      ["queued-child", parentKey, controllerKey],
      ["unrelated-child", "agent:main:other-requester", controllerKey],
    ] as const) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childKey(id),
        defaultSessionId: id,
      });
      await appendTranscriptMessage(
        { storePath, sessionKey: childKey(id), sessionId: id },
        { message: { role: "user", content: "child conversation " + id } },
      );
      childTranscripts.set(id, await loadTranscriptEvents({ storePath, sessionId: id }));
      registerSubagentRun({
        runId: id,
        childSessionKey: childKey(id),
        requesterSessionKey,
        controllerSessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: requesterSessionKey,
        task: id,
        cleanup: "keep",
        expectsCompletionMessage: true,
      });
      const entry = subagentRuns.get(id)!;
      if (id === "queued-child") {
        entry.execution = { status: "queued" };
      } else {
        expect(markSubagentRunPausedAfterYield({ entry })).toBe(true);
      }
      persistSubagentRunsToDiskOrThrow(subagentRuns, [id]);
    }
    const previousRevision = loadSessionEntry({
      storePath,
      sessionKey: parentKey,
    })?.lifecycleRevision;
    if (failed) {
      fixture.persist.mockImplementation((runs, changedRunIds) => {
        if (runs.get("requester-child")?.killIntent) {
          throw new Error("termination persistence refused");
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      });
    }
    if (boundary === "chat") {
      const reset = initSessionState({
        ctx: finalizeInboundContext({
          Body: "/reset",
          RawBody: "/reset",
          CommandBody: "/reset",
          From: "telegram:123",
          To: "telegram:123",
          ChatType: "direct",
          SessionKey: parentKey,
          Provider: "telegram",
          Surface: "telegram",
        }),
        cfg: getRuntimeConfig(),
        commandAuthorized: true,
      });
      if (failed) {
        await expect(reset).rejects.toThrow("Reset did not complete");
      } else {
        expect((await reset).resetTriggered).toBe(true);
      }
    } else {
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.reset"]!({
        params: { key: parentKey },
        context: createChatAbortContext({
          getRuntimeConfig,
          getSessionEventSubscriberConnIds: () => new Set(),
        }) as never,
        respond,
        client: { connect: { scopes: ["operator.admin"] } } as never,
        req: { type: "req", id: "reset", method: "sessions.reset" },
        isWebchatConnect: () => false,
      });
      if (failed) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.stringContaining("Reset did not complete") }),
        );
      } else {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ ok: true }),
          undefined,
        );
      }
    }
    for (const id of ["requester-child", "controller-child", "queued-child"]) {
      expect
        .soft(findTaskByRunId(id)?.status, id)
        .toBe(failed && id === "requester-child" ? "running" : "cancelled");
      expect(loadSessionEntry({ storePath, sessionKey: childKey(id) })?.sessionId).toBe(id);
    }
    expect(findTaskByRunId("unrelated-child")?.status).toBe("running");
    for (const [sessionId, transcript] of childTranscripts) {
      expect(await loadTranscriptEvents({ storePath, sessionId })).toEqual(transcript);
    }
    if (failed) {
      expect(await loadTranscriptEvents({ storePath, sessionId: "reset-parent-session" })).toEqual(
        previousTranscript,
      );
      expect(loadSessionEntry({ storePath, sessionKey: parentKey })?.lifecycleRevision).toBe(
        previousRevision,
      );
    }
  },
);

it.each(["chat", "rpc", "chat-rebind"] as const)(
  "%s reset drains parent then child admissions before committing the boundary",
  async (boundary) => {
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: parentKey,
      defaultSessionId: "parent",
      lifecycleRevision: "before-reset",
    });
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childKey("draining"),
      defaultSessionId: "draining",
    });
    registerSubagentRun({
      runId: "draining",
      childSessionKey: childKey("draining"),
      requesterSessionKey: parentKey,
      controllerSessionKey: controllerKey,
      requesterAgentId: "main",
      requesterDisplayKey: parentKey,
      task: "draining",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const parentInterrupted = createDeferredCore();
    const childInterrupted = createDeferredCore();
    const interruptChild = vi.fn(() => childInterrupted.resolve());
    const parentAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [parentKey, "parent"],
      assertAllowed: () => {},
      onInterrupt: () => parentInterrupted.resolve(),
    });
    const childAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childKey("draining"), "draining"],
      assertAllowed: () => {},
      onInterrupt: interruptChild,
    });
    const respond = vi.fn();
    const replacementInterrupted = createDeferredCore();
    let replacementAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    const reset =
      boundary !== "rpc"
        ? initSessionState({
            ctx: finalizeInboundContext({
              Body: "/reset",
              RawBody: "/reset",
              CommandBody: "/reset",
              From: "telegram:123",
              To: "telegram:123",
              ChatType: "direct",
              SessionKey: parentKey,
              Provider: "telegram",
              Surface: "telegram",
            }),
            cfg: getRuntimeConfig(),
            commandAuthorized: true,
          })
        : sessionMutationHandlers["sessions.reset"]!({
            params: { key: parentKey },
            context: createChatAbortContext({
              getRuntimeConfig,
              getSessionEventSubscriberConnIds: () => new Set(),
            }) as never,
            respond,
            client: { connect: { scopes: ["operator.admin"] } } as never,
            req: { type: "req", id: "reset", method: "sessions.reset" },
            isWebchatConnect: () => false,
          });
    try {
      await parentInterrupted.promise;
      expect(interruptChild).not.toHaveBeenCalled();
      expect(subagentRuns.get("draining")?.killIntent).toBeUndefined();
      if (boundary === "chat-rebind") {
        await patchSessionEntryCore({ storePath, sessionKey: parentKey }, (entry) => ({
          ...entry,
          sessionId: "replacement-parent",
        }));
        replacementAdmission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: ["replacement-parent"],
          assertAllowed: () => {},
          onInterrupt: () => replacementInterrupted.resolve(),
        });
      }
      parentAdmission.release();
      if (replacementAdmission) {
        expect(
          await Promise.race([
            replacementInterrupted.promise.then(() => "parent"),
            childInterrupted.promise.then(() => "child"),
          ]),
        ).toBe("parent");
        replacementAdmission.release();
      }
      await childInterrupted.promise;
      expect(loadSessionEntry({ storePath, sessionKey: parentKey })?.lifecycleRevision).toBe(
        "before-reset",
      );
      // A child finalizer writes through the same store lane before releasing.
      // Running cleanup inside that lane would deadlock this real write.
      await patchSessionEntryCore({ storePath, sessionKey: childKey("draining") }, (entry) => ({
        ...entry,
        displayName: "finalized before reset",
      }));
      childAdmission.release();
      await reset;
      if (boundary === "rpc") {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ ok: true }),
          undefined,
        );
      }
      expect(findTaskByRunId("draining")?.status).toBe("cancelled");
      expect(loadSessionEntry({ storePath, sessionKey: parentKey })?.lifecycleRevision).not.toBe(
        "before-reset",
      );
      expect(loadSessionEntry({ storePath, sessionKey: childKey("draining") })).toMatchObject({
        sessionId: "draining",
        displayName: "finalized before reset",
      });
    } finally {
      replacementAdmission?.release();
      parentAdmission.release();
      childAdmission.release();
      await reset;
    }
  },
);

it("lifecycle requester cleanup respects agent ownership without granting ordinary controller authority", async () => {
  const cfg = getRuntimeConfig();
  for (const agentId of ["main", "work"]) {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId,
      sessionKey: "agent:" + agentId + ":subagent:global-child",
      defaultSessionId: agentId,
    });
    registerSubagentRun({
      runId: agentId,
      childSessionKey: "agent:" + agentId + ":subagent:global-child",
      requesterSessionKey: "global",
      controllerSessionKey: "agent:" + agentId + ":other-controller",
      requesterAgentId: agentId,
      requesterDisplayKey: "global",
      task: agentId,
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const entry = subagentRuns.get(agentId)!;
    expect(markSubagentRunPausedAfterYield({ entry })).toBe(true);
    persistSubagentRunsToDiskOrThrow(subagentRuns, [agentId]);
  }
  const ordinary = await killAllControlledSubagentRuns({
    cfg,
    controller: {
      controllerSessionKey: "global",
      controllerAgentId: "main",
      callerSessionKey: "global",
      callerIsSubagent: false,
      controlScope: "children",
    },
    runs: [...subagentRuns.values()],
  });
  expect(ordinary).toMatchObject({ status: "ok", killed: 0 });
  expect(findTaskByRunId("main")?.status).toBe("running");
  expect(
    await killSessionSubagentRuns({ cfg, sessionKey: "global", agentId: "main" }),
  ).toMatchObject({
    status: "ok",
    killed: 1,
  });
  expect(findTaskByRunId("main")?.status).toBe("cancelled");
  expect(findTaskByRunId("work")?.status).toBe("running");
});

it.each(["sessionId", "lifecycleRevision"] as const)(
  "RPC reset preserves runtime and children of a replacement parent after a hook changes %s",
  async (field) => {
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: parentKey,
      defaultSessionId: "parent",
      lifecycleRevision: "original",
    });
    const cancel = vi.fn();
    let replacementReply: ReturnType<typeof createReplyOperation> | undefined;
    const replaceParent = async () => {
      await patchSessionEntryCore({ storePath, sessionKey: parentKey }, (entry) => ({
        ...entry,
        [field]: "replacement",
      }));
      replacementReply = createReplyOperation({
        sessionKey: parentKey,
        sessionId: field === "sessionId" ? "replacement" : "parent",
        resetTriggered: false,
      });
      replacementReply.attachBackend({ kind: "embedded", cancel, isStreaming: () => false });
      replacementReply.setPhase("running");
      enqueueFollowupRun(
        parentKey,
        createQueueTestRun({ prompt: "replacement follow-up" }),
        { mode: "followup" },
        "none",
        undefined,
        false,
      );
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childKey("replacement-child"),
        defaultSessionId: "replacement-child",
      });
      registerSubagentRun({
        runId: "replacement-child",
        childSessionKey: childKey("replacement-child"),
        requesterSessionKey: "agent:main:other-requester",
        controllerSessionKey: parentKey,
        requesterAgentId: "main",
        requesterDisplayKey: "other requester",
        task: "replacement work",
        cleanup: "keep",
        expectsCompletionMessage: true,
      });
      const entry = subagentRuns.get("replacement-child")!;
      expect(markSubagentRunPausedAfterYield({ entry })).toBe(true);
      persistSubagentRunsToDiskOrThrow(subagentRuns, [entry.runId]);
    };
    registerInternalHook("command:reset", replaceParent);
    const respond = vi.fn();
    try {
      await sessionMutationHandlers["sessions.reset"]!({
        params: { key: parentKey },
        context: createChatAbortContext({
          getRuntimeConfig,
          getSessionEventSubscriberConnIds: () => new Set(),
        }) as never,
        respond,
        client: { connect: { scopes: ["operator.admin"] } } as never,
        req: { type: "req", id: "reset", method: "sessions.reset" },
        isWebchatConnect: () => false,
      });
      expect(findTaskByRunId("replacement-child")?.status).toBe("running");
      expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(loadSessionEntry({ storePath, sessionKey: parentKey })?.[field]).toBe("replacement");
      expect.soft(cancel).not.toHaveBeenCalled();
      expect(getFollowupQueueDepth(parentKey)).toBe(1);
    } finally {
      replacementReply?.complete();
      clearSessionQueues([parentKey]);
      unregisterInternalHook("command:reset", replaceParent);
    }
  },
);
