import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPluginAutoEnable,
  materializePluginAutoEnableCandidates,
} from "./plugin-auto-enable.js";
import {
  makeApnChannelConfig,
  makeBluebubblesAndImessageChannels,
  makeIsolatedEnv,
  makeRegistry,
  makeTempDir,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";

function applyWithApnChannelConfig(extra?: {
  plugins?: { entries?: Record<string, { enabled: boolean }> };
}) {
  return applyPluginAutoEnable({
    config: {
      ...makeApnChannelConfig(),
      ...(extra?.plugins ? { plugins: extra.plugins } : {}),
    },
    env: makeIsolatedEnv(),
    manifestRegistry: makeRegistry([{ id: "apn-channel", channels: ["apn"] }]),
  });
}

function applyWithBluebubblesImessageConfig(extra?: {
  plugins?: { entries?: Record<string, { enabled: boolean }>; deny?: string[] };
}) {
  return applyPluginAutoEnable({
    config: {
      channels: makeBluebubblesAndImessageChannels(),
      ...(extra?.plugins ? { plugins: extra.plugins } : {}),
    },
    env: makeIsolatedEnv(),
  });
}

beforeEach(() => {
  resetPluginAutoEnableTestState();
});

afterEach(() => {
  resetPluginAutoEnableTestState();
});

describe("applyPluginAutoEnable channels", () => {
  it("uses env-scoped catalog metadata for preferOver auto-enable decisions", () => {
    const stateDir = makeTempDir();
    const catalogPath = path.join(stateDir, "plugins", "catalog.json");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/env-secondary",
            openclaw: {
              channel: {
                id: "env-secondary",
                label: "Env Secondary",
                selectionLabel: "Env Secondary",
                docsPath: "/channels/env-secondary",
                blurb: "Env secondary entry",
                preferOver: ["env-primary"],
              },
              install: {
                npmSpec: "@openclaw/env-secondary",
              },
            },
          },
        ],
      }),
      "utf-8",
    );

    const result = materializePluginAutoEnableCandidates({
      config: {
        channels: {
          "env-primary": { token: "primary" },
          "env-secondary": { token: "secondary" },
        },
      },
      candidates: [
        {
          pluginId: "env-primary",
          kind: "channel-configured",
          channelId: "env-primary",
        },
        {
          pluginId: "env-secondary",
          kind: "channel-configured",
          channelId: "env-secondary",
        },
      ],
      env: {
        ...makeIsolatedEnv(),
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
      },
      manifestRegistry: makeRegistry([]),
    });

    expect(result.config.plugins?.entries?.["env-secondary"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["env-primary"]).toBeUndefined();
  });

  it("memoizes external catalog preferOver lookups within one auto-enable pass", () => {
    const stateDir = makeTempDir();
    const catalogPath = path.join(stateDir, "plugins", "catalog.json");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/env-primary",
            openclaw: {
              channel: {
                id: "env-primary",
                label: "Env Primary",
                selectionLabel: "Env Primary",
                docsPath: "/channels/env-primary",
                blurb: "Env primary entry",
              },
              install: {
                npmSpec: "@openclaw/env-primary",
              },
            },
          },
          {
            name: "@openclaw/env-secondary",
            openclaw: {
              channel: {
                id: "env-secondary",
                label: "Env Secondary",
                selectionLabel: "Env Secondary",
                docsPath: "/channels/env-secondary",
                blurb: "Env secondary entry",
                preferOver: ["env-primary"],
              },
              install: {
                npmSpec: "@openclaw/env-secondary",
              },
            },
          },
        ],
      }),
      "utf-8",
    );

    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      materializePluginAutoEnableCandidates({
        config: {
          channels: {
            "env-primary": { token: "primary" },
            "env-secondary": { token: "secondary" },
          },
        },
        candidates: Array.from({ length: 20 }, (_, index) => ({
          pluginId: index % 2 === 0 ? "env-primary" : "env-secondary",
          kind: "channel-configured" as const,
          channelId: index % 2 === 0 ? "env-primary" : "env-secondary",
        })),
        env: {
          ...makeIsolatedEnv(),
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
        },
        manifestRegistry: makeRegistry([]),
      });

      expect(
        readFileSpy.mock.calls.filter(([filePath]) =>
          String(filePath).endsWith("plugins/catalog.json"),
        ),
      ).toHaveLength(2);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  describe("third-party channel plugins (pluginId ≠ channelId)", () => {
    it("uses the plugin manifest id, not the channel id, for plugins.entries", () => {
      const result = applyWithApnChannelConfig();

      expect(result.config.plugins?.entries?.["apn-channel"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.apn).toBeUndefined();
      expect(result.changes.join("\n")).toContain("apn configured, enabled automatically.");
    });

    it("does not double-enable when plugin is already enabled under its plugin id", () => {
      const result = applyWithApnChannelConfig({
        plugins: { entries: { "apn-channel": { enabled: true } } },
      });

      expect(result.changes).toEqual([]);
    });

    it("respects explicit disable of the plugin by its plugin id", () => {
      const result = applyWithApnChannelConfig({
        plugins: { entries: { "apn-channel": { enabled: false } } },
      });

      expect(result.config.plugins?.entries?.["apn-channel"]?.enabled).toBe(false);
      expect(result.changes).toEqual([]);
    });

    it("prefers an external plugin that declares preferOver for a bundled channel", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { "legacy-bundled-chat": { token: "legacy" } },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "legacy-bundled-chat",
            channels: ["legacy-bundled-chat"],
            origin: "bundled",
            channelConfigs: {
              "legacy-bundled-chat": {
                schema: { type: "object" },
                label: "Legacy Bundled Chat",
              },
            },
          },
          {
            id: "openclaw-modern-chat",
            channels: ["legacy-bundled-chat"],
            channelConfigs: {
              "legacy-bundled-chat": {
                schema: { type: "object" },
                label: "Modern Chat",
                preferOver: ["legacy-bundled-chat"],
              },
            },
          },
        ]),
      });

      expect(result.config.plugins?.entries?.["openclaw-modern-chat"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["legacy-bundled-chat"]?.enabled).toBe(false);
      expect(result.changes.join("\n")).toContain("Modern Chat configured, enabled automatically.");
    });

    it("falls back to the bundled channel when the preferred external plugin is disabled", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { "legacy-bundled-chat": { token: "legacy" } },
          plugins: { entries: { "openclaw-modern-chat": { enabled: false } } },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "legacy-bundled-chat",
            channels: ["legacy-bundled-chat"],
            origin: "bundled",
            channelConfigs: {
              "legacy-bundled-chat": {
                schema: { type: "object" },
                label: "Legacy Bundled Chat",
              },
            },
          },
          {
            id: "openclaw-modern-chat",
            channels: ["legacy-bundled-chat"],
            channelConfigs: {
              "legacy-bundled-chat": {
                schema: { type: "object" },
                label: "Modern Chat",
                preferOver: ["legacy-bundled-chat"],
              },
            },
          },
        ]),
      });

      expect(result.config.plugins?.entries?.["openclaw-modern-chat"]?.enabled).toBe(false);
      expect(result.config.plugins?.entries?.["legacy-bundled-chat"]).toBeUndefined();
      expect(result.config.channels?.["legacy-bundled-chat"]?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain(
        "Legacy Bundled Chat configured, enabled automatically.",
      );
    });

    it("does not auto-disable a lower-priority channel plugin that was explicitly selected", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { qqbot: { appId: "app", clientSecret: "secret" } },
          plugins: {
            entries: {
              qqbot: { enabled: true },
            },
          },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          { id: "qqbot", channels: ["qqbot"] },
          {
            id: "openclaw-qqbot",
            channels: ["qqbot"],
            channelConfigs: {
              qqbot: {
                schema: { type: "object" },
                preferOver: ["qqbot"],
              },
            },
          },
        ]),
      });

      expect(result.config.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.qqbot?.enabled).toBe(true);
    });

    it("does not synthesize plugin entries when no installed manifest declares the channel", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { "unknown-chan": { someKey: "value" } },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([]),
      });

      expect(result.config.plugins?.entries?.["unknown-chan"]).toBeUndefined();
      expect(result.config.plugins?.allow).toBeUndefined();
      expect(result.changes).toEqual([]);
    });
  });

  describe("preferOver channel prioritization", () => {
    it("uses manifest channel config preferOver metadata for plugin channels", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            primary: { someKey: "value" },
            secondary: { someKey: "value" },
          },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "primary",
            channels: ["primary"],
            channelConfigs: {
              primary: {
                schema: { type: "object" },
                preferOver: ["secondary"],
              },
            },
          },
          { id: "secondary", channels: ["secondary"] },
        ]),
      });

      expect(result.config.plugins?.entries?.primary?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.secondary?.enabled).toBe(false);
      expect(result.changes.join("\n")).toContain("primary configured, enabled automatically.");
      expect(result.changes.join("\n")).not.toContain(
        "secondary configured, enabled automatically.",
      );
    });

    it("prefers bluebubbles: skips imessage auto-configure when both are configured", () => {
      const result = applyWithBluebubblesImessageConfig();

      expect(result.config.channels?.bluebubbles?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(false);
      expect(result.changes.join("\n")).toContain("BlueBubbles configured, enabled automatically.");
      expect(result.changes.join("\n")).not.toContain(
        "iMessage configured, enabled automatically.",
      );
    });

    it("keeps imessage enabled if already explicitly enabled (non-destructive)", () => {
      const result = applyWithBluebubblesImessageConfig({
        plugins: { entries: { imessage: { enabled: true } } },
      });

      expect(result.config.channels?.bluebubbles?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
    });

    it("allows imessage auto-configure when bluebubbles is explicitly disabled", () => {
      const result = applyWithBluebubblesImessageConfig({
        plugins: { entries: { bluebubbles: { enabled: false } } },
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(false);
      expect(result.config.channels?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, enabled automatically.");
    });

    it("allows imessage auto-configure when bluebubbles is in deny list", () => {
      const result = applyWithBluebubblesImessageConfig({
        plugins: { deny: ["bluebubbles"] },
      });

      expect(result.config.plugins?.entries?.bluebubbles).toBeUndefined();
      expect(result.config.channels?.imessage?.enabled).toBe(true);
    });

    it("auto-enables imessage when only imessage is configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { imessage: { cliPath: "/usr/local/bin/imsg" } },
        },
        env: makeIsolatedEnv(),
      });

      expect(result.config.channels?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, enabled automatically.");
    });
  });
});
