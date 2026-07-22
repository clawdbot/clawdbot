// Media and voice compatibility migrations retired from canonical runtime config.
import { getRecord } from "../../../config/legacy.shared.js";

export function moveVoice(owner: Record<string, unknown>, path: string, changes: string[]): void {
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

export function migrateDiscordVoice(channels: Record<string, unknown>, changes: string[]): void {
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

export function hasDiscordRealtimeVoice(value: unknown): boolean {
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

export function migrateMediaDeepgram(raw: Record<string, unknown>, changes: string[]): void {
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

export function hasMediaDeepgram(value: unknown): boolean {
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
  ["systemAgent"],
  ["marketplaces"],
  ["cli", "banner", "taglineMode"],
  ["commitments"],
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
  ["memory", "search", "chunking"],
  ["memory", "search", "sync", "watchDebounceMs"],
  ["memory", "search", "sync", "intervalMinutes"],
  ["memory", "search", "query", "hybrid", "vectorWeight"],
  ["memory", "search", "query", "hybrid", "textWeight"],
  ["memory", "search", "query", "hybrid", "candidateMultiplier"],
  ["memory", "search", "query", "hybrid", "mmr", "lambda"],
  ["memory", "search", "query", "hybrid", "temporalDecay", "halfLifeDays"],
  ["memory", "search", "cache", "maxEntries"],
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
  ["memory", "search", "chunking"],
  ["memory", "search", "sync", "watchDebounceMs"],
  ["memory", "search", "sync", "intervalMinutes"],
  ["memory", "search", "query", "hybrid", "vectorWeight"],
  ["memory", "search", "query", "hybrid", "textWeight"],
  ["memory", "search", "query", "hybrid", "candidateMultiplier"],
  ["memory", "search", "query", "hybrid", "mmr", "lambda"],
  ["memory", "search", "query", "hybrid", "temporalDecay", "halfLifeDays"],
  ["memory", "search", "cache", "maxEntries"],
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

export function stripRetiredTuningKnobs(raw: Record<string, unknown>): boolean {
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
  const entries = getRecord(agents?.entries);
  if (entries) {
    for (const agent of Object.values(entries)) {
      for (const path of RETIRED_AGENT_TUNING_PATHS) {
        changed = deleteRetiredPath(agent, path) || changed;
      }
    }
  }
  return changed;
}

const MEDIA_CAPABILITIES = ["image", "audio", "video"] as const;
function stableConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableConfigValue);
  }
  const record = getRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .map((key) => [key, stableConfigValue(record[key])]),
  );
}

function mediaModelSignature(model: Record<string, unknown>): string {
  const { capabilities: _capabilities, ...rest } = model;
  return JSON.stringify(stableConfigValue(rest));
}

function scopeLegacyMediaModel(
  model: Record<string, unknown>,
  capability: string,
): Record<string, unknown> | undefined {
  if (
    Array.isArray(model.capabilities) &&
    !model.capabilities.some((value) => value === capability)
  ) {
    return undefined;
  }
  return { ...model, capabilities: [capability] };
}

export function hasLegacyMediaCapabilityConfig(value: unknown): boolean {
  const media = getRecord(value);
  return MEDIA_CAPABILITIES.some((capability) => {
    const config = getRecord(media?.[capability]);
    return Array.isArray(config?.models);
  });
}

export function consolidateMediaCapabilityConfig(
  raw: Record<string, unknown>,
  changes: string[],
): void {
  const media = getRecord(getRecord(raw.tools)?.media);
  if (!media) {
    return;
  }
  const sharedModels = Array.isArray(media.models)
    ? media.models.filter(
        (value): value is Record<string, unknown> => getRecord(value) !== undefined,
      )
    : [];
  const migratedModels: Record<string, unknown>[] = [];
  let changed = false;

  for (const capability of MEDIA_CAPABILITIES) {
    const config = getRecord(media[capability]);
    if (!config) {
      continue;
    }
    const legacyModels = Array.isArray(config.models)
      ? config.models.filter(
          (value): value is Record<string, unknown> => getRecord(value) !== undefined,
        )
      : [];
    const migratedBySignature = new Map<string, Record<string, unknown>>();
    const eligibleLegacyModels = legacyModels.flatMap((legacyModel) => {
      const scoped = scopeLegacyMediaModel(legacyModel, capability);
      return scoped ? [scoped] : [];
    });
    for (const migrated of eligibleLegacyModels) {
      const signature = mediaModelSignature(migrated);
      const duplicate = migratedBySignature.get(signature);
      if (duplicate) {
        continue;
      }
      migratedBySignature.set(signature, migrated);
      migratedModels.push(migrated);
    }
    if (Object.hasOwn(config, "models")) {
      delete config.models;
      changed = true;
    }
    if (Object.keys(config).length === 0) {
      delete media[capability];
    }
    changed = changed || legacyModels.length > 0;
  }
  const canonicalModels = [...migratedModels, ...sharedModels];
  if (canonicalModels.length > 0) {
    media.models = canonicalModels;
  }
  if (changed) {
    changes.push(
      "Consolidated tools.media image/audio/video model settings into capability-tagged tools.media.models entries.",
    );
  }
}
