// Session-stable source-reply mode for synthetic turns (heartbeat wakes,
// system events, inter-session announcements) that reach the reply resolver
// without dispatch's injected delivery-mode facts.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../../agents/agent-tools.policy.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../agents/subagents/spawn/subagent-capabilities.js";
import { isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../agents/tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FinalizedMsgContext } from "../templating.js";
import { resolveVisibleRepliesPolicy } from "./dispatch-from-config.harness-defaults.js";
import { isSystemEventProvider } from "./effective-reply-route.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode.js";

/**
 * Resolves the session's stable source-reply mode the way dispatch does, from
 * a synthetic turn's restored context plus persisted session facts. Synthetic
 * turns keep their effective delivery mode, but CLI session reuse belongs to
 * the session's normal source-reply policy — every turn kind must derive the
 * same messageToolPolicyHash, or chat and heartbeat turns ping-pong the CLI
 * binding on each transition (#121485).
 */
export function resolveSessionStableReplyMode(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  sessionEntry: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  turnModelOverride?: string;
}): SourceReplyDeliveryMode {
  const { cfg, ctx, sessionEntry } = params;
  const chatType =
    normalizeChatType(ctx.ChatType) ?? normalizeChatType(sessionEntry.chatType) ?? undefined;
  // System-event provider strings ("heartbeat", "cron-event") are wake
  // plumbing, not the session's surface; an entry with no persisted delivery
  // origin has only ever been driven internally, so it must resolve the same
  // internal-channel branch dispatch's live webchat turns do.
  const stableReplyContext = {
    CommandAuthorized: false,
    ChatType: chatType,
    Provider:
      resolveStableChannelFact(ctx.Provider) ??
      sessionDeliveryOrigin(sessionEntry)?.provider ??
      INTERNAL_MESSAGE_CHANNEL,
    Surface: resolveStableChannelFact(ctx.Surface) ?? sessionDeliveryChannel(sessionEntry),
    ExplicitDeliverRoute: ctx.ExplicitDeliverRoute,
  };
  const { harnessDefaultVisibleReplies } = resolveVisibleRepliesPolicy({
    cfg,
    chatType,
    ctx,
    entry: sessionEntry,
    sessionAgentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
    sessionStore: params.sessionStore,
    turnModelOverride: params.turnModelOverride,
  });
  const candidateMode = resolveSourceReplyDeliveryMode({
    cfg,
    ctx: stableReplyContext,
    defaultVisibleReplies: harnessDefaultVisibleReplies,
  });
  if (candidateMode !== "message_tool_only") {
    return candidateMode;
  }
  // Dispatch downgrades tool-only delivery to automatic when the message tool
  // is policy-denied (source-reply-delivery-mode.ts availability gate); with a
  // stable ctx that is the boolean's only effect, so apply it directly rather
  // than re-deriving the whole mode. Sender fields are deliberately absent:
  // session-stable policy cannot vary by sender.
  return resolveStableMessageToolAvailability(params) ? candidateMode : "automatic";
}

/** Strips system-event wake providers so only real channel surfaces remain. */
function resolveStableChannelFact(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && !isSystemEventProvider(normalized) ? normalized : undefined;
}

/**
 * Sender-independent message-tool availability for the session-stable mode.
 * One owner for dispatch's stable-mode downgrade and synthetic-turn binding
 * facts: sender-scoped denials apply to the sender's turn, never to the
 * session policy every turn kind must hash identically (#121485).
 */
export function resolveStableMessageToolAvailability(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  sessionEntry?: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
}): boolean {
  const { cfg, ctx, sessionEntry } = params;
  const {
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: cfg,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
  });
  // Tool-only delivery force-allows the message tool at the profile layer
  // (dispatch's runtimeProfileAlsoAllow); only outer deny layers can make it
  // unavailable.
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), [
    ...(profileAlsoAllow ?? []),
    "message",
  ]);
  const providerProfilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(providerProfile), [
    ...(providerProfileAlsoAllow ?? []),
    "message",
  ]);
  // Direct callers (command prepare, synthetic wakes) may carry a bare ctx;
  // fall back to the persisted session facts dispatch sees on live turns, or
  // group/account-scoped policies resolve differently per producer.
  const groupPolicy = resolveGroupToolPolicy({
    config: cfg,
    sessionKey: params.sessionKey,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel:
        ctx.OriginatingChannel ?? (sessionEntry ? sessionDeliveryChannel(sessionEntry) : undefined),
      provider:
        resolveStableChannelFact(ctx.Provider ?? ctx.Surface) ??
        (sessionEntry ? sessionDeliveryOrigin(sessionEntry)?.provider : undefined),
    }),
    groupId: resolveGroupSessionKey(ctx)?.id ?? sessionEntry?.groupId,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ??
      normalizeOptionalString(ctx.GroupSubject) ??
      normalizeOptionalString(sessionEntry?.groupChannel) ??
      normalizeOptionalString(sessionEntry?.subject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    accountId:
      ctx.AccountId ??
      (sessionEntry ? deliveryContextFromSession(sessionEntry)?.accountId : undefined),
  });
  const subagentStore = resolveSubagentCapabilityStore(params.sessionKey, { cfg });
  const subagentPolicy =
    params.sessionKey && isSubagentEnvelopeSession(params.sessionKey, { cfg, store: subagentStore })
      ? resolveSubagentToolPolicyForSession(cfg, params.sessionKey, { store: subagentStore })
      : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(cfg, params.sessionKey, {
    store: subagentStore,
  });
  return isToolAllowedByPolicies("message", [
    profilePolicy,
    providerProfilePolicy,
    globalProviderPolicy,
    agentProviderPolicy,
    globalPolicy,
    agentPolicy,
    groupPolicy,
    subagentPolicy,
    inheritedToolPolicy,
  ]);
}
