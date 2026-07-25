import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "openclaw/plugin-sdk/approval-gateway-runtime";
import { updateGoogleChatMessage } from "./api.js";
import { googleChatApprovalAuth } from "./approval-auth.js";
import {
  claimGoogleChatApprovalCardBinding,
  completeGoogleChatApprovalCardBinding,
  getGoogleChatApprovalCardBinding,
  releaseGoogleChatApprovalCardBinding,
  readGoogleChatApprovalActionToken,
} from "./approval-card-actions.js";
import { buildGoogleChatCanonicalApprovalTerminalCards } from "./approval-terminal-card.js";
import type { WebhookTarget } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

function logIgnored(target: WebhookTarget, message: string): void {
  target.runtime.log?.(`[${target.account.accountId}] googlechat approval ignored: ${message}`);
}

export async function maybeHandleGoogleChatApprovalCardClick(params: {
  event: GoogleChatEvent;
  target: WebhookTarget;
}): Promise<boolean> {
  const eventType = params.event.type ?? params.event.eventType;
  if (eventType !== "CARD_CLICKED") {
    return false;
  }
  const token = readGoogleChatApprovalActionToken(params.event);
  if (!token) {
    return false;
  }

  const binding = getGoogleChatApprovalCardBinding(token);
  if (!binding) {
    logIgnored(params.target, "unknown or expired card token");
    return true;
  }
  if (binding.accountId !== params.target.account.accountId) {
    logIgnored(params.target, "card token account mismatch");
    return true;
  }
  if (params.event.space?.name !== binding.spaceName) {
    logIgnored(params.target, "card token space mismatch");
    return true;
  }
  if (params.event.message?.name && params.event.message.name !== binding.messageName) {
    logIgnored(params.target, "card token message mismatch");
    return true;
  }
  if (!binding.allowedDecisions.includes(binding.decision)) {
    logIgnored(params.target, "card token decision is no longer allowed");
    return true;
  }

  const actor = params.event.user?.name;
  const auth = googleChatApprovalAuth.authorizeActorAction?.({
    cfg: params.target.config,
    accountId: params.target.account.accountId,
    senderId: actor,
    action: "approve",
    approvalKind: binding.approvalKind,
  });
  if (!auth?.authorized) {
    logIgnored(params.target, `unauthorized actor ${actor || "unknown"}`);
    return true;
  }

  const claim = claimGoogleChatApprovalCardBinding(token);
  if (claim.kind === "missing") {
    logIgnored(params.target, "card token already consumed");
    return true;
  }
  if (claim.kind === "in-flight") {
    logIgnored(params.target, "card token resolve already in flight");
    return true;
  }
  const consumed = claim.binding;

  let result: ApprovalResolveResult;
  try {
    result = await resolveApprovalOverGateway({
      cfg: params.target.config,
      approvalId: consumed.approvalId,
      approvalKind: consumed.approvalKind,
      decision: consumed.decision,
      senderId: actor,
      clientDisplayName: `Google Chat approval (${actor?.trim() || "unknown"})`,
    });
    await updateGoogleChatMessage({
      account: params.target.account,
      messageName: consumed.messageName,
      cardsV2: buildGoogleChatCanonicalApprovalTerminalCards(result),
    });
  } catch (error) {
    releaseGoogleChatApprovalCardBinding(token);
    throw error;
  }
  completeGoogleChatApprovalCardBinding(token);
  const outcome = result.applied ? "resolved" : "already resolved";
  const decision = "decision" in result.approval ? result.approval.decision : "none";
  params.target.runtime.log?.(
    `[${params.target.account.accountId}] googlechat approval ${outcome} id=${consumed.approvalId} status=${result.approval.status} decision=${decision} sender=${actor || "unknown"}`,
  );
  return true;
}
