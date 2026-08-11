import { afterEach, describe, expect, it } from "vitest";
import type {
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  listExecutionDecisionFactsForContext,
  pruneExpiredExecutionDecisionFacts,
  recordExecutionDecisionFact,
  summarizeExecutionDecisionFactsForContext,
} from "./execution-decision-facts.js";
import { presentExecutionDecisionReceipts } from "./execution-decision-receipts.js";
import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionEnvelope,
} from "./execution-identity-admission.js";
import { processExecutionIdentityAdmissionWork } from "./execution-identity-context.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-decision-facts-") } };
}

function seedExecutionContext(database: ReturnType<typeof databaseOptions>): void {
  let envelope: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((work) => {
    if (work.kind === "capture") {
      envelope = work.envelope;
    }
    return true;
  });
  try {
    enqueueExecutionIdentityContextAtAdmission(
      {
        runId: "run-1",
        agentId: "main",
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
        runtime: { kind: "embedded" },
      },
      {
        enabled: true,
        now: 50,
        contextId: "context-1",
        executionId: "execution-1",
        runtimeInstanceId: "runtime-1",
      },
    );
  } finally {
    clear();
  }
  if (!envelope) {
    throw new Error("expected execution identity envelope");
  }
  const stored = processExecutionIdentityAdmissionWork(
    { kind: "capture", envelope },
    { ...database, now: 50 },
  );
  if (
    stored.contextId !== "context-1" ||
    stored.executionId !== "execution-1" ||
    stored.runId !== "run-1"
  ) {
    throw new Error(`unexpected execution context: ${JSON.stringify(stored)}`);
  }
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
    seedExecutionContext(database);
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
      listExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        offset: 0,
        limit: 10,
        now: 100,
        database,
      }),
    ).toEqual([receipt("receipt-1")]);
    expect(
      summarizeExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        now: 100,
        database,
      }),
    ).toEqual({ count: 1, coverageState: "enforced", missingEvidence: [] });
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

  it("rejects a generic fact whose context, execution, and run tuple is not exact", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    expect(() =>
      recordExecutionDecisionFact(
        { ...receipt("wrong-execution"), executionId: "execution-2" },
        database,
      ),
    ).toThrow("exact retained execution context");
    expect(tableExists(openOpenClawStateDatabase(database).db, "execution_decision_facts")).toBe(
      false,
    );
  });

  it("projects a fact as unknown when the requested tuple does not match", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    recordExecutionDecisionFact(receipt("tuple-mismatch"), { ...database, now: 100 });

    expect(
      listExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-2", runId: "run-1" },
        offset: 0,
        limit: 10,
        now: 100,
        database,
      }),
    ).toEqual([
      expect.objectContaining({
        decision: { outcome: "unknown", reasonCode: "decision_fact_execution_link_mismatch" },
        enforcement: expect.objectContaining({ coverageState: "unknown" }),
        missingEvidence: ["decision.execution_link"],
      }),
    ]);
  });

  it("enforces the 30-day read boundary and bounded retention pruning", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    recordExecutionDecisionFact(receipt("old", 0), { ...database, now: 0 });
    recordExecutionDecisionFact(receipt("new", RETENTION_MS + 1), {
      ...database,
      now: RETENTION_MS + 1,
      limits: { maxRows: 10, pruneBatchRows: 1 },
    });

    expect(
      listExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
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
    seedExecutionContext(database);
    for (const [index, id] of ["one", "two", "three"].entries()) {
      recordExecutionDecisionFact(receipt(id, 100 + index), {
        ...database,
        now: 100 + index,
        limits: { maxRows: 2, pruneBatchRows: 1 },
      });
    }
    expect(
      listExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        offset: 0,
        limit: 10,
        now: 200,
        database,
      }).map((item) => item.receiptId),
    ).toEqual(["two", "three"]);
  });

  it("turns corrupt retained payloads into bounded unknown receipts", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    const context: ExecutionIdentityContextV1 = {
      schemaVersion: 1,
      contextId: "context-1",
      executionId: "execution-1",
      runId: "run-1",
      createdAt: 50,
      trustDomain: { kind: "gateway-cell", domainRef: "domain-1", state: "present" },
      invoker: { state: "absent" },
      ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      agentPrincipal: { kind: "agent", domainRef: "domain-1", principalRef: "agent-main" },
      agentDefinition: { definitionRef: "main", state: "present" },
      runtimeInstance: { runtimeRef: "runtime-1", kind: "embedded", state: "present" },
      applicableGrants: [],
      assurance: [],
      coverageState: "unattributed",
      missingEvidence: [],
    };
    recordExecutionDecisionFact(receipt("corrupt"), { ...database, now: 100 });
    openOpenClawStateDatabase(database)
      .db.prepare("UPDATE execution_decision_facts SET receipt_json = ? WHERE receipt_id = ?")
      .run("{", "corrupt");

    expect(
      listExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
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
    expect(
      summarizeExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        now: 100,
        database,
      }),
    ).toEqual({
      count: 1,
      coverageState: "unknown",
      missingEvidence: ["decision.fact.valid"],
    });
    expect(
      presentExecutionDecisionReceipts({
        context,
        decisionLimit: 1,
        options: { ...database, now: 100 },
      }),
    ).toMatchObject({
      coverage: {
        state: "unknown",
        missingEvidence: expect.arrayContaining(["decision.fact.valid"]),
      },
      decisions: [{ decision: { outcome: "not-applicable" } }],
      nextDecisionCursor: "1",
    });
  });
});
