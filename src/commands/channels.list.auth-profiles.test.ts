import { beforeEach, describe, expect, it, vi } from "vitest";
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
  loadAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  listReadOnlyChannelPluginsForConfig: vi.fn<() => ChannelPlugin[]>(() => []),
  buildChannelAccountSnapshot: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
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

vi.mock("../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreWithoutExternalProfiles: mocks.loadAuthProfileStoreWithoutExternalProfiles,
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));

vi.mock("../channels/plugins/status.js", () => ({
  buildChannelAccountSnapshot: mocks.buildChannelAccountSnapshot,
}));

vi.mock("../infra/provider-usage.js", () => ({
  formatUsageReportLines: () => [],
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

import { channelsListCommand } from "./channels/list.js";

function createMockChannelPlugin(accountIds: string[]): ChannelPlugin {
  return {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => accountIds,
      resolveAccount: () => ({}),
    },
  };
}

describe("channels list auth profiles", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.resolveCommandConfigWithSecrets.mockClear();
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReset();
    mocks.loadProviderUsageSummary.mockReset();
    mocks.listReadOnlyChannelPluginsForConfig.mockReset();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.buildChannelAccountSnapshot.mockReset();
  });

  it("includes local auth profiles in JSON output without loading external profiles", async () => {
    const runtime = createTestRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "oauth",
          provider: "anthropic",
          access: "token",
          refresh: "refresh",
          expires: 0,
          created: 0,
        },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai",
          access: "token",
          refresh: "refresh",
          expires: 0,
          created: 0,
        },
      },
    });

    await channelsListCommand({ json: true, usage: false }, runtime);

    expect(mocks.resolveCommandConfigWithSecrets).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as {
      auth?: Array<{ id: string }>;
    };
    const ids = payload.auth?.map((entry) => entry.id) ?? [];
    expect(ids).toContain("anthropic:default");
    expect(ids).toContain("openai-codex:default");
  });

  it("includes configured chat channel accounts in JSON output", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin(["alerts", "default"]),
    ]);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "123:abc" },
              alerts: { botToken: "456:def" },
            },
          },
        },
      },
    });
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {},
    });

    await channelsListCommand({ json: true, usage: false }, runtime);

    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ includeSetupFallbackPlugins: true }),
    );
    const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as {
      chat?: Record<string, string[]>;
    };
    expect(payload.chat?.telegram).toEqual(["alerts", "default"]);
  });

  it("keeps JSON output valid when usage loading fails", async () => {
    const runtime = createTestRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {},
    });
    mocks.loadProviderUsageSummary.mockRejectedValue(new Error("fetch failed"));

    await channelsListCommand({ json: true }, runtime);

    const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as {
      usage?: unknown;
    };
    expect(payload.usage).toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("prints configured chat channel accounts before auth providers", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin(["default"]),
    ]);
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
      tokenSource: "config",
      enabled: true,
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "123:abc" },
            },
          },
        },
      },
    });
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {},
    });

    await channelsListCommand({ usage: false }, runtime);

    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ includeSetupFallbackPlugins: true }),
    );
    const output = stripAnsi(runtime.log.mock.calls[0]?.[0] as string);
    expect(output).toContain("Chat channels:");
    expect(output).toContain("Telegram default:");
    expect(output).toContain("configured");
    expect(output.indexOf("Telegram default:")).toBeLessThan(output.indexOf("Auth providers"));
  });
});
