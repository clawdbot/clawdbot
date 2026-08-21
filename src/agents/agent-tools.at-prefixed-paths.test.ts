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
import type { SandboxFsBridge, SandboxFsStat } from "./sandbox/fs-bridge.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";

/**
 * A remote/SSH sandbox (see `remote-fs-bridge.ts`) has no host-mounted copy of the
 * workspace: `resolvePath()` returns no `hostPath`, and every read/stat crosses the
 * bridge instead of the local filesystem. This fake reproduces exactly that shape so
 * a literal `@notes.md` that exists only "remotely" cannot be seen by a host-only
 * `fs.stat` probe. Files are keyed by the same absolute container path a real bridge
 * resolves to (`${cwd}/${relativePath}`), since callers pass either a raw relative
 * `filePath` + `cwd` (the leading-`@` existence probe) or an already-resolved
 * absolute path (the write/edit tool's own file operations) — a real bridge
 * resolves both forms the same way, so this fake must too.
 */
function createRemoteOnlySandboxBridge(
  root: string,
  initialFiles: Record<string, string> = {},
): {
  files: Map<string, string>;
  bridge: SandboxFsBridge;
} {
  const resolve = (filePath: string, cwd?: string) =>
    filePath.startsWith("/") ? filePath : `${cwd ?? root}/${filePath.replace(/^\.\//, "")}`;
  const files = new Map(
    Object.entries(initialFiles).map(([name, contents]) => [resolve(name), contents]),
  );
  const bridge: SandboxFsBridge = {
    resolvePath: ({ filePath, cwd }) => {
      const key = resolve(filePath, cwd);
      return { relativePath: key.slice(root.length + 1), containerPath: key };
    },
    readFile: async ({ filePath, cwd }) =>
      Buffer.from(files.get(resolve(filePath, cwd)) ?? "", "utf8"),
    writeFile: async ({ filePath, cwd, data }) => {
      files.set(resolve(filePath, cwd), Buffer.isBuffer(data) ? data.toString("utf8") : data);
    },
    mkdirp: async () => {},
    remove: async ({ filePath, cwd }) => {
      files.delete(resolve(filePath, cwd));
    },
    rename: async ({ from, to, cwd }) => {
      const key = resolve(from, cwd);
      const contents = files.get(key);
      if (contents !== undefined) {
        files.set(resolve(to, cwd), contents);
        files.delete(key);
      }
    },
    stat: async ({ filePath, cwd }): Promise<SandboxFsStat | null> => {
      const contents = files.get(resolve(filePath, cwd));
      return contents === undefined ? null : { type: "file", size: contents.length, mtimeMs: 0 };
    },
  };
  return { files, bridge };
}

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

  it.each(WORKSPACE_ONLY_CASES)(
    "mutates the literal @-named file when it exists only inside a remote sandbox (workspaceOnly=%s)",
    async (workspaceOnly) => {
      // The root exists on the host but stays EMPTY: only the bridge's in-memory
      // map holds "@notes.md". Host-side canonicalization (memory write
      // provenance) needs a resolvable root, while the existence probe still has
      // nothing on disk to find.
      await withTempDir("openclaw-at-remote-", async (root) => {
        const { files, bridge } = createRemoteOnlySandboxBridge(root, {
          "@notes.md": "literal\n",
          "notes.md": "sibling\n",
        });
        const sandbox = createAgentToolsSandboxContext({ workspaceDir: root, fsBridge: bridge });
        const config: OpenClawConfig = { tools: { fs: { workspaceOnly } } };
        const tools = createOpenClawCodingTools({ sandbox, config });
        const { writeTool, editTool } = expectReadWriteEditTools(tools);

        // A host-only existence probe cannot see "@notes.md" here — it only lives in
        // the bridge's in-memory map, never on this process's real filesystem — so
        // this proves the sandbox bridge's stat() call, not a host fs coincidence.
        await writeTool.execute("sbx-at-write", { path: "@notes.md", content: "written\n" });
        expect(files.get(`${root}/@notes.md`)).toBe("written\n");
        expect(files.get(`${root}/notes.md`)).toBe("sibling\n");

        await editTool.execute("sbx-at-edit", {
          path: "@notes.md",
          edits: [{ oldText: "written", newText: "edited" }],
        });
        expect(files.get(`${root}/@notes.md`)).toBe("edited\n");
        expect(files.get(`${root}/notes.md`)).toBe("sibling\n");
      });
    },
  );
});
