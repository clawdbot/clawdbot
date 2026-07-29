// Discord tests cover draft chunking plugin behavior.
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
});
