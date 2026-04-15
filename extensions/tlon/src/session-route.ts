import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { parseTlonTarget } from "./targets.js";

export function resolveTlonOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const parsed = parseTlonTarget(params.target);
  if (!parsed) {
    return null;
  }
  if (parsed.kind === "group") {
    return buildChannelOutboundSessionRoute({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: "tlon",
      accountId: params.accountId,
      peer: {
        kind: "group",
        id: parsed.nest,
      },
      chatType: "group",
      from: `tlon:group:${parsed.nest}`,
      to: `tlon:${parsed.nest}`,
    });
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "tlon",
    accountId: params.accountId,
    peer: {
      kind: "direct",
      id: parsed.ship,
    },
    chatType: "direct",
    from: `tlon:${parsed.ship}`,
    to: `tlon:${parsed.ship}`,
  });
}
