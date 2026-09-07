/** Bounded receipt projection across admission, owner-native, and generic decision facts. */
import type {
  AuditRunInspectResult,
  DecisionReceiptDisplayV1,
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
  pageOwnerLifecycleReceipts,
  summarizeOwnerLifecycleReceipts,
  type OwnerLifecycleCursor,
  type OwnerLifecycleStage,
} from "./execution-owner-lifecycle-receipts.js";
import {
  pageMessageDeliveryReceiptsForRun,
  summarizeMessageDeliveryReceiptsForRun,
} from "./message-delivery-receipts.js";

type ExecutionDecisionReadOptions = OpenClawStateDatabaseOptions & { now?: number };

export type InternalAuditRunInspectResult = AuditRunInspectResult & {
  decisions: DecisionReceiptV1[];
};

type ProvenancedDecisionReceipt = {
  receipt: DecisionReceiptV1;
  provenance: DecisionReceiptDisplayV1["provenance"];
  selectorId: string;
};

const MAX_AGGREGATE_MISSING_EVIDENCE = 16;
const MISSING_EVIDENCE_TRUNCATED = "decision.missing_evidence_truncated";
type DecisionStage = "approval" | "message" | "generic" | OwnerLifecycleStage;
type DecisionCursor =
  | {
      stage: DecisionStage;
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
  const match = /^([amgctf]):(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(value);
  if (!match) {
    return null;
  }
  const occurredAt = Number(match[2]);
  const rowId = Number(match[3]);
  if (!Number.isSafeInteger(occurredAt) || !Number.isSafeInteger(rowId)) {
    return null;
  }
  const stage =
    match[1] === "a"
      ? "approval"
      : match[1] === "m"
        ? "message"
        : match[1] === "g"
          ? "generic"
          : match[1] === "c"
            ? "cron"
            : match[1] === "t"
              ? "task"
              : "flow";
  return {
    stage,
    ...(occurredAt === 0 && rowId === 0 ? {} : { after: { occurredAt, rowId } }),
  };
}

export function isExecutionDecisionCursor(value: string): boolean {
  return parseDecisionCursor(value) !== null;
}

function formatDecisionCursor(
  stage: DecisionStage,
  cursor?: { occurredAt: number; rowId: number },
): string {
  const prefix = {
    approval: "a",
    message: "m",
    generic: "g",
    cron: "c",
    task: "t",
    flow: "f",
  }[stage];
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

function projectDecisionDisplay({
  receipt,
  provenance,
  selectorId,
}: ProvenancedDecisionReceipt): DecisionReceiptDisplayV1 {
  if (provenance.state === "unverified") {
    return {
      schemaVersion: 1,
      selectorId,
      occurredAt: receipt.occurredAt,
      action: { family: "decision", operation: "record" },
      decision: { outcome: "unknown", reasonCode: "decision_fact_display_unverified" },
      enforcement: {
        coverageState: "unknown",
        policyCount: 0,
        grantCount: 0,
        contextFieldsUsed: [],
      },
      provenance,
      missingEvidence: ["decision.display_provenance"],
      remediation: [],
    };
  }
  const counts = {
    policyCount: receipt.enforcement.policyRefs.length,
    grantCount: receipt.enforcement.grantRefs.length,
  };
  return {
    schemaVersion: 1,
    selectorId,
    occurredAt: receipt.occurredAt,
    action: {
      family: receipt.action.family,
      operation: receipt.action.operation,
      ...(receipt.action.summary ? { summary: receipt.action.summary } : {}),
    },
    decision: receipt.decision,
    enforcement: {
      coverageState: receipt.enforcement.coverageState,
      ...counts,
      contextFieldsUsed: receipt.enforcement.contextFieldsUsed,
    },
    provenance,
    missingEvidence: receipt.missingEvidence,
    remediation: receipt.remediation,
  };
}

export function presentExecutionDecisionReceipts(params: {
  context: ExecutionIdentityContextV1;
  decisionCursor?: string;
  decisionLimit?: number;
  options: ExecutionDecisionReadOptions;
}): InternalAuditRunInspectResult {
  const cursor = parseDecisionCursor(params.decisionCursor);
  if (cursor === null) {
    throw new ExecutionDecisionCursorError();
  }
  const decisionLimit = params.decisionLimit ?? 50;
  const now = params.options.now ?? Date.now();
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
  const cronSummary = summarizeOwnerLifecycleReceipts({
    stage: "cron",
    context: params.context,
    options: params.options,
  });
  const taskSummary = summarizeOwnerLifecycleReceipts({
    stage: "task",
    context: params.context,
    options: params.options,
  });
  const flowSummary = summarizeOwnerLifecycleReceipts({
    stage: "flow",
    context: params.context,
    options: params.options,
  });
  const stages: Array<{
    stage: DecisionStage;
    count: number;
    page: (params: { after?: OwnerLifecycleCursor; offset?: number; limit: number }) => {
      entries: ProvenancedDecisionReceipt[];
      nextCursor?: OwnerLifecycleCursor;
    };
  }> = [
    {
      stage: "approval",
      count: approvalSummary.count,
      page: ({ after, offset, limit }) => {
        const page = pageOperatorApprovalReceiptsForRun({
          context: {
            contextId: params.context.contextId,
            executionId: params.context.executionId,
            runId: params.context.runId,
          },
          after,
          offset,
          limit,
          nowMs: now,
          databaseOptions: params.options,
        });
        return {
          entries: page.entries.map((entry) => ({
            receipt: entry.receipt,
            provenance: { state: "verified", producer: "operator-approval" },
            selectorId: entry.selectorId,
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      },
    },
    {
      stage: "message",
      count: messageSummary.count,
      page: ({ after, offset, limit }) => {
        const page = pageMessageDeliveryReceiptsForRun({
          context: params.context,
          after,
          offset,
          limit,
          options: { ...params.options, now },
        });
        return {
          entries: page.entries.map((entry) => ({
            receipt: entry.receipt,
            provenance: { state: "verified", producer: "message-delivery" },
            selectorId: entry.selectorId,
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      },
    },
    {
      stage: "generic",
      count: genericSummary.count,
      page: ({ after, offset, limit }) => {
        const page = pageExecutionDecisionFactsForContext({
          context: params.context,
          after,
          offset,
          limit,
          now,
          database: params.options,
        });
        return {
          entries: page.entries.map((entry) => ({
            receipt: entry.receipt,
            provenance: { state: "unverified" },
            selectorId: entry.selectorId,
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      },
    },
    ...(["cron", "task", "flow"] as const).map((stage) => ({
      stage,
      count: { cron: cronSummary, task: taskSummary, flow: flowSummary }[stage].count,
      page: ({
        after,
        offset,
        limit,
      }: {
        after?: OwnerLifecycleCursor;
        offset?: number;
        limit: number;
      }) => {
        const page = pageOwnerLifecycleReceipts({
          stage,
          context: params.context,
          after,
          offset,
          limit,
          options: params.options,
        });
        return {
          entries: page.entries.map((entry) => ({
            receipt: entry.receipt,
            provenance: { state: "verified" as const, producer: entry.displayProducer },
            selectorId: entry.selectorId,
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      },
    })),
  ];
  const decisions: ProvenancedDecisionReceipt[] = [];
  let remainingLimit = decisionLimit;
  let nextDecisionCursor: string | undefined;

  if (cursor === undefined && remainingLimit > 0) {
    decisions.push({
      receipt: admissionDecision(params.context),
      provenance: { state: "verified", producer: "run-admission" },
      selectorId: `${params.context.contextId}:admission`,
    });
    remainingLimit -= 1;
    if (remainingLimit === 0 && stages.some((stage) => stage.count > 0)) {
      // The shipped first successor remains the approval cursor even when that owner is empty.
      nextDecisionCursor = formatDecisionCursor("approval");
    }
  }
  let startStage = 0;
  let firstStageOffset: number | undefined;
  if (opaqueCursor) {
    startStage = stages.findIndex((stage) => stage.stage === opaqueCursor.stage);
  } else if (legacyOffset !== undefined) {
    let preceding = 0;
    startStage = stages.findIndex((stage) => {
      if (legacyOffset < preceding + stage.count) {
        firstStageOffset = legacyOffset - preceding;
        return true;
      }
      preceding += stage.count;
      return false;
    });
    if (startStage < 0) {
      startStage = stages.length;
    }
  }
  for (let index = startStage; index < stages.length && remainingLimit > 0; index += 1) {
    const stage = stages[index];
    if (!stage) {
      continue;
    }
    let page;
    try {
      page = stage.page({
        ...(index === startStage && opaqueCursor?.stage === stage.stage
          ? { after: opaqueCursor.after }
          : {}),
        ...(index === startStage && firstStageOffset !== undefined
          ? { offset: firstStageOffset }
          : {}),
        limit: remainingLimit,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("cursor is no longer retained")) {
        throw new ExecutionDecisionCursorError(
          "decision cursor is no longer retained; restart inspection without --cursor",
        );
      }
      throw error;
    }
    decisions.push(...page.entries);
    remainingLimit -= page.entries.length;
    if (page.nextCursor) {
      nextDecisionCursor = formatDecisionCursor(stage.stage, page.nextCursor);
      break;
    }
    if (remainingLimit === 0) {
      const successor = stages.slice(index + 1).find((candidate) => candidate.count > 0);
      nextDecisionCursor = successor ? formatDecisionCursor(successor.stage) : undefined;
    }
  }
  const ownerCoverage = new Set<DecisionReceiptV1["enforcement"]["coverageState"]>(
    [
      approvalSummary.coverageState,
      messageSummary.coverageState,
      cronSummary.coverageState,
      taskSummary.coverageState,
      flowSummary.coverageState,
    ].filter(
      (coverageState): coverageState is NonNullable<typeof coverageState> =>
        coverageState !== undefined,
    ),
  );
  const hasUnverifiedGenericDecisions = genericSummary.count > 0;
  const boundedEvidence = boundMissingEvidence([
    ...params.context.missingEvidence,
    ...approvalSummary.missingEvidence,
    ...messageSummary.missingEvidence,
    ...cronSummary.missingEvidence,
    ...taskSummary.missingEvidence,
    ...flowSummary.missingEvidence,
    ...(hasUnverifiedGenericDecisions ? ["decision.display_provenance"] : []),
  ]);
  const coverageState = boundedEvidence.truncated
    ? "unknown"
    : hasUnverifiedGenericDecisions
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
    decisions: decisions.map(({ receipt }) => receipt),
    decisionDisplays: decisions.map(projectDecisionDisplay),
    coverage: { state: coverageState, missingEvidence: boundedEvidence.missingEvidence },
    ...(nextDecisionCursor ? { nextDecisionCursor } : {}),
  };
}
