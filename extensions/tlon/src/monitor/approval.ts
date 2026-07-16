/**
 * Approval system for managing DM, channel mention, and group invite approvals.
 *
 * When an unknown ship tries to interact with the bot, the owner receives
 * a notification and can approve or deny the request.
 */

// Extensions cannot import core internals directly, so use node:crypto here.
import { randomBytes } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { PendingApproval } from "../settings.js";

export type { PendingApproval };

export type ApprovalType = "dm" | "channel" | "group";

export type CreateApprovalParams = {
  type: ApprovalType;
  requestingShip: string;
  channelNest?: string;
  groupFlag?: string;
  messagePreview?: string;
  originalMessage?: {
    messageId: string;
    messageText: string;
    messageContent: unknown;
    timestamp: number;
    parentId?: string;
    isThreadReply?: boolean;
  };
};

/**
 * Generate a unique approval ID in the format: {type}-{timestamp}-{shortHash}
 */
export function generateApprovalId(type: ApprovalType): string {
  const timestamp = Date.now();
  const randomPart = randomBytes(3).toString("hex");
  return `${type}-${timestamp}-${randomPart}`;
}

/**
 * Create a pending approval object.
 */
export function createPendingApproval(params: CreateApprovalParams): PendingApproval {
  return {
    id: generateApprovalId(params.type),
    type: params.type,
    requestingShip: params.requestingShip,
    channelNest: params.channelNest,
    groupFlag: params.groupFlag,
    messagePreview: params.messagePreview,
    originalMessage: params.originalMessage,
    timestamp: Date.now(),
  };
}

/**
 * Truncate text to a maximum length with ellipsis.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Format a notification message for the owner about a pending approval.
 */
export function formatApprovalRequest(approval: PendingApproval): string {
  const preview = approval.messagePreview ? `\n"${truncate(approval.messagePreview, 100)}"` : "";

  switch (approval.type) {
    case "dm":
      return (
        `New DM request from ${approval.requestingShip}:${preview}\n\n` +
        `Reply "approve", "deny", or "block" (ID: ${approval.id})`
      );

    case "channel":
      return (
        `${approval.requestingShip} mentioned you in ${approval.channelNest}:${preview}\n\n` +
        `Reply "approve", "deny", or "block"\n` +
        `(ID: ${approval.id})`
      );

    case "group":
      return (
        `Group invite from ${approval.requestingShip} to join ${approval.groupFlag}\n\n` +
        `Reply "approve", "deny", or "block"\n` +
        `(ID: ${approval.id})`
      );
  }
  throw new Error("Unsupported approval type");
}

export type ApprovalResponse = {
  action: "approve" | "deny" | "block";
  id?: string;
};

/**
 * Parse an owner's response to an approval request.
 * Supports formats:
 *   - "approve" / "deny" / "block" (applies to most recent pending)
 *   - "approve dm-1234567890-abc" / "deny dm-1234567890-abc" (specific ID)
 *   - "block" permanently blocks the ship via Tlon's native blocking
 */
export function parseApprovalResponse(text: string): ApprovalResponse | null {
  const trimmed = normalizeLowercaseStringOrEmpty(text);

  // Match "approve", "deny", or "block" optionally followed by an ID
  const match = trimmed.match(/^(approve|deny|block)(?:\s+(.+))?$/);
  if (!match) {
    return null;
  }

  const action = match[1] as "approve" | "deny" | "block";
  const id = match[2]?.trim();

  return { action, id };
}

/**
 * Check if a message text looks like an approval response.
 * Used to determine if we should intercept the message before normal processing.
 */
export function isApprovalResponse(text: string): boolean {
  const trimmed = normalizeLowercaseStringOrEmpty(text);
  return trimmed.startsWith("approve") || trimmed.startsWith("deny") || trimmed.startsWith("block");
}

/**
 * Find a pending approval by ID, or return the most recent if no ID specified.
 */
export function findPendingApproval(
  pendingApprovals: PendingApproval[],
  id?: string,
): PendingApproval | undefined {
  if (id) {
    return pendingApprovals.find((a) => a.id === id);
  }
  // Return most recent
  return pendingApprovals[pendingApprovals.length - 1];
}

