// Doctor legacy-config tests cover compatibility normalizers for old channel, browser, and config shapes.
import { describe, expect, it } from "vitest";
import { normalizeLegacyStreamingAliases } from "../config/channel-compat-normalization.js";
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
  offModeLegacyNotice?: (pathPrefix: string) => string;
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
      offModeLegacyNotice: (pathPrefix) =>
        `${pathPrefix}.streaming remains off by default to avoid Discord preview-edit rate limits; set ${pathPrefix}.streaming.mode="partial" to opt in explicitly.`,
    });

    expect(res.entry.streaming).toEqual({ mode: "off" });
    expect(getLegacyProperty(res.entry, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streamMode → channels.discord.streaming.mode (off).",
      'channels.discord.streaming remains off by default to avoid Discord preview-edit rate limits; set channels.discord.streaming.mode="partial" to opt in explicitly.',
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
