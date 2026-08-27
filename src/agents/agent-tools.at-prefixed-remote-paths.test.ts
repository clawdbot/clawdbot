import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  wrapToolMemoryFlushAppendOnlyWrite,
  wrapToolWorkspaceRootGuardWithOptions,
} from "./agent-tools.read.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("leading-@ paths on a real remote sandbox filesystem bridge", () => {
  it.runIf(process.platform !== "win32")(
    "preserves remote-only literal files, shorthand, journal authority, and patch targets",
    async () => {
      const stateDir = tempDirs.make("openclaw-at-remote-");
      const hostRoot = path.join(stateDir, "host");
      const remoteRoot = path.join(stateDir, "remote");
      await fs.mkdir(hostRoot);
      await fs.mkdir(remoteRoot);
      await fs.writeFile(path.join(remoteRoot, "@notes.md"), "literal original", "utf8");
      await fs.writeFile(path.join(remoteRoot, "notes.md"), "sibling original", "utf8");
      await fs.writeFile(path.join(remoteRoot, "reference.md"), "reference", "utf8");
      await fs.mkdir(path.join(remoteRoot, "@projects"));
      await fs.mkdir(path.join(remoteRoot, "projects"));
      await fs.writeFile(path.join(remoteRoot, "projects", "new.md"), "sibling child", "utf8");

      const sandbox = createSandboxTestContext({
        overrides: {
          workspaceDir: hostRoot,
          agentWorkspaceDir: hostRoot,
          containerWorkdir: remoteRoot,
          workspaceAccess: "rw",
        },
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox,
        runtime: {
          remoteWorkspaceDir: remoteRoot,
          remoteAgentWorkspaceDir: remoteRoot,
          runRemoteShellScript: createLocalRemoteShellScriptRunner(),
        },
      });
      const guard = (tool: ReturnType<typeof createSandboxedReadTool>) =>
        wrapToolWorkspaceRootGuardWithOptions(tool, hostRoot, {
          containerWorkdir: remoteRoot,
          bridge,
        });
      const readTool = guard(createSandboxedReadTool({ root: hostRoot, bridge }));
      const writeTool = guard(createSandboxedWriteTool({ root: hostRoot, bridge }));
      const editTool = guard(createSandboxedEditTool({ root: hostRoot, bridge }));

      await expect(readTool.execute("remote-at-read", { path: "@notes.md" })).resolves.toEqual(
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "literal original" }),
          ]),
        }),
      );
      await expect(
        readTool.execute("remote-at-reference", { path: "@reference.md" }),
      ).resolves.toEqual(
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "reference" }),
          ]),
        }),
      );
      await writeTool.execute("remote-at-write", {
        path: "@notes.md",
        content: "literal updated",
      });
      await editTool.execute("remote-at-edit", {
        path: "@notes.md",
        edits: [{ oldText: "updated", newText: "edited" }],
      });
      await expect(fs.readFile(path.join(remoteRoot, "@notes.md"), "utf8")).resolves.toBe(
        "literal edited",
      );
      await expect(fs.readFile(path.join(remoteRoot, "notes.md"), "utf8")).resolves.toBe(
        "sibling original",
      );
      await writeTool.execute("remote-at-parent-write", {
        path: "@projects/new.md",
        content: "literal child",
      });
      await expect(fs.readFile(path.join(remoteRoot, "@projects", "new.md"), "utf8")).resolves.toBe(
        "literal child",
      );
      await expect(fs.readFile(path.join(remoteRoot, "projects", "new.md"), "utf8")).resolves.toBe(
        "sibling child",
      );

      const journal = "memory/2026-08-25.md";
      for (const parent of ["memory", "@memory"]) {
        await fs.mkdir(path.join(remoteRoot, parent));
      }
      await fs.writeFile(path.join(remoteRoot, journal), "allowed", "utf8");
      await fs.writeFile(path.join(remoteRoot, `@${journal}`), "literal", "utf8");
      const memoryWriteTool = wrapToolMemoryFlushAppendOnlyWrite(writeTool, {
        root: hostRoot,
        relativePath: journal,
        sandbox: { root: hostRoot, bridge },
      });
      await expect(
        memoryWriteTool.execute("remote-at-memory", {
          path: `@${journal}`,
          content: "wrong journal",
        }),
      ).rejects.toThrow(/Memory flush writes are restricted/);
      await expect(fs.readFile(path.join(remoteRoot, journal), "utf8")).resolves.toBe("allowed");

      await createApplyPatchTool({ cwd: hostRoot, sandbox: { root: hostRoot, bridge } }).execute(
        "remote-at-patch",
        {
          input: ["*** Begin Patch", "*** Delete File: @notes.md", "*** End Patch"].join("\n"),
        },
      );
      await expect(fs.stat(path.join(remoteRoot, "@notes.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readFile(path.join(remoteRoot, "notes.md"), "utf8")).resolves.toBe(
        "sibling original",
      );
      await expect(fs.stat(path.join(hostRoot, "@notes.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