/**
 * Check if there's already a pending approval for the same ship/channel/group combo.
 * Used to avoid sending duplicate notifications.
 */
export function hasDuplicatePending(
  pendingApprovals: PendingApproval[],
  type: ApprovalType,
  requestingShip: string,
  channelNest?: string,
  groupFlag?: string,
): boolean {
  return pendingApprovals.some((approval) => {
    if (approval.type !== type || approval.requestingShip !== requestingShip) {
      return false;
    }
    if (type === "channel" && approval.channelNest !== channelNest) {
      return false;
    }
    if (type === "group" && approval.groupFlag !== groupFlag) {
      return false;
    }
    return true;
  });
}

/**
 * Remove a pending approval from the list by ID.
 */
export function removePendingApproval(
  pendingApprovals: PendingApproval[],
  id: string,
): PendingApproval[] {
  return pendingApprovals.filter((a) => a.id !== id);
}

/**
 * Format a confirmation message after an approval action.
 */
export function formatApprovalConfirmation(
  approval: PendingApproval,
  action: "approve" | "deny" | "block",
): string {
  if (action === "block") {
    return `Blocked ${approval.requestingShip}. They will no longer be able to contact the bot.`;
  }

  const actionText = action === "approve" ? "Approved" : "Denied";

  switch (approval.type) {
    case "dm":
      if (action === "approve") {
        return `${actionText} DM access for ${approval.requestingShip}. They can now message the bot.`;
      }
      return `${actionText} DM request from ${approval.requestingShip}.`;

    case "channel":
      if (action === "approve") {
        return `${actionText} ${approval.requestingShip} for ${approval.channelNest}. They can now interact in this channel.`;
      }
      return `${actionText} ${approval.requestingShip} for ${approval.channelNest}.`;

    case "group":
      if (action === "approve") {
        return `${actionText} group invite from ${approval.requestingShip} to ${approval.groupFlag}. Joining group...`;
      }
      return `${actionText} group invite from ${approval.requestingShip} to ${approval.groupFlag}.`;
  }
  throw new Error("Unsupported approval type");
}

// ============================================================================
// Admin Commands
// ============================================================================

export type AdminCommand =
  | { type: "unblock"; ship: string }
  | { type: "blocked" }
  | { type: "pending" };

/**
 * Parse an admin command from owner message.
 * Supports:
 *   - "unblock ~ship" - unblock a specific ship
 *   - "blocked" - list all blocked ships
 *   - "pending" - list all pending approvals
 */
export function parseAdminCommand(text: string): AdminCommand | null {
  const trimmed = normalizeLowercaseStringOrEmpty(text);

  // "blocked" - list blocked ships
  if (trimmed === "blocked") {
    return { type: "blocked" };
  }

  // "pending" - list pending approvals
  if (trimmed === "pending") {
    return { type: "pending" };
  }

  // "unblock ~ship" - unblock a specific ship
  const unblockMatch = trimmed.match(/^unblock\s+(~[\w-]+)$/);
  if (unblockMatch) {
    return { type: "unblock", ship: unblockMatch[1] };
  }

  return null;
}

/**
 * Check if a message text looks like an admin command.
 */
export function isAdminCommand(text: string): boolean {
  return parseAdminCommand(text) !== null;
}

/**
 * Format the list of blocked ships for display to owner.
 */
export function formatBlockedList(ships: string[]): string {
  if (ships.length === 0) {
    return "No ships are currently blocked.";
  }
  return `Blocked ships (${ships.length}):\n${ships.map((s) => `• ${s}`).join("\n")}`;
}

/**
 * Format the list of pending approvals for display to owner.
 */
export function formatPendingList(approvals: PendingApproval[]): string {
  if (approvals.length === 0) {
    return "No pending approval requests.";
  }
  return `Pending approvals (${approvals.length}):\n${approvals
    .map((a) => `• ${a.id}: ${a.type} from ${a.requestingShip}`)
    .join("\n")}`;
}
