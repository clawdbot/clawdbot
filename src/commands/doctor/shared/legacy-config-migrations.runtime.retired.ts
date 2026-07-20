// Retired runtime config keys that migrate or disappear before canonical validation.
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const rule = (
  path: string[],
  message: string,
  match?: LegacyConfigRule["match"],
): LegacyConfigRule => ({
  path,
  message: `${message} Run "openclaw doctor --fix".`,
  ...(match ? { match } : {}),
});

function moveVoice(owner: Record<string, unknown>, path: string, changes: string[]): void {
  if (!Object.hasOwn(owner, "voice")) {
    return;
  }
  if (owner.speakerVoice === undefined) {
    owner.speakerVoice = owner.voice;
    changes.push(`Moved ${path}.voice → ${path}.speakerVoice.`);
  } else {
    changes.push(`Removed ${path}.voice (${path}.speakerVoice already set).`);
  }
  delete owner.voice;
}

function migrateDiscordVoice(channels: Record<string, unknown>, changes: string[]): void {
  const discord = getRecord(channels.discord);
  if (!discord) {
    return;
  }
  const migrateEntry = (entry: Record<string, unknown>, path: string) => {
    const realtime = getRecord(getRecord(entry.voice)?.realtime);
    if (realtime) {
      moveVoice(realtime, `${path}.voice.realtime`, changes);
    }
  };
  migrateEntry(discord, "channels.discord");
  const accounts = getRecord(discord.accounts);
  if (accounts) {
    for (const [accountId, value] of Object.entries(accounts)) {
      const account = getRecord(value);
      if (account) {
        migrateEntry(account, `channels.discord.accounts.${accountId}`);
      }
    }
  }
}

function hasDiscordRealtimeVoice(value: unknown): boolean {
  const discord = getRecord(value);
  if (!discord) {
    return false;
  }
  const hasAlias = (entry: unknown) => {
    const realtime = getRecord(getRecord(getRecord(entry)?.voice)?.realtime);
    return realtime ? Object.hasOwn(realtime, "voice") : false;
  };
  if (hasAlias(discord)) {
    return true;
  }
  const accounts = getRecord(discord.accounts);
  return accounts ? Object.values(accounts).some(hasAlias) : false;
}

function mapDeepgram(value: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  if (typeof value.detectLanguage === "boolean") {
    mapped.detect_language = value.detectLanguage;
  }
  if (typeof value.punctuate === "boolean") {
    mapped.punctuate = value.punctuate;
  }
  if (typeof value.smartFormat === "boolean") {
    mapped.smart_format = value.smartFormat;
  }
  return mapped;
}

function migrateDeepgramOwner(
  owner: Record<string, unknown>,
  path: string,
  changes: string[],
): void {
  const legacy = getRecord(owner.deepgram);
  if (!legacy) {
    return;
  }
  const providerOptions = getRecord(owner.providerOptions) ?? {};
  const canonical = getRecord(providerOptions.deepgram) ?? {};
  providerOptions.deepgram = { ...mapDeepgram(legacy), ...canonical };
  owner.providerOptions = providerOptions;
  delete owner.deepgram;
  changes.push(`Moved ${path}.deepgram → ${path}.providerOptions.deepgram.`);
}

function migrateMediaDeepgram(raw: Record<string, unknown>, changes: string[]): void {
  const media = getRecord(getRecord(raw.tools)?.media);
  if (!media) {
    return;
  }
  const migrateModels = (models: unknown, path: string) => {
    if (!Array.isArray(models)) {
      return;
    }
    models.forEach((value, index) => {
      const model = getRecord(value);
      if (model) {
        migrateDeepgramOwner(model, `${path}[${index}]`, changes);
      }
    });
  };
  migrateModels(media.models, "tools.media.models");
  for (const capability of ["audio", "image", "video"]) {
    const entry = getRecord(media[capability]);
    if (!entry) {
      continue;
    }
    migrateDeepgramOwner(entry, `tools.media.${capability}`, changes);
    migrateModels(entry.models, `tools.media.${capability}.models`);
  }
}

