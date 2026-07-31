// Tests for the declarative channel doctor alias-migration DSL.
import { describe, expect, it } from "vitest";
import { defineChannelAliasMigration } from "./channel-alias-migration.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function cfgWith(channelId: string, entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { [channelId]: entry } } as never;
}

describe("defineChannelAliasMigration message generation", () => {
  it("generates preview-chunk channel messages (discord shape)", () => {
    const migration = defineChannelAliasMigration({
      channelId: "discord",
      streaming: { defaultMode: "off", absentObjectDefault: "progress", includePreviewChunk: true },
    });

    expect(migration.legacyConfigRules.map((rule) => rule.message)).toEqual([
      'channels.discord.streamMode, channels.discord.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.discord.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}. Run "openclaw doctor --fix".',
      'channels.discord.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.discord.accounts.<id>.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}. Run "openclaw doctor --fix".',
    ]);
    expect(migration.legacyConfigRules.map((rule) => rule.path)).toEqual([
      ["channels", "discord"],
      ["channels", "discord", "accounts"],
    ]);
  });

  it("generates native-transport channel messages (slack shape)", () => {
    const migration = defineChannelAliasMigration({
      channelId: "slack",
      streaming: { defaultMode: "partial", resolveNativeTransport: () => true },
    });

    expect(migration.legacyConfigRules.map((rule) => rule.message)).toEqual([
      'channels.slack.streamMode, channels.slack.streaming (scalar), chunkMode, blockStreaming, blockStreamingCoalesce, and nativeStreaming are legacy; use channels.slack.streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport}. Run "openclaw doctor --fix".',
      'channels.slack.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, blockStreamingCoalesce, and nativeStreaming are legacy; use channels.slack.accounts.<id>.streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport}. Run "openclaw doctor --fix".',
    ]);
  });

  it("generates delivery-only channel messages (imessage shape)", () => {
    const migration = defineChannelAliasMigration({
      channelId: "imessage",
      streaming: { defaultMode: "partial", deliveryOnly: true },
    });

    expect(migration.legacyConfigRules.map((rule) => rule.message)).toEqual([
      'channels.imessage.chunkMode, blockStreaming, and blockStreamingCoalesce are legacy; use channels.imessage.streaming.{chunkMode,block.enabled,block.coalesce}. Run "openclaw doctor --fix".',
      'channels.imessage.accounts.<id>.chunkMode, blockStreaming, and blockStreamingCoalesce are legacy; use channels.imessage.accounts.<id>.streaming.{chunkMode,block.enabled,block.coalesce}. Run "openclaw doctor --fix".',
    ]);
  });

  it("generates plain mode channel messages (msteams shape)", () => {
    const migration = defineChannelAliasMigration({
      channelId: "msteams",
      streaming: { defaultMode: "partial" },
    });

    expect(migration.legacyConfigRules[0]?.message).toBe(
      'channels.msteams.streamMode, channels.msteams.streaming (scalar), chunkMode, blockStreaming, and blockStreamingCoalesce are legacy; use channels.msteams.streaming.{mode,chunkMode,block.enabled,block.coalesce}. Run "openclaw doctor --fix".',
    );
  });
});

