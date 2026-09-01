import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each(["portable", "Linux shell"] as const)("leading-@ remote paths (%s)", (fixture) => {
  // The shell fixture runs remote GNU utilities locally; the portable fixture
  // exercises the same tool scenario without requiring that local environment.
  it.runIf(fixture === "portable" || process.platform === "linux")(
    "preserves literal files, shorthand, journal authority, patch targets, and stat failures",
    async () => {
      const stateDir = await fs.realpath(tempDirs.make("openclaw-at-remote-"));
      const hostRoot = path.join(stateDir, "host");
      const remoteRoot = path.join(stateDir, "remote");
      const containerWorkdir = fixture === "portable" ? "/remote-workspace" : remoteRoot;
      await fs.mkdir(hostRoot);
      await fs.mkdir(remoteRoot);
      await fs.writeFile(path.join(remoteRoot, "@notes.md"), "literal original", "utf8");
      await fs.writeFile(path.join(remoteRoot, "notes.md"), "sibling original", "utf8");
      await fs.writeFile(path.join(remoteRoot, "reference.md"), "reference", "utf8");
      await fs.writeFile(path.join(remoteRoot, "obsolete.md"), "obsolete", "utf8");
      await fs.writeFile(path.join(remoteRoot, "move-source.md"), "move source", "utf8");
      await fs.writeFile(path.join(remoteRoot, "@replace-absent.md"), "old literal", "utf8");
      await fs.writeFile(path.join(remoteRoot, "@replace-present.md"), "old literal", "utf8");
      await fs.writeFile(path.join(remoteRoot, "replace-present.md"), "sibling", "utf8");
      await fs.mkdir(path.join(remoteRoot, "@projects"));
      await fs.mkdir(path.join(remoteRoot, "projects"));
      await fs.writeFile(path.join(remoteRoot, "projects", "new.md"), "sibling child", "utf8");

      const sandbox = createSandboxTestContext({
        overrides: {
          workspaceDir: hostRoot,
          agentWorkspaceDir: hostRoot,
          containerWorkdir,
          workspaceAccess: "rw",
        },
      });
      const remoteBridge = createRemoteShellSandboxFsBridge({
        sandbox,
        runtime: {
          remoteWorkspaceDir: containerWorkdir,
          remoteAgentWorkspaceDir: containerWorkdir,
          runRemoteShellScript: createLocalRemoteShellScriptRunner(),
        },
      });
      const resolvePath = remoteBridge.resolvePath.bind(remoteBridge);
      const bridge =
        fixture === "portable"
          ? {
              ...createSandboxFsBridgeFromResolver((filePath, cwd) => {
                const resolved = resolvePath({ filePath, cwd });
                return { ...resolved, hostPath: path.join(remoteRoot, resolved.relativePath) };
              }),
              // Only backing operations see hostPath. Public resolution must keep
              // path policy on asynchronous remote stat, including on Windows.
              resolvePath,
            }
          : remoteBridge;
      const guard = (tool: ReturnType<typeof createSandboxedReadTool>) =>
        wrapToolWorkspaceRootGuardWithOptions(tool, hostRoot, {
          containerWorkdir,
          bridge,
        });
      const readTool = guard(createSandboxedReadTool({ root: hostRoot, bridge }));
      const writeTool = guard(createSandboxedWriteTool({ root: hostRoot, bridge }));
      const editTool = guard(createSandboxedEditTool({ root: hostRoot, bridge }));

      const statError = new Error("remote stat unavailable");
      const stat = bridge.stat.bind(bridge);
      const statFailure = vi
        .spyOn(bridge, "stat")
        .mockImplementation((params) =>
          resolvePath(params).relativePath === "@notes.md"
            ? Promise.reject(statError)
            : stat(params),
        );
      try {
        await expect(
          writeTool.execute("remote-at-stat-error", {
            path: "@notes.md",
            content: "must not replace either file",
          }),
        ).rejects.toBe(statError);
        await expect(fs.readFile(path.join(remoteRoot, "@notes.md"), "utf8")).resolves.toBe(
          "literal original",
        );
        await expect(fs.readFile(path.join(remoteRoot, "notes.md"), "utf8")).resolves.toBe(
          "sibling original",
        );
      } finally {
        statFailure.mockRestore();
      }

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
      await createApplyPatchTool({ cwd: hostRoot, sandbox: { root: hostRoot, bridge } }).execute(
        "remote-at-shorthand-patch",
        {
          input: [
            "*** Begin Patch",
            "*** Update File: @reference.md",
            "@@",
            "-reference",
            "+reference patched",
            "*** Add File: @added.md",
            "+added",
            "*** Delete File: @obsolete.md",
            "*** Update File: @move-source.md",
            "*** Move to: @moved.md",
            "@@",
            "-move source",
            "+move target",
            "*** End Patch",
          ].join("\n"),
        },
      );
      await expect(fs.readFile(path.join(remoteRoot, "reference.md"), "utf8")).resolves.toBe(
        "reference patched",
      );
      await expect(fs.readFile(path.join(remoteRoot, "added.md"), "utf8")).resolves.toBe("added\n");
      await expect(fs.stat(path.join(remoteRoot, "obsolete.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(path.join(remoteRoot, "move-source.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readFile(path.join(remoteRoot, "moved.md"), "utf8")).resolves.toBe(
        "move target",
      );
      await createApplyPatchTool({ cwd: hostRoot, sandbox: { root: hostRoot, bridge } }).execute(
        "remote-at-replace-patch",
        {
          input: [
            "*** Begin Patch",
            "*** Delete File: @replace-absent.md",
            "*** Add File: @replace-absent.md",
            "+new literal",
            "*** Delete File: @replace-present.md",
            "*** Add File: @replace-present.md",
            "+new literal",
            "*** End Patch",
          ].join("\n"),
        },
      );
      await expect(fs.readFile(path.join(remoteRoot, "@replace-absent.md"), "utf8")).resolves.toBe(
        "new literal\n",
      );
      await expect(fs.stat(path.join(remoteRoot, "replace-absent.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readFile(path.join(remoteRoot, "@replace-present.md"), "utf8")).resolves.toBe(
        "new literal\n",
      );
      await expect(fs.readFile(path.join(remoteRoot, "replace-present.md"), "utf8")).resolves.toBe(
        "sibling",
      );
      await expect(fs.stat(path.join(hostRoot, "@notes.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readdir(hostRoot)).resolves.toEqual([]);
    },
  );
});
