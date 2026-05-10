import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRunningTaskRun } from "./task-executor.js";
import {
  listTaskFlowAuditFindings,
  type TaskFlowAuditCode,
  type TaskFlowAuditFinding,
} from "./task-flow-registry.audit.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
  setFlowWaiting,
} from "./task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function requireFinding(
  findings: TaskFlowAuditFinding[],
  code: TaskFlowAuditCode,
  flowId?: string,
): TaskFlowAuditFinding {
  const finding = findings.find(
    (candidate) =>
      candidate.code === code && (flowId === undefined || candidate.flow?.flowId === flowId),
  );
  if (!finding) {
    throw new Error(`Expected ${code} finding${flowId ? ` for ${flowId}` : ""}`);
  }
  return finding;
}

async function withTaskFlowAuditStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-task-flow-audit-",
    },
    async (state) => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
      try {
        await run(state.stateDir);
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests();
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("task-flow-registry audit", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("surfaces restore failures as task-flow audit findings", () => {
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => {
          throw new Error("boom");
        },
        saveSnapshot: () => {},
      },
    });

    const findings = listTaskFlowAuditFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.code).toBe("restore_failed");
    expect(findings[0]?.detail).toContain("boom");
  });

  it("clears restore-failed findings after a clean reset and restore", () => {
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => {
          throw new Error("boom");
        },
        saveSnapshot: () => {},
      },
    });

    const findings = listTaskFlowAuditFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("restore_failed");

    resetTaskFlowRegistryForTests({ persist: false });
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
      },
    });

    expect(listTaskFlowAuditFindings()).toStrictEqual([]);
  });

  it("detects stuck managed flows and missing blocked tasks", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const running = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Inspect queue",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });

      const blocked = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Wait on child",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });
      setFlowWaiting({
        flowId: blocked.flowId,
        expectedRevision: blocked.revision,
        blockedTaskId: "task-missing",
        blockedSummary: "Need follow-up",
        updatedAt: 1,
      });

      const findings = listTaskFlowAuditFindings({ now: 31 * 60_000 });
      expect(requireFinding(findings, "missing_linked_tasks", running.flowId).flow?.flowId).toBe(
        running.flowId,
      );
      expect(requireFinding(findings, "blocked_task_missing", blocked.flowId).flow?.flowId).toBe(
        blocked.flowId,
      );
    });
  });

  it("does not flag managed flows with active linked tasks as missing", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Inspect queue",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });

      createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "task-flow-audit-child",
        task: "Inspect PR 1",
        startedAt: 1,
        lastEventAt: 1,
      });

      const findings = listTaskFlowAuditFindings({ now: 31 * 60_000 });
      expect(
        findings.some(
          (finding) =>
            finding.code === "missing_linked_tasks" && finding.flow?.flowId === flow.flowId,
        ),
      ).toBe(false);
    });
  });

  it("does not flag missing linked tasks before the flow is stale", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const now = Date.now();
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Fresh managed flow",
        status: "running",
        createdAt: now - 5 * 60_000,
        updatedAt: now - 5 * 60_000,
      });

      expect(
        listTaskFlowAuditFindings({ now }).find(
          (finding) => finding.code === "missing_linked_tasks",
        ),
      ).toBeUndefined();

      const staleFindings = listTaskFlowAuditFindings({ now: now + 26 * 60_000 });
      expect(requireFinding(staleFindings, "missing_linked_tasks", flow.flowId).flow?.flowId).toBe(
        flow.flowId,
      );
    });
  });

  it("reports cancel-stuck before maintenance finalizes the flow", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Cancel work",
        status: "running",
        cancelRequestedAt: 100,
        createdAt: 1,
        updatedAt: 100,
      });

      const findings = listTaskFlowAuditFindings({ now: 6 * 60_000 });
      expect(requireFinding(findings, "cancel_stuck", flow.flowId).flow?.flowId).toBe(flow.flowId);
    });
  });
});
