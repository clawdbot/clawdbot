import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  type DmGroupAccessReasonCode,
} from "../security/dm-policy-shared.js";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope.js";
import { recordInboundSessionAndDispatchReply } from "./inbound-reply-dispatch.js";
import type { OutboundReplyPayload } from "./reply-payload.js";

export type DirectDmCommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  }) => boolean;
};

export type ResolvedInboundDirectDmAccess = {
  access: {
    decision: "allow" | "block" | "pairing";
    reasonCode: DmGroupAccessReasonCode;
    reason: string;
    effectiveAllowFrom: string[];
  };
  shouldComputeAuth: boolean;
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
};

/** Resolve direct-DM policy, effective allowlists, and optional command auth in one place. */
export async function resolveInboundDirectDmAccessWithRuntime(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId: string;
  dmPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  senderId: string;
  rawBody: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  runtime: DirectDmCommandAuthorizationRuntime;
  modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  readStoreAllowFrom?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<ResolvedInboundDirectDmAccess> {
  const dmPolicy = params.dmPolicy ?? "pairing";
  const storeAllowFrom =
    dmPolicy === "pairing"
      ? await readStoreAllowFromForDmPolicy({
          provider: params.channel,
          accountId: params.accountId,
          dmPolicy,
          readStore: params.readStoreAllowFrom,
        })
      : [];

  const access = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy,
    allowFrom: params.allowFrom,
    storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowEntries) => params.isSenderAllowed(params.senderId, allowEntries),
  });

  const shouldComputeAuth = params.runtime.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    access.effectiveAllowFrom,
  );
  const commandAuthorized = shouldComputeAuth
    ? dmPolicy === "open"
      ? true
      : params.runtime.resolveCommandAuthorizedFromAuthorizers({
          useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
          authorizers: [
            {
              configured: access.effectiveAllowFrom.length > 0,
              allowed: senderAllowedForCommands,
            },
          ],
          modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
        })
    : undefined;

  return {
    access: {
      decision: access.decision,
      reasonCode: access.reasonCode,
      reason: access.reason,
      effectiveAllowFrom: access.effectiveAllowFrom,
    },
    shouldComputeAuth,
    senderAllowedForCommands,
    commandAuthorized,
  };
}

/** Convert resolved DM policy into a pre-crypto allow/block/pairing callback. */
export function createPreCryptoDirectDmAuthorizer(params: {
  resolveAccess: (
    senderId: string,
  ) => Promise<Pick<ResolvedInboundDirectDmAccess, "access"> | ResolvedInboundDirectDmAccess>;
  issuePairingChallenge?: (params: {
    senderId: string;
    reply: (text: string) => Promise<void>;
  }) => Promise<void>;
  onBlocked?: (params: {
    senderId: string;
    reason: string;
    reasonCode: DmGroupAccessReasonCode;
  }) => void;
}) {
  return async (input: {
    senderId: string;
    reply: (text: string) => Promise<void>;
  }): Promise<"allow" | "block" | "pairing"> => {
    const resolved = await params.resolveAccess(input.senderId);
    const access = "access" in resolved ? resolved.access : resolved;
    if (access.decision === "allow") {
      return "allow";
    }
    if (access.decision === "pairing") {
      if (params.issuePairingChallenge) {
        await params.issuePairingChallenge({
          senderId: input.senderId,
          reply: input.reply,
        });
      }
      return "pairing";
    }
    params.onBlocked?.({
      senderId: input.senderId,
      reason: access.reason,
      reasonCode: access.reasonCode,
    });
    return "block";
  };
}

export type DirectDmPreCryptoGuardPolicy = {
  allowedKinds: readonly number[];
  maxFutureSkewSec: number;
  maxCiphertextBytes: number;
  maxPlaintextBytes: number;
  rateLimit: {
    windowMs: number;
    maxPerSenderPerWindow: number;
    maxGlobalPerWindow: number;
    maxTrackedSenderKeys: number;
  };
};

export type DirectDmPreCryptoGuardPolicyOverrides = Partial<
  Omit<DirectDmPreCryptoGuardPolicy, "rateLimit">
> & {
  rateLimit?: Partial<DirectDmPreCryptoGuardPolicy["rateLimit"]>;
};

