import { describe, expect, it } from "vitest";
import { migrateTelegramGroupConfig, migrateTelegramGroupsInPlace } from "./group-migration.js";

function createTelegramGlobalGroupConfig(groups: Record<string, Record<string, unknown>>) {
  return {
    channels: {
      telegram: {
        groups,
      },
    },
  };
}

function createTelegramAccountGroupConfig(
  accountId: string,
  groups: Record<string, Record<string, unknown>>,
) {
  return {
    channels: {
      telegram: {
        accounts: {
          [accountId]: {
            groups,
          },
        },
      },
    },
  };
}

describe("migrateTelegramGroupConfig", () => {
  it("migrates global group ids", () => {
    const cfg = createTelegramGlobalGroupConfig({
      "-123": { requireMention: false },
    });

    const result = migrateTelegramGroupConfig({
      cfg,
      accountId: "default",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(true);
    expect(cfg.channels.telegram.groups).toEqual({
      "-100123": { requireMention: false },
    });
  });

  it("migrates account-scoped groups", () => {
    const cfg = createTelegramAccountGroupConfig("primary", {
      "-123": { requireMention: true },
    });

    const result = migrateTelegramGroupConfig({
      cfg,
      accountId: "primary",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(true);
    expect(result.scopes).toEqual(["account"]);
    expect(cfg.channels.telegram.accounts.primary.groups).toEqual({
      "-100123": { requireMention: true },
    });
  });

  it("matches account ids case-insensitively", () => {
    const cfg = createTelegramAccountGroupConfig("Primary", {
      "-123": {},
    });

    const result = migrateTelegramGroupConfig({
      cfg,
      accountId: "primary",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(true);
    expect(cfg.channels.telegram.accounts.Primary.groups).toEqual({
      "-100123": {},
    });
  });

  it("skips migration when new id already exists", () => {
    const cfg = createTelegramGlobalGroupConfig({
      "-123": { requireMention: true },
      "-100123": { requireMention: false },
    });

    const result = migrateTelegramGroupConfig({
      cfg,
      accountId: "default",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(false);
    expect(result.skippedExisting).toBe(true);
    expect(cfg.channels.telegram.groups).toEqual({
      "-123": { requireMention: true },
      "-100123": { requireMention: false },
    });
  });

  it("no-ops when old and new group ids are the same", () => {
    const groups = {
      "-123": { requireMention: true },
    };
    const result = migrateTelegramGroupsInPlace(groups, "-123", "-123");
    expect(result).toEqual({ migrated: false, skippedExisting: false });
    expect(groups).toEqual({
      "-123": { requireMention: true },
    });
  });
});
