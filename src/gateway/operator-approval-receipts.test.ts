import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  countOperatorApprovalReceiptsForRun,
  forceDenyOperatorApproval,
  insertOperatorApproval,
  listOperatorApprovalReceiptsForRun,
  resolveOperatorApproval,
  summarizeOperatorApprovalReceiptsForRun,
} from "./operator-approval-store.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-approval-receipts-") } };
}

function approval(
  id: string,
  overrides: { runId?: string; createdAtMs?: number; expiresAtMs?: number } = {},
): Parameters<typeof insertOperatorApproval>[0]["approval"] {
  const createdAtMs = overrides.createdAtMs ?? 1_000;
  return {
    id,
    kind: "exec" as const,
    presentation: {
      kind: "exec" as const,
      commandText: "secret command --token private-value",
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: {
      deviceId: "requester-device-secret",
      clientId: "requester-client-secret",
      deviceTokenAuth: true,
    },
    reviewerDeviceIds: ["reviewer-device-secret"],
    source: {
      agentId: "main",
      sessionKey: "session-secret",
      sessionId: "session-id-secret",
      runId: overrides.runId ?? "run-receipts",
      toolCallId: "tool-call-secret",
      toolName: "exec",
    },
    runtimeEpoch: "runtime-secret",
    createdAtMs,
    expiresAtMs: overrides.expiresAtMs ?? createdAtMs + 10_000,
  };
}

const context = {
  contextId: "context-receipts",
  executionId: "execution-receipts",
  runId: "run-receipts",
};

describe("operator approval decision receipts", () => {
  it("projects every terminal state from the authoritative first answer", () => {
    const database = databaseOptions();
    for (const id of [
      "allowed",
      "denied",
      "expired",
      "cancelled",
      "no-route",
      "storage-corrupt",
      "payload-corrupt",
    ]) {
      insertOperatorApproval({ approval: approval(id), databaseOptions: database });
    }
    resolveOperatorApproval({
      id: "allowed",
      decision: "allow-once",
      resolver: { kind: "device", id: "reviewer-device-secret" },
      nowMs: 2_000,
      databaseOptions: database,
    });
    resolveOperatorApproval({
      id: "denied",
      decision: "deny",
      resolver: { kind: "device", id: "reviewer-device-secret" },
      nowMs: 2_001,
      databaseOptions: database,
    });
    forceDenyOperatorApproval({
      id: "expired",
      status: "expired",
      reason: "timeout",
      resolver: { kind: "system", id: null },
      nowMs: 2_002,
      databaseOptions: database,
    });
    forceDenyOperatorApproval({
      id: "cancelled",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: 2_003,
      databaseOptions: database,
    });
    forceDenyOperatorApproval({
      id: "no-route",
      status: "denied",
      reason: "no-route",
      resolver: { kind: "system", id: "no-approval-route" },
      nowMs: 2_004,
      databaseOptions: database,
    });
    forceDenyOperatorApproval({
      id: "storage-corrupt",
      status: "denied",
      reason: "storage-corrupt",
      resolver: { kind: "system", id: "storage-error" },
      nowMs: 2_005,
      databaseOptions: database,
    });
    resolveOperatorApproval({
      id: "payload-corrupt",
      decision: "deny",
      resolver: { kind: "channel", id: "channel-reviewer-secret" },
      nowMs: 2_006,
      databaseOptions: database,
    });
    openOpenClawStateDatabase(database)
      .db.prepare("UPDATE operator_approvals SET presentation_json = ? WHERE approval_id = ?")
      .run("{", "payload-corrupt");

    const receipts = listOperatorApprovalReceiptsForRun({
      context,
      linkState: "unambiguous",
      offset: 0,
      limit: 20,
      nowMs: 3_000,
      databaseOptions: database,
    });
    expect(
      countOperatorApprovalReceiptsForRun({
        runId: context.runId,
        nowMs: 3_000,
        databaseOptions: database,
      }),
    ).toBe(7);
    expect(
      summarizeOperatorApprovalReceiptsForRun({
        runId: context.runId,
        linkState: "unambiguous",
        nowMs: 3_000,
        databaseOptions: database,
      }),
    ).toEqual({
      count: 7,
      coverageState: "unknown",
      missingEvidence: ["operator_approval.valid"],
    });
    expect(
      receipts.map((receipt) => [
        receipt.decision.outcome,
        receipt.decision.reasonCode,
        receipt.enforcement.coverageState,
      ]),
    ).toEqual([
      ["allowed", "operator_approval_allowed_once", "enforced"],
      ["denied", "operator_approval_denied_by_reviewer", "enforced"],
      ["denied", "operator_approval_expired", "enforced"],
      ["denied", "operator_approval_cancelled_run_aborted", "enforced"],
      ["denied", "operator_approval_denied_no_route", "enforced"],
      ["denied", "operator_approval_denied_storage_corrupt", "enforced"],
      ["unknown", "operator_approval_record_corrupt", "unknown"],
    ]);
    expect(receipts[4]?.enforcement.policyRefs).toContain(
      "operator-approval:delivery-route-required",
    );
    expect(receipts[4]?.remediation).toEqual([
      expect.objectContaining({ code: "restore_approval_route" }),
    ]);

    const encoded = JSON.stringify(receipts);
    for (const secret of [
      "secret command",
      "private-value",
      "requester-device-secret",
      "requester-client-secret",
      "reviewer-device-secret",
      "channel-reviewer-secret",
      "session-secret",
      "session-id-secret",
      "tool-call-secret",
      "runtime-secret",
    ]) {
      expect(encoded).not.toContain(secret);
    }
  });

  it("keeps a denied first answer after a conflicting allow retry", () => {
    const database = databaseOptions();
    insertOperatorApproval({ approval: approval("first-answer"), databaseOptions: database });
    expect(
      resolveOperatorApproval({
        id: "first-answer",
        decision: "deny",
        resolver: { kind: "device", id: "first" },
        nowMs: 2_000,
        databaseOptions: database,
      }).outcome,
    ).toBe("resolved");
    expect(
      resolveOperatorApproval({
        id: "first-answer",
        decision: "allow-once",
        resolver: { kind: "device", id: "second" },
        nowMs: 2_001,
        databaseOptions: database,
      }),
    ).toMatchObject({ outcome: "already-resolved", retry: "conflict" });
    expect(
      listOperatorApprovalReceiptsForRun({
        context,
        linkState: "unambiguous",
        offset: 0,
        limit: 10,
        nowMs: 2_001,
        databaseOptions: database,
      })[0],
    ).toMatchObject({
      decision: { outcome: "denied", reasonCode: "operator_approval_denied_by_reviewer" },
      enforcement: {
        coverageState: "enforced",
        contextFieldsUsed: ["runId"],
      },
      source: { owner: "operator_approvals" },
    });
  });

  it("enforces approval retention and never creates a generic duplicate", () => {
    const database = databaseOptions();
    insertOperatorApproval({
      approval: approval("old", { createdAtMs: 0, expiresAtMs: 10 }),
      databaseOptions: database,
    });
    resolveOperatorApproval({
      id: "old",
      decision: "deny",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 1,
      databaseOptions: database,
    });
    expect(
      listOperatorApprovalReceiptsForRun({
        context,
        linkState: "unambiguous",
        offset: 0,
        limit: 10,
        nowMs: RETENTION_MS + 2,
        databaseOptions: database,
      }),
    ).toEqual([]);
    expect(tableExists(openOpenClawStateDatabase(database).db, "execution_decision_facts")).toBe(
      false,
    );
  });
});
