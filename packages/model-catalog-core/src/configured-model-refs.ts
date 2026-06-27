// Collects configured model references from OpenClaw config-shaped objects.
import { normalizeProviderId } from "./provider-id.js";

/** Narrow unknown values to plain records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One configured model reference plus its config path. */
export type ConfiguredModelRef = {
  path: string;
  value: string;
};

/** Agent config keys that can contain direct model references. */
export const AGENT_MODEL_CONFIG_KEYS = [
  "model",
  "utilityModel",
  "imageModel",
  "voiceModel",
  "pdfModel",
] as const;

/** List raw refs from one string or primary/fallback model selector. */
export function listModelRefsFromConfigValue(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!isRecord(value)) {
    return [];
  }
  const refs: string[] = [];
  if (typeof value.primary === "string") {
    refs.push(value.primary);
  }
  if (Array.isArray(value.fallbacks)) {
    for (const fallback of value.fallbacks) {
      if (typeof fallback === "string") {
        refs.push(fallback);
      }
    }
  }
  return refs;
}

/** Collect configured model references from agents, channels, hooks, and message config. */
export function collectConfiguredModelRefs(
  config: unknown,
  options: { includeChannelModelOverrides?: boolean } = {},
): ConfiguredModelRef[] {
  const refs: ConfiguredModelRef[] = [];
  const pushModelRef = (path: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      refs.push({ path, value: value.trim() });
    }
  };
  const collectModelConfig = (path: string, value: unknown) => {
    if (typeof value === "string") {
      pushModelRef(path, value);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    pushModelRef(`${path}.primary`, value.primary);
    if (Array.isArray(value.fallbacks)) {
      for (const [index, entry] of value.fallbacks.entries()) {
        pushModelRef(`${path}.fallbacks.${index}`, entry);
      }
    }
  };
  const collectFromAgent = (path: string, agent: unknown) => {
    if (!isRecord(agent)) {
      return;
    }
    for (const key of AGENT_MODEL_CONFIG_KEYS) {
      collectModelConfig(`${path}.${key}`, agent[key]);
    }
    const mediaModels = isRecord(agent.mediaModels) ? agent.mediaModels : {};
    for (const capability of ["image", "video", "music"] as const) {
      collectModelConfig(`${path}.mediaModels.${capability}`, mediaModels[capability]);
    }
    pushModelRef(
      `${path}.heartbeat.model`,
      isRecord(agent.heartbeat) ? agent.heartbeat.model : undefined,
    );
    collectModelConfig(
      `${path}.subagents.model`,
      isRecord(agent.subagents) ? agent.subagents.model : undefined,
    );
    if (isRecord(agent.compaction)) {
      pushModelRef(`${path}.compaction.model`, agent.compaction.model);
      pushModelRef(
        `${path}.compaction.memoryFlush.model`,
        isRecord(agent.compaction.memoryFlush) ? agent.compaction.memoryFlush.model : undefined,
      );
    }
    if (isRecord(agent.models)) {
      for (const modelRef of Object.keys(agent.models)) {
        pushModelRef(`${path}.models.${modelRef}`, modelRef);
      }
    }
  };

  const root = isRecord(config) ? config : {};
  const agents = isRecord(root.agents) ? root.agents : {};
  collectFromAgent("agents.defaults", agents.defaults);
  if (isRecord(agents.entries)) {
    for (const [agentId, entry] of Object.entries(agents.entries)) {
      collectFromAgent(`agents.entries.${agentId}`, entry);
    }
  } else if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      collectFromAgent(`agents.list.${index}`, entry);
    }
  }
  if (options.includeChannelModelOverrides !== false) {
    const channels = isRecord(root.channels) ? root.channels : {};
    const modelByChannel = isRecord(channels.modelByChannel) ? channels.modelByChannel : {};
    for (const [channelId, channelMap] of Object.entries(modelByChannel)) {
      if (!isRecord(channelMap)) {
        continue;
      }
      for (const [targetId, modelRef] of Object.entries(channelMap)) {
        pushModelRef(`channels.modelByChannel.${channelId}.${targetId}`, modelRef);
      }
    }
  }
  const hooks = isRecord(root.hooks) ? root.hooks : {};
  if (Array.isArray(hooks.mappings)) {
    for (const [index, mapping] of hooks.mappings.entries()) {
      pushModelRef(`hooks.mappings.${index}.model`, isRecord(mapping) ? mapping.model : undefined);
    }
  }
  pushModelRef("hooks.gmail.model", isRecord(hooks.gmail) ? hooks.gmail.model : undefined);
  pushModelRef("tts.summaryModel", isRecord(root.tts) ? root.tts.summaryModel : undefined);
  pushModelRef(
    "channels.discord.voice.model",
    isRecord(root.channels) &&
      isRecord(root.channels.discord) &&
      isRecord(root.channels.discord.voice)
      ? root.channels.discord.voice.model
      : undefined,
  );
  return refs;
}

