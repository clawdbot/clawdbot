// Twitch outbound must strip assistant internal tool-trace scaffolding before
// delivery (#90684). The hook runs in core delivery before chunk planning, so
// the 500-char Twitch chunker only ever sees sanitized text.
import { describe, expect, it } from "vitest";
import { twitchPlugin } from "./plugin.js";

function sanitizeOutboundText(text: string): string {
  const sanitizeText = twitchPlugin.outbound?.sanitizeText;
  if (!sanitizeText) {
    throw new Error("Expected Twitch outbound sanitizeText hook");
  }
  return sanitizeText({ text, payload: { text } });
}

describe("twitch outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(sanitizeOutboundText(text)).toBe("Done.");
  });

  it("strips XML tool-call scaffolding leaked into assistant text", () => {
    const text = '<tool_call>{"name":"exec"}</tool_call>Stream is live.';

    expect(sanitizeOutboundText(text)).toBe("Stream is live.");
  });

  it("strips multiline tool-response scaffolding leaked into assistant text", () => {
    const text = [
      "Checking now.",
      "<function_response>",
      'Searching for: "stream status"',
      "</function_response>",
      "Stream is live.",
    ].join("\n");

    expect(sanitizeOutboundText(text)).toBe("Checking now.\n\nStream is live.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(sanitizeOutboundText(text)).toBe(text);
  });
});
