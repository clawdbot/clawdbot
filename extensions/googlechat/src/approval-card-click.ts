import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { updateGoogleChatMessage } from "./api.js";
import { googleChatApprovalAuth } from "./approval-auth.js";
import {
  googleChatApprovalControls,
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

  const binding = googleChatApprovalControls.get(token);
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

  const outcome = await googleChatApprovalControls.settle(token, async (consumed) => {
    const result = await resolveApprovalOverGateway({
      cfg: params.target.config,
      approvalId: consumed.approvalId,
      approvalKind: consumed.approvalKind,
      decision: consumed.decision,
      channel: "googlechat",
      accountId: params.target.account.accountId,
      senderId: actor,
    });
    await updateGoogleChatMessage({
      account: params.target.account,
      messageName: consumed.messageName,
      cardsV2: buildGoogleChatCanonicalApprovalTerminalCards(result),
    });
    return result;
  });
  if (outcome.kind !== "settled") {
    logIgnored(
      params.target,
      outcome.kind === "missing"
        ? "card token already consumed"
        : outcome.kind === "in-flight"
          ? "card token resolve already in flight"
          : `approval expired or no longer exists id=${outcome.binding.approvalId}`,
    );
    return true;
  }
  const { binding: consumed, result } = outcome;
  const label = result.applied ? "resolved" : "already resolved";
  const decision = "decision" in result.approval ? result.approval.decision : "none";
  params.target.runtime.log?.(
    `[${params.target.account.accountId}] googlechat approval ${label} id=${consumed.approvalId} status=${result.approval.status} decision=${decision} sender=${actor || "unknown"}`,
  );
  return true;
}
