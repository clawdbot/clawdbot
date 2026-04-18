import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeMatrixApproverId } from "./approval-ids.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import type { CoreConfig } from "./types.js";

type MatrixApprovalReactionKind = "exec" | "plugin";

function normalizeMatrixExecApproverId(value: string | number): string | undefined {
  const normalized = normalizeMatrixApproverId(value);
  return normalized === "*" ? undefined : normalized;
}

function getMatrixApprovalReactionApprovers(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  approvalKind: MatrixApprovalReactionKind;
}): string[] {
  const account = resolveMatrixAccount(params).config;
  if (params.approvalKind === "plugin") {
    return resolveApprovalApprovers({
      allowFrom: account.dm?.allowFrom,
      normalizeApprover: normalizeMatrixApproverId,
    });
  }
  return resolveApprovalApprovers({
    explicit: account.execApprovals?.approvers,
    allowFrom: account.dm?.allowFrom,
    normalizeApprover: normalizeMatrixExecApproverId,
  });
}

export function isMatrixApprovalReactionAuthorizedSender(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  senderId?: string | null;
  approvalKind: MatrixApprovalReactionKind;
}): boolean {
  const normalizedSenderId = params.senderId
    ? normalizeMatrixApproverId(params.senderId)
    : undefined;
  if (!normalizedSenderId) {
    return false;
  }
  return getMatrixApprovalReactionApprovers(params).includes(normalizedSenderId);
}
