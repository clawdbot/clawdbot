import { describe, expect, it } from "vitest";
import { zaloPlugin } from "./channel.js";

function sanitizeOutboundText(text: string): string {
  const sanitizeText = zaloPlugin.outbound?.sanitizeText;
  if (!sanitizeText) {
    throw new Error("Expected Zalo outbound sanitizeText hook");
  }
  return sanitizeText({ text, payload: { text } });
}

describe("zalo outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    expect(sanitizeOutboundText("Done.\n⚠️ 🛠️ `search repos (agent)` failed")).toBe("Done.");
  });

  it("strips XML tool-call scaffolding leaked into assistant text", () => {
    expect(sanitizeOutboundText('<tool_call>{"name":"exec"}</tool_call>Message sent.')).toBe(
      "Message sent.",
    );
  });

  it("preserves ordinary assistant prose", () => {
    const text = "The group has 5 active members.";
    expect(sanitizeOutboundText(text)).toBe(text);
  });

  it("preserves literal tool-call examples inside fenced code", () => {
    const text = ["```xml", '<tool_call>{"name":"exec"}</tool_call>', "```"].join("\n");
    expect(sanitizeOutboundText(text)).toBe(text);
  });

  it("returns empty text when the payload contains only an internal trace", () => {
    expect(sanitizeOutboundText("⚠️ 🛠️ `search repos (agent)` failed")).toBe("");
  });
});
