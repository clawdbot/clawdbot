// Covers channel-driven plugin auto-enable decisions.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logWarnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: logWarnSpy }),
}));

import { normalizePluginsConfig } from "../plugins/config-state.js";
import { isActivatedManifestOwner } from "../plugins/manifest-owner-policy.js";
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
import type { OpenClawConfig } from "./types.openclaw.js";

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

function materializeEnvCatalogCandidates(
  stateDir: string,
  candidates: Parameters<typeof materializePluginAutoEnableCandidates>[0]["candidates"] = [
    { pluginId: "env-primary", kind: "channel-configured", channelId: "env-primary" },
    { pluginId: "env-secondary", kind: "channel-configured", channelId: "env-secondary" },
  ],
) {
  return materializePluginAutoEnableCandidates({
    config: {
      channels: {
        "env-primary": { token: "primary" },
        "env-secondary": { token: "secondary" },
      },
    },
    candidates,
    env: {
      ...makeIsolatedEnv(),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
    },
    manifestRegistry: makeRegistry([]),
  });
}

// A mixed-case manifest id beside the lowercase policy key config normalization derives from it,
// and the replacement that declares `preferOver` through that policy key.
const MIXED_CASE_LEGACY_CHAT_PLUGIN = {
  id: "Legacy-Chat",
  channels: ["legacy-chat"],
  channelConfigs: { "legacy-chat": { schema: { type: "object" }, label: "Legacy Chat" } },
};
const MODERN_CHAT_REPLACEMENT_PLUGIN = {
  id: "openclaw-modern-chat",
  channels: ["legacy-chat"],
  channelConfigs: {
    "legacy-chat": {
      schema: { type: "object" },
      label: "Modern Chat",
      preferOver: ["legacy-chat"],
    },
  },
};

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

    const result = materializeEnvCatalogCandidates(stateDir);

    expect(result.config.plugins?.entries?.["env-secondary"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["env-primary"]).toBeUndefined();
  });

  it("parses the external catalog once per process for preferOver lookups", () => {
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
    const countCatalogReads = () =>
      realpathSpy.mock.calls.filter(([filePath]) =>
        String(filePath).endsWith("plugins/catalog.json"),
      ).length;

    try {
      materializeEnvCatalogCandidates(
        stateDir,
        Array.from({ length: 20 }, (_, index) => ({
          pluginId: index % 2 === 0 ? "env-primary" : "env-secondary",
          kind: "channel-configured" as const,
          channelId: index % 2 === 0 ? "env-primary" : "env-secondary",
        })),
      );

      // The catalog file is process-stable plugin metadata: one bounded snapshot serves every
      // claimant, channel, and pass until the plugin metadata lifecycle clears it.
      expect(countCatalogReads()).toBe(1);

      materializeEnvCatalogCandidates(stateDir);

      expect(countCatalogReads()).toBe(1);
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

    const result = materializeEnvCatalogCandidates(stateDir);

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

    const result = materializeEnvCatalogCandidates(stateDir);

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

    it("does not disable a renamed external owner through its removed bundled channel id", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { qqbot: { appId: "app", clientSecret: "secret" } },
          plugins: {
            entries: {
              "openclaw-qqbot": { enabled: true },
            },
          },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
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
      expect(result.config.plugins?.entries?.qqbot).toBeUndefined();
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
      // #120332 round 30: `secondary` solely serves its own configured channel, so the
      // cross-channel preferOver must not plugin-globally disable it — that would leave the
      // configured `secondary` channel silently without an owner (no fallback exists and the
      // re-grounding pin is vetoed by live `primary`). The sole-claimant anchor keeps it live.
      expect(result.config.plugins?.entries?.secondary?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("primary configured, enabled automatically.");
      expect(result.changes.join("\n")).toContain("secondary configured, enabled automatically.");
    });

    // A manifest declares its id in whatever case its author chose, and plugin policy compares the
    // derived lowercase key. `preferOver` must read that same contract, or a mixed-case incumbent
    // stays enabled while config validation already applies the replacement's channel schema.
    it("recognizes a preferOver entry that differs from the manifest id only in case", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { "legacy-chat": { token: "legacy" } },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          MIXED_CASE_LEGACY_CHAT_PLUGIN,
          MODERN_CHAT_REPLACEMENT_PLUGIN,
        ]),
      });

      expect(result.config.plugins?.entries?.["openclaw-modern-chat"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["Legacy-Chat"]?.enabled).toBe(false);
      expect(result.changes.join("\n")).toContain("Modern Chat configured, enabled automatically.");
    });

    // The operator selects that same mixed-case incumbent through the normalized policy key, the
    // only spelling config normalization keeps. Explicit selection must compare through that key
    // too: the case-folded `preferOver` path above now reaches this incumbent, so an exact-match
    // read auto-disables the plugin the operator chose and hands its channel to the replacement.
    for (const [order, plugins] of [
      ["incumbent first", [MIXED_CASE_LEGACY_CHAT_PLUGIN, MODERN_CHAT_REPLACEMENT_PLUGIN]],
      ["incumbent last", [MODERN_CHAT_REPLACEMENT_PLUGIN, MIXED_CASE_LEGACY_CHAT_PLUGIN]],
    ] as const) {
      for (const [selection, makeSelection] of [
        ["allow", () => ({ allow: ["legacy-chat"] })],
        ["entries", () => ({ entries: { "legacy-chat": { config: { token: "legacy" } } } })],
      ] as const) {
        it(`keeps a mixed-case incumbent selected through the normalized ${selection} key (${order})`, () => {
          const result = applyPluginAutoEnable({
            config: {
              channels: { "legacy-chat": { token: "legacy" } },
              plugins: makeSelection(),
            },
            env: makeIsolatedEnv(),
            manifestRegistry: makeRegistry([...plugins]),
          });

          expect(result.config.plugins?.entries?.["Legacy-Chat"]).toBeUndefined();
          expect(result.config.plugins?.entries?.["legacy-chat"]?.enabled).not.toBe(false);
          expect(result.config.plugins?.entries?.["openclaw-modern-chat"]?.enabled).toBe(true);
        });
      }
    }

    // Config normalization keys `plugins.entries` and `plugins.deny` by the same lowercase policy
    // id, so an operator forbids that mixed-case incumbent through the normalized key. Auto-enable's
    // own disable and deny reads must compare through it too: a declared-id read misses the
    // operator's record and writes `enabled: true` under the mixed-case id, which normalization then
    // folds over the operator's false and loads a plugin config forbids.
    for (const [order, plugins] of [
      ["incumbent first", [MIXED_CASE_LEGACY_CHAT_PLUGIN, MODERN_CHAT_REPLACEMENT_PLUGIN]],
      ["incumbent last", [MODERN_CHAT_REPLACEMENT_PLUGIN, MIXED_CASE_LEGACY_CHAT_PLUGIN]],
    ] as const) {
      for (const [policy, makePolicy] of [
        [
          "entries",
          () => ({
            entries: {
              "legacy-chat": { enabled: false },
              "openclaw-modern-chat": { enabled: false },
            },
          }),
        ],
        [
          "deny",
          () => ({
            deny: ["legacy-chat"],
            entries: { "openclaw-modern-chat": { enabled: false } },
          }),
        ],
      ] as const) {
        it(`keeps a mixed-case incumbent forbidden through the normalized ${policy} key (${order})`, () => {
          const result = applyPluginAutoEnable({
            config: {
              channels: { "legacy-chat": { token: "legacy" } },
              plugins: makePolicy(),
            },
            env: makeIsolatedEnv(),
            manifestRegistry: makeRegistry([...plugins]),
          });

          expect(result.config.plugins?.entries?.["Legacy-Chat"]).toBeUndefined();
          expect(
            normalizePluginsConfig(result.config.plugins).entries["legacy-chat"]?.enabled,
          ).not.toBe(true);
          expect(result.changes).toStrictEqual([]);
        });
      }
    }

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

  // #120332 round 13: a supersede-keep claimant the completed config never activates must not
  // count as a live superseder, or the pass disables every plugin it prefers over and a configured
  // channel ends with no runtime owner — the silent-failure class.
  describe("kept-but-inactive claimants do not suppress other claimants", () => {
    // The kept claimant: workspace origin, so a material-only entry keeps it explicitly selected
    // for the replacement policy while the completed config still leaves it unloaded. Mixed-case
    // manifest id beside the normalized entry key the operator writes.
    const KEPT_WORKSPACE_GUARD = {
      id: "Acme-Kept-Guard",
      origin: "workspace" as const,
      channels: ["acme-chat", "acme-zap"],
      channelConfigs: {
        "acme-zap": { schema: { type: "object" } },
        "acme-chat": { schema: { type: "object" }, preferOver: ["acme-chat-serv"] },
      },
    };
    // The live replacement that supersedes the kept claimant on its other channel.
    const MODERN_ZAP = {
      id: "acme-modern-zap",
      origin: "global" as const,
      channels: ["acme-zap"],
      channelConfigs: {
        "acme-zap": { schema: { type: "object" }, preferOver: ["acme-kept-guard"] },
      },
    };
    // The claimant the kept plugin prefers over — the only plugin left to serve acme-chat.
    const CHAT_SERVER = {
      id: "acme-chat-serv",
      origin: "global" as const,
      channels: ["acme-chat"],
      channelConfigs: { "acme-chat": { schema: { type: "object" } } },
    };

    const REGISTRY_ORDERS = [
      ["kept claimant first", [KEPT_WORKSPACE_GUARD, MODERN_ZAP, CHAT_SERVER]],
      ["kept claimant last", [CHAT_SERVER, MODERN_ZAP, KEPT_WORKSPACE_GUARD]],
    ] as const;
    // Candidate order follows configured-channel order, so cover the claimant evaluated before and
    // after its kept superseder's own supersession.
    const CHANNEL_ORDERS = [
      ["zap first", { "acme-zap": { token: "zap" }, "acme-chat": { token: "chat" } }],
      ["chat first", { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } }],
    ] as const;

    for (const [registryOrder, plugins] of REGISTRY_ORDERS) {
      for (const [channelOrder, channels] of CHANNEL_ORDERS) {
        it(`keeps the configured channel owned by an active claimant (${registryOrder}, ${channelOrder})`, () => {
          const registry = makeRegistry([...plugins]);
          const result = applyPluginAutoEnable({
            config: {
              channels,
              plugins: { entries: { "acme-kept-guard": { config: { region: "eu" } } } },
            },
            env: makeIsolatedEnv(),
            manifestRegistry: registry,
          });

          // The replacement is enabled and the kept claimant's material-only entry is untouched.
          expect(result.config.plugins?.entries?.["acme-modern-zap"]?.enabled).toBe(true);
          expect(result.config.plugins?.entries?.["acme-kept-guard"]).toStrictEqual({
            config: { region: "eu" },
          });
          // The kept-but-unloaded claimant must not disable the plugin that serves acme-chat.
          expect(result.config.plugins?.entries?.["acme-chat-serv"]?.enabled).toBe(true);

          // The runtime proof: some claimant of the configured acme-chat channel is activated by
          // the completed config the runtime loads from.
          const completedPlugins = normalizePluginsConfig(result.config.plugins);
          const chatClaimants = registry.plugins.filter((plugin) =>
            plugin.channels.includes("acme-chat"),
          );
          expect(
            chatClaimants.filter((plugin) =>
              isActivatedManifestOwner({
                plugin,
                normalizedConfig: completedPlugins,
                rootConfig: result.config,
              }),
            ),
          ).toMatchObject([{ id: "acme-chat-serv" }]);
        });
      }
    }
  });
});

