/**
 * Tests that a leading "@" on a tool path names a file instead of silently
 * retargeting the de-"@"'d sibling, while the "@"-prefixed mention shorthands
 * keep resolving.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return { ...mod, getShellPathFromLoginShell: () => null };
});

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>) {
  // Real resolvers canonicalize, so the fixture root must be canonical too.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// workspaceOnly decides whether the workspace-root guard wraps the tools, and the
// guard resolves the path separately from the tool. Both arrangements must agree.
const WORKSPACE_ONLY_CASES = [true, false] as const;

describe("@-prefixed tool paths", () => {
  it.each(WORKSPACE_ONLY_CASES)(
    "mutates the literal @-named file instead of its de-@'d sibling (workspaceOnly=%s)",
    async (workspaceOnly) => {
      await withTempDir("openclaw-at-", async (cwd) => {
        const sibling = path.join(cwd, "notes.md");
        const literal = path.join(cwd, "@notes.md");
        const config: OpenClawConfig = { tools: { fs: { workspaceOnly } } };
        const tools = createOpenClawCodingTools({ cwd, config });
        const { writeTool, editTool } = expectReadWriteEditTools(tools);

        await fs.writeFile(sibling, "sibling\n");
        await fs.writeFile(literal, "literal\n");
        await writeTool.execute("at-write", { path: "@notes.md", content: "written\n" });
        await expect(fs.readFile(literal, "utf8")).resolves.toBe("written\n");
        await expect(fs.readFile(sibling, "utf8")).resolves.toBe("sibling\n");

        await fs.writeFile(literal, "before\n");
        await editTool.execute("at-edit", {
          path: "@notes.md",
          edits: [{ oldText: "before", newText: "after" }],
        });
        await expect(fs.readFile(literal, "utf8")).resolves.toBe("after\n");
        await expect(fs.readFile(sibling, "utf8")).resolves.toBe("sibling\n");

        // apply_patch Delete File is a plain unlink with no Trash fallback, so the
        // wrong target here is unrecoverable.
        const patchTool = createApplyPatchTool({ cwd, workspaceOnly });
        await patchTool.execute("at-delete", {
          input: "*** Begin Patch\n*** Delete File: @notes.md\n*** End Patch",
        });
        await expect(fs.readFile(sibling, "utf8")).resolves.toBe("sibling\n");
        await expect(fs.access(literal)).rejects.toThrow();
      });
    },
  );

  it.each(WORKSPACE_ONLY_CASES)(
    "reads back the same file it just wrote (workspaceOnly=%s)",
    async (workspaceOnly) => {
      await withTempDir("openclaw-at-", async (cwd) => {
        await fs.writeFile(path.join(cwd, "notes.md"), "sibling\n");
        await fs.writeFile(path.join(cwd, "@notes.md"), "literal\n");
        const config: OpenClawConfig = { tools: { fs: { workspaceOnly } } };
        const tools = createOpenClawCodingTools({ cwd, config });
        const { readTool, writeTool } = expectReadWriteEditTools(tools);

        await writeTool.execute("at-rw-write", { path: "@notes.md", content: "round-trip\n" });
        const read = await readTool.execute("at-rw-read", { path: "@notes.md" });
        expect(getTextContent(read)).toContain("round-trip");
      });
    },
  );

  it.each(WORKSPACE_ONLY_CASES)(
    "still resolves a relative @path with no literal file, as the TUI autocomplete emits (workspaceOnly=%s)",
    async (workspaceOnly) => {
      await withTempDir("openclaw-at-", async (cwd) => {
        const target = path.join(cwd, "src", "foo.ts");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, "before\n");

        const config: OpenClawConfig = { tools: { fs: { workspaceOnly } } };
        const { editTool } = expectReadWriteEditTools(createOpenClawCodingTools({ cwd, config }));
        await editTool.execute("at-tui", {
          path: "@src/foo.ts",
          edits: [{ oldText: "before", newText: "after" }],
        });
        await expect(fs.readFile(target, "utf8")).resolves.toBe("after\n");
      });
    },
  );
});
