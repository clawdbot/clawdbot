import { afterEach, describe, expect, it } from "vitest";
import {
  hasNodeErrorCode,
  isNodeError,
  isNotFoundPathError,
  isPathInside,
  isSymlinkOpenError,
  normalizeWindowsPathForComparison,
} from "./path-guards.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
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

describe("node path error helpers", () => {
  it.each([
    [{ code: "ENOENT" }, true],
    [{ message: "nope" }, false],
  ])("detects node-style error %j", (value, expected) => {
    expect(isNodeError(value)).toBe(expected);
  });

  it.each([
    [{ code: "ENOENT" }, "ENOENT", true],
    [{ code: "ENOENT" }, "EACCES", false],
  ])("matches node error code for %j", (value, code, expected) => {
    expect(hasNodeErrorCode(value, code)).toBe(expected);
  });

  it.each([
    [{ code: "ENOENT" }, true],
    [{ code: "ENOTDIR" }, true],
    [{ code: "EACCES" }, false],
    [{ code: 404 }, false],
  ])("classifies not-found path error for %j", (value, expected) => {
    expect(isNotFoundPathError(value)).toBe(expected);
  });

  it.each([
    [{ code: "ELOOP" }, true],
    [{ code: "EINVAL" }, true],
    [{ code: "ENOTSUP" }, true],
    [{ code: "ENOENT" }, false],
    [{ code: null }, false],
  ])("classifies symlink-open error for %j", (value, expected) => {
    expect(isSymlinkOpenError(value)).toBe(expected);
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
