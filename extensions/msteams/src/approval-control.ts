import { isImplicitSameChatApprovalAuthorization } from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import { formatUnknownError } from "./errors.js";
import { stripMSTeamsMentionTags } from "./inbound.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { resolveMSTeamsSenderAccess } from "./monitor-handler/access.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

async function sendApprovalStatus(params: {
  context: MSTeamsTurnContext;
  deps: MSTeamsMessageHandlerDeps;
  text: string;
}): Promise<void> {
  try {
    await params.context.sendActivity(params.text);
  } catch (error) {
    params.deps.log.debug?.("failed to send approval control status", {
      error: formatUnknownError(error),
    });
  }
}

export async function maybeHandleMSTeamsApprovalControl(params: {
  context: MSTeamsTurnContext;
  deps: MSTeamsMessageHandlerDeps;
  text: string;
}): Promise<boolean> {
  const allowTextCommands = getMSTeamsRuntime().channel.commands.shouldHandleTextCommands({
    cfg: params.deps.cfg,
    surface: "msteams",
  });
  if (!allowTextCommands) {
    return false;
  }
  const parsed = parseExecApprovalCommandText(stripMSTeamsMentionTags(params.text));
  if (!parsed) {
    return false;
  }

  const senderId = params.context.activity.from?.aadObjectId;
  const approvalKind = parsed.approvalId.startsWith("plugin:") ? "plugin" : "exec";
  const access = await resolveMSTeamsSenderAccess({
    cfg: params.deps.cfg,
    accountId: params.deps.accountId,
    activity: params.context.activity,
    hasControlCommand: true,
  });
  const senderAdmitted = access.isDirectMessage
    ? !access.msteamsCfg || access.senderAccess.decision === "allow"
    : (!access.msteamsCfg ||
        !access.channelGate.allowlistConfigured ||
        access.channelGate.allowed) &&
      access.senderAccess.allowed;
  const accountId = params.deps.accountId ?? access.pairing.accountId;
  const authorization = msTeamsApprovalAuth.authorizeActorAction?.({
    cfg: params.deps.cfg,
    accountId,
    senderId,
    action: "approve",
    approvalKind,
  });
  const explicitlyAuthorized = authorization
    ? authorization.authorized && !isImplicitSameChatApprovalAuthorization(authorization)
    : false;
  const commandAuthorized = access.commandAccess.authorized;
  if (!senderAdmitted || (!commandAuthorized && !explicitlyAuthorized)) {
    params.deps.log.debug?.("dropping approval control from unauthorized sender", {
      accountId,
      sender: senderId ?? "unknown",
      approvalKind,
      senderAdmitted,
      commandAuthorized,
      explicitlyAuthorized,
    });
    return true;
  }

  try {
    await resolveApprovalOverGateway({
      cfg: params.deps.cfg,
      approvalId: parsed.approvalId,
      decision: parsed.decision,
      channel: "msteams",
      accountId,
      senderId,
      approvalKind,
      ...(params.deps.approvalGatewayRuntime
        ? { gatewayRuntime: params.deps.approvalGatewayRuntime }
        : {}),
      clientDisplayName: `Microsoft Teams approval (${senderId?.trim() || "unknown"})`,
    });
  } catch (error) {
    params.deps.log.error("failed to resolve approval control", {
      accountId,
      approvalId: parsed.approvalId,
      approvalKind,
      sender: senderId ?? "unknown",
      error: formatUnknownError(error),
    });
    await sendApprovalStatus({
      context: params.context,
      deps: params.deps,
      text: "❌ Failed to submit approval.",
    });
    return true;
  }
  params.deps.log.info("resolved approval control", {
    accountId,
    approvalId: parsed.approvalId,
    decision: parsed.decision,
    sender: senderId ?? "unknown",
  });
  await sendApprovalStatus({
    context: params.context,
    deps: params.deps,
    text: `✅ Approval ${parsed.decision} submitted for ${parsed.approvalId}.`,
  });
  return true;
}
