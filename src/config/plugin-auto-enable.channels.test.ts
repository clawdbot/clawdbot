// Covers channel-driven plugin auto-enable decisions.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logWarnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: logWarnSpy }),
}));

import { createManifestPluginAliasResolver } from "../plugins/manifest-plugin-alias.js";
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

  // Was two reads, one per distinct candidate channel. Catalog files are process-stable plugin
  // metadata and channel schema ownership resolves preferences on the Gateway config path too, so
  // they are now parsed once per resolved catalog path rather than once per lookup key.
  it("parses an external catalog once for a whole auto-enable pass", () => {
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
      materializeEnvCatalogCandidates(
        stateDir,
        Array.from({ length: 20 }, (_, index) => ({
          pluginId: index % 2 === 0 ? "env-primary" : "env-secondary",
          kind: "channel-configured" as const,
          channelId: index % 2 === 0 ? "env-primary" : "env-secondary",
        })),
      );

      expect(
        realpathSpy.mock.calls.filter(([filePath]) =>
          String(filePath).endsWith("plugins/catalog.json"),
        ),
      ).toHaveLength(1);
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

    // Codex review P1 on #123209: candidate discovery read `channelConfigs.<id>.preferOver` only,
    // so a catalog-declared replacement never reached the preferOver filter and the fallback was
    // activated while channel schema ownership had already selected the replacement.
    it.each([
      {
        source: "its channel config",
        declaration: {
          channelConfigs: {
            "legacy-bundled-chat": {
              schema: { type: "object" },
              label: "Modern Chat",
              preferOver: ["legacy-bundled-chat"],
            },
          },
        },
      },
      {
        source: "its package channel catalog metadata",
        declaration: {
          channelCatalogMeta: {
            id: "legacy-bundled-chat",
            label: "Modern Chat",
            preferOver: ["legacy-bundled-chat"],
          },
          channelConfigs: {
            "legacy-bundled-chat": { schema: { type: "object" }, label: "Modern Chat" },
          },
        },
      },
    ])("prefers an external plugin that declares preferOver through $source", ({ declaration }) => {
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
            ...declaration,
          },
        ]),
      });

      expect(result.config.plugins?.entries?.["openclaw-modern-chat"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["legacy-bundled-chat"]?.enabled).toBe(false);
      expect(result.changes.join("\n")).toContain("Modern Chat configured, enabled automatically.");
    });

    // Codex review P2 on #123209: when two claimants each declare the other, processing order
    // used to disable whichever candidate sorts first and enable the survivor, while schema
    // ownership walks registry order and could select the other plugin's strict schema. A mutual
    // pair settles nothing, so neither side is skipped: both register and the runtime facade
    // keeps the first registrant — the same claimant schema ownership keeps.
    it("enables both claimants when each declares the other in preferOver", () => {
      const result = applyPluginAutoEnable({
        config: { channels: { pairchat: { token: "pair" } } },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "pairchat-b",
            channels: ["pairchat"],
            channelConfigs: {
              pairchat: { schema: { type: "object" }, preferOver: ["pairchat-a"] },
            },
          },
          {
            id: "pairchat-a",
            channels: ["pairchat"],
            channelConfigs: {
              pairchat: { schema: { type: "object" }, preferOver: ["pairchat-b"] },
            },
          },
        ]),
      });

      expect(result.config.plugins?.entries?.["pairchat-a"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["pairchat-b"]?.enabled).toBe(true);
    });

    // Codex review on #123209: with three claimants each naming the next around a ring, no pair
    // is mutual, so candidate processing order disabled two of the three and left a survivor the
    // schema plane never picked. A ring settles nothing whatever its length: no claimant is
    // skipped, all register, and the runtime facade keeps the first registrant.
    it("enables every claimant when three declare each other around a ring", () => {
      const result = applyPluginAutoEnable({
        config: { channels: { ringchat: { token: "ring" } } },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "ringchat-b",
            channels: ["ringchat"],
            channelConfigs: {
              ringchat: { schema: { type: "object" }, preferOver: ["ringchat-c"] },
            },
          },
          {
            id: "ringchat-a",
            channels: ["ringchat"],
            channelConfigs: {
              ringchat: { schema: { type: "object" }, preferOver: ["ringchat-b"] },
            },
          },
          {
            id: "ringchat-c",
            channels: ["ringchat"],
            channelConfigs: {
              ringchat: { schema: { type: "object" }, preferOver: ["ringchat-a"] },
            },
          },
        ]),
      });

      for (const id of ["ringchat-a", "ringchat-b", "ringchat-c"]) {
        expect(result.config.plugins?.entries?.[id]?.enabled).toBe(true);
      }
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

    // The disablement can be written under any spelling Gateway startup canonicalizes. A raw
    // policy check reads the legacy-id entry as some other plugin, keeps the preferred claimant
    // eligible, and disables its fallback: both plugins end up off while validation selected the
    // fallback's schema.
    it("falls back when the preferred plugin is disabled through its legacy alias", () => {
      const manifestRegistry = makeRegistry([
        { id: "zzchat-classic", channels: ["zzchat"] },
        {
          id: "zzchat-modern",
          channels: ["zzchat"],
          legacyPluginIds: ["zzchat-modern-legacy"],
          channelConfigs: {
            zzchat: { schema: { type: "object" }, preferOver: ["zzchat-classic"] },
          },
        },
      ]);
      // The entry key below reaches the preferred plugin through the real manifest alias map.
      expect(createManifestPluginAliasResolver(manifestRegistry)("zzchat-modern-legacy")).toBe(
        "zzchat-modern",
      );

      const result = applyPluginAutoEnable({
        config: {
          channels: { zzchat: { someKey: "value" } },
          plugins: { entries: { "zzchat-modern-legacy": { enabled: false } } },
        },
        env: makeIsolatedEnv(),
        manifestRegistry,
      });

      expect(result.config.plugins?.entries?.["zzchat-classic"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["zzchat-modern"]).toBeUndefined();
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

    // Hand-picking can use any manifest-declared spelling. The preservation check must
    // canonicalize the same way Gateway startup does, or an allowlist entry written as a legacy id
    // keeps the fallback's strict schema for validation while auto-enable still writes
    // `enabled: false` for it.
    it("does not auto-disable a fallback selected through a legacy alias in plugins.allow", () => {
      const manifestRegistry = makeRegistry([
        {
          id: "zzclickclack-plus",
          channels: ["zzclickclack"],
          legacyPluginIds: ["zzclickclack-legacy"],
        },
        {
          id: "zzclickclack-ultra",
          channels: ["zzclickclack"],
          channelConfigs: {
            zzclickclack: { schema: { type: "object" }, preferOver: ["zzclickclack-plus"] },
          },
        },
      ]);
      // The allow spelling below reaches the fallback through the real manifest alias map.
      expect(createManifestPluginAliasResolver(manifestRegistry)("zzclickclack-legacy")).toBe(
        "zzclickclack-plus",
      );

      const result = applyPluginAutoEnable({
        config: {
          channels: { zzclickclack: { someKey: "value" } },
          plugins: { allow: ["zzclickclack-legacy"] },
        },
        env: makeIsolatedEnv(),
        manifestRegistry,
      });

      expect(result.config.plugins?.entries?.["zzclickclack-ultra"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["zzclickclack-plus"]).toBeUndefined();
    });

    // Allowlist materialization shares the same policy filter: a deny written under a legacy
    // alias must keep the plugin's material entry off the allowlist, or the materializer
    // re-admits a plugin the loader refuses to run.
    it("does not allowlist a material entry for a plugin denied through its legacy alias", () => {
      const manifestRegistry = makeRegistry([
        {
          id: "zzclickclack-ultra",
          channels: ["zzultra-chat"],
          legacyPluginIds: ["zzultra-legacy"],
        },
      ]);
      // The deny spelling below reaches the plugin through the real manifest alias map.
      expect(createManifestPluginAliasResolver(manifestRegistry)("zzultra-legacy")).toBe(
        "zzclickclack-ultra",
      );

      const result = applyPluginAutoEnable({
        config: {
          plugins: {
            allow: ["zzkeeper"],
            deny: ["zzultra-legacy"],
            entries: { "zzclickclack-ultra": { config: { token: "x" } } },
          },
        },
        env: makeIsolatedEnv(),
        manifestRegistry,
      });

      expect(result.config.plugins?.allow).toEqual(["zzkeeper"]);
      expect(result.changes).not.toContain(
        "zzclickclack-ultra plugin config present, added to plugin allowlist.",
      );
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

    it("keeps a fallback another configured channel still needs", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            zzalpha: { someKey: "value" },
            zzbeta: { someKey: "value" },
          },
        },
        env: makeIsolatedEnv(),
        manifestRegistry: makeRegistry([
          {
            id: "zz-replacement",
            channels: ["zzalpha"],
            channelConfigs: {
              zzalpha: {
                schema: { type: "object" },
                preferOver: ["zz-fallback"],
              },
            },
          },
          { id: "zz-fallback", channels: ["zzalpha", "zzbeta"] },
        ]),
      });

      expect(result.config.plugins?.entries?.["zz-replacement"]?.enabled).toBe(true);
      // zzbeta has no other claimant, so disabling the fallback plugin-wide takes that channel
      // down with it.
      expect(result.config.plugins?.entries?.["zz-fallback"]?.enabled).toBe(true);
    });

    it("does not let a non-channel candidate stand in for a channel claim", () => {
      // `zz-replacement` succeeds the `zzlegacy` plugin outright: it declares the preference for
      // channel `zzlegacy`, which that plugin does not claim — it serves `zzother`. A candidate
      // that is not channel-configured must not turn that into a same-channel rivalry just because
      // the plugin id matches the channel id.
      const run = (
        candidates: Parameters<typeof materializePluginAutoEnableCandidates>[0]["candidates"],
      ) =>
        materializePluginAutoEnableCandidates({
          config: {
            channels: { zzlegacy: { someKey: "value" }, zzother: { someKey: "value" } },
          },
          candidates,
          env: makeIsolatedEnv(),
          manifestRegistry: makeRegistry([
            {
              id: "zz-replacement",
              channels: ["zzlegacy"],
              channelConfigs: {
                zzlegacy: { schema: { type: "object" }, preferOver: ["zzlegacy"] },
              },
            },
            { id: "zzlegacy", channels: ["zzother"] },
          ]),
        });

      const withoutToolCandidate = run([
        { pluginId: "zz-replacement", kind: "channel-configured", channelId: "zzlegacy" },
        { pluginId: "zzlegacy", kind: "channel-configured", channelId: "zzother" },
      ]);
      const withToolCandidate = run([
        { pluginId: "zz-replacement", kind: "channel-configured", channelId: "zzlegacy" },
        { pluginId: "zzlegacy", kind: "channel-configured", channelId: "zzother" },
        { pluginId: "zzlegacy", kind: "plugin-tool-configured" },
      ]);

      // One unrelated tool candidate must not flip the plugin-wide outcome.
      expect(withToolCandidate.config.plugins?.entries?.zzlegacy?.enabled).toBe(
        withoutToolCandidate.config.plugins?.entries?.zzlegacy?.enabled,
      );
      expect(withToolCandidate.config.plugins?.entries?.zzlegacy?.enabled).toBe(false);
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
