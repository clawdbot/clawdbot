import { describe, expect, it } from "vitest";
import { MEDIA_AUDIO_FIELD_KEYS } from "./media-audio-field-metadata.js";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";

const ROOT_SECTIONS = [
  "meta",
  "env",
  "wizard",
  "diagnostics",
  "logging",
  "cli",
  "update",
  "commitments",
  "browser",
  "ui",
  "auth",
  "models",
  "nodeHost",
  "agents",
  "tools",
  "bindings",
  "broadcast",
  "audio",
  "media",
  "messages",
  "commands",
  "approvals",
  "session",
  "cron",
  "hooks",
  "web",
  "channels",
  "discovery",
  "canvasHost",
  "talk",
  "gateway",
  "memory",
  "plugins",
] as const;

const TARGET_KEYS = [
  "memory.citations",
  "memory.backend",
  "memory.qmd.searchMode",
  "memory.qmd.searchTool",
  "memory.qmd.scope",
  "memory.qmd.includeDefaultMemory",
  "memory.qmd.mcporter.enabled",
  "memory.qmd.mcporter.serverName",
  "memory.qmd.command",
  "memory.qmd.mcporter",
  "memory.qmd.mcporter.startDaemon",
  "memory.qmd.paths",
  "memory.qmd.paths.path",
  "memory.qmd.paths.pattern",
  "memory.qmd.paths.name",
  "memory.qmd.sessions.enabled",
  "memory.qmd.sessions.exportDir",
  "memory.qmd.sessions.retentionDays",
  "memory.qmd.update.interval",
  "memory.qmd.update.debounceMs",
  "memory.qmd.update.onBoot",
  "memory.qmd.update.startup",
  "memory.qmd.update.startupDelayMs",
  "memory.qmd.update.waitForBootSync",
  "memory.qmd.update.embedInterval",
  "memory.qmd.update.commandTimeoutMs",
  "memory.qmd.update.updateTimeoutMs",
  "memory.qmd.update.embedTimeoutMs",
  "memory.qmd.limits.maxResults",
  "memory.qmd.limits.maxSnippetChars",
  "memory.qmd.limits.maxInjectedChars",
  "memory.qmd.limits.timeoutMs",
  "agents.defaults.memorySearch.provider",
  "agents.defaults.memorySearch.fallback",
  "agents.defaults.memorySearch.sources",
  "agents.defaults.memorySearch.extraPaths",
  "agents.defaults.memorySearch.qmd",
  "agents.defaults.memorySearch.qmd.extraCollections",
  "agents.defaults.memorySearch.qmd.extraCollections.path",
  "agents.defaults.memorySearch.qmd.extraCollections.name",
  "agents.defaults.memorySearch.qmd.extraCollections.pattern",
  "agents.defaults.memorySearch.multimodal",
  "agents.defaults.memorySearch.multimodal.enabled",
  "agents.defaults.memorySearch.multimodal.modalities",
  "agents.defaults.memorySearch.multimodal.maxFileBytes",
  "agents.defaults.memorySearch.experimental.sessionMemory",
  "agents.defaults.memorySearch.remote.baseUrl",
  "agents.defaults.memorySearch.remote.apiKey",
  "agents.defaults.memorySearch.remote.headers",
  "agents.defaults.memorySearch.remote.nonBatchConcurrency",
  "agents.defaults.memorySearch.remote.batch.enabled",
  "agents.defaults.memorySearch.remote.batch.wait",
  "agents.defaults.memorySearch.remote.batch.concurrency",
  "agents.defaults.memorySearch.remote.batch.pollIntervalMs",
  "agents.defaults.memorySearch.remote.batch.timeoutMinutes",
  "agents.defaults.memorySearch.local.modelPath",
  "agents.defaults.memorySearch.store.path",
  "agents.defaults.memorySearch.inputType",
  "agents.defaults.memorySearch.queryInputType",
  "agents.defaults.memorySearch.documentInputType",
  "agents.defaults.memorySearch.outputDimensionality",
  "agents.defaults.memorySearch.store.vector.enabled",
  "agents.defaults.memorySearch.store.vector.extensionPath",
  "agents.defaults.memorySearch.query.hybrid.enabled",
  "agents.defaults.memorySearch.query.hybrid.vectorWeight",
  "agents.defaults.memorySearch.query.hybrid.textWeight",
  "agents.defaults.memorySearch.query.hybrid.candidateMultiplier",
  "agents.defaults.memorySearch.query.hybrid.mmr.enabled",
  "agents.defaults.memorySearch.query.hybrid.mmr.lambda",
  "agents.defaults.memorySearch.query.hybrid.temporalDecay.enabled",
  "agents.defaults.memorySearch.query.hybrid.temporalDecay.halfLifeDays",
  "agents.defaults.memorySearch.cache.enabled",
  "agents.defaults.memorySearch.cache.maxEntries",
  "agents.defaults.memorySearch.sync.onSearch",
  "agents.defaults.memorySearch.sync.watch",
  "agents.defaults.memorySearch.sync.embeddingBatchTimeoutSeconds",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages",
  "models.mode",
  "models.providers.*.auth",
  "models.providers.*.authHeader",
  "models.providers.*.request",
  "gateway.reload.mode",
  "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback",
  "gateway.controlUi.allowInsecureAuth",
  "gateway.controlUi.dangerouslyDisableDeviceAuth",
  "gateway.controlUi.embedSandbox",
  "cron",
  "cron.enabled",
  "cron.store",
  "cron.maxConcurrentRuns",
  "cron.retry",
  "cron.retry.maxAttempts",
  "cron.retry.backoffMs",
  "cron.retry.retryOn",
  "cron.webhook",
  "cron.webhookToken",
  "cron.sessionRetention",
  "cron.runLog",
  "cron.runLog.maxBytes",
  "cron.runLog.keepLines",
  "session",
  "session.scope",
  "session.dmScope",
  "session.identityLinks",
  "session.resetTriggers",
  "session.idleMinutes",
  "session.reset",
  "session.reset.mode",
  "session.reset.atHour",
  "session.reset.idleMinutes",
  "session.resetByType",
  "session.resetByType.direct",
  "session.resetByType.dm",
  "session.resetByType.group",
  "session.resetByType.thread",
  "session.resetByChannel",
  "session.store",
  "session.typingIntervalSeconds",
  "session.typingMode",
  "session.mainKey",
  "session.sendPolicy",
  "session.sendPolicy.default",
  "session.sendPolicy.rules",
  "session.sendPolicy.rules[].action",
  "session.sendPolicy.rules[].match",
  "session.sendPolicy.rules[].match.channel",
  "session.sendPolicy.rules[].match.chatType",
  "session.sendPolicy.rules[].match.keyPrefix",
  "session.sendPolicy.rules[].match.rawKeyPrefix",
  "session.agentToAgent",
  "session.agentToAgent.maxPingPongTurns",
  "session.threadBindings",
  "session.threadBindings.enabled",
  "session.threadBindings.idleHours",
  "session.threadBindings.maxAgeHours",
  "session.threadBindings.spawnSessions",
  "session.threadBindings.defaultSpawnContext",
  "session.maintenance",
  "session.maintenance.mode",
  "session.maintenance.pruneAfter",
  "session.maintenance.pruneDays",
  "session.maintenance.maxEntries",
  "session.maintenance.rotateBytes",
  "session.maintenance.resetArchiveRetention",
  "session.maintenance.maxDiskBytes",
  "session.maintenance.highWaterBytes",
  "approvals",
  "approvals.exec",
  "approvals.exec.enabled",
  "approvals.exec.mode",
  "approvals.exec.agentFilter",
  "approvals.exec.sessionFilter",
  "approvals.exec.targets",
  "approvals.exec.targets[].channel",
  "approvals.exec.targets[].to",
  "approvals.exec.targets[].accountId",
  "approvals.exec.targets[].threadId",
  "nodeHost",
  "nodeHost.browserProxy",
  "nodeHost.browserProxy.enabled",
  "nodeHost.browserProxy.allowProfiles",
  "media",
  "media.preserveFilenames",
  "audio",
  "audio.transcription",
  "audio.transcription.command",
  "audio.transcription.timeoutSeconds",
  "bindings",
  "bindings[].agentId",
  "bindings[].match",
  "bindings[].match.channel",
  "bindings[].match.accountId",
  "bindings[].match.peer",
  "bindings[].match.peer.kind",
  "bindings[].match.peer.id",
  "bindings[].match.guildId",
  "bindings[].match.teamId",
  "bindings[].match.roles",
  "broadcast",
  "broadcast.strategy",
  "broadcast.*",
  "commands",
  "commands.allowFrom",
  "hooks",
  "hooks.enabled",
  "hooks.path",
  "hooks.token",
  "hooks.defaultSessionKey",
  "hooks.allowRequestSessionKey",
  "hooks.allowedSessionKeyPrefixes",
  "hooks.allowedAgentIds",
  "hooks.maxBodyBytes",
  "hooks.transformsDir",
  "hooks.mappings",
  "hooks.mappings[].action",
  "hooks.mappings[].wakeMode",
  "hooks.mappings[].channel",
  "hooks.mappings[].transform.module",
  "hooks.gmail",
  "hooks.gmail.pushToken",
  "hooks.gmail.tailscale.mode",
  "hooks.gmail.thinking",
  "hooks.internal",
  "hooks.internal.load.extraDirs",
  "messages",
  "messages.messagePrefix",
  "messages.visibleReplies",
  "messages.responsePrefix",
  "messages.groupChat",
  "messages.groupChat.mentionPatterns",
  "messages.groupChat.historyLimit",
  "messages.groupChat.visibleReplies",
  "messages.queue",
  "messages.queue.mode",
  "messages.queue.byChannel",
  "messages.queue.debounceMs",
  "messages.queue.debounceMsByChannel",
  "messages.queue.cap",
  "messages.queue.drop",
  "messages.inbound",
  "messages.inbound.byChannel",
  "messages.removeAckAfterReply",
  "messages.tts",
  "channels",
  "channels.defaults",
  "channels.defaults.groupPolicy",
  "channels.defaults.contextVisibility",
  "channels.defaults.heartbeat",
  "channels.defaults.heartbeat.showOk",
  "channels.defaults.heartbeat.showAlerts",
  "channels.defaults.heartbeat.useIndicator",
  "gateway",
  "gateway.mode",
  "gateway.bind",
  "gateway.auth.mode",
  "gateway.tailscale.mode",
  "gateway.tools.allow",
  "gateway.tools.deny",
  "gateway.tls.enabled",
  "gateway.tls.autoGenerate",
  "gateway.http",
  "gateway.http.endpoints",
  "browser",
  "browser.enabled",
  "browser.cdpUrl",
  "browser.headless",
  "browser.noSandbox",
  "browser.profiles",
  "browser.profiles.*.userDataDir",
  "browser.profiles.*.driver",
  "browser.profiles.*.attachOnly",
  "tools",
  "tools.allow",
  "tools.deny",
  "tools.exec",
  "tools.exec.host",
  "tools.exec.security",
  "tools.exec.ask",
  "tools.exec.node",
  "tools.agentToAgent.enabled",
  "tools.elevated.enabled",
  "tools.elevated.allowFrom",
  "tools.subagents.tools",
  "tools.sandbox.tools",
  "web",
  "web.enabled",
  "web.heartbeatSeconds",
  "web.reconnect",
  "web.reconnect.initialMs",
  "web.reconnect.maxMs",
  "web.reconnect.factor",
  "web.reconnect.jitter",
  "web.reconnect.maxAttempts",
  "web.whatsapp",
  "web.whatsapp.keepAliveIntervalMs",
  "web.whatsapp.connectTimeoutMs",
  "web.whatsapp.defaultQueryTimeoutMs",
  "discovery",
  "discovery.wideArea.domain",
  "discovery.wideArea.enabled",
  "discovery.mdns",
  "discovery.mdns.mode",
  "gateway.controlUi.embedSandbox",
  "canvasHost",
  "canvasHost.enabled",
  "canvasHost.root",
  "canvasHost.port",
  "canvasHost.liveReload",
  "talk",
  "talk.interruptOnSpeech",
  "talk.silenceTimeoutMs",
  "meta",
  "env",
  "env.shellEnv",
  "env.shellEnv.enabled",
  "env.shellEnv.timeoutMs",
  "env.vars",
  "wizard",
  "wizard.lastRunAt",
  "wizard.lastRunVersion",
  "wizard.lastRunCommit",
  "wizard.lastRunCommand",
  "wizard.lastRunMode",
  "diagnostics",
  "diagnostics.otel",
  "diagnostics.cacheTrace",
  "logging",
  "logging.level",
  "logging.file",
  "logging.consoleLevel",
  "logging.consoleStyle",
  "logging.redactSensitive",
  "logging.redactPatterns",
  "update",
  "ui",
  "ui.assistant",
  "plugins",
  "plugins.enabled",
  "plugins.allow",
  "plugins.deny",
  "plugins.load",
  "plugins.load.paths",
  "plugins.slots",
  "plugins.entries",
  "plugins.entries.*.enabled",
  "plugins.entries.*.hooks",
  "plugins.entries.*.hooks.allowPromptInjection",
  "plugins.entries.*.hooks.allowConversationAccess",
  "plugins.entries.*.hooks.timeoutMs",
  "plugins.entries.*.hooks.timeouts",
  "plugins.entries.*.subagent",
  "plugins.entries.*.subagent.allowModelOverride",
  "plugins.entries.*.subagent.allowedModels",
  "plugins.entries.*.apiKey",
  "plugins.entries.*.env",
  "plugins.entries.*.config",
  "auth",
  "auth.cooldowns",
  "models",
  "models.providers",
  "models.providers.*.baseUrl",
  "models.providers.*.apiKey",
  "models.providers.*.api",
  "models.providers.*.contextWindow",
  "models.providers.*.contextTokens",
  "models.providers.*.maxTokens",
  "models.providers.*.headers",
  "models.providers.*.models",
  "agents",
  "agents.defaults",
  "agents.list",
  "agents.defaults.compaction",
  "agents.defaults.compaction.mode",
  "agents.defaults.compaction.provider",
  "agents.defaults.compaction.reserveTokens",
  "agents.defaults.compaction.keepRecentTokens",
  "agents.defaults.compaction.reserveTokensFloor",
  "agents.defaults.compaction.maxHistoryShare",
  "agents.defaults.compaction.identifierPolicy",
  "agents.defaults.compaction.identifierInstructions",
  "agents.defaults.compaction.recentTurnsPreserve",
  "agents.defaults.compaction.qualityGuard",
  "agents.defaults.compaction.qualityGuard.enabled",
  "agents.defaults.compaction.qualityGuard.maxRetries",
  "agents.defaults.compaction.midTurnPrecheck",
  "agents.defaults.compaction.midTurnPrecheck.enabled",
  "agents.defaults.compaction.postCompactionSections",
  "agents.defaults.compaction.timeoutSeconds",
  "agents.defaults.compaction.model",
  "agents.defaults.compaction.truncateAfterCompaction",
  "agents.defaults.compaction.maxActiveTranscriptBytes",
  "agents.defaults.compaction.memoryFlush",
  "agents.defaults.compaction.memoryFlush.enabled",
  "agents.defaults.compaction.memoryFlush.model",
  "agents.defaults.compaction.memoryFlush.softThresholdTokens",
  "agents.defaults.compaction.memoryFlush.prompt",
  "agents.defaults.compaction.memoryFlush.systemPrompt",
] as const;

