// Preview warning tests cover doctor warnings for preview or experimental config state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { collectDoctorPreviewNotes } from "./preview-warnings.js";

async function collectDoctorPreviewWarnings(
  params: Parameters<typeof collectDoctorPreviewNotes>[0],
): Promise<string[]> {
  return (await collectDoctorPreviewNotes(params)).warningNotes;
}

async function collectProfileConfiguredToolSectionWarningsThroughDoctor(
  cfg: OpenClawConfig,
): Promise<string[]> {
  const warnings = await collectDoctorPreviewWarnings({
    cfg,
    doctorFixCommand: "openclaw doctor --fix",
  });
  return warnings.filter((warning) => warning.includes("is configured, but configured sections"));
}

async function collectVisibleReplyToolPolicyWarningsThroughDoctor(
  cfg: OpenClawConfig,
): Promise<string[]> {
  const warnings = await collectDoctorPreviewWarnings({
    cfg,
    doctorFixCommand: "openclaw doctor --fix",
  });
  return warnings.filter((warning) => warning.includes("visibleReplies is set"));
}

async function collectChannelBoundMessageToolPolicyWarningsThroughDoctor(
  cfg: OpenClawConfig,
): Promise<string[]> {
  const warnings = await collectDoctorPreviewWarnings({
    cfg,
    doctorFixCommand: "openclaw doctor --fix",
  });
  return warnings.filter((warning) => warning.includes("is routed from channel"));
}

type TestManifestRecord = {
  id: string;
  channels: string[];
  origin?: "bundled" | "global";
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

const staleOAuthShadowState = vi.hoisted(() => ({
  warnings: [] as string[],
}));

const staleAuthOrderState = vi.hoisted(() => ({
  warnings: [] as string[],
}));

const activeToolSchemaState = vi.hoisted(() => ({
  warnings: [] as string[],
}));

const commandSecretState = vi.hoisted(() => ({
  targetIds: new Set<string>(),
  resolvedConfig: undefined as OpenClawConfig | undefined,
  diagnostics: [] as string[],
}));

const tempRoots = new Set<string>();

vi.mock("../../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: vi.fn(async (params: { config: OpenClawConfig }) => ({
    resolvedConfig: commandSecretState.resolvedConfig ?? params.config,
    diagnostics: commandSecretState.diagnostics,
    targetStatesByPath: {},
    hadUnresolvedTargets: false,
  })),
}));

vi.mock("../../../cli/command-secret-targets.js", () => ({
  getConfiguredChannelsCommandSecretTargetIds: vi.fn(() => commandSecretState.targetIds),
}));

