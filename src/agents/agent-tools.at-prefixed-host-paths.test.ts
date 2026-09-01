import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withWorkspace(run: (workspaceDir: string) => Promise<void>): Promise<void> {
  await run(tempDirs.make("openclaw-at-host-"));
}

describe("leading-@ host and mounted sandbox paths", () => {
  it.each([false, true])(
    "preserves literal files, new descendants, and file-reference shorthand with workspaceOnly=%s",
    async (workspaceOnly) => {
      await withWorkspace(async (workspaceDir) => {
        const literalPath = path.join(workspaceDir, "@existing.md");
        const siblingPath = path.join(workspaceDir, "existing.md");
        const literalParent = path.join(workspaceDir, "@notes");
        const siblingParent = path.join(workspaceDir, "notes");
        await fs.mkdir(literalParent);
        await fs.mkdir(siblingParent);
        await fs.writeFile(literalPath, "literal original", "utf8");
        await fs.writeFile(siblingPath, "sibling original", "utf8");
        await fs.writeFile(path.join(siblingParent, "new.md"), "sibling child", "utf8");
        await fs.writeFile(path.join(workspaceDir, "reference.md"), "reference", "utf8");
        const { readTool, writeTool, editTool } = expectReadWriteEditTools(
          createOpenClawCodingTools({
            workspaceDir,
            config: { tools: { fs: { workspaceOnly } } },
          }),
        );

        expect(
          getTextContent(await readTool.execute("at-existing-read", { path: "@existing.md" })),
        ).toContain("literal original");
        expect(
          getTextContent(await readTool.execute("at-reference-read", { path: "@reference.md" })),
        ).toContain("reference");
        await writeTool.execute("at-existing-write", {
          path: "@existing.md",
          content: "literal updated",
        });
        await editTool.execute("at-existing-edit", {
          path: "@existing.md",
          edits: [{ oldText: "updated", newText: "edited" }],
        });
        await writeTool.execute("at-parent-write", {
          path: "@notes/nested/../new.md",
          content: "literal child",
        });

        await expect(fs.readFile(literalPath, "utf8")).resolves.toBe("literal edited");
        await expect(fs.readFile(siblingPath, "utf8")).resolves.toBe("sibling original");
        await expect(fs.readFile(path.join(literalParent, "new.md"), "utf8")).resolves.toBe(
          "literal child",
        );
        await expect(fs.readFile(path.join(siblingParent, "new.md"), "utf8")).resolves.toBe(
          "sibling child",
        );
      });
    },
  );

  it.each([
    { name: "workspace-confined host", workspaceOnly: true, mounted: false },
    { name: "unconfined host", workspaceOnly: false, mounted: false },
    { name: "mounted sandbox", workspaceOnly: true, mounted: true },
  ])("adds, updates, and deletes literal paths through the $name owner", async (runtime) => {
    await withWorkspace(async (workspaceDir) => {
      const literalParent = path.join(workspaceDir, "@notes");
      const siblingParent = path.join(workspaceDir, "notes");
      await fs.mkdir(literalParent);
      await fs.mkdir(siblingParent);
      await fs.writeFile(path.join(siblingParent, "new.md"), "sibling before\n", "utf8");
      const patchTool = createApplyPatchTool({
        cwd: workspaceDir,
        workspaceOnly: runtime.workspaceOnly,
        ...(runtime.mounted
          ? { sandbox: { root: workspaceDir, bridge: createHostSandboxFsBridge(workspaceDir) } }
          : {}),
      });
      const runPatch = (callId: string, lines: string[]) =>
        patchTool.execute(callId, { input: lines.join("\n") });

      await runPatch("at-patch-add", [
        "*** Begin Patch",
        "*** Add File: @notes/new.md",
        "+literal before",
        "*** End Patch",
      ]);
      await expect(fs.readFile(path.join(literalParent, "new.md"), "utf8")).resolves.toBe(
        "literal before\n",
      );

      await runPatch("at-patch-update", [
        "*** Begin Patch",
        "*** Update File: @notes/new.md",
        "@@",
        "-literal before",
        "+literal after",
        "*** End Patch",
      ]);
      await expect(fs.readFile(path.join(literalParent, "new.md"), "utf8")).resolves.toBe(
        "literal after\n",
      );

      await runPatch("at-patch-delete", [
        "*** Begin Patch",
        "*** Delete File: @notes/new.md",
        "*** End Patch",
      ]);
      await expect(fs.stat(path.join(literalParent, "new.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readFile(path.join(siblingParent, "new.md"), "utf8")).resolves.toBe(
        "sibling before\n",
      );
    });
  });

  it.each([
    { sibling: false, label: "without an unprefixed sibling" },
    { sibling: true, label: "with an unprefixed sibling" },
  ])("keeps literal replacement paths stable $label", async ({ sibling }) => {
    await withWorkspace(async (workspaceDir) => {
      await fs.writeFile(path.join(workspaceDir, "@replace.md"), "old literal\n", "utf8");
      if (sibling) {
        await fs.writeFile(path.join(workspaceDir, "replace.md"), "sibling\n", "utf8");
      }
      await createApplyPatchTool({ cwd: workspaceDir }).execute("at-patch-replace", {
        input: [
          "*** Begin Patch",
          "*** Delete File: @replace.md",
          "*** Add File: @replace.md",
          "+new literal",
          "*** End Patch",
        ].join("\n"),
      });

      await expect(fs.readFile(path.join(workspaceDir, "@replace.md"), "utf8")).resolves.toBe(
        "new literal\n",
      );
      if (sibling) {
        await expect(fs.readFile(path.join(workspaceDir, "replace.md"), "utf8")).resolves.toBe(
          "sibling\n",
        );
      } else {
        await expect(fs.stat(path.join(workspaceDir, "replace.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    });
  });
});
