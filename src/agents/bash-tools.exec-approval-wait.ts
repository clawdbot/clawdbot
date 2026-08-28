import { isNativeApprovalChannel, normalizeMessageChannel } from "../utils/message-channel.js";

export function shouldAwaitExecApprovalInline(params: {
  turnSourceChannel?: string;
  approvalFollowupMode?: "agent" | "direct";
  trigger?: string;
}): boolean {
  if (params.approvalFollowupMode !== undefined) {
    return false;
  }
  // Scheduled runs cannot recover from an "approval-pending" handoff: the
  // isolated session ends and authority-close cancels the parked approval
  // seconds later. Wait inline so a connected approval client gets the full
  // approval window; allow-always there mints the standing grant and this
  // occurrence executes. Cron jobs are single-flight, so waiting cannot
  // stack runs.
  if (params.trigger === "cron") {
    return true;
  }
  // Native chat approval clients (Telegram /approve, Discord buttons,
  // etc.) resolve the approval back into the same session, so the agent can
  // wait inline and return the real exec output as the tool result. This
  // mirrors the webchat path that PR #85239 fixed; without it the agent run
  // terminates on the "approval-pending" tool result and the operator must
  // send a follow-up chat message to recover the turn (issue #93918).
  return isNativeApprovalChannel(normalizeMessageChannel(params.turnSourceChannel));
}
