import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "../../../config/validation.js";
import { resolveModelEntries } from "../../../media-understanding/resolve.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("legacy config migration end to end", () => {
  it("reshapes duplicate agent ids deterministically and keeps canonical entries", () => {
    const duplicate = applyLegacyDoctorMigrations({
      agents: {
        list: [
          { id: "main", name: "first" },
          { id: "main", name: "second" },
        ],
      },
    });
    expect(duplicate.next).toEqual({
      agents: { entries: { main: { name: "first" }, "main-2": { name: "second" } } },
    });
    expect(applyLegacyDoctorMigrations(duplicate.next)).toEqual({ next: null, changes: [] });

    const canonicalWins = applyLegacyDoctorMigrations({
      agents: { entries: { main: { name: "canonical" } }, list: [{ id: "main", name: "old" }] },
    });
    expect(canonicalWins.next).toEqual({ agents: { entries: { main: { name: "canonical" } } } });

    const prototypeId = applyLegacyDoctorMigrations({
      agents: { list: [{ id: "__proto__", name: "prototype-safe" }] },
    });
    const prototypeEntries = (prototypeId.next?.agents as { entries?: Record<string, unknown> })
      ?.entries;
    expect(Object.hasOwn(prototypeEntries ?? {}, "__proto__")).toBe(true);

    const normalizedId = applyLegacyDoctorMigrations({
      agents: { list: [{ id: "Team Ops", name: "normalized" }] },
    });
    expect(normalizedId.next).toEqual({
      agents: { entries: { "team-ops": { name: "normalized" } } },
    });
  });

  it("keeps agents.defaults.tts outside the schema", () => {
    expect(validateConfigObjectRaw({ agents: { defaults: { tts: {} } } }).ok).toBe(false);
  });

  it("canonicalizes a multi-family legacy config and is idempotent", () => {
    const result = migrateLegacyConfig({
      env: { shellEnv: { enabled: true }, API_ORIGIN: "https://example.test" },
      agents: {
        defaults: {
          pdfMaxBytesMb: 12,
          imageGenerationModel: "openai/image-1",
          promptOverlays: { gpt5: { personality: "off" } },
          envelopeTimestamp: "off",
          sandbox: { browser: { enableNoVnc: false } },
        },
        list: [{ id: "main", name: "Main", tools: { exec: { timeoutSec: 45 } } }],
      },
      tools: { exec: { timeoutSec: 30 } },
      media: { ttlHours: 24, preserveFilenames: true },
      audit: { enabled: false, messages: "direct" },
      diagnostics: {
        otel: { captureContent: { enabled: false, toolInputs: true } },
        cacheTrace: { enabled: true, filePath: "/tmp/trace.jsonl", includePrompt: false },
      },
      browser: {
        color: "#ffffff",
        ssrfPolicy: { allowedHostnames: ["localhost"], hostnameAllowlist: ["*.example.com"] },
        profiles: { chrome: { driver: "extension", color: "#000000" } },
      },
      gateway: {
        reload: { mode: "hot" },
        nodes: {
          skills: { enabled: false },
          allowCommands: ["camera.snap"],
          denyCommands: ["system.run"],
        },
        controlUi: { chatMessageMaxWidth: "82%" },
      },
      logging: { consoleStyle: "compact" },
      cron: { failureDestination: { channel: "telegram", to: "123" } },
      messages: {
        statusReactions: { enabled: true, emojis: { done: "✅" } },
        removeAckAfterReply: true,
      },
      channels: {
        defaults: { heartbeat: { showOk: true } },
        slack: {
          identity: "user",
          groupPolicy: "allowlist",
          dmPolicy: "pairing",
          mode: "socket",
          webhookPath: "/slack/events",
          userTokenReadOnly: true,
          socketMode: { clientPingTimeout: 1000 },
        },
        whatsapp: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          mediaMaxMb: 50,
          debounceMs: 0,
          messagePrefix: "[wa]",
          ackReaction: { emoji: "👀", direct: false, group: "mentions" },
        },
        imessage: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          coalesceSameSenderDms: true,
        },
      },
      mcp: {
        servers: {
          docs: {
            command: "docs",
            workingDirectory: "/tmp/docs",
            supports_parallel_tool_calls: true,
            ssl_verify: false,
            codex: { default_tools_approval_mode: "prompt" },
          },
        },
      },
    });

    expect(result.partiallyValid).toBeUndefined();
    expect(result.config).toMatchObject({
      env: { shellEnv: { enabled: true }, vars: { API_ORIGIN: "https://example.test" } },
      agents: {
        defaults: { pdfMaxMb: 12, mediaModels: { image: "openai/image-1" } },
        entries: { main: { name: "Main", tools: { exec: { timeoutSeconds: 45 } } } },
      },
      plugins: { entries: { openai: { config: { personality: "off" } } } },
      tools: { exec: { timeoutSeconds: 30 } },
      attachments: { ttlHours: 24 },
      logging: { consoleStyle: "pretty", audit: { enabled: false, messages: "direct" } },
      diagnostics: { otel: { captureContent: false }, cacheTrace: { enabled: true } },
      gateway: {
        reload: { mode: "hybrid" },
        nodes: { allowSkills: false, commands: { allow: ["camera.snap"], deny: ["system.run"] } },
      },
      cron: { failureAlert: { channel: "telegram", to: "123" } },
      messages: { inbound: { byChannel: { whatsapp: 0 } } },
      channels: {
        defaults: { heartbeatVisibility: { showOk: true } },
        slack: { postAs: "user" },
        whatsapp: { responsePrefix: "[wa]" },
      },
      mcp: {
        servers: {
          docs: {
            command: "docs",
            cwd: "/tmp/docs",
            supportsParallelToolCalls: true,
            sslVerify: false,
            codex: { defaultToolsApprovalMode: "prompt" },
          },
        },
      },
    });
    expect(result.changes).toContain(
      "Moved agents.defaults.promptOverlays.gpt5.personality → plugins.entries.openai.config.personality.",
    );
    const validation = validateConfigObjectRaw(result.config);
    expect(validation.ok, validation.ok ? undefined : JSON.stringify(validation.issues)).toBe(true);
    expect(applyLegacyDoctorMigrations(result.config)).toEqual({ next: null, changes: [] });
    const serialized = JSON.stringify(result.config);
    for (const key of [
      "pdfMaxBytesMb",
      "timeoutSec",
      "hostnameAllowlist",
      "enableNoVnc",
      "preserveFilenames",
      "ownerDisplay",
      "removeAckAfterReply",
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it("preserves canonical OpenAI personality over the retired prompt overlay", () => {
    const result = migrateLegacyConfig({
      agents: { defaults: { promptOverlays: { gpt5: { personality: "off" } } } },
      plugins: { entries: { openai: { config: { personality: "friendly" } } } },
    });

    expect(result.config?.plugins?.entries?.openai?.config?.personality).toBe("friendly");
    expect(result.config?.agents?.defaults?.promptOverlays).toBeUndefined();
    expect(result.changes).toContain(
      "Removed agents.defaults.promptOverlays.gpt5.personality (plugins.entries.openai.config.personality already set).",
    );
  });

  it("repairs unsupported OTel grpc once and is then a no-op", () => {
    const result = migrateLegacyConfig({
      diagnostics: {
        otel: {
          enabled: true,
          traces: false,
          metrics: false,
          logs: true,
          logsExporter: "stdout",
          protocol: "grpc",
        },
      },
    });

    expect(result.config?.diagnostics?.otel).toEqual({
      enabled: true,
      traces: false,
      metrics: false,
      logs: true,
      logsExporter: "stdout",
    });
    expect(validateConfigObjectRaw(result.config).ok).toBe(true);
    expect(applyLegacyDoctorMigrations(result.config)).toEqual({ next: null, changes: [] });
  });

  it("loads the OpenCode doctor contract from an exec reviewer fallback", () => {
    const raw = {
      tools: {
        exec: {
          reviewer: { model: { fallbacks: ["opencode/hy3-free@work"] } },
        },
      },
    };
    const applied = applyLegacyDoctorMigrations(raw);

    expect(applied.next?.tools).toEqual({
      exec: {
        reviewer: { model: { fallbacks: ["opencode/laguna-s-2.1-free@work"] } },
      },
    });
    const result = migrateLegacyConfig(raw);

    expect(result.partiallyValid).toBeUndefined();
    expect(result.config?.tools?.exec?.reviewer?.model).toEqual({
      fallbacks: ["opencode/laguna-s-2.1-free@work"],
    });
    expect(result.changes).toContain(
      "Updated tools.exec.reviewer.model.fallbacks.0 from the retired OpenCode Zen model to opencode/laguna-s-2.1-free.",
    );
    const validation = validateConfigObjectRaw(result.config);
    expect(validation.ok, validation.ok ? undefined : JSON.stringify(validation.issues)).toBe(true);
    expect(applyLegacyDoctorMigrations(result.config)).toEqual({ next: null, changes: [] });
    expect(migrateLegacyConfig(result.config)).toEqual({ config: null, changes: [] });
  });

  it("keeps a repaired OpenCode media preference selected", () => {
    const result = migrateLegacyConfig({
      tools: {
        media: {
          image: { preferredModel: "opencode/hy3-free" },
          models: [
            { provider: "other", model: "alternative", capabilities: ["image"] },
            { provider: "opencode", model: "hy3-free", capabilities: ["image"] },
          ],
        },
      },
    });

    expect(result.config?.tools?.media?.image?.preferredModel).toBe("opencode/laguna-s-2.1-free");
    const entries = resolveModelEntries({
      cfg: result.config ?? {},
      capability: "image",
      config: result.config?.tools?.media?.image,
      providerRegistry: new Map([
        ["opencode", { capabilities: ["image"] }],
        ["other", { capabilities: ["image"] }],
      ]),
    });
    expect(entries[0]?.entry).toMatchObject({
      provider: "opencode",
      model: "laguna-s-2.1-free",
    });
    expect(validateConfigObjectRaw(result.config).ok).toBe(true);
    expect(migrateLegacyConfig(result.config)).toEqual({ config: null, changes: [] });
  });
});