vi.mock("../channel-capabilities.js", () => {
  const fallback = {
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: true,
    warnOnEmptyGroupSenderAllowlist: true,
  };
  return {
    getDoctorChannelCapabilities: () => fallback,
    resolveDoctorChannelAccountIds: () => undefined,
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
  scanConfiguredChannelPluginBlockers: (
    cfg: {
      channels?: Record<string, unknown>;
      plugins?: {
        allow?: string[];
        enabled?: boolean;
        entries?: Record<string, { enabled?: boolean }>;
      };
    },
    env: NodeJS.ProcessEnv = process.env,
    activationSourceConfig = cfg,
  ) => {
    const configuredChannels = new Set(Object.keys(cfg.channels ?? {}));
    if (Object.keys(env).some((key) => key.startsWith("TELEGRAM_"))) {
      configuredChannels.add("telegram");
    }
    if (Object.keys(env).some((key) => key.startsWith("DISCORD_"))) {
      configuredChannels.add("discord");
    }
    const hits: Array<{
      channelId: string;
      pluginId: string;
      reason: string;
      channelAvailable?: boolean;
    }> = manifestState.plugins.flatMap((plugin) => {
      const sourcePlugins = activationSourceConfig.plugins;
      const disabledByEntry = sourcePlugins?.entries?.[plugin.id]?.enabled === false;
      const pluginsDisabled = sourcePlugins?.enabled === false;
      const isExternal = plugin.origin === "global";
      const omittedFromAllowlist =
        isExternal &&
        (sourcePlugins?.allow ?? []).length > 0 &&
        !(sourcePlugins?.allow ?? []).includes(plugin.id);
      const missingExplicitTrust =
        isExternal &&
        sourcePlugins?.entries?.[plugin.id]?.enabled !== true &&
        !(sourcePlugins?.allow ?? []).includes(plugin.id);
      if (!disabledByEntry && !pluginsDisabled && !omittedFromAllowlist && !missingExplicitTrust) {
        return [];
      }
      return plugin.channels
        .filter((channelId) => configuredChannels.has(channelId))
        .map((channelId) => ({
          channelId,
          pluginId: plugin.id,
          reason: disabledByEntry
            ? "disabled in config"
            : pluginsDisabled
              ? "plugins disabled"
              : omittedFromAllowlist
                ? "not in allowlist"
                : "missing explicit enablement",
        }));
    });
    const blockedPluginIds = new Set(hits.map((hit) => hit.pluginId));
    const availableChannelIds = new Set(
      manifestState.plugins
        .filter((plugin) => !blockedPluginIds.has(plugin.id))
        .flatMap((plugin) =>
          plugin.channels.filter((channelId) => configuredChannels.has(channelId)),
        ),
    );
    for (const hit of hits) {
      if (availableChannelIds.has(hit.channelId)) {
        hit.channelAvailable = true;
      }
    }
    return hits;
  },
  collectConfiguredChannelPluginBlockerWarnings: (
    hits: Array<{ channelId: string; pluginId: string; reason: string }>,
  ) =>
    hits.map((hit) => {
      const reason =
        hit.reason === "disabled in config"
          ? `plugin "${hit.pluginId}" is disabled by plugins.entries.${hit.pluginId}.enabled=false.`
          : hit.reason === "plugins disabled"
            ? "plugins.enabled=false blocks channel plugins globally."
            : hit.reason === "not in allowlist"
              ? `external plugin "${hit.pluginId}" is installed but omitted from plugins.allow. Include "${hit.pluginId}" in plugins.allow.`
              : `external plugin "${hit.pluginId}" is installed without explicit trust. Add plugins.entries.${hit.pluginId}.enabled=true.`;
      return `- channels.${hit.channelId}: channel is configured, but ${reason}`;
    }),
  isWarningBlockedByChannelPlugin: (
    warning: string,
    hits: Array<{ channelId: string; channelAvailable?: boolean }>,
  ) =>
    hits.some(
      (hit) =>
        !hit.channelAvailable &&
        (warning.includes(`channels.${hit.channelId}:`) ||
          warning.includes(`channels.${hit.channelId}.`)),
    ),
}));

