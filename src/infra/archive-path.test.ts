// Covers the archive-path facade used by runtime path classification.
import { describe, expect, it } from "vitest";
import { isWindowsDrivePath } from "./archive-path.js";

describe("archive path helpers", () => {
  it.each([
    { value: "C:\\temp\\file.txt", expected: true },
    { value: "D:/temp/file.txt", expected: true },
    { value: "tmp/file.txt", expected: false },
    { value: "/tmp/file.txt", expected: false },
  ])("detects Windows drive paths for %j", ({ value, expected }) => {
    expect(isWindowsDrivePath(value)).toBe(expected);
  });
});
