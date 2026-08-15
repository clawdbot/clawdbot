// Channels list tests cover catalog entries, installed plugins, status fallback, and terminal output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { resolvePluginControlPlaneWorkspace } from "../plugins/control-plane-workspace.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  metadataSnapshot: {
    plugins: [],
    index: { plugins: [] },
    discovery: { candidates: [], diagnostics: [] },
  },
  readConfigFileSnapshot: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [],
  })),
  listReadOnlyChannelPluginsForConfig: vi.fn<() => ChannelPlugin[]>(() => []),
  resolveChannelAccountSnapshot: vi.fn(),
  listTrustedChannelPluginCatalogEntries: vi.fn<() => ChannelPluginCatalogEntry[]>(() => []),
  listManifestInstalledChannelIds: vi.fn<() => Set<string>>(() => new Set()),
  resolveMissingOfficialExternalChannelPluginRepairHint: vi.fn(),
  callGateway: vi.fn(),
  resolvePluginControlPlaneWorkspace: vi.fn<typeof resolvePluginControlPlaneWorkspace>(() => ({
    workspaceDir: "/tmp/workspace",
    workspaceScope: "selected",
  })),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

vi.mock("../plugins/control-plane-workspace.js", () => ({
  resolvePluginControlPlaneWorkspace: mocks.resolvePluginControlPlaneWorkspace,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: () => new Set<string>(),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));

vi.mock("../channels/plugins/status.js", () => ({
  resolveChannelAccountSnapshot: mocks.resolveChannelAccountSnapshot,
}));

vi.mock("./channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: mocks.listTrustedChannelPluginCatalogEntries,
}));

vi.mock("./channel-setup/discovery.js", () => ({
  listManifestInstalledChannelIds: mocks.listManifestInstalledChannelIds,
}));

vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHint:
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint,
}));

import { channelsListCommand } from "./channels/list.js";

function createMockChannelPlugin(overrides: {
  id?: string;
  label?: string;
  accountIds?: string[];
}): ChannelPlugin {
  const id = overrides.id ?? "telegram";
  return {
    id,
    meta: {
      id,
      label: overrides.label ?? "Telegram",
      selectionLabel: overrides.label ?? "Telegram",
      docsPath: `/channels/${id}`,
      blurb: overrides.label ?? "Telegram",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => overrides.accountIds ?? [],
      resolveAccount: () => ({}),
    },
  };
}

function createCatalogEntry(id: string, label: string): ChannelPluginCatalogEntry {
  return {
    id,
    label,
    pluginId: `@openclaw/${id}`,
    origin: "official",
    meta: {
      id,
      label,
      selectionLabel: label,
      docsPath: `/channels/${id}`,
      blurb: label,
    },
    install: { npmSpec: `@openclaw/${id}` },
  } as unknown as ChannelPluginCatalogEntry;
}

function loggedText(runtime: ReturnType<typeof createTestRuntime>): string {
  const value = runtime.log.mock.calls[0]?.[0];
  if (typeof value !== "string") {
    throw new Error("expected runtime log text");
  }
  return value;
}

