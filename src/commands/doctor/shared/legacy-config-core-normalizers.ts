import { migrateLegacyRuntimeModelRef } from "../../../agents/model-runtime-aliases.js";
import { normalizeProviderId } from "../../../agents/provider-id.js";
import { resolveSingleAccountKeysToMove } from "../../../channels/plugins/setup-promotion-helpers.js";
import { resolveNormalizedProviderModelMaxTokens } from "../../../config/defaults.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { DEFAULT_GOOGLE_API_BASE_URL } from "../../../infra/google-api-base-url.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../../shared/string-coerce.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { isRecord } from "./legacy-config-record-shared.js";
import { isLegacyModelsAddCodexMetadataModel } from "./legacy-models-add-metadata.js";
export { normalizeLegacyTalkConfig } from "./legacy-talk-config-normalizer.js";

export function normalizeLegacyCommandsConfig(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawCommands = cfg.commands;
  if (!isRecord(rawCommands) || !("modelsWrite" in rawCommands)) {
    return cfg;
  }

  const commands = { ...rawCommands };
  delete commands.modelsWrite;
  changes.push("Removed deprecated commands.modelsWrite (/models add is deprecated).");

  return {
    ...cfg,
    commands: commands as OpenClawConfig["commands"],
  };
}

export function normalizeLegacyBrowserConfig(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawBrowser = cfg.browser;
  if (!isRecord(rawBrowser)) {
    return cfg;
  }

  const browser = structuredClone(rawBrowser);
  let browserChanged = false;

  if ("relayBindHost" in browser) {
    delete browser.relayBindHost;
    browserChanged = true;
    changes.push(
      "Removed browser.relayBindHost (legacy Chrome extension relay setting; host-local Chrome now uses Chrome MCP existing-session attach).",
    );
  }

  const rawProfiles = browser.profiles;
  if (isRecord(rawProfiles)) {
    const profiles = { ...rawProfiles };
    let profilesChanged = false;
    for (const [profileName, rawProfile] of Object.entries(rawProfiles)) {
      if (!isRecord(rawProfile)) {
        continue;
      }
      const rawDriver = normalizeOptionalString(rawProfile.driver) ?? "";
      if (rawDriver !== "extension") {
        continue;
      }
      profiles[profileName] = {
        ...rawProfile,
        driver: "existing-session",
      };
      profilesChanged = true;
      changes.push(
        `Moved browser.profiles.${profileName}.driver "extension" → "existing-session" (Chrome MCP attach).`,
      );
    }
    if (profilesChanged) {
      browser.profiles = profiles;
      browserChanged = true;
    }
  }

  const rawSsrFPolicy = browser.ssrfPolicy;
  if (isRecord(rawSsrFPolicy) && "allowPrivateNetwork" in rawSsrFPolicy) {
    const legacyAllowPrivateNetwork = rawSsrFPolicy.allowPrivateNetwork;
    const currentDangerousAllowPrivateNetwork = rawSsrFPolicy.dangerouslyAllowPrivateNetwork;

    let resolvedDangerousAllowPrivateNetwork: unknown = currentDangerousAllowPrivateNetwork;
    if (
      typeof legacyAllowPrivateNetwork === "boolean" ||
      typeof currentDangerousAllowPrivateNetwork === "boolean"
    ) {
      resolvedDangerousAllowPrivateNetwork =
        legacyAllowPrivateNetwork === true || currentDangerousAllowPrivateNetwork === true;
    } else if (currentDangerousAllowPrivateNetwork === undefined) {
      resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
    }

    const nextSsrFPolicy: Record<string, unknown> = { ...rawSsrFPolicy };
    delete nextSsrFPolicy.allowPrivateNetwork;
    if (resolvedDangerousAllowPrivateNetwork !== undefined) {
      nextSsrFPolicy.dangerouslyAllowPrivateNetwork = resolvedDangerousAllowPrivateNetwork;
    }
    browser.ssrfPolicy = nextSsrFPolicy;
    browserChanged = true;
    changes.push(
      `Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (${String(resolvedDangerousAllowPrivateNetwork)}).`,
    );
  }

  if (!browserChanged) {
    return cfg;
  }

  return {
    ...cfg,
    browser: browser as OpenClawConfig["browser"],
  };
}

