import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  consumeOperatorApprovalAllowOnce,
  getOperatorApprovalDetailed,
  insertOperatorApproval,
  resolveOperatorApproval,
} from "./operator-approval-store.js";

type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(tempDirs.make("openclaw-approval-id-"));
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function approval(
  id: string,
  token?: NewOperatorApproval["executionIdentityToken"],
): NewOperatorApproval {
  return {
    id,
    kind: "exec",
    presentation: {
      kind: "exec",
      commandText: `echo ${id}`,
      commandPreview: `echo ${id}`,
      warningText: null,
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: { deviceId: "request-device", clientId: "request-client", deviceTokenAuth: true },
    reviewerDeviceIds: ["reviewer"],
    source: {
      agentId: "main",
      sessionKey: "agent:main:child",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
    },
    audienceSessionKeys: ["agent:main:child"],
    runtimeEpoch: "runtime-a",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    ...(token ? { executionIdentityToken: token } : {}),
  };
}

const token = (runId = "run-1"): NonNullable<NewOperatorApproval["executionIdentityToken"]> => ({
  tokenVersion: 1,
  createdAt: 1,
  runId,
  contextId: "context-1",
  executionId: "execution-1",
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("operator approval execution identity", () => {
  it("creates the side table only for the first exact bound write", () => {
    const unbound = databaseOptions();
    expect(
      insertOperatorApproval({ approval: approval("unbound"), databaseOptions: unbound }),
    ).toMatchObject({ outcome: "inserted" });
    expect(
      openOpenClawStateDatabase(unbound)
        .db.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
        )
        .get(),
    ).toBeUndefined();

    const bound = databaseOptions();
    const userVersionBefore = openOpenClawStateDatabase(bound)
      .db.prepare("PRAGMA user_version")
      .get();
    const record = approval("bound", token());
    expect(insertOperatorApproval({ approval: record, databaseOptions: bound })).toMatchObject({
      outcome: "inserted",
    });
    expect(
      openOpenClawStateDatabase(bound)
        .db.prepare(
          "SELECT approval_id, source_context_id, source_execution_id FROM operator_approval_execution_identities",
        )
        .get(),
    ).toEqual({
      approval_id: "bound",
      source_context_id: "context-1",
      source_execution_id: "execution-1",
    });
    expect(insertOperatorApproval({ approval: record, databaseOptions: bound })).toMatchObject({
      outcome: "existing",
    });
    expect(openOpenClawStateDatabase(bound).db.prepare("PRAGMA user_version").get()).toEqual(
      userVersionBefore,
    );
  });

  it("never late-binds or binds a mismatched source run", () => {
    const late = databaseOptions();
    const base = approval("late-bind");
    expect(insertOperatorApproval({ approval: base, databaseOptions: late })).toMatchObject({
      outcome: "inserted",
    });
    expect(
      insertOperatorApproval({
        approval: { ...base, executionIdentityToken: token() },
        databaseOptions: late,
      }),
    ).toMatchObject({ outcome: "conflict" });

    const mismatch = databaseOptions();
    expect(
      insertOperatorApproval({
        approval: approval("mismatch", token("other-run")),
        databaseOptions: mismatch,
      }),
    ).toMatchObject({ outcome: "inserted" });
    expect(
      openOpenClawStateDatabase(mismatch)
        .db.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("rolls back the parent when the child insert is forced to fail", () => {
    const options = databaseOptions();
    const db = openOpenClawStateDatabase(options).db;
    db.exec(`
      CREATE TABLE operator_approval_execution_identities (
        approval_id TEXT PRIMARY KEY REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
        source_context_id TEXT NOT NULL,
        source_execution_id TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER force_execution_identity_failure
      BEFORE INSERT ON operator_approval_execution_identities
      BEGIN
        SELECT RAISE(ABORT, 'forced child failure');
      END;
    `);

    expect(() =>
      insertOperatorApproval({ approval: approval("atomic", token()), databaseOptions: options }),
    ).toThrow("forced child failure");
    expect(
      db.prepare("SELECT approval_id FROM operator_approvals WHERE approval_id = ?").get("atomic"),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT approval_id FROM operator_approval_execution_identities").get(),
    ).toBeUndefined();
  });

  it("cascades parent deletion and retains the exact child across reopen", () => {
    const options = databaseOptions();
    expect(
      insertOperatorApproval({ approval: approval("durable", token()), databaseOptions: options }),
    ).toMatchObject({ outcome: "inserted" });
    closeOpenClawStateDatabaseForTest();

    const db = openOpenClawStateDatabase(options).db;
    expect(
      db
        .prepare(
          "SELECT source_context_id, source_execution_id FROM operator_approval_execution_identities WHERE approval_id = ?",
        )
        .get("durable"),
    ).toEqual({ source_context_id: "context-1", source_execution_id: "execution-1" });
    db.prepare("DELETE FROM operator_approvals WHERE approval_id = ?").run("durable");
    expect(
      db
        .prepare(
          "SELECT approval_id FROM operator_approval_execution_identities WHERE approval_id = ?",
        )
        .get("durable"),
    ).toBeUndefined();
  });

  it("keeps parent decision and consume semantics independent of child/audit rows", () => {
    const options = databaseOptions();
    for (const id of ["missing-child", "corrupt-child", "deleted-audit"]) {
      expect(
        insertOperatorApproval({ approval: approval(id, token()), databaseOptions: options }),
      ).toMatchObject({ outcome: "inserted" });
    }
    const db = openOpenClawStateDatabase(options).db;
    db.prepare("DELETE FROM operator_approval_execution_identities WHERE approval_id = ?").run(
      "missing-child",
    );
    db.prepare(
      "UPDATE operator_approval_execution_identities SET source_context_id = ?, source_execution_id = ? WHERE approval_id = ?",
    ).run("missing-context", "missing-execution", "corrupt-child");
    db.exec(`
      CREATE TABLE execution_identity_contexts (
        context_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL
      ) STRICT;
      INSERT INTO execution_identity_contexts VALUES ('context-1', 'execution-1');
      DELETE FROM execution_identity_contexts WHERE context_id = 'context-1';
    `);

    for (const id of ["missing-child", "corrupt-child", "deleted-audit"]) {
      expect(
        resolveOperatorApproval({
          id,
          decision: "allow-once",
          resolver: { kind: "device", id: "reviewer" },
          expectedKind: "exec",
          runtimeEpoch: "runtime-a",
          nowMs: 2_000,
          databaseOptions: options,
        }),
      ).toMatchObject({ outcome: "resolved" });
      expect(
        consumeOperatorApprovalAllowOnce({
          id,
          consumerId: "consumer",
          expectedKind: "exec",
          runtimeEpoch: "runtime-a",
          nowMs: 3_000,
          databaseOptions: options,
        }),
      ).toMatchObject({ outcome: "consumed" });
      expect(
        getOperatorApprovalDetailed({ id, nowMs: 3_000, databaseOptions: options }),
      ).toMatchObject({
        outcome: "found",
        record: { decision: "allow-once", consumedBy: "consumer" },
      });
    }
  });
});
