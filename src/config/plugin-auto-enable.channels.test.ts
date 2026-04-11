import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

    it("falls back to channel key as plugin id when no installed manifest declares the channel", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { "unknown-chan": { someKey: "value" } },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([]),
      });

      expect(result.config.plugins?.entries?.["unknown-chan"]?.enabled).toBe(true);
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
      expect(result.config.plugins?.entries?.secondary?.enabled).toBeUndefined();
      expect(result.changes.join("\n")).toContain("primary configured, enabled automatically.");
      expect(result.changes.join("\n")).not.toContain(
        "secondary configured, enabled automatically.",
      );
    });

    it("prefers bluebubbles: skips imessage auto-configure when both are configured", () => {
      const result = applyWithBluebubblesImessageConfig();

      expect(result.config.channels?.bluebubbles?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBeUndefined();
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
