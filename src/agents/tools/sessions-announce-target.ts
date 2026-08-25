/**
 * Session announcement target resolver.
 *
 * Resolves where sessions_send/subagent completion announcements should be delivered.
 */
import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import {
  parseSessionDeliveryRoute,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import type { GatewaySessionListRow } from "./sessions-helpers.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
  callGateway: AgentToolGatewayRequestCaller;
  agentId?: string;
}): Promise<AnnounceTarget | null> {
  const parsed = resolveAnnounceTargetFromKey(params.sessionKey);
  const parsedDisplay = resolveAnnounceTargetFromKey(params.displayKey);
  const fallback = parsed ?? parsedDisplay ?? null;
  const fallbackThreadId =
    fallback?.threadId ??
    parseThreadSessionSuffix(params.sessionKey).threadId ??
    parseThreadSessionSuffix(params.displayKey).threadId;

  if (fallback) {
    const normalized = normalizeChannelId(fallback.channel);
    const plugin = normalized ? getChannelPlugin(normalized) : null;
    const route =
      parseSessionDeliveryRoute(params.sessionKey) ?? parseSessionDeliveryRoute(params.displayKey);
    // Stored DM delivery context carries the authoritative account and thread;
    // use the parsed address only when that exact session has no saved route.
    const isDirectRoute = route?.peerKind === "direct" || route?.peerKind === "dm";
    if (!isDirectRoute && !plugin?.meta?.preferSessionLookupForAnnounceTarget) {
      return fallback;
    }
  }

  try {
    const list = await params.callGateway<{
      sessions: Array<GatewaySessionListRow>;
    }>({
      method: "sessions.list",
      params: {
        includeGlobal: true,
        includeUnknown: true,
        limit: 200,
        agentId: params.agentId,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    const match =
      sessions.find(
        (entry) =>
          entry?.key === params.sessionKey && (!params.agentId || entry.agentId === params.agentId),
      ) ??
      sessions.find(
        (entry) =>
          entry?.key === params.displayKey && (!params.agentId || entry.agentId === params.agentId),
      );

    const context = match?.deliveryContext;
    const threadId = normalizeOptionalStringifiedId(context?.threadId ?? fallbackThreadId);
    if (context?.channel && context.to) {
      return { channel: context.channel, to: context.to, accountId: context.accountId, threadId };
    }
  } catch {
    // ignore
  }

  return fallback;
}
