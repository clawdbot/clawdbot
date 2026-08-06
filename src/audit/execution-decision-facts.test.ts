import { afterEach, describe, expect, it } from "vitest";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  countExecutionDecisionFactsForContext,
  listExecutionDecisionFactsForContext,
  pruneExpiredExecutionDecisionFacts,
  recordExecutionDecisionFact,
} from "./execution-decision-facts.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-decision-facts-") } };
}

function receipt(id: string, occurredAt = 100): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: id,
    contextId: "context-1",
    executionId: "execution-1",
    runId: "run-1",
    actionId: `action-${id}`,
    occurredAt,
    action: { family: "tool", operation: "policy" },
    decision: { outcome: "denied", reasonCode: "tool_policy_denied" },
    enforcement: {
      coverageState: "enforced",
      evaluatorRef: "tool-policy",
      policyRefs: ["tool-policy:deny"],
      grantRefs: [],
      contextFieldsUsed: ["runId"],
    },
    source: {
      owner: "tool-policy",
      recordRef: `record-${id}`,
      decisionBoundary: "agent-tool.before-call",
    },
    missingEvidence: [],
    remediation: [{ code: "choose_allowed_tool", text: "Choose an allowed tool and retry." }],
  };
}

describe("execution decision facts", () => {
  it("stays absent until a future owner writes one immutable fact", () => {
    const database = databaseOptions();
    const opened = openOpenClawStateDatabase(database);
    expect(tableExists(opened.db, "execution_decision_facts")).toBe(false);
    expect(pruneExpiredExecutionDecisionFacts({ database })).toBe(0);
    expect(tableExists(opened.db, "execution_decision_facts")).toBe(false);

    expect(recordExecutionDecisionFact(receipt("receipt-1"), { ...database, now: 100 })).toBe(
      "inserted",
    );
    expect(recordExecutionDecisionFact(receipt("receipt-1"), { ...database, now: 100 })).toBe(
      "existing",
    );
    expect(() =>
      recordExecutionDecisionFact(
        { ...receipt("receipt-1"), decision: { outcome: "allowed", reasonCode: "changed" } },
        { ...database, now: 100 },
      ),
    ).toThrow("conflicts with retained state");

    expect(
      countExecutionDecisionFactsForContext({ contextId: "context-1", now: 100, database }),
    ).toBe(1);
    expect(
      listExecutionDecisionFactsForContext({
        contextId: "context-1",
        offset: 0,
        limit: 10,
        now: 100,
        database,
      }),
    ).toEqual([receipt("receipt-1")]);
  });

  it("rejects approval duplication before creating the generic table", () => {
    const database = databaseOptions();
    expect(() =>
      recordExecutionDecisionFact(
        {
          ...receipt("approval-duplicate"),
          source: {
            owner: "operator_approvals",
            recordRef: "approval-ref",
            decisionBoundary: "gateway.operator-approval.first-answer",
          },
        },
        { ...database, now: 100 },
      ),
    ).toThrow("owner-native table");
    expect(tableExists(openOpenClawStateDatabase(database).db, "execution_decision_facts")).toBe(
      false,
    );
  });

  it("enforces the 30-day read boundary and bounded retention pruning", () => {
    const database = databaseOptions();
    recordExecutionDecisionFact(receipt("old", 0), { ...database, now: 0 });
    recordExecutionDecisionFact(receipt("new", RETENTION_MS + 1), {
      ...database,
      now: RETENTION_MS + 1,
      limits: { maxRows: 10, pruneBatchRows: 1 },
    });

    expect(
      listExecutionDecisionFactsForContext({
        contextId: "context-1",
        offset: 0,
        limit: 10,
        now: RETENTION_MS + 1,
        database,
      }).map((item) => item.receiptId),
    ).toEqual(["new"]);
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT COUNT(*) AS count FROM execution_decision_facts")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("caps retained facts without accepting a non-identical receipt id", () => {
    const database = databaseOptions();
    for (const [index, id] of ["one", "two", "three"].entries()) {
      recordExecutionDecisionFact(receipt(id, 100 + index), {
        ...database,
        now: 100 + index,
        limits: { maxRows: 2, pruneBatchRows: 1 },
      });
    }
    expect(
      listExecutionDecisionFactsForContext({
        contextId: "context-1",
        offset: 0,
        limit: 10,
        now: 200,
        database,
      }).map((item) => item.receiptId),
    ).toEqual(["two", "three"]);
  });

  it("turns corrupt retained payloads into bounded unknown receipts", () => {
    const database = databaseOptions();
    recordExecutionDecisionFact(receipt("corrupt"), { ...database, now: 100 });
    openOpenClawStateDatabase(database)
      .db.prepare("UPDATE execution_decision_facts SET receipt_json = ? WHERE receipt_id = ?")
      .run("{", "corrupt");

    expect(
      listExecutionDecisionFactsForContext({
        contextId: "context-1",
        offset: 0,
        limit: 10,
        now: 100,
        database,
      }),
    ).toEqual([
      expect.objectContaining({
        receiptId: "corrupt",
        decision: { outcome: "unknown", reasonCode: "decision_fact_record_corrupt" },
        enforcement: expect.objectContaining({ coverageState: "unknown" }),
        missingEvidence: ["decision.fact.valid"],
      }),
    ]);
  });
});
