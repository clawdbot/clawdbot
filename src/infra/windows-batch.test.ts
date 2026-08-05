import { describe, expect, it } from "vitest";
import { normalizeNewWindowsBatchContent } from "./windows-batch.js";

describe("normalizeNewWindowsBatchContent", () => {
  it.each(["script.cmd", "script.CMD", "script.bat"])("normalizes %s to CRLF", (filePath) => {
    expect(normalizeNewWindowsBatchContent(filePath, "first\nsecond\r\nthird\rfourth")).toBe(
      "first\r\nsecond\r\nthird\r\nfourth",
    );
  });

  it("leaves non-batch files unchanged", () => {
    const content = "first\nsecond\r\n";
    expect(normalizeNewWindowsBatchContent("notes.txt", content)).toBe(content);
  });
});