vi.mock("./stale-plugin-config.js", () => ({
  scanStalePluginConfig: (cfg: {
    plugins?: { allow?: string[]; entries?: Record<string, unknown> };
    channels?: Record<string, unknown>;
  }) => {
    const knownIds = new Set(manifestState.plugins.map((plugin) => plugin.id));
    const hits = [
      ...(cfg.plugins?.allow ?? []).map((id) => ({ id, surface: "allow" })),
      ...Object.keys(cfg.plugins?.entries ?? {}).map((id) => ({ id, surface: "entries" })),
    ].filter((hit) => !knownIds.has(hit.id));
    if (cfg.channels?.["openclaw-weixin"]) {
      hits.push({ id: "openclaw-weixin", surface: "channel" });
    }
    return hits.filter(
      (hit, index) =>
        hits.findIndex(
          (candidate) => candidate.id === hit.id && candidate.surface === hit.surface,
        ) === index,
    );
  },
  isStalePluginAutoRepairBlocked: () =>
    manifestState.diagnostics.some((diagnostic) => diagnostic.level === "error"),
  collectStalePluginConfigWarnings: ({
    autoRepairBlocked,
    doctorFixCommand,
    hits,
    surfacePreservePluginIds,
  }: {
    autoRepairBlocked: boolean;
    doctorFixCommand: string;
    hits: Array<{ id: string; surface: string }>;
    surfacePreservePluginIds?: Record<string, ReadonlySet<string>>;
  }) => {
    const actionableHits = hits.filter(
      (hit) => !surfacePreservePluginIds?.[hit.surface]?.has(hit.id),
    );
    if (actionableHits.length === 0) {
      return [];
    }
    const pluginIds = actionableHits
      .filter((hit) => hit.surface !== "channel")
      .map((hit) => hit.id)
      .toSorted();
    const lines = [
      pluginIds.length > 0
        ? `Stale plugin references (plugins.allow/deny/entries): ${pluginIds.join(", ")}.`
        : null,
      ...actionableHits
        .filter((hit) => hit.surface === "channel")
        .map((hit) => `channels.${hit.id}: dangling channel config.`),
      autoRepairBlocked
        ? `Auto-removal is paused; rerun "${doctorFixCommand}".`
        : `Run "${doctorFixCommand}".`,
    ];
    return lines.filter((line): line is string => line !== null);
  },
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

vi.mock("./stale-oauth-profile-shadows.js", () => ({
  scanStaleOAuthProfileShadows: () =>
    staleOAuthShadowState.warnings.map((warning, index) => ({ profileId: String(index), warning })),
  collectStaleOAuthProfileShadowWarnings: ({ hits }: { hits: Array<{ warning: string }> }) =>
    hits.map((hit) => hit.warning),
}));

vi.mock("./stale-auth-order.js", () => ({
  collectStaleConfiguredAuthOrderWarnings: () => staleAuthOrderState.warnings,
}));

vi.mock("./active-tool-schema-warnings.js", () => ({
  collectActiveToolSchemaProjectionWarnings: () => activeToolSchemaState.warnings,
}));

vi.mock("./codex-route-warnings.js", () => ({
  collectCodexRouteWarnings: vi.fn(() => []),
}));

vi.mock("./context-engine-host-compat.js", () => ({
  collectContextEngineHostCompatibilityWarnings: vi.fn(async () => []),
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

function externalChannelManifest(id: string, channelId: string): TestManifestRecord {
  return {
    ...channelManifest(id, channelId),
    origin: "global",
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
  return expectDefined(warning, "warning test invariant");
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
    staleOAuthShadowState.warnings = [];
    staleAuthOrderState.warnings = [];
    activeToolSchemaState.warnings = [];
    commandSecretState.targetIds = new Set<string>();
    commandSecretState.resolvedConfig = undefined;
    commandSecretState.diagnostics = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it("routes personal Codex asset notices to info instead of warnings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preview-codex-assets-"));
    tempRoots.add(root);
    const codexHome = path.join(root, ".codex");
    await fs.mkdir(path.join(root, ".agents", "skills", "agent-helper"), { recursive: true });
    await fs.writeFile(path.join(root, ".agents", "skills", "agent-helper", "SKILL.md"), "");

    const notes = await collectDoctorPreviewNotes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: true },
          },
        },
        agents: {
          defaults: {
            agentRuntime: {
              id: "codex",
            },
          },
        },
      } as unknown as OpenClawConfig,
      doctorFixCommand: "openclaw doctor --fix",
      env: { CODEX_HOME: codexHome, HOME: root },
    });

    expect(notes.infoNotes.join("\n")).toContain("Personal Codex CLI assets found");
    expect(notes.warningNotes.join("\n")).not.toContain("Personal Codex CLI assets found");
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

  it("resolves configured channel SecretRefs before collecting channel preview warnings", async () => {
    const rawConfig = {
      channels: {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig = {
      channels: {
        telegram: {
          botToken: "resolved-token",
          allowFrom: ["@alice"],
        },
      },
    } as unknown as OpenClawConfig;
    commandSecretState.targetIds = new Set(["channels.telegram.botToken"]);
    commandSecretState.resolvedConfig = resolvedConfig;
    commandSecretState.diagnostics = [
      "doctor preview: gateway secrets.resolve unavailable (gateway closed); resolved command secrets locally.",
    ];

    const { resolveCommandSecretRefsViaGateway } =
      await import("../../../cli/command-secret-gateway.js");
    const notes = await collectDoctorPreviewNotes({
      cfg: rawConfig,
      doctorFixCommand: "openclaw doctor --fix",
      env: {},
    });

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config: rawConfig,
      commandName: "doctor preview",
      targetIds: commandSecretState.targetIds,
      mode: "read_only_status",
      allowLocalExecSecretRefs: false,
      scrubUnresolvedSecretRefs: false,
    });
    expect(notes.warningNotes).toContain(commandSecretState.diagnostics[0]);
    expect(
      notes.warningNotes.some(
        (warning) =>
          warning.includes("Telegram allowFrom contains 1") && warning.includes("(e.g. @alice)"),
      ),
    ).toBe(true);
  });

  it("allows doctor preview to opt into local exec SecretRef resolution", async () => {
    commandSecretState.targetIds = new Set(["channels.telegram.botToken"]);
    const { resolveCommandSecretRefsViaGateway } =
      await import("../../../cli/command-secret-gateway.js");

    await collectDoctorPreviewNotes({
      cfg: {
        channels: {
          telegram: {
            botToken: { source: "exec", provider: "default", id: "telegram/bot-token" },
          },
        },
      } as unknown as OpenClawConfig,
      doctorFixCommand: "openclaw doctor --fix",
      env: {},
      allowExec: true,
    });

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowLocalExecSecretRefs: true,
        scrubUnresolvedSecretRefs: false,
      }),
    );
  });

  it("warns when a normalized legacy Codex provider cannot be auto-merged", async () => {
    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        models: {
          providers: {
            openai: {
              api: "openai-chatgpt-responses",
              baseUrl: "https://api.openai.com/v1",
              params: { store: true },
              models: [{ id: "text-embedding-3-small" }],
            },
            "openai-codex": {
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              models: [{ id: "gpt-5.5", api: "openai-chatgpt-responses" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      doctorFixCommand: "openclaw doctor --fix",
    });

    const warning = expectSingleWarningContaining(
      warnings,
      "models.providers.openai-codex cannot be merged automatically",
    );
    expect(warning).toContain("models.providers.openai.params");
    expect(warning).toContain("Move the affected model/provider defaults manually");
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
      "Stale plugin references (plugins.allow/deny/entries): acpx",
    );
    expect(warning).toContain('Run "openclaw doctor --fix"');
    expect(warning).not.toContain("Auto-removal is paused");
  });

  it("omits stale cleanup warnings for version-bound Codex policy", async () => {
    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        plugins: {
          allow: ["codex"],
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings.join("\n")).not.toContain("Stale plugin references");
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

  it("includes stale OAuth profile shadow warnings", async () => {
    staleOAuthShadowState.warnings = [
      '- ~/.openclaw/agents/telegram/agent/auth-profiles.json has stale OAuth auth profile openai-codex:default. Run "openclaw doctor --fix".',
    ];

    const warnings = await collectDoctorPreviewWarnings({
      cfg: {},
      doctorFixCommand: "openclaw doctor --fix",
    });

    expectSingleWarningContaining(warnings, "stale OAuth auth profile openai-codex:default");
  });

  it("includes stale configured auth-order warnings", async () => {
    staleAuthOrderState.warnings = [
      "- auth.order.anthropic references only missing profiles while compatible stored credentials exist; run openclaw doctor --fix to remove the stale override and restore automatic selection.",
    ];

    const warnings = await collectDoctorPreviewWarnings({
      cfg: {},
      doctorFixCommand: "openclaw doctor --fix",
    });

    expectSingleWarningContaining(
      warnings,
      "auth.order.anthropic references only missing profiles",
    );
  });

  it("includes active tool schema projection warnings", async () => {
    activeToolSchemaState.warnings = [
      '- agents.main: active tool "fuzzplugin_move_angles" from plugin "fuzzplugin" has unsupported runtime input schema.',
    ];

    const warnings = await collectDoctorPreviewWarnings({
      cfg: { tools: { allow: ["fuzzplugin_move_angles"] } },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(
      warnings.some((warning) => warning.includes('active tool "fuzzplugin_move_angles"')),
    ).toBe(true);
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
      "Stale plugin references (plugins.allow/deny/entries): acpx",
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

  it("warns when a configured external channel plugin lacks explicit trust", async () => {
    manifestState.plugins = [externalChannelManifest("discord", "discord")];

    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          discord: {
            enabled: true,
            token: {
              source: "env",
              provider: "default",
              id: "DISCORD_BOT_TOKEN",
            },
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'channels.discord: channel is configured, but external plugin "discord" is installed without explicit trust.',
    );
    expect(warning).toContain("plugins.entries.discord.enabled=true");
    expect(warning).not.toContain("plugins.allow");
    expect(warning).not.toContain("first-time setup mode");
  });

  it("preserves empty-allowlist warnings when a blocked plugin has an active co-owner", async () => {
    manifestState.plugins = [
      channelManifest("bundled-chat", "shared-chat"),
      externalChannelManifest("external-chat", "shared-chat"),
    ];

    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          "shared-chat": {
            groupPolicy: "allowlist",
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings.join("\n")).toContain(
      'channels.shared-chat: channel is configured, but external plugin "external-chat" is installed without explicit trust.',
    );
    expect(warnings.join("\n")).toContain("channels.shared-chat.groupPolicy");
  });

  it("warns for an external-only manifest env channel whose effective owner lacks source trust", async () => {
    manifestState.plugins = [externalChannelManifest("discord", "discord")];

    const notes = await collectDoctorPreviewNotes({
      cfg: {
        plugins: {
          entries: {
            discord: {
              enabled: true,
            },
          },
        },
      },
      activationSourceConfig: {},
      doctorFixCommand: "openclaw doctor --fix",
      env: {
        DISCORD_BOT_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
    });

    const warning = expectSingleWarningContaining(
      notes.warningNotes,
      'channels.discord: channel is configured, but external plugin "discord" is installed without explicit trust.',
    );
    expect(warning).toContain("plugins.entries.discord.enabled=true");
  });

  it("warns when a configured external channel plugin is omitted from plugins.allow", async () => {
    manifestState.plugins = [
      externalChannelManifest("discord", "discord"),
      channelManifest("brave", "brave"),
    ];

    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        plugins: {
          allow: ["brave"],
        },
        channels: {
          discord: {
            enabled: true,
            token: {
              source: "env",
              provider: "default",
              id: "DISCORD_BOT_TOKEN",
            },
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'channels.discord: channel is configured, but external plugin "discord" is installed but omitted from plugins.allow.',
    );
    expect(warning).toContain('Include "discord" in plugins.allow');
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

  it("warns without suggesting fix when configured tool sections need explicit profile grants", async () => {
    const warnings = await collectDoctorPreviewWarnings({
      cfg: {
        tools: {
          profile: "messaging",
          exec: {
            security: "allowlist",
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    const warning = expectSingleWarningContaining(warnings, 'tools.profile is "messaging"');
    expect(warning).toContain("tools.exec is configured");
    expect(warning).toContain('tools.alsoAllow: ["exec", "process"]');
    expect(warning).not.toContain("doctor --fix");
  });

  it("does not suggest alsoAllow when configured section warnings already have allow", async () => {
    const warnings = await collectProfileConfiguredToolSectionWarningsThroughDoctor({
      tools: {
        profile: "messaging",
      },
      agents: {
        list: [
          {
            id: "sage",
            tools: {
              allow: ["message"],
              exec: {
                security: "allowlist",
              },
            },
          },
        ],
      },
    });

    const warning = expectSingleWarningContaining(warnings, "agents.list[0].tools.profile");
    expect(warning).toContain("Add these grants to agents.list[0].tools.allow");
    expect(warning).toContain('set agents.list[0].tools.profile to "full"');
    expect(warning).not.toContain("agents.list[0].tools.alsoAllow");
  });

  it("warns when an agent tool section inherits a restrictive provider profile", async () => {
    const warnings = await collectProfileConfiguredToolSectionWarningsThroughDoctor({
      tools: {
        byProvider: {
          openai: {
            profile: "messaging",
          },
        },
      },
      agents: {
        list: [
          {
            id: "sage",
            tools: {
              exec: {
                security: "allowlist",
              },
            },
          },
        ],
      },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'tools.byProvider.openai.profile is "messaging"',
    );
    expect(warning).toContain("agents.list[0].tools.exec is configured");
    expect(warning).toContain(
      'agents.list[0].tools.byProvider.openai.alsoAllow: ["exec", "process"]',
    );
  });

  it("uses inherited provider alsoAllow for agent provider profile warnings", async () => {
    const warnings = await collectProfileConfiguredToolSectionWarningsThroughDoctor({
      tools: {
        byProvider: {
          openai: {
            alsoAllow: ["exec", "process"],
          },
        },
      },
      agents: {
        list: [
          {
            id: "sage",
            tools: {
              exec: {
                security: "allowlist",
              },
              byProvider: {
                "openai/gpt-5": {
                  profile: "messaging",
                },
              },
            },
          },
        ],
      },
    });

    expect(warnings).toStrictEqual([]);
  });

  it("uses model-scoped agent provider overrides for inherited provider warnings", async () => {
    const warnings = await collectProfileConfiguredToolSectionWarningsThroughDoctor({
      tools: {
        byProvider: {
          openai: {
            profile: "messaging",
          },
        },
      },
      agents: {
        list: [
          {
            id: "sage",
            model: {
              primary: "openai/gpt-5",
            },
            tools: {
              exec: {
                security: "allowlist",
              },
              byProvider: {
                "openai/gpt-5": {
                  alsoAllow: ["exec", "process"],
                },
              },
            },
          },
        ],
      },
    });

    expect(warnings).toStrictEqual([]);
  });

  it("treats empty provider alsoAllow as an explicit inherited-profile override", async () => {
    const warnings = await collectProfileConfiguredToolSectionWarningsThroughDoctor({
      tools: {
        byProvider: {
          openai: {
            profile: "messaging",
            alsoAllow: ["exec", "process"],
          },
        },
      },
      agents: {
        list: [
          {
            id: "sage",
            tools: {
              exec: {
                security: "allowlist",
              },
              byProvider: {
                openai: {
                  alsoAllow: [],
                },
              },
            },
          },
        ],
      },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'tools.byProvider.openai.profile is "messaging"',
    );
    expect(warning).toContain(
      'agents.list[0].tools.byProvider.openai.alsoAllow: ["exec", "process"]',
    );
  });

  it("does not warn for configured tool sections already granted by explicit alsoAllow", async () => {
    const warnings = await collectProfileConfiguredToolSectionWarningsThroughDoctor({
      tools: {
        profile: "messaging",
        alsoAllow: ["exec", "process"],
        exec: {
          security: "allowlist",
        },
      },
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn for configured tool sections when the profile id is unknown", async () => {
    const malformedConfig = {
      tools: {
        profile: "custom-profile",
        exec: {
          security: "allowlist",
        },
        byProvider: {
          openai: {
            profile: "custom-provider-profile",
          },
        },
      },
      agents: {
        list: [
          {
            id: "sage",
            tools: {
              exec: {
                security: "allowlist",
              },
              byProvider: {
                openai: {
                  profile: "custom-agent-provider-profile",
                },
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const warnings =
      await collectProfileConfiguredToolSectionWarningsThroughDoctor(malformedConfig);

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn when default group visible replies are automatic", async () => {
    const warnings = await collectVisibleReplyToolPolicyWarningsThroughDoctor({
      channels: {
        slack: {},
      },
      tools: {
        allow: ["read"],
      },
    });

    expect(warnings).toStrictEqual([]);
  });

  it("warns strongly when explicit group visible replies require an unavailable message tool", async () => {
    const warnings = await collectVisibleReplyToolPolicyWarningsThroughDoctor({
      messages: {
        groupChat: {
          visibleReplies: "message_tool",
        },
      },
      tools: {
        allow: ["read"],
      },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'messages.groupChat.visibleReplies is set to "message_tool"',
    );
    expect(warning).toContain("normal replies may post to the source chat");
    expect(warning).toContain('set messages.groupChat.visibleReplies to "automatic"');
  });

  it("does not warn when source reply delivery grants message at runtime", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
          },
        },
        list: [
          {
            id: "main",
          },
        ],
      },
      channels: {
        discord: {},
        telegram: {},
      },
      messages: {
        groupChat: {
          visibleReplies: "message_tool",
        },
      },
      tools: {
        profile: "coding" as const,
      },
    } satisfies OpenClawConfig;

    expect(await collectVisibleReplyToolPolicyWarningsThroughDoctor(cfg)).toStrictEqual([]);
    expect(await collectChannelBoundMessageToolPolicyWarningsThroughDoctor(cfg)).toStrictEqual([]);
  });

  it("still warns when provider policy blocks the runtime message grant", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
          },
        },
        list: [
          {
            id: "main",
          },
        ],
      },
      channels: {
        discord: {},
      },
      messages: {
        groupChat: {
          visibleReplies: "message_tool",
        },
      },
      tools: {
        profile: "coding" as const,
        byProvider: {
          openai: {
            allow: ["read"],
          },
        },
      },
    } satisfies OpenClawConfig;

    expectWarningsContaining(await collectVisibleReplyToolPolicyWarningsThroughDoctor(cfg), [
      'messages.groupChat.visibleReplies is set to "message_tool"',
    ]);
    expect(await collectChannelBoundMessageToolPolicyWarningsThroughDoctor(cfg)).toEqual([
      '- Agent "main" is routed from channel "discord", but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.',
    ]);
  });

  it("keeps provider-specific message grants when checking provider policy", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
          },
        },
        list: [
          {
            id: "main",
          },
        ],
      },
      channels: {
        discord: {},
      },
      messages: {
        groupChat: {
          visibleReplies: "message_tool",
        },
      },
      tools: {
        profile: "coding" as const,
        byProvider: {
          openai: {
            alsoAllow: ["message"],
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(await collectVisibleReplyToolPolicyWarningsThroughDoctor(cfg)).toStrictEqual([]);
    expect(await collectChannelBoundMessageToolPolicyWarningsThroughDoctor(cfg)).toStrictEqual([]);
  });

  it("warns for direct chats when global visible replies are tool-only but groups override automatic", async () => {
    const warnings = await collectVisibleReplyToolPolicyWarningsThroughDoctor({
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

  it("warns separately for explicit global and group visible reply policy mismatches", async () => {
    const warnings = await collectVisibleReplyToolPolicyWarningsThroughDoctor({
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

  it("skips visible reply tool warnings when the message tool is available or default groups are unused", async () => {
    expect(
      await collectVisibleReplyToolPolicyWarningsThroughDoctor({
        channels: {
          slack: {},
        },
        tools: {
          profile: "messaging",
        },
      }),
    ).toStrictEqual([]);
    expect(
      await collectVisibleReplyToolPolicyWarningsThroughDoctor({
        tools: {
          allow: ["read"],
        },
      }),
    ).toStrictEqual([]);
  });

  it("warns when a channel route targets an agent without the message tool", async () => {
    const warnings = await collectChannelBoundMessageToolPolicyWarningsThroughDoctor({
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

  it("warns for the default agent when configured channels have no explicit routes", async () => {
    const warnings = await collectChannelBoundMessageToolPolicyWarningsThroughDoctor({
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

  it("warns only for configured channels not covered by channel routes", async () => {
    const warnings = await collectChannelBoundMessageToolPolicyWarningsThroughDoctor({
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

  it("warns for default-routed traffic when a channel only has scoped routes", async () => {
    const warnings = await collectChannelBoundMessageToolPolicyWarningsThroughDoctor({
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

  it("skips the default-agent warning when a wildcard account route covers the channel", async () => {
    const warnings = await collectChannelBoundMessageToolPolicyWarningsThroughDoctor({
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

  it("skips the default-agent warning when configured accounts are fully covered", async () => {
    const warnings = await collectChannelBoundMessageToolPolicyWarningsThroughDoctor({
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

  it("does not treat channel aliases as route coverage when runtime would not match them", async () => {
    const warnings = await collectChannelBoundMessageToolPolicyWarningsThroughDoctor({
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

  it("warns for the default agent when configured account routes are incomplete", async () => {
    const warnings = await collectChannelBoundMessageToolPolicyWarningsThroughDoctor({
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
