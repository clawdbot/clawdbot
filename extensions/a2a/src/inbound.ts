import {
  buildChannelInboundEventContext,
  resolveChannelInboundRouteEnvelope,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { A2aTaskStore } from "./task-store.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

type A2aInboundDispatchParams = {
  account: ResolvedA2aChannelAccount;
  config: OpenClawConfig;
  channelRuntime: PluginRuntime["channel"];
  buildContext: typeof buildChannelInboundEventContext;
  store: A2aTaskStore;
  taskId: string;
  contextId: string;
  messageId: string;
  peerName: string;
  text: string;
};

export async function dispatchA2aInbound(params: A2aInboundDispatchParams): Promise<void> {
  try {
    // Peer credentials admit tasks, never user commands (including plugin commands).
    if (params.text.trimStart().startsWith("/")) {
      params.store.reject(
        params.taskId,
        "A2A peers cannot execute slash commands. Send a task in plain text; only users can issue commands.",
      );
      return;
    }
    const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
      cfg: params.config,
      channel: "a2a",
      accountId: params.account.accountId,
      peer: { kind: "direct", id: `${params.peerName}:${params.contextId}` },
      // Untrusted remote peers must never land in the operator's main session,
      // so A2A pins the most isolated scope instead of inheriting session.dmScope.
      // The peer id embeds the A2A contextId, giving one session per peer+context.
      dmScope: "per-account-channel-peer",
    });
    const ingress = await resolveStableChannelMessageIngress({
      channelId: "a2a",
      accountId: params.account.accountId,
      cfg: params.config,
      identity: { key: "sender", entryIdPrefix: "a2a-entry" },
      subject: { stableId: params.peerName },
      conversation: { kind: "direct", id: params.contextId },
      contextBinding: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        messageId: params.messageId,
        inboundEventKind: "user_request",
      },
      dmPolicy: "allowlist",
      allowFrom: Object.keys(params.account.config.peers ?? {}),
    });
    if (ingress.ingress.admission !== "dispatch") {
      params.store.reject(params.taskId, "A2A peer was blocked by channel ingress policy");
      return;
    }

    const timestamp = Date.now();
    const target = `a2a:${params.peerName}`;
    const body = buildEnvelope({
      channel: "A2A",
      from: params.peerName,
      timestamp,
      body: params.text,
    });
    const ctxPayload = params.buildContext({
      channel: "a2a",
      accountId: route.accountId ?? params.account.accountId,
      messageId: params.messageId,
      messageIdFull: params.messageId,
      timestamp,
      from: target,
      sender: { id: params.peerName, name: params.peerName },
      conversation: {
        kind: "direct",
        id: params.contextId,
        label: params.peerName,
      },
      route: {
        agentId: route.agentId,
        dmScope: route.dmScope,
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
        dispatchSessionKey: route.sessionKey,
      },
      reply: { to: target, originatingTo: target },
      message: {
        body,
        bodyForAgent: params.text,
        rawBody: params.text,
        commandBody: params.text,
      },
      channelIngress: ingress,
      extra: { CommandInterpretationSuppressed: true },
    });

    const dispatch = await params.channelRuntime.inbound.dispatch({
      cfg: params.config,
      channel: "a2a",
      accountId: params.account.accountId,
      route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
      ctxPayload,
      delivery: {
        deliver: async (payload, info) => {
          if (info.kind !== "final") {
            return;
          }
          // Conversation queues, rather than callback ownership, preserve FIFO
          // correlation across concurrent sends and canceled-task tombstones.
          params.store.completeNext(params.contextId, payload.text, params.peerName);
        },
        onError: (error) => {
          params.store.fail(params.taskId, error);
        },
      },
      replyPipeline: {},
    });
    if (dispatch.admission.kind !== "dispatch") {
      params.store.reject(
        params.taskId,
        `A2A channel declined the turn: ${dispatch.admission.kind}`,
      );
    } else if (!dispatch.dispatched) {
      params.store.fail(params.taskId, "A2A channel accepted the turn without dispatching it");
    }
  } catch (error) {
    params.store.fail(params.taskId, error);
  }
}
