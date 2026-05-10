import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { stripAnsi } from "../terminal/ansi.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [],
  })),
  listReadOnlyChannelPluginsForConfig: vi.fn<() => ChannelPlugin[]>(() => []),
  buildChannelAccountSnapshot: vi.fn(),
  listTrustedChannelPluginCatalogEntries: vi.fn<() => ChannelPluginCatalogEntry[]>(() => []),
  isCatalogChannelInstalled: vi.fn<(params: { entry: ChannelPluginCatalogEntry }) => boolean>(
    () => true,
  ),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: () => new Set<string>(),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));

vi.mock("../channels/plugins/status.js", () => ({
  buildChannelAccountSnapshot: mocks.buildChannelAccountSnapshot,
}));

vi.mock("./channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: mocks.listTrustedChannelPluginCatalogEntries,
}));

vi.mock("./channel-setup/discovery.js", () => ({
  isCatalogChannelInstalled: mocks.isCatalogChannelInstalled,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
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

describe("channels list", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.resolveCommandConfigWithSecrets.mockClear();
    mocks.listReadOnlyChannelPluginsForConfig.mockReset();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.buildChannelAccountSnapshot.mockReset();
    mocks.listTrustedChannelPluginCatalogEntries.mockReset();
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.isCatalogChannelInstalled.mockReset();
    mocks.isCatalogChannelInstalled.mockReturnValue(true);
  });

  it("does not include auth providers in JSON output (auth section was removed)", async () => {
    const runtime = createTestRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsListCommand({ json: true }, runtime);

    const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as Record<string, unknown>;
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
      includeSetupFallbackPlugins: true,
    });
    const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as {
      chat?: Record<string, { accounts: string[]; installed: boolean; origin: string }>;
    };
    expect(payload.chat?.telegram).toEqual({
      accounts: ["alerts", "default"],
      installed: true,
      origin: "configured",
    });
  });

  it("keeps JSON output valid when only channels are provided (no usage field)", async () => {
    const runtime = createTestRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsListCommand({ json: true }, runtime);

    const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as {
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
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
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
    });
    const output = stripAnsi(runtime.log.mock.calls[0]?.[0] as string);
    expect(output).toContain("Chat channels:");
    expect(output).toContain("Telegram default:");
    expect(output).toContain("installed");
    expect(output).toContain("configured");
    expect(output).toContain("enabled");
    expect(output).not.toContain("Auth providers");
  });

  it("default output does NOT show installable catalog channels (only configured ones)", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.isCatalogChannelInstalled.mockReturnValue(false);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsListCommand({}, runtime);

    const output = stripAnsi(runtime.log.mock.calls[0]?.[0] as string);
    expect(output).toContain("Chat channels:");
    expect(output).not.toContain("QQ Bot");
    // Hint user about --all
    expect(output).toContain("--all");
  });

  it("--all surfaces uninstalled catalog channels with installed=false / not configured / not enabled", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.isCatalogChannelInstalled.mockReturnValue(false);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsListCommand({ all: true }, runtime);

    const output = stripAnsi(runtime.log.mock.calls[0]?.[0] as string);
    expect(output).toContain("QQ Bot");
    expect(output).toContain("not installed");
    expect(output).toContain("not configured");
  });

  it("--all surfaces bundled-but-unconfigured plugins with installed=true / not configured", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: [] }),
    ]);
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
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
    const noAllOutput = stripAnsi(runtime.log.mock.calls[0]?.[0] as string);
    expect(noAllOutput).not.toContain("Discord default:");

    runtime.log.mockClear();

    // With --all: discord is rendered with installed + not configured + disabled.
    await channelsListCommand({ all: true }, runtime);
    const allOutput = stripAnsi(runtime.log.mock.calls[0]?.[0] as string);
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
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: false,
      enabled: false,
    });
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.isCatalogChannelInstalled.mockImplementation(({ entry }) => entry.id !== "qqbot");
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { accounts: { default: { botToken: "x:y" } } },
        },
      },
    });

    await channelsListCommand({ json: true, all: true }, runtime);

    const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as {
      chat: Record<string, { origin: string; installed: boolean }>;
    };
    expect(payload.chat.telegram?.origin).toBe("configured");
    expect(payload.chat.telegram?.installed).toBe(true);
    expect(payload.chat.discord?.origin).toBe("available");
    expect(payload.chat.discord?.installed).toBe(true);
    expect(payload.chat.qqbot?.origin).toBe("installable");
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
      // But catalog knows about wecom, and isCatalogChannelInstalled sees
      // the wecom npm package on disk.
      mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
        createCatalogEntry("wecom", "WeCom"),
      ]);
      mocks.isCatalogChannelInstalled.mockReturnValue(true);
      mocks.readConfigFileSnapshot.mockResolvedValue({
        ...baseConfigSnapshot,
        config: {},
      });

      await channelsListCommand({ all: true }, runtime);

      const output = stripAnsi(runtime.log.mock.calls[0]?.[0] as string);
      expect(output).toContain("WeCom");
      expect(output).toContain("installed");
      expect(output).not.toContain("not installed");
      expect(output).toContain("not configured");
      expect(output).toContain("disabled");

      // JSON side: origin should be "available" (installed, but user has
      // not written a config entry for it).
      runtime.log.mockClear();
      await channelsListCommand({ json: true, all: true }, runtime);
      const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as {
        chat: Record<string, { origin: string; installed: boolean }>;
      };
      expect(payload.chat.wecom?.origin).toBe("available");
      expect(payload.chat.wecom?.installed).toBe(true);
    },
  );
});