const ENUM_EXPECTATIONS: Record<string, string[]> = {
  "memory.citations": ['"auto"', '"on"', '"off"'],
  "memory.backend": ['"builtin"', '"qmd"'],
  "memory.qmd.searchMode": ['"query"', '"search"', '"vsearch"'],
  "models.mode": ['"merge"', '"replace"'],
  "models.providers.*.auth": ['"api-key"', '"token"', '"oauth"', '"aws-sdk"'],
  "gateway.reload.mode": ['"off"', '"restart"', '"hot"', '"hybrid"'],
  "approvals.exec.mode": ['"session"', '"targets"', '"both"'],
  "bindings[].match.peer.kind": ['"direct"', '"group"', '"channel"', '"dm"'],
  "broadcast.strategy": ['"parallel"', '"sequential"'],
  "hooks.mappings[].action": ['"wake"', '"agent"'],
  "hooks.mappings[].wakeMode": ['"now"', '"next-heartbeat"'],
  "hooks.gmail.tailscale.mode": ['"off"', '"serve"', '"funnel"'],
  "hooks.gmail.thinking": ['"off"', '"minimal"', '"low"', '"medium"', '"high"'],
  "messages.queue.mode": [
    '"steer"',
    '"followup"',
    '"collect"',
    '"steer-backlog"',
    '"steer+backlog"',
    '"queue"',
    '"interrupt"',
  ],
  "messages.queue.drop": ['"old"', '"new"', '"summarize"'],
  "channels.defaults.groupPolicy": ['"open"', '"disabled"', '"allowlist"'],
  "channels.defaults.contextVisibility": ['"all"', '"allowlist"', '"allowlist_quote"'],
  "gateway.mode": ['"local"', '"remote"'],
  "gateway.bind": ['"auto"', '"lan"', '"loopback"', '"custom"', '"tailnet"'],
  "gateway.auth.mode": ['"none"', '"token"', '"password"', '"trusted-proxy"'],
  "gateway.tailscale.mode": ['"off"', '"serve"', '"funnel"'],
  "browser.profiles.*.driver": ['"openclaw"', '"clawd"', '"existing-session"'],
  "discovery.mdns.mode": ['"off"', '"minimal"', '"full"'],
  "wizard.lastRunMode": ['"local"', '"remote"'],
  "diagnostics.otel.protocol": ['"http/protobuf"', '"grpc"'],
  "logging.level": ['"silent"', '"fatal"', '"error"', '"warn"', '"info"', '"debug"', '"trace"'],
  "logging.consoleLevel": [
    '"silent"',
    '"fatal"',
    '"error"',
    '"warn"',
    '"info"',
    '"debug"',
    '"trace"',
  ],
  "logging.consoleStyle": ['"pretty"', '"compact"', '"json"'],
  "logging.redactSensitive": ['"off"', '"tools"'],
  "cli.banner.taglineMode": ['"random"', '"default"', '"off"'],
  "update.channel": ['"stable"', '"beta"', '"dev"'],
  "agents.defaults.compaction.mode": ['"default"', '"safeguard"'],
  "agents.defaults.compaction.identifierPolicy": ['"strict"', '"off"', '"custom"'],
};

