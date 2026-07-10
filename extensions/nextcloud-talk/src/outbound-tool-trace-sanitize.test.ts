// Nextcloud Talk outbound must strip assistant internal tool-trace scaffolding
// before delivery, matching the shared channel sanitizer contract.
import { describe, expect, it } from "vitest";
import { nextcloudTalkPlugin } from "./channel.js";

function sanitizeOutboundText(text: string): string {
  const sanitizeText = nextcloudTalkPlugin.outbound?.sanitizeText;
  if (!sanitizeText) {
    throw new Error("Expected Nextcloud Talk outbound sanitizeText hook");
  }
  return sanitizeText({ text, payload: { text } });
}

describe("nextcloud-talk outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";
    expect(sanitizeOutboundText(text)).toBe("Done.");
  });

  it("strips XML tool-call scaffolding leaked into assistant text", () => {
    const text = '<tool_call>{"name":"exec"}</tool_call>Meeting notes sent.';
    expect(sanitizeOutboundText(text)).toBe("Meeting notes sent.");
  });

  it("strips multiline tool-response scaffolding leaked into assistant text", () => {
    const text = [
      "Checking now.",
      "<function_response>",
      'Searching for: "agenda"',
      "</function_response>",
      "Meeting notes sent.",
    ].join("\n");
    expect(sanitizeOutboundText(text)).toBe("Checking now.\n\nMeeting notes sent.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The agenda has 3 open action items.";
    expect(sanitizeOutboundText(text)).toBe(text);
  });

  it("preserves internal trace examples inside fenced code", () => {
    const text = ["Example:", "```", "⚠️ 🛠️ `search repos (agent)` failed", "```"].join("\n");
    expect(sanitizeOutboundText(text)).toBe(text);
  });
});
