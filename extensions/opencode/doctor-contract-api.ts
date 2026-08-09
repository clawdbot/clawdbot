// OpenCode doctor contract repairs the retired Zen free-model reference shipped in beta.3.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeProviderId, parseModelRef } from "openclaw/plugin-sdk/model-ref-parse";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";

const RETIRED_MODEL = "hy3-free";
const REPLACEMENT_MODEL = "laguna-s-2.1-free";
const REPLACEMENT_REF = `opencode/${REPLACEMENT_MODEL}`;
const AGENT_MODEL_KEYS = ["model", "utilityModel", "imageModel", "voiceModel", "pdfModel"] as const;

function replacementFor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  const suffixAt = trimmed.indexOf("@", slash + 1);
  const suffix = suffixAt >= 0 ? trimmed.slice(suffixAt) : "";
  if (suffix === "@" || suffix.includes("/")) {
    return undefined;
  }
  const parsed = parseModelRef(suffixAt >= 0 ? trimmed.slice(0, suffixAt) : trimmed, "");
  if (
    parsed?.provider.toLowerCase() !== "opencode" ||
    parsed.model.toLowerCase() !== RETIRED_MODEL
  ) {
    return undefined;
  }
  return `${REPLACEMENT_REF}${suffix}`;
}

function rewriteString(
  owner: Record<string, unknown> | null,
  key: string,
  path: string,
  changes: string[],
): void {
  if (!owner) {
    return;
  }
  const replacement = replacementFor(owner[key]);
  if (!replacement) {
    return;
  }
  owner[key] = replacement;
  changes.push(`Updated ${path} from the retired OpenCode Zen model to ${REPLACEMENT_REF}.`);
}

function rewriteSelector(
  owner: Record<string, unknown> | null,
  key: string,
  path: string,
  changes: string[],
): void {
  if (!owner) {
    return;
  }
  if (typeof owner[key] === "string") {
    rewriteString(owner, key, path, changes);
    return;
  }
  const selector = asObjectRecord(owner[key]);
  if (!selector) {
    return;
  }
  rewriteString(selector, "primary", `${path}.primary`, changes);
  if (!Array.isArray(selector.fallbacks)) {
    return;
  }
  rewriteStringList(selector.fallbacks, `${path}.fallbacks`, changes);
}

function rewriteStringList(values: unknown[], path: string, changes: string[]): void {
  for (const [index, value] of values.entries()) {
    const replacement = replacementFor(value);
    if (!replacement) {
      continue;
    }
    values[index] = replacement;
    changes.push(
      `Updated ${path}.${index} from the retired OpenCode Zen model to ${REPLACEMENT_REF}.`,
    );
  }
}

function rewriteModelMap(agent: Record<string, unknown>, path: string, changes: string[]): void {
  const models = asObjectRecord(agent.models);
  if (!models) {
    return;
  }
  for (const [modelRef, config] of Object.entries(models)) {
    const replacement = replacementFor(modelRef);
    if (!replacement) {
      continue;
    }
    if (!Object.hasOwn(models, replacement)) {
      models[replacement] = config;
    }
    delete models[modelRef];
    changes.push(`Updated a retired OpenCode Zen model key in ${path} to ${REPLACEMENT_REF}.`);
  }
}

function rewriteExecReviewer(
  owner: Record<string, unknown>,
  path: string,
  changes: string[],
): void {
  const exec = asObjectRecord(asObjectRecord(owner.tools)?.exec);
  rewriteSelector(asObjectRecord(exec?.reviewer), "model", path, changes);
}

function rewriteDiscordVoice(value: unknown, path: string, changes: string[]): void {
  const voice = asObjectRecord(value);
  rewriteString(voice, "model", `${path}.model`, changes);
  rewriteString(asObjectRecord(voice?.tts), "summaryModel", `${path}.tts.summaryModel`, changes);
}

function rewriteStructuredMediaModels(root: Record<string, unknown>, changes: string[]): void {
  const models = asObjectRecord(asObjectRecord(root.tools)?.media)?.models;
  if (!Array.isArray(models)) {
    return;
  }
  for (const [index, value] of models.entries()) {
    const entry = asObjectRecord(value);
    if (
      !entry ||
      entry.type === "cli" ||
      (typeof entry.command === "string" && entry.command.trim()) ||
      typeof entry.provider !== "string" ||
      normalizeProviderId(entry.provider) !== "opencode" ||
      typeof entry.model !== "string" ||
      entry.model.trim().toLowerCase() !== RETIRED_MODEL
    ) {
      continue;
    }
    entry.provider = "opencode";
    entry.model = REPLACEMENT_MODEL;
    changes.push(`Updated tools.media.models.${index} to the current OpenCode Zen model.`);
  }
}