function hasMediaDeepgram(value: unknown): boolean {
  const media = getRecord(value);
  if (!media) {
    return false;
  }
  const hasAlias = (entry: unknown) => {
    const owner = getRecord(entry);
    return owner ? Object.hasOwn(owner, "deepgram") : false;
  };
  const modelsHaveAlias = (models: unknown) => Array.isArray(models) && models.some(hasAlias);
  if (modelsHaveAlias(media.models)) {
    return true;
  }
  return ["audio", "image", "video"].some((capability) => {
    const entry = getRecord(media[capability]);
    return entry ? hasAlias(entry) || modelsHaveAlias(entry.models) : false;
  });
}

const RETIRED_TUNING_PATHS = [
  ["auth", "cooldowns"],
  ["secrets", "resolution"],
  ["browser", "remoteCdpTimeoutMs"],
  ["browser", "remoteCdpHandshakeTimeoutMs"],
  ["browser", "localLaunchTimeoutMs"],
  ["browser", "localCdpReadyTimeoutMs"],
  ["browser", "actionTimeoutMs"],
  ["browser", "cdpPortRangeStart"],
  ["browser", "tabCleanup", "idleMinutes"],
  ["browser", "tabCleanup", "maxTabsPerSession"],
  ["browser", "tabCleanup", "sweepMinutes"],
  ["tools", "loopDetection", "genericRepeat"],
  ["tools", "loopDetection", "knownPollNoProgress"],
  ["tools", "loopDetection", "pingPong"],
  ["tools", "loopDetection", "windowSize"],
  ["tools", "loopDetection", "historySize"],
  ["tools", "loopDetection", "warningThreshold"],
  ["tools", "loopDetection", "unknownToolThreshold"],
  ["tools", "loopDetection", "criticalThreshold"],
  ["tools", "loopDetection", "globalCircuitBreakerThreshold"],
  ["tools", "loopDetection", "detectors"],
  ["tools", "loopDetection", "postCompactionGuard"],
  ["gateway", "handshakeTimeoutMs"],
  ["gateway", "channelHealthCheckMinutes"],
  ["gateway", "channelStaleEventThresholdMinutes"],
  ["gateway", "channelMaxRestartsPerHour"],
  ["gateway", "reload", "debounceMs"],
  ["gateway", "reload", "deferralTimeoutMs"],
  ["gateway", "http", "endpoints", "chatCompletions", "maxBodyBytes"],
  ["gateway", "http", "endpoints", "chatCompletions", "maxImageParts"],
  ["gateway", "http", "endpoints", "chatCompletions", "maxTotalImageBytes"],
  ["gateway", "http", "endpoints", "responses", "maxBodyBytes"],
  ["session", "typingIntervalSeconds"],
  ["session", "writeLock"],
  ["session", "agentToAgent", "maxPingPongTurns"],
  ["cron", "maxConcurrentRuns"],
  ["cron", "triggers", "minIntervalMs"],
  ["cron", "retry"],
  ["diagnostics", "stuckSessionWarnMs"],
  ["diagnostics", "stuckSessionAbortMs"],
  ["diagnostics", "memoryPressureSnapshot"],
  ["diagnostics", "memoryPressureBundle"],
  ["web", "heartbeatSeconds"],
  ["web", "reconnect"],
  ["web", "whatsapp"],
  ["messages", "queue", "debounceMs"],
  ["messages", "statusReactions", "timing"],
  ["acp", "stream", "coalesceIdleMs"],
  ["acp", "stream", "maxChunkChars"],
  ["acp", "stream", "maxOutputChars"],
  ["acp", "stream", "maxSessionUpdateChars"],
  ["acp", "stream", "hiddenBoundarySeparator"],
  ["acp", "maxConcurrentSessions"],
  ["acp", "runtime", "ttlMinutes"],
  ["mcp", "sessionIdleTtlMs"],
  ["worktrees"],
  ["transcripts", "maxUtterances"],
  ["hooks", "maxBodyBytes"],
  ["update", "auto", "stableDelayHours"],
  ["update", "auto", "stableJitterHours"],
  ["update", "auto", "betaCheckIntervalHours"],
] as const;

