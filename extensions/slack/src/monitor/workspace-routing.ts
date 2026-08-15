// Slack plugin module keeps Enterprise Grid routing identities workspace-qualified.
import type { SlackEventScope } from "./event-scope.js";

export function resolveSlackEnterpriseMainDmSessionKey(params: {
  baseSessionKey: string;
  accountId: string;
  eventScope: SlackEventScope;
}): string {
  const accountId = encodeURIComponent(params.accountId).toLowerCase();
  const teamId = encodeURIComponent(params.eventScope.teamId).toLowerCase();
  return `${params.baseSessionKey}:account:${accountId}:team:${teamId}`;
}

export function qualifySlackRoutePeerId(params: {
  id: string;
  kind: "user" | "channel";
  eventScope?: SlackEventScope;
}): string {
  if (!params.eventScope) {
    return params.id;
  }
  return `team:${encodeURIComponent(params.eventScope.teamId)}:${params.kind}:${encodeURIComponent(params.id)}`;
}

export function qualifySlackConversationId(
  conversationId: string,
  eventScope?: SlackEventScope,
): string {
  return eventScope
    ? `team:${encodeURIComponent(eventScope.teamId)}:${conversationId}`
    : conversationId;
}
