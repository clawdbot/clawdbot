// Signal outbound must strip assistant internal tool-trace scaffolding, matching
// the sibling channel fixes tracked under #90684 (Telegram #95774 / Google Chat
// #95084 / IRC #97214). Signal is plaintext-only, so leaked traces are verbatim.
import { describe, expect, it } from "vitest";
import { signalPlugin } from "./channel.js";

describe("signal outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(signalPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(signalPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });
});
