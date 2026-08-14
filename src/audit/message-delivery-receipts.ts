/** Owner-native outbound message lifecycle projection for run inspection. */
import type {
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OutboundMessageAuditEventRecord } from "./audit-event-types.js";
import {
  countOutboundMessageAuditEventsForRun,
  pageOutboundMessageAuditEventsForRun,
  type OutboundMessageAuditEventCursor,
} from "./message-delivery-audit-store.js";

type MessageDeliveryReadOptions = OpenClawStateDatabaseOptions & { now?: number };

function messageOutcome(
  event: OutboundMessageAuditEventRecord,
): Pick<DecisionReceiptV1, "decision" | "remediation"> {
  switch (event.outcome) {
    case "queued":
      return {
        decision: { outcome: "allowed", reasonCode: "message_queued" },
        remediation: [
          {
            code: "inspect_delivery_progress",
            text: "Inspect this run again to observe the platform and terminal delivery outcome.",
          },
        ],
      };
    case "platform_started":
      return {
        decision: { outcome: "allowed", reasonCode: "message_platform_started" },
        remediation: [
          {
            code: "inspect_delivery_result",
            text: "Inspect this run again for a delivered, failed, or unknown terminal outcome.",
          },
        ],
      };
    case "sent":
      return {
        decision: { outcome: "allowed", reasonCode: "message_delivered" },
        remediation: [],
      };
    case "suppressed":
      return {
        decision: {
          outcome: "not-applicable",
          reasonCode: `message_suppressed_${event.reasonCode}`,
        },
        remediation: [
          {
            code: "revise_suppressed_message",
            text: "Revise the outbound content or remove the suppressing hook before retrying.",
          },
        ],
      };
    case "failed":
      return {
        decision: {
          outcome: "unknown",
          reasonCode: `message_delivery_failed_${event.failureStage}`,
        },
        remediation: [
          {
            code: "inspect_delivery_failure",
            text: "Inspect channel configuration and delivery logs before retrying the message.",
          },
        ],
      };
    case "unknown":
      return {
        decision: {
          outcome: "unknown",
          reasonCode: `message_delivery_unknown_${event.failureStage}`,
        },
        remediation: [
          {
            code: "reconcile_delivery_outcome",
            text: "Reconcile the platform delivery outcome before retrying to avoid a duplicate message.",
          },
        ],
      };
  }
  throw new Error("unsupported outbound message outcome");
}

function projectMessageDeliveryReceipt(
  event: OutboundMessageAuditEventRecord,
  context: ExecutionIdentityContextV1,
): DecisionReceiptV1 {
  const resourceRef = `channel:${event.channel}`;
  const outcome = messageOutcome(event);
  return {
    schemaVersion: 1,
    receiptId: `message:${event.eventId}`,
    contextId: context.contextId,
    executionId: context.executionId,
    runId: context.runId,
    actionId: event.eventId,
    occurredAt: event.occurredAt,
    action: {
      family: "message",
      operation: "send",
      ...(resourceRef.length <= 256 ? { resourceRef } : {}),
      ...(event.targetRef ? { targetRef: event.targetRef } : {}),
      summary: `Outbound message lifecycle: ${event.outcome.replaceAll("_", "-")}.`,
    },
    decision: outcome.decision,
    enforcement: {
      coverageState: "attribution-only",
      evaluatorRef: "outbound-delivery",
      policyRefs: [],
      grantRefs: [],
      contextFieldsUsed: ["runId"],
    },
    source: {
      owner:
        event.action === "message.outbound.finished" ? "audit_events" : "outbound_message_progress",
      recordRef: event.eventId,
      decisionBoundary: event.action,
    },
    // Message audit predates exact execution linkage. Never upgrade transport
    // evidence into an authorization claim merely because the run id matches.
    missingEvidence: ["message.execution_link"],
    remediation: outcome.remediation,
  };
}

export function summarizeMessageDeliveryReceiptsForRun(params: {
  context: ExecutionIdentityContextV1;
  options: MessageDeliveryReadOptions;
}): { count: number; coverageState?: "attribution-only"; missingEvidence: string[] } {
  const count = countOutboundMessageAuditEventsForRun({
    runId: params.context.runId,
    now: params.options.now,
    database: params.options,
  });
  return {
    count,
    ...(count > 0 ? { coverageState: "attribution-only" as const } : {}),
    missingEvidence: count > 0 ? ["message.execution_link"] : [],
  };
}

export function pageMessageDeliveryReceiptsForRun(params: {
  context: ExecutionIdentityContextV1;
  after?: OutboundMessageAuditEventCursor;
  offset?: number;
  limit: number;
  options: MessageDeliveryReadOptions;
}): { receipts: DecisionReceiptV1[]; nextCursor?: OutboundMessageAuditEventCursor } {
  const page = pageOutboundMessageAuditEventsForRun({
    runId: params.context.runId,
    after: params.after,
    offset: params.offset,
    limit: params.limit,
    now: params.options.now,
    database: params.options,
  });
  return {
    receipts: page.events.map((event) => projectMessageDeliveryReceipt(event, params.context)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}
