/** Real handler and registry proof for session-wide descendant cancellation ownership. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import * as transcriptPersistence from "./chat-transcript-persistence.js";
import { requireLastRespondCall } from "./chat.abort-authorization.test-helpers.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadSessionEntry: () => ({ entry: { sessionId: "main-session" } }),
}));

describe("descendant cascade ownership", () => {
  beforeEach(() => {
    subagentRegistryTesting.setDepsForTest({
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {},
    });
  });
  afterEach(async () => {
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest();
    swarmSchedulerTesting.reset();
    vi.restoreAllMocks();
  });

  it.each([
    "owned",
    "orphan",
    "all foreign",
    "all foreign hidden",
    "late descendant",
    "mixed active",
    "mixed queued",
    "mixed pending agent",
    "mixed pending chat",
    "hidden",
    "preserved",
    "hidden pending",
    "unrepresented worker",
    "represented worker",
    "hidden worker",
    "ordinary",
  ])("does not kill or inhibit excluded queued descendants: %s", async (kind) => {
    const sessionKey = kind.includes("worker") ? "global" : "agent:main:main";
    const cfg: OpenClawConfig = sessionKey === "global" ? { session: { scope: "global" } } : {};
    const childKey = "agent:main:subagent:cascade-ownership";
    const canCascade = ["owned", "orphan", "represented worker", "late descendant"].includes(kind);
    const hasOwnedActive = kind !== "orphan" && !kind.startsWith("all foreign");
    const mine = createActiveRun(sessionKey, {
      sessionId: "main-session",
      agentId: "main",
      owner: { connId: "conn-owner", deviceId: "dev-owner" },
    });
    const foreign = createActiveRun(sessionKey, {
      sessionId: "main-session",
      agentId: "main",
      owner: { connId: "conn-foreign", deviceId: "dev-foreign" },
      controlUiVisible: ["hidden", "hidden worker", "all foreign hidden"].includes(kind)
        ? false
        : undefined,
      turnKind: kind === "preserved" ? "btw" : undefined,
    });
    const context = createChatAbortContext({ getRuntimeConfig: () => cfg });
    if (hasOwnedActive) {
      context.chatAbortControllers.set("run-mine", mine);
      context.chatRunState.getOrCreate("run-mine").buffer = "partial parent reply";
      mine.controller.signal.addEventListener("abort", () => {
        if (kind !== "late descendant") {
          releaseSwarmRun("capacity");
        }
      });
    }
    if (
      [
        "all foreign",
        "all foreign hidden",
        "mixed active",
        "hidden",
        "preserved",
        "hidden worker",
      ].includes(kind)
    ) {
      context.chatAbortControllers.set("run-foreign", foreign);
    }
    if (kind === "mixed queued") {
      context.chatQueuedTurns.set("run-foreign", {
        controller: foreign.controller,
        sessionKey,
        sessionId: "main-session",
        agentId: "main",
        ownerConnId: "conn-foreign",
        ownerDeviceId: "dev-foreign",
      });
    }
    if (kind.includes("pending")) {
      const prefix = kind === "mixed pending chat" ? "pending-chat:" : "agent:";
      context.dedupe.set(`${prefix}run-foreign`, {
        ts: Date.now(),
        ok: true,
        payload: {
          runId: "run-foreign",
          sessionKey,
          agentId: "main",
          status: "accepted",
          ownerConnId: "conn-foreign",
          ownerDeviceId: "dev-foreign",
          controlUiVisible: kind === "hidden pending" ? false : undefined,
        },
      });
    }
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    if (kind.includes("worker")) {
      const workerRunId =
        kind === "represented worker"
          ? "run-mine"
          : kind === "hidden worker"
            ? "run-foreign"
            : "worker-run";
      context.workerEnvironmentService = {
        cancelInferenceForSession,
        hasInferenceForSession: (sessionId: string, runId?: string) =>
          sessionId === "main-session" && (!runId || runId === workerRunId),
      };
    }
    const registerChild = () =>
      registerSubagentRun({
        runId: "cascade-queued",
        childSessionKey: childKey,
        requesterSessionKey:
          kind === "late descendant" ? "agent:main:subagent:orchestrator" : sessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: sessionKey,
        task: "preserve exclusive ownership",
        cleanup: "keep",
        collect: true,
        queued: true,
      });
    if (kind === "late descendant") {
      addSubagentRunForTests({
        runId: "orchestrator",
        childSessionKey: "agent:main:subagent:orchestrator",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: "run-mine",
        requesterDisplayKey: sessionKey,
        task: "live orchestrator",
        cleanup: "keep",
        createdAt: 1,
        startedAt: 2,
      });
    } else {
      registerChild();
    }
    const start = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "cascade-ownership",
      runId: "cascade-queued",
      maxConcurrent: 1,
      activeRunIds: ["capacity"],
      start,
      onStartFailure: () => true,
    });
    const entered = createDeferred();
    const proceed = createDeferred();
    const admission =
      kind === "late descendant"
        ? await beginSessionWorkAdmission({
            scope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            identities: ["agent:main:subagent:orchestrator"],
            assertAllowed: () => {},
            onInterrupt: () => entered.resolve(),
          })
        : undefined;
    const append = vi
      .spyOn(transcriptPersistence, "appendAssistantTranscriptMessage")
      .mockImplementationOnce(async () => {
        if (kind === "late descendant") {
          releaseSwarmRun("capacity");
        }
        entered.resolve();
        await proceed.promise;
        return { ok: true, messageId: "aborted-partial" };
      });
    if (!hasOwnedActive) {
      releaseSwarmRun("capacity");
    }
    const pending = invokeChatAbortHandler({
      handler: (options) =>
        handleChatAbortRequestWithLifecycle(
          options,
          kind === "ordinary" ? {} : { cascadeDescendants: true },
        ),
      context,
      request: {
        sessionKey,
        agentId: "main",
        preserveSideRuns: kind === "preserved",
        ...(kind === "late descendant" ? { runId: "run-mine" } : {}),
      },
      client: {
        connId: "conn-owner",
        connect: {
          device: { id: "dev-owner" },
          scopes:
            kind === "hidden worker" ? ["operator.admin"] : ["operator.read", "operator.write"],
        },
      },
    });
    try {
      if (hasOwnedActive) {
        await entered.promise;
        if (kind === "late descendant") {
          expect(
            getSubagentRunByChildSessionKey("agent:main:subagent:orchestrator")?.execution.endedAt,
          ).toBeUndefined();
          registerChild();
        }
        if (canCascade) {
          expect(
            start,
            "selected queued work does not dispatch during parent partial persistence",
          ).not.toHaveBeenCalled();
        } else {
          expect(
            start,
            "foreign/protected/ordinary work must not be held during partial persistence",
          ).toHaveBeenCalledOnce();
        }
      }
      admission?.release();
      proceed.resolve();
      const respond = await pending;
      expect(requireLastRespondCall(respond)[0]).toBe(!kind.startsWith("all foreign"));
      const child = getSubagentRunByChildSessionKey(childKey);
      if (canCascade) {
        expect(child).toMatchObject({
          endedReason: "subagent-killed",
          execution: { status: "terminal" },
        });
        expect(start).not.toHaveBeenCalled();
      } else {
        expect(child?.execution.endedAt).toBeUndefined();
        expect(start).toHaveBeenCalledOnce();
      }
      expect(foreign.controller.signal.aborted).toBe(false);
      expect(cancelInferenceForSession).not.toHaveBeenCalled();
    } finally {
      admission?.release();
      proceed.resolve();
      await pending;
      append.mockRestore();
      releaseSwarmRun("capacity");
    }
  });
});
