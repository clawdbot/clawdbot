import { describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createSubagentRegistryListener } from "./subagent-registry-listener.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";

describe("subagent registry lifecycle listener", () => {
  function createHarness(expectsCompletionMessage: boolean) {
    const runId = `run-terminal-evidence-${expectsCompletionMessage}`;
    const entry = createSubagentRunRecord({
      runId,
      expectsCompletionMessage,
      execution: { status: "running", startedAt: 10 },
    });
    const runs = new Map([[runId, entry]]);
    const completeSubagentRunWithRecovery = vi.fn(async () => undefined);
    const pendingLifecycle = createPendingLifecycleScheduler({
      runs,
      completeInBackground: vi.fn(),
    });
    let handler:
      | Parameters<Parameters<typeof createSubagentRegistryListener>[0]["onAgentEvent"]>[0]
      | null = null;
    const listener = createSubagentRegistryListener({
      runs,
      pendingLifecycle,
      onAgentEvent: (next) => {
        handler = next;
        return () => undefined;
      },
      persist: vi.fn(),
      refreshFrozenResultFromSession: vi.fn(async () => undefined),
      completeSubagentRunWithRecovery,
      warn: vi.fn(),
    });
    listener.ensure();
    return { completeSubagentRunWithRecovery, handler: () => handler, runId };
  }

  it("fails required completion when the producer omitted terminal reply evidence", async () => {
    const harness = createHarness(true);
    harness.handler()?.({
      runId: harness.runId,
      seq: 1,
      ts: 20,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 10, endedAt: 20 },
    });

    await vi.waitFor(() => {
      expect(harness.completeSubagentRunWithRecovery).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: harness.runId,
          reason: "subagent-error",
          outcome: {
            status: "error",
            error: "subagent run ended before producing a final reply",
          },
        }),
        "lifecycle-missing-final-reply",
      );
    });
  });

  it("accepts explicit terminal reply evidence for required completion", async () => {
    const harness = createHarness(true);
    harness.handler()?.({
      runId: harness.runId,
      seq: 1,
      ts: 20,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 10,
        endedAt: 20,
        terminalReply: { disposition: "visible", text: "Finished." },
      },
    });

    await vi.waitFor(() => {
      expect(harness.completeSubagentRunWithRecovery).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "subagent-complete",
          outcome: { status: "ok" },
          terminalReply: { disposition: "visible", text: "Finished." },
        }),
        "lifecycle-ok-event",
      );
    });
  });

  it("keeps reply-optional completion compatible without terminal reply evidence", async () => {
    const harness = createHarness(false);
    harness.handler()?.({
      runId: harness.runId,
      seq: 1,
      ts: 20,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 10, endedAt: 20 },
    });

    await vi.waitFor(() => {
      expect(harness.completeSubagentRunWithRecovery).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "subagent-complete", outcome: { status: "ok" } }),
        "lifecycle-ok-event",
      );
    });
  });
});
