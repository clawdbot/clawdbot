import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config-contracts.js";
import {
  defineKeyMoveMigration,
  normalizeChannelConfigEntries,
  stripRetiredChannelKeys,
} from "./runtime-doctor.js";

function cfgWith(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { sample: entry } } as never;
}

describe("runtime-doctor channel helpers", () => {
  it("moves nested keys across wildcard entries and preserves canonical values", () => {
    const migration = defineKeyMoveMigration({
      scope: ["groups", "*"],
      from: ["allow"],
      to: ["enabled"],
    });
    const entry = {
      groups: {
        first: { allow: true },
        second: { allow: true, enabled: false },
        invalid: "skip",
      },
    };
    const changes: string[] = [];

    expect(migration.hasLegacy(entry)).toBe(true);
    expect(migration.normalize({ entry, pathPrefix: "channels.sample", changes })).toEqual({
      entry: {
        groups: {
          first: { enabled: true },
          second: { enabled: false },
          invalid: "skip",
        },
      },
      changed: true,
    });
    expect(changes).toEqual([
      "Moved channels.sample.groups.first.allow → channels.sample.groups.first.enabled.",
      "Removed channels.sample.groups.second.allow (channels.sample.groups.second.enabled already set).",
    ]);
  });

  it("supports mapped values, invalid removal, and empty-parent pruning", () => {
    const migration = defineKeyMoveMigration({
      from: ["thread", "requireExplicitMention"],
      to: ["implicitMentions", "threadParticipation"],
      map: (value) => (typeof value === "boolean" ? { value: !value } : null),
      pruneEmptySource: true,
    });
    const changes: string[] = [];
    const moved = migration.normalize({
      entry: { thread: { requireExplicitMention: true } },
      pathPrefix: "channels.sample",
      changes,
    });
    expect(moved.entry).toEqual({ implicitMentions: { threadParticipation: false } });
    expect(
      migration.normalize({
        entry: { thread: { requireExplicitMention: "yes" } },
        pathPrefix: "channels.sample",
        changes,
      }).entry,
    ).toEqual({});
    expect(changes).toEqual([
      "Moved channels.sample.thread.requireExplicitMention → channels.sample.implicitMentions.threadParticipation.",
      "Removed invalid channels.sample.thread.requireExplicitMention value.",
    ]);
  });

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
