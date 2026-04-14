import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { tryResolveLoadedOutboundTarget } from "./targets-loaded.js";

const mocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn(),
}));

vi.mock("../../channels/plugins/registry-loaded-read.js", () => ({
  getLoadedChannelPluginForRead: mocks.getLoadedChannelPlugin,
}));

describe("tryResolveLoadedOutboundTarget", () => {
  beforeEach(() => {
    mocks.getLoadedChannelPlugin.mockReset();
  });

  it("returns undefined when no loaded plugin exists", () => {
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);

    expect(tryResolveLoadedOutboundTarget({ channel: "telegram", to: "123" })).toBeUndefined();
  });

  it("uses loaded plugin config defaultTo fallback", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { defaultTo: "123456789" } },
    };
    mocks.getLoadedChannelPlugin.mockReturnValue({
      id: "telegram",
      meta: { label: "Telegram" },
      capabilities: {},
      config: {
        resolveDefaultTo: ({ cfg }: { cfg: OpenClawConfig }) => cfg.channels?.telegram?.defaultTo,
      },
      outbound: {},
      messaging: {},
    });

    expect(
      tryResolveLoadedOutboundTarget({
        channel: "telegram",
        to: "",
        cfg,
        mode: "implicit",
      }),
    ).toEqual({ ok: true, to: "123456789" });
  });

  it("trims channel ids before reading the loaded registry", () => {
    tryResolveLoadedOutboundTarget({ channel: " telegram " as never, to: "123" });

    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("telegram");
  });
});
