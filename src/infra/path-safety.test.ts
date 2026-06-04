// Covers safe base-dir and containment checks.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWithinDir, resolveSafeBaseDir } from "./path-safety.js";

describe("path-safety", () => {
  it.each([
    { rootDir: "/tmp/demo", expected: `${path.resolve("/tmp/demo")}${path.sep}` },
    { rootDir: `/tmp/demo${path.sep}`, expected: `${path.resolve("/tmp/demo")}${path.sep}` },
    { rootDir: "/tmp/demo/..", expected: `${path.resolve("/tmp")}${path.sep}` },
  ])("resolves safe base dir for %j", ({ rootDir, expected }) => {
    expect(resolveSafeBaseDir(rootDir)).toBe(expected);
  });

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