describe("channels list", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.resolveCommandConfigWithSecrets.mockClear();
    mocks.listReadOnlyChannelPluginsForConfig.mockReset();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.resolveChannelAccountSnapshot.mockReset();
    mocks.listTrustedChannelPluginCatalogEntries.mockReset();
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.listManifestInstalledChannelIds.mockReset();
    mocks.listManifestInstalledChannelIds.mockReturnValue(new Set());
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockReset();
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockReturnValue(null);
    mocks.callGateway.mockReset();
    mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
    mocks.resolvePluginControlPlaneWorkspace.mockReset();
    mocks.resolvePluginControlPlaneWorkspace.mockReturnValue({
      workspaceDir: "/tmp/workspace",
      workspaceScope: "selected",
    });
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(mocks.metadataSnapshot);
  });

  it("does not include auth providers in JSON output (auth section was removed)", async () => {
    const runtime = createTestRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsListCommand({ json: true }, runtime);

    const payload = JSON.parse(loggedText(runtime)) as Record<string, unknown>;
    expect(payload.auth).toBeUndefined();
    expect(payload).toHaveProperty("chat");
  });

  it("includes configured chat channel accounts in JSON output with installed flag", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ accountIds: ["alerts", "default"] }),
    ]);
    const config = {
      channels: {
        telegram: {
          accounts: {
            default: { botToken: "123:abc" },
            alerts: { botToken: "456:def" },
          },
        },
      },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config,
    });

    await channelsListCommand({ json: true }, runtime);

    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(config, {
      metadataSnapshot: mocks.metadataSnapshot,
    });
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ skipPluginValidation: true });
    const payload = JSON.parse(loggedText(runtime)) as {
      chat?: Record<string, { accounts: string[]; installed: boolean; origin: string }>;
    };
    expect(payload.chat?.telegram).toEqual({
      accounts: ["alerts", "default"],
      installed: true,
      origin: "configured",
    });
  });

  it("keeps shared inventory when an explicit multi-agent roster has no system owner", async () => {
    const runtime = createTestRuntime();
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: {}, research: {} },
      },
    };
    mocks.resolvePluginControlPlaneWorkspace.mockReturnValue({
      workspaceScope: "omitted",
      diagnostic: {
        level: "warn",
        code: "workspace-scope-omitted",
        message: "Workspace plugin discovery was skipped for this explicit roster.",
      },
    });
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.listManifestInstalledChannelIds.mockReturnValue(new Set(["qqbot"]));
    mocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot, config });

    await channelsListCommand({ all: true, json: true }, runtime);

    expect(mocks.resolvePluginControlPlaneWorkspace).toHaveBeenCalledWith({
      config,
      env: process.env,
    });
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config,
      env: process.env,
      allowWorkspaceScopedCurrent: true,
    });
    expect(mocks.listTrustedChannelPluginCatalogEntries).toHaveBeenCalledWith({
      cfg: config,
      discovery: mocks.metadataSnapshot.discovery,
    });
    const payload = JSON.parse(loggedText(runtime)) as {
      chat: Record<string, { installed: boolean }>;
      diagnostics?: Array<{ code?: string }>;
    };
    expect(payload.chat.qqbot?.installed).toBe(true);
    expect(payload.diagnostics).toContainEqual(
      expect.objectContaining({ code: "workspace-scope-omitted" }),
    );
  });

  it("uses the named system owner for workspace-scoped channel inventory", async () => {
    const runtime = createTestRuntime();
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "research" } },
        entries: { main: {}, research: { workspace: "/tmp/research-workspace" } },
      },
    };
    mocks.resolvePluginControlPlaneWorkspace.mockReturnValue({
      workspaceDir: "/tmp/research-workspace",
      workspaceScope: "selected",
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot, config });

    await channelsListCommand({ all: true, json: true }, runtime);

    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config,
      env: process.env,
      workspaceDir: "/tmp/research-workspace",
      allowWorkspaceScopedCurrent: true,
    });
    expect(mocks.listTrustedChannelPluginCatalogEntries).toHaveBeenCalledWith({
      cfg: config,
      workspaceDir: "/tmp/research-workspace",
      discovery: mocks.metadataSnapshot.discovery,
    });
    expect(mocks.listManifestInstalledChannelIds).toHaveBeenCalledWith({
      cfg: config,
      workspaceDir: "/tmp/research-workspace",
      index: mocks.metadataSnapshot.index,
    });
  });

  it("keeps JSON output valid when only channels are provided (no usage field)", async () => {
    const runtime = createTestRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsListCommand({ json: true }, runtime);

    const payload = JSON.parse(loggedText(runtime)) as {
      usage?: unknown;
    };
    expect(payload.usage).toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("text output prints chat channels but no longer renders an Auth providers section", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ accountIds: ["default"] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
      tokenSource: "config",
      enabled: true,
    });
    const config = {
      channels: {
        telegram: {
          accounts: {
            default: { botToken: "123:abc" },
          },
        },
      },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config,
    });

    await channelsListCommand({}, runtime);

    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(config, {
      includeSetupFallbackPlugins: true,
      metadataSnapshot: mocks.metadataSnapshot,
    });
    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("Chat channels:");
    expect(output).toContain("Telegram default:");
    expect(output).toContain("installed");
    expect(output).toContain("configured");
    expect(output).toContain("enabled");
    expect(output).not.toContain("Auth providers");
  });

  it("sanitizes channel labels only in terminal output", async () => {
    const control = "\u001B]0;channels-list-injection\u0007";
    const accountId = `${control}default\nforged-row`;
    const channelLabel = `${control}Telegram 🦞\r\nAdmin`;
    const accountName = `${control}Primary\tAccount`;
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ label: channelLabel, accountIds: [accountId] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId,
      name: accountName,
      configured: true,
      enabled: true,
    });
    const config = { channels: { telegram: { accounts: { [accountId]: {} } } } };
    mocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot, config });

    const textRuntime = createTestRuntime();
    await channelsListCommand({}, textRuntime);

    const textOutput = loggedText(textRuntime);
    expect(textOutput).not.toContain("\u001B");
    expect(textOutput).not.toContain("\nforged-row");
    expect(textOutput).toContain("Telegram 🦞\\r\\nAdmin");
    expect(textOutput).toContain("\\nforged-row");
    expect(textOutput).toContain("Primary\\tAccount");

    const jsonRuntime = createTestRuntime();
    await channelsListCommand({ json: true }, jsonRuntime);
    const payload = JSON.parse(loggedText(jsonRuntime)) as {
      chat?: Record<string, { accounts: string[] }>;
    };
    expect(payload.chat?.telegram?.accounts).toStrictEqual([accountId]);
  });

  it("prefers reachable gateway account snapshots over command-local token state", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: ["default"] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: false,
      tokenSource: "none",
      enabled: true,
    });
    mocks.callGateway.mockResolvedValue({
      channelAccounts: {
        discord: [
          {
            accountId: "default",
            name: "clawsweeper",
            configured: true,
            tokenSource: "env",
            tokenStatus: "available",
            enabled: true,
          },
        ],
      },
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          discord: { enabled: true },
        },
      },
    });

    await channelsListCommand({ all: true }, runtime);

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "channels.status",
      params: { probe: false, timeoutMs: 5000 },
      timeoutMs: 5000,
    });
    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("Discord default (clawsweeper):");
    expect(output).toContain("configured");
    expect(output).toContain("token=env");
    expect(output).not.toContain("not configured");
    expect(output).not.toContain("token=none");
  });

  it("falls back to command-local account snapshots when gateway status is unavailable", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: ["default"] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: false,
      tokenSource: "none",
      enabled: true,
    });
    mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          discord: { enabled: true },
        },
      },
    });

    await channelsListCommand({ all: true }, runtime);

    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("Discord default:");
    expect(output).toContain("not configured");
    expect(output).toContain("token=none");
  });

  it("marks configured-but-unavailable credential sources in text output", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: ["default"] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      enabled: true,
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          discord: { enabled: true },
        },
      },
    });

    await channelsListCommand({ all: true }, runtime);

    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("configured");
    expect(output).toContain("token=config-unavailable");
  });

  it("default output does NOT show installable catalog channels (only configured ones)", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.listManifestInstalledChannelIds.mockReturnValue(new Set());
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsListCommand({}, runtime);

    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("Chat channels:");
    expect(output).not.toContain("QQ Bot");
    // Hint user about --all
    expect(output).toContain("--all");
  });

  it("default output shows configured official external channels when the plugin is missing", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("discord", "Discord"),
    ]);
    mocks.listManifestInstalledChannelIds.mockReturnValue(new Set());
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockReturnValue({
      pluginId: "discord",
      channelId: "discord",
      label: "Discord",
      installSpec: "@openclaw/discord",
      installCommand: "openclaw plugins install @openclaw/discord",
      doctorFixCommand: "openclaw doctor --fix",
      repairHint:
        "Install the official external plugin with: openclaw plugins install @openclaw/discord, or run: openclaw doctor --fix.",
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          discord: { enabled: true, token: "secret" },
        },
      },
    });

    await channelsListCommand({}, runtime);

    expect(mocks.resolveMissingOfficialExternalChannelPluginRepairHint).toHaveBeenCalledWith({
      config: {
        channels: {
          discord: { enabled: true, token: "secret" },
        },
      },
      channelId: "discord",
      workspaceDir: "/tmp/workspace",
      // Prepared once for the invocation; the row loop must not rediscover.
      manifestRecords: expect.any(Array),
    });
    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("Discord");
    expect(output).toContain("not installed");
    expect(output).toContain("configured");
    expect(output).toContain("disabled");
    expect(output).toContain(
      "run openclaw plugins install @openclaw/discord or openclaw doctor --fix",
    );
    expect(output).not.toContain("no configured chat channels");
  });

  it("JSON output includes configured official external channels when the plugin is missing", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("discord", "Discord"),
    ]);
    mocks.listManifestInstalledChannelIds.mockReturnValue(new Set());
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockReturnValue({
      pluginId: "discord",
      channelId: "discord",
      label: "Discord",
      installSpec: "@openclaw/discord",
      installCommand: "openclaw plugins install @openclaw/discord",
      doctorFixCommand: "openclaw doctor --fix",
      repairHint:
        "Install the official external plugin with: openclaw plugins install @openclaw/discord, or run: openclaw doctor --fix.",
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          discord: { enabled: true, token: "secret" },
        },
      },
    });

    await channelsListCommand({ json: true }, runtime);

    const payload = JSON.parse(loggedText(runtime)) as {
      chat: Record<string, { accounts: string[]; origin: string; installed: boolean }>;
    };
    expect(payload.chat.discord).toEqual({
      accounts: [],
      installed: false,
      origin: "configured",
    });
  });

  it("--all surfaces uninstalled catalog channels with installed=false / not configured / not enabled", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.listManifestInstalledChannelIds.mockReturnValue(new Set());
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsListCommand({ all: true }, runtime);

    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("QQ Bot");
    expect(output).toContain("not installed");
    expect(output).toContain("not configured");
  });

  it("--all surfaces bundled-but-unconfigured plugins with installed=true / not configured", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: [] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: false,
      enabled: false,
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    // Without --all: discord should not appear.
    await channelsListCommand({}, runtime);
    const noAllOutput = stripAnsi(loggedText(runtime));
    expect(noAllOutput).not.toContain("Discord default:");

    runtime.log.mockClear();

    // With --all: discord is rendered with installed + not configured + disabled.
    await channelsListCommand({ all: true }, runtime);
    const allOutput = stripAnsi(loggedText(runtime));
    expect(allOutput).toContain("Discord default:");
    expect(allOutput).toContain("installed");
    expect(allOutput).toContain("not configured");
    expect(allOutput).toContain("disabled");
  });

  it("--all JSON exposes 'origin' tag (configured / available / installable)", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "telegram", accountIds: ["default"] }),
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: [] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: false,
      enabled: false,
    });
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.listManifestInstalledChannelIds.mockReturnValue(new Set());
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { accounts: { default: { botToken: "x:y" } } },
        },
      },
    });

    await channelsListCommand({ json: true, all: true }, runtime);

    const payload = JSON.parse(loggedText(runtime)) as {
      chat: Record<string, { origin: string; installed: boolean }>;
    };
    expect(payload.chat.telegram?.origin).toBe("configured");
    expect(payload.chat.telegram?.installed).toBe(true);
    expect(payload.chat.discord?.origin).toBe("available");
    expect(payload.chat.discord?.installed).toBe(true);
    expect(payload.chat.qqbot?.origin).toBe("installable");
    expect(payload.chat.qqbot?.installed).toBe(false);
  });

  it("resolves installed manifest channels once for the whole catalog", async () => {
    const runtime = createTestRuntime();
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("wecom", "WeCom"),
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.listManifestInstalledChannelIds.mockReturnValue(new Set(["wecom"]));
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsListCommand({ all: true, json: true }, runtime);

    expect(mocks.listManifestInstalledChannelIds).toHaveBeenCalledOnce();
    expect(mocks.listTrustedChannelPluginCatalogEntries).toHaveBeenCalledWith({
      cfg: {},
      workspaceDir: "/tmp/workspace",
      discovery: mocks.metadataSnapshot.discovery,
    });
    expect(mocks.listManifestInstalledChannelIds).toHaveBeenCalledWith({
      cfg: {},
      workspaceDir: "/tmp/workspace",
      index: mocks.metadataSnapshot.index,
    });
    const payload = JSON.parse(loggedText(runtime)) as {
      chat: Record<string, { installed: boolean }>;
    };
    expect(payload.chat.wecom?.installed).toBe(true);
    expect(payload.chat.qqbot?.installed).toBe(false);
  });

  it(
    "--all still surfaces catalog channels that are installed on disk but have no " +
      "plugin object loaded and no config entry (regression: WeCom-like channels " +
      "disappearing when the read-only loader only surfaces configured channels)",
    async () => {
      const runtime = createTestRuntime();
      // Read-only loader returns nothing for wecom because the user has no
      // configured wecom channel, so the loader never activates it.
      mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
      // But catalog knows about wecom, and manifest discovery sees
      // the wecom npm package on disk.
      mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
        createCatalogEntry("wecom", "WeCom"),
      ]);
      mocks.listManifestInstalledChannelIds.mockReturnValue(new Set(["wecom"]));
      mocks.readConfigFileSnapshot.mockResolvedValue({
        ...baseConfigSnapshot,
        config: {},
      });

      await channelsListCommand({ all: true }, runtime);

      const output = stripAnsi(loggedText(runtime));
      expect(output).toContain("WeCom");
      expect(output).toContain("installed");
      expect(output).not.toContain("not installed");
      expect(output).toContain("not configured");
      expect(output).toContain("disabled");

      // JSON side: origin should be "available" (installed, but user has
      // not written a config entry for it).
      runtime.log.mockClear();
      await channelsListCommand({ json: true, all: true }, runtime);
      const payload = JSON.parse(loggedText(runtime)) as {
        chat: Record<string, { origin: string; installed: boolean }>;
      };
      expect(payload.chat.wecom?.origin).toBe("available");
      expect(payload.chat.wecom?.installed).toBe(true);
    },
  );
});
