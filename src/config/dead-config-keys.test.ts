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
  const agent = (config.agents as { list?: Array<Record<string, unknown>> } | undefined)?.list?.[0];
  if (agent) {
    agent.id = "test";
  }
  return config;
}

describe("dead config keys", () => {
  it.each([
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
    "tools.loopDetection.historySize",
    "tools.loopDetection.warningThreshold",
    "tools.loopDetection.detectors",
    "tools.loopDetection.postCompactionGuard",
    "agents.defaults.compaction.reserveTokens",
    "agents.defaults.compaction.reserveTokensFloor",
    "agents.defaults.compaction.maxHistoryShare",
    "agents.defaults.contextPruning.keepLastAssistants",
    "agents.defaults.contextPruning.softTrimRatio",
    "agents.defaults.contextPruning.softTrim",
    "agents.defaults.memorySearch.chunking",
    "agents.defaults.memorySearch.sync.watchDebounceMs",
    "agents.defaults.memorySearch.sync.intervalMinutes",
    "agents.defaults.memorySearch.query.hybrid.vectorWeight",
    "agents.defaults.memorySearch.query.hybrid.textWeight",
    "agents.defaults.memorySearch.query.hybrid.candidateMultiplier",
    "agents.defaults.memorySearch.query.hybrid.mmr.lambda",
    "agents.defaults.memorySearch.query.hybrid.temporalDecay.halfLifeDays",
    "agents.defaults.memorySearch.cache.maxEntries",
    "agents.defaults.cliBackends.codex.reliability.outputLimits",
    "agents.defaults.cliBackends.codex.reliability.watchdog.fresh.noOutputTimeoutMs",
    "agents.defaults.cliBackends.codex.reliability.watchdog.resume.noOutputTimeoutMs",
    "agents.defaults.runRetries",
    "agents.list.0.memorySearch.chunking",
    "agents.list.0.runRetries",
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
    "session.writeLock",
    "session.agentToAgent",
    "cron.maxConcurrentRuns",
    "cron.triggers.minIntervalMs",
    "cron.retry",
    "diagnostics.stuckSessionWarnMs",
    "diagnostics.stuckSessionAbortMs",
    "diagnostics.memoryPressureSnapshot",
    "web.heartbeatSeconds",
    "web.reconnect",
    "web.whatsapp",
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
