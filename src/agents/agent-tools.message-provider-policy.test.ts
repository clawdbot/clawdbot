/**
 * Tests message-provider tool filtering.
 * Voice-like transports should not expose text-to-speech when that surface is
 * unsafe or redundant for the active channel.
 */
import { describe, expect, it } from "vitest";
import { filterToolsByMessageProvider } from "./agent-tools.message-provider-policy.js";

const DEFAULT_TOOLS = [
  { name: "read" },
  { name: "write" },
  { name: "tts" },
  { name: "web_search" },
];

function toolNames(tools: readonly { name: string }[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

describe("createOpenClawCodingTools message provider policy", () => {
  it.each(["voice", "VOICE", " Voice ", "discord-voice", "DISCORD-VOICE", " Discord-Voice "])(
    "does not expose tts tool for normalized voice provider: %s",
    (messageProvider) => {
      const names = toolNames(filterToolsByMessageProvider(DEFAULT_TOOLS, messageProvider));
      expect(names.has("tts")).toBe(false);
    },
  );

  it("keeps tts tool for non-voice providers", () => {
    const names = toolNames(filterToolsByMessageProvider(DEFAULT_TOOLS, "guildchat"));
    expect(names.has("tts")).toBe(true);
  });

  it("preserves duplicate tool entries while filtering", () => {
    const tools = [
      { name: "read", id: 1 },
      { name: "tts", id: 2 },
      { name: "read", id: 3 },
    ];
    expect(filterToolsByMessageProvider(tools, "voice")).toStrictEqual([
      { name: "read", id: 1 },
      { name: "read", id: 3 },
    ]);
  });
});
