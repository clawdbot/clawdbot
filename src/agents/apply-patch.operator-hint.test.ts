/**
 * Operator-hint tests for apply_patch workspace containment.
 * The remediation names configuration that relaxes containment, so it must reach the Gateway
 * log without entering the model-visible failure message, and must name the control that
 * actually imposed the boundary rather than one that cannot lift it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApplyPatchTool } from "./apply-patch.js";
import { createMemoryPatchSandbox } from "./apply-patch.test-support.js";
import { isHostRootEscapeError } from "./sandbox-paths.js";
import { readToolOperatorHint, withToolOperatorHint } from "./tool-operator-hint.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  // realpath: containment compares canonical paths, and macOS os.tmpdir() is a
  // /var -> /private/var symlink that would otherwise trip the guard itself.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-hint-")));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function addFilePatch(target: string): string {
  return `*** Begin Patch\n*** Add File: ${target}\n+escaped\n*** End Patch`;
}

async function captureFailure(
  tool: ReturnType<typeof createApplyPatchTool>,
  input: string,
): Promise<unknown> {
  try {
    await tool.execute("call-hint", { input }, undefined);
  } catch (error) {
    return error;
  }
  throw new Error("expected apply_patch to reject");
}

async function hintForHostEscape(
  containmentSource: Parameters<typeof createApplyPatchTool>[0]["containmentSource"],
): Promise<{ hint: string | undefined; message: string }> {
  return await withTempDir(async (dir) => {
    const root = path.join(dir, "workspace");
    await fs.mkdir(root, { recursive: true });
    const tool = createApplyPatchTool({ cwd: root, root, containmentSource });
    const error = await captureFailure(tool, addFilePatch(path.join(dir, "outside", "note.md")));
    return { hint: readToolOperatorHint(error), message: (error as Error).message };
  });
}

describe("apply_patch workspace containment hint", () => {
  it("names both configuration settings when configuration imposed the boundary", async () => {
    const { hint, message } = await hintForHostEscape("config");

    expect(hint).toBeDefined();
    expect(hint).toContain("tools.exec.applyPatch.workspaceOnly");
    expect(hint).toContain("tools.fs.workspaceOnly");
    // The model sees only the boundary rejection, never the way to lift it.
    expect(message).toContain("Path escapes sandbox root");
    expect(message).not.toContain("workspaceOnly");
  });

  it("points a worker placement at the session mode, not at settings it never reads", async () => {
    const { hint } = await hintForHostEscape("worker");

    expect(hint).toContain("full session permission mode");
    expect(hint).toContain("do not read");
  });

  it("points a mode-governed session at the mode, not at configuration", async () => {
    const { hint } = await hintForHostEscape("session");

    expect(hint).toContain("full permission mode");
    expect(hint).not.toContain("tools.exec.applyPatch.workspaceOnly");
  });

  it("stays silent when the runtime owner named no containment source", async () => {
    const { hint } = await hintForHostEscape(undefined);

    expect(hint).toBeUndefined();
  });

  it("leaves unrelated apply_patch failures unhinted", async () => {
    await withTempDir(async (dir) => {
      const tool = createApplyPatchTool({ cwd: dir, root: dir, containmentSource: "config" });
      const error = await captureFailure(tool, "*** Begin Patch\nnot a real hunk\n*** End Patch");

      expect(readToolOperatorHint(error)).toBeUndefined();
    });
  });

  it("hints a sandboxed run whose mounted host path fails the host workspace check", async () => {
    // resolvePatchPath still applies the host check when the bridge exposes a hostPath, so
    // this rejection is one the host controls do govern.
    const sandbox = createMemoryPatchSandbox();
    const tool = createApplyPatchTool({
      cwd: "/local/workspace",
      root: "/local/workspace",
      containmentSource: "config",
      sandbox: {
        root: "/local/workspace",
        bridge: {
          ...sandbox.bridge,
          resolvePath: ({ filePath }: { filePath: string }) => ({
            relativePath: filePath,
            containerPath: `/sandbox/${filePath}`,
            hostPath: "/etc/escaped.md",
          }),
        },
      },
    });
    const error = await captureFailure(tool, addFilePatch("escaped.md"));

    expect(isHostRootEscapeError(error)).toBe(true);
    expect(readToolOperatorHint(error)).toContain("tools.exec.applyPatch.workspaceOnly");
  });

  it("leaves a bridge's own mount rejection to the bridge's remedy", async () => {
    // Bridges enforce their own mount boundary and never tag the host marker. Host controls
    // cannot lift a mount, so this rejection must carry no host hint. OpenShell's bridge
    // phrases this identically to the host message, so the tag is what separates them.
    const sandbox = createMemoryPatchSandbox();
    const tool = createApplyPatchTool({
      cwd: "/local/workspace",
      root: "/local/workspace",
      containmentSource: "config",
      sandbox: {
        root: "/local/workspace",
        bridge: {
          ...sandbox.bridge,
          resolvePath: () => {
            throw new Error("Path escapes sandbox root (/local/workspace): escaped.md");
          },
        },
      },
    });
    const error = await captureFailure(tool, addFilePatch("escaped.md"));

    expect((error as Error).message).toContain("Path escapes sandbox root");
    expect(isHostRootEscapeError(error)).toBe(false);
    expect(readToolOperatorHint(error)).toBeUndefined();
  });

  it("never masks a failure that cannot carry a hint", () => {
    const frozen = Object.freeze(new Error("Path escapes sandbox root (/w): /outside/note.md"));

    expect(() => withToolOperatorHint(frozen, "hint")).not.toThrow();
    expect(withToolOperatorHint(frozen, "hint")).toBe(frozen);
    expect(readToolOperatorHint(frozen)).toBeUndefined();
  });

  it("keeps the first hint when one is already attached", () => {
    const error = new Error("Path escapes sandbox root (/w): /outside/note.md");
    withToolOperatorHint(error, "first");
    withToolOperatorHint(error, "second");

    expect(readToolOperatorHint(error)).toBe("first");
  });
});
