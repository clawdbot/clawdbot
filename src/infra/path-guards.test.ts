// Covers path guard helpers for platform and symlink errors.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  isPathInside,
  normalizeWindowsPathForComparison,
  normalizeWindowsPathPreservingCase,
} from "./path-guards.js";

function setPlatform(platform: NodeJS.Platform): void {
  mockProcessPlatform(platform);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeWindowsPathForComparison", () => {
  it.each([
    ["\\\\?\\C:\\Users\\Peter/Repo", "c:\\users\\peter\\repo"],
    ["\\\\?\\UNC\\Server\\Share\\Folder", "\\\\server\\share\\folder"],
    ["\\\\?\\unc\\Server\\Share\\Folder", "\\\\server\\share\\folder"],
  ])("normalizes windows path %s", (input, expected) => {
    expect(normalizeWindowsPathForComparison(input)).toBe(expected);
  });
});

describe("normalizeWindowsPathPreservingCase", () => {
  // Callers create files from paths derived off this, so case must survive. The
  // equivalence case below pins that case is the *only* thing that differs from the
  // comparison variant; these rows pin the concrete shapes.
  it.each([
    ["\\\\?\\C:\\Users\\Peter/Repo", "C:\\Users\\Peter\\Repo"],
    ["\\\\?\\UNC\\Server\\Share\\Folder", "\\\\Server\\Share\\Folder"],
    ["\\\\?\\unc\\Server\\Share\\Folder", "\\\\Server\\Share\\Folder"],
    ["C:\\Users\\User\\OpenClaw\\src/Components", "C:\\Users\\User\\OpenClaw\\src\\Components"],
    ["C:\\Users\\User\\OpenClaw  ", "C:\\Users\\User\\OpenClaw"],
  ])("normalizes windows path %s without lowercasing", (input, expected) => {
    expect(normalizeWindowsPathPreservingCase(input)).toBe(expected);
  });

  it("matches the comparison variant except for case", () => {
    for (const input of [
      "\\\\?\\C:\\Users\\Peter/Repo",
      "\\\\?\\UNC\\Server\\Share\\Folder",
      "\\\\?\\unc\\Server\\Share\\Folder",
      "C:\\Users\\User\\OpenClaw\\src/Components",
      "C:\\Users\\User\\OpenClaw  ",
      "  C:\\Users\\User\\OpenClaw  ",
    ]) {
      expect(normalizeWindowsPathPreservingCase(input).toLowerCase()).toBe(
        normalizeWindowsPathForComparison(input),
      );
    }
  });
});

describe("isPathInside", () => {
  it.each([
    ["/workspace/root", "/workspace/root", true],
    ["/workspace/root", "/workspace/root/nested/file.txt", true],
    ["/workspace/root", "/workspace/root/..file.txt", true],
    ["/workspace/root", "/workspace/root/../escape.txt", false],
    ["/workspace/root", "/workspace/rootless/file.txt", false],
    ["/workspace/root", "/workspace/root/a/b/c/d/e/file.txt", true],
    ["/workspace/root", "/workspace/root/a/..", true],
    ["/workspace/root", "/workspace/root/a/../..", false],
    ["/workspace/root", "/workspace/root/a/b/../../../escape", false],
    ["/", "/anything/at/all", true],
    ["/", "/", true],
    ["foo", "foo/bar", true],
    ["foo", "../escape", false],
  ])("checks posix containment %s -> %s", (basePath, targetPath, expected) => {
    expect(isPathInside(basePath, targetPath)).toBe(expected);
  });

  it("uses win32 path semantics for windows containment checks", () => {
    setPlatform("win32");

    for (const [basePath, targetPath, expected] of [
      [String.raw`C:\workspace\root`, String.raw`C:\workspace\root`, true],
      [String.raw`C:\workspace\root`, String.raw`C:\workspace\root\Nested\File.txt`, true],
      [String.raw`C:\workspace\root`, String.raw`C:\workspace\root\..file.txt`, true],
      [String.raw`C:\workspace\root`, String.raw`C:\workspace\root\..\escape.txt`, false],
      [String.raw`C:\workspace\root`, String.raw`D:\workspace\root\file.txt`, false],
    ] as const) {
      expect(isPathInside(basePath, targetPath)).toBe(expected);
    }
  });
});
