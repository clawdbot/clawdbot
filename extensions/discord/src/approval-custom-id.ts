// Discord plugin module owns its transport-private approval callback envelope.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import type { MessagePresentationAction } from "openclaw/plugin-sdk/interactive-runtime";
import type { ComponentData } from "./internal/discord.js";

export type DiscordApprovalAction = Extract<MessagePresentationAction, { type: "approval" }>;

const DISCORD_APPROVAL_CUSTOM_ID_MAX_CHARS = 100;

function encodeDiscordApprovalCustomId(action: DiscordApprovalAction): string {
  return [
    `execapproval:kind=${action.approvalKind}`,
    `id=${encodeURIComponent(action.approvalId)}`,
    `action=${action.decision}`,
  ].join(";");
}

function encodeBoundedDiscordApprovalCustomId(action: DiscordApprovalAction): string {
  const exact = encodeDiscordApprovalCustomId(action);
  if (exact.length <= DISCORD_APPROVAL_CUSTOM_ID_MAX_CHARS) {
    return exact;
  }
  // The full digest is a durable locator, not authorization. Gateway auth and
  // kind/decision checks still guard the canonical approval record.
  return encodeDiscordApprovalCustomId({
    ...action,
    approvalId: buildApprovalResolutionRef({
      approvalId: action.approvalId,
      approvalKind: action.approvalKind,
    }),
  });
}

export function buildDiscordApprovalCustomId(action: DiscordApprovalAction): string | undefined {
  if (
    !action.approvalId ||
    (action.approvalKind !== "exec" && action.approvalKind !== "plugin") ||
    (action.decision !== "allow-once" &&
      action.decision !== "allow-always" &&
      action.decision !== "deny")
  ) {
    return undefined;
  }
  return encodeBoundedDiscordApprovalCustomId(action);
}

export function buildExecApprovalCustomId(
  approvalId: string,
  approvalKind: DiscordApprovalAction["approvalKind"],
  decision: DiscordApprovalAction["decision"],
): string {
  return encodeBoundedDiscordApprovalCustomId({
    type: "approval",
    approvalId,
    approvalKind,
    decision,
  });
}

function decodeCustomIdValue(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseExecApprovalData(data: ComponentData): {
  approvalId: string;
  approvalKind: DiscordApprovalAction["approvalKind"];
  action: DiscordApprovalAction["decision"];
} | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawId = coerce(data.id);
  const rawKind = coerce(data.kind);
  const rawAction = coerce(data.action);
  if (!rawId || (rawKind !== "exec" && rawKind !== "plugin") || !rawAction) {
    return null;
  }
  if (rawAction !== "allow-once" && rawAction !== "allow-always" && rawAction !== "deny") {
    return null;
  }
  const approvalId = decodeCustomIdValue(rawId);
  if (!approvalId) {
    return null;
  }
  return {
    approvalId,
    approvalKind: rawKind,
    action: rawAction,
  };
}