const TOOLS_HOOKS_TARGET_KEYS = [
  "hooks.gmail.account",
  "hooks.gmail.allowUnsafeExternalContent",
  "hooks.gmail.hookUrl",
  "hooks.gmail.includeBody",
  "hooks.gmail.label",
  "hooks.gmail.model",
  "hooks.gmail.serve",
  "hooks.gmail.subscription",
  "hooks.gmail.tailscale",
  "hooks.gmail.topic",
  "hooks.internal.entries",
  "hooks.internal.installs",
  "hooks.internal.load",
  "hooks.mappings[].allowUnsafeExternalContent",
  "hooks.mappings[].deliver",
  "hooks.mappings[].id",
  "hooks.mappings[].match",
  "hooks.mappings[].messageTemplate",
  "hooks.mappings[].model",
  "hooks.mappings[].name",
  "hooks.mappings[].textTemplate",
  "hooks.mappings[].thinking",
  "hooks.mappings[].transform",
  "tools.alsoAllow",
  "tools.byProvider",
  "tools.exec.approvalRunningNoticeMs",
  "tools.exec.strictInlineEval",
  "tools.links.enabled",
  "tools.links.maxLinks",
  "tools.links.models",
  "tools.links.scope",
  "tools.links.timeoutSeconds",
  ...MEDIA_AUDIO_FIELD_KEYS,
  "tools.media.concurrency",
  "tools.media.image.attachments",
  "tools.media.image.enabled",
  "tools.media.image.maxBytes",
  "tools.media.image.maxChars",
  "tools.media.image.models",
  "tools.media.image.prompt",
  "tools.media.image.scope",
  "tools.media.image.timeoutSeconds",
  "tools.media.models",
  "tools.media.video.attachments",
  "tools.media.video.enabled",
  "tools.media.video.maxBytes",
  "tools.media.video.maxChars",
  "tools.media.video.models",
  "tools.media.video.prompt",
  "tools.media.video.scope",
  "tools.media.video.timeoutSeconds",
  "tools.profile",
] as const;

