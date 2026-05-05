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
  return refs;
}
