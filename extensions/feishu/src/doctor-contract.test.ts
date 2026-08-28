// Feishu tests cover doctor contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

function feishuConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { feishu: entry } } as never;
}

describe("feishu streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find(
    (rule) => rule.path.join(".") === "channels.feishu" && rule.message.includes("chunkMode"),
  );
  const accountsRule = legacyConfigRules.find(
    (rule) =>
      rule.path.join(".") === "channels.feishu.accounts" && rule.message.includes("chunkMode"),
  );

  it("matches boolean streaming and flat delivery aliases but not the nested shape", () => {
    expect(rootRule?.match?.({ streaming: false }, {})).toBe(true);
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ blockStreamingCoalesce: { idleMs: 100 } }, {})).toBe(true);
    expect(rootRule?.match?.({ chunkMode: "newline" }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { mode: "partial" } }, {})).toBe(false);
  });

  it("matches account entries carrying flat aliases", () => {
    expect(accountsRule?.match?.({ main: { streaming: true } }, {})).toBe(true);
    expect(accountsRule?.match?.({ main: { streaming: { mode: "off" } } }, {})).toBe(false);
  });
});

describe("feishu normalizeCompatibilityConfig streaming aliases", () => {
  it("migrates boolean streaming plus flat delivery keys into the nested shape", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        streaming: false,
        chunkMode: "newline",
        blockStreaming: true,
        blockStreamingCoalesce: { idleMs: 100 },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    expect(feishu.streaming).toEqual({
      mode: "off",
      chunkMode: "newline",
      block: { enabled: true, coalesce: { idleMs: 100 } },
    });
    expect(feishu.chunkMode).toBeUndefined();
    expect(feishu.blockStreaming).toBeUndefined();
    expect(feishu.blockStreamingCoalesce).toBeUndefined();
  });

  it("maps streaming true to mode partial, preserving the streaming-card enable", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({ streaming: true }),
    });
    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    expect(feishu.streaming).toEqual({ mode: "partial" });
  });

  it("seeds materialized account objects from root (account merge replaces wholesale)", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        streaming: { mode: "off", chunkMode: "newline" },
        accounts: {
          work: { blockStreaming: true },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    const work = (feishu.accounts as Record<string, Record<string, unknown>>).work;
    // Feishu's account merge replaces root streaming wholesale, so the
    // migrated account object carries the inherited root settings (copying
    // freezes inheritance at fix time by design; the change message says so).
    expect(work?.streaming).toEqual({
      mode: "off",
      chunkMode: "newline",
      block: { enabled: true },
    });
    expect(work?.blockStreaming).toBeUndefined();
  });

  it("seeds root FLAT delivery keys into accounts that already had a streaming object", () => {
    // Pre-migration, root flat keys resolved per-key for every account even
    // when the account's own streaming object replaced the root object
    // wholesale; migration must not silently drop that inherited behavior.
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        blockStreaming: true,
        accounts: {
          work: { streaming: { mode: "off" } },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    expect(feishu.streaming).toEqual({ block: { enabled: true } });
    const work = (feishu.accounts as Record<string, Record<string, unknown>>).work;
    expect(work?.streaming).toEqual({ mode: "off", block: { enabled: true } });
  });

  it("keeps canonical root nested values over conflicting account flat keys", () => {
    // Pre-migration the resolvers read the merged nested object first, so an
    // account flat key was dead whenever root nested set the same slot.
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        streaming: { block: { enabled: false } },
        accounts: {
          work: { blockStreaming: true },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    const work = (feishu.accounts as Record<string, Record<string, unknown>>).work;
    expect(work?.streaming).toEqual({ block: { enabled: false } });
  });

  it("keeps account-set delivery fields over root flat keys when seeding", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        chunkMode: "newline",
        accounts: {
          work: { streaming: { chunkMode: "length" } },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    const work = (feishu.accounts as Record<string, Record<string, unknown>>).work;
    // Account nested values won over root flat keys pre-migration too.
    expect(work?.streaming).toEqual({ chunkMode: "length" });
  });

  it("does not seed accounts whose streaming object already existed", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        streaming: { chunkMode: "newline" },
        accounts: {
          work: { streaming: { mode: "off" }, blockStreaming: true },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    const work = (feishu.accounts as Record<string, Record<string, unknown>>).work;
    expect(work?.streaming).toEqual({ mode: "off", block: { enabled: true } });
  });

  it("moves tools.base to tools.bitable at root and account scope", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        tools: { base: false, doc: true },
        accounts: {
          work: { tools: { base: false } },
          canonical: { tools: { base: false, bitable: true } },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    expect(feishu.tools).toEqual({ bitable: false, doc: true });
    const accounts = feishu.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.work?.tools).toEqual({ bitable: false });
    expect(accounts.canonical?.tools).toEqual({ bitable: true });
    expect(FeishuConfigSchema.safeParse(feishu).success).toBe(true);
  });

  it("sanitizes legacy Feishu-only coalesce fields so doctor output validates", () => {
    // The retired Feishu coalesce schema advertised enabled/minDelayMs/
    // maxDelayMs, which no runtime path read; migrated output must still pass
    // the strict nested schema.
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        blockStreamingCoalesce: { enabled: true, minDelayMs: 100, maxDelayMs: 200 },
        accounts: {
          work: { blockStreamingCoalesce: { minDelayMs: 50 } },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    expect(feishu.streaming).toEqual({ block: { coalesce: {} } });
    const work = (feishu.accounts as Record<string, Record<string, unknown>>).work;
    expect(work?.streaming).toEqual({ block: { coalesce: {} } });
    expect(FeishuConfigSchema.safeParse(feishu).success).toBe(true);
  });

  it("strips unread legacy Feishu heartbeat fields at root and account scope", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        heartbeat: { visibility: "hidden", intervalMs: 1000 },
        accounts: {
          work: { heartbeat: { visibility: "visible" } },
          empty: { heartbeat: {} },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    expect(feishu.heartbeat).toBeUndefined();
    const work = (feishu.accounts as Record<string, Record<string, unknown>>).work;
    expect(work?.heartbeat).toBeUndefined();
    const empty = (feishu.accounts as Record<string, Record<string, unknown>>).empty;
    expect(empty?.heartbeat).toBeUndefined();
    expect(result.changes).toEqual([
      "Removed channels.feishu.heartbeat (legacy Feishu fields were never read by runtime).",
      "Removed channels.feishu.accounts.work.heartbeat (legacy Feishu fields were never read by runtime).",
      "Removed channels.feishu.accounts.empty.heartbeat (legacy Feishu fields were never read by runtime).",
    ]);
    expect(FeishuConfigSchema.safeParse(feishu).success).toBe(true);
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalizeCompatibilityConfig({
      cfg: feishuConfig({ streaming: true, blockStreaming: true, tools: { base: false } }),
    });
    expect(first.changes.length).toBeGreaterThan(0);

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});

describe("feishu webhook route doctor migration", () => {
  const webhookRule = legacyConfigRules.find((rule) => rule.message.includes("webhookPath"));

  it("detects noncanonical webhook paths at root and account scope", () => {
    expect(webhookRule?.match?.({ webhookPath: "/hook#fragment" }, {})).toBe(true);
    expect(webhookRule?.match?.({ accounts: { main: { webhookPath: "hook" } } }, {})).toBe(true);
    expect(webhookRule?.match?.({ webhookPath: "/hook/?tenant=alpha" }, {})).toBe(false);
  });

  it.each([
    ["hook#fragment", "/hook"],
    ["/hook?tenant=alpha#fragment", "/hook?tenant=alpha"],
    ["/hook?", "/hook?"],
    ["/hook?#", "/hook"],
    ["/other/%2e%2e/hook", "/hook"],
    ["/other\\..\\hook", "/hook"],
    ["//example.com/hook", "/hook"],
    ["https://example.com/hook/?tenant=alpha#fragment", "/hook/?tenant=alpha"],
    ["/café", "/caf%C3%A9"],
    ["/hook name", "/hook%20name"],
    ["/hook\u0000name", "/hook%00name"],
    ["/hook%23fragment", "/hook%23fragment"],
    ["", "/feishu/events"],
    ["   ", "/feishu/events"],
    ["mailto:hello@example.com", "/feishu/events"],
    ["javascript:alert(1)", "/feishu/events"],
    ["ftp://example.com/hook", "/feishu/events"],
    ["file:///tmp/hook", "/feishu/events"],
    ["//[", "/feishu/events"],
  ])("repairs root and account webhook path %j to %j", (webhookPath, expectedPath) => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({ webhookPath, accounts: { main: { webhookPath } } }),
    });
    const feishu = result.config.channels?.feishu as unknown as {
      webhookPath?: string;
      accounts?: Record<string, { webhookPath?: string }>;
    };

    expect(feishu.webhookPath).toBe(expectedPath);
    expect(feishu.accounts?.main?.webhookPath).toBe(expectedPath);
    expect(FeishuConfigSchema.safeParse(feishu).success).toBe(true);
    if (webhookPath === expectedPath) {
      expect(result.changes).toEqual([]);
    } else {
      expect(result.changes).toEqual([
        expect.stringContaining("channels.feishu.webhookPath"),
        expect.stringContaining("channels.feishu.accounts.main.webhookPath"),
      ]);
    }

    const second = normalizeCompatibilityConfig({ cfg: result.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(result.config);
  });

  it("reports actionable default repairs without echoing malformed operator URLs", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({ webhookPath: "javascript:alert(operator-private-value)" }),
    });

    expect(result.changes).toEqual([
      "Reset invalid channels.feishu.webhookPath to /feishu/events.",
    ]);
  });
});
