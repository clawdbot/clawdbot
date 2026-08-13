import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch } from "./apply-patch.test-support.js";
import {
  createMemoryPatchSandbox,
  withCanonicalTempDir,
} from "./test-helpers/apply-patch-fixtures.js";

describe("applyPatch envelope staging", () => {
  it("updates a file added earlier in the same patch", async () => {
    const memory = createMemoryPatchSandbox();
    const patch = `*** Begin Patch
*** Add File: notes.txt
+draft
*** Update File: notes.txt
@@
-draft
+final
*** End Patch`;

    const result = await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/notes.txt")).toBe("final\n");
    expect(result.summary.added).toEqual(["notes.txt"]);
    expect(result.summary.modified).toEqual(["notes.txt"]);
  });

  it.each([
    { name: "workspace-confined host", workspaceOnly: true },
    { name: "unconfined host", workspaceOnly: false },
  ])(
    "keeps an earlier delete uncommitted in $name when a later hunk fails",
    async ({ workspaceOnly }) => {
      await withCanonicalTempDir(async (dir) => {
        const importantPath = path.join(dir, "important.txt");
        await fs.writeFile(importantPath, "irreplaceable-user-data\n", "utf8");
        const patch = `*** Begin Patch
*** Delete File: important.txt
*** Update File: missing.txt
@@
-old
+new
*** End Patch`;

        await expect(applyPatch(patch, { cwd: dir, workspaceOnly })).rejects.toThrow(
          /Failed to read file to update/,
        );
        await expect(fs.readFile(importantPath, "utf8")).resolves.toBe("irreplaceable-user-data\n");
      });
    },
  );

  it("keeps an earlier update uncommitted when a later context match fails", async () => {
    await withCanonicalTempDir(async (dir) => {
      const firstPath = path.join(dir, "first.txt");
      const secondPath = path.join(dir, "second.txt");
      await fs.writeFile(firstPath, "alpha\n", "utf8");
      await fs.writeFile(secondPath, "charlie\n", "utf8");
      const patch = `*** Begin Patch
*** Update File: first.txt
@@
-alpha
+beta
*** Update File: second.txt
@@
-delta
+echo
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
        /Failed to find expected lines/,
      );
      await expect(fs.readFile(firstPath, "utf8")).resolves.toBe("alpha\n");
      await expect(fs.readFile(secondPath, "utf8")).resolves.toBe("charlie\n");
    });
  });

  it("keeps an earlier add uncommitted when a later add targets an existing file", async () => {
    const memory = createMemoryPatchSandbox({ "existing.txt": "keep me\n" });
    const patch = `*** Begin Patch
*** Add File: fresh.txt
+fresh
*** Add File: existing.txt
+replacement
*** End Patch`;

    await expect(applyPatch(patch, memory.options)).rejects.toThrow(
      /Cannot create existing\.txt: the file already exists/,
    );
    expect(memory.files.has("/sandbox/fresh.txt")).toBe(false);
    expect(memory.files.get("/sandbox/existing.txt")).toBe("keep me\n");
  });

  it("rejects a delete hunk for a missing file before committing other hunks", async () => {
    const memory = createMemoryPatchSandbox({ "keep.txt": "keep\n" });
    const patch = `*** Begin Patch
*** Update File: keep.txt
@@
-keep
+kept
*** Delete File: missing.txt
*** End Patch`;

    await expect(applyPatch(patch, memory.options)).rejects.toThrow(
      /Cannot delete missing\.txt: the file was not found/,
    );
    expect(memory.files.get("/sandbox/keep.txt")).toBe("keep\n");
    expect(memory.writeFile).not.toHaveBeenCalled();
  });

  it("keeps an earlier delete uncommitted when a later delete targets a directory", async () => {
    await withCanonicalTempDir(async (dir) => {
      const importantPath = path.join(dir, "important.txt");
      const nestedPath = path.join(dir, "node", "child.txt");
      await fs.writeFile(importantPath, "irreplaceable-user-data\n", "utf8");
      await fs.mkdir(path.dirname(nestedPath), { recursive: true });
      await fs.writeFile(nestedPath, "nested-user-data\n", "utf8");
      const patch = `*** Begin Patch
*** Delete File: important.txt
*** Delete File: node
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
        /Cannot delete node: it is a directory, not a file/,
      );
      await expect(fs.readFile(importantPath, "utf8")).resolves.toBe("irreplaceable-user-data\n");
      await expect(fs.readFile(nestedPath, "utf8")).resolves.toBe("nested-user-data\n");
    });
  });

  it.each([
    {
      name: "a file created earlier in the same patch",
      seedParentOnDisk: false,
      parentHunk: "*** Add File: node\n+leaf-content\n",
      reason: /Cannot create node\/child: node is created as a file earlier in this patch/,
    },
    {
      name: "an existing file on disk",
      seedParentOnDisk: true,
      parentHunk: "",
      reason: /Cannot create node\/child: node is an existing file, not a directory/,
    },
  ])(
    "keeps an earlier delete uncommitted when a later add nests under $name",
    async ({ seedParentOnDisk, parentHunk, reason }) => {
      await withCanonicalTempDir(async (dir) => {
        const importantPath = path.join(dir, "important.txt");
        const nodePath = path.join(dir, "node");
        await fs.writeFile(importantPath, "irreplaceable-user-data\n", "utf8");
        if (seedParentOnDisk) {
          await fs.writeFile(nodePath, "preexisting-file\n", "utf8");
        }
        const patch = `*** Begin Patch
*** Delete File: important.txt
${parentHunk}*** Add File: node/child
+child-content
*** End Patch`;

        await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(reason);
        await expect(fs.readFile(importantPath, "utf8")).resolves.toBe("irreplaceable-user-data\n");
        await expect(fs.readdir(dir).then((entries) => entries.sort())).resolves.toEqual(
          seedParentOnDisk ? ["important.txt", "node"] : ["important.txt"],
        );
      });
    },
  );

  it("rejects an add that collides with a directory an earlier hunk creates", async () => {
    await withCanonicalTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: node/child
+child-content
*** Add File: node
+leaf-content
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
        /Cannot create node: an earlier hunk in this patch creates it as a directory/,
      );
      await expect(fs.readdir(dir)).resolves.toEqual([]);
    });
  });

  it("rejects a sandbox add nesting under an existing file before committing", async () => {
    const memory = createMemoryPatchSandbox({ node: "preexisting-file\n", "keep.txt": "keep\n" });
    const patch = `*** Begin Patch
*** Delete File: keep.txt
*** Add File: node/child
+child-content
*** End Patch`;

    await expect(applyPatch(patch, memory.options)).rejects.toThrow(
      /Cannot create node\/child: node is an existing file, not a directory/,
    );
    expect(memory.files.get("/sandbox/keep.txt")).toBe("keep\n");
    expect(memory.files.has("/sandbox/node/child")).toBe(false);
  });

  it("reports earlier applied hunks when a commit-time race rejects the patch", async () => {
    const memory = createMemoryPatchSandbox();
    memory.mkdirp.mockImplementation(async () => {
      memory.files.set("/sandbox/second.txt", "written by another writer\n");
    });
    const patch = `*** Begin Patch
*** Add File: first.txt
+first
*** Add File: second.txt
+second
*** End Patch`;

    await expect(applyPatch(patch, memory.options)).rejects.toThrow(
      /Cannot create second\.txt: the file already exists.*partially applied before this failure: added first\.txt/s,
    );
    expect(memory.files.get("/sandbox/first.txt")).toBe("first\n");
    expect(memory.files.get("/sandbox/second.txt")).toBe("written by another writer\n");
  });
});
