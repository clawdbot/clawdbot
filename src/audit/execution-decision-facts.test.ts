import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuditRunInspectResultSchema,
  type DecisionReceiptV1,
  type ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEvent } from "./audit-event-store.js";
import {
  pageExecutionDecisionFactsForContext,
  pruneExpiredExecutionDecisionFacts,
  recordExecutionDecisionFact,
  summarizeExecutionDecisionFactsForContext,
} from "./execution-decision-facts.js";
import { presentExecutionDecisionReceipts } from "./execution-decision-receipts.js";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionEnvelope,
} from "./execution-identity-admission.js";
import { processExecutionIdentityAdmissionWork } from "./execution-identity-context.js";
import {
  configureMessageActionDecisionSink,
  recordMessageActionDecision,
} from "./message-action-decision.js";
import { recordOutboundMessageProgress } from "./message-delivery-progress-store.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-decision-facts-") } };
}

function seedExecutionContext(
  database: ReturnType<typeof databaseOptions>,
): ExecutionIdentityContextV1 {
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
  return stored;
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
  it("persists repeated same-reason broadcast denials with opaque distinct ids", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    const token = createExecutionIdentityAdmissionToken("run-1", {
      contextId: "context-1",
      executionId: "execution-1",
      now: 100,
    });
    const clear = configureMessageActionDecisionSink(
      (decision) => recordExecutionDecisionFact(decision, { ...database, now: 100 }) === "inserted",
    );
    try {
      for (const receiptDiscriminator of ["broadcast:0", "broadcast:1"]) {
        expect(
          recordMessageActionDecision({
            token,
            actionId: "broadcast-action",
            action: "broadcast",
            channel: "qa-channel",
            outcome: "denied",
            reasonCode: "message_target_unknown",
            coverageState: "enforced",
            policyRefs: ["message-target:known"],
            summary: "Message action was denied before platform delivery.",
            remediation: [],
            receiptDiscriminator,
            occurredAt: 100,
          }),
        ).toBe(true);
      }
    } finally {
      clear();
    }

    const receipts = pageExecutionDecisionFactsForContext({
      context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
      limit: 10,
      now: 100,
      database,
    }).receipts;
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((item) => item.receiptId)).size).toBe(2);
    expect(JSON.stringify(receipts)).not.toContain("broadcast:0");
    expect(JSON.stringify(receipts)).not.toContain("broadcast:1");
  });

  it("projects owner-native outbound delivery into run inspection", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const now = Date.now();
    recordAuditEvent(
      {
        sourceId: "message:outbound:queue:delivery-1:payload:0",
        sourceSequence: 1,
        occurredAt: now,
        kind: "message",
        action: "message.outbound.finished",
        status: "succeeded",
        outcome: "sent",
        actorType: "agent",
        actorId: "main",
        agentId: "main",
        runId: "run-1",
        direction: "outbound",
        channel: "qa-channel",
        conversationKind: "direct",
        resultCount: 1,
        targetId: "raw-target",
        messageId: "raw-message-id",
      },
      database,
    );

    expect(
      presentExecutionDecisionReceipts({
        context,
        decisionLimit: 10,
        options: { ...database, now },
      }).decisions,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.objectContaining({ family: "message", operation: "send" }),
          decision: { outcome: "allowed", reasonCode: "message_delivered" },
          enforcement: expect.objectContaining({ coverageState: "attribution-only" }),
          source: expect.objectContaining({ owner: "audit_events" }),
        }),
      ]),
    );
  });

  it("keeps delivery stages distinct, redacted, replay-safe, and retention bounded", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const now = Date.now();
    const common = {
      sourceSequence: 1,
      occurredAt: now,
      kind: "message" as const,
      actorType: "agent" as const,
      actorId: "main",
      agentId: "main",
      runId: "run-1",
      direction: "outbound" as const,
      channel: "qa-channel",
      conversationKind: "direct" as const,
      targetId: "raw-channel-target",
    };
    const events = [
      {
        ...common,
        occurredAt: now,
        sourceId: "queue-1:queued",
        action: "message.outbound.queued" as const,
        status: "started" as const,
        outcome: "queued" as const,
      },
      {
        ...common,
        occurredAt: now + 1,
        sourceId: "queue-1:platform",
        action: "message.outbound.platform-started" as const,
        status: "started" as const,
        outcome: "platform_started" as const,
      },
      {
        ...common,
        occurredAt: now + 2,
        sourceId: "queue-1:finished",
        action: "message.outbound.finished" as const,
        status: "succeeded" as const,
        outcome: "sent" as const,
        messageId: "raw-platform-message",
      },
      {
        ...common,
        occurredAt: now + 3,
        sourceId: "queue-2:failed",
        action: "message.outbound.finished" as const,
        status: "failed" as const,
        outcome: "failed" as const,
        errorCode: "message_delivery_failed" as const,
        failureStage: "queue" as const,
      },
      {
        ...common,
        occurredAt: now + 4,
        sourceId: "queue-3:failed",
        action: "message.outbound.finished" as const,
        status: "failed" as const,
        outcome: "failed" as const,
        errorCode: "message_delivery_failed" as const,
        failureStage: "platform_send" as const,
      },
      {
        ...common,
        occurredAt: now + 5,
        sourceId: "queue-4:suppressed",
        action: "message.outbound.finished" as const,
        status: "blocked" as const,
        outcome: "suppressed" as const,
        reasonCode: "no_visible_payload" as const,
      },
    ];
    for (const event of events) {
      expect(
        event.action === "message.outbound.finished"
          ? recordAuditEvent(event, database)
          : recordOutboundMessageProgress(event, database),
      ).toBeDefined();
    }
    expect(
      recordOutboundMessageProgress(
        {
          ...common,
          occurredAt: now,
          sourceId: "queue-1:queued",
          action: "message.outbound.queued",
          status: "started",
          outcome: "queued",
        },
        database,
      ),
    ).toBeUndefined();

    const inspect = () =>
      presentExecutionDecisionReceipts({
        context,
        decisionCursor: "m:0:0",
        decisionLimit: 10,
        options: { ...database, now },
      });
    expect(inspect().decisions.map((item) => item.decision.reasonCode)).toEqual([
      "message_queued",
      "message_platform_started",
      "message_delivered",
      "message_delivery_failed_queue",
      "message_delivery_failed_platform_send",
      "message_suppressed_no_visible_payload",
    ]);
    expect(inspect().decisions.map((item) => item.enforcement.coverageState)).toEqual(
      Array.from({ length: 6 }, () => "attribution-only"),
    );
    expect(inspect().decisions.map((item) => item.source.owner)).toEqual([
      "outbound_message_progress",
      "outbound_message_progress",
      "audit_events",
      "audit_events",
      "audit_events",
      "audit_events",
    ]);
    expect(JSON.stringify(inspect())).not.toContain("raw-channel-target");
    expect(JSON.stringify(inspect())).not.toContain("raw-platform-message");

    closeOpenClawStateDatabaseForTest();
    expect(inspect().decisions).toHaveLength(6);
    expect(
      presentExecutionDecisionReceipts({
        context,
        decisionCursor: "m:0:0",
        decisionLimit: 10,
        options: { ...database, now: now + RETENTION_MS + events.length + 1 },
      }).decisions,
    ).toEqual([]);
  });

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
      pageExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 10,
        now: 100,
        database,
      }).receipts,
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

  it("keeps high-cardinality summary work bounded and conservative", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    for (let index = 0; index < 130; index += 1) {
      recordExecutionDecisionFact(receipt(`bounded-${String(index).padStart(3, "0")}`), {
        ...database,
        now: 100,
        limits: { maxRows: 1_000, pruneBatchRows: 10 },
      });
    }

    expect(
      summarizeExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        now: 100,
        database,
      }),
    ).toEqual({
      count: 129,
      coverageState: "unknown",
      missingEvidence: ["decision.fact.summary_bounded"],
    });
  });

  it("pages equal-time facts by a bounded row key", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    for (const id of ["same-time-a", "same-time-b", "same-time-c"]) {
      recordExecutionDecisionFact(receipt(id, 100), { ...database, now: 100 });
    }

    const first = pageExecutionDecisionFactsForContext({
      context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
      limit: 1,
      now: 100,
      database,
    });
    expect(first.receipts.map((item) => item.receiptId)).toEqual(["same-time-a"]);
    expect(first.nextCursor).toEqual({ occurredAt: 100, rowId: expect.any(Number) });
    expect(
      pageExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        after: first.nextCursor,
        limit: 2,
        now: 100,
        database,
      }).receipts.map((item) => item.receiptId),
    ).toEqual(["same-time-b", "same-time-c"]);

    for (const decisionCursor of ["1", "001"]) {
      const legacyPage = presentExecutionDecisionReceipts({
        context,
        decisionCursor,
        decisionLimit: 1,
        options: { ...database, now: 100 },
      });
      expect(legacyPage.decisions.map((item) => item.receiptId)).toEqual(["same-time-a"]);
      expect(legacyPage.nextDecisionCursor).toMatch(/^g:/);
    }
    const legacyPage = presentExecutionDecisionReceipts({
      context,
      decisionCursor: "1",
      decisionLimit: 1,
      options: { ...database, now: 100 },
    });
    expect(
      presentExecutionDecisionReceipts({
        context,
        decisionCursor: legacyPage.nextDecisionCursor,
        decisionLimit: 2,
        options: { ...database, now: 100 },
      }).decisions.map((item) => item.receiptId),
    ).toEqual(["same-time-b", "same-time-c"]);
  });

  it("bounds aggregated missing evidence at the result protocol boundary", () => {
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
    for (const owner of ["one", "two"] as const) {
      recordExecutionDecisionFact(
        {
          ...receipt(owner),
          missingEvidence: Array.from(
            { length: 16 },
            (_, index) => `${owner}.missing.${String(index).padStart(2, "0")}`,
          ),
        },
        { ...database, now: 100 },
      );
    }

    const result = presentExecutionDecisionReceipts({
      context,
      decisionLimit: 10,
      options: { ...database, now: 100 },
    });
    expect(result.coverage).toEqual({
      state: "unknown",
      missingEvidence: expect.arrayContaining(["decision.missing_evidence_truncated"]),
    });
    expect(result.coverage.missingEvidence).toHaveLength(16);
    expect(Compile(AuditRunInspectResultSchema).Check(result)).toBe(true);
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
      pageExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-2", runId: "run-1" },
        limit: 10,
        now: 100,
        database,
      }).receipts,
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
      pageExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 10,
        now: RETENTION_MS + 1,
        database,
      }).receipts.map((item) => item.receiptId),
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
      pageExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 10,
        now: 200,
        database,
      }).receipts.map((item) => item.receiptId),
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
      pageExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 10,
        now: 100,
        database,
      }).receipts,
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
      nextDecisionCursor: "a:0:0",
    });
  });

  it("does not materialize an oversized retained fact payload", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    recordExecutionDecisionFact(receipt("oversized"), { ...database, now: 100 });
    const db = openOpenClawStateDatabase(database).db;
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE execution_decision_facts SET receipt_json = ? WHERE receipt_id = ?").run(
      "x".repeat(20_000),
      "oversized",
    );

    expect(
      pageExecutionDecisionFactsForContext({
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 1,
        now: 100,
        database,
      }).receipts,
    ).toEqual([
      expect.objectContaining({
        decision: { outcome: "unknown", reasonCode: "decision_fact_payload_bounded" },
        missingEvidence: ["decision.fact.payload_bounded"],
      }),
    ]);
  });
});
