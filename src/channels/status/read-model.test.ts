import { describe, expect, it } from "vitest";
import {
  findRuntimeChannelAccount,
  getRuntimeChannelAccounts,
  hasRuntimeCredentialAvailable,
  markConfiguredUnavailableCredentialStatusesAvailable,
  normalizeRuntimeChannelAccountSnapshots,
  resolveChannelAccountStatusRows,
} from "./read-model.js";

describe("channel status read model", () => {
  it("normalizes gateway channel account snapshots by channel", () => {
    const accounts = normalizeRuntimeChannelAccountSnapshots({
      channelAccounts: {
        discord: [
          { accountId: "default", configured: true },
          { name: "missing-account-id", configured: true },
        ],
        slack: { accountId: "default" },
      },
    });

    expect(accounts.get("discord")).toStrictEqual([{ accountId: "default", configured: true }]);
    expect(accounts.has("slack")).toBe(false);
  });

  it("merges runtime-only accounts and prefers gateway snapshots", async () => {
    const rows = await resolveChannelAccountStatusRows({
      localAccountIds: ["default"],
      runtimeAccounts: [
        { accountId: "default", configured: true, tokenSource: "env" },
        { accountId: "ops", configured: true, tokenSource: "env" },
      ],
      resolveLocalSnapshot: async (accountId) => ({
        accountId,
        configured: false,
        tokenSource: "none",
      }),
    });

    expect(rows).toStrictEqual([
      {
        accountId: "default",
        source: "gateway",
        snapshot: { accountId: "default", configured: true, tokenSource: "env" },
      },
      {
        accountId: "ops",
        source: "gateway",
        snapshot: { accountId: "ops", configured: true, tokenSource: "env" },
      },
    ]);
  });

  it("finds legacy live accounts by id/name fallback for status summaries", () => {
    const liveAccounts = getRuntimeChannelAccounts({
      payload: {
        channelAccounts: {
          discord: [{ name: "default", running: true }],
        },
      },
      channelId: "discord",
    });

    expect(findRuntimeChannelAccount({ liveAccounts, accountId: "default" })).toStrictEqual({
      name: "default",
      running: true,
    });
    expect(hasRuntimeCredentialAvailable({ liveAccounts, accountId: "default" })).toBe(true);
  });

  it("does not treat unavailable runtime credentials as available", () => {
    const liveAccounts = [
      { accountId: "default", running: true, tokenStatus: "configured_unavailable" },
    ];

    expect(hasRuntimeCredentialAvailable({ liveAccounts, accountId: "default" })).toBe(false);
  });

  it("marks configured-unavailable credential statuses available for runtime-backed summaries", () => {
    expect(
      markConfiguredUnavailableCredentialStatusesAvailable({
        tokenStatus: "configured_unavailable",
        userTokenStatus: "configured_unavailable",
        appTokenStatus: "missing",
      }),
    ).toStrictEqual({
      tokenStatus: "available",
      userTokenStatus: "available",
      appTokenStatus: "missing",
    });
  });
});
