// Slack plugin module owns its transport-private approval callback envelope.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import type { MessagePresentationAction } from "openclaw/plugin-sdk/interactive-runtime";
import { SLACK_BUTTON_VALUE_MAX } from "./presentation.js";

const SLACK_APPROVAL_VALUE_PREFIX = "openclaw:approval:v1:";

export type SlackApprovalAction = Extract<MessagePresentationAction, { type: "approval" }>;

function isApprovalDecision(value: unknown): value is SlackApprovalAction["decision"] {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

/** Encode portable approval facts without exposing a slash command to Slack callbacks. */
export function encodeSlackApprovalAction(action: SlackApprovalAction): string {
  const encode = (approvalId: string) =>
    `${SLACK_APPROVAL_VALUE_PREFIX}${JSON.stringify({
      approvalId,
      approvalKind: action.approvalKind,
      decision: action.decision,
    })}`;
  const exact = encode(action.approvalId);
  return exact.length <= SLACK_BUTTON_VALUE_MAX
    ? exact
    : encode(
        buildApprovalResolutionRef({
          approvalId: action.approvalId,
          approvalKind: action.approvalKind,
        }),
      );
}

/** Decode only the exact Slack-owned approval envelope. Malformed callbacks fail closed. */
export function decodeSlackApprovalAction(value: unknown): SlackApprovalAction | null {
  if (typeof value !== "string" || !value.startsWith(SLACK_APPROVAL_VALUE_PREFIX)) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(value.slice(SLACK_APPROVAL_VALUE_PREFIX.length));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return null;
    }
    const record = decoded as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      typeof record.approvalId !== "string" ||
      record.approvalId.length === 0 ||
      (record.approvalKind !== "exec" && record.approvalKind !== "plugin") ||
      !isApprovalDecision(record.decision)
    ) {
      return null;
    }
    return {
      type: "approval",
      approvalId: record.approvalId,
      approvalKind: record.approvalKind,
      decision: record.decision,
    };
  } catch {
    return null;
  }
}
