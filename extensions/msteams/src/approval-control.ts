import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const APPROVE_COMMAND_RE =
  /^\/approve\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|deny)\s*$/i;

function parseApprovalCommand(text: string): {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
} | null {
  const match = text.trim().match(APPROVE_COMMAND_RE);
  if (!match) {
    return null;
  }
  return {
    approvalId: match[1],
    decision: match[2].toLowerCase() as ExecApprovalReplyDecision,
  };
}

export async function maybeHandleMSTeamsApprovalControl(params: {
  context: MSTeamsTurnContext;
  deps: MSTeamsMessageHandlerDeps;
  text: string;
}): Promise<boolean> {
  const parsed = parseApprovalCommand(params.text);
  if (!parsed) {
    return false;
  }

  const senderId = params.context.activity.from?.aadObjectId;
  const approvalKind = parsed.approvalId.startsWith("plugin:") ? "plugin" : "exec";
  const authorization = msTeamsApprovalAuth.authorizeActorAction?.({
    cfg: params.deps.cfg,
    accountId: "default",
    senderId,
    action: "approve",
    approvalKind,
  });
  if (!authorization?.authorized) {
    params.deps.log.debug?.("dropping approval control from unauthorized sender", {
      sender: senderId ?? "unknown",
      approvalKind,
    });
    return true;
  }

  await resolveApprovalOverGateway({
    cfg: params.deps.cfg,
    approvalId: parsed.approvalId,
    decision: parsed.decision,
    senderId,
    allowPluginFallback: approvalKind === "exec",
    clientDisplayName: `Microsoft Teams approval (${senderId?.trim() || "unknown"})`,
  });
  params.deps.log.info("resolved approval control", {
    approvalId: parsed.approvalId,
    decision: parsed.decision,
    sender: senderId ?? "unknown",
  });
  return true;
}
