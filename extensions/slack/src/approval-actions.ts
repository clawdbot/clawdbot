// Slack plugin module owns its transport-private approval callback envelope.
import { createHmac, timingSafeEqual } from "node:crypto";
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import type { MessagePresentationAction } from "openclaw/plugin-sdk/interactive-runtime";
import { SLACK_BUTTON_VALUE_MAX } from "./presentation.js";

const SLACK_APPROVAL_VALUE_PREFIX = "openclaw:approval:v1:";
const SLACK_ENTERPRISE_APPROVAL_VALUE_PREFIX = "openclaw:approval:v2:";
const SLACK_ENTERPRISE_APPROVAL_HMAC_DOMAIN = "openclaw.slack.enterprise-approval.v2";

export type SlackApprovalAction = Extract<MessagePresentationAction, { type: "approval" }>;

type SlackEnterpriseApprovalUnsigned = Pick<
  SlackApprovalAction,
  "approvalId" | "approvalKind" | "decision"
> & { teamId: string };

function isApprovalDecision(value: unknown): value is SlackApprovalAction["decision"] {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

function normalizeSlackEnterpriseTeamId(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^T[A-Z0-9]+$/u.test(normalized) ? normalized : null;
}

function buildSlackEnterpriseApprovalSignature(
  unsigned: SlackEnterpriseApprovalUnsigned,
  signingKey: string,
): Buffer {
  return createHmac("sha256", signingKey)
    .update(SLACK_ENTERPRISE_APPROVAL_HMAC_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(unsigned), "utf8")
    .digest();
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

/** Sign an Enterprise approval action for exactly one originating Slack workspace. */
export function encodeSlackEnterpriseApprovalAction(params: {
  action: SlackApprovalAction;
  teamId: string;
  signingKey: string;
  maxLength?: number;
}): string {
  const teamId = normalizeSlackEnterpriseTeamId(params.teamId);
  if (!teamId || !params.signingKey || !params.action.approvalId) {
    throw new Error("Cannot sign malformed Slack Enterprise approval action");
  }
  const maxLength = params.maxLength ?? SLACK_BUTTON_VALUE_MAX;
  const encode = (approvalId: string) => {
    const unsigned: SlackEnterpriseApprovalUnsigned = {
      approvalId,
      approvalKind: params.action.approvalKind,
      decision: params.action.decision,
      teamId,
    };
    return `${SLACK_ENTERPRISE_APPROVAL_VALUE_PREFIX}${JSON.stringify({
      ...unsigned,
      signature: buildSlackEnterpriseApprovalSignature(unsigned, params.signingKey).toString(
        "base64url",
      ),
    })}`;
  };
  const exact = encode(params.action.approvalId);
  if (exact.length <= maxLength) {
    return exact;
  }
  const shortened = encode(
    buildApprovalResolutionRef({
      approvalId: params.action.approvalId,
      approvalKind: params.action.approvalKind,
    }),
  );
  if (shortened.length > maxLength) {
    throw new Error("Slack Enterprise approval action exceeds the transport value limit");
  }
  return shortened;
}

/** Verify only the exact credential- and workspace-bound Enterprise envelope. */
export function verifySlackEnterpriseApprovalAction(params: {
  value: unknown;
  teamId: string;
  signingKey: string;
}): SlackApprovalAction | null {
  if (
    typeof params.value !== "string" ||
    !params.value.startsWith(SLACK_ENTERPRISE_APPROVAL_VALUE_PREFIX) ||
    params.value.length > SLACK_BUTTON_VALUE_MAX ||
    !params.signingKey
  ) {
    return null;
  }
  const expectedTeamId = normalizeSlackEnterpriseTeamId(params.teamId);
  try {
    const encoded = params.value.slice(SLACK_ENTERPRISE_APPROVAL_VALUE_PREFIX.length);
    const decoded: unknown = JSON.parse(encoded);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return null;
    }
    const record = decoded as Record<string, unknown>;
    const { approvalId, approvalKind, decision, teamId, signature: encodedSignature } = record;
    if (
      typeof approvalId !== "string" ||
      approvalId.length === 0 ||
      (approvalKind !== "exec" && approvalKind !== "plugin") ||
      !isApprovalDecision(decision) ||
      typeof teamId !== "string" ||
      teamId !== normalizeSlackEnterpriseTeamId(teamId) ||
      teamId !== expectedTeamId ||
      typeof encodedSignature !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(encodedSignature)
    ) {
      return null;
    }
    const unsigned: SlackEnterpriseApprovalUnsigned = {
      approvalId,
      approvalKind,
      decision,
      teamId,
    };
    const signed = { ...unsigned, signature: encodedSignature };
    if (encoded !== JSON.stringify(signed)) {
      return null;
    }
    const signature = Buffer.from(encodedSignature, "base64url");
    if (
      signature.length !== 32 ||
      signature.toString("base64url") !== signed.signature ||
      !timingSafeEqual(
        signature,
        buildSlackEnterpriseApprovalSignature(unsigned, params.signingKey),
      )
    ) {
      return null;
    }
    return {
      type: "approval",
      approvalId: unsigned.approvalId,
      approvalKind: unsigned.approvalKind,
      decision: unsigned.decision,
    };
  } catch {
    return null;
  }
}
