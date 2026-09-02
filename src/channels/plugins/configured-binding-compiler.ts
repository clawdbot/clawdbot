/**
 * Configured binding compiler.
 *
 * Compiles config rules into channel/provider-specific binding registry entries.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { listConfiguredBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pickFirstExistingAgentId } from "../../routing/resolve-route.js";
import { resolveChannelConfiguredBindingProvider } from "./binding-provider.js";
import type { CompiledConfiguredBinding, ConfiguredBindingChannel } from "./binding-types.js";
import { resolveConfiguredBindingConsumer } from "./configured-binding-consumers.js";
import { getLoadedChannelPlugin } from "./index.js";
import type { ChannelConfiguredBindingProvider } from "./types.adapters.js";

export type CompiledConfiguredBindingRegistry = {
  rulesByChannel: Map<ConfiguredBindingChannel, CompiledConfiguredBinding[]>;
};

function resolveConfiguredBindingAdapter(channel: string): {
  channel: ConfiguredBindingChannel;
  provider: ChannelConfiguredBindingProvider;
} | null {
  const normalized = normalizeOptionalLowercaseString(channel);
  if (!normalized) {
    return null;
  }
  const plugin = getLoadedChannelPlugin(normalized as ConfiguredBindingChannel);
  const provider = resolveChannelConfiguredBindingProvider(plugin);
  if (
    !plugin ||
    !provider ||
    !provider.compileConfiguredBinding ||
    !provider.matchInboundConversation
  ) {
    return null;
  }
  return {
    channel: plugin.id,
    provider,
  };
}

export function resolveCompiledBindingRegistry(
  cfg: OpenClawConfig,
): CompiledConfiguredBindingRegistry {
  const rulesByChannel = new Map<ConfiguredBindingChannel, CompiledConfiguredBinding[]>();

  for (const binding of listConfiguredBindings(cfg)) {
    // Ordinary routing bindings share the config array but have no stateful target consumer.
    // Reject them before consulting the loaded channel registry on request-time route lookups.
    const consumer = resolveConfiguredBindingConsumer(binding);
    if (!consumer) {
      continue;
    }
    const bindingConversationId = normalizeOptionalString(binding.match?.peer?.id);
    if (!bindingConversationId) {
      continue;
    }

    const resolvedChannel = resolveConfiguredBindingAdapter(binding.match.channel);
    if (!resolvedChannel) {
      continue;
    }

    const target = resolvedChannel.provider.compileConfiguredBinding({
      binding,
      conversationId: bindingConversationId,
    });
    if (!target) {
      continue;
    }

    const agentId = pickFirstExistingAgentId(cfg, binding.agentId ?? "main");
    const targetFactory = consumer.buildTargetFactory({
      cfg,
      binding,
      channel: resolvedChannel.channel,
      agentId,
      target,
      bindingConversationId,
    });
    if (!targetFactory) {
      continue;
    }
    const rule: CompiledConfiguredBinding = {
      channel: resolvedChannel.channel,
      accountPattern: normalizeOptionalString(binding.match.accountId),
      binding,
      bindingConversationId,
      target,
      agentId,
      provider: resolvedChannel.provider,
      targetFactory,
    };
    const existing = rulesByChannel.get(rule.channel);
    if (existing) {
      existing.push(rule);
    } else {
      rulesByChannel.set(rule.channel, [rule]);
    }
  }

  return { rulesByChannel };
}
