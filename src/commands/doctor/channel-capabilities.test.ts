// Doctor channel capability tests cover channel capability inspection and diagnostics.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDoctorChannelCapabilities,
  resolveDoctorChannelAccountIds,
} from "./channel-capabilities.js";

const channelPluginMocks = vi.hoisted(() => ({
  getBundledChannelPlugin: vi.fn(() => undefined),
  getChannelPlugin: vi.fn(() => undefined),
}));

vi.mock("../../channels/plugins/bundled.js", () => ({
  getBundledChannelPlugin: channelPluginMocks.getBundledChannelPlugin,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: channelPluginMocks.getChannelPlugin,
}));

describe("doctor channel capabilities", () => {
  beforeEach(() => {
    channelPluginMocks.getBundledChannelPlugin.mockReset().mockReturnValue(undefined);
    channelPluginMocks.getChannelPlugin.mockReset().mockReturnValue(undefined);
  });

  it("returns nested route semantics from googlechat plugin metadata", () => {
    expect(getDoctorChannelCapabilities("googlechat")).toEqual({
      dmAllowFromMode: "nestedOnly",
      groupModel: "route",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    });
  });

  it("returns capability overrides from matrix plugin metadata", () => {
    expect(getDoctorChannelCapabilities("matrix")).toEqual({
      dmAllowFromMode: "nestedOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    });
  });

  it("returns hybrid group semantics for zalouser", () => {
    expect(getDoctorChannelCapabilities("zalouser")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "hybrid",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    });
  });

  it("preserves empty sender allowlist warnings for msteams hybrid routing", () => {
    expect(getDoctorChannelCapabilities("msteams")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "hybrid",
      groupAllowFromFallbackToAllowFrom: true,
      warnOnEmptyGroupSenderAllowlist: true,
    });
  });

  it("falls back conservatively for unknown external channels", () => {
    expect(getDoctorChannelCapabilities("external-demo")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: true,
      warnOnEmptyGroupSenderAllowlist: true,
    });
  });

  it("falls back conservatively when channel plugin resolution throws", () => {
    channelPluginMocks.getChannelPlugin.mockImplementation(() => {
      throw new Error("missing generated bundled module");
    });

    expect(resolveDoctorChannelAccountIds("telegram", {}, [])).toBeUndefined();
  });

  it("resolves configured and runtime account ids through plugin semantics", () => {
    channelPluginMocks.getChannelPlugin.mockReturnValue({
      config: {
        listAccountIds: () => ["default", "Work"],
        resolveAccount: (_cfg: unknown, accountId?: string | null) => ({
          accountId: accountId === "Work" ? "work" : accountId,
        }),
      },
    } as never);

    expect(resolveDoctorChannelAccountIds("signal", {}, ["Work"])).toEqual({
      configured: ["work"],
      runtime: ["default", "work"],
    });
  });
});
