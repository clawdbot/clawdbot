import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { resolveDiscordDraftStreamingChunking } from "./draft-chunking.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "./test-support/config.js";

describe("resolveDiscordDraftStreamingChunking", () => {
  it("returns sane defaults when discord draft chunking is unset", () => {
    expect(resolveDiscordDraftStreamingChunking(EMPTY_DISCORD_TEST_CONFIG)).toEqual({
      minChars: 200,
      maxChars: 800,
      breakPreference: "paragraph",
    });
  });

  it("clamps requested draft chunk sizes to the resolved text limit", () => {
    const cfg = {
      channels: {
        discord: {
          textChunkLimit: 500,
          draftChunk: {
            minChars: 900,
            maxChars: 1200,
            breakPreference: "sentence",
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveDiscordDraftStreamingChunking(cfg)).toEqual({
      minChars: 500,
      maxChars: 500,
      breakPreference: "sentence",
    });
  });

  it("prefers account draft chunking over channel defaults", () => {
    const cfg = {
      channels: {
        discord: {
          draftChunk: {
            minChars: 200,
            maxChars: 800,
            breakPreference: "paragraph",
          },
          accounts: {
            ops: {
              draftChunk: {
                minChars: 25,
                maxChars: 75,
                breakPreference: "newline",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveDiscordDraftStreamingChunking(cfg, "ops")).toEqual({
      minChars: 25,
      maxChars: 75,
      breakPreference: "newline",
    });
  });
});
