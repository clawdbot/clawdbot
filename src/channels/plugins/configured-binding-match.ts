import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import type {
  CompiledConfiguredBinding,
  ConfiguredBindingChannel,
  ConfiguredBindingRecordResolution,
} from "./binding-types.js";
import type {
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingMatch,
} from "./types.adapters.js";

export function resolveAccountMatchPriority(match: string | undefined, actual: string): 0 | 1 | 2 {
  const trimmed = (match ?? "").trim();
  if (!trimmed) {
    return actual === DEFAULT_ACCOUNT_ID ? 2 : 0;
  }
  if (trimmed === "*") {
    return 1;
  }
  return normalizeAccountId(trimmed) === actual ? 2 : 0;
}

function matchCompiledBindingConversation(params: {
  rule: CompiledConfiguredBinding;
  conversationId: string;
  parentConversationId?: string;
}): ChannelConfiguredBindingMatch | null {
  return params.rule.provider.matchInboundConversation({
    binding: params.rule.binding,
    compiledBinding: params.rule.target,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
}

export function resolveCompiledBindingChannel(raw: string): ConfiguredBindingChannel | null {
  const normalized = normalizeOptionalLowercaseString(raw);
  return normalized ? (normalized as ConfiguredBindingChannel) : null;
}

export function toConfiguredBindingConversationRef(conversation: ConversationRef): {
  channel: ConfiguredBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
} | null {
  const channel = resolveCompiledBindingChannel(conversation.channel);
  const conversationId = conversation.conversationId.trim();
  if (!channel || !conversationId) {
    return null;
  }
  return {
    channel,
    accountId: normalizeAccountId(conversation.accountId),
    conversationId,
    parentConversationId: normalizeOptionalString(conversation.parentConversationId),
  };
}

export function materializeConfiguredBindingRecord(params: {
  rule: CompiledConfiguredBinding;
  accountId: string;
  conversation: ChannelConfiguredBindingConversationRef;
}): ConfiguredBindingRecordResolution {
  return params.rule.targetFactory.materialize({
    accountId: normalizeAccountId(params.accountId),
    conversation: params.conversation,
  });
}

export function resolveMatchingConfiguredBinding(params: {
  rules: CompiledConfiguredBinding[];
  conversation: ReturnType<typeof toConfiguredBindingConversationRef>;
}): { rule: CompiledConfiguredBinding; match: ChannelConfiguredBindingMatch } | null {
  if (!params.conversation) {
    return null;
  }

  let wildcardMatch: {
    rule: CompiledConfiguredBinding;
    match: ChannelConfiguredBindingMatch;
  } | null = null;
  let exactMatch: { rule: CompiledConfiguredBinding; match: ChannelConfiguredBindingMatch } | null =
    null;

  for (const rule of params.rules) {
    const accountMatchPriority = resolveAccountMatchPriority(
      rule.accountPattern,
      params.conversation.accountId,
    );
    if (accountMatchPriority === 0) {
      continue;
    }
    const match = matchCompiledBindingConversation({
      rule,
      conversationId: params.conversation.conversationId,
      parentConversationId: params.conversation.parentConversationId,
    });
    if (!match) {
      continue;
    }
    const matchPriority = match.matchPriority ?? 0;
    if (accountMatchPriority === 2) {
      if (!exactMatch || matchPriority > (exactMatch.match.matchPriority ?? 0)) {
        exactMatch = { rule, match };
      }
      continue;
    }
    if (!wildcardMatch || matchPriority > (wildcardMatch.match.matchPriority ?? 0)) {
      wildcardMatch = { rule, match };
    }
  }

  return exactMatch ?? wildcardMatch;
}
