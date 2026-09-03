import {
  createInternalHookEvent,
  fireAndForgetHook,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";

export type MSTeamsAIFeedbackHookParams = {
  sessionKey: string;
  accountId?: string;
  agentId: string;
  occurredAt?: string;
  providerActivityId: string;
  providerConversationId: string;
  providerTargetActivityId: string;
  actorId: string;
  actorName?: string;
  reaction: "like" | "dislike";
  comment?: string;
};

function isExactReference(value: string): boolean {
  return Boolean(value.trim()) && value !== "unknown";
}

/** Emit the authenticated Teams AI feedback control as a distinct provider fact. */
export function emitMSTeamsAIFeedbackHook(params: MSTeamsAIFeedbackHookParams): boolean {
  const exactReferences = [
    params.sessionKey,
    params.agentId,
    params.providerActivityId,
    params.providerConversationId,
    params.providerTargetActivityId,
    params.actorId,
  ];
  if (exactReferences.some((value) => !isExactReference(value))) {
    return false;
  }

  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent("message", "feedback", params.sessionKey, {
        channelId: "msteams",
        source: "ai_feedback_control",
        accountId: params.accountId,
        agentId: params.agentId,
        occurredAt: params.occurredAt,
        providerActivityId: params.providerActivityId,
        providerConversationId: params.providerConversationId,
        providerTargetActivityId: params.providerTargetActivityId,
        actorId: params.actorId,
        actorName: params.actorName,
        reaction: params.reaction,
        comment: params.comment,
        untrusted: true,
      }),
    ),
    "msteams: message:feedback internal hook failed",
  );
  return true;
}