describe("defineChannelAliasMigration rule matching", () => {
  it("matches root and account entries per spec options", () => {
    const migration = defineChannelAliasMigration({
      channelId: "discord",
      streaming: { defaultMode: "off", includePreviewChunk: true },
    });
    const [rootRule, accountsRule] = migration.legacyConfigRules;

    expect(rootRule?.match?.({ streamMode: "block" }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: false }, {})).toBe(true);
    expect(rootRule?.match?.({ draftChunk: { minChars: 5 } }, {})).toBe(true);
    expect(rootRule?.match?.({ nativeStreaming: false }, {})).toBe(false);
    expect(rootRule?.match?.({ streaming: { mode: "off" } }, {})).toBe(false);
    expect(accountsRule?.match?.({ work: { blockStreaming: true } }, {})).toBe(true);
    expect(accountsRule?.match?.({ work: { streaming: { mode: "off" } } }, {})).toBe(false);
  });

  it("matches nativeStreaming only for native-transport channels", () => {
    const migration = defineChannelAliasMigration({
      channelId: "slack",
      streaming: { defaultMode: "partial", resolveNativeTransport: () => true },
    });

    expect(migration.hasLegacyAliases({ nativeStreaming: false })).toBe(true);
    expect(migration.hasLegacyAliases({ draftChunk: {} })).toBe(false);
  });

  it("excludes mode sources for delivery-only channels", () => {
    const migration = defineChannelAliasMigration({
      channelId: "imessage",
      streaming: { defaultMode: "partial", deliveryOnly: true },
    });

    expect(migration.hasLegacyAliases({ chunkMode: "newline" })).toBe(true);
    expect(migration.hasLegacyAliases({ streamMode: "block" })).toBe(false);
    expect(migration.hasLegacyAliases({ streaming: "partial" })).toBe(false);
    expect(migration.hasLegacyAliases({ streaming: false })).toBe(false);
  });

  it("matches nested DM aliases at root and account scope", () => {
    const migration = defineChannelAliasMigration({
      channelId: "googlechat",
      streaming: { defaultMode: "partial", deliveryOnly: true },
      dm: { root: true, accounts: true },
    });
    const [rootDmRule, accountDmRule] = migration.legacyConfigRules.slice(2);

    expect(rootDmRule?.match?.({ dm: { policy: "open" } }, {})).toBe(true);
    expect(accountDmRule?.match?.({ work: { dm: { allowFrom: ["users/1"] } } }, {})).toBe(true);
    expect(rootDmRule?.match?.({ dmPolicy: "open" }, {})).toBe(false);
  });
});

