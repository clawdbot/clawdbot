// Imessage tests cover doctor contract api plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function imessageConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { imessage: entry } } as never;
}

describe("imessage streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find(
    (rule) => rule.path.join(".") === "channels.imessage" && rule.message.includes("chunkMode"),
  );
  const accountRule = legacyConfigRules.find(
    (rule) =>
      rule.path.join(".") === "channels.imessage.accounts" && rule.message.includes("chunkMode"),
  );

  it("matches flat delivery aliases at root and account level", () => {
    expect(rootRule?.match?.({ chunkMode: "newline" }, {})).toBe(true);
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ blockStreamingCoalesce: { idleMs: 5 } }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { chunkMode: "newline" } }, {})).toBe(false);
    expect(accountRule?.match?.({ work: { blockStreaming: false } }, {})).toBe(true);
    expect(accountRule?.match?.({ work: { streaming: { block: { enabled: true } } } }, {})).toBe(
      false,
    );
  });
});

describe("imessage normalizeCompatibilityConfig streaming aliases", () => {
  it("moves flat delivery aliases into the nested streaming shape", () => {
    const result = normalizeCompatibilityConfig({
      cfg: imessageConfig({
        chunkMode: "newline",
        blockStreaming: true,
        accounts: {
          personal: {
            blockStreamingCoalesce: { idleMs: 250 },
          },
        },
      }),
    });

    const imessage = result.config.channels?.imessage as Record<string, unknown>;
    expect(imessage.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: true },
    });
    expect(imessage.chunkMode).toBeUndefined();
    expect(imessage.blockStreaming).toBeUndefined();
    const personal = expectDefined(
      (imessage.accounts as Record<string, Record<string, unknown>>).personal,
      "personal iMessage account",
    );
    // iMessage deep-merges root+account streaming at runtime
    // (mergeIMessageStreamingConfig), so migration keeps the account object
    // account-local instead of seeding root values into it.
    expect(personal.streaming).toEqual({
      block: { coalesce: { idleMs: 250 } },
    });
    expect(personal.blockStreamingCoalesce).toBeUndefined();
    for (const change of [
      "Moved channels.imessage.chunkMode → channels.imessage.streaming.chunkMode.",
      "Moved channels.imessage.blockStreaming → channels.imessage.streaming.block.enabled.",
      "Moved channels.imessage.accounts.personal.blockStreamingCoalesce → channels.imessage.accounts.personal.streaming.block.coalesce.",
    ]) {
      expect(result.changes).toContain(change);
    }
  });

  it("removes flat aliases when the nested value is already set", () => {
    const result = normalizeCompatibilityConfig({
      cfg: imessageConfig({
        chunkMode: "length",
        streaming: { chunkMode: "newline" },
      }),
    });

    const imessage = result.config.channels?.imessage as Record<string, unknown>;
    expect(imessage.streaming).toEqual({ chunkMode: "newline" });
    expect(imessage.chunkMode).toBeUndefined();
    expect(result.changes).toContain(
      "Removed channels.imessage.chunkMode (channels.imessage.streaming.chunkMode already set).",
    );
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalizeCompatibilityConfig({
      cfg: imessageConfig({
        chunkMode: "newline",
        blockStreaming: false,
        blockStreamingCoalesce: { minChars: 10 },
      }),
    });
    expect(first.changes.length).toBeGreaterThan(0);

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });

  it("leaves nested-only configs untouched", () => {
    const cfg = imessageConfig({
      streaming: { chunkMode: "newline", block: { enabled: true } },
    });
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });
});
