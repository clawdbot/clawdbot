// Signal tests cover doctor contract api plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function signalConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { signal: entry } } as never;
}

describe("signal streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find((rule) => rule.path.join(".") === "channels.signal");
  const accountRule = legacyConfigRules.find(
    (rule) => rule.path.join(".") === "channels.signal.accounts",
  );

  it("matches flat delivery aliases at root and account level", () => {
    expect(rootRule?.match?.({ chunkMode: "newline" }, {})).toBe(true);
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { chunkMode: "newline" } }, {})).toBe(false);
    expect(accountRule?.match?.({ personal: { blockStreamingCoalesce: { idleMs: 5 } } }, {})).toBe(
      true,
    );
    expect(
      accountRule?.match?.({ personal: { streaming: { block: { enabled: true } } } }, {}),
    ).toBe(false);
  });
});

describe("signal normalizeCompatibilityConfig streaming aliases", () => {
  it("moves flat delivery aliases and seeds materialized account objects from root", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        chunkMode: "newline",
        blockStreaming: true,
        accounts: {
          personal: {
            blockStreamingCoalesce: { idleMs: 250 },
          },
        },
      }),
    });

    const signal = result.config.channels?.signal as unknown as Record<string, unknown>;
    expect(signal.streaming).toEqual({ chunkMode: "newline", block: { enabled: true } });
    expect(signal.chunkMode).toBeUndefined();
    expect(signal.blockStreaming).toBeUndefined();
    const personal = expectDefined(
      (signal.accounts as Record<string, Record<string, unknown>>).personal,
      "personal signal account",
    );
    // Signal's account merge replaces the root streaming object wholesale, so
    // the account object migration materializes must carry the inherited root
    // settings or `doctor --fix` would silently drop them for this account.
    expect(personal.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: true, coalesce: { idleMs: 250 } },
    });
    expect(personal.blockStreamingCoalesce).toBeUndefined();
    expect(result.changes).toContain(
      "Copied channels.signal.streaming into channels.signal.accounts.personal.streaming to keep inherited settings while migrating flat streaming keys.",
    );
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalizeCompatibilityConfig({
      cfg: signalConfig({
        chunkMode: "newline",
        accounts: { personal: { blockStreaming: false } },
      }),
    });
    expect(first.changes.length).toBeGreaterThan(0);

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});
