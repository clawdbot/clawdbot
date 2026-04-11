import { describe, expect, it, vi } from "vitest";
import { scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan.js";

vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: channelName !== "imessage",
    warnOnEmptyGroupSenderAllowlist: channelName !== "discord",
  }),
}));

vi.mock("./channel-doctor.js", () => ({
  shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning: () => false,
}));

describe("doctor empty allowlist policy scan", () => {
  it("scans top-level and account-scoped channel warnings", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "allowlist",
            accounts: {
              work: { dmPolicy: "allowlist" },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([
      expect.stringContaining('channels.signal.dmPolicy is "allowlist" but allowFrom is empty'),
      expect.stringContaining(
        'channels.signal.accounts.work.dmPolicy is "allowlist" but allowFrom is empty',
      ),
    ]);
  });

  it("allows provider-specific extra warnings without importing providers", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
          },
        },
      },
      {
        doctorFixCommand: "openclaw doctor --fix",
        extraWarningsForAccount: ({ channelName, prefix }) =>
          channelName === "telegram" ? [`extra:${prefix}`] : [],
      },
    );

    expect(warnings).toContain("extra:channels.telegram");
  });
});