export function seedMissingDefaultAccountsFromSingleAccountBase(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels) {
    return cfg;
  }

  let channelsChanged = false;
  const nextChannels = { ...channels };
  for (const [channelId, rawChannel] of Object.entries(channels)) {
    if (!isRecord(rawChannel)) {
      continue;
    }
    const rawAccounts = rawChannel.accounts;
    if (!isRecord(rawAccounts)) {
      continue;
    }
    const accountKeys = Object.keys(rawAccounts);
    if (accountKeys.length === 0) {
      continue;
    }
    const hasDefault = accountKeys.some(
      (key) => normalizeOptionalLowercaseString(key) === DEFAULT_ACCOUNT_ID,
    );
    if (hasDefault) {
      continue;
    }
    const keysToMove = resolveSingleAccountKeysToMove({
      channelKey: channelId,
      channel: rawChannel,
    });
    if (keysToMove.length === 0) {
      continue;
    }

    const defaultAccount: Record<string, unknown> = {};
    for (const key of keysToMove) {
      const value = rawChannel[key];
      defaultAccount[key] = value && typeof value === "object" ? structuredClone(value) : value;
    }
    const nextChannel: Record<string, unknown> = {
      ...rawChannel,
    };
    for (const key of keysToMove) {
      delete nextChannel[key];
    }
    nextChannel.accounts = {
      ...rawAccounts,
      [DEFAULT_ACCOUNT_ID]: defaultAccount,
    };

    nextChannels[channelId] = nextChannel;
    channelsChanged = true;
    changes.push(
      `Moved channels.${channelId} single-account top-level values into channels.${channelId}.accounts.default.`,
    );
  }

  if (!channelsChanged) {
    return cfg;
  }

  return {
    ...cfg,
    channels: nextChannels as OpenClawConfig["channels"],
  };
}

type ModelProviderEntry = Partial<
  NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
>;
type ModelsConfigPatch = Partial<NonNullable<OpenClawConfig["models"]>>;
type ModelDefinitionEntry = NonNullable<ModelProviderEntry["models"]>[number];
type AgentRuntimePolicyPatch = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["agentRuntime"]
>;

function mergeModelEntry(legacyEntry: unknown, currentEntry: unknown): unknown {
  if (!isRecord(legacyEntry) || !isRecord(currentEntry)) {
    return currentEntry ?? legacyEntry;
  }
  return { ...legacyEntry, ...currentEntry };
}

function normalizeLegacyRuntimeAgentModelConfig(raw: unknown): {
  value?: unknown;
  changed: boolean;
  selectedRuntime?: string;
} {
  if (typeof raw === "string") {
    const migrated = migrateLegacyRuntimeModelRef(raw);
    return migrated
      ? { value: migrated.ref, changed: true, selectedRuntime: migrated.runtime }
      : { value: raw, changed: false };
  }
  if (!isRecord(raw)) {
    return { value: raw, changed: false };
  }

  const migratedPrimary =
    typeof raw.primary === "string" ? migrateLegacyRuntimeModelRef(raw.primary) : null;
  if (!migratedPrimary) {
    return { value: raw, changed: false };
  }

  const next: Record<string, unknown> = { ...raw, primary: migratedPrimary.ref };
  if (Array.isArray(raw.fallbacks)) {
    next.fallbacks = raw.fallbacks.map((fallback) => {
      if (typeof fallback !== "string") {
        return fallback;
      }
      const migratedFallback = migrateLegacyRuntimeModelRef(fallback);
      return migratedFallback?.runtime === migratedPrimary.runtime
        ? migratedFallback.ref
        : fallback;
    });
  }
  return {
    value: next,
    changed: true,
    selectedRuntime: migratedPrimary.runtime,
  };
}