const CHANNELS_AGENTS_TARGET_KEYS = [
  "agents.defaults.memorySearch.chunking.overlap",
  "agents.defaults.memorySearch.chunking.tokens",
  "agents.defaults.memorySearch.enabled",
  "agents.defaults.memorySearch.model",
  "agents.defaults.memorySearch.query.maxResults",
  "agents.defaults.memorySearch.query.minScore",
  "agents.defaults.memorySearch.sync.onSessionStart",
  "agents.defaults.memorySearch.sync.watchDebounceMs",
  "agents.defaults.workspace",
  "agents.list[].tools.alsoAllow",
  "agents.list[].tools.byProvider",
  "agents.list[].tools.profile",
  "channels.mattermost",
] as const;

const FINAL_BACKLOG_TARGET_KEYS = [
  "browser.evaluateEnabled",
  "browser.remoteCdpHandshakeTimeoutMs",
  "browser.remoteCdpTimeoutMs",
  "browser.snapshotDefaults",
  "browser.snapshotDefaults.mode",
  "browser.ssrfPolicy",
  "browser.ssrfPolicy.dangerouslyAllowPrivateNetwork",
  "browser.ssrfPolicy.allowedHostnames",
  "browser.ssrfPolicy.hostnameAllowlist",
  "diagnostics.enabled",
  "diagnostics.otel.enabled",
  "diagnostics.otel.endpoint",
  "diagnostics.otel.flushIntervalMs",
  "diagnostics.otel.headers",
  "diagnostics.otel.logsEndpoint",
  "diagnostics.otel.logs",
  "diagnostics.otel.metricsEndpoint",
  "diagnostics.otel.metrics",
  "diagnostics.otel.sampleRate",
  "diagnostics.otel.serviceName",
  "diagnostics.otel.tracesEndpoint",
  "diagnostics.otel.traces",
  "gateway.remote.password",
  "gateway.remote.token",
  "skills.load.watch",
  "skills.load.watchDebounceMs",
  "ui.assistant.avatar",
  "ui.assistant.name",
  "ui.seamColor",
] as const;

