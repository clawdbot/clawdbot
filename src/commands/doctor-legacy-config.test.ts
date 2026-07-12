// Doctor legacy-config tests cover compatibility normalizers for old channel, browser, and config shapes.
import { describe, expect, it } from "vitest";
import {
  normalizeLegacyChannelAliases,
  normalizeLegacyStreamingAliases,
  resolveLegacyAliasStreamingMode,
} from "../config/channel-compat-normalization.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeLegacyBrowserConfig } from "./doctor/shared/legacy-config-core-normalizers.js";

function asLegacyConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function getLegacyProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function normalizeStreaming(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  resolvedMode: string;
  aliasOnlyMode?: string;
  resolvedNativeTransport?: unknown;
}) {
  const changes: string[] = [];
  const result = normalizeLegacyStreamingAliases({
    ...params,
    changes,
    includePreviewChunk: true,
  });
  return { entry: result.entry, changes };
}

describe("normalizeCompatibilityConfigValues preview streaming aliases", () => {
  it("preserves telegram boolean streaming aliases as-is", () => {
    const res = normalizeStreaming({
      entry: { streaming: false },
      pathPrefix: "channels.telegram",
      resolvedMode: "off",
    });

    expect(res.entry.streaming).toEqual({ mode: "off" });
    expect(getLegacyProperty(res.entry, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.telegram.streaming (boolean) → channels.telegram.streaming.mode (off).",
    ]);
  });

  it("preserves discord boolean streaming aliases as-is", () => {
    const res = normalizeStreaming({
      entry: { streaming: true },
      pathPrefix: "channels.discord",
      resolvedMode: "partial",
    });

    expect(res.entry.streaming).toEqual({ mode: "partial" });
    expect(getLegacyProperty(res.entry, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streaming (boolean) → channels.discord.streaming.mode (partial).",
    ]);
  });

  it("preserves explicit discord streaming=false as-is", () => {
    const res = normalizeStreaming({
      entry: { streaming: false },
      pathPrefix: "channels.discord",
      resolvedMode: "off",
    });

    expect(res.entry.streaming).toEqual({ mode: "off" });
    expect(getLegacyProperty(res.entry, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streaming (boolean) → channels.discord.streaming.mode (off).",
    ]);
  });

  it("preserves discord streamMode when legacy config resolves to off", () => {
    const res = normalizeStreaming({
      entry: { streamMode: "off" },
      pathPrefix: "channels.discord",
      resolvedMode: "off",
    });

    expect(res.entry.streaming).toEqual({ mode: "off" });
    expect(getLegacyProperty(res.entry, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streamMode → channels.discord.streaming.mode (off).",
    ]);
  });

  it("pins the previous default mode when delivery-only aliases create the streaming object", () => {
    // Discord previews default to progress only while `streaming` is absent;
    // without aliasOnlyMode the migrated object would resolve to off.
    const res = normalizeStreaming({
      entry: { blockStreaming: true },
      pathPrefix: "channels.discord",
      resolvedMode: "off",
      aliasOnlyMode: "progress",
    });

    expect(res.entry.streaming).toEqual({ mode: "progress", block: { enabled: true } });
    expect(res.changes).toEqual([
      "Moved channels.discord.blockStreaming → channels.discord.streaming.block.enabled.",
      "Set channels.discord.streaming.mode (progress) to keep the previous default while migrating flat streaming keys.",
    ]);
  });

  it("keeps delivery-only alias migration mode-free without aliasOnlyMode", () => {
    const res = normalizeStreaming({
      entry: { blockStreaming: true },
      pathPrefix: "channels.telegram",
      resolvedMode: "partial",
    });

    expect(res.entry.streaming).toEqual({ block: { enabled: true } });
    expect(res.changes).toEqual([
      "Moved channels.telegram.blockStreaming → channels.telegram.streaming.block.enabled.",
    ]);
  });

  it("does not apply aliasOnlyMode when a legacy mode source exists", () => {
    const res = normalizeStreaming({
      entry: { streamMode: "partial", blockStreaming: true },
      pathPrefix: "channels.discord",
      resolvedMode: "partial",
      aliasOnlyMode: "progress",
    });

    expect(res.entry.streaming).toEqual({ mode: "partial", block: { enabled: true } });
    expect(res.changes).toEqual([
      "Moved channels.discord.streamMode → channels.discord.streaming.mode (partial).",
      "Moved channels.discord.blockStreaming → channels.discord.streaming.block.enabled.",
    ]);
  });

  it("does not apply aliasOnlyMode when a nested streaming object already exists", () => {
    // A pre-existing object already resolved with object-without-mode
    // semantics, so pinning a mode would change behavior instead of keeping it.
    const res = normalizeStreaming({
      entry: { streaming: { chunkMode: "newline" }, blockStreaming: true },
      pathPrefix: "channels.discord",
      resolvedMode: "off",
      aliasOnlyMode: "progress",
    });

    expect(res.entry.streaming).toEqual({ chunkMode: "newline", block: { enabled: true } });
    expect(res.changes).toEqual([
      "Moved channels.discord.blockStreaming → channels.discord.streaming.block.enabled.",
    ]);
  });

  it("preserves slack boolean streaming aliases as-is", () => {
    const res = normalizeStreaming({
      entry: { streaming: false },
      pathPrefix: "channels.slack",
      resolvedMode: "off",
      resolvedNativeTransport: false,
    });

    expect(res.entry.streaming).toEqual({
      mode: "off",
      nativeTransport: false,
    });
    expect(getLegacyProperty(res.entry, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.slack.streaming (boolean) → channels.slack.streaming.mode (off).",
      "Moved channels.slack.streaming (boolean) → channels.slack.streaming.nativeTransport.",
    ]);
  });
});

