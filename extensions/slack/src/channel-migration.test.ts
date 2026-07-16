import { describe, expect, it } from "vitest";
import { migrateSlackChannelConfig, migrateSlackChannelsInPlace } from "./channel-migration.js";

function createSlackGlobalChannelConfig(channels: Record<string, Record<string, unknown>>) {
  return {
    channels: {
      slack: {
        channels,
      },
    },
  };
}

function createSlackAccountChannelConfig(
  accountId: string,
  channels: Record<string, Record<string, unknown>>,
) {
  return {
    channels: {
      slack: {
        accounts: {
          [accountId]: {
            channels,
          },
        },
      },
    },
  };
}

describe("migrateSlackChannelConfig", () => {
  it("migrates global channel ids", () => {
    const cfg = createSlackGlobalChannelConfig({
      C123: { requireMention: false },
    });

    const result = migrateSlackChannelConfig({
      cfg,
      accountId: "default",
      oldChannelId: "C123",
      newChannelId: "C999",
    });

    expect(result.migrated).toBe(true);
    expect(cfg.channels.slack.channels).toEqual({
      C999: { requireMention: false },
    });
  });

  it("migrates account-scoped channels", () => {
    const cfg = createSlackAccountChannelConfig("primary", {
      C123: { requireMention: true },
    });

    const result = migrateSlackChannelConfig({
      cfg,
      accountId: "primary",
      oldChannelId: "C123",
      newChannelId: "C999",
    });

    expect(result.migrated).toBe(true);
    expect(result.scopes).toEqual(["account"]);
    expect(cfg.channels.slack.accounts.primary.channels).toEqual({
      C999: { requireMention: true },
    });
  });

  it("matches account ids case-insensitively", () => {
    const cfg = createSlackAccountChannelConfig("Primary", {
      C123: {},
    });

    const result = migrateSlackChannelConfig({
      cfg,
      accountId: "primary",
      oldChannelId: "C123",
      newChannelId: "C999",
    });

    expect(result.migrated).toBe(true);
    expect(cfg.channels.slack.accounts.Primary.channels).toEqual({
      C999: {},
    });
  });

  it("skips migration when new id already exists", () => {
    const cfg = createSlackGlobalChannelConfig({
      C123: { requireMention: true },
      C999: { requireMention: false },
    });

    const result = migrateSlackChannelConfig({
      cfg,
      accountId: "default",
      oldChannelId: "C123",
      newChannelId: "C999",
    });

    expect(result.migrated).toBe(false);
    expect(result.skippedExisting).toBe(true);
    expect(cfg.channels.slack.channels).toEqual({
      C123: { requireMention: true },
      C999: { requireMention: false },
    });
  });

  it("no-ops when old and new channel ids are the same", () => {
    const channels = {
      C123: { requireMention: true },
    };
    const result = migrateSlackChannelsInPlace(channels, "C123", "C123");
    expect(result).toEqual({ migrated: false, skippedExisting: false });
    expect(channels).toEqual({
      C123: { requireMention: true },
    });
  });
});
