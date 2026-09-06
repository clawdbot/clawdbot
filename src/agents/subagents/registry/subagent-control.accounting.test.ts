/** Final cancellation diagnostics belong to stable nodes, including the selected root. */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
} from "../../../sessions/session-lifecycle-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();
const owner = "agent:main:main";
const key = (id: string) => `agent:main:subagent:${id}`;
const controller = {
  controllerSessionKey: owner,
  controllerAgentId: "main",
  callerSessionKey: owner,
  callerIsSubagent: false,
  controlScope: "children" as const,
};

async function seed() {
  let storePath = "";
  for (const id of ["root", "child", "healthy"]) {
    storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: key(id),
      defaultSessionId: `${id}-session`,
      lifecycleRevision: `${id}-revision`,
    });
    registerSubagentRun({
      runId: id,
      childSessionKey: key(id),
      requesterSessionKey: id === "root" ? owner : key("root"),
      requesterAgentId: "main",
      requesterDisplayKey: owner,
      task: "shared label",
      cleanup: "keep",
      collect: true,
      expectsCompletionMessage: false,
    });
  }
  return storePath;
}

it.each(
  (["bulk", "admin"] as const).flatMap((boundary) =>
    (["root traversal", "descendant drain"] as const).map((phase) => ({ boundary, phase })),
  ),
)(
  "$boundary reports a root read failure during $phase with truthful kill accounting",
  async ({ boundary, phase }) => {
    const storePath = await seed();
    const entered = createDeferred();
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [key("child"), "child-session"],
      assertAllowed: () => {},
      onInterrupt: () => entered.resolve(),
    });
    const failure = "root identity unavailable after cancellation";
    let armed = false;
    let failedReads = 0;
    let armedReads = 0;
    const read = sessions.loadExactSessionEntryReadOnly;
    const reader = vi
      .spyOn(sessions, "loadExactSessionEntryReadOnly")
      .mockImplementation((scope) => {
        if (
          armed &&
          scope.sessionKey === key("root") &&
          ++armedReads === (phase === "descendant drain" ? 2 : 1)
        ) {
          armed = false;
          failedReads += 1;
          throw new Error(failure);
        }
        return read(scope);
      });
    const patch = sessions.patchSessionEntryCore;
    const writer = vi
      .spyOn(sessions, "patchSessionEntryCore")
      .mockImplementation(async (scope, patcher, options) => {
        const result = await patch(scope, patcher, options);
        if (
          phase === "root traversal" &&
          scope.sessionKey === key("root") &&
          result?.abortedLastRun
        ) {
          // The real marker commit has finished; the next root ownership read is fallible.
          armed = true;
        }
        return result;
      });
    const cfg = getRuntimeConfig();
    const root = subagentRuns.get("root")!;
    const pending =
      boundary === "bulk"
        ? killAllControlledSubagentRuns({ cfg, controller, runs: [root] })
        : killSubagentRunAdmin({
            cfg,
            sessionKey: key("root"),
            expectedRunId: "root",
            expectedOwnerKey: owner,
          });
    try {
      if (phase === "descendant drain") {
        await Promise.race([
          entered.promise,
          pending.then((result) => {
            throw new Error(`Root never reached child drain: ${JSON.stringify(result)}`);
          }),
        ]);
        expect(findTaskByRunId("root")?.status).toBe("cancelled");
        armed = true;
        admission.release();
      }
      const result = await pending;
      expect(failedReads).toBe(1);
      expect(
        sessions.loadExactSessionEntryReadOnly({ storePath, sessionKey: key("root") })?.entry
          .sessionId,
      ).toBe("root-session");
      expect(result).toHaveProperty("error", expect.stringContaining(failure));
      expect(root.endedReason).toBe("subagent-killed");
      const childKills = phase === "descendant drain" ? 2 : 0;
      expect(findTaskByRunId("child")?.status).toBe(childKills ? "cancelled" : "running");
      expect(findTaskByRunId("healthy")?.status).toBe(childKills ? "cancelled" : "running");
      expect(result).toMatchObject(
        boundary === "bulk"
          ? {
              status: "error",
              killed: 1 + childKills,
              failed: 1,
              labels: Array(1 + childKills).fill("shared label"),
            }
          : {
              found: true,
              killed: true,
              cascadeKilled: childKills,
              targetState: {
                state: "terminal",
                task: { status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR },
              },
            },
      );
    } finally {
      armed = false;
      admission.release();
      try {
        await pending;
      } finally {
        reader.mockRestore();
        writer.mockRestore();
      }
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);

it.each([false, true])(
  "counts failed nodes once despite runtime plus discovery errors (same-text sibling=%s)",
  async (sameTextSibling) => {
    const storePath = await seed();
    const entered = createDeferred();
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [key("root"), "root-session"],
      assertAllowed: () => {},
      onInterrupt: () => entered.resolve(),
    });
    const rootHandle = createEmbeddedRunHandle({ runId: "root", isAbortable: false });
    const healthyHandle = createEmbeddedRunHandle({ runId: "healthy", isAbortable: false });
    setActiveEmbeddedRun("root-session", rootHandle, key("root"));
    if (sameTextSibling) {
      setActiveEmbeddedRun("healthy-session", healthyHandle, key("healthy"));
    }
    const read = sessions.loadExactSessionEntryReadOnly;
    let armed = false;
    let reads = 0;
    let failedReads = 0;
    const failure = "transient root discovery failure";
    const reader = vi
      .spyOn(sessions, "loadExactSessionEntryReadOnly")
      .mockImplementation((scope) => {
        if (armed && scope.sessionKey === key("root") && ++reads === 2) {
          failedReads += 1;
          throw new Error(failure);
        }
        return read(scope);
      });
    const pending = killAllControlledSubagentRuns({
      cfg: getRuntimeConfig(),
      controller,
      runs: [subagentRuns.get("root")!],
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(`Root never reached drain: ${JSON.stringify(result)}`);
        }),
      ]);
      armed = true;
      admission.release();
      const result = await pending;
      expect(failedReads).toBe(1);
      expect(result).toMatchObject({
        status: "error",
        failed: sameTextSibling ? 2 : 1,
        killed: sameTextSibling ? 1 : 2,
      });
      if (result.status !== "error") {
        throw new Error("Missing operation diagnostics");
      }
      expect(result.error).toContain(failure);
      // Identical labels and runtime errors on distinct nodes remain distinct diagnostics.
      expect(result.error.match(/Subagent is still active/g)).toHaveLength(sameTextSibling ? 2 : 1);
      expect(findTaskByRunId("root")?.status).toBe("running");
      expect(findTaskByRunId("child")?.status).toBe("cancelled");
      expect(findTaskByRunId("healthy")?.status).toBe(sameTextSibling ? "running" : "cancelled");
    } finally {
      armed = false;
      admission.release();
      try {
        await pending;
      } finally {
        reader.mockRestore();
        clearActiveEmbeddedRun("root-session", rootHandle, key("root"));
        clearActiveEmbeddedRun("healthy-session", healthyHandle, key("healthy"));
      }
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);
