// Legacy TTS runtime config migrations for provider aliases, enabled toggles, and voices.
import {
  defineLegacyConfigMigration,
  getRecord,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";

const LEGACY_TTS_PROVIDER_KEYS = ["openai", "elevenlabs", "microsoft", "edge"] as const;
const LEGACY_TTS_PLUGIN_IDS = new Set(["voice-call"]);
const CHANNEL_ROOT_TTS_UNSUPPORTED_IDS = new Set(["discord"]);

function isLegacyEdgeProviderId(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "edge";
}

function hasLegacyTtsProviderKeys(value: unknown): boolean {
  const tts = getRecord(value);
  if (!tts) {
    return false;
  }
  if (isLegacyEdgeProviderId(tts.provider)) {
    return true;
  }
  if (LEGACY_TTS_PROVIDER_KEYS.some((key) => Object.hasOwn(tts, key))) {
    return true;
  }
  const providers = getRecord(tts.providers);
  return Boolean(providers && Object.hasOwn(providers, "edge"));
}

function hasLegacyTtsEnabled(value: unknown): boolean {
  return typeof getRecord(value)?.enabled === "boolean";
}

function hasLegacySpeakerSelectionKeys(value: unknown): boolean {
  const config = getRecord(value);
  if (!config) {
    return false;
  }
  return (
    Object.hasOwn(config, "voice") ||
    Object.hasOwn(config, "voiceName") ||
    Object.hasOwn(config, "voiceId")
  );
}

function hasLegacyTtsSpeakerSelection(value: unknown): boolean {
  const tts = getRecord(value);
  if (!tts) {
    return false;
  }
  if (hasLegacyTtsSpeakerSelectionInProviderMap(tts.providers)) {
    return true;
  }
  if (
    LEGACY_TTS_PROVIDER_KEYS.some((providerId) => hasLegacySpeakerSelectionKeys(tts[providerId]))
  ) {
    return true;
  }
  return hasLegacyTtsSpeakerSelectionInPersonas(tts.personas);
}

function hasLegacyTtsSpeakerSelectionInProviderMap(value: unknown): boolean {
  const providers = getRecord(value);
  return Boolean(
    providers &&
    Object.entries(providers).some(
      ([providerId, providerConfig]) =>
        !isBlockedObjectKey(providerId) && hasLegacySpeakerSelectionKeys(providerConfig),
    ),
  );
}

function hasLegacyTtsSpeakerSelectionInPersonas(value: unknown): boolean {
  const personas = getRecord(value);
  if (!personas) {
    return false;
  }
  return Object.entries(personas).some(([personaId, personaValue]) => {
    if (isBlockedObjectKey(personaId)) {
      return false;
    }
    const persona = getRecord(personaValue);
    if (!persona) {
      return false;
    }
    if (hasLegacyTtsSpeakerSelectionInProviderMap(persona.providers)) {
      return true;
    }
    return LEGACY_TTS_PROVIDER_KEYS.some((providerId) =>
      hasLegacySpeakerSelectionKeys(persona[providerId]),
    );
  });
}

type LegacyTtsMatcher = (value: unknown) => boolean;

function hasLegacyTtsInAgentLocations(value: unknown, matcher: LegacyTtsMatcher): boolean {
  const agents = getRecord(value);
  const agentList = Array.isArray(agents?.list) ? agents.list : [];
  return agentList.some((entry) => matcher(getRecord(getRecord(entry)?.tts)));
}

function supportsChannelRootTtsMigration(channelId: string): boolean {
  return !CHANNEL_ROOT_TTS_UNSUPPORTED_IDS.has(channelId.trim().toLowerCase());
}

function hasLegacyTtsInChannelLocations(value: unknown, matcher: LegacyTtsMatcher): boolean {
  const channels = getRecord(value);
  for (const [channelId, channelValue] of Object.entries(channels ?? {})) {
    if (isBlockedObjectKey(channelId)) {
      continue;
    }
    const channel = getRecord(channelValue);
    const migrateRootTts = supportsChannelRootTtsMigration(channelId);
    if (migrateRootTts && matcher(getRecord(channel?.tts))) {
      return true;
    }
    if (matcher(getRecord(getRecord(channel?.voice)?.tts))) {
      return true;
    }
    const accounts = getRecord(channel?.accounts);
    for (const [accountId, accountValue] of Object.entries(accounts ?? {})) {
      if (isBlockedObjectKey(accountId)) {
        continue;
      }
      const account = getRecord(accountValue);
      if (
        (migrateRootTts && matcher(getRecord(account?.tts))) ||
        matcher(getRecord(getRecord(account?.voice)?.tts))
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasLegacyTtsInPluginLocations(value: unknown, matcher: LegacyTtsMatcher): boolean {
  const entries = getRecord(value);
  if (!entries) {
    return false;
  }
  return Object.entries(entries).some(([pluginId, entryValue]) => {
    if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) {
      return false;
    }
    const entry = getRecord(entryValue);
    const config = getRecord(entry?.config);
    return matcher(getRecord(config?.tts));
  });
}

function getOrCreateTtsProviders(tts: Record<string, unknown>): Record<string, unknown> {
  const providers = getRecord(tts.providers) ?? {};
  tts.providers = providers;
  return providers;
}

function mergeLegacyTtsProviderConfig(
  tts: Record<string, unknown>,
  legacyKey: string,
  providerId: string,
  source: "tts" | "providers" = "tts",
): boolean {
  const legacyOwner = source === "providers" ? getRecord(tts.providers) : tts;
  const legacyValue = getRecord(legacyOwner?.[legacyKey]);
  if (!legacyOwner || !legacyValue) {
    return false;
  }
  const providers = source === "providers" ? legacyOwner : getOrCreateTtsProviders(tts);
  const existing = getRecord(providers[providerId]) ?? {};
  const merged = structuredClone(existing);
  mergeMissing(merged, legacyValue);
  providers[providerId] = merged;
  delete legacyOwner[legacyKey];
  return true;
}

function migrateLegacyTtsConfig(
  tts: Record<string, unknown> | null | undefined,
  pathLabel: string,
  changes: string[],
): void {
  if (!tts) {
    return;
  }
  if (isLegacyEdgeProviderId(tts.provider)) {
    tts.provider = "microsoft";
    changes.push(`Moved ${pathLabel}.provider "edge" → "microsoft".`);
  }
  for (const [legacyKey, providerId, source] of [
    ["openai", "openai", "tts"],
    ["elevenlabs", "elevenlabs", "tts"],
    ["microsoft", "microsoft", "tts"],
    ["edge", "microsoft", "providers"],
    ["edge", "microsoft", "tts"],
  ] as const) {
    if (!mergeLegacyTtsProviderConfig(tts, legacyKey, providerId, source)) {
      continue;
    }
    const sourcePath =
      source === "providers" ? `${pathLabel}.providers.${legacyKey}` : `${pathLabel}.${legacyKey}`;
    changes.push(`Moved ${sourcePath} → ${pathLabel}.providers.${providerId}.`);
  }
}

function migrateLegacyTtsEnabled(
  tts: Record<string, unknown> | null | undefined,
  pathLabel: string,
  changes: string[],
): void {
  if (!tts || typeof tts.enabled !== "boolean") {
    return;
  }
  const nextAuto = tts.enabled ? "always" : "off";
  delete tts.enabled;
  if (typeof tts.auto === "string" && tts.auto.trim()) {
    changes.push(`Removed ${pathLabel}.enabled because ${pathLabel}.auto is already set.`);
    return;
  }
  tts.auto = nextAuto;
  changes.push(`Moved ${pathLabel}.enabled → ${pathLabel}.auto "${nextAuto}".`);
}

function migrateLegacySpeakerSelectionConfig(
  providerConfig: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  for (const [legacyKey, canonicalKey] of [
    ["voice", "speakerVoice"],
    ["voiceName", "speakerVoice"],
    ["voiceId", "speakerVoiceId"],
  ] as const) {
    if (!Object.hasOwn(providerConfig, legacyKey)) {
      continue;
    }
    if (providerConfig[canonicalKey] === undefined) {
      providerConfig[canonicalKey] = providerConfig[legacyKey];
      changes.push(`Moved ${pathLabel}.${legacyKey} → ${pathLabel}.${canonicalKey}.`);
    } else {
      changes.push(
        `Removed ${pathLabel}.${legacyKey} because ${pathLabel}.${canonicalKey} is already set.`,
      );
    }
    delete providerConfig[legacyKey];
  }
}

function migrateLegacyTtsSpeakerSelection(
  tts: Record<string, unknown> | null | undefined,
  pathLabel: string,
  changes: string[],
): void {
  if (!tts) {
    return;
  }
  migrateLegacySpeakerSelectionProviderMap(tts.providers, `${pathLabel}.providers`, changes);
  for (const providerId of LEGACY_TTS_PROVIDER_KEYS) {
    const providerConfig = getRecord(tts[providerId]);
    if (!providerConfig) {
      continue;
    }
    migrateLegacySpeakerSelectionConfig(providerConfig, `${pathLabel}.${providerId}`, changes);
  }
  const personas = getRecord(tts.personas);
  for (const [personaId, personaValue] of Object.entries(personas ?? {})) {
    if (isBlockedObjectKey(personaId)) {
      continue;
    }
    const persona = getRecord(personaValue);
    if (!persona) {
      continue;
    }
    migrateLegacySpeakerSelectionProviderMap(
      persona.providers,
      `${pathLabel}.personas.${personaId}.providers`,
      changes,
    );
    for (const providerId of LEGACY_TTS_PROVIDER_KEYS) {
      const providerConfig = getRecord(persona[providerId]);
      if (!providerConfig) {
        continue;
      }
      migrateLegacySpeakerSelectionConfig(
        providerConfig,
        `${pathLabel}.personas.${personaId}.${providerId}`,
        changes,
      );
    }
  }
}

function migrateLegacySpeakerSelectionProviderMap(
  value: unknown,
  pathLabel: string,
  changes: string[],
): void {
  const providers = getRecord(value);
  if (!providers) {
    return;
  }
  for (const [providerId, providerValue] of Object.entries(providers)) {
    if (isBlockedObjectKey(providerId)) {
      continue;
    }
    const providerConfig = getRecord(providerValue);
    if (!providerConfig) {
      continue;
    }
    migrateLegacySpeakerSelectionConfig(providerConfig, `${pathLabel}.${providerId}`, changes);
  }
}

function visitKnownTtsConfigLocations(
  raw: Record<string, unknown>,
  visit: (tts: Record<string, unknown> | null | undefined, pathLabel: string) => void,
): void {
  visit(getRecord(raw.tts), "tts");

  const agents = getRecord(raw.agents);
  const agentList = Array.isArray(agents?.list) ? agents.list : [];
  agentList.forEach((entry, index) => {
    const agent = getRecord(entry);
    visit(getRecord(agent?.tts), `agents.list[${index}].tts`);
  });

  const channels = getRecord(raw.channels);
  for (const [channelId, channelValue] of Object.entries(channels ?? {})) {
    if (isBlockedObjectKey(channelId)) {
      continue;
    }
    const channel = getRecord(channelValue);
    const migrateRootTts = supportsChannelRootTtsMigration(channelId);
    if (migrateRootTts) {
      visit(getRecord(channel?.tts), `channels.${channelId}.tts`);
    }
    visit(getRecord(getRecord(channel?.voice)?.tts), `channels.${channelId}.voice.tts`);
    const accounts = getRecord(channel?.accounts);
    for (const [accountId, accountValue] of Object.entries(accounts ?? {})) {
      if (isBlockedObjectKey(accountId)) {
        continue;
      }
      const account = getRecord(accountValue);
      if (migrateRootTts) {
        visit(getRecord(account?.tts), `channels.${channelId}.accounts.${accountId}.tts`);
      }
      visit(
        getRecord(getRecord(account?.voice)?.tts),
        `channels.${channelId}.accounts.${accountId}.voice.tts`,
      );
    }
  }

  const plugins = getRecord(raw.plugins);
  const pluginEntries = getRecord(plugins?.entries);
  for (const [pluginId, entryValue] of Object.entries(pluginEntries ?? {})) {
    if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) {
      continue;
    }
    const entry = getRecord(entryValue);
    const config = getRecord(entry?.config);
    visit(getRecord(config?.tts), `plugins.entries.${pluginId}.config.tts`);
  }
}

const LEGACY_TTS_PROVIDER_RULES: LegacyConfigRule[] = [
  {
    path: ["tts"],
    message:
      'tts legacy provider aliases/keys are legacy; use provider: "microsoft" and tts.providers.<provider>. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsProviderKeys(value),
  },
  {
    path: ["plugins", "entries"],
    message:
      'plugins.entries.voice-call.config.tts legacy provider aliases/keys are legacy; use provider: "microsoft" and plugins.entries.voice-call.config.tts.providers.<provider>. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsInPluginLocations(value, hasLegacyTtsProviderKeys),
  },
];

const LEGACY_TTS_ENABLED_RULES: LegacyConfigRule[] = [
  {
    path: ["tts"],
    message: 'tts.enabled is legacy; use tts.auto. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsEnabled(value),
  },
  {
    path: ["agents"],
    message:
      'agents.list[].tts.enabled is legacy; use agents.list[].tts.auto. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsInAgentLocations(value, hasLegacyTtsEnabled),
  },
  {
    path: ["channels"],
    message:
      'supported channel TTS enabled fields are legacy; use the same TTS block auto field. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsInChannelLocations(value, hasLegacyTtsEnabled),
  },
  {
    path: ["plugins", "entries"],
    message:
      'plugins.entries.voice-call.config.tts.enabled is legacy; use plugins.entries.voice-call.config.tts.auto. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsInPluginLocations(value, hasLegacyTtsEnabled),
  },
];

const LEGACY_TTS_SPEAKER_SELECTION_RULES: LegacyConfigRule[] = [
  {
    path: ["tts"],
    message:
      'tts speaker selection fields voice/voiceName/voiceId are legacy; use speakerVoice or speakerVoiceId. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsSpeakerSelection(value),
  },
  {
    path: ["agents"],
    message:
      'agents.list[].tts speaker selection fields voice/voiceName/voiceId are legacy; use speakerVoice or speakerVoiceId. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsInAgentLocations(value, hasLegacyTtsSpeakerSelection),
  },
  {
    path: ["channels"],
    message:
      'supported channel TTS speaker selection fields voice/voiceName/voiceId are legacy; use speakerVoice or speakerVoiceId. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsInChannelLocations(value, hasLegacyTtsSpeakerSelection),
  },
  {
    path: ["plugins", "entries"],
    message:
      'plugins.entries.voice-call.config.tts speaker selection fields voice/voiceName/voiceId are legacy; use speakerVoice or speakerVoiceId. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsInPluginLocations(value, hasLegacyTtsSpeakerSelection),
  },
];

/** Legacy config migration specs for TTS runtime compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "tts.top-level-owner",
    describe: "Move messages.tts to top-level tts",
    legacyRules: [
      {
        path: ["messages", "tts"],
        message: 'messages.tts moved to top-level tts. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const messages = getRecord(raw.messages);
      if (!messages || !Object.hasOwn(messages, "tts")) {
        return;
      }
      const legacy = getRecord(messages.tts);
      if (!legacy) {
        delete messages.tts;
        changes.push("Removed messages.tts (invalid value).");
        return;
      }
      // Root tts has no realtime block; realtime speaker voice is owned by
      // talk.realtime.speakerVoice, so route the legacy alias there first.
      const legacyRealtime = getRecord(legacy.realtime);
      if (legacyRealtime) {
        const legacyVoice = legacyRealtime.speakerVoice ?? legacyRealtime.voice;
        const talk = getRecord(raw.talk) ?? {};
        const talkRealtime = getRecord(talk.realtime) ?? {};
        if (legacyVoice !== undefined && talkRealtime.speakerVoice === undefined) {
          talkRealtime.speakerVoice = legacyVoice;
          talk.realtime = talkRealtime;
          raw.talk = talk;
          changes.push("Moved messages.tts.realtime voice → talk.realtime.speakerVoice.");
        } else {
          changes.push("Removed messages.tts.realtime (talk.realtime already configured).");
        }
        delete legacy.realtime;
      }
      const canonical = getRecord(raw.tts) ?? {};
      mergeMissing(canonical, legacy);
      raw.tts = canonical;
      delete messages.tts;
      changes.push("Moved messages.tts to top-level tts.");
    },
  }),
  defineLegacyConfigMigration({
    id: "tts.providers-generic-shape",
    describe: "Move legacy bundled TTS config keys into tts.providers",
    legacyRules: LEGACY_TTS_PROVIDER_RULES,
    apply: (raw, changes) => {
      migrateLegacyTtsConfig(getRecord(raw.tts), "tts", changes);

      const plugins = getRecord(raw.plugins);
      const pluginEntries = getRecord(plugins?.entries);
      if (!pluginEntries) {
        return;
      }
      for (const [pluginId, entryValue] of Object.entries(pluginEntries)) {
        if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) {
          continue;
        }
        const entry = getRecord(entryValue);
        const config = getRecord(entry?.config);
        migrateLegacyTtsConfig(
          getRecord(config?.tts),
          `plugins.entries.${pluginId}.config.tts`,
          changes,
        );
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "tts.speaker-selection-keys",
    describe: "Move TTS speaker selection keys to speakerVoice/speakerVoiceId",
    legacyRules: LEGACY_TTS_SPEAKER_SELECTION_RULES,
    apply: (raw, changes) => {
      visitKnownTtsConfigLocations(raw, (tts, pathLabel) =>
        migrateLegacyTtsSpeakerSelection(tts, pathLabel, changes),
      );
    },
  }),
  defineLegacyConfigMigration({
    id: "tts.enabled-auto-mode",
    describe: "Move legacy TTS enabled toggles to auto mode",
    legacyRules: LEGACY_TTS_ENABLED_RULES,
    apply: (raw, changes) => {
      visitKnownTtsConfigLocations(raw, (tts, pathLabel) =>
        migrateLegacyTtsEnabled(tts, pathLabel, changes),
      );
    },
  }),
];
