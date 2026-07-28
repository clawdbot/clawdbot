// Verifies schema-only config keys stay outside the canonical config contract.
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

function expectUnknownKey(params: { config: Record<string, unknown>; path: string; key: string }) {
  const result = validateConfigObjectRaw(params.config, { validateBundledChannels: true });
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  const issue = result.issues.find(
    (candidate) =>
      candidate.path === params.path &&
      (candidate.message.includes(`Unrecognized key: "${params.key}"`) ||
        candidate.message.includes(`must not have additional properties: "${params.key}"`)),
  );
  if (!issue) {
    throw new Error(`Expected unknown ${params.path}.${params.key} validation issue`);
  }
}

function configWithPath(path: string): Record<string, unknown> {
  const segments = path.split(".");
  const config = segments.reduceRight<unknown>(
    (value, segment) => (segment === "0" ? [value] : { [segment]: value }),
    1,
  ) as Record<string, unknown>;
  return config;
}

describe("dead config keys", () => {
  it.each([
    "systemAgent",
    "meta.lastTouchedAt",
    "marketplaces",
    "cli",
    "commitments",
    "auth.cooldowns",
    "secrets.resolution",
    "browser.remoteCdpTimeoutMs",
    "browser.remoteCdpHandshakeTimeoutMs",
    "browser.localLaunchTimeoutMs",
    "browser.localCdpReadyTimeoutMs",
    "browser.actionTimeoutMs",
    "browser.cdpPortRangeStart",
    "browser.tabCleanup.idleMinutes",
    "browser.tabCleanup.maxTabsPerSession",
    "browser.tabCleanup.sweepMinutes",
    "browser.color",
    "browser.profiles.chrome.color",
    "browser.ssrfPolicy.hostnameAllowlist",
    "agents.defaults.pdfMaxBytesMb",
    "agents.defaults.imageGenerationModel",
    "agents.defaults.videoGenerationModel",
    "agents.defaults.musicGenerationModel",
    "agents.defaults.promptOverlays",
    "agents.defaults.cliBackends",
    "agents.defaults.heartbeat.ackMaxChars",
    "agents.defaults.heartbeat.includeReasoning",
    "agents.defaults.heartbeat.includeSystemPromptSection",
    "agents.defaults.heartbeat.skipWhenBusy",
    "agents.defaults.heartbeat.suppressToolErrorWarnings",
    "agents.entries.test.groupChat.visibleReplies",
    "agents.defaults.envelopeTimestamp",
    "agents.defaults.envelopeElapsed",
    "agents.defaults.envelopeTimezone",
    "agents.defaults.timeFormat",
    "agents.defaults.bootstrapPromptTruncationWarning",
    "agents.defaults.mediaGenerationAutoProviderFallback",
    "tools.exec.timeoutSec",
    "agents.entries.test.tools.exec.timeoutSec",
    "agents.defaults.sandbox.browser.enableNoVnc",
    "media",
    "audit",
    "attachments.preserveFilenames",
    "diagnostics.cacheTrace.filePath",
    "messages.removeAckAfterReply",
    "messages.statusReactions.emojis",
    "commands.ownerDisplay",
    "commands.ownerDisplaySecret",
    "gateway.nodes.skills",
    "gateway.nodes.allowCommands",
    "gateway.nodes.denyCommands",
    "gateway.controlUi.chatMessageMaxWidth",
    "ui.prefs.chatMessageMaxWidth",
    "ui.prefs.textScale",
    "ui.prefs.sidebarLiveActivity",
    "cron.failureDestination",
    "channels.defaults.heartbeat",
    "tools.loopDetection.historySize",
    "tools.loopDetection.warningThreshold",
    "tools.loopDetection.detectors",
    "tools.loopDetection.postCompactionGuard",
    "tools.media.image.models",
    "tools.media.audio.models",
    "tools.media.video.models",
    "agents.defaults.memorySearch",
    "agents.entries.test.memorySearch",
    "messages.tts",
    "agents.defaults.compaction.reserveTokens",
    "agents.defaults.compaction.reserveTokensFloor",
    "agents.defaults.compaction.maxHistoryShare",
    "agents.defaults.contextPruning.keepLastAssistants",
    "agents.defaults.contextPruning.softTrimRatio",
    "agents.defaults.contextPruning.softTrim",
    "memory.search.chunking",
    "memory.search.remote.nonBatchConcurrency",
    "memory.search.remote.batch.wait",
    "memory.search.remote.batch.concurrency",
    "memory.search.remote.batch.pollIntervalMs",
    "memory.search.remote.batch.timeoutMinutes",
    "memory.search.local.contextSize",
    "memory.search.local.modelCacheDir",
    "memory.search.store.driver",
    "memory.search.sync",
    "memory.search.query.hybrid",
    "memory.qmd.mcporter",
    "memory.qmd.update",
    "memory.search.cache.maxEntries",
    "agents.defaults.runRetries",
    "agents.entries.test.memory.search.chunking",
    "agents.entries.test.runRetries",
    "agents.entries.test.typingIntervalSeconds",
    "agents.defaults.contextLimits.memoryGetDefaultLines",
    "agents.defaults.contextLimits.toolResultMaxChars",
    "agents.entries.test.contextLimits.memoryGetDefaultLines",
    "agents.entries.test.contextLimits.toolResultMaxChars",
    "skills.load.watchDebounceMs",
    "gateway.handshakeTimeoutMs",
    "gateway.channelHealthCheckMinutes",
    "gateway.channelStaleEventThresholdMinutes",
    "gateway.channelMaxRestartsPerHour",
    "gateway.reload.debounceMs",
    "gateway.reload.deferralTimeoutMs",
    "gateway.http.endpoints.chatCompletions.maxBodyBytes",
    "gateway.http.endpoints.chatCompletions.maxImageParts",
    "gateway.http.endpoints.chatCompletions.maxTotalImageBytes",
    "gateway.http.endpoints.responses.maxBodyBytes",
    "session.typingIntervalSeconds",
    "session.typingMode",
    "session.writeLock",
    "session.agentToAgent",
    "cron.maxConcurrentRuns",
    "cron.store",
    "cron.triggers.minIntervalMs",
    "cron.retry",
    "diagnostics.stuckSessionWarnMs",
    "diagnostics.stuckSessionAbortMs",
    "diagnostics.memoryPressureSnapshot",
    "web",
    "messages.queue.debounceMs",
    "messages.statusReactions.timing",
    "acp.stream.coalesceIdleMs",
    "acp.stream.maxChunkChars",
    "acp.stream.maxOutputChars",
    "acp.stream.maxSessionUpdateChars",
    "acp.stream.hiddenBoundarySeparator",
    "acp.maxConcurrentSessions",
    "acp.runtime.ttlMinutes",
    "mcp.sessionIdleTtlMs",
    "worktrees",
    "transcripts.maxUtterances",
    "hooks.maxBodyBytes",
    "update.auto.stableDelayHours",
    "update.auto.stableJitterHours",
    "update.auto.betaCheckIntervalHours",
    "channels.telegram.timeoutSeconds",
    "channels.telegram.mediaGroupFlushMs",
    "channels.telegram.pollingStallThresholdMs",
    "channels.telegram.retry",
    "channels.telegram.errorCooldownMs",
    "channels.telegram.accounts.work.timeoutSeconds",
    "channels.telegram.accounts.work.retry",
    "channels.whatsapp.debounceMs",
    "channels.whatsapp.accounts.work.debounceMs",
    "channels.telegram.groups.-100.errorCooldownMs",
    "channels.telegram.groups.-100.topics.1.errorCooldownMs",
    "channels.discord.gatewayInfoTimeoutMs",
    "channels.discord.gatewayReadyTimeoutMs",
    "channels.discord.gatewayRuntimeReadyTimeoutMs",
    "channels.discord.eventQueue",
    "channels.discord.retry",
    "channels.discord.accounts.work.eventQueue",
    "channels.discord.accounts.work.retry",
    "channels.clickclack.timeoutSeconds",
    "channels.clickclack.accounts.work.timeoutSeconds",
    "channels.signal.httpHost",
    "channels.signal.httpPort",
    "channels.googlechat.serviceAccountRef",
    "hooks.internal.installs",
    "plugins.bundledDiscovery",
    "tts.prefsPath",
    "tts.personas.test.prompt",
    "agents.defaults.compaction.customInstructions",
    "agents.defaults.compaction.identifierInstructions",
    "agents.defaults.compaction.memoryFlush.prompt",
    "agents.defaults.compaction.memoryFlush.systemPrompt",
    "logging.redactSensitive",
    "commands.useAccessGroups",
    "gateway.controlUi.allowInsecureAuth",
    "discovery.wideArea.enabled",
    "cloudWorkers.profiles.default.lifetime",
    "mcp.servers.docs.workingDirectory",
    "nodeHost.mcp.servers.docs.workingDirectory",
    "models.providers.custom.models.0.compat.requiresMistralToolIds",
    "models.providers.custom.models.0.compat.nativeWebSearchTool",
  ] as const)("rejects retired tuning knob %s", (fullPath) => {
    const segments = fullPath.split(".");
    const key = segments.pop() ?? "";
    expectUnknownKey({
      config: configWithPath(fullPath),
      path: segments.join("."),
      key,
    });
  });

  it.each([
    [
      "file provider insecure-path bypass",
      {
        secrets: {
          providers: {
            legacy: {
              source: "file",
              path: "/tmp/openclaw-secret",
              allowInsecurePath: true,
            },
          },
        },
      },
    ],
    [
      "exec provider symlink bypass",
      {
        secrets: {
          providers: {
            legacy: {
              source: "exec",
              command: "/bin/echo",
              allowSymlinkCommand: true,
            },
          },
        },
      },
    ],
  ] as const)("rejects retired secret provider %s", (_name, config) => {
    const result = validateConfigObjectRaw(config, { validateBundledChannels: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "secrets.providers.legacy",
        message: "Invalid input",
      });
    }
  });

  it.each([
    ["Discord root", "discord", { dm: { policy: "pairing" } }, "channels.discord.dm", "policy"],
    [
      "Discord account",
      "discord",
      { accounts: { work: { dm: { allowFrom: ["1"] } } } },
      "channels.discord.accounts.work.dm",
      "allowFrom",
    ],
    ["Slack root", "slack", { dm: { policy: "pairing" } }, "channels.slack.dm", "policy"],
    [
      "Slack account",
      "slack",
      { accounts: { work: { dm: { allowFrom: ["U1"] } } } },
      "channels.slack.accounts.work.dm",
      "allowFrom",
    ],
    [
      "Google Chat root",
      "googlechat",
      { dm: { policy: "pairing" } },
      "channels.googlechat.dm",
      "policy",
    ],
    [
      "Google Chat account",
      "googlechat",
      { accounts: { work: { dm: { allowFrom: ["users/1"] } } } },
      "channels.googlechat.accounts.work.dm",
      "allowFrom",
    ],
  ] as const)("rejects legacy nested DM aliases for %s", (_name, channel, entry, path, key) => {
    expectUnknownKey({ config: { channels: { [channel]: entry } }, path, key });
  });

  it("rejects retired audio.transcription", () => {
    expectUnknownKey({
      config: { audio: { transcription: { command: ["whisper"] } } },
      path: "",
      key: "audio",
    });
  });

  it("rejects legacy session.maintenance.rotateBytes", () => {
    expectUnknownKey({
      config: { session: { maintenance: { rotateBytes: "10mb" } } },
      path: "session.maintenance",
      key: "rotateBytes",
    });
  });

  it("rejects unused gateway.remote.enabled", () => {
    expectUnknownKey({
      config: { gateway: { remote: { enabled: false } } },
      path: "gateway.remote",
      key: "enabled",
    });
  });

  it.each([
    ["root canvasHost", { canvasHost: { enabled: true } }, "", "canvasHost"],
    ["root tui", { tui: { footer: { showRemoteHost: true } } }, "", "tui"],
    ["root defaultModel", { defaultModel: "openai/gpt-5.6" }, "", "defaultModel"],
    ["agents list", { agents: { list: [{ id: "main" }] } }, "agents", "list"],
    ["Slack identity", { channels: { slack: { identity: "bot" } } }, "channels.slack", "identity"],
    [
      "WhatsApp message prefix",
      { channels: { whatsapp: { messagePrefix: "x" } } },
      "channels.whatsapp",
      "messagePrefix",
    ],
    [
      "WhatsApp ack block",
      { channels: { whatsapp: { ackReaction: { emoji: "x" } } } },
      "channels.whatsapp",
      "ackReaction",
    ],
    [
      "Discord subagent progress",
      { channels: { discord: { subagentProgress: true } } },
      "channels.discord",
      "subagentProgress",
    ],
    [
      "iMessage coalesce",
      { channels: { imessage: { coalesceSameSenderDms: true } } },
      "channels.imessage",
      "coalesceSameSenderDms",
    ],
    ["cron.webhook", { cron: { webhook: "https://example.com" } }, "cron", "webhook"],
    ["commands.modelsWrite", { commands: { modelsWrite: true } }, "commands", "modelsWrite"],
    ["messages.messagePrefix", { messages: { messagePrefix: "x" } }, "messages", "messagePrefix"],
    [
      "session reset dm",
      { session: { resetByType: { dm: { mode: "idle" } } } },
      "session.resetByType",
      "dm",
    ],
    [
      "session pruneDays",
      { session: { maintenance: { pruneDays: 7 } } },
      "session.maintenance",
      "pruneDays",
    ],
    ["Talk realtime voice", { talk: { realtime: { voice: "alloy" } } }, "talk.realtime", "voice"],
    [
      "media async direct send",
      { tools: { media: { asyncCompletion: { directSend: true } } } },
      "tools.media",
      "asyncCompletion",
    ],
    [
      "message cross-context alias",
      { tools: { message: { allowCrossContextSend: true } } },
      "tools.message",
      "allowCrossContextSend",
    ],
    [
      "media Deepgram alias",
      { tools: { media: { audio: { deepgram: { punctuate: true } } } } },
      "tools.media.audio",
      "deepgram",
    ],
    [
      "MCP connect timeout alias",
      { mcp: { servers: { docs: { command: "docs", connectTimeout: 2 } } } },
      "mcp.servers.docs",
      "connectTimeout",
    ],
    [
      "MCP request timeout alias",
      { mcp: { servers: { docs: { command: "docs", timeout: 2 } } } },
      "mcp.servers.docs",
      "timeout",
    ],
    [
      "node-host MCP timeout alias",
      { nodeHost: { mcp: { servers: { docs: { command: "docs", connect_timeout: 2 } } } } },
      "nodeHost.mcp.servers.docs",
      "connect_timeout",
    ],
    [
      "Discord realtime voice alias",
      { channels: { discord: { voice: { realtime: { voice: "alloy" } } } } },
      "channels.discord.voice.realtime",
      "voice",
    ],
    [
      "Discord thread spawn alias",
      { channels: { discord: { threadBindings: { spawnAcpSessions: true } } } },
      "channels.discord.threadBindings",
      "spawnAcpSessions",
    ],
    [
      "Telegram thread spawn alias",
      { channels: { telegram: { threadBindings: { spawnSubagentSessions: true } } } },
      "channels.telegram.threadBindings",
      "spawnSubagentSessions",
    ],
    [
      "Matrix thread spawn alias",
      { channels: { matrix: { threadBindings: { spawnAcpSessions: true } } } },
      "channels.matrix.threadBindings",
      "spawnAcpSessions",
    ],
    [
      "LINE thread spawn alias",
      { channels: { line: { threadBindings: { spawnSubagentSessions: true } } } },
      "channels.line.threadBindings",
      "spawnSubagentSessions",
    ],
    [
      "Slack DM reply alias",
      { channels: { slack: { dm: { replyToMode: "all" } } } },
      "channels.slack.dm",
      "replyToMode",
    ],
    [
      "WhatsApp no-op",
      { channels: { whatsapp: { exposeErrorText: true } } },
      "channels.whatsapp",
      "exposeErrorText",
    ],
    [
      "Google Chat no-op",
      { channels: { googlechat: { actions: { reactions: true } } } },
      "channels.googlechat",
      "actions",
    ],
    [
      "Telegram DM topic config",
      { channels: { telegram: { dm: { threadReplies: "always" } } } },
      "channels.telegram",
      "dm",
    ],
  ] as const)("rejects retired %s", (_name, config, path, key) => {
    expectUnknownKey({ config, path, key });
  });
});
