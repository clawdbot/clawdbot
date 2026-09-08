import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Telegram plugin module implements bot native commands behavior.
import { resolveAgentScopedOutboundMediaAccess } from "openclaw/plugin-sdk/media-local-roots";

export { ensureConfiguredBindingRouteReady } from "openclaw/plugin-sdk/conversation-runtime";
export {
  finalizeInboundContext,
  resolveChunkMode,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";
export { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
export { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";

/**
 * Owns the Telegram-side inputs to the shared outbound media policy: pins the
 * provider, derives the group id, and forwards requester identity. Configured
 * `agents.defaults.mediaLocalRoots` apply only when sender/group host-read
 * policy and the canonical host-root expansion gate allow — the generic root
 * helper never grants them ambiently.
 */
export function resolveNativeCommandOutboundMediaRoots(params: {
  cfg: OpenClawConfig;
  route: { agentId: string; sessionKey: string; accountId: string };
  auth: { isGroup: boolean; chatId: number; senderId?: string };
}): readonly string[] {
  return (
    resolveAgentScopedOutboundMediaAccess({
      cfg: params.cfg,
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
      messageProvider: "telegram",
      accountId: params.route.accountId,
      groupId: params.auth.isGroup ? String(params.auth.chatId) : undefined,
      requesterSenderId: params.auth.senderId,
    }).localRoots ?? []
  );
}
