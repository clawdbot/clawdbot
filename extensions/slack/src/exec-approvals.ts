// Slack plugin module implements exec approvals behavior.
import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalTargetRecipient,
} from "openclaw/plugin-sdk/approval-client-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeStringifiedOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount } from "./accounts.js";
import { formatSlackTarget, parseSlackTarget } from "./target-parsing.js";

function normalizeSlackUserLikeId(value: string): string | undefined {
  const upper = value.toUpperCase();
  return /^[UW][A-Z0-9]+$/.test(upper) ? upper : undefined;
}

export function normalizeSlackApproverTarget(value: string | number): string | undefined {
  const trimmed = normalizeStringifiedOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  try {
    const target = parseSlackTarget(trimmed, { defaultKind: "user" });
    const id = target?.kind === "user" ? normalizeSlackUserLikeId(target.id) : undefined;
    return target?.teamId && id
      ? formatSlackTarget({ kind: "user", id, teamId: target.teamId.toUpperCase() })
      : id;
  } catch {
    return undefined;
  }
}

export function normalizeSlackApproverId(value: string | number): string | undefined {
  const target = normalizeSlackApproverTarget(value);
  return target?.startsWith("team:") ? undefined : target;
}

function resolveSlackOwnerApprovers(cfg: OpenClawConfig): string[] {
  const ownerAllowFrom = cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(ownerAllowFrom) || ownerAllowFrom.length === 0) {
    return [];
  }
  return resolveApprovalApprovers({
    explicit: ownerAllowFrom,
    normalizeApprover: normalizeSlackApproverId,
  });
}
export function getSlackExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveSlackAccount(params).config;
  return resolveApprovalApprovers({
    explicit: account.execApprovals?.approvers ?? resolveSlackOwnerApprovers(params.cfg),
    normalizeApprover: normalizeSlackApproverId,
  });
}

function isSlackExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalTargetRecipient({
    ...params,
    channel: "slack",
    normalizeSenderId: normalizeSlackApproverId,
    matchTarget: ({ target, normalizedSenderId }) =>
      normalizeSlackApproverId(target.to) === normalizedSenderId,
  });
}

const slackExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: (params) => resolveSlackAccount(params).config.execApprovals,
  resolveApprovers: getSlackExecApprovalApprovers,
  normalizeSenderId: normalizeSlackApproverId,
  isTargetRecipient: isSlackExecApprovalTargetRecipient,
});

export const isSlackExecApprovalClientEnabled = slackExecApprovalProfile.isClientEnabled;
export const isSlackExecApprovalAuthorizedSender = slackExecApprovalProfile.isAuthorizedSender;
export const resolveSlackExecApprovalTarget = slackExecApprovalProfile.resolveTarget;
export const shouldSuppressLocalSlackExecApprovalPrompt =
  slackExecApprovalProfile.shouldSuppressLocalPrompt;
