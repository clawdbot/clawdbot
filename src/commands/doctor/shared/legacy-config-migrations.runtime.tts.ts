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
  for (const [config] of visitLegacyTtsSpeakerConfigs(value, "")) {
    if (hasLegacySpeakerSelectionKeys(config)) {
      return true;
    }
  }
  return false;
}

type LegacyTtsMatcher = (value: unknown) => boolean;

function hasLegacyTtsInLocations(raw: Record<string, unknown>, matcher: LegacyTtsMatcher): boolean {
  for (const [tts] of visitKnownTtsConfigLocations(raw)) {
    if (matcher(tts)) {
      return true;
    }
  }
  return false;
}

function supportsChannelRootTtsMigration(channelId: string): boolean {
  return !CHANNEL_ROOT_TTS_UNSUPPORTED_IDS.has(channelId.trim().toLowerCase());
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
  for (const [config, path] of visitLegacyTtsSpeakerConfigs(tts, pathLabel)) {
    migrateLegacySpeakerSelectionConfig(config, path, changes);
  }
}

function* visitLegacySpeakerSelectionScope(
  value: unknown,
  pathLabel: string,
): Generator<[Record<string, unknown>, string]> {
  const scope = getRecord(value);
  if (!scope) {
    return;
  }
  for (const [providerId, providerValue] of Object.entries(getRecord(scope.providers) ?? {})) {
    const config = getRecord(providerValue);
    if (!isBlockedObjectKey(providerId) && config) {
      yield [config, `${pathLabel}.providers.${providerId}`];
    }
  }
  for (const providerId of LEGACY_TTS_PROVIDER_KEYS) {
    const config = getRecord(scope[providerId]);
    if (config) {
      yield [config, `${pathLabel}.${providerId}`];
    }
  }
}

function* visitLegacyTtsSpeakerConfigs(
  value: unknown,
  pathLabel: string,
): Generator<[Record<string, unknown>, string]> {
  const tts = getRecord(value);
  yield* visitLegacySpeakerSelectionScope(tts, pathLabel);
  for (const [personaId, persona] of Object.entries(getRecord(tts?.personas) ?? {})) {
    if (!isBlockedObjectKey(personaId)) {
      yield* visitLegacySpeakerSelectionScope(persona, `${pathLabel}.personas.${personaId}`);
    }
  }
}

// Keep previews lazy while sharing the repair walk and its supported-path exclusions.
function* visitKnownTtsConfigLocations(
  raw: Record<string, unknown>,
): Generator<[Record<string, unknown> | null, string]> {
  yield [getRecord(raw.tts), "tts"];

  const agents = getRecord(raw.agents);
  const agentList = Array.isArray(agents?.list) ? agents.list : [];
  for (const [index, entry] of agentList.entries()) {
    yield [getRecord(getRecord(entry)?.tts), `agents.list[${index}].tts`];
  }

  const channels = getRecord(raw.channels);
  for (const [channelId, channelValue] of Object.entries(channels ?? {})) {
    if (isBlockedObjectKey(channelId)) {
      continue;
    }
    const channel = getRecord(channelValue);
    const migrateRootTts = supportsChannelRootTtsMigration(channelId);
    if (migrateRootTts) {
      yield [getRecord(channel?.tts), `channels.${channelId}.tts`];
    }
    yield [getRecord(getRecord(channel?.voice)?.tts), `channels.${channelId}.voice.tts`];
    for (const [accountId, accountValue] of Object.entries(getRecord(channel?.accounts) ?? {})) {
      if (isBlockedObjectKey(accountId)) {
        continue;
      }
      const account = getRecord(accountValue);
      if (migrateRootTts) {
        yield [getRecord(account?.tts), `channels.${channelId}.accounts.${accountId}.tts`];
      }
      yield [
        getRecord(getRecord(account?.voice)?.tts),
        `channels.${channelId}.accounts.${accountId}.voice.tts`,
      ];
    }
  }

  const pluginEntries = getRecord(getRecord(raw.plugins)?.entries);
  for (const [pluginId, entryValue] of Object.entries(pluginEntries ?? {})) {
    if (!isBlockedObjectKey(pluginId) && LEGACY_TTS_PLUGIN_IDS.has(pluginId)) {
      yield [
        getRecord(getRecord(getRecord(entryValue)?.config)?.tts),
        `plugins.entries.${pluginId}.config.tts`,
      ];
    }
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
    match: (value) =>
      hasLegacyTtsInLocations({ plugins: { entries: value } }, hasLegacyTtsProviderKeys),
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
    match: (value) => hasLegacyTtsInLocations({ agents: value }, hasLegacyTtsEnabled),
  },
  {
    path: ["channels"],
    message:
      'supported channel TTS enabled fields are legacy; use the same TTS block auto field. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsInLocations({ channels: value }, hasLegacyTtsEnabled),
  },
  {
    path: ["plugins", "entries"],
    message:
      'plugins.entries.voice-call.config.tts.enabled is legacy; use plugins.entries.voice-call.config.tts.auto. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsInLocations({ plugins: { entries: value } }, hasLegacyTtsEnabled),
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
    match: (value) => hasLegacyTtsInLocations({ agents: value }, hasLegacyTtsSpeakerSelection),
  },
  {
    path: ["channels"],
    message:
      'supported channel TTS speaker selection fields voice/voiceName/voiceId are legacy; use speakerVoice or speakerVoiceId. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsInLocations({ channels: value }, hasLegacyTtsSpeakerSelection),
  },
  {
    path: ["plugins", "entries"],
    message:
      'plugins.entries.voice-call.config.tts speaker selection fields voice/voiceName/voiceId are legacy; use speakerVoice or speakerVoiceId. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyTtsInLocations({ plugins: { entries: value } }, hasLegacyTtsSpeakerSelection),
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
      // Provider aliases have a narrower migration scope than speaker keys and enabled.
      for (const [tts, pathLabel] of visitKnownTtsConfigLocations({
        tts: raw.tts,
        plugins: raw.plugins,
      })) {
        migrateLegacyTtsConfig(tts, pathLabel, changes);
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "tts.speaker-selection-keys",
    describe: "Move TTS speaker selection keys to speakerVoice/speakerVoiceId",
    legacyRules: LEGACY_TTS_SPEAKER_SELECTION_RULES,
    apply: (raw, changes) => {
      for (const [tts, pathLabel] of visitKnownTtsConfigLocations(raw)) {
        migrateLegacyTtsSpeakerSelection(tts, pathLabel, changes);
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "tts.enabled-auto-mode",
    describe: "Move legacy TTS enabled toggles to auto mode",
    legacyRules: LEGACY_TTS_ENABLED_RULES,
    apply: (raw, changes) => {
      for (const [tts, pathLabel] of visitKnownTtsConfigLocations(raw)) {
        migrateLegacyTtsEnabled(tts, pathLabel, changes);
      }
    },
  }),
];