describe("config help copy quality", () => {
  function expectOperationalGuidance(
    keys: readonly string[],
    guidancePattern: RegExp,
    minLength = 80,
  ) {
    for (const key of keys) {
      const help = FIELD_HELP[key];
      expect(help, `missing help for ${key}`).toBeDefined();
      expect(help.length, `help too short for ${key}`).toBeGreaterThanOrEqual(minLength);
      expect(
        guidancePattern.test(help),
        `help should include operational guidance for ${key}`,
      ).toBe(true);
    }
  }

  it("keeps root section labels and help complete", () => {
    for (const key of ROOT_SECTIONS) {
      expect(FIELD_LABELS[key], `missing root label for ${key}`).toBeDefined();
      expect(FIELD_HELP[key], `missing root help for ${key}`).toBeDefined();
    }
  });

  it("keeps labels in parity for all help keys", () => {
    for (const key of Object.keys(FIELD_HELP)) {
      expect(FIELD_LABELS[key], `missing label for help key ${key}`).toBeDefined();
    }
  });

  it("covers the target confusing fields with non-trivial explanations", () => {
    expectOperationalGuidance(
      TARGET_KEYS,
      /(default|keep|use|enable|disable|controls|selects|sets|defines)/i,
    );
  });

  it("covers tools/hooks help keys with non-trivial operational guidance", () => {
    expectOperationalGuidance(
      TOOLS_HOOKS_TARGET_KEYS,
      /(default|keep|use|enable|disable|controls|set|sets|increase|lower|prefer|tune|avoid|choose|when)/i,
    );
  });

  it("covers channels/agents help keys with non-trivial operational guidance", () => {
    expectOperationalGuidance(
      CHANNELS_AGENTS_TARGET_KEYS,
      /(default|keep|use|enable|disable|controls|set|sets|increase|lower|prefer|tune|avoid|choose|when)/i,
    );
  });

  it("covers final backlog help keys with non-trivial operational guidance", () => {
    expectOperationalGuidance(
      FINAL_BACKLOG_TARGET_KEYS,
      /(default|keep|use|enable|disable|controls|set|sets|increase|lower|prefer|tune|avoid|choose|when)/i,
    );
  });

  it("documents option behavior for enum-style fields", () => {
    for (const [key, options] of Object.entries(ENUM_EXPECTATIONS)) {
      const help = FIELD_HELP[key];
      expect(help, `missing help for enum key ${key}`).toBeDefined();
      for (const token of options) {
        expect(help.includes(token), `missing option ${token} in ${key}`).toBe(true);
      }
    }
  });

  it("explains memory citations mode semantics", () => {
    const help = FIELD_HELP["memory.citations"];
    expect(help.includes('"auto"')).toBe(true);
    expect(help.includes('"on"')).toBe(true);
    expect(help.includes('"off"')).toBe(true);
    expect(/always|always shows/i.test(help)).toBe(true);
    expect(/hides|hide/i.test(help)).toBe(true);
  });

  it("includes concrete examples on path and interval fields", () => {
    expect(FIELD_HELP["memory.qmd.paths.pattern"].includes("**/*.md")).toBe(true);
    expect(FIELD_HELP["memory.qmd.update.interval"].includes("5m")).toBe(true);
    expect(FIELD_HELP["memory.qmd.update.embedInterval"].includes("60m")).toBe(true);
    expect(FIELD_HELP["agents.defaults.memorySearch.store.path"]).toContain(
      "~/.openclaw/memory/{agentId}.sqlite",
    );
  });

  it("documents cron deprecation, migration, and retention formats", () => {
    const legacy = FIELD_HELP["cron.webhook"];
    expect(/deprecated|legacy/i.test(legacy)).toBe(true);
    expect(legacy.includes('delivery.mode="webhook"')).toBe(true);
    expect(legacy.includes("delivery.to")).toBe(true);

    const retention = FIELD_HELP["cron.sessionRetention"];
    expect(retention.includes("24h")).toBe(true);
    expect(retention.includes("7d")).toBe(true);
    expect(retention.includes("1h30m")).toBe(true);
    expect(/false/i.test(retention)).toBe(true);

    const token = FIELD_HELP["cron.webhookToken"];
    expect(/token|bearer/i.test(token)).toBe(true);
    expect(/secret|env|rotate/i.test(token)).toBe(true);
  });

  it("documents session send-policy examples and prefix semantics", () => {
    const rules = FIELD_HELP["session.sendPolicy.rules"];
    expect(rules.includes("{ action:")).toBe(true);
    expect(rules.includes('"deny"')).toBe(true);
    expect(rules.includes('"discord"')).toBe(true);

    const keyPrefix = FIELD_HELP["session.sendPolicy.rules[].match.keyPrefix"];
    expect(/normalized/i.test(keyPrefix)).toBe(true);

    const rawKeyPrefix = FIELD_HELP["session.sendPolicy.rules[].match.rawKeyPrefix"];
    expect(/raw|unnormalized/i.test(rawKeyPrefix)).toBe(true);
  });

  it("documents session write-lock acquire timeout defaults", () => {
    const acquireTimeout = FIELD_HELP["session.writeLock.acquireTimeoutMs"];
    expect(acquireTimeout.includes("60000")).toBe(true);
    expect(/transcript|lock/i.test(acquireTimeout)).toBe(true);
  });

  it("documents session maintenance duration/size examples and deprecations", () => {
    const pruneAfter = FIELD_HELP["session.maintenance.pruneAfter"];
    expect(pruneAfter.includes("30d")).toBe(true);
    expect(pruneAfter.includes("12h")).toBe(true);

    const rotate = FIELD_HELP["session.maintenance.rotateBytes"];
    expect(/deprecated/i.test(rotate)).toBe(true);
    expect(rotate.includes("doctor --fix")).toBe(true);

    const deprecated = FIELD_HELP["session.maintenance.pruneDays"];
    expect(/deprecated/i.test(deprecated)).toBe(true);
    expect(deprecated.includes("session.maintenance.pruneAfter")).toBe(true);

    const resetRetention = FIELD_HELP["session.maintenance.resetArchiveRetention"];
    expect(resetRetention.includes(".reset.")).toBe(true);
    expect(/false/i.test(resetRetention)).toBe(true);

    const maxDisk = FIELD_HELP["session.maintenance.maxDiskBytes"];
    expect(maxDisk.includes("500mb")).toBe(true);

    const highWater = FIELD_HELP["session.maintenance.highWaterBytes"];
    expect(highWater.includes("80%")).toBe(true);
  });

  it("documents cron run-log retention controls", () => {
    const runLog = FIELD_HELP["cron.runLog"];
    expect(runLog.includes("cron/runs")).toBe(true);

    const maxBytes = FIELD_HELP["cron.runLog.maxBytes"];
    expect(maxBytes.includes("2mb")).toBe(true);

    const keepLines = FIELD_HELP["cron.runLog.keepLines"];
    expect(keepLines.includes("2000")).toBe(true);
  });

  it("documents approvals filters and target semantics", () => {
    const sessionFilter = FIELD_HELP["approvals.exec.sessionFilter"];
    expect(/substring|regex/i.test(sessionFilter)).toBe(true);
    expect(sessionFilter.includes("discord:")).toBe(true);
    expect(sessionFilter.includes("^agent:ops:")).toBe(true);

    const agentFilter = FIELD_HELP["approvals.exec.agentFilter"];
    expect(agentFilter.includes("primary")).toBe(true);
    expect(agentFilter.includes("ops-agent")).toBe(true);

    const targetTo = FIELD_HELP["approvals.exec.targets[].to"];
    expect(/channel ID|user ID|thread root/i.test(targetTo)).toBe(true);
    expect(/differs|per provider/i.test(targetTo)).toBe(true);
  });

  it("documents broadcast and audio command examples", () => {
    const audioCmd = FIELD_HELP["audio.transcription.command"];
    expect(audioCmd.includes("whisper-cli")).toBe(true);
    expect(audioCmd.includes("{input}")).toBe(true);

    const broadcastMap = FIELD_HELP["broadcast.*"];
    expect(/source peer ID/i.test(broadcastMap)).toBe(true);
    expect(/destination peer IDs/i.test(broadcastMap)).toBe(true);
  });

  it("documents hook transform safety and queue behavior options", () => {
    const transformModule = FIELD_HELP["hooks.mappings[].transform.module"];
    expect(/relative/i.test(transformModule)).toBe(true);
    expect(/path traversal|reviewed|controlled/i.test(transformModule)).toBe(true);

    const queueMode = FIELD_HELP["messages.queue.mode"];
    expect(queueMode.includes('"interrupt"')).toBe(true);
    expect(queueMode.includes('"steer+backlog"')).toBe(true);
  });

  it("documents gateway bind modes and web reconnect semantics", () => {
    const bind = FIELD_HELP["gateway.bind"];
    expect(bind.includes('"loopback"')).toBe(true);
    expect(bind.includes('"tailnet"')).toBe(true);

    const reconnect = FIELD_HELP["web.reconnect.maxAttempts"];
    expect(/0 means no retries|no retries/i.test(reconnect)).toBe(true);
    expect(/failure sequence|retry/i.test(reconnect)).toBe(true);
  });

  it("documents metadata/admin semantics for logging, wizard, and plugins", () => {
    const wizardMode = FIELD_HELP["wizard.lastRunMode"];
    expect(wizardMode.includes('"local"')).toBe(true);
    expect(wizardMode.includes('"remote"')).toBe(true);

    const consoleStyle = FIELD_HELP["logging.consoleStyle"];
    expect(consoleStyle.includes('"pretty"')).toBe(true);
    expect(consoleStyle.includes('"compact"')).toBe(true);
    expect(consoleStyle.includes('"json"')).toBe(true);

    const pluginApiKey = FIELD_HELP["plugins.entries.*.apiKey"];
    expect(/secret|env|credential/i.test(pluginApiKey)).toBe(true);

    const pluginEnv = FIELD_HELP["plugins.entries.*.env"];
    expect(/scope|plugin|environment/i.test(pluginEnv)).toBe(true);

    const pluginPromptPolicy = FIELD_HELP["plugins.entries.*.hooks.allowPromptInjection"];
    expect(pluginPromptPolicy.includes("before_prompt_build")).toBe(true);
    expect(pluginPromptPolicy.includes("before_agent_start")).toBe(true);
    expect(pluginPromptPolicy.includes("modelOverride")).toBe(true);

    const pluginConversationPolicy = FIELD_HELP["plugins.entries.*.hooks.allowConversationAccess"];
    expect(pluginConversationPolicy.includes("llm_input")).toBe(true);
    expect(pluginConversationPolicy.includes("llm_output")).toBe(true);
    expect(pluginConversationPolicy.includes("before_agent_finalize")).toBe(true);

    const pluginHookTimeout = FIELD_HELP["plugins.entries.*.hooks.timeoutMs"];
    expect(pluginHookTimeout.includes("typed hooks")).toBe(true);
    expect(pluginHookTimeout.includes("hooks.timeouts")).toBe(true);

    const pluginHookTimeouts = FIELD_HELP["plugins.entries.*.hooks.timeouts"];
    expect(pluginHookTimeouts.includes("before_prompt_build")).toBe(true);
    expect(pluginHookTimeouts.includes("agent_end")).toBe(true);
    expect(pluginConversationPolicy.includes("agent_end")).toBe(true);
  });

  it("documents auth/model root semantics and provider secret handling", () => {
    const providerKey = FIELD_HELP["models.providers.*.apiKey"];
    expect(/secret|env|credential/i.test(providerKey)).toBe(true);
    const modelsMode = FIELD_HELP["models.mode"];
    expect(modelsMode.includes("SecretRef-managed")).toBe(true);
    expect(modelsMode.includes("preserve")).toBe(true);

    const authCooldowns = FIELD_HELP["auth.cooldowns"];
    expect(/cooldown|backoff|retry/i.test(authCooldowns)).toBe(true);
  });

  it("documents agent compaction safeguards and memory flush behavior", () => {
    const mode = FIELD_HELP["agents.defaults.compaction.mode"];
    expect(mode.includes('"default"')).toBe(true);
    expect(mode.includes('"safeguard"')).toBe(true);

    const historyShare = FIELD_HELP["agents.defaults.compaction.maxHistoryShare"];
    expect(/0\\.1-0\\.9|fraction|share/i.test(historyShare)).toBe(true);

    const identifierPolicy = FIELD_HELP["agents.defaults.compaction.identifierPolicy"];
    expect(identifierPolicy.includes('"strict"')).toBe(true);
    expect(identifierPolicy.includes('"off"')).toBe(true);
    expect(identifierPolicy.includes('"custom"')).toBe(true);

    const recentTurnsPreserve = FIELD_HELP["agents.defaults.compaction.recentTurnsPreserve"];
    expect(/recent.*turn|verbatim/i.test(recentTurnsPreserve)).toBe(true);
    expect(/default:\s*3/i.test(recentTurnsPreserve)).toBe(true);

    const midTurnPrecheck = FIELD_HELP["agents.defaults.compaction.midTurnPrecheck.enabled"];
    expect(/mid-turn|tool loop|default:\s*false/i.test(midTurnPrecheck)).toBe(true);

    const postCompactionSections = FIELD_HELP["agents.defaults.compaction.postCompactionSections"];
    expect(/Session Startup|Red Lines/i.test(postCompactionSections)).toBe(true);
    expect(/Every Session|Safety/i.test(postCompactionSections)).toBe(true);
    expect(/\[\]|disable/i.test(postCompactionSections)).toBe(true);

    const compactionModel = FIELD_HELP["agents.defaults.compaction.model"];
    expect(/provider\/model|different model|primary agent model/i.test(compactionModel)).toBe(true);

    const transcriptBytes = FIELD_HELP["agents.defaults.compaction.maxActiveTranscriptBytes"];
    expect(/transcript|bytes|compaction/i.test(transcriptBytes)).toBe(true);
    expect(/never splits raw transcript bytes/i.test(transcriptBytes)).toBe(true);

    const flush = FIELD_HELP["agents.defaults.compaction.memoryFlush.enabled"];
    expect(/pre-compaction|memory flush|token/i.test(flush)).toBe(true);
  });

  it("documents agent startup-context preload controls", () => {
    const startupContext = FIELD_HELP["agents.defaults.startupContext"];
    expect(/first-turn|\/new|\/reset|daily memory/i.test(startupContext)).toBe(true);

    const applyOn = FIELD_HELP["agents.defaults.startupContext.applyOn"];
    expect(applyOn.includes('"new"')).toBe(true);
    expect(applyOn.includes('"reset"')).toBe(true);

    const dailyMemoryDays = FIELD_HELP["agents.defaults.startupContext.dailyMemoryDays"];
    expect(/today \+ yesterday|default:\s*2/i.test(dailyMemoryDays)).toBe(true);
  });
});
