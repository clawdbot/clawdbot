import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON } from "./legacy-config-migrations.runtime.cron.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP } from "./legacy-config-migrations.runtime.mcp.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";

function applyAll(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of [
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.filter(
      (modelMigration) => modelMigration.id === "defaultModel->agents.defaults.model",
    ),
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED,
  ]) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

function configWithPath(path: string): Record<string, unknown> {
  return path
    .split(".")
    .reduceRight<unknown>(
      (value, segment) => (segment === "0" ? [value] : { [segment]: value }),
      1,
    ) as Record<string, unknown>;
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (Array.isArray(current)) {
      return current[Number(segment)];
    }
    return current && typeof current === "object"
      ? (current as Record<string, unknown>)[segment]
      : undefined;
  }, value);
}

describe("retired runtime config migrations", () => {
  it.each([
    "auth.cooldowns",
    "secrets.resolution",
    "browser.remoteCdpTimeoutMs",
    "browser.tabCleanup.idleMinutes",
    "tools.loopDetection.warningThreshold",
    "tools.loopDetection.detectors",
    "agents.defaults.compaction.reserveTokens",
    "agents.defaults.compaction.reserveTokensFloor",
    "agents.defaults.compaction.maxHistoryShare",
    "agents.defaults.contextPruning.softTrim",
    "agents.defaults.memorySearch.chunking",
    "agents.defaults.memorySearch.sync.watchDebounceMs",
    "agents.defaults.memorySearch.sync.intervalMinutes",
    "agents.defaults.memorySearch.query.hybrid.vectorWeight",
    "agents.defaults.memorySearch.query.hybrid.mmr.lambda",
    "agents.defaults.memorySearch.query.hybrid.temporalDecay.halfLifeDays",
    "agents.defaults.memorySearch.cache.maxEntries",
    "agents.defaults.cliBackends.codex.reliability.outputLimits",
    "agents.defaults.cliBackends.codex.reliability.watchdog.fresh.noOutputTimeoutMs",
    "agents.defaults.runRetries",
    "agents.list.0.compaction.reserveTokens",
    "agents.list.0.contextPruning.softTrimRatio",
    "agents.list.0.memorySearch.chunking",
    "agents.list.0.cliBackends.codex.reliability.outputLimits",
    "agents.list.0.runRetries",
    "agents.list.0.tools.loopDetection.warningThreshold",
    "agents.list.0.tools.loopDetection.detectors",
    "gateway.handshakeTimeoutMs",
    "gateway.channelHealthCheckMinutes",
    "gateway.reload.debounceMs",
    "gateway.reload.deferralTimeoutMs",
    "gateway.http.endpoints.chatCompletions.maxBodyBytes",
    "gateway.http.endpoints.responses.maxBodyBytes",
    "session.typingIntervalSeconds",
    "session.writeLock",
    "session.agentToAgent.maxPingPongTurns",
    "cron.maxConcurrentRuns",
    "cron.triggers.minIntervalMs",
    "cron.retry",
    "diagnostics.stuckSessionWarnMs",
    "diagnostics.memoryPressureSnapshot",
    "diagnostics.memoryPressureBundle",
    "web.heartbeatSeconds",
    "web.reconnect",
    "web.whatsapp",
    "messages.queue.debounceMs",
    "messages.statusReactions.timing",
    "acp.stream.coalesceIdleMs",
    "acp.stream.hiddenBoundarySeparator",
    "acp.maxConcurrentSessions",
    "acp.runtime.ttlMinutes",
    "mcp.sessionIdleTtlMs",
    "worktrees",
    "transcripts.maxUtterances",
    "hooks.maxBodyBytes",
    "update.auto.stableDelayHours",
  ] as const)("strips retired tuning knob %s", (path) => {
    const result = applyAll(configWithPath(path));
    expect(getPath(result.raw, path)).toBeUndefined();
    expect(result.changes).toContain(
      "Removed retired runtime tuning knobs; built-in defaults now apply.",
    );
  });

  it("moves aliases and strips dead keys", () => {
    const result = applyAll({
      tui: { footer: { showRemoteHost: true } },
      defaultModel: "openai/gpt-5.6",
      commands: { modelsWrite: true },
      messages: { messagePrefix: "[wa]" },
      cron: { webhook: "https://example.com", webhookToken: "keep" },
      session: { maintenance: { pruneDays: 7 }, resetByType: { dm: { mode: "idle" } } },
      talk: { realtime: { voice: "alloy" } },
      mcp: { servers: { docs: { connectTimeout: 2, timeout: 3 } } },
      nodeHost: { mcp: { servers: { local: { connect_timeout: 4 } } } },
      tools: {
        media: {
          asyncCompletion: { directSend: true },
          audio: { deepgram: { smartFormat: true } },
        },
        message: { allowCrossContextSend: true },
      },
    });

    expect(result.raw).toMatchObject({
      channels: { whatsapp: { messagePrefix: "[wa]" } },
      agents: { defaults: { model: "openai/gpt-5.6" } },
      cron: { webhookToken: "keep" },
      session: { maintenance: { pruneAfter: 7 }, resetByType: { direct: { mode: "idle" } } },
      talk: { realtime: { speakerVoice: "alloy" } },
      mcp: { servers: { docs: { connectionTimeoutMs: 2000, requestTimeoutMs: 3000 } } },
      nodeHost: { mcp: { servers: { local: { connectionTimeoutMs: 4000 } } } },
      tools: {
        media: { audio: { providerOptions: { deepgram: { smart_format: true } } } },
        message: { crossContext: { allowWithinProvider: true, allowAcrossProviders: true } },
      },
    });
    expect(result.raw).not.toHaveProperty("tui");
    expect(result.raw).not.toHaveProperty("commands.modelsWrite");
    expect(result.changes.length).toBeGreaterThan(8);
  });
});