function normalizeLegacyRuntimeAllowlistModels(
  rawModels: unknown,
  selectedRuntime: string | undefined,
): {
  value?: unknown;
  changed: boolean;
} {
  if (!selectedRuntime || !isRecord(rawModels)) {
    return { value: rawModels, changed: false };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  const legacyEntries: Array<[string, unknown]> = [];
  for (const [rawKey, entry] of Object.entries(rawModels)) {
    const migrated = migrateLegacyRuntimeModelRef(rawKey);
    if (migrated?.runtime === selectedRuntime) {
      changed = true;
      next[rawKey] = mergeModelEntry(entry, next[rawKey]);
      legacyEntries.push([migrated.ref, entry]);
      continue;
    }
    next[rawKey] = mergeModelEntry(entry, next[rawKey]);
  }
  for (const [migratedKey, entry] of legacyEntries) {
    next[migratedKey] = mergeModelEntry(entry, next[migratedKey]);
  }
  return { value: next, changed };
}

function ensureAgentRuntimePolicy(
  raw: unknown,
  selectedRuntime: string,
): {
  value: AgentRuntimePolicyPatch;
  changed: boolean;
} {
  if (!isRecord(raw)) {
    return { value: { id: selectedRuntime }, changed: true };
  }
  const currentRuntime = normalizeOptionalLowercaseString(raw.id);
  if (!currentRuntime || currentRuntime === "auto") {
    return {
      value: { ...raw, id: selectedRuntime } as AgentRuntimePolicyPatch,
      changed: currentRuntime !== selectedRuntime,
    };
  }
  return { value: raw as AgentRuntimePolicyPatch, changed: false };
}

function normalizeLegacyRuntimeAgentContainer(
  raw: Record<string, unknown>,
  path: string,
  changes: string[],
): { value: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = { ...raw };

  const model = normalizeLegacyRuntimeAgentModelConfig(raw.model);
  if (model.changed) {
    next.model = model.value;
    changed = true;
    const runtimeSuffix = model.selectedRuntime
      ? ` and selected ${model.selectedRuntime} runtime`
      : "";
    changes.push(
      `Moved ${path}.model legacy runtime primary refs to canonical provider refs${runtimeSuffix}.`,
    );
  }

  const models = normalizeLegacyRuntimeAllowlistModels(raw.models, model.selectedRuntime);
  if (models.changed) {
    next.models = models.value;
    changed = true;
    changes.push(`Moved ${path}.models legacy runtime keys to canonical provider keys.`);
  }

  if (model.selectedRuntime) {
    const agentRuntime = ensureAgentRuntimePolicy(raw.agentRuntime, model.selectedRuntime);
    if (agentRuntime.changed) {
      next.agentRuntime = agentRuntime.value;
      changed = true;
    }
  }

  return { value: next, changed };
}

export function normalizeLegacyRuntimeModelRefs(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawAgents = cfg.agents;
  if (!isRecord(rawAgents)) {
    return cfg;
  }

  let changed = false;
  const nextAgents: Record<string, unknown> = { ...rawAgents };
  if (isRecord(rawAgents.defaults)) {
    const defaults = normalizeLegacyRuntimeAgentContainer(
      rawAgents.defaults,
      "agents.defaults",
      changes,
    );
    if (defaults.changed) {
      nextAgents.defaults = defaults.value;
      changed = true;
    }
  }

  if (Array.isArray(rawAgents.list)) {
    const nextList = rawAgents.list.map((entry, index) => {
      if (!isRecord(entry)) {
        return entry;
      }
      const agentId = normalizeOptionalString(entry.id);
      const path = agentId ? `agents.list.${sanitizeForLog(agentId)}` : `agents.list[${index}]`;
      const agent = normalizeLegacyRuntimeAgentContainer(entry, path, changes);
      if (agent.changed) {
        changed = true;
        return agent.value;
      }
      return entry;
    });
    if (changed) {
      nextAgents.list = nextList;
    }
  }

  return changed
    ? {
        ...cfg,
        agents: nextAgents as OpenClawConfig["agents"],
      }
    : cfg;
}

export function normalizeLegacyOpenAICodexModelsAddMetadata(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawModels = cfg.models;
  if (!isRecord(rawModels) || !isRecord(rawModels.providers)) {
    return cfg;
  }

  const rawProviders: Record<string, unknown> = rawModels.providers;
  let providersChanged = false;
  const nextProviders: Record<string, unknown> = { ...rawProviders };
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (normalizeProviderId(providerId) !== "openai-codex" || !isRecord(rawProvider)) {
      continue;
    }
    const rawProviderModels = rawProvider.models;
    if (!Array.isArray(rawProviderModels)) {
      continue;
    }
    let providerChanged = false;
    const nextModels: typeof rawProviderModels = [];
    for (const model of rawProviderModels) {
      if (
        isRecord(model) &&
        !("metadataSource" in model) &&
        isLegacyModelsAddCodexMetadataModel({
          provider: providerId,
          model: model as Partial<ModelDefinitionEntry>,
        })
      ) {
        providerChanged = true;
        const safeProviderId = sanitizeForLog(providerId);
        const safeModelId = sanitizeForLog(normalizeOptionalString(model.id) ?? "unknown");
        changes.push(
          `Marked models.providers.${safeProviderId}.models.${safeModelId} as /models add metadata so official OpenAI Codex metadata can override it.`,
        );
        nextModels.push(Object.assign({}, model, { metadataSource: "models-add" }));
      } else {
        nextModels.push(model);
      }
    }

    if (!providerChanged) {
      continue;
    }
    nextProviders[providerId] = {
      ...rawProvider,
      models: nextModels,
    } as (typeof nextProviders)[string];
    providersChanged = true;
  }

  if (!providersChanged) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...rawModels,
      providers: nextProviders as NonNullable<OpenClawConfig["models"]>["providers"],
    },
  };
}

