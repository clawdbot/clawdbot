import { describe, expect, it } from "vitest";
import { lineOutboundAdapter } from "./outbound.js";

describe("line outbound sanitizeText", () => {
  const sanitize = (text: string) =>
    lineOutboundAdapter.sanitizeText?.({ text, payload: { text } });

  it("strips internal tool traces before standard outbound delivery", () => {
    const text = [
      "Done.",
      '<tool_call>{"name":"read","arguments":{"path":"secret"}}</tool_call>',
      "⚠️ 🛠️ `search repos (agent)` failed",
    ].join("\n");

    expect(sanitize(text)).toBe("Done.");
  });

  it("preserves literal tool-trace examples in fenced code", () => {
    const text = [
      "Example:",
      "```text",
      "⚠️ 🛠️ `search repos (agent)` failed",
      '<tool_call>{"name":"read"}</tool_call>',
      "```",
    ].join("\n");

    expect(sanitize(text)).toBe(text);
  });
});