function rewriteAgent(
  value: unknown,
  path: string,
  changes: string[],
  includeEntrySelectors = false,
): void {
  const agent = asObjectRecord(value);
  if (!agent) {
    return;
  }
  for (const key of AGENT_MODEL_KEYS) {
    rewriteSelector(agent, key, `${path}.${key}`, changes);
  }
  const mediaModels = asObjectRecord(agent.mediaModels);
  for (const capability of ["image", "video", "music"] as const) {
    rewriteSelector(mediaModels, capability, `${path}.mediaModels.${capability}`, changes);
  }
  rewriteString(asObjectRecord(agent.heartbeat), "model", `${path}.heartbeat.model`, changes);
  rewriteSelector(asObjectRecord(agent.subagents), "model", `${path}.subagents.model`, changes);
  const compaction = asObjectRecord(agent.compaction);
  rewriteString(compaction, "model", `${path}.compaction.model`, changes);
  rewriteString(
    asObjectRecord(compaction?.memoryFlush),
    "model",
    `${path}.compaction.memoryFlush.model`,
    changes,
  );
  rewriteModelMap(agent, `${path}.models`, changes);
  const allow = asObjectRecord(agent.modelPolicy)?.allow;
  if (Array.isArray(allow)) {
    rewriteStringList(allow, `${path}.modelPolicy.allow`, changes);
  }
  if (includeEntrySelectors) {
    rewriteExecReviewer(agent, `${path}.tools.exec.reviewer.model`, changes);
    rewriteString(asObjectRecord(agent.tts), "summaryModel", `${path}.tts.summaryModel`, changes);
  }
}

function rewriteNonAgentRefs(root: Record<string, unknown>, changes: string[]): void {
  rewriteExecReviewer(root, "tools.exec.reviewer.model", changes);
  rewriteStructuredMediaModels(root, changes);
  const media = asObjectRecord(asObjectRecord(root.tools)?.media);
  for (const capability of ["image", "audio", "video"] as const) {
    rewriteString(
      asObjectRecord(media?.[capability]),
      "preferredModel",
      `tools.media.${capability}.preferredModel`,
      changes,
    );
  }
  const channels = asObjectRecord(root.channels);
  const modelByChannel = asObjectRecord(channels?.modelByChannel);
  if (modelByChannel) {
    for (const [channelId, targetsValue] of Object.entries(modelByChannel)) {
      const targets = asObjectRecord(targetsValue);
      if (!targets) {
        continue;
      }
      for (const targetId of Object.keys(targets)) {
        rewriteString(
          targets,
          targetId,
          `channels.modelByChannel.${channelId}.${targetId}`,
          changes,
        );
      }
    }
  }
  const discord = asObjectRecord(channels?.discord);
  rewriteDiscordVoice(discord?.voice, "channels.discord.voice", changes);
  const accounts = asObjectRecord(discord?.accounts);
  if (accounts) {
    for (const [accountId, account] of Object.entries(accounts)) {
      rewriteDiscordVoice(
        asObjectRecord(account)?.voice,
        `channels.discord.accounts.${accountId}.voice`,
        changes,
      );
    }
  }

  const hooks = asObjectRecord(root.hooks);
  if (Array.isArray(hooks?.mappings)) {
    for (const [index, mapping] of hooks.mappings.entries()) {
      rewriteString(asObjectRecord(mapping), "model", `hooks.mappings.${index}.model`, changes);
    }
  }
  rewriteString(asObjectRecord(hooks?.gmail), "model", "hooks.gmail.model", changes);
  rewriteString(asObjectRecord(root.tts), "summaryModel", "tts.summaryModel", changes);
}

function removeRetiredCatalogRows(root: Record<string, unknown>, changes: string[]): void {
  const provider = asObjectRecord(asObjectRecord(asObjectRecord(root.models)?.providers)?.opencode);
  if (!provider || !Array.isArray(provider.models)) {
    return;
  }
  const retained = provider.models.filter((row) => {
    const id = asObjectRecord(row)?.id;
    return typeof id !== "string" || id.trim().toLowerCase() !== RETIRED_MODEL;
  });
  const removed = provider.models.length - retained.length;
  if (removed > 0) {
    provider.models = retained;
    changes.push(
      `Removed ${removed} retired OpenCode Zen model row(s) from models.providers.opencode.models.`,
    );
  }
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const next = structuredClone(cfg);
  const root = asObjectRecord(next);
  if (!root) {
    return { config: cfg, changes: [] };
  }
  const changes: string[] = [];
  const agents = asObjectRecord(root.agents);
  if (agents) {
    rewriteAgent(agents.defaults, "agents.defaults", changes);
    // Keyed entries own the roster whenever present; the legacy list is only a fallback.
    if (Object.hasOwn(agents, "entries")) {
      const entries = asObjectRecord(agents.entries);
      if (entries) {
        for (const [agentId, entry] of Object.entries(entries)) {
          rewriteAgent(entry, `agents.entries.${agentId}`, changes, true);
        }
      }
    } else if (Array.isArray(agents.list)) {
      for (const [index, entry] of agents.list.entries()) {
        rewriteAgent(entry, `agents.list.${index}`, changes, true);
      }
    }
  }
  rewriteNonAgentRefs(root, changes);
  removeRetiredCatalogRows(root, changes);
  return changes.length > 0 ? { config: next, changes } : { config: cfg, changes };
}
