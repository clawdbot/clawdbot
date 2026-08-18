/** Bounded receipt projection across admission, owner-native, and generic decision facts. */
import type {
  AuditRunInspectResult,
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import {
  pageOperatorApprovalReceiptsForRun,
  summarizeOperatorApprovalReceiptsForRun,
} from "../gateway/operator-approval-store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { parsePositiveAuditCursor } from "./audit-cursor.js";
import {
  pageExecutionDecisionFactsForContext,
  summarizeExecutionDecisionFactsForContext,
} from "./execution-decision-facts.js";
import {
  pageMessageDeliveryReceiptsForRun,
  summarizeMessageDeliveryReceiptsForRun,
} from "./message-delivery-receipts.js";

type ExecutionDecisionReadOptions = OpenClawStateDatabaseOptions & { now?: number };

const MAX_AGGREGATE_MISSING_EVIDENCE = 16;
const MISSING_EVIDENCE_TRUNCATED = "decision.missing_evidence_truncated";
type DecisionCursor =
  | {
      stage: "approval" | "message" | "generic";
      after?: { occurredAt: number; rowId: number };
    }
  | {
      offset: number;
    };

export class ExecutionDecisionCursorError extends Error {
  constructor(message = "invalid execution decision cursor") {
    super(message);
    this.name = "ExecutionDecisionCursorError";
  }
}

function parseDecisionCursor(value: string | undefined): DecisionCursor | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  const offset = parsePositiveAuditCursor(value);
  if (offset !== null && offset !== undefined) {
    return { offset };
  }
  const match = /^([amg]):(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(value);
  if (!match) {
    return null;
  }
  const occurredAt = Number(match[2]);
  const rowId = Number(match[3]);
  if (!Number.isSafeInteger(occurredAt) || !Number.isSafeInteger(rowId)) {
    return null;
  }
  return {
    stage: match[1] === "a" ? "approval" : match[1] === "m" ? "message" : "generic",
    ...(occurredAt === 0 && rowId === 0 ? {} : { after: { occurredAt, rowId } }),
  };
}

export function isExecutionDecisionCursor(value: string): boolean {
  return parseDecisionCursor(value) !== null;
}

function formatDecisionCursor(
  stage: "approval" | "message" | "generic",
  cursor?: { occurredAt: number; rowId: number },
): string {
  const prefix = stage === "approval" ? "a" : stage === "message" ? "m" : "g";
  return `${prefix}:${cursor?.occurredAt ?? 0}:${cursor?.rowId ?? 0}`;
}

function boundMissingEvidence(values: readonly string[]): {
  missingEvidence: string[];
  truncated: boolean;
} {
  const unique = [...new Set(values)].toSorted();
  if (unique.length <= MAX_AGGREGATE_MISSING_EVIDENCE) {
    return { missingEvidence: unique, truncated: false };
  }
  return {
    missingEvidence: [
      ...unique
        .filter((value) => value !== MISSING_EVIDENCE_TRUNCATED)
        .slice(0, MAX_AGGREGATE_MISSING_EVIDENCE - 1),
      MISSING_EVIDENCE_TRUNCATED,
    ].toSorted(),
    truncated: true,
  };
}

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
  decisionCursor?: string;
  decisionLimit?: number;
  options: ExecutionDecisionReadOptions;
}): AuditRunInspectResult {
  const cursor = parseDecisionCursor(params.decisionCursor);
  if (cursor === null) {
    throw new ExecutionDecisionCursorError();
  }
  const limit = params.decisionLimit ?? 50;
  const now = params.options.now ?? Date.now();
  // Numeric cursors are the shipped aggregate offset. Resolve its owner span
  // once, then let the canonical bounded owner pagers emit opaque successors.
  const opaqueCursor = cursor && "stage" in cursor ? cursor : undefined;
  const legacyOffset = cursor && "offset" in cursor ? cursor.offset - 1 : undefined;
  const approvalSummary = summarizeOperatorApprovalReceiptsForRun({
    context: {
      contextId: params.context.contextId,
      executionId: params.context.executionId,
      runId: params.context.runId,
    },
    nowMs: now,
    databaseOptions: params.options,
    exactCount: legacyOffset !== undefined,
  });
  const genericSummary = summarizeExecutionDecisionFactsForContext({
    context: params.context,
    now,
    database: params.options,
  });
  const messageSummary = summarizeMessageDeliveryReceiptsForRun({
    context: params.context,
    options: { ...params.options, now },
  });
  const decisions: DecisionReceiptV1[] = [];
  let remainingLimit = limit;
  let nextDecisionCursor: string | undefined;
  const approvalOffset =
    legacyOffset !== undefined && legacyOffset < approvalSummary.count ? legacyOffset : undefined;

  if (cursor === undefined && remainingLimit > 0) {
    decisions.push(admissionDecision(params.context));
    remainingLimit -= 1;
    if (
      remainingLimit === 0 &&
      (approvalSummary.count > 0 || messageSummary.count > 0 || genericSummary.count > 0)
    ) {
      nextDecisionCursor = formatDecisionCursor("approval");
    }
  }
  if (
    remainingLimit > 0 &&
    opaqueCursor?.stage !== "message" &&
    opaqueCursor?.stage !== "generic" &&
    (legacyOffset === undefined || approvalOffset !== undefined)
  ) {
    let page;
    try {
      page = pageOperatorApprovalReceiptsForRun({
        context: {
          contextId: params.context.contextId,
          executionId: params.context.executionId,
          runId: params.context.runId,
        },
        after: opaqueCursor?.stage === "approval" ? opaqueCursor.after : undefined,
        offset: approvalOffset,
        limit: remainingLimit,
        nowMs: now,
        databaseOptions: params.options,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("cursor is no longer retained")) {
        throw new ExecutionDecisionCursorError(
          "decision cursor is no longer retained; restart inspection without --cursor",
        );
      }
      throw error;
    }
    decisions.push(...page.receipts);
    remainingLimit -= page.receipts.length;
    if (page.nextCursor) {
      nextDecisionCursor = formatDecisionCursor("approval", page.nextCursor);
    } else if (remainingLimit === 0 && messageSummary.count > 0) {
      nextDecisionCursor = formatDecisionCursor("message");
    } else if (remainingLimit === 0 && genericSummary.count > 0) {
      nextDecisionCursor = formatDecisionCursor("generic");
    }
  }
  const messageOffset =
    legacyOffset === undefined
      ? undefined
      : legacyOffset >= approvalSummary.count &&
          legacyOffset < approvalSummary.count + messageSummary.count
        ? legacyOffset - approvalSummary.count
        : undefined;
  if (
    remainingLimit > 0 &&
    nextDecisionCursor?.startsWith("a:") !== true &&
    opaqueCursor?.stage !== "generic" &&
    (legacyOffset === undefined || messageOffset !== undefined || approvalOffset !== undefined)
  ) {
    let page;
    try {
      page = pageMessageDeliveryReceiptsForRun({
        context: params.context,
        after: opaqueCursor?.stage === "message" ? opaqueCursor.after : undefined,
        offset: messageOffset,
        limit: remainingLimit,
        options: { ...params.options, now },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("cursor is no longer retained")) {
        throw new ExecutionDecisionCursorError(
          "decision cursor is no longer retained; restart inspection without --cursor",
        );
      }
      throw error;
    }
    decisions.push(...page.receipts);
    remainingLimit -= page.receipts.length;
    if (page.nextCursor) {
      nextDecisionCursor = formatDecisionCursor("message", page.nextCursor);
    } else if (remainingLimit === 0 && genericSummary.count > 0) {
      nextDecisionCursor = formatDecisionCursor("generic");
    }
  }
  const genericOffset =
    legacyOffset === undefined
      ? undefined
      : Math.max(0, legacyOffset - approvalSummary.count - messageSummary.count);
  if (
    remainingLimit > 0 &&
    nextDecisionCursor?.startsWith("a:") !== true &&
    nextDecisionCursor?.startsWith("m:") !== true
  ) {
    let page;
    try {
      page = pageExecutionDecisionFactsForContext({
        context: params.context,
        after: opaqueCursor?.stage === "generic" ? opaqueCursor.after : undefined,
        offset: genericOffset,
        limit: remainingLimit,
        now,
        database: params.options,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("cursor is no longer retained")) {
        throw new ExecutionDecisionCursorError(
          "decision cursor is no longer retained; restart inspection without --cursor",
        );
      }
      throw error;
    }
    decisions.push(...page.receipts);
    if (page.nextCursor) {
      nextDecisionCursor = formatDecisionCursor("generic", page.nextCursor);
    } else {
      nextDecisionCursor = undefined;
    }
  }
  const ownerCoverage = new Set([
    approvalSummary.coverageState,
    messageSummary.coverageState,
    genericSummary.coverageState,
  ]);
  const boundedEvidence = boundMissingEvidence([
    ...params.context.missingEvidence,
    ...approvalSummary.missingEvidence,
    ...messageSummary.missingEvidence,
    ...genericSummary.missingEvidence,
  ]);
  const coverageState = boundedEvidence.truncated
    ? "unknown"
    : ownerCoverage.has("unsupported")
      ? "unsupported"
      : ownerCoverage.has("unknown")
        ? "unknown"
        : ownerCoverage.has("enforced")
          ? "enforced"
          : ownerCoverage.has("attribution-only")
            ? "attribution-only"
            : params.context.coverageState;
  return {
    schemaVersion: 1,
    run: {
      runId: params.context.runId,
      executionId: params.context.executionId,
      status: "known",
    },
    identity: { state: "present", context: params.context },
    decisions,
    coverage: { state: coverageState, missingEvidence: boundedEvidence.missingEvidence },
    ...(nextDecisionCursor ? { nextDecisionCursor } : {}),
  };
}