export function normalizeLegacyOpenAIModelProviderApi(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawModels = cfg.models;
  if (!isRecord(rawModels) || !isRecord(rawModels.providers)) {
    return cfg;
  }

  const rawProviders: Record<string, unknown> = rawModels.providers;
  let providersChanged = false;
  const nextProviders: Record<string, unknown> = { ...rawProviders };
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (!isRecord(rawProvider)) {
      continue;
    }

    let providerChanged = false;
    const nextProvider: Record<string, unknown> = { ...rawProvider };
    if (nextProvider.api === "openai") {
      nextProvider.api = "openai-completions";
      providerChanged = true;
      changes.push(
        `Moved models.providers.${sanitizeForLog(providerId)}.api "openai" → "openai-completions".`,
      );
    }

    const rawProviderModels = rawProvider.models;
    if (Array.isArray(rawProviderModels)) {
      let modelsChanged = false;
      const nextModels: unknown[] = [];
      rawProviderModels.forEach((model, index) => {
        if (!isRecord(model) || model.api !== "openai") {
          nextModels.push(model);
          return;
        }
        modelsChanged = true;
        changes.push(
          `Moved models.providers.${sanitizeForLog(providerId)}.models[${index}].api "openai" → "openai-completions".`,
        );
        nextModels.push({
          ...model,
          api: "openai-completions",
        });
      });
      if (modelsChanged) {
        nextProvider.models = nextModels;
        providerChanged = true;
      }
    }

    if (!providerChanged) {
      continue;
    }
    nextProviders[providerId] = nextProvider;
    providersChanged = true;
  }

  if (!providersChanged) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...rawModels,
      providers: nextProviders as NonNullable<OpenClawConfig["models"]>["providers"],
    },
  };
}

export function normalizeLegacyNanoBananaSkill(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const NANO_BANANA_SKILL_KEY = "nano-banana-pro";
  const NANO_BANANA_MODEL = "google/gemini-3-pro-image-preview";
  const rawSkills = cfg.skills;
  if (!isRecord(rawSkills)) {
    return cfg;
  }

  let next = cfg;
  let skillsChanged = false;
  const skills = structuredClone(rawSkills);

  if (Array.isArray(skills.allowBundled)) {
    const allowBundled = skills.allowBundled.filter(
      (value) => typeof value !== "string" || value.trim() !== NANO_BANANA_SKILL_KEY,
    );
    if (allowBundled.length !== skills.allowBundled.length) {
      if (allowBundled.length === 0) {
        delete skills.allowBundled;
        changes.push(`Removed skills.allowBundled entry for ${NANO_BANANA_SKILL_KEY}.`);
      } else {
        skills.allowBundled = allowBundled;
        changes.push(`Removed ${NANO_BANANA_SKILL_KEY} from skills.allowBundled.`);
      }
      skillsChanged = true;
    }
  }

  const rawEntries = skills.entries;
  if (!isRecord(rawEntries)) {
    if (!skillsChanged) {
      return cfg;
    }
    return {
      ...cfg,
      skills,
    };
  }

  const rawLegacyEntry = rawEntries[NANO_BANANA_SKILL_KEY];
  if (!isRecord(rawLegacyEntry)) {
    if (!skillsChanged) {
      return cfg;
    }
    return {
      ...cfg,
      skills,
    };
  }

  const existingImageGenerationModel = next.agents?.defaults?.imageGenerationModel;
  if (existingImageGenerationModel === undefined) {
    next = {
      ...next,
      agents: {
        ...next.agents,
        defaults: {
          ...next.agents?.defaults,
          imageGenerationModel: {
            primary: NANO_BANANA_MODEL,
          },
        },
      },
    };
    changes.push(
      `Moved skills.entries.${NANO_BANANA_SKILL_KEY} → agents.defaults.imageGenerationModel.primary (${NANO_BANANA_MODEL}).`,
    );
  }

  const legacyEnv = isRecord(rawLegacyEntry.env) ? rawLegacyEntry.env : undefined;
  const legacyEnvApiKey = normalizeOptionalString(legacyEnv?.GEMINI_API_KEY) ?? "";
  const legacyApiKey =
    legacyEnvApiKey ||
    (typeof rawLegacyEntry.apiKey === "string"
      ? normalizeOptionalString(rawLegacyEntry.apiKey)
      : rawLegacyEntry.apiKey && isRecord(rawLegacyEntry.apiKey)
        ? structuredClone(rawLegacyEntry.apiKey)
        : undefined);

  const rawModels = (
    isRecord(next.models) ? structuredClone(next.models) : {}
  ) as ModelsConfigPatch;
  const rawProviders = (isRecord(rawModels.providers) ? { ...rawModels.providers } : {}) as Record<
    string,
    ModelProviderEntry
  >;
  const rawGoogle = (
    isRecord(rawProviders.google) ? { ...rawProviders.google } : {}
  ) as ModelProviderEntry;
  const hasGoogleApiKey = rawGoogle.apiKey !== undefined;
  if (!hasGoogleApiKey && legacyApiKey) {
    rawGoogle.apiKey = legacyApiKey;
    if (!rawGoogle.baseUrl) {
      rawGoogle.baseUrl = DEFAULT_GOOGLE_API_BASE_URL;
    }
    if (!Array.isArray(rawGoogle.models)) {
      rawGoogle.models = [];
    }
    rawProviders.google = rawGoogle;
    rawModels.providers = rawProviders as NonNullable<OpenClawConfig["models"]>["providers"];
    next = {
      ...next,
      models: rawModels as OpenClawConfig["models"],
    };
    changes.push(
      `Moved skills.entries.${NANO_BANANA_SKILL_KEY}.${legacyEnvApiKey ? "env.GEMINI_API_KEY" : "apiKey"} → models.providers.google.apiKey.`,
    );
  }

  const entries = { ...rawEntries };
  delete entries[NANO_BANANA_SKILL_KEY];
  if (Object.keys(entries).length === 0) {
    delete skills.entries;
  } else {
    skills.entries = entries;
  }
  changes.push(`Removed legacy skills.entries.${NANO_BANANA_SKILL_KEY}.`);
  skillsChanged = true;

  if (Object.keys(skills).length === 0) {
    const { skills: _ignored, ...rest } = next;
    return rest;
  }

  if (!skillsChanged) {
    return next;
  }
  return {
    ...next,
    skills,
  };
}

