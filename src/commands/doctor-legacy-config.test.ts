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
  it("removes legacy browser relay bind host and migrates extension profiles", () => {
    const changes: string[] = [];
    const config = normalizeLegacyBrowserConfig(
      asLegacyConfig({
        browser: {
          relayBindHost: "127.0.0.1",
          profiles: {
            work: {
              driver: "extension",
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
    expect(config.browser?.profiles?.work?.driver).toBe("existing-session");
    expect(config.browser?.profiles?.keep?.driver).toBe("existing-session");
    expect(changes).toEqual([
      "Removed browser.relayBindHost (legacy Chrome extension relay setting; host-local Chrome now uses Chrome MCP existing-session attach).",
      'Moved browser.profiles.work.driver "extension" → "existing-session" (Chrome MCP attach).',
    ]);
  });
});
