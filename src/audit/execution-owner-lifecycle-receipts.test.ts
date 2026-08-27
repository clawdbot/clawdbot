import { rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { bindCronRunReceiptExecution } from "../cron/store/run-receipt-store.js";
import { tableHasColumn, tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { bindTaskFlowExecution } from "../tasks/task-flow-registry.store.sqlite.js";
import { bindTaskRunExecution } from "../tasks/task-registry.store.sqlite.js";
import { presentExecutionDecisionReceipts } from "./execution-decision-receipts.js";
import { createExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";
import { pageOwnerLifecycleReceipts } from "./execution-owner-lifecycle-receipts.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function oldSchemaSql(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS execution_owner_lifecycle_bindings (",
  );
  const endMarker = ") STRICT;";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start);
  if (start < 0 || end < start) {
    throw new Error("owner lifecycle binding schema marker is missing");
  }
  return `${OPENCLAW_STATE_SCHEMA_SQL.slice(0, start)}${OPENCLAW_STATE_SCHEMA_SQL.slice(end + endMarker.length)}`;
}

function createOldOwnerDatabase() {
  const pathname = path.join(tempDirs.make("owner-lifecycle-"), "openclaw.sqlite");
  const oldReader = new DatabaseSync(pathname);
  oldReader.exec(oldSchemaSql());
  oldReader.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
  oldReader
    .prepare(
      `INSERT INTO schema_meta (
         meta_key, role, schema_version, created_at, updated_at
       ) VALUES ('primary', 'global', ?, 1, 1)`,
    )
    .run(OPENCLAW_STATE_SCHEMA_VERSION);
  oldReader
    .prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("cron-1", "default", "job-1", "revision-1", "main", "run-1", "running", 1, 60, null);
  oldReader
    .prepare(
      `INSERT INTO task_runs (
         task_id, runtime, owner_key, scope_kind, task, status, delivery_status,
         notify_policy, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "task-1",
      "cron",
      "owner-1",
      "system",
      "private",
      "running",
      "not_applicable",
      "silent",
      61,
    );
  oldReader
    .prepare(
      `INSERT INTO flow_runs (
         flow_id, owner_key, status, notify_policy, goal, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("flow-1", "owner-1", "running", "silent", "private", 62, 62);
  oldReader.close();
  return { path: pathname };
}

function admitted(contextId = "context-1", executionId = "execution-1"): AdmittedRunContext {
  return {
    operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
    executionIdentityToken: createExecutionIdentityAdmissionToken("run-1", {
      contextId,
      executionId,
      now: 50,
    }),
  };
}

function executionContext(contextId = "context-1"): ExecutionIdentityContextV1 {
  return {
    schemaVersion: 1,
    contextId,
    executionId: "execution-1",
    runId: "run-1",
    createdAt: 50,
    trustDomain: { kind: "gateway-cell", domainRef: "host-1", state: "present" },
    invoker: { state: "unknown" },
    ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
    agentPrincipal: { kind: "agent", domainRef: "host-1", principalRef: "main" },
    agentDefinition: { definitionRef: "main", state: "present" },
    runtimeInstance: { runtimeRef: "runtime-1", kind: "embedded", state: "present" },
    applicableGrants: [],
    assurance: [],
    coverageState: "unattributed",
    missingEvidence: [],
  };
}

const receiptHandle = {
  receiptId: "cron-1",
  storeKey: "default",
  jobId: "job-1",
  configRevision: "revision-1",
  agentId: "main",
  ownerPid: 1,
  ownerStartTime: null,
  startedAtMs: 60,
};

describe("owner-native execution lifecycle receipts", () => {
  it("lazily binds exact owner rows while disabled collection allocates nothing", () => {
    const options = createOldOwnerDatabase();
    const current = openOpenClawStateDatabase(options).db;
    expect(tableExists(current, "execution_owner_lifecycle_bindings")).toBe(false);
    for (const table of ["cron_run_receipts", "task_runs", "flow_runs"]) {
      expect(tableHasColumn(current, table, "context_id")).toBe(false);
      expect(tableHasColumn(current, table, "execution_id")).toBe(false);
    }

    const disabled: AdmittedRunContext = {
      operationalRunInstance: { instanceId: "instance-disabled", runId: "run-1" },
    };
    expect(
      bindCronRunReceiptExecution({ admitted: disabled, handle: receiptHandle, options }),
    ).toBe("disabled");
    expect(bindTaskRunExecution({ admitted: disabled, taskId: "task-1", options })).toBe(
      "disabled",
    );
    expect(bindTaskFlowExecution({ admitted: disabled, flowId: "flow-1", options })).toBe(
      "disabled",
    );
    expect(tableExists(current, "execution_owner_lifecycle_bindings")).toBe(false);
    for (const table of ["cron_run_receipts", "task_runs", "flow_runs"]) {
      expect(tableHasColumn(current, table, "context_id")).toBe(false);
      expect(tableHasColumn(current, table, "execution_id")).toBe(false);
    }

    expect(
      bindCronRunReceiptExecution({ admitted: admitted(), handle: receiptHandle, options }),
    ).toBe("bound");
    expect(bindTaskRunExecution({ admitted: admitted(), taskId: "task-1", options })).toBe("bound");
    expect(bindTaskFlowExecution({ admitted: admitted(), flowId: "flow-1", options })).toBe(
      "bound",
    );
    expect(tableExists(current, "execution_owner_lifecycle_bindings")).toBe(true);
    for (const table of ["cron_run_receipts", "task_runs", "flow_runs"]) {
      expect(tableHasColumn(current, table, "context_id")).toBe(false);
      expect(tableHasColumn(current, table, "execution_id")).toBe(false);
    }
    expect(bindTaskRunExecution({ admitted: admitted(), taskId: "task-1", options })).toBe(
      "already-bound",
    );
    expect(
      bindTaskRunExecution({
        admitted: admitted("context-1", "execution-other"),
        taskId: "task-1",
        options,
      }),
    ).toBe("mismatch");
    current.prepare("UPDATE cron_run_receipts SET status = 'ok', finished_at_ms = 70").run();
    current.prepare("UPDATE task_runs SET status = 'succeeded'").run();
    current.prepare("UPDATE flow_runs SET status = 'succeeded', ended_at = 70").run();

    closeOpenClawStateDatabaseForTest();
    const oldReader = new DatabaseSync(options.path);
    expect(
      oldReader.prepare("SELECT status FROM task_runs WHERE task_id = ?").get("task-1"),
    ).toEqual({
      status: "succeeded",
    });
    oldReader.prepare("UPDATE task_runs SET status = ? WHERE task_id = ?").run("failed", "task-1");
    oldReader.close();

    const reopened = openOpenClawStateDatabase(options).db;
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      reopened
        .prepare(
          `SELECT binding.context_id, binding.execution_id, task.status
           FROM task_runs AS task
           JOIN execution_owner_lifecycle_bindings AS binding
             ON binding.owner_kind = 'task' AND binding.owner_id = task.task_id
           WHERE task.task_id = ?`,
        )
        .get("task-1"),
    ).toEqual({ context_id: "context-1", execution_id: "execution-1", status: "failed" });
    expect(
      reopened
        .prepare(
          `SELECT owner_kind, owner_id, context_id, execution_id
           FROM execution_owner_lifecycle_bindings
           ORDER BY owner_kind`,
        )
        .all(),
    ).toEqual([
      {
        owner_kind: "cron",
        owner_id: "cron-1",
        context_id: "context-1",
        execution_id: "execution-1",
      },
      {
        owner_kind: "flow",
        owner_id: "flow-1",
        context_id: "context-1",
        execution_id: "execution-1",
      },
      {
        owner_kind: "task",
        owner_id: "task-1",
        context_id: "context-1",
        execution_id: "execution-1",
      },
    ]);
    expect(tableExists(reopened, "execution_decision_facts")).toBe(true);
    expect(
      reopened.prepare("SELECT COUNT(*) AS count FROM execution_decision_facts").get(),
    ).toEqual({ count: 0 });
  });

  it("uses stable c/t/f cursors and rejects a mismatched exact execution", () => {
    const options = createOldOwnerDatabase();
    bindCronRunReceiptExecution({ admitted: admitted(), handle: receiptHandle, options });
    bindTaskRunExecution({ admitted: admitted(), taskId: "task-1", options });
    bindTaskFlowExecution({ admitted: admitted(), flowId: "flow-1", options });
    const db = openOpenClawStateDatabase(options).db;
    db.prepare("UPDATE cron_run_receipts SET status = 'ok', finished_at_ms = 70").run();
    db.prepare("UPDATE task_runs SET status = 'succeeded'").run();
    db.prepare("UPDATE flow_runs SET status = 'succeeded', ended_at = 70").run();
    db.prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("cron-2", "default", "job-2", "revision-1", "main", "run-1", "skipped", 1, 60, 70);
    db.prepare(
      `INSERT INTO execution_owner_lifecycle_bindings (
         owner_kind, owner_id, context_id, execution_id
       ) VALUES (?, ?, ?, ?)`,
    ).run("cron", "cron-2", "context-1", "execution-other");
    const context = executionContext();

    const first = presentExecutionDecisionReceipts({
      context,
      decisionLimit: 1,
      options,
    });
    expect(first.nextDecisionCursor).toBe("a:0:0");
    const cronPage = presentExecutionDecisionReceipts({
      context,
      decisionCursor: first.nextDecisionCursor,
      decisionLimit: 1,
      options,
    });
    expect(cronPage.decisions[0]?.source.owner).toBe("cron_run_receipts");
    expect(cronPage.decisionDisplays[0]).toMatchObject({
      decision: { outcome: "not-applicable", reasonCode: "cron_run_ok" },
      provenance: { state: "verified", producer: "cron-lifecycle" },
    });
    expect(cronPage.nextDecisionCursor).toMatch(/^c:/);
    const mismatchPage = presentExecutionDecisionReceipts({
      context,
      decisionCursor: cronPage.nextDecisionCursor,
      decisionLimit: 1,
      options,
    });
    expect(mismatchPage.decisions[0]).toMatchObject({
      decision: { outcome: "unknown", reasonCode: "cron_run_execution_link_mismatch" },
      missingEvidence: ["decision.execution_link"],
    });
    expect(mismatchPage.nextDecisionCursor).toBe("t:0:0");
    const taskPage = presentExecutionDecisionReceipts({
      context,
      decisionCursor: mismatchPage.nextDecisionCursor,
      decisionLimit: 1,
      options,
    });
    expect(taskPage.decisions[0]?.source.owner).toBe("task_runs");
    expect(taskPage.decisionDisplays[0]).toMatchObject({
      decision: { outcome: "not-applicable", reasonCode: "task_run_succeeded" },
      provenance: { state: "verified", producer: "task-lifecycle" },
    });
    expect(taskPage.nextDecisionCursor).toBe("f:0:0");
    const flowPage = presentExecutionDecisionReceipts({
      context,
      decisionCursor: taskPage.nextDecisionCursor,
      decisionLimit: 1,
      options,
    });
    expect(flowPage.decisions[0]?.source.owner).toBe("flow_runs");
    expect(flowPage.decisionDisplays[0]).toMatchObject({
      decision: { outcome: "not-applicable", reasonCode: "flow_run_succeeded" },
      provenance: { state: "verified", producer: "flow-lifecycle" },
    });
    expect(
      JSON.stringify([
        cronPage.decisionDisplays,
        taskPage.decisionDisplays,
        flowPage.decisionDisplays,
      ]),
    ).not.toMatch(/cron-1|task-1|flow-1|private|cron_run_receipts|task_runs|flow_runs/);
    expect(flowPage.nextDecisionCursor).toBeUndefined();

    expect(
      presentExecutionDecisionReceipts({
        context,
        decisionCursor: "1",
        decisionLimit: 1,
        options,
      }).decisions[0]?.source.owner,
    ).toBe("cron_run_receipts");
  });

  const deletedAnchorCases = [
    {
      stage: "cron",
      cursor: "c:0:0",
      bindFirst: (options: ReturnType<typeof createOldOwnerDatabase>) =>
        bindCronRunReceiptExecution({ admitted: admitted(), handle: receiptHandle, options }),
      addSuccessor: (db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO cron_run_receipts (
             receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
             status, owner_pid, started_at_ms, finished_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run("cron-2", "default", "job-2", "revision-1", "main", "run-1", "running", 1, 63, null);
        db.prepare(
          `INSERT INTO execution_owner_lifecycle_bindings (
             owner_kind, owner_id, context_id, execution_id
           ) VALUES ('cron', 'cron-2', 'context-1', 'execution-1')`,
        ).run();
      },
      deleteAnchor: (db: DatabaseSync) => {
        db.prepare(
          "DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'cron' AND owner_id = 'cron-1'",
        ).run();
        db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-1'").run();
      },
    },
    {
      stage: "task",
      cursor: "t:0:0",
      bindFirst: (options: ReturnType<typeof createOldOwnerDatabase>) =>
        bindTaskRunExecution({ admitted: admitted(), taskId: "task-1", options }),
      addSuccessor: (db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO task_runs (
             task_id, runtime, owner_key, scope_kind, task, status, delivery_status,
             notify_policy, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "task-2",
          "cron",
          "owner-2",
          "system",
          "private",
          "running",
          "not_applicable",
          "silent",
          63,
        );
        db.prepare(
          `INSERT INTO execution_owner_lifecycle_bindings (
             owner_kind, owner_id, context_id, execution_id
           ) VALUES ('task', 'task-2', 'context-1', 'execution-1')`,
        ).run();
      },
      deleteAnchor: (db: DatabaseSync) => {
        db.prepare(
          "DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'task' AND owner_id = 'task-1'",
        ).run();
        db.prepare("DELETE FROM task_runs WHERE task_id = 'task-1'").run();
      },
    },
    {
      stage: "flow",
      cursor: "f:0:0",
      bindFirst: (options: ReturnType<typeof createOldOwnerDatabase>) =>
        bindTaskFlowExecution({ admitted: admitted(), flowId: "flow-1", options }),
      addSuccessor: (db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO flow_runs (
             flow_id, owner_key, status, notify_policy, goal, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run("flow-2", "owner-2", "running", "silent", "private", 63, 63);
        db.prepare(
          `INSERT INTO execution_owner_lifecycle_bindings (
             owner_kind, owner_id, context_id, execution_id
           ) VALUES ('flow', 'flow-2', 'context-1', 'execution-1')`,
        ).run();
      },
      deleteAnchor: (db: DatabaseSync) => {
        db.prepare(
          "DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'flow' AND owner_id = 'flow-1'",
        ).run();
        db.prepare("DELETE FROM flow_runs WHERE flow_id = 'flow-1'").run();
      },
    },
  ] as const;

  it.each(deletedAnchorCases)(
    "rejects a nonzero $stage cursor after its exact owner anchor is deleted",
    ({ cursor, bindFirst, addSuccessor, deleteAnchor }) => {
      const options = createOldOwnerDatabase();
      expect(bindFirst(options)).toBe("bound");
      const db = openOpenClawStateDatabase(options).db;
      addSuccessor(db);
      const firstPage = presentExecutionDecisionReceipts({
        context: executionContext(),
        decisionCursor: cursor,
        decisionLimit: 1,
        options,
      });
      expect(firstPage.nextDecisionCursor).toMatch(/^[ctf]:[1-9]\d*:[1-9]\d*$/);

      deleteAnchor(db);

      expect(() =>
        presentExecutionDecisionReceipts({
          context: executionContext(),
          decisionCursor: firstPage.nextDecisionCursor,
          decisionLimit: 1,
          options,
        }),
      ).toThrow("decision cursor is no longer retained; restart inspection without --cursor");
    },
  );

  it("rejects a nonzero owner cursor when its retained anchor belongs to another context", () => {
    const options = createOldOwnerDatabase();
    expect(
      bindCronRunReceiptExecution({ admitted: admitted(), handle: receiptHandle, options }),
    ).toBe("bound");
    const db = openOpenClawStateDatabase(options).db;
    deletedAnchorCases[0].addSuccessor(db);
    const firstPage = presentExecutionDecisionReceipts({
      context: executionContext(),
      decisionCursor: "c:0:0",
      decisionLimit: 1,
      options,
    });
    expect(firstPage.nextDecisionCursor).toMatch(/^c:[1-9]\d*:[1-9]\d*$/);

    expect(() =>
      presentExecutionDecisionReceipts({
        context: executionContext("context-other"),
        decisionCursor: firstPage.nextDecisionCursor,
        decisionLimit: 1,
        options,
      }),
    ).toThrow("decision cursor is no longer retained; restart inspection without --cursor");
  });

  it("rejects a nonzero owner cursor after the state database is removed", () => {
    const options = createOldOwnerDatabase();
    expect(
      bindCronRunReceiptExecution({ admitted: admitted(), handle: receiptHandle, options }),
    ).toBe("bound");
    const db = openOpenClawStateDatabase(options).db;
    deletedAnchorCases[0].addSuccessor(db);
    const firstPage = presentExecutionDecisionReceipts({
      context: executionContext(),
      decisionCursor: "c:0:0",
      decisionLimit: 1,
      options,
    });
    expect(firstPage.nextDecisionCursor).toMatch(/^c:[1-9]\d*:[1-9]\d*$/);

    closeOpenClawStateDatabaseForTest();
    rmSync(options.path);

    expect(() =>
      presentExecutionDecisionReceipts({
        context: executionContext(),
        decisionCursor: firstPage.nextDecisionCursor,
        decisionLimit: 1,
        options,
      }),
    ).toThrow("decision cursor is no longer retained; restart inspection without --cursor");
  });

  it("rejects a reused owner rowid whose binding belongs to another execution", () => {
    const options = createOldOwnerDatabase();
    const db = openOpenClawStateDatabase(options).db;
    db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-1'").run();
    db.prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("cron-2", "default", "job-2", "revision-1", "main", "run-1", "running", 1, 63, null);
    db.prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("cron-1", "default", "job-1", "revision-1", "main", "run-1", "running", 1, 60, null);
    expect(
      bindCronRunReceiptExecution({ admitted: admitted(), handle: receiptHandle, options }),
    ).toBe("bound");
    db.prepare(
      `INSERT INTO execution_owner_lifecycle_bindings (
         owner_kind, owner_id, context_id, execution_id
       ) VALUES ('cron', 'cron-2', 'context-1', 'execution-1')`,
    ).run();
    const firstPage = presentExecutionDecisionReceipts({
      context: executionContext(),
      decisionCursor: "c:0:0",
      decisionLimit: 1,
      options,
    });
    expect(firstPage.nextDecisionCursor).toMatch(/^c:60:[1-9]\d*$/);

    db.prepare(
      "DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'cron' AND owner_id = 'cron-1'",
    ).run();
    db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = 'cron-1'").run();
    db.prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "cron-replacement",
      "default",
      "job-replacement",
      "revision-1",
      "main",
      "run-2",
      "running",
      1,
      60,
      null,
    );
    db.prepare(
      `INSERT INTO execution_owner_lifecycle_bindings (
         owner_kind, owner_id, context_id, execution_id
       ) VALUES ('cron', 'cron-replacement', 'context-1', 'execution-other')`,
    ).run();

    expect(() =>
      presentExecutionDecisionReceipts({
        context: executionContext(),
        decisionCursor: firstPage.nextDecisionCursor,
        decisionLimit: 1,
        options,
      }),
    ).toThrow("decision cursor is no longer retained; restart inspection without --cursor");
  });

  it("projects every owner terminal state without rederiving lifecycle precedence", () => {
    const options = createOldOwnerDatabase();
    bindCronRunReceiptExecution({ admitted: admitted(), handle: receiptHandle, options });
    bindTaskRunExecution({ admitted: admitted(), taskId: "task-1", options });
    bindTaskFlowExecution({ admitted: admitted(), flowId: "flow-1", options });
    const context = executionContext();
    const db = openOpenClawStateDatabase(options).db;

    for (const status of ["ok", "error", "skipped", "interrupted", "superseded"]) {
      db.prepare(
        "UPDATE cron_run_receipts SET status = ?, finished_at_ms = 70 WHERE receipt_id = ?",
      ).run(status, "cron-1");
      expect(
        pageOwnerLifecycleReceipts({ stage: "cron", context, limit: 1, options }).entries[0]
          ?.receipt.decision,
      ).toEqual({ outcome: "not-applicable", reasonCode: `cron_run_${status}` });
    }
    for (const status of ["succeeded", "failed", "timed_out", "cancelled", "lost"]) {
      db.prepare("UPDATE task_runs SET status = ?, terminal_outcome = NULL WHERE task_id = ?").run(
        status,
        "task-1",
      );
      expect(
        pageOwnerLifecycleReceipts({ stage: "task", context, limit: 1, options }).entries[0]
          ?.receipt.decision.reasonCode,
      ).toBe(`task_run_${status}`);
    }
    db.prepare("UPDATE task_runs SET terminal_outcome = 'blocked' WHERE task_id = ?").run("task-1");
    expect(
      pageOwnerLifecycleReceipts({ stage: "task", context, limit: 1, options }).entries[0]?.receipt
        .decision.reasonCode,
    ).toBe("task_run_blocked");
    for (const status of ["blocked", "succeeded", "failed", "cancelled", "lost"]) {
      db.prepare("UPDATE flow_runs SET status = ? WHERE flow_id = ?").run(status, "flow-1");
      expect(
        pageOwnerLifecycleReceipts({ stage: "flow", context, limit: 1, options }).entries[0]
          ?.receipt.decision.reasonCode,
      ).toBe(`flow_run_${status}`);
    }
  });
});