describe("normalizeLegacyChannelAliases account inheritance seeding", () => {
  // Discord-shaped options: object-without-mode default "off", absent default
  // "progress", account merge replaces the root streaming object wholesale.
  function normalizeChannel(
    entry: Record<string, unknown>,
    options?: { seedAccountStreamingFromRoot?: boolean },
  ) {
    const changes: string[] = [];
    const result = normalizeLegacyChannelAliases({
      entry,
      pathPrefix: "channels.discord",
      changes,
      seedAccountStreamingFromRoot: options?.seedAccountStreamingFromRoot ?? true,
      resolveStreamingOptions: (value) => ({
        resolvedMode: resolveLegacyAliasStreamingMode(value, "off"),
        aliasOnlyMode: "progress",
        includePreviewChunk: true,
      }),
    });
    return { entry: result.entry, changes };
  }

  function workStreaming(entry: Record<string, unknown>): unknown {
    return (entry.accounts as { work: Record<string, unknown> }).work.streaming;
  }

  it("pins the absent-object default when no root streaming object exists", () => {
    // Truth table row 1: root absent → account previously resolved the
    // channel's streaming-absent default, so migration pins it explicitly.
    const res = normalizeChannel({
      accounts: { work: { blockStreaming: true } },
    });

    expect(workStreaming(res.entry)).toEqual({
      mode: "progress",
      block: { enabled: true },
    });
    expect(res.changes).toEqual([
      "Moved channels.discord.accounts.work.blockStreaming → channels.discord.accounts.work.streaming.block.enabled.",
      "Set channels.discord.accounts.work.streaming.mode (progress) to keep the previous default while migrating flat streaming keys.",
    ]);
  });

  it("seeds the root object's mode and subfields when the root has a mode", () => {
    // Truth table row 2: account previously inherited the root object wholesale,
    // so the created account object copies mode plus subfields; no pin needed.
    const res = normalizeChannel({
      streaming: { mode: "block", block: { coalesce: { idleMs: 5 } } },
      accounts: { work: { chunkMode: "newline" } },
    });

    expect(workStreaming(res.entry)).toEqual({
      mode: "block",
      chunkMode: "newline",
      block: { coalesce: { idleMs: 5 } },
    });
    expect(res.entry.streaming).toEqual({ mode: "block", block: { coalesce: { idleMs: 5 } } });
    expect(res.changes).toEqual([
      "Moved channels.discord.accounts.work.chunkMode → channels.discord.accounts.work.streaming.chunkMode.",
      "Copied channels.discord.streaming into channels.discord.accounts.work.streaming to keep inherited settings while migrating flat streaming keys.",
    ]);
  });

  it("seeds subfields without pinning a mode when the root object has no mode", () => {
    // Truth table row 3: the account previously resolved the root object's
    // object-without-mode default; pinning absentObjectDefault would change it.
    const res = normalizeChannel({
      streaming: { chunkMode: "word" },
      accounts: { work: { blockStreaming: true } },
    });

    const streaming = workStreaming(res.entry) as Record<string, unknown>;
    expect(streaming).toEqual({
      chunkMode: "word",
      block: { enabled: true },
    });
    expect(streaming.mode).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.accounts.work.blockStreaming → channels.discord.accounts.work.streaming.block.enabled.",
      "Copied channels.discord.streaming into channels.discord.accounts.work.streaming to keep inherited settings while migrating flat streaming keys.",
    ]);
  });

  it("keeps account values over seeded root values on conflict", () => {
    const res = normalizeChannel({
      streaming: { mode: "block", chunkMode: "word" },
      accounts: { work: { streamMode: "partial", chunkMode: "newline" } },
    });

    expect(workStreaming(res.entry)).toEqual({
      mode: "partial",
      chunkMode: "newline",
    });
  });

  it("does not seed accounts whose streaming key already existed", () => {
    const res = normalizeChannel({
      streaming: { mode: "block", chunkMode: "word" },
      accounts: { work: { streaming: false } },
    });

    expect(workStreaming(res.entry)).toEqual({
      mode: "off",
    });
    expect(res.changes).toEqual([
      "Moved channels.discord.accounts.work.streaming (boolean) → channels.discord.accounts.work.streaming.mode (off).",
    ]);
  });

  it("does not seed for deep-merge channels so runtime inheritance keeps composing", () => {
    // Slack/iMessage deep-merge root+account streaming at runtime; copying root
    // values into the account config would freeze inheritance at fix time.
    const res = normalizeChannel(
      {
        streaming: { mode: "block", block: { coalesce: { idleMs: 5 } } },
        accounts: { work: { chunkMode: "newline" } },
      },
      { seedAccountStreamingFromRoot: false },
    );

    expect(workStreaming(res.entry)).toEqual({ chunkMode: "newline" });
    expect(res.changes).toEqual([
      "Moved channels.discord.accounts.work.chunkMode → channels.discord.accounts.work.streaming.chunkMode.",
    ]);
  });
});

