// Startup log tests cover security warnings, model detail formatting, plugin
// summaries, bind URLs, ANSI output, and dangerous config reporting.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { captureEnv, deleteTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import { formatAgentModelStartupDetails, logGatewayStartup } from "./server-startup-log.js";

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
}));
const modelMocks = vi.hoisted(() => ({
  resolveThinkingDefault: vi.fn(() => "medium" as const),
}));
// Scrub the host's real reef guard env so ambient channel triggers cannot leak
// warnings into these assertions. Names are built dynamically so secret scanners
// do not mistake the identifiers for credential assignments; no values are set.
const AMBIENT_REEF_ENV_NAMES = ["API", "OPENAI", "ANTHROPIC"].map(
  (provider) => `REEF_GUARD_${provider}_KEY`,
);
const ambientChannelEnvSnapshot = captureEnv(AMBIENT_REEF_ENV_NAMES);

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry.js")>()),
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
}));

// Provider thinking owns a dedicated suite. Startup logging only needs its
// fixture-level default while proving precedence and banner composition.
vi.mock("../agents/model-thinking-default.js", () => ({
  resolveThinkingDefault: modelMocks.resolveThinkingDefault,
}));

describe("gateway startup log", () => {
  beforeEach(() => {
    for (const name of AMBIENT_REEF_ENV_NAMES) {
      deleteTestEnvValue(name);
    }
    modelMocks.resolveThinkingDefault.mockClear();
    modelMocks.resolveThinkingDefault.mockReturnValue("medium");
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    ambientChannelEnvSnapshot.restore();
  });

  afterAll(() => {});

  it("warns when dangerous config flags are enabled", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: { hooks: { gmail: { allowUnsafeExternalContent: true } } },
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn.mock.calls).toEqual([
      [
        "security warning: dangerous config flags enabled: hooks.gmail.allowUnsafeExternalContent=true. Run `openclaw security audit`.",
      ],
    ]);
  });

  it("does not warn when dangerous config flags are disabled", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when a configured channel plugin is blocked from startup", async () => {
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "slack",
          origin: "global",
          channels: ["slack"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    });
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {
        channels: {
          slack: {
            enabled: true,
            botToken: "configured",
          },
        },
      },
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn.mock.calls).toEqual([
      [
        'configured channel warning: channels.slack: channel is configured, but external plugin "slack" is installed without explicit trust. Add plugins.entries.slack.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.',
      ],
    ]);
  });

  it("warns when a configured channel has no owning plugin", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {
        channels: {
          "missing-chat": {
            enabled: true,
            token: "configured",
          },
        },
      },
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn.mock.calls).toEqual([
      [
        "configured channel warning: channels.missing-chat is configured but no channel plugin is installed or loadable (no-channel-owner). Run `openclaw doctor --fix` or install the channel plugin before relying on this channel.",
      ],
    ]);
  });

  it("logs one dev suppression notice without an ambient configured-channel warning", async () => {
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          packageChannel: {
            id: "discord",
            configuredState: { env: { allOf: ["DISCORD_FAKE_TEST_TRIGGER"] } },
          },
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    });
    const info = vi.fn();
    const warn = vi.fn();

    await withEnvAsync({ DISCORD_FAKE_TEST_TRIGGER: "configured" }, async () => {
      await logGatewayStartup({
        cfg: {
          plugins: {
            entries: { discord: { enabled: true } },
          },
        },
        ambientEnvTriggers: "suppress",
        bindHost: "127.0.0.1",
        loadedPluginIds: [],
        port: 18789,
        log: { info, warn },
        isNixMode: false,
      });
    });

    expect(warn.mock.calls).toEqual([
      [
        "dev gateway suppressed ambient channel auto-configuration for 1 channel: discord. Use --dev-ambient-channels to re-enable ambient channel triggers.",
      ],
    ]);
    expect(warn.mock.calls.flat().join("\n")).not.toContain("channels.discord is configured");
  });

  it("sanitizes configured channel ids in startup warnings", async () => {
    const unsafeChannelId = `slack${String.fromCharCode(0x1b)}[31m`;
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "slack",
          origin: "global",
          channels: [unsafeChannelId],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    });
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {
        channels: {
          [unsafeChannelId]: {
            enabled: true,
            botToken: "configured",
          },
        },
      },
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn.mock.calls[0]?.[0]).toContain("channels.slack: channel is configured");
    expect(warn.mock.calls[0]?.[0]).not.toContain(String.fromCharCode(0x1b));
  });

  it("does not warn when startup activation enables the configured channel owner", async () => {
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "openclaw-modern-chat",
          origin: "global",
          channels: ["legacy-chat"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    });
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {
        channels: {
          "legacy-chat": {
            enabled: true,
            token: "configured",
          },
        },
      },
      activationSourceConfig: {
        plugins: {
          entries: {
            "openclaw-modern-chat": {
              enabled: true,
            },
          },
        },
      },
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("logs configured model thinking and fast mode defaults with the startup model", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": {
                params: {
                  fastMode: true,
                  thinking: "medium",
                },
              },
            },
            reasoningDefault: "stream",
          },
        },
      },
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    const firstInfoCall = info.mock.calls[0];
    expect(firstInfoCall?.[0]).toBe("agent model: openai/gpt-5.5 (thinking=medium, fast=on)");
    expect(stripAnsi(String(firstInfoCall?.[1]?.consoleMessage))).toBe(
      "agent model: openai/gpt-5.5 (thinking=medium, fast=on)",
    );
  });

  it("defaults unset startup thinking to medium", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
            },
            list: [{ id: "main", default: true, fastModeDefault: true }],
          },
        },
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toBe("thinking=medium, fast=on");
    expect(modelMocks.resolveThinkingDefault).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit startup thinking off", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { params: { thinking: "off", fastMode: true } },
              },
            },
          },
        },
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toBe("thinking=off, fast=on");
    expect(modelMocks.resolveThinkingDefault).not.toHaveBeenCalled();
  });

  it("preserves explicit Ultra in startup model details", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: { agents: { defaults: { thinkingDefault: "ultra" } } },
        provider: "openai",
        model: "gpt-5.6-sol",
      }),
    ).toBe("thinking=ultra, fast=off");
    expect(modelMocks.resolveThinkingDefault).not.toHaveBeenCalled();
  });

  it("shows thinking off for configured provider models with reasoning disabled", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          models: {
            providers: {
              google: {
                api: "google-generative-ai",
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                models: [
                  {
                    id: "gemma-4-26b-a4b-it",
                    name: "Gemma 4 26B",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32_000,
                    maxTokens: 8_192,
                  },
                ],
              },
            },
          },
        },
        provider: "google",
        model: "gemma-4-26b-a4b-it",
      }),
    ).toBe("thinking=off, fast=off");
    expect(modelMocks.resolveThinkingDefault).not.toHaveBeenCalled();
  });

  it("uses default agent mode overrides in the startup model details", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          agents: {
            defaults: {
              thinkingDefault: "low",
              reasoningDefault: "off",
              models: {
                "openai/gpt-5.5": { params: { fastMode: false } },
              },
            },
            list: [{ id: "alpha", default: true, thinkingDefault: "high", fastModeDefault: true }],
          },
        },
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toBe("thinking=high, fast=on");
  });

  it("logs a compact listening line with loaded plugin ids and duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T10:00:16.000Z"));

    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      bindHosts: ["127.0.0.1", "::1"],
      loadedPluginIds: ["delta", "alpha", "delta", "beta"],
      port: 18789,
      startupStartedAt: Date.parse("2026-04-03T10:00:00.000Z"),
      log: { info, warn },
      isNixMode: false,
    });

    const listeningMessages = info.mock.calls
      .map((call) => call[0])
      .filter((message) => message.startsWith("http server listening ("));
    expect(listeningMessages).toEqual([
      "http server listening (3 plugins: alpha, beta, delta; 16.0s)",
    ]);
  });
});