// #120332 ClawSweeper re-review (P1): the alias-aware config-record resolver admits an authored
// variant record (`channels.ClickClack`) as a configured-channel candidate, but the explicit-
// disable filter still read `channels[clickclack]` raw. The operator's `enabled: false` went
// unseen, so a channel that was explicitly turned off could enable its claimants — or let a
// replacement claim suppress the incumbent — while the canonical spelling was correctly
// skipped. Disable checks must resolve the authored record through the same identity that
// presence detection uses.
describe("alias-spelled explicit disables reach the planner", () => {
  const CLICKCLACK_INCUMBENT: Parameters<typeof makeRegistry>[0][number] = {
    id: "clickclack",
    origin: "bundled",
    channels: ["clickclack"],
    channelConfigs: { clickclack: { schema: { type: "object" } } },
  };
  const CLICKCLACK_REPLACEMENT: Parameters<typeof makeRegistry>[0][number] = {
    id: "acme-clack-rep",
    origin: "global",
    channels: ["clickclack"],
    channelConfigs: {
      clickclack: { schema: { type: "object" }, preferOver: ["clickclack"] },
    },
  };

  for (const [spelling, channels] of [
    ["canonical", { clickclack: { botToken: "clack-token", enabled: false } }],
    ["authored variant", { ClickClack: { botToken: "clack-token", enabled: false } }],
  ] as const) {
    it(`contributes no claims for a channel disabled under the ${spelling} spelling`, () => {
      const registry = makeRegistry([CLICKCLACK_INCUMBENT, CLICKCLACK_REPLACEMENT]);
      const result = applyPluginAutoEnable({
        config: { channels } as OpenClawConfig,
        env: makeIsolatedEnv(),
        manifestRegistry: registry,
      });

      // The operator turned the channel off: no claimant is enabled on its behalf, no
      // suppression fires against the incumbent, and no canonical-key enablement record is
      // written beside the authored one.
      expect(result.config.plugins?.entries?.["acme-clack-rep"]).toBeUndefined();
      expect(result.config.plugins?.entries?.clickclack).toBeUndefined();
      expect(result.config.channels).toStrictEqual(channels);
    });
  }
});
