// Covers safe base-dir and containment checks.
import { describe, expect, it } from "vitest";
import { isWithinDir } from "./path-safety.js";

describe("path-safety", () => {
  it.each([
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo", expected: true },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo/sub/file.txt", expected: true },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo/./nested/../file.txt", expected: true },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo-two/../demo/file.txt", expected: true },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo/../escape.txt", expected: false },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo-sibling/file.txt", expected: false },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo/../../escape.txt", expected: false },
    { rootDir: "/tmp/demo", targetPath: "sub/file.txt", expected: false },
  ])("checks containment for %j", ({ rootDir, targetPath, expected }) => {
    expect(isWithinDir(rootDir, targetPath)).toBe(expected);
  });
});
