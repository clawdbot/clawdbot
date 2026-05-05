import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getSandboxHostPathPolicyKey,
  isSandboxHostPathAbsolute,
  normalizeSandboxHostPath,
  resolveSandboxHostPathViaExistingAncestor,
} from "./host-paths.js";

describe("normalizeSandboxHostPath", () => {
  it("normalizes dot segments and strips trailing slash", () => {
    expect(normalizeSandboxHostPath("/tmp/a/../b//")).toBe("/tmp/b");
  });

  it("normalizes Windows drive-letter paths without losing the drive root", () => {
    expect(normalizeSandboxHostPath("c:\\Users\\Kai\\..\\Project\\")).toBe("C:/Users/Project");
    expect(normalizeSandboxHostPath("d:/")).toBe("D:/");
  });
});

describe("isSandboxHostPathAbsolute", () => {
  it("accepts POSIX and drive-absolute Windows paths", () => {
    expect(isSandboxHostPathAbsolute("/tmp/project")).toBe(true);
    expect(isSandboxHostPathAbsolute("C:/Users/kai/project")).toBe(true);
    expect(isSandboxHostPathAbsolute("C:\\Users\\kai\\project")).toBe(true);
  });

  it("rejects relative paths, named volumes, and drive-relative Windows paths", () => {
    expect(isSandboxHostPathAbsolute("relative/path")).toBe(false);
    expect(isSandboxHostPathAbsolute("my-volume")).toBe(false);
    expect(isSandboxHostPathAbsolute("C:relative\\path")).toBe(false);
  });
});

describe("getSandboxHostPathPolicyKey", () => {
  it("compares Windows drive-letter paths case-insensitively", () => {
    expect(getSandboxHostPathPolicyKey("c:\\Users\\Kai\\.SSH\\config")).toBe(
      "c:/users/kai/.ssh/config",
    );
  });
});

describe("resolveSandboxHostPathViaExistingAncestor", () => {
  it("keeps non-absolute paths unchanged", () => {
    expect(resolveSandboxHostPathViaExistingAncestor("relative/path")).toBe("relative/path");
  });

  it("normalizes Windows paths without resolving them through POSIX cwd on non-Windows hosts", () => {
    if (process.platform === "win32") {
      return;
    }

    expect(resolveSandboxHostPathViaExistingAncestor("C:/Users/kai/project")).toBe(
      "C:/Users/kai/project",
    );
  });

  it("resolves symlink parents when the final leaf does not exist", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "openclaw-host-paths-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(workspace, "alias-out");
    symlinkSync(outside, link);

    const unresolved = join(link, "missing-leaf");
    const resolved = resolveSandboxHostPathViaExistingAncestor(unresolved);
    expect(resolved).toBe(join(realpathSync.native(outside), "missing-leaf"));
  });
});
