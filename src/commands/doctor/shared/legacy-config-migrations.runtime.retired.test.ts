import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON } from "./legacy-config-migrations.runtime.cron.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY } from "./legacy-config-migrations.runtime.gateway.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP } from "./legacy-config-migrations.runtime.mcp.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";

function applyAll(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of [
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY,
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
  it("uses a dedicated, actionable migration for the retired device-auth bypass", () => {
    const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY.find(
      (candidate) => candidate.id === "gateway.control-ui-device-auth-bypass->pairing-migration",
    );
    expect(migration).toBeDefined();
    const raw = {
      gateway: { controlUi: { dangerouslyDisableDeviceAuth: true } },
    };
    const changes: string[] = [];
    migration?.apply(raw, changes);

    expect(raw).not.toHaveProperty("gateway.controlUi.dangerouslyDisableDeviceAuth");
    expect(changes).toEqual([
      "Preserved the retired Control UI device-auth bypass for remediation. Reopen the Control UI over HTTPS or localhost, then click Secure this browser.",
    ]);
    expect(migration?.legacyRules?.[0]?.message).toContain("reopen the Control UI over HTTPS");
  });

  it("removes a disabled retired device-auth bypass without requiring pairing", () => {
    const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY.find(
      (candidate) => candidate.id === "gateway.control-ui-device-auth-bypass->pairing-migration",
    );
    expect(migration).toBeDefined();
    const raw = {
      gateway: { controlUi: { dangerouslyDisableDeviceAuth: false } },
    };
    const changes: string[] = [];

    expect(migration?.legacyRules?.[0]?.match?.(false, raw)).toBe(true);
    migration?.apply(raw, changes);

    expect(raw).not.toHaveProperty("gateway.controlUi.dangerouslyDisableDeviceAuth");
    expect(changes).toEqual([
      "Removed disabled gateway.controlUi.dangerouslyDisableDeviceAuth legacy config.",
    ]);
  });

  it("consolidates modality model lists with capability tags and exact deduplication", () => {
    const result = applyAll({
      tools: {
        media: {
          models: [{ provider: "openai", model: "shared", capabilities: ["image"] }],
          image: {
            enabled: true,
            models: [{ provider: "openai", model: "shared" }],
          },
          audio: {
            timeoutSeconds: 20,
            models: [
              { provider: "deepgram", model: "nova-3" },
              { provider: "deepgram", model: "nova-3" },
              { provider: "local", model: "same", timeoutSeconds: 20 },
            ],
          },
          video: { models: [{ provider: "local", model: "same", timeoutSeconds: 20 }] },
        },
      },
    });

    expect(result.raw).toEqual({
      tools: {
        media: {
          models: [
            { provider: "openai", model: "shared", capabilities: ["image"] },
            {
              provider: "deepgram",
              model: "nova-3",
              capabilities: ["audio"],
            },
            {
              provider: "local",
              model: "same",
              timeoutSeconds: 20,
              capabilities: ["audio"],
            },
            {
              provider: "local",
              model: "same",
              timeoutSeconds: 20,
              capabilities: ["video"],
            },
            { provider: "openai", model: "shared", capabilities: ["image"] },
          ],
          image: { enabled: true },
          audio: { timeoutSeconds: 20 },
        },
      },
    });
  });

  it("keeps modality defaults for auto-detection and preserves distinct legacy entries", () => {
    const result = applyAll({
      tools: {
        media: {
          models: [
            { provider: "openai", model: "shared", capabilities: ["image", "audio"] },
            { provider: "fallback", capabilities: ["audio"] },
          ],
          image: {
            timeoutSeconds: 180,
            models: [{ provider: "openai", model: "shared", prompt: "Describe details" }],
          },
          audio: {
            language: "en",
            models: [{ provider: "local-default" }],
          },
        },
      },
    });

    expect(getPath(result.raw, "tools.media.models")).toEqual([
      {
        provider: "openai",
        model: "shared",
        prompt: "Describe details",
        capabilities: ["image"],
      },
      { provider: "local-default", capabilities: ["audio"] },
      { provider: "openai", model: "shared", capabilities: ["image", "audio"] },
      { provider: "fallback", capabilities: ["audio"] },
    ]);
    expect(getPath(result.raw, "tools.media.image.timeoutSeconds")).toBe(180);
    expect(getPath(result.raw, "tools.media.audio.language")).toBe("en");
  });

  it("preserves independent fallback order across capability lists", () => {
    const result = applyAll({
      tools: {
        media: {
          image: { models: ["a", "b", "c"].map((model) => ({ provider: "p", model })) },
          audio: { models: ["c", "b", "a"].map((model) => ({ provider: "p", model })) },
        },
      },
    });
    const models = getPath(result.raw, "tools.media.models") as Array<{
      model: string;
      capabilities: string[];
    }>;
    expect(
      models.filter((model) => model.capabilities.includes("image")).map((model) => model.model),
    ).toEqual(["a", "b", "c"]);
    expect(
      models.filter((model) => model.capabilities.includes("audio")).map((model) => model.model),
    ).toEqual(["c", "b", "a"]);
  });

  it("preserves explicit legacy capability filtering", () => {
    const result = applyAll({
      tools: {
        media: {
          image: {
            models: [
              { provider: "skip", model: "audio-only", capabilities: ["audio"] },
              {
                provider: "keep",
                model: "image-first",
                capabilities: ["image", "audio"],
              },
            ],
          },
        },
      },
    });

    expect(getPath(result.raw, "tools.media.models")).toEqual([
      { provider: "keep", model: "image-first", capabilities: ["image"] },
    ]);
    expect(getPath(result.raw, "tools.media.image.preferredModel")).toBeUndefined();
  });
  it.each([
    "systemAgent",
    "marketplaces",
    "cli.banner.taglineMode",
    "commitments",
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
    "memory.search.chunking",
    "memory.search.cache.maxEntries",
    "agents.defaults.cliBackends.codex.reliability.outputLimits",
    "agents.defaults.cliBackends.codex.reliability.watchdog.fresh.noOutputTimeoutMs",
    "agents.defaults.runRetries",
    "agents.list.0.compaction.reserveTokens",
    "agents.list.0.contextPruning.softTrimRatio",
    "agents.list.0.memory.search.chunking",
    "agents.list.0.cliBackends.codex.reliability.outputLimits",
    "agents.list.0.runRetries",
    "agents.list.0.tools.loopDetection.warningThreshold",
    "agents.list.0.tools.loopDetection.detectors",
    "agents.entries.worker.contextPruning.softTrimRatio",
    "agents.entries.worker.memory.search.chunking",
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

  it("migrates the config tranche while preserving canonical settings", () => {
    const result = applyAll({
      ui: {
        prefs: {
          chatMessageMaxWidth: "82%",
          textScale: 125,
          sidebarLiveActivity: false,
          showAdvancedSettings: true,
        },
      },
      skills: { load: { watch: true, watchDebounceMs: 500 } },
      agents: {
        defaults: {
          typingIntervalSeconds: 6,
          contextLimits: {
            memoryGetMaxChars: 12_000,
            memoryGetDefaultLines: 180,
            toolResultMaxChars: 24_000,
          },
        },
        entries: {
          writer: {
            typingMode: "message",
            typingIntervalSeconds: 8,
            contextLimits: { toolResultMaxChars: 8_000 },
          },
        },
        list: [
          {
            id: "legacy",
            typingIntervalSeconds: 10,
            contextLimits: { memoryGetDefaultLines: 80 },
          },
        ],
      },
      channels: {
        whatsapp: {
          defaultAccount: "Work",
          debounceMs: 2_000,
          accounts: {
            default: { debounceMs: 3_000 },
            work: { debounceMs: 4_000 },
          },
        },
      },
    });

    expect(result.raw).toMatchObject({
      ui: { prefs: { showAdvancedSettings: true } },
      skills: { load: { watch: true } },
      agents: {
        defaults: {
          typingIntervalSeconds: 6,
          contextLimits: { memoryGetMaxChars: 12_000 },
        },
        entries: { writer: { typingMode: "message" } },
        list: [{ id: "legacy" }],
      },
      messages: { inbound: { byChannel: { whatsapp: 4_000 } } },
    });
    expect(result.raw).not.toHaveProperty("channels.whatsapp.debounceMs");
    expect(result.raw).not.toHaveProperty("channels.whatsapp.accounts.default.debounceMs");
    expect(result.raw).not.toHaveProperty("channels.whatsapp.accounts.work.debounceMs");
    expect(result.changes).toContain(
      "Collapsed conflicting WhatsApp debounce values into messages.inbound.byChannel.whatsapp using channels.whatsapp.accounts.work.debounceMs (4000 ms); account-specific debounce is no longer supported.",
    );
  });

  it("keeps an existing canonical WhatsApp debounce value", () => {
    const result = applyAll({
      messages: { inbound: { byChannel: { whatsapp: 900 } } },
      channels: {
        whatsapp: {
          debounceMs: 2_000,
          accounts: { work: { debounceMs: 4_000 } },
        },
      },
    });

    expect(result.raw).toHaveProperty("messages.inbound.byChannel.whatsapp", 900);
    expect(result.raw).not.toHaveProperty("channels.whatsapp.debounceMs");
    expect(result.raw).not.toHaveProperty("channels.whatsapp.accounts.work.debounceMs");
  });

  it("preserves accounts.default debounce inheritance for a named default account", () => {
    const result = applyAll({
      channels: {
        whatsapp: {
          defaultAccount: "work",
          debounceMs: 2_000,
          accounts: {
            default: { debounceMs: 3_000 },
            work: { name: "Work" },
          },
        },
      },
    });

    expect(result.raw).toHaveProperty("messages.inbound.byChannel.whatsapp", 3_000);
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
      channels: { whatsapp: { responsePrefix: "[wa]" } },
      agents: { defaults: { model: "openai/gpt-5.6" } },
      cron: { webhookToken: "keep" },
      session: { maintenance: { pruneAfter: 7 }, resetByType: { direct: { mode: "idle" } } },
      talk: { realtime: { speakerVoice: "alloy" } },
      mcp: { servers: { docs: { connectionTimeoutMs: 2000, requestTimeoutMs: 3000 } } },
      nodeHost: { mcp: { servers: { local: { connectionTimeoutMs: 4000 } } } },
      tools: {
        media: {},
        message: { crossContext: { allowWithinProvider: true, allowAcrossProviders: true } },
      },
    });
    expect(result.raw).not.toHaveProperty("tui");
    expect(result.raw).not.toHaveProperty("commands.modelsWrite");
    expect(result.changes.length).toBeGreaterThan(8);
  });

  it("consolidates the approved tier-eval tranche with canonical values winning", () => {
    const result = applyAll({
      mcp: { servers: { docs: { cwd: "/canonical", workingDirectory: "/legacy" } } },
      nodeHost: { mcp: { servers: { local: { workingDirectory: "/node" } } } },
      session: {
        idleMinutes: 45,
        reset: { idleMinutes: 90 },
        threadBindings: { enabled: false, idleHours: 12 },
      },
      channels: {
        signal: { httpHost: "127.0.0.2", httpPort: 9090 },
        googlechat: { serviceAccountRef: { source: "env" } },
        discord: { threadBindings: { enabled: false, idleHours: 12 } },
        whatsapp: {},
      },
      agents: {
        defaults: {
          cliBackends: { custom: { sessionArg: "--session" } },
          heartbeat: { ackMaxChars: 10, includeReasoning: true },
          memory: { search: { query: { hybrid: { enabled: false } } } },
        },
        entries: {
          main: {
            groupChat: { visibleReplies: "automatic" },
            tools: { exec: { security: "allowlist", ask: "on-miss" } },
          },
        },
      },
      tools: {
        exec: { mode: "deny", security: "full", ask: "off" },
        media: {
          models: [
            {
              provider: "openai",
              model: "whisper-1",
              capabilities: ["audio"],
              baseUrl: "https://legacy.example/v1",
              headers: { "x-legacy": "1" },
            },
          ],
          audio: { request: { auth: { mode: "none" } } },
        },
      },
      models: { providers: { openai: { headers: { "x-canonical": "1" } } } },
      memory: {
        qmd: { mcporter: { enabled: true }, update: { interval: "1m" } },
        search: {
          experimental: { sessionMemory: true },
          remote: { nonBatchConcurrency: 4, batch: { enabled: true, concurrency: 3 } },
          sync: { watch: false },
          store: { driver: "sqlite", vector: { enabled: false } },
        },
      },
      messages: { responsePrefix: "[bot]" },
      web: { enabled: false },
      logging: { redactSensitive: "off" },
      commands: { useAccessGroups: false },
      gateway: {
        controlUi: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: true },
      },
      proxy: { enabled: true, proxyUrl: "http://proxy.example" },
      discovery: { wideArea: { enabled: true, domain: "openclaw.internal" } },
    });

    expect(result.raw).toMatchObject({
      mcp: { servers: { docs: { cwd: "/canonical" } } },
      nodeHost: { mcp: { servers: { local: { cwd: "/node" } } } },
      session: { reset: { idleMinutes: 90 }, threadBindings: { enabled: false, idleHours: 12 } },
      channels: {
        signal: { httpUrl: "http://127.0.0.2:9090", autoStart: true },
        googlechat: { serviceAccount: { source: "env" } },
        discord: { threadBindings: { enabled: false, idleHours: 12 } },
        whatsapp: { enabled: false, responsePrefix: "[bot]" },
      },
      agents: {
        defaults: { cliBackends: { custom: { sessionArgs: ["--session", "{sessionId}"] } } },
        entries: { main: { tools: { exec: { mode: "ask" } } } },
      },
      tools: {
        exec: { mode: "deny" },
        media: {
          models: [
            {
              provider: "openai",
              model: "whisper-1",
              capabilities: ["audio"],
              baseUrl: "https://legacy.example/v1",
              headers: { "x-legacy": "1" },
            },
          ],
          audio: { request: { auth: { mode: "none" } } },
        },
      },
      models: {
        providers: {
          openai: { headers: { "x-canonical": "1" } },
        },
      },
      memory: {
        search: {
          experimental: { sessionMemory: true },
          remote: { batch: { enabled: true } },
          store: { vector: { enabled: false } },
        },
      },
      proxy: { proxyUrl: "http://proxy.example" },
      discovery: { wideArea: { domain: "openclaw.internal" } },
    });
    expect(result.raw).toHaveProperty("messages.responsePrefix", "[bot]");
    expect(result.raw).not.toHaveProperty("web");
    expect(result.raw).not.toHaveProperty("logging.redactSensitive");
    expect(result.raw).not.toHaveProperty("commands.useAccessGroups");
    expect(result.raw).not.toHaveProperty("gateway.controlUi.allowInsecureAuth");
    expect(result.raw).not.toHaveProperty("memory.qmd");
  });

  it("keeps evidence mismatches while stripping canonical conflict aliases", () => {
    const result = applyAll({
      session: { threadBindings: { enabled: true } },
      tools: { media: { audio: { baseUrl: "https://provider-required.example" } } },
      proxy: { enabled: false, proxyUrl: "http://disabled-proxy.example" },
      discovery: { wideArea: { enabled: false, domain: "disabled.example" } },
      channels: {
        telegram: { threadBindings: { enabled: false } },
        googlechat: { serviceAccount: "plain", serviceAccountRef: { source: "env" } },
        whatsapp: { enabled: true },
      },
      web: { enabled: false },
    });

    expect(result.raw).toHaveProperty("channels.telegram.threadBindings.enabled", false);
    expect(result.raw).toHaveProperty(
      "tools.media.audio.baseUrl",
      "https://provider-required.example",
    );
    expect(result.raw).toHaveProperty("proxy", {
      enabled: false,
      proxyUrl: "http://disabled-proxy.example",
    });
    expect(result.raw).not.toHaveProperty("discovery.wideArea.domain");
    expect(result.raw).not.toHaveProperty("channels.googlechat.serviceAccountRef");
    expect(result.raw).toHaveProperty("channels.googlechat.serviceAccount", { source: "env" });
    expect(result.raw).not.toHaveProperty("web");
  });

  it("keeps nonrepresentable exec and inherited memory policies", () => {
    const result = applyAll({
      tools: { exec: { security: "allowlist", ask: "always" } },
      memory: { search: { provider: "openai", store: { vector: { enabled: false } } } },
      agents: {
        entries: {
          malformed: { tools: { exec: { security: "deny " } } },
          onMissFull: { tools: { exec: { security: "full", ask: "on-miss" } } },
        },
      },
    });

    expect(result.raw).toHaveProperty("tools.exec.ask", "always");
    expect(result.raw).not.toHaveProperty("tools.exec.mode");
    expect(result.raw).toHaveProperty("agents.entries.malformed.tools.exec.security", "deny ");
    expect(result.raw).toHaveProperty("agents.entries.onMissFull.tools.exec.ask", "on-miss");
    expect(result.raw).not.toHaveProperty("agents.entries.onMissFull.tools.exec.mode");
    expect(result.raw).toHaveProperty("memory.search.provider", "openai");
    expect(result.raw).toHaveProperty("memory.search.store.vector.enabled", false);
    expect(result.changes).toEqual([]);
  });

  it("uses the inherited exec policy when migrating a partial agent override", () => {
    const result = applyAll({
      tools: { exec: { security: "allowlist", ask: "on-miss" } },
      agents: {
        entries: {
          nonInteractive: { tools: { exec: { ask: "off" } } },
        },
      },
    });

    expect(result.raw).toHaveProperty("tools.exec.mode", "ask");
    expect(result.raw).toHaveProperty("agents.entries.nonInteractive.tools.exec.mode", "allowlist");
    expect(result.raw).not.toHaveProperty("agents.entries.nonInteractive.tools.exec.ask");
  });

  it("preserves idle mode when migrating a standalone session idle timeout", () => {
    const result = applyAll({ session: { idleMinutes: 45 } });

    expect(result.raw).toHaveProperty("session.reset", { mode: "idle", idleMinutes: 45 });
  });

  it("brackets IPv6 Signal hosts when migrating the legacy endpoint fields", () => {
    const result = applyAll({
      channels: { signal: { httpHost: "::1", httpPort: 9090 } },
    });

    expect(result.raw).toHaveProperty("channels.signal.httpUrl", "http://[::1]:9090");
  });

  it("preserves inherited Signal host values for partial account overrides", () => {
    const result = applyAll({
      channels: {
        signal: {
          httpHost: "10.0.0.5",
          httpPort: 8080,
          accounts: { work: { httpPort: 9090 } },
        },
      },
    });

    expect(result.raw).toHaveProperty(
      "channels.signal.accounts.work.httpUrl",
      "http://10.0.0.5:9090",
    );
  });

  it("keeps an inherited canonical Signal URL over account legacy fields", () => {
    const result = applyAll({
      channels: {
        signal: {
          httpUrl: "http://signal.example:8080",
          accounts: { work: { httpPort: 9090 } },
        },
      },
    });

    expect(result.raw).not.toHaveProperty("channels.signal.accounts.work.httpUrl");
    expect(result.raw).not.toHaveProperty("channels.signal.accounts.work.httpPort");
    expect(result.raw).toHaveProperty("channels.signal.httpUrl", "http://signal.example:8080");
  });

  it("moves the global TTS preference path while retaining scoped agent paths", () => {
    const result = applyAll({
      tts: { prefsPath: "/global/tts.json" },
      agents: { entries: { voice: { tts: { prefsPath: "/voice/tts.json" } } } },
    });

    expect(result.raw).not.toHaveProperty("tts.prefsPath");
    expect(result.raw).toHaveProperty("agents.entries.voice.tts.prefsPath", "/voice/tts.json");
  });

  it("strips TTS persona prompts with a prepareSynthesis migration pointer", () => {
    const result = applyAll({
      tts: {
        personas: {
          alfred: {
            prompt: { style: "dry" },
            providers: {
              custom: { tts: { personas: { voice: { prompt: { owned: true } } } } },
            },
          },
        },
      },
      agents: {
        entries: {
          voice: { tts: { personas: { narrator: { prompt: { pacing: "slow" } } } } },
        },
      },
    });

    expect(result.raw).not.toHaveProperty("tts.personas.alfred.prompt");
    expect(result.raw).toHaveProperty(
      "tts.personas.alfred.providers.custom.tts.personas.voice.prompt.owned",
      true,
    );
    expect(result.raw).not.toHaveProperty("agents.entries.voice.tts.personas.narrator.prompt");
    expect(result.changes.join("\n")).toContain("prepareSynthesis");
  });

  it("strips compaction prompt config with provider and hook pointers", () => {
    const result = applyAll({
      agents: {
        defaults: {
          compaction: {
            customInstructions: "Keep decisions.",
            identifierPolicy: "custom",
            identifierInstructions: "Keep ticket IDs.",
            postCompactionSections: ["Red Lines"],
            memoryFlush: { prompt: "Write memory.", systemPrompt: "Be careful." },
          },
        },
      },
    });

    expect(result.raw).toHaveProperty("agents.defaults.compaction.identifierPolicy", "strict");
    expect(result.raw).not.toHaveProperty("agents.defaults.compaction.customInstructions");
    expect(result.raw).not.toHaveProperty("agents.defaults.compaction.identifierInstructions");
    expect(result.raw).toHaveProperty("agents.defaults.compaction.postCompactionSections", [
      "Red Lines",
    ]);
    expect(result.raw).not.toHaveProperty("agents.defaults.compaction.memoryFlush.prompt");
    expect(result.raw).not.toHaveProperty("agents.defaults.compaction.memoryFlush.systemPrompt");
    expect(result.changes.join("\n")).toContain("summarize()");
    expect(result.changes.join("\n")).toContain("before_prompt_build");
  });

  it("copies responsePrefix to supported channels while retaining custom-channel fallback", () => {
    const result = applyAll({
      messages: { responsePrefix: "[bot]" },
      channels: { whatsapp: {}, custom: { enabled: true } },
    });

    expect(result.raw).toHaveProperty("channels.whatsapp.responsePrefix", "[bot]");
    expect(result.raw).toHaveProperty("messages.responsePrefix", "[bot]");
    expect(applyAll(result.raw).changes).toEqual([]);
  });

  it("keeps the inherited session-memory policy", () => {
    const result = applyAll({
      memory: {
        search: {
          rememberAcrossConversations: true,
          sources: ["memory"],
          experimental: { sessionMemory: true },
        },
      },
    });

    expect(result.raw).toHaveProperty("memory.search.sources", ["memory"]);
    expect(result.raw).toHaveProperty("memory.search.experimental.sessionMemory", true);
  });
});
