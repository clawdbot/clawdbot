// Base session-key helper keeps outbound-only delivery aligned with route
// resolution session-scope rules.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAgentSessionKey, type RoutePeer } from "../../routing/resolve-route.js";

/**
 * Builds the canonical outbound base-session key for a resolved route peer.
 *
 * Mirrors the routing layer's session-scope rules so outbound-only sends and
 * inbound route resolution keep the same `dmScope` and identity-link behavior.
 */
export function buildOutboundBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: RoutePeer;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    dmScope: params.cfg.session?.dmScope ?? "main",
    identityLinks: params.cfg.session?.identityLinks,
  });
}
