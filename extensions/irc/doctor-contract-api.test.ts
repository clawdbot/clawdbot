// Irc tests cover doctor contract api plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function ircConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { irc: entry } } as never;
}

describe("irc streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find((rule) => rule.path.join(".") === "channels.irc");
  const accountRule = legacyConfigRules.find(
    (rule) => rule.path.join(".") === "channels.irc.accounts",
  );

  it("matches flat delivery aliases at root and account level", () => {
    expect(rootRule?.match?.({ blockStreaming: false }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { block: { enabled: false } } }, {})).toBe(false);
    expect(accountRule?.match?.({ libera: { chunkMode: "newline" } }, {})).toBe(true);
    expect(accountRule?.match?.({ libera: { streaming: { chunkMode: "newline" } } }, {})).toBe(
      false,
    );
  });
});

describe("irc normalizeCompatibilityConfig streaming aliases", () => {
  it("moves flat delivery aliases and seeds materialized account objects from root", () => {
    const result = normalizeCompatibilityConfig({
      cfg: ircConfig({
        blockStreaming: true,
        accounts: {
          libera: { chunkMode: "newline" },
        },
      }),
    });

    const irc = result.config.channels?.irc as unknown as Record<string, unknown>;
    expect(irc.streaming).toEqual({ block: { enabled: true } });
    expect(irc.blockStreaming).toBeUndefined();
    const libera = expectDefined(
      (irc.accounts as Record<string, Record<string, unknown>>).libera,
      "libera irc account",
    );
    // IRC's account merge replaces the root streaming object wholesale, so the
    // migrated account object must carry the inherited root block settings.
    expect(libera.streaming).toEqual({ chunkMode: "newline", block: { enabled: true } });
    expect(libera.chunkMode).toBeUndefined();
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalizeCompatibilityConfig({
      cfg: ircConfig({ chunkMode: "length", blockStreamingCoalesce: { minChars: 10 } }),
    });
    expect(first.changes.length).toBeGreaterThan(0);

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});

describe("irc retired mentionPatterns migration", () => {
  it("flags and strips the retired key at root and account scope", () => {
    const cfg = ircConfig({
      host: "irc.libera.chat",
      mentionPatterns: ["\\bopenclaw\\b"],
      accounts: { work: { nick: "openclaw-ops", mentionPatterns: ["\\bops\\b"] } },
    });

    const rootRule = legacyConfigRules.find(
      (rule) => rule.path.join(".") === "channels.irc" && rule.message?.includes("mentionPatterns"),
    );
    const accountRule = legacyConfigRules.find(
      (rule) =>
        rule.path.join(".") === "channels.irc.accounts" &&
        rule.message?.includes("mentionPatterns"),
    );
    expect(rootRule?.match?.({ mentionPatterns: ["x"] }, {})).toBe(true);
    expect(rootRule?.match?.({ host: "irc.libera.chat" }, {})).toBe(false);
    expect(accountRule?.match?.({ work: { mentionPatterns: ["x"] } }, {})).toBe(true);
    expect(accountRule?.match?.({ work: { nick: "n" } }, {})).toBe(false);

    const result = normalizeCompatibilityConfig({ cfg });
    const irc = expectDefined(
      (result.config.channels as Record<string, Record<string, unknown>> | undefined)?.irc,
      "channels.irc",
    );
    expect(irc.mentionPatterns).toBeUndefined();
    expect(irc.host).toBe("irc.libera.chat");
    const accounts = irc.accounts as Record<string, Record<string, unknown> | undefined>;
    const workAccount = expectDefined(accounts.work, "channels.irc.accounts.work");
    expect(workAccount.mentionPatterns).toBeUndefined();
    expect(workAccount.nick).toBe("openclaw-ops");
    expect(result.changes.some((change) => change.includes("mentionPatterns"))).toBe(true);
  });

  it("leaves a config without the retired key untouched", () => {
    const result = normalizeCompatibilityConfig({ cfg: ircConfig({ host: "irc.libera.chat" }) });
    expect(result.changes.some((change) => change.includes("mentionPatterns"))).toBe(false);
  });
});
