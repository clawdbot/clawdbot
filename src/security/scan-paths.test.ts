import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extensionUsesSkippedScannerPath,
  isPathInside,
  isPathInsideWithRealpath,
} from "./scan-paths.js";

// ---------------------------------------------------------------------------
// isPathInside
// ---------------------------------------------------------------------------

describe("isPathInside", () => {
  it("returns true for same directory", () => {
    const base = "/home/user/project";
    expect(isPathInside(base, base)).toBe(true);
  });

  it("returns true for a direct child", () => {
    expect(isPathInside("/home/user/project", "/home/user/project/src/file.ts")).toBe(true);
  });

  it("returns false when candidate escapes base with ..", () => {
    expect(isPathInside("/home/user/project", "/home/user/other")).toBe(false);
  });

  it("returns false for absolute path outside base", () => {
    expect(isPathInside("/home/user/project", "/etc/passwd")).toBe(false);
  });

  it("returns false for a sibling directory", () => {
    expect(isPathInside("/home/user/a", "/home/user/b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPathInsideWithRealpath
// ---------------------------------------------------------------------------

describe("isPathInsideWithRealpath", () => {
  const tmpDir = os.tmpdir();

  it("returns true when both paths exist and candidate is inside base", () => {
    // os.tmpdir() and itself both exist on disk
    const result = isPathInsideWithRealpath(tmpDir, tmpDir);
    expect(result).toBe(true);
  });

  it("returns false (line 25) when candidate is outside base without realpath check needed", () => {
    // /etc is outside os.tmpdir() — isPathInside returns false immediately
    const result = isPathInsideWithRealpath(tmpDir, "/etc");
    expect(result).toBe(false); // covers line 25: return false
  });

  it("returns false (safe default) when realpath fails for non-existent candidate", () => {
    // Non-existent path causes safeRealpathSync to return null (covers line 15)
    // New safe default (requireRealpath not set): returns false — secure by default
    const nonExistent = path.join(tmpDir, "__does_not_exist_clawin_test__");
    const result = isPathInsideWithRealpath(tmpDir, nonExistent);
    expect(result).toBe(false);
  });

  it("returns false when requireRealpath is true and realpath fails", () => {
    const nonExistent = path.join(tmpDir, "__does_not_exist_clawin_test__");
    const result = isPathInsideWithRealpath(tmpDir, nonExistent, { requireRealpath: true });
    expect(result).toBe(false);
  });

  it("returns true (explicit opt-out) when requireRealpath is false and realpath fails", () => {
    const nonExistent = path.join(tmpDir, "__does_not_exist_clawin_test__");
    const result = isPathInsideWithRealpath(tmpDir, nonExistent, { requireRealpath: false });
    expect(result).toBe(true);
  });

  it("returns false (safe default) when realpath fails for base path", () => {
    const nonExistentBase = path.join(tmpDir, "__nonexistent_base__");
    const child = path.join(nonExistentBase, "child.ts");
    const result = isPathInsideWithRealpath(nonExistentBase, child);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extensionUsesSkippedScannerPath
// ---------------------------------------------------------------------------

describe("extensionUsesSkippedScannerPath", () => {
  it("returns true for node_modules segment", () => {
    expect(extensionUsesSkippedScannerPath("src/node_modules/pkg/index.js")).toBe(true);
  });

  it("returns true for hidden directory (.hidden)", () => {
    expect(extensionUsesSkippedScannerPath("src/.hidden/file.ts")).toBe(true);
  });

  it("returns false for normal paths", () => {
    expect(extensionUsesSkippedScannerPath("src/utils/helpers.ts")).toBe(false);
  });

  it("returns false for a single . segment (current dir)", () => {
    expect(extensionUsesSkippedScannerPath("./src/file.ts")).toBe(false);
  });

  it("returns false for a .. segment (parent dir)", () => {
    expect(extensionUsesSkippedScannerPath("../src/file.ts")).toBe(false);
  });

  it("returns true for Windows-style paths with node_modules", () => {
    expect(extensionUsesSkippedScannerPath("src\\node_modules\\pkg\\index.js")).toBe(true);
  });
});
