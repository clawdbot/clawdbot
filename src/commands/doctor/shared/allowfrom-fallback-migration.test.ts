import { describe, expect, it, vi } from "vitest";
import { maybeRepairGroupAllowFromFallback } from "./allowfrom-fallback-migration.js";

vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode: channelName === "matrix" ? "nestedOnly" : "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: channelName !== "discord",
    warnOnEmptyGroupSenderAllowlist: true,
  }),
}));

describe("doctor group allowFrom fallback migration", () => {
  it("copies fallback allowFrom into explicit groupAllowFrom", () => {
    const result = maybeRepairGroupAllowFromFallback({
      channels: {
        telegram: {
          allowFrom: [123, "accessGroup:ops", "123"],
          groupPolicy: "allowlist",
        },
      },
    });

    expect(result.changes).toEqual([
      "channels.telegram.groupAllowFrom: copied 2 sender entries from allowFrom for explicit group allowlist.",
    ]);
    expect(result.config.channels?.telegram?.groupAllowFrom).toEqual(["123", "accessGroup:ops"]);
  });

  it("uses canonical nested dm allowFrom for nested channels", () => {
    const result = maybeRepairGroupAllowFromFallback({
      channels: {
        matrix: {
          allowFrom: ["@legacy:example.org"],
          dm: {
            allowFrom: ["@alice:example.org"],
          },
        },
      },
    });

    expect(result.changes).toEqual([
      "channels.matrix.groupAllowFrom: copied 1 sender entry from allowFrom for explicit group allowlist.",
    ]);
    expect(result.config.channels?.matrix?.groupAllowFrom).toEqual(["@alice:example.org"]);
  });

  it("preserves account-scoped fallback without broadening to the channel", () => {
    const result = maybeRepairGroupAllowFromFallback({
      channels: {
        signal: {
          allowFrom: ["parent"],
          accounts: {
            work: { allowFrom: ["work-user"] },
            personal: { groupAllowFrom: ["personal-user"], allowFrom: ["ignored"] },
          },
        },
      },
    });

    expect(result.changes).toEqual([
      "channels.signal.groupAllowFrom: copied 1 sender entry from allowFrom for explicit group allowlist.",
      "channels.signal.accounts.work.groupAllowFrom: copied 1 sender entry from allowFrom for explicit group allowlist.",
    ]);
    expect(result.config.channels?.signal?.groupAllowFrom).toEqual(["parent"]);
    expect(result.config.channels?.signal?.accounts?.work?.groupAllowFrom).toEqual(["work-user"]);
    expect(result.config.channels?.signal?.accounts?.personal?.groupAllowFrom).toEqual([
      "personal-user",
    ]);
  });

  it("does not shadow an inherited channel group allowlist for accounts", () => {
    const result = maybeRepairGroupAllowFromFallback({
      channels: {
        telegram: {
          allowFrom: ["dm-user"],
          groupAllowFrom: ["group-user"],
          accounts: {
            work: { allowFrom: ["work-dm-user"] },
          },
        },
      },
    });

    expect(result).toEqual({
      config: {
        channels: {
          telegram: {
            allowFrom: ["dm-user"],
            groupAllowFrom: ["group-user"],
            accounts: {
              work: { allowFrom: ["work-dm-user"] },
            },
          },
        },
      },
      changes: [],
    });
  });

  it("skips disabled channels, disabled accounts, and channels without fallback", () => {
    const cfg = {
      channels: {
        disabled: { enabled: false, allowFrom: ["user"] },
        telegram: {
          accounts: {
            disabled: { enabled: false, allowFrom: ["user"] },
          },
        },
        discord: { allowFrom: ["user"] },
        tools: { allowFrom: ["user"] },
      },
    };

    expect(maybeRepairGroupAllowFromFallback(cfg)).toEqual({ config: cfg, changes: [] });
  });

  it("skips generated channel schemas that reject groupAllowFrom", () => {
    const cfg = {
      channels: {
        slack: {
          allowFrom: ["U123"],
          accounts: {
            workspace: { allowFrom: ["U456"] },
          },
        },
      },
    };

    expect(maybeRepairGroupAllowFromFallback(cfg)).toEqual({ config: cfg, changes: [] });
  });
});
