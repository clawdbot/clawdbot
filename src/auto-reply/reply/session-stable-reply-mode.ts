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
} from "../../agents/subagent-capabilities.js";
import { isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../agents/tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FinalizedMsgContext } from "../templating.js";
import { resolveVisibleRepliesPolicy } from "./dispatch-from-config.harness-defaults.js";
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
  const stableReplyContext = {
    CommandAuthorized: false,
    ChatType: chatType,
    Provider:
      normalizeOptionalString(ctx.Provider) ?? sessionDeliveryOrigin(sessionEntry)?.provider,
    Surface: normalizeOptionalString(ctx.Surface) ?? sessionDeliveryChannel(sessionEntry),
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
  // is policy-denied; the stable fact must downgrade identically or the two
  // turn kinds hash different policies. Sender fields are deliberately absent:
  // session-stable policy cannot vary by sender.
  return resolveSourceReplyDeliveryMode({
    cfg,
    ctx: stableReplyContext,
    defaultVisibleReplies: harnessDefaultVisibleReplies,
    messageToolAvailable: resolveStableMessageToolAvailability(params),
  });
}

function resolveStableMessageToolAvailability(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  sessionAgentId: string;
  sessionKey?: string;
}): boolean {
  const { cfg, ctx } = params;
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
  const groupPolicy = resolveGroupToolPolicy({
    config: cfg,
    sessionKey: params.sessionKey,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: ctx.OriginatingChannel,
      provider: ctx.Provider ?? ctx.Surface,
    }),
    groupId: resolveGroupSessionKey(ctx)?.id,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    accountId: ctx.AccountId,
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
