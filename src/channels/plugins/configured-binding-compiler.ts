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
import {
  resolveConfiguredBindingConsumer,
  type ConfiguredBindingConsumer,
} from "./configured-binding-consumers.js";
import { getLoadedChannelPlugin } from "./index.js";
import type {
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingProvider,
} from "./types.adapters.js";

export type CompiledConfiguredBindingRegistry = {
  rulesByChannel: Map<ConfiguredBindingChannel, CompiledConfiguredBinding[]>;
};

function resolveLoadedChannelPlugin(channel: string) {
  const normalized = normalizeOptionalLowercaseString(channel);
  if (!normalized) {
    return undefined;
  }
  return getLoadedChannelPlugin(normalized as ConfiguredBindingChannel);
}

function resolveConfiguredBindingAdapter(channel: string): {
  channel: ConfiguredBindingChannel;
  provider: ChannelConfiguredBindingProvider;
} | null {
  const normalized = normalizeOptionalLowercaseString(channel);
  if (!normalized) {
    return null;
  }
  const plugin = resolveLoadedChannelPlugin(normalized);
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

function resolveBindingConversationId(binding: {
  match?: { peer?: { id?: string } };
}): string | null {
  return normalizeOptionalString(binding.match?.peer?.id) ?? null;
}

function compileConfiguredBindingTarget(params: {
  provider: ChannelConfiguredBindingProvider;
  binding: CompiledConfiguredBinding["binding"];
  conversationId: string;
}): ChannelConfiguredBindingConversationRef | null {
  return params.provider.compileConfiguredBinding({
    binding: params.binding,
    conversationId: params.conversationId,
  });
}

function compileConfiguredBindingRule(params: {
  cfg: OpenClawConfig;
  channel: ConfiguredBindingChannel;
  binding: CompiledConfiguredBinding["binding"];
  target: ChannelConfiguredBindingConversationRef;
  bindingConversationId: string;
  provider: ChannelConfiguredBindingProvider;
  consumer: ConfiguredBindingConsumer;
}): CompiledConfiguredBinding | null {
  const agentId = pickFirstExistingAgentId(params.cfg, params.binding.agentId ?? "main");
  const targetFactory = params.consumer.buildTargetFactory({
    cfg: params.cfg,
    binding: params.binding,
    channel: params.channel,
    agentId,
    target: params.target,
    bindingConversationId: params.bindingConversationId,
  });
  if (!targetFactory) {
    return null;
  }
  return {
    channel: params.channel,
    accountPattern: normalizeOptionalString(params.binding.match.accountId),
    binding: params.binding,
    bindingConversationId: params.bindingConversationId,
    target: params.target,
    agentId,
    provider: params.provider,
    targetFactory,
  };
}

function pushCompiledRule(
  target: Map<ConfiguredBindingChannel, CompiledConfiguredBinding[]>,
  rule: CompiledConfiguredBinding,
) {
  const existing = target.get(rule.channel);
  if (existing) {
    existing.push(rule);
    return;
  }
  target.set(rule.channel, [rule]);
}

function compileConfiguredBindingRegistry(params: {
  cfg: OpenClawConfig;
}): CompiledConfiguredBindingRegistry {
  const rulesByChannel = new Map<ConfiguredBindingChannel, CompiledConfiguredBinding[]>();

  for (const binding of listConfiguredBindings(params.cfg)) {
    // Ordinary routing bindings share the config array but have no stateful target consumer.
    // Reject them before consulting the loaded channel registry on request-time route lookups.
    const consumer = resolveConfiguredBindingConsumer(binding);
    if (!consumer) {
      continue;
    }
    const bindingConversationId = resolveBindingConversationId(binding);
    if (!bindingConversationId) {
      continue;
    }

    const resolvedChannel = resolveConfiguredBindingAdapter(binding.match.channel);
    if (!resolvedChannel) {
      continue;
    }

    const target = compileConfiguredBindingTarget({
      provider: resolvedChannel.provider,
      binding,
      conversationId: bindingConversationId,
    });
    if (!target) {
      continue;
    }

    const rule = compileConfiguredBindingRule({
      cfg: params.cfg,
      channel: resolvedChannel.channel,
      binding,
      target,
      bindingConversationId,
      provider: resolvedChannel.provider,
      consumer,
    });
    if (!rule) {
      continue;
    }
    pushCompiledRule(rulesByChannel, rule);
  }

  return {
    rulesByChannel,
  };
}

export function resolveCompiledBindingRegistry(
  cfg: OpenClawConfig,
): CompiledConfiguredBindingRegistry {
  return compileConfiguredBindingRegistry({ cfg });
}

export function primeCompiledBindingRegistry(
  cfg: OpenClawConfig,
): CompiledConfiguredBindingRegistry {
  return compileConfiguredBindingRegistry({ cfg });
}

export function countCompiledBindingRegistry(registry: CompiledConfiguredBindingRegistry): {
  bindingCount: number;
  channelCount: number;
} {
  return {
    bindingCount: [...registry.rulesByChannel.values()].reduce(
      (sum, rules) => sum + rules.length,
      0,
    ),
    channelCount: registry.rulesByChannel.size,
  };
}
