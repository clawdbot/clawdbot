import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectChannelBoundMessageToolPolicyWarnings,
  collectDoctorPreviewWarnings,
  collectVisibleReplyToolPolicyWarnings,
} from "./preview-warnings.js";

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
  createChannelDoctorEmptyAllowlistPolicyHooks: vi.fn(() => ({
    extraWarningsForAccount: () => [],
    shouldSkipDefaultEmptyGroupAllowlistWarning: () => false,
  })),
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
    channels?: Record<string, unknown>;
  }) => {
    const knownIds = new Set(manifestState.plugins.map((plugin) => plugin.id));
    const hits = [...(cfg.plugins?.allow ?? []), ...Object.keys(cfg.plugins?.entries ?? {})]
      .filter((id) => !knownIds.has(id))
      .map((id) => ({ id, surface: "plugin" }));
    if (cfg.channels?.["openclaw-weixin"]) {
      hits.push({ id: "openclaw-weixin", surface: "channel" });
    }
    return hits.filter(
      (hit, index) => hits.findIndex((candidate) => candidate.id === hit.id) === index,
    );
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
    hits: Array<{ id: string; surface: string }>;
  }) =>
    hits.map((hit) => {
      const prefix =
        hit.surface === "channel"
          ? `channels.${hit.id}: dangling channel config.`
          : `plugins.allow: stale plugin reference "${hit.id}". plugins.entries.${hit.id} is unused.`;
      return `${prefix} ${
        autoRepairBlocked
          ? `Auto-removal is paused; rerun "${doctorFixCommand}".`
          : `Run "${doctorFixCommand}".`
      }`;
    }),
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

function expectSingleWarningContaining(warnings: string[], text: string): string {
  expect(warnings).toHaveLength(1);
  const warning = warnings[0];
  expect(warning).toContain(text);
  return warning;
}

