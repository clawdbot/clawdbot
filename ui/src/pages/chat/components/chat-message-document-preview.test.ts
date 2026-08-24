import { describe, expect, it } from "vitest";
import { parseDelimitedPreview } from "./chat-message-document-preview.ts";

describe("parseDelimitedPreview", () => {
  it("bounds columns and total cells for a wide CSV row", () => {
    const wideRow = Array.from({ length: 8_192 }, () => "x").join(",");
    const preview = parseDelimitedPreview(Array.from({ length: 8 }, () => wideRow).join("\n"));
    const cellCount = preview.reduce((total, row) => total + row.length, 0);

    expect(Math.max(...preview.map((row) => row.length))).toBeLessThanOrEqual(24);
    expect(cellCount).toBeLessThanOrEqual(128);
  });
});
