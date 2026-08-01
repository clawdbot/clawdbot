import type { ExecApprovalReplyDecision } from "../infra/exec-approval-reply.js";
import type { MessagePresentation } from "../interactive/payload.js";
import type { ReplyPayload } from "./reply-payload.js";

type ApprovalKind = "exec" | "plugin";

/** Validated identity and decisions shared by typed approval delivery surfaces. */
export type ApprovalReactionDeliveryBinding = {
  approvalId: string;
  approvalKind: ApprovalKind;
  allowedDecisions: ExecApprovalReplyDecision[];
  approvalSlug?: string;
};

/** Read a nonempty, duplicate-free list without accepting unrecognized decisions. */
export function readApprovalReactionDecisionList(
  value: unknown,
): ExecApprovalReplyDecision[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const decisions: ExecApprovalReplyDecision[] = [];
  for (const decision of value) {
    if (
      (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") ||
      decisions.includes(decision)
    ) {
      return null;
    }
    decisions.push(decision);
  }
  return decisions;
}

/** Normalize the shipped approval command spelling without accepting other decisions. */
export function normalizeApprovalReactionDecision(value: string): ExecApprovalReplyDecision | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "always") {
    return "allow-always";
  }
  return normalized === "allow-once" || normalized === "allow-always" || normalized === "deny"
    ? normalized
    : null;
}

/** Read only canonical approval prompts; unrelated `/approve` help must never gain controls. */
export function extractApprovalReactionPromptBinding(params: {
  text: string;
  approvalKind?: ApprovalKind;
  replyInstructionOnly?: boolean;
}): ApprovalReactionDeliveryBinding | null {
  const lines = params.text.split(/\r?\n/).map((line) => line.replace(/\*\*/g, ""));
  let approvalKind = params.approvalKind;
  if (!approvalKind) {
    const exec = lines.some((line) => /^\s*[^A-Za-z0-9]*Exec approval required\s*$/i.test(line));
    const plugin = lines.some((line) =>
      /^\s*[^A-Za-z0-9]*Plugin approval required\s*$/i.test(line),
    );
    if (exec === plugin) {
      return null;
    }
    approvalKind = plugin ? "plugin" : "exec";
  }
  const approvalId = lines
    .map((line) => line.match(/^\s*ID:\s*([A-Za-z0-9][A-Za-z0-9._:-]*)\s*$/i))
    .find(Boolean)?.[1];
  if (!approvalId) {
    return null;
  }
  const commandPattern = params.replyInstructionOnly
    ? /^\s*Reply with:\s*\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(.+)$/i
    : /\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(.+)$/i;
  const allowedDecisions: ExecApprovalReplyDecision[] = [];
  for (const line of lines) {
    const match = line.match(commandPattern);
    if (match?.[1] !== approvalId || !match[2]) {
      continue;
    }
    for (const token of match[2].split(/[\s|,]+/)) {
      const decision = normalizeApprovalReactionDecision(token);
      if (decision && !allowedDecisions.includes(decision)) {
        allowedDecisions.push(decision);
      }
    }
  }
  return allowedDecisions.length ? { approvalId, approvalKind, allowedDecisions } : null;
}

/** Compare approved decision sets independently of presentation order. */
export function approvalReactionDecisionSetsMatch(
  left: readonly ExecApprovalReplyDecision[],
  right: readonly ExecApprovalReplyDecision[],
): boolean {
  return left.length === right.length && left.every((decision) => right.includes(decision));
}

/** Validate canonical approval metadata without inferring its owner from text. */
export function readApprovalReactionDeliveryMetadata(
  payload: ReplyPayload,
  options: { requireApprovalSlug?: boolean; trimApprovalId?: boolean } = {},
): ApprovalReactionDeliveryBinding | null {
  const value = payload.channelData?.execApproval;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.approvalId !== "string") {
    return null;
  }
  const approvalId = options.trimApprovalId ? record.approvalId.trim() : record.approvalId;
  const approvalSlug = typeof record.approvalSlug === "string" ? record.approvalSlug.trim() : "";
  const allowedDecisions = readApprovalReactionDecisionList(record.allowedDecisions);
  if (
    !approvalId ||
    (!options.trimApprovalId && approvalId !== approvalId.trim()) ||
    (options.requireApprovalSlug && !approvalSlug) ||
    (record.approvalKind !== "exec" && record.approvalKind !== "plugin") ||
    !allowedDecisions
  ) {
    return null;
  }
  return {
    approvalId,
    approvalKind: record.approvalKind,
    allowedDecisions,
    ...(approvalSlug ? { approvalSlug } : {}),
  };
}

/** Verify that typed presentation controls exactly match authoritative approval metadata. */
export function readApprovalReactionPresentationBinding(params: {
  payload: ReplyPayload;
  presentation?: MessagePresentation;
  requireApprovalSlug?: boolean;
  trimApprovalId?: boolean;
}): ApprovalReactionDeliveryBinding | null {
  const metadata = readApprovalReactionDeliveryMetadata(params.payload, params);
  if (!metadata) {
    return null;
  }
  const actions = (params.presentation ?? params.payload.presentation)?.blocks.flatMap((block) =>
    block.type === "buttons"
      ? block.buttons.flatMap((button) =>
          button.action?.type === "approval" ? [button.action] : [],
        )
      : [],
  );
  if (
    !actions?.length ||
    actions.some(
      (action) =>
        action.approvalId !== metadata.approvalId || action.approvalKind !== metadata.approvalKind,
    )
  ) {
    return null;
  }
  const decisions = readApprovalReactionDecisionList(actions.map((action) => action.decision));
  return decisions && approvalReactionDecisionSetsMatch(metadata.allowedDecisions, decisions)
    ? metadata
    : null;
}

/** Revalidate the private delivery marker against canonical typed approval metadata. */
export function readApprovalReactionDeliveredBinding(params: {
  payload: ReplyPayload;
  channelDataKey: string;
  requireApprovalSlug?: boolean;
  trimApprovalId?: boolean;
}): ApprovalReactionDeliveryBinding | null {
  const metadata = readApprovalReactionDeliveryMetadata(params.payload, params);
  const marker = params.payload.channelData?.[params.channelDataKey];
  if (!metadata || !marker || typeof marker !== "object" || Array.isArray(marker)) {
    return null;
  }
  const record = marker as Record<string, unknown>;
  const markerId =
    typeof record.approvalId === "string" && params.trimApprovalId
      ? record.approvalId.trim()
      : record.approvalId;
  const markerSlug = typeof record.approvalSlug === "string" ? record.approvalSlug.trim() : "";
  const decisions = readApprovalReactionDecisionList(record.allowedDecisions);
  return record.version === 1 &&
    markerId === metadata.approvalId &&
    record.approvalKind === metadata.approvalKind &&
    (!params.requireApprovalSlug || markerSlug === metadata.approvalSlug) &&
    decisions &&
    approvalReactionDecisionSetsMatch(metadata.allowedDecisions, decisions)
    ? metadata
    : null;
}
