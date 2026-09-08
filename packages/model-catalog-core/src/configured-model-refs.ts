// Collects configured model references from OpenClaw config-shaped objects.
import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";

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

/** Visit raw selector refs without changing values, order, or fallback indices. */
export function visitModelSelectorRefs(
  value: unknown,
  path: string,
  visit: (path: string, value: string, role: "primary" | "fallback") => void,
): void {
  if (typeof value === "string") {
    visit(path, value, "primary");
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.primary === "string") {
    visit(`${path}.primary`, value.primary, "primary");
  }
  if (Array.isArray(value.fallbacks)) {
    for (const [index, fallback] of value.fallbacks.entries()) {
      if (typeof fallback === "string") {
        visit(`${path}.fallbacks.${index}`, fallback, "fallback");
      }
    }
  }
}

/** List raw refs from one string or primary/fallback model selector. */
export function listModelRefsFromConfigValue(value: unknown): string[] {
  const refs: string[] = [];
  visitModelSelectorRefs(value, "", (_path, ref) => refs.push(ref));
  return refs;
}

/** Collect configured model references from agents, tools, channels, hooks, and message config. */
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
  const collectModelConfig = (path: string, value: unknown) =>
    visitModelSelectorRefs(value, path, pushModelRef);
  const collectFromAgent = (path: string, agent: unknown, includeEntrySelectors = false) => {
    if (!isRecord(agent)) {
      return;
    }
    for (const key of AGENT_MODEL_CONFIG_KEYS) {
      collectModelConfig(`${path}.${key}`, agent[key]);
    }
    const mediaModels = asNonArrayRecord(agent.mediaModels);
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
    if (includeEntrySelectors) {
      const tools = asNonArrayRecord(agent.tools);
      const exec = asNonArrayRecord(tools.exec);
      collectModelConfig(
        `${path}.tools.exec.reviewer.model`,
        isRecord(exec.reviewer) ? exec.reviewer.model : undefined,
      );
      pushModelRef(
        `${path}.tts.summaryModel`,
        isRecord(agent.tts) ? agent.tts.summaryModel : undefined,
      );
    }
  };

  const root = asNonArrayRecord(config);
  const tools = asNonArrayRecord(root.tools);
  const exec = asNonArrayRecord(tools.exec);
  collectModelConfig(
    "tools.exec.reviewer.model",
    isRecord(exec.reviewer) ? exec.reviewer.model : undefined,
  );
  const media = asNonArrayRecord(tools.media);
  for (const capability of ["image", "audio", "video"] as const) {
    pushModelRef(
      `tools.media.${capability}.preferredModel`,
      isRecord(media[capability]) ? media[capability].preferredModel : undefined,
    );
  }
  const agents = asNonArrayRecord(root.agents);
  collectFromAgent("agents.defaults", agents.defaults);
  if (Object.hasOwn(agents, "entries")) {
    if (isRecord(agents.entries)) {
      for (const [agentId, entry] of Object.entries(agents.entries)) {
        collectFromAgent(`agents.entries.${agentId}`, entry, true);
      }
    }
  } else if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      collectFromAgent(`agents.list.${index}`, entry, true);
    }
  }
  if (options.includeChannelModelOverrides !== false) {
    const channels = asNonArrayRecord(root.channels);
    const modelByChannel = asNonArrayRecord(channels.modelByChannel);
    for (const [channelId, channelMap] of Object.entries(modelByChannel)) {
      if (!isRecord(channelMap)) {
        continue;
      }
      for (const [targetId, modelRef] of Object.entries(channelMap)) {
        pushModelRef(`channels.modelByChannel.${channelId}.${targetId}`, modelRef);
      }
    }
  }
  const hooks = asNonArrayRecord(root.hooks);
  if (Array.isArray(hooks.mappings)) {
    for (const [index, mapping] of hooks.mappings.entries()) {
      pushModelRef(`hooks.mappings.${index}.model`, isRecord(mapping) ? mapping.model : undefined);
    }
  }
  pushModelRef("hooks.gmail.model", isRecord(hooks.gmail) ? hooks.gmail.model : undefined);
  pushModelRef("tts.summaryModel", isRecord(root.tts) ? root.tts.summaryModel : undefined);
  const discord = asNonArrayRecord(asNonArrayRecord(root.channels).discord);
  const collectDiscordVoice = (path: string, value: unknown) => {
    const voice = asNonArrayRecord(value);
    pushModelRef(`${path}.model`, voice.model);
    pushModelRef(
      `${path}.tts.summaryModel`,
      isRecord(voice.tts) ? voice.tts.summaryModel : undefined,
    );
  };
  collectDiscordVoice("channels.discord.voice", discord.voice);
  if (isRecord(discord.accounts)) {
    for (const [accountId, account] of Object.entries(discord.accounts)) {
      collectDiscordVoice(
        `channels.discord.accounts.${accountId}.voice`,
        isRecord(account) ? account.voice : undefined,
      );
    }
  }
  return refs;
}

/** Collect only configured model reference values. */
export function collectConfiguredModelRefValues(
  config: unknown,
  options?: { includeChannelModelOverrides?: boolean },
): string[] {
  return collectConfiguredModelRefs(config, options).map((ref) => ref.value);
}
