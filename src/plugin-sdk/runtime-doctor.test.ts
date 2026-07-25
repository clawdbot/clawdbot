import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config-contracts.js";
import { normalizeChannelConfigEntries, stripRetiredChannelKeys } from "./runtime-doctor.js";

function cfgWith(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { sample: entry } } as never;
}

describe("runtime-doctor channel helpers", () => {
  it("normalizes the root and every object-shaped account in order", () => {
    const changeLog: string[] = [];
    const result = normalizeChannelConfigEntries({
      cfg: cfgWith({ legacy: true, accounts: { work: { legacy: false }, invalid: "skip" } }),
      channelId: "sample",
      changes: changeLog,
      normalizeEntry: ({ entry, pathPrefix, changes }) => {
        if (!Object.hasOwn(entry, "legacy")) {
          return { entry, changed: false };
        }
        const { legacy: _legacy, ...rest } = entry;
        changes.push(`Removed ${pathPrefix}.legacy.`);
        return { entry: rest, changed: true };
      },
    });

    expect(result.changes).toBe(changeLog);
    expect(result.changes).toEqual([
      "Removed channels.sample.legacy.",
      "Removed channels.sample.accounts.work.legacy.",
    ]);
    expect((result.config.channels as Record<string, unknown>).sample).toEqual({
      accounts: { work: {}, invalid: "skip" },
    });
  });

  it("supports recursive and root-account-only retired key scopes", () => {
    const source = cfgWith({
      retired: 1,
      nested: { retired: 2 },
      accounts: { work: { retired: 3, nested: { retired: 4 } } },
    });
    const keys = new Set(["retired"]);

    const scoped = stripRetiredChannelKeys({
      cfg: source,
      channelId: "sample",
      keys,
      scope: "root-and-accounts",
    });
    expect((scoped.config.channels as Record<string, unknown>).sample).toEqual({
      nested: { retired: 2 },
      accounts: { work: { nested: { retired: 4 } } },
    });

    const recursive = stripRetiredChannelKeys({
      cfg: source,
      channelId: "sample",
      keys,
      scope: "recursive",
    });
    expect((recursive.config.channels as Record<string, unknown>).sample).toEqual({
      nested: {},
      accounts: { work: { nested: {} } },
    });
  });
});
