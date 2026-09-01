import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { settleSubagentCompletionDelivery } from "../agents/subagents/completion/subagent-completion-admission.store.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../agents/subagents/registry/subagent-lifecycle-events.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  resumeSubagentRun,
  testing,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { ensureTaskRegistryReady, getTaskById } from "../tasks/runtime-internal.js";
import { publishTaskRecordAfterAtomicStore } from "../tasks/task-registry.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  installGatewayTestHooks,
  testState,
  waitForSystemEvent,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("subagent completion blocked Gateway E2E", () => {
  it("publishes one no-crash system event after ordinary delivery exhaustion", async () => {
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for Gateway E2E fixtures");
    }
    testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");
    try {
      await withGatewayServer(async () => {
        const now = Date.now();
        const endedAt = now - 31 * 60_000;
        const task: TaskRecord = {
          taskId: "task-blocked-gateway-e2e",
          runtime: "subagent",
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey: "agent:main:subagent:blocked-gateway-e2e",
          runId: "task-run-blocked-gateway-e2e",
          requesterAgentId: "main",
          task: "finish the Gateway exhaustion proof",
          status: "succeeded",
          deliveryStatus: "pending",
          terminalOutcome: "succeeded",
          notifyPolicy: "done_only",
          createdAt: endedAt - 1_000,
          endedAt,
          lastEventAt: endedAt,
        };
        const subagent = createSubagentRunRecord({
          runId: "subagent-run-blocked-gateway-e2e",
          taskRunId: task.runId,
          childSessionKey: task.childSessionKey,
          requesterSessionKey: task.requesterSessionKey,
          requesterDisplayKey: task.requesterSessionKey,
          requesterAgentId: "main",
          task: task.task,
          createdAt: task.createdAt,
          endedAt,
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          completion: { required: true, resultText: "proof result", capturedAt: endedAt },
          delivery: {
            status: "pending",
            disposition: "retryable",
            generation: 1,
            windowStartedAt: endedAt,
            deadlineAt: endedAt + 30 * 60_000,
            lastError: "requester unavailable",
          },
        });

        await writeSessionStore({
          entries: {
            [subagent.childSessionKey]: {
              sessionId: "session-blocked-gateway-e2e",
              updatedAt: now,
            },
          },
        });
        settleSubagentCompletionDelivery({ subagent, task });
        addSubagentRunForTests(subagent);
        ensureTaskRegistryReady();
        publishTaskRecordAfterAtomicStore(task);
        testing.setDepsForTest({
          runSubagentAnnounceFlow: async () => "retryable",
          maybeWakeRequesterAfterAllChildrenSettled: async () => false,
        });

        resumeSubagentRun(subagent.runId);

        const events = await waitForSystemEvent(5_000);
        expect(events).toHaveLength(1);
        expect(events[0]).toContain("Task needs follow-up");
        expect(events[0]).toContain("requester unavailable");
        expect(getTaskById(task.taskId)).toMatchObject({
          deliveryStatus: "failed",
          terminalOutcome: "blocked",
        });
        expect(getSubagentRunByRunId(subagent.runId)?.delivery).toMatchObject({
          status: "suspended",
          disposition: "permanent_failure",
          suspendedReason: "expiry",
        });
      });
    } finally {
      testing.setDepsForTest();
      resetSubagentRegistryForTests({ persist: false });
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
    }
  });
});
