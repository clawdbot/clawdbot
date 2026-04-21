import { describe, expect, it } from "vitest";
import { filterToolNamesByMessageProvider } from "./pi-tools.message-provider-policy.js";

const DEFAULT_TOOL_NAMES = ["read", "write", "tts", "web_search"];

describe("createOpenClawCodingTools message provider policy", () => {
  it.each(["voice", "VOICE", " Voice "])(
    "does not expose tts tool for normalized voice provider: %s",
    (messageProvider) => {
      const names = new Set(filterToolNamesByMessageProvider(DEFAULT_TOOL_NAMES, messageProvider));
      expect(names.has("tts")).toBe(false);
    },
  );

  it("keeps tts tool for non-voice providers", () => {
    const names = new Set(filterToolNamesByMessageProvider(DEFAULT_TOOL_NAMES, "guildchat"));
    expect(names.has("tts")).toBe(true);
  });
});
