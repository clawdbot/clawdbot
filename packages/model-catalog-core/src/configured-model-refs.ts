import { normalizeLowercaseStringOrEmpty, normalizeProviderId } from "./provider-id.js";

// Collects configured model references from OpenClaw config-shaped objects.
import { isRecord } from "@openclaw/normalization-core/record-coerce";

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
  reason: "missing-provider" | "missing-model";
  replacement?: string;
};

export type PruneOrphanModelRefsOptions = {
  knownProviderIds: ReadonlySet<string>;
  knownModelRefs?: ReadonlySet<string>;
  fallbackModelRef?: string | null;
};

const DELETE_FIELD = Symbol("delete-field");

function extractModelFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null;
  }
  return trimmed.slice(slash + 1).trim() || null;
}

function normalizeModelRefForLookup(value: string): string | null {
  const provider = extractProviderFromModelRef(value);
  const model = extractModelFromModelRef(value);
  if (provider === null || model === null) {
    return null;
  }
  return `${provider}/${normalizeLowercaseStringOrEmpty(model)}`;
}

function normalizeKnownProviderIds(providerIds: ReadonlySet<string>): Set<string> {
  const normalized = new Set<string>();
  for (const providerId of providerIds) {
    const provider = normalizeProviderId(providerId);
    if (provider) {
      normalized.add(provider);
    }
  }
  return normalized;
}

function normalizeKnownModelRefs(modelRefs: ReadonlySet<string> | undefined): Set<string> | null {
  if (!modelRefs) {
    return null;
  }
  const normalized = new Set<string>();
  for (const modelRef of modelRefs) {
    const lookup = normalizeModelRefForLookup(modelRef);
    if (lookup) {
      normalized.add(lookup);
    }
  }
  return normalized.size > 0 ? normalized : null;
}

