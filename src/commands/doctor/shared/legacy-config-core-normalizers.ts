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
import { isRecord } from "./legacy-config-record-shared.js";
export { normalizeLegacyTalkConfig } from "./legacy-talk-config-normalizer.js";

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
