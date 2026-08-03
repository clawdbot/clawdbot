// Sessions table tests cover shared fixed-width cell formatting.
import { describe, expect, it } from "vitest";
import { formatSessionKeyCell, SESSION_KEY_PAD } from "./sessions-table.js";

describe("formatSessionKeyCell", () => {
  it("keeps both truncation boundaries UTF-16 safe", () => {
    const key = `${"a".repeat(15)}😀middle😀${"z".repeat(5)}`;

    const rendered = formatSessionKeyCell(key, false);

    expect(rendered).toBe(`${"a".repeat(15)}...${"z".repeat(5)}`.padEnd(SESSION_KEY_PAD));
    expect(rendered).toHaveLength(SESSION_KEY_PAD);
  });
});