const RETIRED_AGENT_TUNING_PATHS = [
  ["compaction", "reserveTokens"],
  ["compaction", "reserveTokensFloor"],
  ["compaction", "maxHistoryShare"],
  ["contextPruning", "keepLastAssistants"],
  ["contextPruning", "softTrimRatio"],
  ["contextPruning", "hardClearRatio"],
  ["contextPruning", "minPrunableToolChars"],
  ["contextPruning", "softTrim"],
  ["memorySearch", "chunking"],
  ["memorySearch", "sync", "watchDebounceMs"],
  ["memorySearch", "sync", "intervalMinutes"],
  ["memorySearch", "query", "hybrid", "vectorWeight"],
  ["memorySearch", "query", "hybrid", "textWeight"],
  ["memorySearch", "query", "hybrid", "candidateMultiplier"],
  ["memorySearch", "query", "hybrid", "mmr", "lambda"],
  ["memorySearch", "query", "hybrid", "temporalDecay", "halfLifeDays"],
  ["memorySearch", "cache", "maxEntries"],
  ["cliBackends", "*", "reliability", "outputLimits"],
  ["cliBackends", "*", "reliability", "watchdog", "fresh", "noOutputTimeoutMs"],
  ["cliBackends", "*", "reliability", "watchdog", "resume", "noOutputTimeoutMs"],
  ["runRetries"],
  ["tools", "loopDetection", "genericRepeat"],
  ["tools", "loopDetection", "knownPollNoProgress"],
  ["tools", "loopDetection", "pingPong"],
  ["tools", "loopDetection", "windowSize"],
  ["tools", "loopDetection", "historySize"],
  ["tools", "loopDetection", "warningThreshold"],
  ["tools", "loopDetection", "unknownToolThreshold"],
  ["tools", "loopDetection", "criticalThreshold"],
  ["tools", "loopDetection", "globalCircuitBreakerThreshold"],
  ["tools", "loopDetection", "detectors"],
  ["tools", "loopDetection", "postCompactionGuard"],
] as const;

function deleteRetiredPath(owner: unknown, path: readonly string[], index = 0): boolean {
  const record = getRecord(owner);
  if (!record) {
    return false;
  }
  const key = path[index];
  if (!key) {
    return false;
  }
  if (key === "*") {
    let changed = false;
    for (const value of Object.values(record)) {
      changed = deleteRetiredPath(value, path, index + 1) || changed;
    }
    return changed;
  }
  if (index === path.length - 1) {
    if (!Object.hasOwn(record, key)) {
      return false;
    }
    delete record[key];
    return true;
  }
  const child = getRecord(record[key]);
  if (!child || !deleteRetiredPath(child, path, index + 1)) {
    return false;
  }
  if (Object.keys(child).length === 0) {
    delete record[key];
  }
  return true;
}

