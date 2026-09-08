import { normalizeRouteBasePath } from "@openclaw/uirouter";

export type AssistantMediaContext = { sessionKey?: string; agentId?: string; policyKey?: string };

export function buildAssistantMediaUrl(
  source: string,
  resourceBasePath = "",
  mediaTicket?: string | null,
  context?: AssistantMediaContext,
): string {
  const params = new URLSearchParams({ source });
  const normalizedMediaTicket = mediaTicket?.trim();
  if (normalizedMediaTicket) {
    params.set("mediaTicket", normalizedMediaTicket);
  }
  if (context?.sessionKey) {
    params.set("sessionKey", context.sessionKey);
  }
  if (context?.agentId) {
    params.set("agentId", context.agentId);
  }
  return `${normalizeRouteBasePath(resourceBasePath)}/__openclaw__/assistant-media?${params.toString()}`;
}
