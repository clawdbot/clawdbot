/** Bounded receipt projection across admission, owner-native, and generic decision facts. */
import type {
  AuditRunInspectResult,
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import {
  listOperatorApprovalReceiptsForRun,
  summarizeOperatorApprovalReceiptsForRun,
} from "../gateway/operator-approval-store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  listExecutionDecisionFactsForContext,
  summarizeExecutionDecisionFactsForContext,
} from "./execution-decision-facts.js";

type ExecutionDecisionReadOptions = OpenClawStateDatabaseOptions & { now?: number };

function admissionDecision(context: ExecutionIdentityContextV1): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: `${context.contextId}:admission`,
    contextId: context.contextId,
    executionId: context.executionId,
    runId: context.runId,
    occurredAt: context.createdAt,
    action: {
      family: "run",
      operation: "admission",
      summary: "Run admission was recorded without an identity-aware policy or grant decision.",
    },
    decision: {
      outcome: "not-applicable",
      reasonCode: "run_admission_identity_not_evaluated",
    },
    enforcement: {
      coverageState: context.coverageState,
      policyRefs: [],
      grantRefs: [],
      contextFieldsUsed: [],
    },
    source: {
      owner: "agent-command",
      recordRef: context.contextId,
      decisionBoundary: "agent-command.run-admission",
    },
    missingEvidence: [...context.missingEvidence],
    remediation: [
      {
        code: "no_identity_enforcement_claimed",
        text: "Treat this receipt as attribution only; it does not prove authorization.",
      },
    ],
  };
}

export function presentExecutionDecisionReceipts(params: {
  context: ExecutionIdentityContextV1;
  decisionOffset?: number;
  decisionLimit?: number;
  approvalLinkState: "unambiguous" | "ambiguous";
  options: ExecutionDecisionReadOptions;
}): AuditRunInspectResult {
  const offset = params.decisionOffset ?? 0;
  const limit = params.decisionLimit ?? 50;
  const now = params.options.now ?? Date.now();
  const approvalSummary = summarizeOperatorApprovalReceiptsForRun({
    context: {
      contextId: params.context.contextId,
      executionId: params.context.executionId,
      runId: params.context.runId,
      createdAt: params.context.createdAt,
    },
    linkState: params.approvalLinkState,
    nowMs: now,
    databaseOptions: params.options,
  });
  const approvalCount = approvalSummary.count;
  const genericSummary = summarizeExecutionDecisionFactsForContext({
    contextId: params.context.contextId,
    now,
    database: params.options,
  });
  const genericCount = genericSummary.count;
  const totalDecisions = 1 + approvalCount + genericCount;
  const decisions: DecisionReceiptV1[] = [];
  let remainingOffset = offset;
  let remainingLimit = limit;

  if (remainingOffset === 0 && remainingLimit > 0) {
    decisions.push(admissionDecision(params.context));
    remainingLimit -= 1;
  } else {
    remainingOffset = Math.max(0, remainingOffset - 1);
  }
  if (remainingLimit > 0 && remainingOffset < approvalCount) {
    const page = listOperatorApprovalReceiptsForRun({
      context: {
        contextId: params.context.contextId,
        executionId: params.context.executionId,
        runId: params.context.runId,
        createdAt: params.context.createdAt,
      },
      linkState: params.approvalLinkState,
      offset: remainingOffset,
      limit: remainingLimit,
      nowMs: now,
      databaseOptions: params.options,
    });
    decisions.push(...page);
    remainingLimit -= page.length;
    remainingOffset = 0;
  } else {
    remainingOffset = Math.max(0, remainingOffset - approvalCount);
  }
  if (remainingLimit > 0 && remainingOffset < genericCount) {
    decisions.push(
      ...listExecutionDecisionFactsForContext({
        contextId: params.context.contextId,
        offset: remainingOffset,
        limit: remainingLimit,
        now,
        database: params.options,
      }),
    );
  }
  const nextOffset = offset + decisions.length;
  const ownerCoverage = new Set([approvalSummary.coverageState, genericSummary.coverageState]);
  const coverageState = ownerCoverage.has("unsupported")
    ? "unsupported"
    : ownerCoverage.has("unknown")
      ? "unknown"
      : ownerCoverage.has("enforced")
        ? "enforced"
        : params.context.coverageState;
  const missingEvidence = [
    ...new Set([
      ...params.context.missingEvidence,
      ...approvalSummary.missingEvidence,
      ...genericSummary.missingEvidence,
    ]),
  ].toSorted();
  return {
    schemaVersion: 1,
    run: {
      runId: params.context.runId,
      executionId: params.context.executionId,
      status: "known",
    },
    identity: { state: "present", context: params.context },
    decisions,
    coverage: { state: coverageState, missingEvidence },
    ...(nextOffset < totalDecisions ? { nextDecisionCursor: String(nextOffset) } : {}),
  };
}
