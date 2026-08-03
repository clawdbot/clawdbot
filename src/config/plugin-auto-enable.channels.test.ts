// Covers channel-driven plugin auto-enable decisions.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logWarnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: logWarnSpy }),
}));

import {
  applyPluginAutoEnable,
  materializePluginAutoEnableCandidates,
} from "./plugin-auto-enable.js";
import {
  makeApnChannelConfig,
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

beforeEach(() => {
  resetPluginAutoEnableTestState();
});

afterEach(() => {
  resetPluginAutoEnableTestState();
  logWarnSpy.mockClear();
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

    const realpathSpy = vi.spyOn(fs, "realpathSync");

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
        realpathSpy.mock.calls.filter(([filePath]) =>
          String(filePath).endsWith("plugins/catalog.json"),
        ),
      ).toHaveLength(2);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("reads external catalog files through a symlink", () => {
    const stateDir = makeTempDir();
    const pluginsDir = path.join(stateDir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    const realPath = path.join(stateDir, "real-catalog.json");
    fs.writeFileSync(
      realPath,
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
              install: { npmSpec: "@openclaw/env-secondary" },
            },
          },
        ],
      }),
      "utf-8",
    );
    const catalogPath = path.join(pluginsDir, "catalog.json");
    fs.symlinkSync(realPath, catalogPath);

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
          kind: "channel-configured" as const,
          channelId: "env-primary",
        },
        {
          pluginId: "env-secondary",
          kind: "channel-configured" as const,
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

  it("warns when an oversized catalog is skipped and continues selection", () => {
    const stateDir = makeTempDir();
    const catalogPath = path.join(stateDir, "plugins", "catalog.json");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    // Create a sparse file whose stat.size exceeds the 16 MiB cap without
    // allocating actual disk blocks — the bounded read rejects it by size
    // before loading content into memory.
    const fd = fs.openSync(catalogPath, "w");
    try {
      fs.writeSync(fd, "{}\n");
      fs.ftruncateSync(fd, 17 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }

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
          kind: "channel-configured" as const,
          channelId: "env-primary",
        },
        {
          pluginId: "env-secondary",
          kind: "channel-configured" as const,
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

    // Selection continues: env-secondary is still auto-enabled.
    expect(result.config.plugins?.entries?.["env-secondary"]?.enabled).toBe(true);
    // Warning was logged for the oversized catalog.
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipping oversized external catalog file"),
    );
  });

  describe("third-party channel plugins", () => {
    it("activates external channel plugins under plugins.entries when plugin id matches channel id", () => {
      const result = materializePluginAutoEnableCandidates({
        config: {
          channels: {
            mattermost: {
              baseUrl: "http://mattermost:8065",
            },
          },
        },
        candidates: [
          {
            pluginId: "mattermost",
            kind: "channel-configured",
            channelId: "mattermost",
          },
        ],
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "mattermost",
            channels: ["mattermost"],
            origin: "global",
          },
        ]),
      });

      expect(result.config.plugins?.entries?.mattermost?.enabled).toBe(true);
      expect(result.config.channels?.mattermost?.enabled).toBeUndefined();
      expect(result.changes).toContain("Mattermost configured, enabled automatically.");
    });

    it("activates repaired external channel plugins under plugins.entries", () => {
      const result = materializePluginAutoEnableCandidates({
        config: {
          channels: {
            mattermost: {
              baseUrl: "http://mattermost:8065",
            },
          },
        },
        candidates: [
          {
            pluginId: "mattermost",
            kind: "configured-plugin-repaired",
          },
        ],
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "mattermost",
            channels: ["mattermost"],
            origin: "global",
          },
        ]),
      });

      expect(result.config.plugins?.entries?.mattermost?.enabled).toBe(true);
      expect(result.config.channels?.mattermost?.enabled).toBeUndefined();
      expect(result.changes).toContain(
        "mattermost installed for existing configuration, enabled automatically.",
      );
    });

    it("allowlists repaired external channel plugins under restrictive plugin policy", () => {
      const result = materializePluginAutoEnableCandidates({
        config: {
          channels: {
            mattermost: {
              baseUrl: "http://mattermost:8065",
            },
          },
          plugins: {
            allow: ["telegram"],
          },
        },
        candidates: [
          {
            pluginId: "mattermost",
            kind: "configured-plugin-repaired",
          },
        ],
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "mattermost",
            channels: ["mattermost"],
            origin: "global",
          },
        ]),
      });

      expect(result.config.plugins?.entries?.mattermost?.enabled).toBe(true);
      expect(result.config.plugins?.allow).toEqual(["telegram", "mattermost"]);
      expect(result.config.channels?.mattermost?.enabled).toBeUndefined();
      expect(result.changes).toContain(
        "mattermost installed for existing configuration, enabled automatically.",
      );
    });

    it("keeps built-in channel enablement when a same-id plugin does not claim the channel", () => {
      const result = materializePluginAutoEnableCandidates({
        config: {
          channels: {
            telegram: {
              botToken: "token",
            },
          },
        },
        candidates: [
          {
            pluginId: "telegram",
            kind: "channel-configured",
            channelId: "telegram",
          },
        ],
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "telegram",
            channels: ["unrelated-channel"],
            origin: "global",
          },
        ]),
      });

      expect(result.config.channels?.telegram?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.telegram).toBeUndefined();
      expect(result.changes).toContain("Telegram configured, enabled automatically.");
    });

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

      expect(result.changes).toStrictEqual([]);
    });

    it("respects explicit disable of the plugin by its plugin id", () => {
      const result = applyWithApnChannelConfig({
        plugins: { entries: { "apn-channel": { enabled: false } } },
      });

      expect(result.config.plugins?.entries?.["apn-channel"]?.enabled).toBe(false);
      expect(result.changes).toStrictEqual([]);
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
      expect(result.changes).toStrictEqual([]);
    });
  });

  describe("preferOver channel prioritization", () => {
    it("uses the plugin manifest id for built-in channel claims", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            wecom: { token: "enabled" },
          },
          plugins: {
            allow: ["existing-plugin"],
          },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "wecom-openclaw-plugin",
            channels: ["wecom"],
          },
        ]),
      });

      expect(result.config.plugins?.entries?.["wecom-openclaw-plugin"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.wecom).toBeUndefined();
      expect(result.config.plugins?.allow).toEqual(["existing-plugin", "wecom-openclaw-plugin"]);
      expect(result.changes.join("\n")).toContain("enabled automatically.");
    });

    it("preserves same-name official channel plugin ids", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            discord: { token: "enabled" },
          },
          plugins: {
            allow: ["existing-plugin"],
          },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "discord",
            channels: ["discord"],
            origin: "bundled",
          },
        ]),
      });

      expect(result.config.channels?.discord?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.discord).toBeUndefined();
      expect(result.config.plugins?.allow).toEqual(["existing-plugin", "discord"]);
      expect(result.changes.join("\n")).toContain("Discord configured, enabled automatically.");
    });

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