describe("normalizeCompatibilityConfigValues browser compatibility aliases", () => {
  it("removes legacy browser relay bind host and stale extension relay cdpUrl", () => {
    const changes: string[] = [];
    const config = normalizeLegacyBrowserConfig(
      asLegacyConfig({
        browser: {
          relayBindHost: "127.0.0.1",
          profiles: {
            work: {
              driver: "extension",
              cdpUrl: "http://127.0.0.1:18792",
            },
            keep: {
              driver: "existing-session",
            },
          },
        },
      }),
      changes,
    );

    expect(
      (config.browser as { relayBindHost?: string } | undefined)?.relayBindHost,
    ).toBeUndefined();
    // driver "extension" is the live Chrome extension relay driver again; only
    // the retired relay endpoint URL gets stripped.
    expect(config.browser?.profiles?.work?.driver).toBe("extension");
    expect(config.browser?.profiles?.work?.cdpUrl).toBeUndefined();
    expect(config.browser?.profiles?.keep?.driver).toBe("existing-session");
    expect(changes).toEqual([
      "Removed browser.relayBindHost (legacy Chrome extension relay setting; the extension relay binds loopback on the profile cdpPort).",
      "Removed browser.profiles.work.cdpUrl (extension driver profiles own their relay endpoint).",
    ]);
  });
});
