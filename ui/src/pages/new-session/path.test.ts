// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { isKnownWorkspacePath, sameAbsolutePath } from "./path.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("sameAbsolutePath", () => {
  it.each([
    ["/workspace/", "/workspace", true],
    ["/", "///", true],
    ["/workspace/./packages/..", "/workspace", true],
    ["/Workspace", "/workspace", false],
    ["C:\\Users\\Projects\\", "c:/users/projects", true],
    ["C:\\", "c:/", true],
    ["\\\\Server\\Share\\", "//server/share", true],
    ["/workspace", "/workspace-other", false],
    ["relative", "relative", false],
    ["", "", false],
  ])("compares %j and %j as %s", (a, b, expected) => {
    expect(sameAbsolutePath(a, b)).toBe(expected);
  });
});

describe("isKnownWorkspacePath", () => {
  it("accepts a canonical child after the Gateway approves a symlinked workspace root", async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    const container = tempDirs.make("openclaw-ui-workspace-alias-", tempRoot);
    const canonicalWorkspace = path.join(container, "canonical-workspace");
    const workspaceAlias = path.join(container, "workspace-alias");
    await fs.mkdir(path.join(canonicalWorkspace, "packages", "app"), { recursive: true });
    await fs.symlink(canonicalWorkspace, workspaceAlias);

    const approvedCanonicalRoot = await fs.realpath(workspaceAlias);
    const canonicalFolder = path.join(approvedCanonicalRoot, "packages", "app");
    expect(canonicalFolder.startsWith(workspaceAlias)).toBe(false);
    expect(isKnownWorkspacePath([workspaceAlias], canonicalFolder)).toBe(false);
    expect(isKnownWorkspacePath([workspaceAlias, approvedCanonicalRoot], canonicalFolder)).toBe(
      true,
    );
  });
});
