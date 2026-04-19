import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectDoctorPreviewWarnings } from "./preview-warnings.js";

type TestManifestRecord = {
  id: string;
  channels: string[];
};

const manifestState = vi.hoisted(
  () =>
    ({
      plugins: [] as TestManifestRecord[],
      diagnostics: [] as Array<{ level: string; message: string; source: string }>,
    }) satisfies {
      plugins: TestManifestRecord[];
      diagnostics: Array<{ level: string; message: string; source: string }>;
    },
);

vi.mock("../channel-capabilities.js", () => {
  const fallback = {
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: true,
    warnOnEmptyGroupSenderAllowlist: true,
  };
  return {
    getDoctorChannelCapabilities: () => fallback,
  };
});

vi.mock("./channel-doctor.js", () => ({
  collectChannelDoctorEmptyAllowlistExtraWarnings: vi.fn(() => []),
  collectChannelDoctorPreviewWarnings: vi.fn(
    async ({ cfg }: { cfg: { channels?: Record<string, unknown> } }) => {
      const telegram = cfg.channels?.telegram as { allowFrom?: unknown } | undefined;
      const usernames = Array.isArray(telegram?.allowFrom)
        ? telegram.allowFrom.filter(
            (entry): entry is string => typeof entry === "string" && entry.startsWith("@"),
          )
        : [];
      if (usernames.length === 0) {
        return [];
      }
      return [
        `- Telegram allowFrom contains ${usernames.length} username entr${
          usernames.length === 1 ? "y" : "ies"
        } (e.g. ${usernames[0]}).`,
      ];
    },
  ),
  shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning: vi.fn(() => false),
}));

vi.mock("./channel-plugin-blockers.js", () => ({
  scanConfiguredChannelPluginBlockers: (cfg: {
    channels?: Record<string, unknown>;
    plugins?: { enabled?: boolean; entries?: Record<string, { enabled?: boolean }> };
  }) => {
    const configuredChannels = new Set(Object.keys(cfg.channels ?? {}));
    return manifestState.plugins.flatMap((plugin) => {
      const disabledByEntry = cfg.plugins?.entries?.[plugin.id]?.enabled === false;
      const pluginsDisabled = cfg.plugins?.enabled === false;
      if (!disabledByEntry && !pluginsDisabled) {
        return [];
      }
      return plugin.channels
        .filter((channelId) => configuredChannels.has(channelId))
        .map((channelId) => ({
          channelId,
          pluginId: plugin.id,
          reason: disabledByEntry ? "disabled in config" : "plugins disabled",
        }));
    });
  },
  collectConfiguredChannelPluginBlockerWarnings: (
    hits: Array<{ channelId: string; pluginId: string; reason: string }>,
  ) =>
    hits.map((hit) => {
      const reason =
        hit.reason === "disabled in config"
          ? `plugin "${hit.pluginId}" is disabled by plugins.entries.${hit.pluginId}.enabled=false.`
          : "plugins.enabled=false blocks channel plugins globally.";
      return `- channels.${hit.channelId}: channel is configured, but ${reason}`;
    }),
  isWarningBlockedByChannelPlugin: (warning: string, hits: Array<{ channelId: string }>) =>
    hits.some(
      (hit) =>
        warning.includes(`channels.${hit.channelId}:`) ||
        warning.includes(`channels.${hit.channelId}.`),
    ),
}));

vi.mock("./stale-plugin-config.js", () => ({
  scanStalePluginConfig: (cfg: {
    plugins?: { allow?: string[]; entries?: Record<string, unknown> };
  }) => {
    const knownIds = new Set(manifestState.plugins.map((plugin) => plugin.id));
    const ids = [...(cfg.plugins?.allow ?? []), ...Object.keys(cfg.plugins?.entries ?? {})];
    return [...new Set(ids)].filter((id) => !knownIds.has(id)).map((id) => ({ id }));
  },
  isStalePluginAutoRepairBlocked: () =>
    manifestState.diagnostics.some((diagnostic) => diagnostic.level === "error"),
  collectStalePluginConfigWarnings: ({
    autoRepairBlocked,
    doctorFixCommand,
    hits,
  }: {
    autoRepairBlocked: boolean;
    doctorFixCommand: string;
    hits: Array<{ id: string }>;
  }) =>
    hits.map(
      (hit) =>
        `plugins.allow: stale plugin reference "${hit.id}". plugins.entries.${hit.id} is unused. ${
          autoRepairBlocked
            ? `Auto-removal is paused; rerun "${doctorFixCommand}".`
            : `Run "${doctorFixCommand}".`
        }`,
    ),
}));

