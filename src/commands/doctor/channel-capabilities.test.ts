// Doctor channel capability tests cover channel capability inspection and diagnostics.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectChannelDmPolicyDependencyWarnings } from "../../config/validation-channel-rules.js";
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

  it("returns canonical top-level route semantics from googlechat plugin metadata", () => {
    expect(getDoctorChannelCapabilities("googlechat")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "route",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    });
  });

  it("retains root and account Google Chat DM-policy safety warnings", () => {
    const dmAllowFromMode = getDoctorChannelCapabilities("googlechat").dmAllowFromMode;
    const warnings = collectChannelDmPolicyDependencyWarnings(
      {
        channels: {
          googlechat: {
            dmPolicy: "open",
            allowFrom: ["users/123"],
            accounts: {
              work: {
                dmPolicy: "open",
                allowFrom: ["users/456"],
              },
            },
          },
        },
      },
      { dmAllowFromModes: new Map([["googlechat", dmAllowFromMode]]) },
    );

    expect(warnings.map(({ path }) => path)).toEqual([
      "channels.googlechat.allowFrom",
      "channels.googlechat.accounts.work.allowFrom",
    ]);
  });

  it("returns Slack route semantics without loading its channel plugin", () => {
    expect(getDoctorChannelCapabilities("slack")).toEqual({
      dmAllowFromMode: "topOnly",
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