/** Prune configured model refs that are absent from the runtime provider/model catalog. */
export function pruneOrphanModelRefs(
  config: unknown,
  options: PruneOrphanModelRefsOptions,
): { config: unknown; pruned: PrunedModelRef[] } {
  const pruned: PrunedModelRef[] = [];
  const knownProviderIds = normalizeKnownProviderIds(options.knownProviderIds);
  const knownModelRefs = normalizeKnownModelRefs(options.knownModelRefs);
  const root = isRecord(config) ? { ...config } : {};
  const sourceAgents = isRecord(root.agents) ? root.agents : null;
  const agents: Record<string, unknown> = sourceAgents ? { ...sourceAgents } : {};

  const refIssue = (ref: string): PrunedModelRef["reason"] | null => {
    const provider = extractProviderFromModelRef(ref);
    if (provider === null) {
      return null;
    }
    if (!knownProviderIds.has(provider)) {
      return "missing-provider";
    }
    const model = extractModelFromModelRef(ref);
    if (model === "*") {
      return null;
    }
    const lookup = normalizeModelRefForLookup(ref);
    if (knownModelRefs && lookup && !knownModelRefs.has(lookup)) {
      return "missing-model";
    }
    return null;
  };

  const validRef = (ref: string): string | null => {
    const trimmed = ref.trim();
    return trimmed && refIssue(trimmed) === null ? trimmed : null;
  };

  const configuredFallbackModelRef =
    typeof options.fallbackModelRef === "string" ? validRef(options.fallbackModelRef) : null;

  const recordPruned = (path: string, value: string, replacement?: string): void => {
    const reason = refIssue(value);
    if (!reason) {
      return;
    }
    pruned.push({
      path,
      value,
      reason,
      ...(replacement ? { replacement } : {}),
    });
  };

  const computeFallbackPrimary = (): string | null => {
    const defaultsModel = isRecord(agents.defaults) ? agents.defaults.model : undefined;
    const defaultPrimary =
      typeof defaultsModel === "string"
        ? defaultsModel
        : isRecord(defaultsModel)
          ? defaultsModel.primary
          : undefined;
    if (typeof defaultPrimary === "string") {
      const validDefault = validRef(defaultPrimary);
      if (validDefault) {
        return validDefault;
      }
    }
    return configuredFallbackModelRef;
  };

  const fallbackPrimary = computeFallbackPrimary();

  const pruneModelConfig = (path: string, value: unknown): unknown => {
    if (typeof value === "string") {
      if (refIssue(value)) {
        recordPruned(path, value, fallbackPrimary ?? undefined);
        return fallbackPrimary ?? DELETE_FIELD;
      }
      return value;
    }
    if (!isRecord(value)) {
      return value;
    }
    const next: Record<string, unknown> = { ...value };
    if (typeof value.primary === "string" && refIssue(value.primary)) {
      recordPruned(`${path}.primary`, value.primary, fallbackPrimary ?? undefined);
      if (fallbackPrimary) {
        next.primary = fallbackPrimary;
      } else {
        delete next.primary;
      }
    }
    if (Array.isArray(value.fallbacks)) {
      next.fallbacks = value.fallbacks.filter((entry, index) => {
        if (typeof entry === "string" && refIssue(entry)) {
          recordPruned(`${path}.fallbacks.${index}`, entry);
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
        const prunedValue = pruneModelConfig(`${path}.${key}`, agent[key]);
        if (prunedValue === DELETE_FIELD) {
          delete next[key];
        } else {
          next[key] = prunedValue;
        }
      }
    }
    if (isRecord(agent.mediaModels)) {
      const mediaModels: Record<string, unknown> = { ...agent.mediaModels };
      for (const capability of ["image", "video", "music"] as const) {
        if (agent.mediaModels[capability] === undefined) {
          continue;
        }
        const prunedValue = pruneModelConfig(
          `${path}.mediaModels.${capability}`,
          agent.mediaModels[capability],
        );
        if (prunedValue === DELETE_FIELD) {
          delete mediaModels[capability];
        } else {
          mediaModels[capability] = prunedValue;
        }
      }
      next.mediaModels = mediaModels;
    }
    if (isRecord(agent.heartbeat) && typeof agent.heartbeat.model === "string") {
      if (refIssue(agent.heartbeat.model)) {
        recordPruned(
          `${path}.heartbeat.model`,
          agent.heartbeat.model,
          fallbackPrimary ?? undefined,
        );
        const heartbeat: Record<string, unknown> = { ...agent.heartbeat };
        if (fallbackPrimary) {
          heartbeat.model = fallbackPrimary;
        } else {
          delete heartbeat.model;
        }
        next.heartbeat = heartbeat;
      }
    }
    if (isRecord(agent.subagents)) {
      const subagents: Record<string, unknown> = { ...agent.subagents };
      const prunedValue = pruneModelConfig(`${path}.subagents.model`, agent.subagents.model);
      if (prunedValue === DELETE_FIELD) {
        delete subagents.model;
      } else {
        subagents.model = prunedValue;
      }
      next.subagents = subagents;
    }
    if (isRecord(agent.compaction)) {
      const compaction: Record<string, unknown> = { ...agent.compaction };
      next.compaction = compaction;
      if (typeof agent.compaction.model === "string" && refIssue(agent.compaction.model)) {
        recordPruned(
          `${path}.compaction.model`,
          agent.compaction.model,
          fallbackPrimary ?? undefined,
        );
        if (fallbackPrimary) {
          compaction.model = fallbackPrimary;
        } else {
          delete compaction.model;
        }
      }
      if (
        isRecord(agent.compaction.memoryFlush) &&
        typeof agent.compaction.memoryFlush.model === "string"
      ) {
        if (refIssue(agent.compaction.memoryFlush.model)) {
          recordPruned(
            `${path}.compaction.memoryFlush.model`,
            agent.compaction.memoryFlush.model,
            fallbackPrimary ?? undefined,
          );
          const memoryFlush: Record<string, unknown> = { ...agent.compaction.memoryFlush };
          if (fallbackPrimary) {
            memoryFlush.model = fallbackPrimary;
          } else {
            delete memoryFlush.model;
          }
          compaction.memoryFlush = memoryFlush;
        }
      }
    }
    if (isRecord(agent.models)) {
      const nextModels: Record<string, unknown> = {};
      for (const [modelRef, entry] of Object.entries(agent.models)) {
        if (!refIssue(modelRef)) {
          nextModels[modelRef] = entry;
        } else {
          recordPruned(`${path}.models.${modelRef}`, modelRef);
        }
      }
      next.models = nextModels;
    }
    return next;
  };

  agents.defaults = pruneFromAgent("agents.defaults", agents.defaults);
  if (isRecord(agents.entries)) {
    const entries: Record<string, unknown> = {};
    for (const [agentId, entry] of Object.entries(agents.entries)) {
      entries[agentId] = pruneFromAgent(`agents.entries.${agentId}`, entry);
    }
    agents.entries = entries;
  } else if (Array.isArray(agents.list)) {
    agents.list = agents.list.map((entry, index) => pruneFromAgent(`agents.list.${index}`, entry));
  }

  if (sourceAgents) {
    root.agents = agents;
  }

  // Prune hooks
  if (isRecord(root.hooks)) {
    const hooks: Record<string, unknown> = { ...root.hooks };
    if (Array.isArray(hooks.mappings)) {
      hooks.mappings = hooks.mappings.map((mapping, index) => {
        if (isRecord(mapping) && typeof mapping.model === "string" && refIssue(mapping.model)) {
          recordPruned(
            `hooks.mappings.${index}.model`,
            mapping.model,
            fallbackPrimary ?? undefined,
          );
          const nextMapping = { ...mapping };
          if (fallbackPrimary) {
            nextMapping.model = fallbackPrimary;
          } else {
            delete nextMapping.model;
          }
          return nextMapping;
        }
        return mapping;
      });
    }
    if (isRecord(hooks.gmail) && typeof hooks.gmail.model === "string") {
      if (refIssue(hooks.gmail.model)) {
        recordPruned("hooks.gmail.model", hooks.gmail.model, fallbackPrimary ?? undefined);
        const gmail = { ...hooks.gmail };
        if (fallbackPrimary) {
          gmail.model = fallbackPrimary;
        } else {
          delete gmail.model;
        }
        hooks.gmail = gmail;
      }
    }
    root.hooks = hooks;
  }

  // Prune TTS summary model.
  if (isRecord(root.tts) && typeof root.tts.summaryModel === "string") {
    if (refIssue(root.tts.summaryModel)) {
      recordPruned("tts.summaryModel", root.tts.summaryModel, fallbackPrimary ?? undefined);
      const tts = { ...root.tts };
      if (fallbackPrimary) {
        tts.summaryModel = fallbackPrimary;
      } else {
        delete tts.summaryModel;
      }
      root.tts = tts;
    }
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
          if (typeof modelRef === "string" && refIssue(modelRef)) {
            recordPruned(
              `channels.modelByChannel.${channelId}.${targetId}`,
              modelRef,
              fallbackPrimary ?? undefined,
            );
            if (fallbackPrimary) {
              nextChannelMap[targetId] = fallbackPrimary;
            }
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
      if (refIssue(channels.discord.voice.model)) {
        recordPruned(
          "channels.discord.voice.model",
          channels.discord.voice.model,
          fallbackPrimary ?? undefined,
        );
        const voice = { ...channels.discord.voice };
        if (fallbackPrimary) {
          voice.model = fallbackPrimary;
        } else {
          delete voice.model;
        }
        channels.discord = {
          ...channels.discord,
          voice,
        };
      }
    }
    root.channels = channels;
  }

  return { config: root, pruned };
}
