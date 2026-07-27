// Agents provider tests cover provider status index construction for configured agents.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OfficialExternalPluginRepairHint } from "../plugins/official-external-plugin-repair-hints.js";
import {
  buildProviderStatusIndex,
  buildProviderSummaryMetadataIndex,
  listProvidersForAgent,
  summarizeBindings,
} from "./agents.providers.js";

const mocks = vi.hoisted(() => ({
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : null,
  ),
  resolveChannelDefaultAccountId: vi.fn(() => "default"),
  isChannelVisibleInConfiguredLists: vi.fn(() => true),
  listExplicitConfiguredChannelIdsForConfig: vi.fn(() => [] as string[]),
  resolveMissingOfficialExternalChannelPluginRepairHint: vi.fn<
    () => OfficialExternalPluginRepairHint | null
  >(() => null),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: Parameters<typeof mocks.getChannelPlugin>) =>
    mocks.getChannelPlugin(...args),
  normalizeChannelId: (...args: Parameters<typeof mocks.normalizeChannelId>) =>
    mocks.normalizeChannelId(...args),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: (
    ...args: Parameters<typeof mocks.listReadOnlyChannelPluginsForConfig>
  ) => mocks.listReadOnlyChannelPluginsForConfig(...args),
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: (
    ...args: Parameters<typeof mocks.resolveChannelDefaultAccountId>
  ) => mocks.resolveChannelDefaultAccountId(...args),
}));

vi.mock("../channels/plugins/exposure.js", () => ({
  isChannelVisibleInConfiguredLists: (
    ...args: Parameters<typeof mocks.isChannelVisibleInConfiguredLists>
  ) => mocks.isChannelVisibleInConfiguredLists(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: mocks.listExplicitConfiguredChannelIdsForConfig,
}));

vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHint:
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint,
}));

describe("buildProviderStatusIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReturnValue([]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockReturnValue(null);
  });

  it("prefers inspectAccount for read-only status surfaces", async () => {
    const inspectAccount = vi.fn(() => ({ enabled: true, configured: true, name: "Work" }));
    const resolveAccount = vi.fn(() => {
      throw new Error("should not be used when inspectAccount exists");
    });
    const plugin = {
      id: "workchat",
      meta: { label: "WorkChat" },
      config: {
        listAccountIds: () => ["work"],
        inspectAccount,
        resolveAccount,
        describeAccount: () => ({ configured: true, enabled: true, linked: true, name: "Work" }),
      },
      status: {},
    } as never;

    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    mocks.getChannelPlugin.mockReturnValue(plugin);

    const map = await buildProviderStatusIndex({} as OpenClawConfig);

    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      {},
      { includeSetupFallbackPlugins: false },
    );
    expect(resolveAccount).not.toHaveBeenCalled();
    expect(inspectAccount).toHaveBeenCalledWith({}, "work");
    const status = map.get("workchat:work");
    expect(status?.provider).toBe("workchat");
    expect(status?.accountId).toBe("work");
    expect(status?.state).toBe("linked");
    expect(status?.configured).toBe(true);
    expect(status?.enabled).toBe(true);
    expect(status?.name).toBe("Work");
  });

  it("records accounts that throw during read-only resolution as not configured", async () => {
    const plugin = {
      id: "quietchat",
      meta: { label: "QuietChat" },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => {
          throw new Error("unresolved SecretRef");
        },
      },
      status: {},
    } as never;

    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    mocks.getChannelPlugin.mockReturnValue(plugin);

    await expect(buildProviderStatusIndex({} as OpenClawConfig)).resolves.toEqual(
      new Map([
        [
          "quietchat:default",
          {
            provider: "quietchat",
            accountId: "default",
            state: "not configured",
            configured: false,
          },
        ],
      ]),
    );
  });

  it("rethrows unexpected read-only account resolution errors", async () => {
    const plugin = {
      id: "quietchat",
      meta: { label: "QuietChat" },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => {
          throw new Error("plugin crash");
        },
      },
      status: {},
    } as never;

    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    mocks.getChannelPlugin.mockReturnValue(plugin);

    await expect(buildProviderStatusIndex({} as OpenClawConfig)).rejects.toThrow("plugin crash");
  });

  it("keeps configured missing external channels in provider metadata", () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReturnValue(["feishu"]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockReturnValue({
      channelId: "feishu",
      pluginId: "feishu",
      label: "Feishu",
      installSpec: "@openclaw/feishu",
      installCommand: "openclaw plugins install @openclaw/feishu",
      doctorFixCommand: "openclaw doctor --fix",
      repairHint:
        "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    });

    expect(
      buildProviderSummaryMetadataIndex({ channels: { feishu: { appId: "cli_xxx" } } } as never),
    ).toEqual(
      new Map([
        [
          "feishu",
          {
            label: "Feishu",
            defaultAccountId: "default",
            visibleInConfiguredLists: true,
            repairHint:
              "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
          },
        ],
      ]),
    );
  });

  it("uses repair hints instead of unknown for bound missing external channels", () => {
    const lines = listProvidersForAgent({
      summaryIsDefault: false,
      cfg: { channels: { feishu: { appId: "cli_xxx" } } } as never,
      bindings: [{ match: { channel: "feishu" } }] as never,
      providerStatus: new Map(),
      providerMetadata: new Map([
        [
          "feishu",
          {
            label: "Feishu",
            defaultAccountId: "default",
            visibleInConfiguredLists: true,
            repairHint:
              "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
          },
        ],
      ]),
    });

    expect(lines).toEqual([
      "Feishu default: missing plugin - Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    ]);
  });

  it("keeps bound missing external channels when runtime registry normalization is unavailable", () => {
    mocks.normalizeChannelId.mockReturnValueOnce(null);

    const lines = listProvidersForAgent({
      summaryIsDefault: false,
      cfg: { channels: { feishu: { appId: "cli_xxx" } } } as never,
      bindings: [{ match: { channel: "feishu" } }] as never,
      providerStatus: new Map(),
      providerMetadata: new Map([
        [
          "feishu",
          {
            label: "Feishu",
            defaultAccountId: "default",
            visibleInConfiguredLists: true,
            repairHint:
              "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
          },
        ],
      ]),
    });

    expect(lines).toEqual([
      "Feishu default: missing plugin - Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    ]);
  });

  it("shows missing external plugin repair hints for default agent summaries", () => {
    const lines = listProvidersForAgent({
      summaryIsDefault: true,
      cfg: { channels: { feishu: { appId: "cli_xxx" } } } as never,
      bindings: [],
      providerStatus: new Map(),
      providerMetadata: new Map([
        [
          "feishu",
          {
            label: "Feishu",
            defaultAccountId: "default",
            visibleInConfiguredLists: true,
            repairHint:
              "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
          },
        ],
      ]),
    });

    expect(lines).toEqual([
      "Feishu default: missing plugin - Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    ]);
  });

  it("keeps route summaries when runtime registry normalization is unavailable", () => {
    mocks.normalizeChannelId.mockReturnValueOnce(null);

    expect(
      summarizeBindings(
        { channels: { feishu: { appId: "cli_xxx" } } } as never,
        [{ match: { channel: "feishu" } }] as never,
        new Map([
          [
            "feishu",
            {
              label: "Feishu",
              defaultAccountId: "default",
              visibleInConfiguredLists: true,
            },
          ],
        ]),
      ),
    ).toEqual(["Feishu default"]);
  });
});
