// Mattermost tests cover doctor contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

function mattermostConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { mattermost: entry } } as never;
}

describe("mattermost streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find(
    (rule) => rule.path.join(".") === "channels.mattermost" && rule.message.includes("chunkMode"),
  );

  it("matches scalar streaming and flat delivery aliases but not the nested shape", () => {
    expect(rootRule?.match?.({ streaming: "block" }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: false }, {})).toBe(true);
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { mode: "block" } }, {})).toBe(false);
  });
});

describe("mattermost normalizeCompatibilityConfig streaming aliases", () => {
  it("moves scalar streaming into streaming.mode alongside flat delivery keys", () => {
    const result = normalizeCompatibilityConfig({
      cfg: mattermostConfig({
        streaming: "progress",
        chunkMode: "newline",
        blockStreamingCoalesce: { idleMs: 100 },
      }),
    });

    const mattermost = result.config.channels?.mattermost as unknown as Record<string, unknown>;
    expect(mattermost.streaming).toEqual({
      mode: "progress",
      chunkMode: "newline",
      block: { coalesce: { idleMs: 100 } },
    });
    expect(mattermost.chunkMode).toBeUndefined();
    expect(mattermost.blockStreamingCoalesce).toBeUndefined();
  });

  it("migrates boolean streaming off and seeds materialized account objects from root", () => {
    const result = normalizeCompatibilityConfig({
      cfg: mattermostConfig({
        streaming: false,
        accounts: {
          work: { blockStreaming: true },
        },
      }),
    });

    const mattermost = result.config.channels?.mattermost as unknown as Record<string, unknown>;
    expect(mattermost.streaming).toEqual({ mode: "off" });
    const work = (mattermost.accounts as Record<string, Record<string, unknown>>).work;
    // Mattermost's account merge replaces root streaming wholesale, so the
    // migrated account object carries the inherited root mode.
    expect(work?.streaming).toEqual({ mode: "off", block: { enabled: true } });
    expect(work?.blockStreaming).toBeUndefined();
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalizeCompatibilityConfig({
      cfg: mattermostConfig({ streaming: "partial", blockStreaming: true }),
    });
    expect(first.changes.length).toBeGreaterThan(0);

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});
