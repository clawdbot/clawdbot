import { describe, expect, it } from "vitest";
import { basenameFromAnyPath, extnameFromAnyPath, nameFromAnyPath } from "./file-name.js";

describe("basenameFromAnyPath", () => {
  it.each([
    ["a/b/c.txt", "c.txt"],
    ["a\\b\\c.txt", "c.txt"],
    ["../../evil.txt", "evil.txt"],
    ["..\\..\\evil.txt", "evil.txt"],
    ["normal.png", "normal.png"],
    ["...", "..."],
    ["file..txt", "file..txt"],
    ["", ""],
  ])("reduces %j to %j", (input, expected) => {
    expect(basenameFromAnyPath(input)).toBe(expected);
  });

  it.each([".", "..", "foo/.", "foo/..", "a/b/..", "..\\", "foo\\..", "C:\\x\\..", "/a/b/../"])(
    "never returns a path-navigation segment for %j",
    (input) => {
      expect(basenameFromAnyPath(input)).toBe("");
    },
  );
});

describe("nameFromAnyPath / extnameFromAnyPath", () => {
  it("splits a normal filename into name and extension", () => {
    expect(nameFromAnyPath("a/b/c.txt")).toBe("c");
    expect(extnameFromAnyPath("a/b/c.txt")).toBe(".txt");
  });

  it("does not leak a path-navigation segment", () => {
    expect(nameFromAnyPath("foo/..")).toBe("");
    expect(extnameFromAnyPath("foo/..")).toBe("");
  });
});
