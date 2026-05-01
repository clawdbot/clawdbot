import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildProviderStatusIndex } from "./agents.providers.js";

const mocks = vi.hoisted(() => ({
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : null,
  ),
  resolveChannelDefaultAccountId: vi.fn(() => "default"),
  isChannelVisibleInConfiguredLists: vi.fn(() => true),
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

describe("buildProviderStatusIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(map.get("workchat:work")).toMatchObject({
      provider: "workchat",
      accountId: "work",
      state: "linked",
      configured: true,
      enabled: true,
      name: "Work",
    });
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
});
