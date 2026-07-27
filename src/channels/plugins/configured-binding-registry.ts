/**
 * Configured binding registry.
 *
 * Primes, counts, and resolves compiled binding records from config and conversation facts.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import type {
  ConfiguredBindingRecordResolution,
  ConfiguredBindingResolution,
} from "./binding-types.js";
import {
  countCompiledBindingRegistry,
  primeCompiledBindingRegistry,
  resolveCompiledBindingRegistry,
} from "./configured-binding-compiler.js";
import {
  materializeConfiguredBindingRecord,
  resolveMatchingConfiguredBinding,
  toConfiguredBindingConversationRef,
} from "./configured-binding-match.js";
import { resolveConfiguredBindingRecordBySessionKeyFromRegistry } from "./configured-binding-session-lookup.js";

function resolveMaterializedConfiguredBinding(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}) {
  const conversation = toConfiguredBindingConversationRef(params.conversation);
  if (!conversation) {
    return null;
  }
  const rules = resolveCompiledBindingRegistry(params.cfg).rulesByChannel.get(conversation.channel);
  if (!rules || rules.length === 0) {
    return null;
  }
  const resolved = resolveMatchingConfiguredBinding({
    rules,
    conversation,
  });
  if (!resolved) {
    return null;
  }
  // Matching returns provider-specific target facts; materialization turns them into the
  // persisted session binding record and stateful target descriptor used at runtime.
  return {
    conversation,
    resolved,
    materializedTarget: materializeConfiguredBindingRecord({
      rule: resolved.rule,
      accountId: conversation.accountId,
      conversation: resolved.match,
    }),
  };
}

/**
 * Warms and counts the compiled configured binding registry for a config snapshot.
 */
export function primeConfiguredBindingRegistry(params: { cfg: OpenClawConfig }): {
  bindingCount: number;
  channelCount: number;
} {
  return countCompiledBindingRegistry(primeCompiledBindingRegistry(params.cfg));
}

/**
 * Resolves a configured binding record from explicit channel/account/conversation ids.
 */
export function resolveConfiguredBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ConfiguredBindingRecordResolution | null {
  const conversation = toConfiguredBindingConversationRef({
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!conversation) {
    return null;
  }
  return resolveConfiguredBindingRecordForConversation({
    cfg: params.cfg,
    conversation,
  });
}

/**
 * Resolves a configured binding record from a normalized conversation reference.
 */
function resolveConfiguredBindingRecordForConversation(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): ConfiguredBindingRecordResolution | null {
  const resolved = resolveMaterializedConfiguredBinding(params);
  if (!resolved) {
    return null;
  }
  return resolved.materializedTarget;
}

/**
 * Resolves the full configured binding match, including compiled rule and match diagnostics.
 */
export function resolveConfiguredBinding(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): ConfiguredBindingResolution | null {
  const resolved = resolveMaterializedConfiguredBinding(params);
  if (!resolved) {
    return null;
  }
  return {
    conversation: resolved.conversation,
    compiledBinding: resolved.resolved.rule,
    match: resolved.resolved.match,
    ...resolved.materializedTarget,
  };
}

/**
 * Resolves a configured binding record by the stateful target session key.
 */
export function resolveConfiguredBindingRecordBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): ConfiguredBindingRecordResolution | null {
  return resolveConfiguredBindingRecordBySessionKeyFromRegistry({
    registry: resolveCompiledBindingRegistry(params.cfg),
    sessionKey: params.sessionKey,
  });
}
