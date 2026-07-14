// Googlechat tests cover doctor contract plugin behavior.
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("googlechat doctor contract", () => {
  it("removes legacy streamMode keys", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          googlechat: {
            streamMode: "append",
            accounts: {
              work: {
                streamMode: "replace",
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toEqual([
      "Removed channels.googlechat.streamMode (legacy key no longer used).",
      "Removed channels.googlechat.accounts.work.streamMode (legacy key no longer used).",
    ]);
    expect(result.config.channels?.googlechat).toEqual({
      accounts: {
        work: {},
      },
    });
  });

  it("moves legacy group allow toggles into enabled", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          googlechat: {
            groups: {
              "spaces/aaa": {
                allow: false,
              },
              "spaces/bbb": {
                allow: true,
                enabled: false,
              },
            },
            accounts: {
              work: {
                groups: {
                  "spaces/ccc": {
                    allow: true,
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toEqual([
      "Moved channels.googlechat.groups.spaces/aaa.allow → channels.googlechat.groups.spaces/aaa.enabled.",
      "Removed channels.googlechat.groups.spaces/bbb.allow (channels.googlechat.groups.spaces/bbb.enabled already set).",
      "Moved channels.googlechat.accounts.work.groups.spaces/ccc.allow → channels.googlechat.accounts.work.groups.spaces/ccc.enabled.",
    ]);
    expect(result.config.channels?.googlechat?.groups?.["spaces/aaa"]).toEqual({
      enabled: false,
    });
    expect(result.config.channels?.googlechat?.groups?.["spaces/bbb"]).toEqual({
      enabled: false,
    });
    expect(result.config.channels?.googlechat?.accounts?.work?.groups?.["spaces/ccc"]).toEqual({
      enabled: true,
    });
  });

  it("matches flat streaming aliases in legacy rules but not the nested shape", () => {
    const rootRule = legacyConfigRules.find(
      (rule) => rule.path.join(".") === "channels.googlechat" && rule.message.includes("chunkMode"),
    );
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { block: { enabled: true } } }, {})).toBe(false);
  });

  it("moves flat delivery aliases at root and account level with root seeding", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          googlechat: {
            streamMode: "append",
            chunkMode: "newline",
            accounts: {
              work: { blockStreaming: true },
            },
          },
        },
      } as never,
    });

    const googlechat = result.config.channels?.googlechat as unknown as Record<string, unknown>;
    expect(googlechat.streamMode).toBeUndefined();
    expect(googlechat.streaming).toEqual({ chunkMode: "newline" });
    expect(googlechat.chunkMode).toBeUndefined();
    const work = (googlechat.accounts as Record<string, Record<string, unknown>>).work;
    // Google Chat's account merge replaces root streaming wholesale, so the
    // migrated account object carries the inherited root chunk mode.
    expect(work?.streaming).toEqual({ chunkMode: "newline", block: { enabled: true } });
    expect(work?.blockStreaming).toBeUndefined();

    const second = normalizeCompatibilityConfig({ cfg: result.config });
    expect(second.changes).toEqual([]);
  });
});
