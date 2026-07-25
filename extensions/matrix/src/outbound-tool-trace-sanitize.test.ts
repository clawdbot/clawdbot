// Matrix outbound must strip assistant internal tool-trace scaffolding, matching
// the sibling channel fixes tracked under #90684 (Telegram #95774 / Google Chat
// #95084 / IRC #97214). The hook runs before the markdown->HTML render, so a
// single sanitize cleans both the plain body and the formatted_body.
import { describe, expect, it } from "vitest";
import { matrixPlugin } from "./channel.js";

describe("matrix outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(matrixPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(matrixPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });
});
