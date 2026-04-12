import { listConfiguredBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getActivePluginChannelRegistryVersion,
  requireActivePluginChannelRegistry,
} from "../../plugins/runtime.js";
import { pickFirstExistingAgentId } from "../../routing/resolve-route.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { resolveChannelConfiguredBindingProvider } from "./binding-provider.js";
import type { CompiledConfiguredBinding, ConfiguredBindingChannel } from "./binding-types.js";
import { resolveConfiguredBindingConsumer } from "./configured-binding-consumers.js";
import { getChannelPlugin } from "./index.js";
import type {
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingProvider,
} from "./types.adapters.js";

// Configured bindings are channel-owned rules compiled from config, separate
// from runtime plugin-owned conversation bindings.

export type CompiledConfiguredBindingRegistry = {
  rulesByChannel: Map<ConfiguredBindingChannel, CompiledConfiguredBinding[]>;
};

type CachedCompiledConfiguredBindingRegistry = {
  registryRef: object | null;
  registryVersion: number;
  registry: CompiledConfiguredBindingRegistry;
};

const compiledRegistryCache = new WeakMap<
  OpenClawConfig,
  CachedCompiledConfiguredBindingRegistry
>();

function resolveLoadedChannelPlugin(channel: string) {
  const normalized = normalizeOptionalLowercaseString(channel);
  if (!normalized) {
    return undefined;
  }
  return getChannelPlugin(normalized as ConfiguredBindingChannel);
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
}): CompiledConfiguredBinding | null {
  const agentId = pickFirstExistingAgentId(params.cfg, params.binding.agentId ?? "main");
  const consumer = resolveConfiguredBindingConsumer(params.binding);
  if (!consumer) {
    return null;
  }
  const targetFactory = consumer.buildTargetFactory({
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
  const activeRegistry = requireActivePluginChannelRegistry();
  const registryVersion = getActivePluginChannelRegistryVersion();
  const cached = compiledRegistryCache.get(cfg);
  if (cached?.registryVersion === registryVersion && cached.registryRef === activeRegistry) {
    return cached.registry;
  }

  const registry = compileConfiguredBindingRegistry({
    cfg,
  });
  compiledRegistryCache.set(cfg, {
    registryRef: activeRegistry,
    registryVersion,
    registry,
  });
  return registry;
}

export function primeCompiledBindingRegistry(
  cfg: OpenClawConfig,
): CompiledConfiguredBindingRegistry {
  const activeRegistry = requireActivePluginChannelRegistry();
  const registry = compileConfiguredBindingRegistry({ cfg });
  compiledRegistryCache.set(cfg, {
    registryRef: activeRegistry,
    registryVersion: getActivePluginChannelRegistryVersion(),
    registry,
  });
  return registry;
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