/** Shared policy object for DM-style pre-crypto guardrails. */
export function createDirectDmPreCryptoGuardPolicy(
  overrides: DirectDmPreCryptoGuardPolicyOverrides = {},
): DirectDmPreCryptoGuardPolicy {
  return {
    allowedKinds: overrides.allowedKinds ?? [4],
    maxFutureSkewSec: overrides.maxFutureSkewSec ?? 120,
    maxCiphertextBytes: overrides.maxCiphertextBytes ?? 16 * 1024,
    maxPlaintextBytes: overrides.maxPlaintextBytes ?? 8 * 1024,
    rateLimit: {
      windowMs: overrides.rateLimit?.windowMs ?? 60_000,
      maxPerSenderPerWindow: overrides.rateLimit?.maxPerSenderPerWindow ?? 20,
      maxGlobalPerWindow: overrides.rateLimit?.maxGlobalPerWindow ?? 200,
      maxTrackedSenderKeys: overrides.rateLimit?.maxTrackedSenderKeys ?? 4096,
    },
  };
}

type DirectDmRoutePeer = {
  kind: "direct";
  id: string;
};

type DirectDmRoute = {
  agentId: string;
  sessionKey: string;
  accountId?: string;
};

type DirectDmRuntime = {
  channel: {
    routing: {
      resolveAgentRoute: (params: {
        cfg: OpenClawConfig;
        channel: string;
        accountId: string;
        peer: DirectDmRoutePeer;
      }) => DirectDmRoute;
    };
    session: {
      resolveStorePath: typeof import("../config/sessions.js").resolveStorePath;
      readSessionUpdatedAt: (params: {
        storePath: string;
        sessionKey: string;
      }) => number | undefined;
      recordInboundSession: typeof import("../channels/session.js").recordInboundSession;
    };
    reply: {
      resolveEnvelopeFormatOptions: (
        cfg: OpenClawConfig,
      ) => ReturnType<typeof import("../auto-reply/envelope.js").resolveEnvelopeFormatOptions>;
      formatAgentEnvelope: typeof import("../auto-reply/envelope.js").formatAgentEnvelope;
      finalizeInboundContext: typeof import("../auto-reply/reply/inbound-context.js").finalizeInboundContext;
      dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
    };
  };
};

/** Route, envelope, record, and dispatch one direct-DM turn through the standard pipeline. */
export async function dispatchInboundDirectDmWithRuntime(params: {
  cfg: OpenClawConfig;
  runtime: DirectDmRuntime;
  channel: string;
  channelLabel: string;
  accountId: string;
  peer: DirectDmRoutePeer;
  senderId: string;
  senderAddress: string;
  recipientAddress: string;
  conversationLabel: string;
  rawBody: string;
  messageId: string;
  timestamp?: number;
  commandAuthorized?: boolean;
  bodyForAgent?: string;
  commandBody?: string;
  provider?: string;
  surface?: string;
  originatingChannel?: string;
  originatingTo?: string;
  extraContext?: Record<string, unknown>;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
}): Promise<{
  route: DirectDmRoute;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
}> {
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    runtime: params.runtime.channel,
    sessionStore: params.cfg.session?.store,
  });

  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: params.rawBody,
    timestamp: params.timestamp,
  });

  const ctxPayload = params.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.bodyForAgent ?? params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.commandBody ?? params.rawBody,
    From: params.senderAddress,
    To: params.recipientAddress,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.accountId,
    ChatType: "direct",
    ConversationLabel: params.conversationLabel,
    SenderId: params.senderId,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.channel,
    MessageSid: params.messageId,
    MessageSidFull: params.messageId,
    Timestamp: params.timestamp,
    CommandAuthorized: params.commandAuthorized,
    OriginatingChannel: params.originatingChannel ?? params.channel,
    OriginatingTo: params.originatingTo ?? params.recipientAddress,
    ...params.extraContext,
  });

  await recordInboundSessionAndDispatchReply({
    cfg: params.cfg,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: params.runtime.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      params.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    deliver: params.deliver,
    onRecordError: params.onRecordError,
    onDispatchError: params.onDispatchError,
  });

  return {
    route,
    storePath,
    ctxPayload,
  };
}
