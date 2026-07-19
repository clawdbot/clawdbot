// Whatsapp tests cover doctor contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

function whatsappConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { whatsapp: entry } } as never;
}

describe("whatsapp streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find((rule) => rule.path.join(".") === "channels.whatsapp");

  it("matches flat delivery aliases but not the nested shape", () => {
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { block: { enabled: true } } }, {})).toBe(false);
  });
});

it("removes retired exposeErrorText at root and account level", () => {
  const result = normalizeCompatibilityConfig({
    cfg: whatsappConfig({ exposeErrorText: true, accounts: { work: { exposeErrorText: false } } }),
  });
  expect(result.config.channels?.whatsapp).toEqual({ accounts: { work: {} } });
  expect(result.changes).toContain("Removed retired channels.whatsapp.exposeErrorText.");
  expect(result.changes).toContain(
    "Removed retired channels.whatsapp.accounts.work.exposeErrorText.",
  );
});

describe("whatsapp normalizeCompatibilityConfig streaming aliases", () => {
  it("moves flat delivery aliases at root and account level with root seeding", () => {
    const result = normalizeCompatibilityConfig({
      cfg: whatsappConfig({
        chunkMode: "newline",
        blockStreaming: false,
        accounts: {
          personal: { blockStreamingCoalesce: { minChars: 20 } },
        },
      }),
    });

    const whatsapp = result.config.channels?.whatsapp as unknown as Record<string, unknown>;
    expect(whatsapp.streaming).toEqual({ chunkMode: "newline", block: { enabled: false } });
    expect(whatsapp.chunkMode).toBeUndefined();
    expect(whatsapp.blockStreaming).toBeUndefined();
    const personal = (whatsapp.accounts as Record<string, Record<string, unknown>>).personal;
    // WhatsApp's account merge replaces root streaming wholesale, so the
    // migrated account object carries the inherited root delivery settings.
    expect(personal?.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: false, coalesce: { minChars: 20 } },
    });
    expect(personal?.blockStreamingCoalesce).toBeUndefined();
  });

  it("seeds named accounts from accounts.default over root (layered inheritance)", () => {
    const result = normalizeCompatibilityConfig({
      cfg: whatsappConfig({
        chunkMode: "length",
        accounts: {
          default: { blockStreaming: true },
          work: { chunkMode: "newline" },
        },
      }),
    });

    const whatsapp = result.config.channels?.whatsapp as unknown as Record<string, unknown>;
    const accounts = whatsapp.accounts as Record<string, Record<string, unknown>>;
    expect(whatsapp.streaming).toEqual({ chunkMode: "length" });
    expect(accounts.default?.streaming).toEqual({
      chunkMode: "length",
      block: { enabled: true },
    });
    // The old flat keys resolved per key across named > accounts.default >
    // root, so the materialized work object must inherit the default
    // account's block setting, not just the root chunk mode.
    expect(accounts.work?.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: true },
    });

    const second = normalizeCompatibilityConfig({ cfg: result.config });
    expect(second.changes).toEqual([]);
  });

  it("resolves the default account case-insensitively when seeding named accounts", () => {
    // resolveAccountEntry matches account keys case-insensitively, so
    // `accounts.Default` is the runtime default account too.
    const result = normalizeCompatibilityConfig({
      cfg: whatsappConfig({
        accounts: {
          Default: { blockStreaming: true },
          work: { chunkMode: "newline" },
        },
      }),
    });

    const whatsapp = result.config.channels?.whatsapp as unknown as Record<string, unknown>;
    const accounts = whatsapp.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.work?.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: true },
    });
  });

  it("keeps the legacy ackReaction migration and stays idempotent", () => {
    const first = normalizeCompatibilityConfig({
      cfg: {
        messages: { ackReaction: "👀" },
        channels: { whatsapp: { blockStreaming: true } },
      } as never,
    });
    const whatsapp = first.config.channels?.whatsapp as unknown as Record<string, unknown>;
    expect(whatsapp.ackReaction).toEqual({ emoji: "👀", direct: false, group: "mentions" });
    expect(whatsapp.streaming).toEqual({ block: { enabled: true } });

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
  });
});