function expectWarningsContaining(warnings: string[], texts: string[]): void {
  expect(warnings).toHaveLength(texts.length);
  texts.forEach((text, index) => {
    expect(warnings[index]).toContain(text);
  });
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
    expect(
      warnings.some((warning) => warning.includes('channels.signal.allowFrom: set to ["*"]')),
    ).toBe(true);
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

    const warning = expectSingleWarningContaining(
      warnings,
      "channels.signal.accounts.ops-teamnext.dmPolicy",
    );
    expect(warning).not.toContain("\u001B");
    expect(warning).not.toContain("\r");
  });

  it("includes stale plugin config warnings", async () => {
    const warnings = await collectDoctorPreviewWarnings({
      cfg: stalePluginConfig(),
      doctorFixCommand: "openclaw doctor --fix",
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'plugins.allow: stale plugin reference "acpx"',
    );
    expect(warning).toContain("plugins.entries.acpx");
    expect(warning).toContain('Run "openclaw doctor --fix"');
    expect(warning).not.toContain("Auto-removal is paused");
  });

  it("includes stale channel config warnings without plugin config", async () => {
    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          "openclaw-weixin": {
            enabled: true,
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expectSingleWarningContaining(warnings, "channels.openclaw-weixin: dangling channel config");
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

    const warning = expectSingleWarningContaining(
      warnings,
      `plugins.load.paths: legacy bundled plugin path "${legacyPath}"`,
    );
    expect(warning).toContain('Run "openclaw doctor --fix"');
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

    const warning = expectSingleWarningContaining(
      warnings,
      'plugins.allow: stale plugin reference "acpx"',
    );
    expect(warning).toContain("Auto-removal is paused");
    expect(warning).toContain('rerun "openclaw doctor --fix"');
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

    const warning = expectSingleWarningContaining(
      warnings,
      'channels.telegram: channel is configured, but plugin "telegram" is disabled by plugins.entries.telegram.enabled=false.',
    );
    expect(warning).not.toContain("first-time setup mode");
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

    const warning = expectSingleWarningContaining(
      warnings,
      "channels.telegram: channel is configured, but plugins.enabled=false blocks channel plugins globally.",
    );
    expect(warning).not.toContain("first-time setup mode");
  });

  it("keeps global plugin-disable blocker warnings but omits stale plugin cleanup warnings", async () => {
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
          allow: ["acpx"],
          entries: {
            acpx: { enabled: true },
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expectSingleWarningContaining(
      warnings,
      "channels.telegram: channel is configured, but plugins.enabled=false blocks channel plugins globally.",
    );
    expect(warnings.join("\n")).not.toContain("stale plugin reference");
  });

  it("warns softly when default group visible replies need an unavailable message tool", () => {
    const warnings = collectVisibleReplyToolPolicyWarnings({
      channels: {
        slack: {},
      },
      tools: {
        allow: ["read"],
      },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'messages.groupChat.visibleReplies defaults to "message_tool"',
    );
    expect(warning).toContain("message tool is unavailable");
    expect(warning).toContain("falls back to automatic group/channel replies");
  });

  it("warns strongly when explicit group visible replies require an unavailable message tool", () => {
    const warnings = collectVisibleReplyToolPolicyWarnings({
      messages: {
        groupChat: {
          visibleReplies: "message_tool",
        },
      },
      tools: {
        profile: "coding",
      },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'messages.groupChat.visibleReplies is set to "message_tool"',
    );
    expect(warning).toContain("normal replies may post to the source chat");
    expect(warning).toContain('set messages.groupChat.visibleReplies to "automatic"');
  });

  it("warns for direct chats when global visible replies are tool-only but groups override automatic", () => {
    const warnings = collectVisibleReplyToolPolicyWarnings({
      messages: {
        visibleReplies: "message_tool",
        groupChat: {
          visibleReplies: "automatic",
        },
      },
      tools: {
        allow: ["read"],
      },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'messages.visibleReplies is set to "message_tool"',
    );
    expect(warning).toContain("automatic direct-chat replies");
  });

  it("warns separately for explicit global and group visible reply policy mismatches", () => {
    const warnings = collectVisibleReplyToolPolicyWarnings({
      messages: {
        visibleReplies: "message_tool",
        groupChat: {
          visibleReplies: "message_tool",
        },
      },
      tools: {
        allow: ["read"],
      },
    });

    expectWarningsContaining(warnings, [
      'messages.groupChat.visibleReplies is set to "message_tool"',
      'messages.visibleReplies is set to "message_tool"',
    ]);
  });

  it("skips visible reply tool warnings when the message tool is available or default groups are unused", () => {
    expect(
      collectVisibleReplyToolPolicyWarnings({
        channels: {
          slack: {},
        },
        tools: {
          profile: "messaging",
        },
      }),
    ).toStrictEqual([]);
    expect(
      collectVisibleReplyToolPolicyWarnings({
        tools: {
          allow: ["read"],
        },
      }),
    ).toStrictEqual([]);
  });

  it("warns when a channel route targets an agent without the message tool", () => {
    const warnings = collectChannelBoundMessageToolPolicyWarnings({
      agents: {
        list: [
          {
            id: "commander",
            tools: {
              allow: ["read", "write"],
            },
          },
          {
            id: "support",
            tools: {
              profile: "messaging",
            },
          },
        ],
      },
      bindings: [
        {
          agentId: "commander",
          match: {
            channel: "discord",
          },
        },
        {
          agentId: "support",
          match: {
            channel: "telegram",
          },
        },
      ],
    });

    expect(warnings).toEqual([
      '- Agent "commander" is routed from channel "discord", but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.',
    ]);
    expect(warnings.join("\n")).not.toContain("support");
  });

  it("warns for the default agent when configured channels have no explicit routes", () => {
    const warnings = collectChannelBoundMessageToolPolicyWarnings({
      channels: {
        defaults: {
          groupPolicy: "allowlist",
        },
        discord: {},
        slack: {
          enabled: false,
        },
        telegram: {},
      },
      tools: {
        allow: ["read"],
      },
    });

    expect(warnings).toEqual([
      '- Agent "main" is routed from channel "discord" and "telegram", but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.',
    ]);
    expect(warnings.join("\n")).not.toContain("slack");
    expect(warnings.join("\n")).not.toContain("defaults");
  });

  it("warns only for configured channels not covered by channel routes", () => {
    const warnings = collectChannelBoundMessageToolPolicyWarnings({
      channels: {
        discord: {},
        telegram: {},
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              allow: ["read"],
            },
          },
          {
            id: "commander",
            tools: {
              profile: "messaging",
            },
          },
        ],
      },
      bindings: [
        {
          agentId: "commander",
          match: {
            channel: "discord",
          },
        },
      ],
    });

    expect(warnings).toEqual([
      '- Agent "main" is routed from channel "telegram", but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.',
    ]);
    expect(warnings.join("\n")).not.toContain("discord");
    expect(warnings.join("\n")).not.toContain("commander");
  });

  it("warns for default-routed traffic when a channel only has scoped routes", () => {
    const warnings = collectChannelBoundMessageToolPolicyWarnings({
      channels: {
        discord: {},
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              allow: ["read"],
            },
          },
          {
            id: "commander",
            tools: {
              profile: "messaging",
            },
          },
        ],
      },
      bindings: [
        {
          agentId: "commander",
          match: {
            channel: "discord",
            accountId: "workspace-1",
          },
        },
      ],
    });

    expect(warnings).toEqual([
      '- Agent "main" is routed from channel "discord", but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.',
    ]);
    expect(warnings.join("\n")).not.toContain("commander");
  });

  it("skips the default-agent warning when a wildcard account route covers the channel", () => {
    const warnings = collectChannelBoundMessageToolPolicyWarnings({
      channels: {
        discord: {},
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              allow: ["read"],
            },
          },
          {
            id: "commander",
            tools: {
              profile: "messaging",
            },
          },
        ],
      },
      bindings: [
        {
          agentId: "commander",
          match: {
            channel: "discord",
            accountId: "*",
          },
        },
      ],
    });

    expect(warnings).toStrictEqual([]);
  });

  it("skips the default-agent warning when configured accounts are fully covered", () => {
    const warnings = collectChannelBoundMessageToolPolicyWarnings({
      channels: {
        discord: {
          accounts: {
            personal: {},
            work: {},
          },
        },
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              allow: ["read"],
            },
          },
          {
            id: "personal-agent",
            tools: {
              profile: "messaging",
            },
          },
          {
            id: "work-agent",
            tools: {
              profile: "messaging",
            },
          },
        ],
      },
      bindings: [
        {
          agentId: "personal-agent",
          match: {
            channel: "Discord",
            accountId: "personal",
          },
        },
        {
          agentId: "work-agent",
          match: {
            channel: "Discord",
            accountId: "work",
          },
        },
      ],
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not treat channel aliases as route coverage when runtime would not match them", () => {
    const warnings = collectChannelBoundMessageToolPolicyWarnings({
      channels: {
        imessage: {},
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              allow: ["read"],
            },
          },
          {
            id: "ios-agent",
            tools: {
              profile: "messaging",
            },
          },
        ],
      },
      bindings: [
        {
          agentId: "ios-agent",
          match: {
            channel: "imsg",
          },
        },
      ],
    });

    expect(warnings).toEqual([
      '- Agent "main" is routed from channel "imessage", but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.',
    ]);
    expect(warnings.join("\n")).not.toContain("ios-agent");
    expect(warnings.join("\n")).not.toContain("imsg");
  });

  it("warns for the default agent when configured account routes are incomplete", () => {
    const warnings = collectChannelBoundMessageToolPolicyWarnings({
      channels: {
        discord: {
          accounts: {
            personal: {},
            work: {},
          },
        },
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              allow: ["read"],
            },
          },
          {
            id: "personal-agent",
            tools: {
              profile: "messaging",
            },
          },
        ],
      },
      bindings: [
        {
          agentId: "personal-agent",
          match: {
            channel: "discord",
            accountId: "personal",
          },
        },
      ],
    });

    expect(warnings).toEqual([
      '- Agent "main" is routed from channel "discord", but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.',
    ]);
    expect(warnings.join("\n")).not.toContain("personal-agent");
  });
});
