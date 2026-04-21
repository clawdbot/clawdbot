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

    expect(tryResolveLoadedOutboundTarget({ channel: "alpha", to: "room-one" })).toBeUndefined();
  });

  it("uses loaded plugin config defaultTo fallback", () => {
    const cfg: OpenClawConfig = {
      channels: { alpha: { defaultTo: "room-one" } },
    };
    mocks.getLoadedChannelPlugin.mockReturnValue({
      id: "alpha",
      meta: { label: "Alpha" },
      capabilities: {},
      config: {
        resolveDefaultTo: ({ cfg }: { cfg: OpenClawConfig }) =>
          (cfg.channels?.alpha as { defaultTo?: string } | undefined)?.defaultTo,
      },
      outbound: {},
      messaging: {},
    });

    expect(
      tryResolveLoadedOutboundTarget({
        channel: "alpha",
        to: "",
        cfg,
        mode: "implicit",
      }),
    ).toEqual({ ok: true, to: "room-one" });
  });

  it("trims channel ids before reading the loaded registry", () => {
    tryResolveLoadedOutboundTarget({ channel: " alpha " as never, to: "room-one" });

    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("alpha");
  });
});
