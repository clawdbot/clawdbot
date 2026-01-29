import { describe, expect, it } from "vitest";
import { globToRegex, matchesList, matchesTarget, matchesRule } from "./matchers.js";

describe("globToRegex", () => {
  it("should match exact strings", () => {
    const re = globToRegex("/src/index.ts");
    expect(re.test("/src/index.ts")).toBe(true);
    expect(re.test("/src/other.ts")).toBe(false);
  });

  it("should support * for single-segment wildcards", () => {
    const re = globToRegex("/src/*.ts");
    expect(re.test("/src/index.ts")).toBe(true);
    expect(re.test("/src/foo.ts")).toBe(true);
    expect(re.test("/src/sub/foo.ts")).toBe(false);
  });

  it("should support ** for multi-segment wildcards", () => {
    const re = globToRegex("/src/**/*.ts");
    expect(re.test("/src/foo.ts")).toBe(true);
    expect(re.test("/src/a/b/c.ts")).toBe(true);
    expect(re.test("/other/foo.ts")).toBe(false);
  });

  it("should support ? for single character", () => {
    const re = globToRegex("file?.ts");
    expect(re.test("file1.ts")).toBe(true);
    expect(re.test("fileAB.ts")).toBe(false);
  });

  it("should escape regex special characters", () => {
    const re = globToRegex("file.test.ts");
    expect(re.test("file.test.ts")).toBe(true);
    expect(re.test("filextest.ts")).toBe(false);
  });
});

describe("matchesList", () => {
  it("should return true for exact match", () => {
    expect(matchesList("Bash", ["Bash", "Write"])).toBe(true);
  });

  it("should return false for no match", () => {
    expect(matchesList("Read", ["Bash", "Write"])).toBe(false);
  });

  it("should be case-sensitive", () => {
    expect(matchesList("bash", ["Bash"])).toBe(false);
  });
});

describe("matchesTarget", () => {
  it("should match glob patterns", () => {
    expect(matchesTarget("/src/foo.ts", ["/src/*.ts"], false)).toBe(true);
    expect(matchesTarget("/src/foo.js", ["/src/*.ts"], false)).toBe(false);
  });

  it("should match regex patterns", () => {
    expect(matchesTarget("rm -rf /", ["rm\\s+-rf"], true)).toBe(true);
    expect(matchesTarget("ls -la", ["rm\\s+-rf"], true)).toBe(false);
  });

  it("should match if any pattern matches", () => {
    expect(matchesTarget("rm -rf /", ["mkfs\\.", "rm\\s+-rf"], true)).toBe(true);
  });

  it("should return false for undefined target", () => {
    expect(matchesTarget(undefined, ["*"], false)).toBe(false);
  });
});

describe("matchesRule", () => {
  it("should match when all criteria match", () => {
    expect(
      matchesRule("Bash", "command", "rm -rf /", {
        tools: ["Bash"],
        categories: ["command"],
        targetPatterns: ["rm\\s+-rf"],
        targetPatternsAreRegex: true,
      }),
    ).toBe(true);
  });

  it("should fail when tool doesn't match", () => {
    expect(
      matchesRule("Read", "file_read", "/foo", {
        tools: ["Bash"],
      }),
    ).toBe(false);
  });

  it("should fail when category doesn't match", () => {
    expect(
      matchesRule("Bash", "command", "ls", {
        categories: ["network"],
      }),
    ).toBe(false);
  });

  it("should fail when target doesn't match", () => {
    expect(
      matchesRule("Bash", "command", "ls -la", {
        targetPatterns: ["rm\\s+-rf"],
        targetPatternsAreRegex: true,
      }),
    ).toBe(false);
  });

  it("should match when no criteria are specified (empty match)", () => {
    expect(matchesRule("Bash", "command", "anything", {})).toBe(true);
  });

  it("should match with only tools specified", () => {
    expect(matchesRule("Write", "file_write", "/foo", { tools: ["Write", "Edit"] })).toBe(true);
  });

  it("should match with only categories specified", () => {
    expect(matchesRule("WebFetch", "network", "https://x.com", { categories: ["network"] })).toBe(true);
  });
});
