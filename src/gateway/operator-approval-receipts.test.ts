import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { activityRunInspectorSearch } from "../../ui/src/pages/activity/run-inspector-model.js";
import { presentExecutionDecisionReceipts } from "../audit/execution-decision-receipts.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  forceDenyOperatorApproval,
  insertOperatorApproval,
  pageOperatorApprovalReceiptsForRun,
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
  overrides: {
    runId?: string;
    createdAtMs?: number;
    expiresAtMs?: number;
    contextId?: string;
    executionId?: string;
  } = {},
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
    executionIdentityToken: {
      tokenVersion: 1,
      createdAt: createdAtMs,
      runId: overrides.runId ?? "run-receipts",
      contextId: overrides.contextId ?? "context-receipts",
      executionId: overrides.executionId ?? "execution-receipts",
    },
  };
}

const context = {
  contextId: "context-receipts",
  executionId: "execution-receipts",
  runId: "run-receipts",
  createdAt: 500,
};

const identityContext: ExecutionIdentityContextV1 = {
  schemaVersion: 1,
  ...context,
  trustDomain: { kind: "gateway-cell", domainRef: "domain-ref", state: "present" },
  invoker: { state: "absent" },
  ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
  agentPrincipal: { kind: "agent", domainRef: "domain-ref", principalRef: "main" },
  agentDefinition: { definitionRef: "main", state: "present" },
  runtimeInstance: { runtimeRef: "runtime-ref", kind: "embedded", state: "present" },
  applicableGrants: [],
  assurance: [],
  coverageState: "unattributed",
  missingEvidence: [],
};