describe("defineChannelAliasMigration normalizeChannelConfig", () => {
  it("migrates root and account aliases with dm normalization", () => {
    const migration = defineChannelAliasMigration({
      channelId: "discord",
      streaming: { defaultMode: "off", absentObjectDefault: "progress", includePreviewChunk: true },
      accountStreamingReplacesRoot: true,
      dm: { root: true, accounts: true },
    });

    const changes: string[] = [];
    const result = migration.normalizeChannelConfig({
      cfg: cfgWith("discord", {
        streamMode: "block",
        dm: { policy: "open" },
        accounts: { work: { draftChunk: { minChars: 9 } } },
      }),
      changes,
    });

    expect(result.changes).toBe(changes);
    expect((result.config.channels as Record<string, unknown>).discord).toEqual({
      dmPolicy: "open",
      streaming: { mode: "block" },
      accounts: {
        work: {
          streaming: { mode: "block", preview: { chunk: { minChars: 9 } } },
        },
      },
    });
    expect(changes).toEqual([
      "Moved channels.discord.dm.policy → channels.discord.dmPolicy.",
      "Removed empty channels.discord.dm after migration.",
      "Moved channels.discord.streamMode → channels.discord.streaming.mode (block).",
      "Moved channels.discord.accounts.work.draftChunk → channels.discord.accounts.work.streaming.preview.chunk.",
      "Copied channels.discord.streaming into channels.discord.accounts.work.streaming to keep inherited settings while migrating flat streaming keys.",
    ]);
  });

  it("routes the escape hatch into per-account migration", () => {
    const migration = defineChannelAliasMigration({
      channelId: "discord",
      streaming: { defaultMode: "off" },
      normalizeAccountExtra: ({ account, pathPrefix, changes }) => {
        if (account.legacyFlag === undefined) {
          return { entry: account, changed: false };
        }
        const { legacyFlag: _ignored, ...rest } = account;
        changes.push(`Removed ${pathPrefix}.legacyFlag.`);
        return { entry: rest, changed: true };
      },
    });

    const result = migration.normalizeChannelConfig({
      cfg: cfgWith("discord", { accounts: { work: { legacyFlag: true } } }),
    });

    expect(result.changes).toEqual(["Removed channels.discord.accounts.work.legacyFlag."]);
    expect((result.config.channels as Record<string, unknown>).discord).toEqual({
      accounts: { work: {} },
    });
  });

  it("returns the unchanged sentinel when nothing matches", () => {
    const migration = defineChannelAliasMigration({
      channelId: "msteams",
      streaming: { defaultMode: "partial" },
    });

    const modern = cfgWith("msteams", { streaming: { mode: "partial" } });
    const untouched = migration.normalizeChannelConfig({ cfg: modern });
    expect(untouched.config).toBe(modern);
    expect(untouched.changes).toEqual([]);

    const missing = { channels: {} } as never;
    expect(migration.normalizeChannelConfig({ cfg: missing }).config).toBe(missing);
  });

  it("skips scalar streaming values entirely for delivery-only channels", () => {
    const migration = defineChannelAliasMigration({
      channelId: "imessage",
      streaming: { defaultMode: "partial", deliveryOnly: true },
    });

    // Scalar `streaming` is a validation error for delivery-only channels, not
    // a migratable legacy shape, so the migration must not touch it.
    const scalarOnly = cfgWith("imessage", { streaming: "partial" });
    expect(migration.normalizeChannelConfig({ cfg: scalarOnly }).config).toBe(scalarOnly);

    const result = migration.normalizeChannelConfig({
      cfg: cfgWith("imessage", { accounts: { work: { chunkMode: "newline" } } }),
    });
    expect(result.changes).toEqual([
      "Moved channels.imessage.accounts.work.chunkMode → channels.imessage.accounts.work.streaming.chunkMode.",
    ]);
  });

  it("migrates DM aliases even when a delivery-only channel has no streaming aliases", () => {
    const migration = defineChannelAliasMigration({
      channelId: "googlechat",
      streaming: { defaultMode: "partial", deliveryOnly: true },
      dm: { root: true, accounts: true },
    });

    const result = migration.normalizeChannelConfig({
      cfg: cfgWith("googlechat", {
        dm: { enabled: false, policy: "allowlist", allowFrom: ["users/root"] },
        accounts: { work: { dm: { policy: "open", allowFrom: ["*"] } } },
      }),
    });

    expect((result.config.channels as Record<string, unknown>).googlechat).toEqual({
      dmPolicy: "allowlist",
      allowFrom: ["users/root"],
      dm: { enabled: false },
      accounts: { work: { dmPolicy: "open", allowFrom: ["*"] } },
    });
  });

  it("materializes root and default-account streaming inheritance", () => {
    const migration = defineChannelAliasMigration({
      channelId: "layered",
      streaming: { defaultMode: "partial", deliveryOnly: true },
      accountStreamingInheritsDefaultAccount: true,
    });
    const result = migration.normalizeChannelConfig({
      cfg: cfgWith("layered", {
        streaming: { block: { enabled: true } },
        accounts: {
          Default: { chunkMode: "newline" },
          work: { blockStreamingCoalesce: { minChars: 20 } },
        },
      }),
    });

    expect((result.config.channels as Record<string, unknown>).layered).toEqual({
      streaming: { block: { enabled: true } },
      accounts: {
        Default: { streaming: { block: { enabled: true }, chunkMode: "newline" } },
        work: {
          streaming: {
            block: { enabled: true, coalesce: { minChars: 20 } },
            chunkMode: "newline",
          },
        },
      },
    });
    expect(result.changes.slice(-2)).toEqual([
      "Copied channels.layered.streaming into channels.layered.accounts.Default.streaming to keep inherited settings while migrating flat streaming keys.",
      "Copied channels.layered.accounts.Default.streaming into channels.layered.accounts.work.streaming to keep inherited settings while migrating flat streaming keys.",
    ]);
  });
});