/** Collect only configured model reference values. */
export function collectConfiguredModelRefValues(
  config: unknown,
  options?: { includeChannelModelOverrides?: boolean },
): string[] {
  return collectConfiguredModelRefs(config, options).map((ref) => ref.value);
}
/** Extract a normalized provider id from a provider/model reference. */
export function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalizeProviderId(trimmed.slice(0, slash));
}

/** One pruned model reference plus its config path and prune reason. */
export type PrunedModelRef = {
  path: string;
  value: string;
  reason: "missing-provider" | "rewritten";
};

/** Prune orphan model refs whose provider is not in the known provider set. Returns immutable config clone. */
export function pruneOrphanModelRefs(
  config: unknown,
  knownProviderIds: ReadonlySet<string>,
): { config: unknown; pruned: PrunedModelRef[] } {
  const pruned: PrunedModelRef[] = [];
  const root = isRecord(config) ? { ...config } : {};
  const agents = isRecord(root.agents) ? { ...root.agents } : {};

  const shouldPruneRef = (ref: string): boolean => {
    const provider = extractProviderFromModelRef(ref);
    return provider !== null && !knownProviderIds.has(provider);
  };

  // Compute fallback primary ref: agents.defaults.model.primary or first available provider
  const computeFallbackPrimary = (): string | null => {
    const defaultsModel = isRecord(agents.defaults) ? agents.defaults.model : undefined;
    const defaultPrimary =
      typeof defaultsModel === "string"
        ? defaultsModel
        : isRecord(defaultsModel)
          ? defaultsModel.primary
          : undefined;
    if (typeof defaultPrimary === "string" && !shouldPruneRef(defaultPrimary)) {
      return defaultPrimary;
    }
    const firstProvider = Array.from(knownProviderIds)[0];
    return firstProvider ? `${firstProvider}/default` : null;
  };

  const fallbackPrimary = computeFallbackPrimary();

  const pruneModelConfig = (path: string, value: unknown): unknown => {
    if (typeof value === "string") {
      if (shouldPruneRef(value)) {
        pruned.push({ path, value, reason: "missing-provider" });
        return fallbackPrimary ?? value;
      }
      return value;
    }
    if (!isRecord(value)) {
      return value;
    }
    const next: Record<string, unknown> = { ...value };
    if (typeof value.primary === "string" && shouldPruneRef(value.primary)) {
      pruned.push({ path: `${path}.primary`, value: value.primary, reason: "rewritten" });
      next.primary = fallbackPrimary ?? value.primary;
    }
    if (Array.isArray(value.fallbacks)) {
      next.fallbacks = value.fallbacks.filter((entry, index) => {
        if (typeof entry === "string" && shouldPruneRef(entry)) {
          pruned.push({
            path: `${path}.fallbacks.${index}`,
            value: entry,
            reason: "missing-provider",
          });
          return false;
        }
        return true;
      });
    }
    return next;
  };

  const pruneFromAgent = (path: string, agent: unknown): unknown => {
    if (!isRecord(agent)) {
      return agent;
    }
    const next: Record<string, unknown> = { ...agent };
    for (const key of AGENT_MODEL_CONFIG_KEYS) {
      if (agent[key] !== undefined) {
        next[key] = pruneModelConfig(`${path}.${key}`, agent[key]);
      }
    }
    if (isRecord(agent.heartbeat) && typeof agent.heartbeat.model === "string") {
      if (shouldPruneRef(agent.heartbeat.model)) {
        pruned.push({
          path: `${path}.heartbeat.model`,
          value: agent.heartbeat.model,
          reason: "rewritten",
        });
        const heartbeat: Record<string, unknown> = {
          ...agent.heartbeat,
          model: fallbackPrimary ?? agent.heartbeat.model,
        };
        next.heartbeat = heartbeat;
      }
    }
    if (agent.subagents !== undefined) {
      const subagents = isRecord(agent.subagents) ? agent.subagents : {};
      next.subagents = { ...subagents };
      if (isRecord(next.subagents)) {
        next.subagents.model = pruneModelConfig(`${path}.subagents.model`, subagents.model);
      }
    }
    if (isRecord(agent.compaction)) {
      const compaction: Record<string, unknown> = { ...agent.compaction };
      next.compaction = compaction;
      if (typeof agent.compaction.model === "string" && shouldPruneRef(agent.compaction.model)) {
        pruned.push({
          path: `${path}.compaction.model`,
          value: agent.compaction.model,
          reason: "rewritten",
        });
        compaction.model = fallbackPrimary ?? agent.compaction.model;
      }
      if (
        isRecord(agent.compaction.memoryFlush) &&
        typeof agent.compaction.memoryFlush.model === "string"
      ) {
        if (shouldPruneRef(agent.compaction.memoryFlush.model)) {
          pruned.push({
            path: `${path}.compaction.memoryFlush.model`,
            value: agent.compaction.memoryFlush.model,
            reason: "rewritten",
          });
          compaction.memoryFlush = {
            ...agent.compaction.memoryFlush,
            model: fallbackPrimary ?? agent.compaction.memoryFlush.model,
          };
        }
      }
    }
    if (isRecord(agent.models)) {
      const nextModels: Record<string, unknown> = {};
      for (const [modelRef, entry] of Object.entries(agent.models)) {
        if (!shouldPruneRef(modelRef)) {
          nextModels[modelRef] = entry;
        } else {
          pruned.push({
            path: `${path}.models.${modelRef}`,
            value: modelRef,
            reason: "missing-provider",
          });
        }
      }
      next.models = nextModels;
    }
    return next;
  };

  agents.defaults = pruneFromAgent("agents.defaults", agents.defaults);
  if (Array.isArray(agents.list)) {
    agents.list = agents.list.map((entry, index) => pruneFromAgent(`agents.list.${index}`, entry));
  }

  root.agents = agents;

  // Prune hooks
  if (isRecord(root.hooks)) {
    const hooks: Record<string, unknown> = { ...root.hooks };
    if (Array.isArray(hooks.mappings)) {
      hooks.mappings = hooks.mappings.map((mapping, index) => {
        if (
          isRecord(mapping) &&
          typeof mapping.model === "string" &&
          shouldPruneRef(mapping.model)
        ) {
          pruned.push({
            path: `hooks.mappings.${index}.model`,
            value: mapping.model,
            reason: "rewritten",
          });
          return { ...mapping, model: fallbackPrimary ?? mapping.model };
        }
        return mapping;
      });
    }
    if (isRecord(hooks.gmail) && typeof hooks.gmail.model === "string") {
      if (shouldPruneRef(hooks.gmail.model)) {
        pruned.push({ path: "hooks.gmail.model", value: hooks.gmail.model, reason: "rewritten" });
        hooks.gmail = { ...hooks.gmail, model: fallbackPrimary ?? hooks.gmail.model };
      }
    }
    root.hooks = hooks;
  }

  // Prune messages
  if (isRecord(root.messages)) {
    const messages: Record<string, unknown> = { ...root.messages };
    if (isRecord(messages.tts) && typeof messages.tts.summaryModel === "string") {
      if (shouldPruneRef(messages.tts.summaryModel)) {
        pruned.push({
          path: "messages.tts.summaryModel",
          value: messages.tts.summaryModel,
          reason: "rewritten",
        });
        messages.tts = {
          ...messages.tts,
          summaryModel: fallbackPrimary ?? messages.tts.summaryModel,
        };
      }
    }
    root.messages = messages;
  }

  // Prune channels
  if (isRecord(root.channels)) {
    const channels: Record<string, unknown> = { ...root.channels };
    if (isRecord(channels.modelByChannel)) {
      const modelByChannel: Record<string, unknown> = {};
      for (const [channelId, channelMap] of Object.entries(channels.modelByChannel)) {
        if (!isRecord(channelMap)) {
          modelByChannel[channelId] = channelMap;
          continue;
        }
        const nextChannelMap: Record<string, unknown> = {};
        for (const [targetId, modelRef] of Object.entries(channelMap)) {
          if (typeof modelRef === "string" && shouldPruneRef(modelRef)) {
            pruned.push({
              path: `channels.modelByChannel.${channelId}.${targetId}`,
              value: modelRef,
              reason: "rewritten",
            });
            nextChannelMap[targetId] = fallbackPrimary ?? modelRef;
          } else {
            nextChannelMap[targetId] = modelRef;
          }
        }
        modelByChannel[channelId] = nextChannelMap;
      }
      channels.modelByChannel = modelByChannel;
    }
    if (
      isRecord(channels.discord) &&
      isRecord(channels.discord.voice) &&
      typeof channels.discord.voice.model === "string"
    ) {
      if (shouldPruneRef(channels.discord.voice.model)) {
        pruned.push({
          path: "channels.discord.voice.model",
          value: channels.discord.voice.model,
          reason: "rewritten",
        });
        channels.discord = {
          ...channels.discord,
          voice: {
            ...channels.discord.voice,
            model: fallbackPrimary ?? channels.discord.voice.model,
          },
        };
      }
    }
    root.channels = channels;
  }

  return { config: root, pruned };
}
