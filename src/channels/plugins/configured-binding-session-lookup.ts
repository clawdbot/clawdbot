/**
 * Configured binding session lookup.
 *
 * Resolves materialized binding records from stateful target session keys.
 */
import type { ConfiguredBindingRecordResolution } from "./binding-types.js";
import type { CompiledConfiguredBindingRegistry } from "./configured-binding-compiler.js";
import { listConfiguredBindingConsumers } from "./configured-binding-consumers.js";
import {
  materializeConfiguredBindingRecord,
  resolveAccountMatchPriority,
  resolveCompiledBindingChannel,
} from "./configured-binding-match.js";

/**
 * Resolves a configured binding record from a stateful target session key.
 */
export function resolveConfiguredBindingRecordBySessionKeyFromRegistry(params: {
  registry: CompiledConfiguredBindingRegistry;
  sessionKey: string;
}): ConfiguredBindingRecordResolution | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }

  for (const consumer of listConfiguredBindingConsumers()) {
    const parsed = consumer.parseSessionKey?.({ sessionKey });
    if (!parsed) {
      continue;
    }
    const channel = resolveCompiledBindingChannel(parsed.channel);
    if (!channel) {
      continue;
    }
    const rules = params.registry.rulesByChannel.get(channel);
    if (!rules || rules.length === 0) {
      continue;
    }
    let wildcardMatch: ConfiguredBindingRecordResolution | null = null;
    let exactMatch: ConfiguredBindingRecordResolution | null = null;
    for (const rule of rules) {
      if (rule.targetFactory.driverId !== consumer.id) {
        continue;
      }
      const accountMatchPriority = resolveAccountMatchPriority(
        rule.accountPattern,
        parsed.accountId,
      );
      if (accountMatchPriority === 0) {
        continue;
      }
      // Materialize candidate targets before matching because wildcard rules can derive
      // provider-specific target session keys from parsed session-key facts.
      const materializedTarget = materializeConfiguredBindingRecord({
        rule,
        accountId: parsed.accountId,
        conversation: rule.target,
      });
      const matchesSessionKey =
        consumer.matchesSessionKey?.({
          sessionKey,
          compiledBinding: rule,
          accountId: parsed.accountId,
          materializedTarget,
        }) ?? materializedTarget.record.targetSessionKey === sessionKey;
      if (matchesSessionKey) {
        if (accountMatchPriority === 2) {
          // Exact account matches outrank wildcard account bindings for the same session key.
          exactMatch = materializedTarget;
          break;
        }
        wildcardMatch = materializedTarget;
      }
    }
    if (exactMatch) {
      return exactMatch;
    }
    if (wildcardMatch) {
      return wildcardMatch;
    }
  }

  return null;
}