vi.mock("./bundled-plugin-load-paths.js", () => ({
  scanBundledPluginLoadPathMigrations: (cfg: { plugins?: { load?: { paths?: string[] } } }) =>
    (cfg.plugins?.load?.paths ?? []).map((legacyPath) => ({ legacyPath })),
  collectBundledPluginLoadPathWarnings: ({
    doctorFixCommand,
    hits,
  }: {
    doctorFixCommand: string;
    hits: Array<{ legacyPath: string }>;
  }) =>
    hits.map(
      (hit) =>
        `plugins.load.paths: legacy bundled plugin path "${hit.legacyPath}". Run "${doctorFixCommand}".`,
    ),
}));

function manifest(id: string): TestManifestRecord {
  return {
    id,
    channels: [],
  };
}

function channelManifest(id: string, channelId: string): TestManifestRecord {
  return {
    ...manifest(id),
    channels: [channelId],
  };
}

function stalePluginConfig(id = "acpx") {
  return {
    plugins: {
      allow: [id],
      entries: {
        [id]: { enabled: true },
      },
    },
  };
}

describe("doctor preview warnings", () => {
  beforeEach(() => {
    manifestState.plugins = [manifest("discord")];
    manifestState.diagnostics = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects provider and shared preview warnings", async () => {
    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["@alice"],
          },
          signal: {
            dmPolicy: "open",
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(
      warnings.some(
        (warning) =>
          warning.includes("Telegram allowFrom contains 1") && warning.includes("(e.g. @alice)"),
      ),
    ).toBe(true);
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('channels.signal.allowFrom: set to ["*"]')]),
    );
  });

  it("sanitizes empty-allowlist warning paths before returning preview output", async () => {
    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          signal: {
            accounts: {
              "ops\u001B[31m-team\u001B[0m\r\nnext": {
                dmPolicy: "allowlist",
              },
            },
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining("channels.signal.accounts.ops-teamnext.dmPolicy"),
    ]);
    expect(warnings[0]).not.toContain("\u001B");
    expect(warnings[0]).not.toContain("\r");
  });

  it("includes stale plugin config warnings", async () => {
    const warnings = await collectDoctorPreviewWarnings({
      cfg: stalePluginConfig(),
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining('plugins.allow: stale plugin reference "acpx"'),
    ]);
    expect(warnings[0]).toContain("plugins.entries.acpx");
    expect(warnings[0]).toContain('Run "openclaw doctor --fix"');
    expect(warnings[0]).not.toContain("Auto-removal is paused");
  });

  it("includes bundled plugin load path migration warnings", async () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const legacyPath = path.join(packageRoot, "extensions", "feishu");
    manifestState.plugins = [manifest("feishu")];

    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        plugins: {
          load: {
            paths: [legacyPath],
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining(`plugins.load.paths: legacy bundled plugin path "${legacyPath}"`),
    ]);
    expect(warnings[0]).toContain('Run "openclaw doctor --fix"');
  });

  it("warns but skips auto-removal when plugin discovery has errors", async () => {
    manifestState.plugins = [];
    manifestState.diagnostics = [
      { level: "error", message: "plugin path not found: /missing", source: "/missing" },
    ];

    const warnings = await collectDoctorPreviewWarnings({
      cfg: stalePluginConfig(),
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining('plugins.allow: stale plugin reference "acpx"'),
    ]);
    expect(warnings[0]).toContain("Auto-removal is paused");
    expect(warnings[0]).toContain('rerun "openclaw doctor --fix"');
  });

  it("warns when a configured channel plugin is disabled explicitly", async () => {
    manifestState.plugins = [channelManifest("telegram", "telegram")];

    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          telegram: {
            botToken: "123:abc",
            groupPolicy: "allowlist",
          },
        },
        plugins: {
          entries: {
            telegram: {
              enabled: false,
            },
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining(
        'channels.telegram: channel is configured, but plugin "telegram" is disabled by plugins.entries.telegram.enabled=false.',
      ),
    ]);
    expect(warnings[0]).not.toContain("first-time setup mode");
  });

  it("warns when channel plugins are blocked globally", async () => {
    manifestState.plugins = [channelManifest("telegram", "telegram")];

    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          telegram: {
            botToken: "123:abc",
            groupPolicy: "allowlist",
          },
        },
        plugins: {
          enabled: false,
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining(
        "channels.telegram: channel is configured, but plugins.enabled=false blocks channel plugins globally.",
      ),
    ]);
    expect(warnings[0]).not.toContain("first-time setup mode");
  });
});
