import { describe, expect, it } from "vitest";
import { stripUnsupportedCitationControlMarkers } from "./citation-control-markers.js";

describe("stripUnsupportedCitationControlMarkers", () => {
  it("removes citation control markers and line-end spacing they leave behind", () => {
    expect(stripUnsupportedCitationControlMarkers("v2026.5.20 citeturn2view0")).toBe(
      "v2026.5.20",
    );
  });

  it("preserves unrelated trailing whitespace", () => {
    expect(stripUnsupportedCitationControlMarkers("hard break  \nnext")).toBe("hard break  \nnext");
  });
});