export function normalizeLegacyCrossContextMessageConfig(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawTools = cfg.tools;
  if (!isRecord(rawTools)) {
    return cfg;
  }
  const rawMessage = rawTools.message;
  if (!isRecord(rawMessage) || !("allowCrossContextSend" in rawMessage)) {
    return cfg;
  }

  const legacyAllowCrossContextSend = rawMessage.allowCrossContextSend;
  if (typeof legacyAllowCrossContextSend !== "boolean") {
    return cfg;
  }

  const nextMessage = { ...rawMessage };
  delete nextMessage.allowCrossContextSend;

  if (legacyAllowCrossContextSend) {
    const rawCrossContext = isRecord(nextMessage.crossContext)
      ? structuredClone(nextMessage.crossContext)
      : {};
    rawCrossContext.allowWithinProvider = true;
    rawCrossContext.allowAcrossProviders = true;
    nextMessage.crossContext = rawCrossContext;
    changes.push(
      "Moved tools.message.allowCrossContextSend → tools.message.crossContext.allowWithinProvider/allowAcrossProviders (true).",
    );
  } else {
    changes.push(
      "Removed tools.message.allowCrossContextSend=false (default cross-context policy already matches canonical settings).",
    );
  }

  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      message: nextMessage,
    },
  };
}

function mapDeepgramCompatToProviderOptions(
  rawCompat: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const providerOptions: Record<string, string | number | boolean> = {};
  if (typeof rawCompat.detectLanguage === "boolean") {
    providerOptions.detect_language = rawCompat.detectLanguage;
  }
  if (typeof rawCompat.punctuate === "boolean") {
    providerOptions.punctuate = rawCompat.punctuate;
  }
  if (typeof rawCompat.smartFormat === "boolean") {
    providerOptions.smart_format = rawCompat.smartFormat;
  }
  return providerOptions;
}

