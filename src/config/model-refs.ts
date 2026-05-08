import { normalizeProviderId } from "../agents/provider-id.js";
import { isRecord } from "../utils.js";

export type ConfiguredModelRef = {
  path: string;
  value: string;
};

export const AGENT_MODEL_CONFIG_KEYS = [
  "model",
  "imageModel",
  "imageGenerationModel",
  "videoGenerationModel",
  "musicGenerationModel",
  "pdfModel",
] as const;

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
  if (Array.isArray(agents.list)) {
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
  collectModelConfig(
    "tools.subagents.model",
    isRecord(root.tools) && isRecord(root.tools.subagents) ? root.tools.subagents.model : undefined,
  );
  pushModelRef(
    "messages.tts.summaryModel",
    isRecord(root.messages) && isRecord(root.messages.tts)
      ? root.messages.tts.summaryModel
      : undefined,
  );
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

export function collectConfiguredModelRefValues(
  config: unknown,
  options?: { includeChannelModelOverrides?: boolean },
): string[] {
  return collectConfiguredModelRefs(config, options).map((ref) => ref.value);
}

export function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalizeProviderId(trimmed.slice(0, slash));
}
