// iMessage outbound must strip assistant internal tool-trace scaffolding,
// matching the sibling channel fixes tracked under #90684 while preserving the
// channel-specific plain-text cleanup that already existed.
import { describe, expect, it } from "vitest";
import { imessagePlugin } from "./channel.js";

describe("imessage outbound sanitizeText", () => {
  it("strips downgraded tool-call text before outbound delivery", () => {
    const text = [
      "[Tool Call: read (ID: toolu_1)]",
      'Arguments: {"path":"/tmp/internal"}',
      "Done.",
    ].join("\n");

    expect(imessagePlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(imessagePlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });
});
