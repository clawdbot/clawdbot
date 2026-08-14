import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { createNodeWorkerWorkspaceFallback } from "./node-worker-workspace-fallback.js";

const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-node-workspace-fallback-" });

describe("node worker workspace fallback", () => {
  let root: string;

  beforeEach(async () => {
    root = await tempRoot.setup();
  });

  afterEach(async () => {
    await tempRoot.cleanup();
  });

  async function expectTransferRequired(marker: string, contents = ""): Promise<void> {
    await expect(
      runCommandWithTimeout(["git", "-C", root, "init", "--quiet"], { timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ code: 0 });
    await fs.writeFile(path.join(root, marker), contents);
    const exec = vi.fn();
    const workspace = createNodeWorkerWorkspaceFallback(exec);

    await expect(
      workspace.syncWorkspace({ localPath: root, sessionId: "session-1", generation: 1 }),
    ).rejects.toMatchObject({
      code: "workspace-transport-pending",
      operation: "sync",
      reason: "workspace-transfer-required",
    });
    expect(exec).not.toHaveBeenCalled();
  }

  it("reports a plain workspace as requiring the transfer carrier", async () => {
    const exec = vi.fn();
    const workspace = createNodeWorkerWorkspaceFallback(exec);

    await expect(
      workspace.syncWorkspace({ localPath: root, sessionId: "session-1", generation: 1 }),
    ).rejects.toMatchObject({
      code: "workspace-transport-pending",
      operation: "sync",
      reason: "plain-workspace",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses clone fallback for submodule workspaces", async () => {
    await expectTransferRequired(".gitmodules", '[submodule "fixture"]\n\tpath = fixture\n');
  });

  it("refuses clone fallback for Git LFS workspaces", async () => {
    await expectTransferRequired(".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  });
});
