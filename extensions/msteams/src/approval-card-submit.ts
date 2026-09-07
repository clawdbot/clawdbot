import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import {
  msTeamsApprovalControls,
  readMSTeamsApprovalActionToken,
} from "./approval-card-actions.js";
import { buildMSTeamsCanonicalApprovalTerminalCard } from "./approval-card.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

function isMSTeamsApprovalSubmit(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.openclawAction === "approval") {
    return true;
  }
  const action = isRecord(value.action) ? value.action : undefined;
  const data = action?.data;
  return isRecord(data) && data.openclawAction === "approval";
}

export async function maybeHandleMSTeamsApprovalCardSubmit(params: {
  context: MSTeamsTurnContext;
  deps: MSTeamsMessageHandlerDeps;
}): Promise<boolean> {
  const { context, deps } = params;
  if (!isMSTeamsApprovalSubmit(context.activity.value)) {
    return false;
  }

  const ignored = (reason: string) => deps.log.info("msteams approval ignored", { reason });
  const token = readMSTeamsApprovalActionToken(context.activity.value);
  if (!token) {
    ignored("missing card token");
    return true;
  }
  const binding = msTeamsApprovalControls.get(token);
  if (!binding) {
    ignored("unknown or expired card token");
    return true;
  }
  if (binding.accountId !== DEFAULT_ACCOUNT_ID) {
    ignored("card token account mismatch");
    return true;
  }
  if (
    normalizeMSTeamsConversationId(context.activity.conversation?.id ?? "") !==
    normalizeMSTeamsConversationId(binding.conversationId)
  ) {
    ignored("card token conversation mismatch");
    return true;
  }
  if (context.activity.replyToId && context.activity.replyToId !== binding.activityId) {
    ignored("card token activity mismatch");
    return true;
  }
  if (!binding.allowedDecisions.includes(binding.decision)) {
    ignored("card token decision is no longer allowed");
    return true;
  }

  const senderId = context.activity.from?.aadObjectId;
  const authorization = msTeamsApprovalAuth.authorizeActorAction?.({
    cfg: deps.cfg,
    accountId: DEFAULT_ACCOUNT_ID,
    senderId,
    action: "approve",
    approvalKind: binding.approvalKind,
  });
  if (!authorization?.authorized) {
    ignored(`unauthorized actor ${senderId || "unknown"}`);
    return true;
  }

  const outcome = await msTeamsApprovalControls.settle(token, async (consumed) => {
    const result = await resolveApprovalOverGateway({
      cfg: deps.cfg,
      approvalId: consumed.approvalId,
      approvalKind: consumed.approvalKind,
      decision: consumed.decision,
      channel: "msteams",
      accountId: DEFAULT_ACCOUNT_ID,
      senderId,
    });
    await context.updateActivity({
      type: "message",
      id: consumed.activityId,
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: buildMSTeamsCanonicalApprovalTerminalCard(result),
        },
      ],
    });
    return result;
  });
  if (outcome.kind !== "settled") {
    ignored(
      outcome.kind === "missing"
        ? "card token already consumed"
        : outcome.kind === "in-flight"
          ? "card token resolve already in flight"
          : `approval expired or no longer exists id=${outcome.binding.approvalId}`,
    );
    return true;
  }

  const { binding: consumed, result } = outcome;
  deps.log.info("msteams approval resolved", {
    approvalId: consumed.approvalId,
    approvalKind: consumed.approvalKind,
    applied: result.applied,
    status: result.approval.status,
    senderId,
  });
  return true;
}