function stripRetiredTuningKnobs(raw: Record<string, unknown>): boolean {
  let changed = false;
  for (const path of RETIRED_TUNING_PATHS) {
    changed = deleteRetiredPath(raw, path) || changed;
  }
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  if (defaults) {
    for (const path of RETIRED_AGENT_TUNING_PATHS) {
      changed = deleteRetiredPath(defaults, path) || changed;
    }
  }
  if (Array.isArray(agents?.list)) {
    for (const agent of agents.list) {
      for (const path of RETIRED_AGENT_TUNING_PATHS) {
        changed = deleteRetiredPath(agent, path) || changed;
      }
    }
  }
  return changed;
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "runtime.tuning-knobs-purge",
    describe: "Remove retired runtime tuning knobs",
    legacyRules: [
      rule(
        [],
        "Numeric runtime tuning knobs were retired and now use built-in defaults.",
        (_value, root) => stripRetiredTuningKnobs(structuredClone(root)),
      ),
    ],
    apply: (raw, changes) => {
      if (stripRetiredTuningKnobs(raw)) {
        changes.push("Removed retired runtime tuning knobs; built-in defaults now apply.");
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "runtime.retired-config-keys",
    describe: "Migrate retired root and tool config keys",
    legacyRules: [
      rule(["tui"], "tui was retired and is ignored."),
      rule(["commands", "modelsWrite"], "commands.modelsWrite was retired and is ignored."),
      rule(
        ["messages", "messagePrefix"],
        "messages.messagePrefix moved to channels.whatsapp.messagePrefix.",
      ),
      rule(
        ["tools", "media", "asyncCompletion"],
        "tools.media.asyncCompletion.directSend was retired and is ignored.",
      ),
      rule(
        ["tools", "message", "allowCrossContextSend"],
        "tools.message.allowCrossContextSend moved to tools.message.crossContext.",
      ),
      rule(
        ["talk", "realtime", "voice"],
        "talk.realtime.voice moved to talk.realtime.speakerVoice.",
      ),
      rule(
        ["channels", "discord"],
        "Discord realtime voice aliases moved to speakerVoice.",
        hasDiscordRealtimeVoice,
      ),
      rule(
        ["tools", "media"],
        "Legacy Deepgram options moved to providerOptions.deepgram.",
        hasMediaDeepgram,
      ),
    ],
    apply: (raw, changes) => {
      if (Object.hasOwn(raw, "tui")) {
        delete raw.tui;
        changes.push("Removed retired tui config; the footer uses the default compact display.");
      }
      const commands = getRecord(raw.commands);
      if (commands && Object.hasOwn(commands, "modelsWrite")) {
        delete commands.modelsWrite;
        changes.push("Removed retired commands.modelsWrite.");
      }
      const messages = getRecord(raw.messages);
      if (messages && Object.hasOwn(messages, "messagePrefix")) {
        const whatsapp = ensureRecord(ensureRecord(raw, "channels"), "whatsapp");
        if (whatsapp.messagePrefix === undefined) {
          whatsapp.messagePrefix = messages.messagePrefix;
          changes.push("Moved messages.messagePrefix → channels.whatsapp.messagePrefix.");
        } else {
          changes.push(
            "Removed messages.messagePrefix (channels.whatsapp.messagePrefix already set).",
          );
        }
        delete messages.messagePrefix;
      }
      const media = getRecord(getRecord(raw.tools)?.media);
      if (media && Object.hasOwn(media, "asyncCompletion")) {
        delete media.asyncCompletion;
        changes.push("Removed retired tools.media.asyncCompletion.directSend.");
      }
      const messageTool = getRecord(getRecord(raw.tools)?.message);
      if (messageTool && Object.hasOwn(messageTool, "allowCrossContextSend")) {
        const enabled = messageTool.allowCrossContextSend === true;
        if (enabled) {
          const crossContext = getRecord(messageTool.crossContext) ?? {};
          if (crossContext.allowWithinProvider === undefined) {
            crossContext.allowWithinProvider = true;
          }
          if (crossContext.allowAcrossProviders === undefined) {
            crossContext.allowAcrossProviders = true;
          }
          messageTool.crossContext = crossContext;
          changes.push("Moved tools.message.allowCrossContextSend → tools.message.crossContext.");
        } else {
          changes.push("Removed tools.message.allowCrossContextSend.");
        }
        delete messageTool.allowCrossContextSend;
      }
      const talkRealtime = getRecord(getRecord(raw.talk)?.realtime);
      if (talkRealtime) {
        moveVoice(talkRealtime, "talk.realtime", changes);
      }
      const channels = getRecord(raw.channels);
      if (channels) {
        migrateDiscordVoice(channels, changes);
      }
      migrateMediaDeepgram(raw, changes);
    },
  }),
];