function migrateLegacyDeepgramCompat(params: {
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): boolean {
  const rawCompat = isRecord(params.owner.deepgram) ? structuredClone(params.owner.deepgram) : null;
  if (!rawCompat) {
    return false;
  }

  const compatProviderOptions = mapDeepgramCompatToProviderOptions(rawCompat);
  const currentProviderOptions = isRecord(params.owner.providerOptions)
    ? structuredClone(params.owner.providerOptions)
    : {};
  const currentDeepgram = isRecord(currentProviderOptions.deepgram)
    ? structuredClone(currentProviderOptions.deepgram)
    : {};
  const mergedDeepgram = { ...compatProviderOptions, ...currentDeepgram };

  delete params.owner.deepgram;
  currentProviderOptions.deepgram = mergedDeepgram;
  params.owner.providerOptions = currentProviderOptions;

  const hadCanonicalDeepgram = Object.keys(currentDeepgram).length > 0;
  params.changes.push(
    hadCanonicalDeepgram
      ? `Merged ${params.pathPrefix}.deepgram → ${params.pathPrefix}.providerOptions.deepgram (filled missing canonical fields from legacy).`
      : `Moved ${params.pathPrefix}.deepgram → ${params.pathPrefix}.providerOptions.deepgram.`,
  );
  return true;
}

export function normalizeLegacyMediaProviderOptions(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawTools = cfg.tools;
  if (!isRecord(rawTools)) {
    return cfg;
  }
  const rawMedia = rawTools.media;
  if (!isRecord(rawMedia)) {
    return cfg;
  }

  let mediaChanged = false;
  const nextMedia = structuredClone(rawMedia);
  const migrateModelList = (models: unknown, pathPrefix: string): boolean => {
    if (!Array.isArray(models)) {
      return false;
    }
    let changedAny = false;
    for (const [index, entry] of models.entries()) {
      if (!isRecord(entry)) {
        continue;
      }
      if (
        migrateLegacyDeepgramCompat({
          owner: entry,
          pathPrefix: `${pathPrefix}[${index}]`,
          changes,
        })
      ) {
        changedAny = true;
      }
    }
    return changedAny;
  };

  for (const capability of ["audio", "image", "video"] as const) {
    const config = isRecord(nextMedia[capability]) ? structuredClone(nextMedia[capability]) : null;
    if (!config) {
      continue;
    }
    let configChanged = false;
    if (
      migrateLegacyDeepgramCompat({
        owner: config,
        pathPrefix: `tools.media.${capability}`,
        changes,
      })
    ) {
      configChanged = true;
    }
    if (migrateModelList(config.models, `tools.media.${capability}.models`)) {
      configChanged = true;
    }
    if (configChanged) {
      nextMedia[capability] = config;
      mediaChanged = true;
    }
  }

  if (migrateModelList(nextMedia.models, "tools.media.models")) {
    mediaChanged = true;
  }

  if (!mediaChanged) {
    return cfg;
  }

  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      media: nextMedia as NonNullable<OpenClawConfig["tools"]>["media"],
    },
  };
}

export function normalizeLegacyMistralModelMaxTokens(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawProviders = cfg.models?.providers;
  if (!isRecord(rawProviders)) {
    return cfg;
  }

  let providersChanged = false;
  const nextProviders = { ...rawProviders };
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (normalizeProviderId(providerId) !== "mistral" || !isRecord(rawProvider)) {
      continue;
    }
    const rawModels = rawProvider.models;
    if (!Array.isArray(rawModels)) {
      continue;
    }

    let modelsChanged = false;
    const nextModels = rawModels.map((model, index) => {
      if (!isRecord(model)) {
        return model;
      }
      const modelId = normalizeOptionalString(model.id) ?? "";
      const contextWindow =
        typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
          ? model.contextWindow
          : null;
      const maxTokens =
        typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens)
          ? model.maxTokens
          : null;
      if (!modelId || contextWindow === null || maxTokens === null) {
        return model;
      }

      const normalizedMaxTokens = resolveNormalizedProviderModelMaxTokens({
        providerId,
        modelId,
        contextWindow,
        rawMaxTokens: maxTokens,
      });
      if (normalizedMaxTokens === maxTokens) {
        return model;
      }

      modelsChanged = true;
      changes.push(
        `Normalized models.providers.${providerId}.models[${index}].maxTokens (${maxTokens} → ${normalizedMaxTokens}) to avoid Mistral context-window rejects.`,
      );
      return Object.assign({}, model, { maxTokens: normalizedMaxTokens });
    });

    if (!modelsChanged) {
      continue;
    }

    nextProviders[providerId] = {
      ...rawProvider,
      models: nextModels,
    };
    providersChanged = true;
  }

  if (!providersChanged) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: nextProviders as NonNullable<OpenClawConfig["models"]>["providers"],
    },
  };
}
