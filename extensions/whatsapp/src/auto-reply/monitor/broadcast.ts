// Whatsapp plugin module implements broadcast behavior.
import type { AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import { resolveGroupThreadConfig, runGroupThread } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  buildAgentMainSessionKey,
  DEFAULT_MAIN_KEY,
} from "openclaw/plugin-sdk/routing";
import { resolveWhatsAppGroupSessionRoute } from "../../group-session-key.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { formatError } from "../../session.js";
import { whatsappInboundLog } from "../loggers.js";
import type { GroupHistoryEntry } from "./inbound-context.js";

function buildBroadcastRouteKeys(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  route: ReturnType<typeof resolveAgentRoute>;
  peerId: string;
  agentId: string;
}) {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const sessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
    peer: {
      kind: admission.conversation.kind,
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
  msg: AdmittedWebInboundMessage;
  peerId: string;
  route: ReturnType<typeof resolveAgentRoute>;
  groupHistoryKey: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  processMessage: (
    msg: AdmittedWebInboundMessage,
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
  const group = resolveGroupThreadConfig({
    cfg: params.cfg,
    channel: "whatsapp",
    peerId: params.peerId,
  });
  if (!group) {
    return false;
  }

  whatsappInboundLog.info(
    `Broadcasting message to ${group.agents.length} agents (${group.strategy})`,
  );
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const isGroupConversation = admission.conversation.kind === "group";
  const groupHistorySnapshot = isGroupConversation
    ? [...(params.groupHistories.get(params.groupHistoryKey) ?? [])]
    : undefined;

  await runGroupThread({
    cfg: params.cfg,
    group,
    channel: "whatsapp",
    accountId: params.route.accountId,
    peerId: params.peerId,
    messageId: params.msg.event.id,
    text: [params.msg.payload.body, params.preflightAudioTranscript].filter(Boolean).join("\n"),
    onError: (err, turn) => {
      whatsappInboundLog.error(`Broadcast agent ${turn.agentId} failed: ${formatError(err)}`);
    },
    runTurn: async (turn) => {
      const routeKeys = buildBroadcastRouteKeys({
        cfg: params.cfg,
        msg: params.msg,
        route: params.route,
        peerId: params.peerId,
        agentId: turn.agentId,
      });
      const baseAgentRoute = {
        ...params.route,
        agentId: turn.agentId,
        ...routeKeys,
      };
      const agentRoute = isGroupConversation
        ? resolveWhatsAppGroupSessionRoute(baseAgentRoute)
        : baseAgentRoute;

      return params.processMessage(params.msg, agentRoute, params.groupHistoryKey, {
        groupHistory: turn.round === 1 ? groupHistorySnapshot : [],
        suppressGroupHistoryClear: true,
        ...(params.preflightAudioTranscript !== undefined
          ? { preflightAudioTranscript: params.preflightAudioTranscript }
          : {}),
        ...(params.ackAlreadySent === true || turn.round > 1 ? { ackAlreadySent: true } : {}),
        ...(params.ackReaction !== undefined && turn.round === 1
          ? { ackReaction: params.ackReaction }
          : {}),
      });
    },
  });

  if (isGroupConversation) {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  return true;
}