describe("operator approval decision receipts", () => {
  it.each([null, "permission-change", "approval-scope-closed"])(
    "only recommends a new run when the outer approval owner stopped (%s)",
    (resolverId) => {
      const database = databaseOptions();
      insertOperatorApproval({ approval: approval("cancelled-scope"), databaseOptions: database });
      forceDenyOperatorApproval({
        id: "cancelled-scope",
        status: "cancelled",
        reason: "run-aborted",
        resolver: { kind: "system", id: resolverId },
        nowMs: 2_000,
        databaseOptions: database,
      });
      const receipt = pageOperatorApprovalReceiptsForRun({
        context,
        limit: 1,
        nowMs: 3_000,
        databaseOptions: database,
      }).entries[0]?.receipt;
      expect(receipt?.remediation).toEqual([
        expect.objectContaining({
          code: resolverId === null ? "start_new_run" : "request_approval_again",
        }),
      ]);
    },
  );

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

    const page = pageOperatorApprovalReceiptsForRun({
      context,
      limit: 20,
      nowMs: 3_000,
      databaseOptions: database,
    });
    const receipts = page.entries.map((entry) => entry.receipt);
    expect(page.entries.map((entry) => entry.selectorId)).toEqual([
      "approval-decision:1",
      "approval-decision:2",
      "approval-decision:3",
      "approval-decision:4",
      "approval-decision:5",
      "approval-decision:6",
      "approval-decision:7",
    ]);
    expect(page.entries).toHaveLength(receipts.length);
    expect(
      summarizeOperatorApprovalReceiptsForRun({
        context,
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

    const displays = presentExecutionDecisionReceipts({
      context: identityContext,
      decisionCursor: "a:0:0",
      decisionLimit: 20,
      options: { ...database, now: 3_000 },
    }).decisionDisplays;
    expect(displays?.[0]).toMatchObject({
      action: {
        family: "exec",
        operation: "approval",
        summary: "A exec approval allowed the requested action.",
      },
      provenance: { state: "verified", producer: "operator-approval" },
      remediation: [],
    });
    expect(JSON.stringify(displays)).not.toContain("secret command");
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
      pageOperatorApprovalReceiptsForRun({
        context,
        limit: 10,
        nowMs: 2_001,
        databaseOptions: database,
      }).entries[0]?.receipt,
    ).toMatchObject({
      decision: { outcome: "denied", reasonCode: "operator_approval_denied_by_reviewer" },
      enforcement: {
        coverageState: "enforced",
        contextFieldsUsed: ["contextId", "executionId", "runId"],
      },
      source: { owner: "operator_approvals" },
    });
  });

  it("keeps high-cardinality summary work bounded and conservative", () => {
    const database = databaseOptions();
    for (let index = 0; index < 130; index += 1) {
      const id = `bounded-${String(index).padStart(3, "0")}`;
      insertOperatorApproval({ approval: approval(id), databaseOptions: database });
      resolveOperatorApproval({
        id,
        decision: "deny",
        resolver: { kind: "device", id: "reviewer-device-secret" },
        nowMs: 2_000 + index,
        databaseOptions: database,
      });
    }

    expect(
      summarizeOperatorApprovalReceiptsForRun({
        context,
        nowMs: 3_000,
        databaseOptions: database,
      }),
    ).toEqual({
      count: 129,
      coverageState: "unknown",
      missingEvidence: ["operator_approval.summary_bounded"],
    });
  });

  it("pages equal-time approvals by row key and bounds oversized presentations", () => {
    const database = databaseOptions();
    for (const id of ["page-a", "page-b", "page-c"]) {
      insertOperatorApproval({ approval: approval(id), databaseOptions: database });
      resolveOperatorApproval({
        id,
        decision: "deny",
        resolver: { kind: "device", id: "reviewer" },
        nowMs: 2_000,
        databaseOptions: database,
      });
    }
    const db = openOpenClawStateDatabase(database).db;
    db.prepare("UPDATE operator_approvals SET presentation_json = ? WHERE approval_id = ?").run(
      JSON.stringify({ kind: "exec", commandText: "x".repeat(70_000) }),
      "page-b",
    );

    const first = pageOperatorApprovalReceiptsForRun({
      context,
      limit: 1,
      nowMs: 3_000,
      databaseOptions: database,
    });
    expect(first.entries[0]?.receipt.receiptId).toContain("approval:");
    expect(first.nextCursor).toEqual({ occurredAt: 2_000, rowId: expect.any(Number) });
    const firstDisplay = presentExecutionDecisionReceipts({
      context: identityContext,
      decisionCursor: "a:0:0",
      decisionLimit: 1,
      options: { ...database, now: 3_000 },
    }).decisionDisplays[0];
    expect(firstDisplay?.selectorId).toBe(`approval-decision:${first.nextCursor?.rowId}`);
    expect(first.entries[0]?.selectorId).toBe(firstDisplay?.selectorId);
    expect(firstDisplay?.selectorId).not.toBe(first.entries[0]?.receipt.receiptId);
    const receiptSearch = activityRunInspectorSearch(
      { kind: "run", id: context.runId },
      { id: firstDisplay?.selectorId ?? "" },
    );
    expect(new URLSearchParams(receiptSearch.slice(1)).get("receipt")).toBe(
      firstDisplay?.selectorId,
    );
    expect(receiptSearch).not.toContain(
      encodeURIComponent(first.entries[0]?.receipt.receiptId ?? ""),
    );
    expect(
      pageOperatorApprovalReceiptsForRun({
        context,
        after: first.nextCursor,
        limit: 2,
        nowMs: 3_000,
        databaseOptions: database,
      }).entries.map((entry) => entry.receipt),
    ).toEqual([
      expect.objectContaining({
        decision: { outcome: "unknown", reasonCode: "operator_approval_payload_bounded" },
        missingEvidence: ["operator_approval.payload_bounded"],
      }),
      expect.objectContaining({
        decision: { outcome: "denied", reasonCode: "operator_approval_denied_by_reviewer" },
      }),
    ]);
  });

  it("projects each approval page from one owner snapshot without dropping outcomes", () => {
    const database = databaseOptions();
    for (const id of [
      "snapshot-corrupt",
      "snapshot-oversized",
      "snapshot-unlinked",
      "snapshot-valid",
    ]) {
      insertOperatorApproval({ approval: approval(id), databaseOptions: database });
      resolveOperatorApproval({
        id,
        decision: "deny",
        resolver: { kind: "device", id: "reviewer" },
        nowMs: 2_000,
        databaseOptions: database,
      });
    }
    const db = openOpenClawStateDatabase(database).db;
    db.prepare("UPDATE operator_approvals SET presentation_json = ? WHERE approval_id = ?").run(
      "{",
      "snapshot-corrupt",
    );
    db.prepare("UPDATE operator_approvals SET presentation_json = ? WHERE approval_id = ?").run(
      JSON.stringify({ kind: "exec", commandText: "x".repeat(70_000) }),
      "snapshot-oversized",
    );
    db.prepare("DELETE FROM operator_approval_execution_identities WHERE approval_id = ?").run(
      "snapshot-unlinked",
    );
    const expectedSelectors = new Map(
      (
        db
          .prepare(
            "SELECT approval_id, rowid AS receipt_rowid FROM operator_approvals WHERE source_run_id = ?",
          )
          .all(context.runId) as Array<{ approval_id: string; receipt_rowid: number }>
      ).map((row) => [row.approval_id, `approval-decision:${row.receipt_rowid}`]),
    );
    const tracker = trackSqliteStatementExecutions(db, ["approvalPage"] as const, (sqlText) =>
      sqlText.trimStart().toLowerCase().startsWith("select") &&
      sqlText.includes("operator_approvals")
        ? "approvalPage"
        : null,
    );

    try {
      const first = pageOperatorApprovalReceiptsForRun({
        context,
        limit: 2,
        nowMs: 3_000,
        databaseOptions: database,
      });
      const second = pageOperatorApprovalReceiptsForRun({
        context,
        after: first.nextCursor,
        limit: 10,
        nowMs: 3_000,
        databaseOptions: database,
      });
      const entries = [...first.entries, ...second.entries];
      expect(tracker.counts.approvalPage).toBe(2);
      expect(entries).toHaveLength(4);
      expect(entries.map((entry) => entry.receipt.decision.reasonCode)).toEqual([
        "operator_approval_record_corrupt",
        "operator_approval_payload_bounded",
        "operator_approval_execution_link_missing",
        "operator_approval_denied_by_reviewer",
      ]);
      expect(entries.map((entry) => entry.selectorId)).toEqual(
        ["snapshot-corrupt", "snapshot-oversized", "snapshot-unlinked", "snapshot-valid"].map(
          (id) => expectedSelectors.get(id),
        ),
      );
    } finally {
      tracker.restore();
    }
  });

  it("never enforces a later unrelated approval that reuses the retained run id", () => {
    const database = databaseOptions();
    insertOperatorApproval({ approval: approval("retained"), databaseOptions: database });
    insertOperatorApproval({
      approval: approval("later", {
        createdAtMs: 2_000,
        contextId: "context-later",
        executionId: "execution-later",
      }),
      databaseOptions: database,
    });
    for (const [id, nowMs] of [
      ["retained", 3_000],
      ["later", 3_001],
    ] as const) {
      resolveOperatorApproval({
        id,
        decision: "deny",
        resolver: { kind: "device", id: "reviewer" },
        nowMs,
        databaseOptions: database,
      });
    }

    expect(
      pageOperatorApprovalReceiptsForRun({
        context,
        limit: 10,
        nowMs: 4_000,
        databaseOptions: database,
      }).entries.map((entry) => entry.receipt.enforcement.coverageState),
    ).toEqual(["enforced", "unknown"]);
  });

  it("reports missing, malformed, and mismatched execution bindings as unknown", () => {
    for (const [bindingState, reasonCode] of [
      ["missing", "operator_approval_execution_link_missing"],
      ["malformed", "operator_approval_execution_link_malformed"],
      ["mismatch", "operator_approval_execution_link_mismatch"],
    ] as const) {
      const database = databaseOptions();
      insertOperatorApproval({
        approval: approval(`binding-${bindingState}`),
        databaseOptions: database,
      });
      const db = openOpenClawStateDatabase(database).db;
      if (bindingState === "missing") {
        db.prepare("DELETE FROM operator_approval_execution_identities").run();
      } else if (bindingState === "malformed") {
        db.exec("PRAGMA ignore_check_constraints = ON");
        db.prepare(
          "UPDATE operator_approval_execution_identities SET source_context_id = ''",
        ).run();
      } else {
        db.prepare(
          "UPDATE operator_approval_execution_identities SET source_context_id = 'context-other'",
        ).run();
      }
      resolveOperatorApproval({
        id: `binding-${bindingState}`,
        decision: "deny",
        resolver: { kind: "device", id: "reviewer" },
        nowMs: 3_000,
        databaseOptions: database,
      });

      expect(
        pageOperatorApprovalReceiptsForRun({
          context,
          limit: 10,
          nowMs: 4_000,
          databaseOptions: database,
        }).entries.map((entry) => entry.receipt),
      ).toEqual([
        expect.objectContaining({
          decision: { outcome: "unknown", reasonCode },
          enforcement: expect.objectContaining({ coverageState: "unknown", grantRefs: [] }),
          missingEvidence: ["decision.execution_link"],
        }),
      ]);
      closeOpenClawStateDatabaseForTest();
    }
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
      pageOperatorApprovalReceiptsForRun({
        context,
        limit: 10,
        nowMs: RETENTION_MS + 2,
        databaseOptions: database,
      }).entries.map((entry) => entry.receipt),
    ).toEqual([]);
    expect(tableExists(openOpenClawStateDatabase(database).db, "execution_decision_facts")).toBe(
      false,
    );
  });
});
