import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildProviderStatusIndex } from "./agents.providers.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : null,
  ),
  resolveChannelDefaultAccountId: vi.fn(() => "default"),
  isChannelVisibleInConfiguredLists: vi.fn(() => true),
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: (...args: Parameters<typeof mocks.listChannelPlugins>) =>
    mocks.listChannelPlugins(...args),
  getChannelPlugin: (...args: Parameters<typeof mocks.getChannelPlugin>) =>
    mocks.getChannelPlugin(...args),
  normalizeChannelId: (...args: Parameters<typeof mocks.normalizeChannelId>) =>
    mocks.normalizeChannelId(...args),
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
      id: "slack",
      meta: { label: "Slack" },
      config: {
        listAccountIds: () => ["work"],
        inspectAccount,
        resolveAccount,
        describeAccount: () => ({ configured: true, enabled: true, linked: true, name: "Work" }),
      },
      status: {},
    } as never;

    mocks.listChannelPlugins.mockReturnValue([plugin]);
    mocks.getChannelPlugin.mockReturnValue(plugin);

    const map = await buildProviderStatusIndex({} as OpenClawConfig);

    expect(resolveAccount).not.toHaveBeenCalled();
    expect(inspectAccount).toHaveBeenCalledWith({}, "work");
    expect(map.get("slack:work")).toMatchObject({
      provider: "slack",
      accountId: "work",
      state: "linked",
      configured: true,
      enabled: true,
      name: "Work",
    });
  });

  it("records accounts that throw during read-only resolution as not configured", async () => {
    const plugin = {
      id: "telegram",
      meta: { label: "Telegram" },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => {
          throw new Error("unresolved SecretRef");
        },
      },
      status: {},
    } as never;

    mocks.listChannelPlugins.mockReturnValue([plugin]);
    mocks.getChannelPlugin.mockReturnValue(plugin);

    await expect(buildProviderStatusIndex({} as OpenClawConfig)).resolves.toEqual(
      new Map([
        [
          "telegram:default",
          {
            provider: "telegram",
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
      id: "telegram",
      meta: { label: "Telegram" },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => {
          throw new Error("plugin crash");
        },
      },
      status: {},
    } as never;

    mocks.listChannelPlugins.mockReturnValue([plugin]);
    mocks.getChannelPlugin.mockReturnValue(plugin);

    await expect(buildProviderStatusIndex({} as OpenClawConfig)).rejects.toThrow("plugin crash");
  });
});
