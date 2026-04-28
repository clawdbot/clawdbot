import type { AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { buildAgentSessionKey, deriveLastRoutePolicy } from "openclaw/plugin-sdk/routing";
import {
  buildAgentMainSessionKey,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
} from "openclaw/plugin-sdk/routing";
import { resolveWhatsAppGroupSessionRoute } from "../../group-session-key.js";
import { formatError } from "../../session.js";
import { whatsappInboundLog } from "../loggers.js";
import type { WebInboundMsg } from "../types.js";
import type { GroupHistoryEntry } from "./inbound-context.js";

function buildBroadcastRouteKeys(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMsg;
  route: ReturnType<typeof resolveAgentRoute>;
  peerId: string;
  agentId: string;
}) {
  const sessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
    peer: {
      kind: params.msg.chatType === "group" ? "group" : "direct",
      id: params.peerId,
    },
    dmScope: params.cfg.session?.dmScope,
    identityLinks: params.cfg.session?.identityLinks,
  });
  const mainSessionKey = buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: DEFAULT_MAIN_KEY,
  });

  return {
    sessionKey,
    mainSessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey,
      mainSessionKey,
    }),
  };
}

export async function maybeBroadcastMessage(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMsg;
  peerId: string;
  route: ReturnType<typeof resolveAgentRoute>;
  groupHistoryKey: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  processMessage: (
    msg: WebInboundMsg,
    route: ReturnType<typeof resolveAgentRoute>,
    groupHistoryKey: string,
    opts?: {
      groupHistory?: GroupHistoryEntry[];
      suppressGroupHistoryClear?: boolean;
      preflightAudioTranscript?: string | null;
      ackAlreadySent?: boolean;
      ackReaction?: AckReactionHandle | null;
    },
  ) => Promise<boolean>;
  preflightAudioTranscript?: string | null;
  ackAlreadySent?: boolean;
  ackReaction?: AckReactionHandle | null;
}) {
  const broadcastAgents = params.cfg.broadcast?.[params.peerId];
  if (!broadcastAgents || !Array.isArray(broadcastAgents)) {
    return false;
  }
  if (broadcastAgents.length === 0) {
    return false;
  }

  const strategy = params.cfg.broadcast?.strategy || "parallel";
  whatsappInboundLog.info(`Broadcasting message to ${broadcastAgents.length} agents (${strategy})`);

  const agentIds = params.cfg.agents?.list?.map((agent) => normalizeAgentId(agent.id));
  const hasKnownAgents = (agentIds?.length ?? 0) > 0;
  const groupHistorySnapshot =
    params.msg.chatType === "group"
      ? (params.groupHistories.get(params.groupHistoryKey) ?? [])
      : undefined;

  const processForAgent = async (agentId: string): Promise<boolean> => {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (hasKnownAgents && !agentIds?.includes(normalizedAgentId)) {
      whatsappInboundLog.warn(`Broadcast agent ${agentId} not found in agents.list; skipping`);
      return false;
    }
    const routeKeys = buildBroadcastRouteKeys({
      cfg: params.cfg,
      msg: params.msg,
      route: params.route,
      peerId: params.peerId,
      agentId: normalizedAgentId,
    });
    const baseAgentRoute = {
      ...params.route,
      agentId: normalizedAgentId,
      ...routeKeys,
    };
    const agentRoute =
      params.msg.chatType === "group"
        ? resolveWhatsAppGroupSessionRoute(baseAgentRoute)
        : baseAgentRoute;

    try {
      const opts: {
        groupHistory?: GroupHistoryEntry[];
        suppressGroupHistoryClear: true;
        preflightAudioTranscript?: string | null;
        ackAlreadySent?: boolean;
        ackReaction?: AckReactionHandle | null;
      } = {
        groupHistory: groupHistorySnapshot,
        suppressGroupHistoryClear: true,
      };
      if (params.preflightAudioTranscript !== undefined) {
        opts.preflightAudioTranscript = params.preflightAudioTranscript;
      }
      if (params.ackAlreadySent === true) {
        opts.ackAlreadySent = true;
      }
      if (params.ackReaction !== undefined) {
        opts.ackReaction = params.ackReaction;
      }
      return await params.processMessage(params.msg, agentRoute, params.groupHistoryKey, opts);
    } catch (err) {
      whatsappInboundLog.error(`Broadcast agent ${agentId} failed: ${formatError(err)}`);
      return false;
    }
  };

  if (strategy === "sequential") {
    for (const agentId of broadcastAgents) {
      await processForAgent(agentId);
    }
  } else {
    await Promise.allSettled(broadcastAgents.map(processForAgent));
  }

  if (params.msg.chatType === "group") {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  return true;
}
