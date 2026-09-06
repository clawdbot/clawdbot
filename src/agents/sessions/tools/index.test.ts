import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { AgentTool } from "../../runtime/index.js";
import {
  allToolNames,
  createAllTools,
  createCodingTools,
  createReadOnlyTools,
  createTool,
  createToolDefinition,
  type ToolName,
  type ToolsOptions,
} from "./index.js";

const names: ToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const factories = [
  {
    name: "selected",
    create: (cwd: string, options?: ToolsOptions) =>
      names.map((name) => createTool(name, cwd, options)),
    names,
  },
  { name: "coding", create: createCodingTools, names: ["read", "bash", "edit", "write"] },
  { name: "read-only", create: createReadOnlyTools, names: ["read", "grep", "find", "ls"] },
  {
    name: "all",
    create: (cwd: string, options?: ToolsOptions) => Object.values(createAllTools(cwd, options)),
    names,
  },
] satisfies Array<{
  name: string;
  create: (cwd: string, options?: ToolsOptions) => AgentTool[];
  names: string[];
}>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Missing ${name} tool`);
  }
  return tool;
}

describe("session tool factories", () => {
  it("preserves literal @ paths across session file operations and keeps shorthand", async () => {
    const cwd = tempDirs.make("openclaw-tool-factories-at-paths-");
    const tools = createAllTools(cwd);
    await fs.writeFile(path.join(cwd, "@literal.txt"), "literal before\n");
    await fs.writeFile(path.join(cwd, "literal.txt"), "plain sibling\n");
    await fs.writeFile(path.join(cwd, "shorthand.txt"), "shorthand control\n");

    const shorthand = await tools.read.execute("read-shorthand", { path: "@shorthand.txt" });
    expect(shorthand.content).toEqual([{ type: "text", text: "shorthand control\n" }]);
    const literal = await tools.read.execute("read-literal", { path: "@literal.txt" });
    expect(literal.content).toEqual([{ type: "text", text: "literal before\n" }]);

    const written = await tools.write.execute("write-literal", {
      path: "@literal.txt",
      content: "literal written\n",
    });
    expect(written.details).toMatchObject({ changed: true, created: false });
    const edited = await tools.edit.execute("edit-literal", {
      path: "@literal.txt",
      edits: [{ oldText: "written", newText: "edited" }],
    });
    expect(edited.details).toMatchObject({ changed: true });
    await expect(fs.readFile(path.join(cwd, "@literal.txt"), "utf8")).resolves.toBe(
      "literal edited\n",
    );
    await expect(fs.readFile(path.join(cwd, "literal.txt"), "utf8")).resolves.toBe(
      "plain sibling\n",
    );

    await fs.mkdir(path.join(cwd, "@directory"));
    const created = await tools.write.execute("write-literal-child", {
      path: "@directory/new.txt",
      content: "literal child\n",
    });
    expect(created.details).toMatchObject({ changed: true, created: true });
    const listed = await tools.ls.execute("list-literal-directory", { path: "@directory" });
    expect(listed.content).toEqual([{ type: "text", text: '"new.txt"' }]);
    await expect(fs.readFile(path.join(cwd, "@directory/new.txt"), "utf8")).resolves.toBe(
      "literal child\n",
    );
    await expect(fs.stat(path.join(cwd, "directory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps injected file paths independent of colliding local @ files", async () => {
    const cwd = tempDirs.make("openclaw-tool-factories-local-");
    const remote = tempDirs.make("openclaw-tool-factories-remote-");
    await fs.writeFile(path.join(cwd, "@target.txt"), "local sentinel\n");
    await fs.writeFile(path.join(remote, "target.txt"), "remote before\n");
    const remotePath = (absolutePath: string) =>
      path.join(remote, path.relative(cwd, absolutePath));
    const access = (absolutePath: string) => fs.access(remotePath(absolutePath));
    const readFile = (absolutePath: string) => fs.readFile(remotePath(absolutePath));
    const writeFile = (absolutePath: string, content: string) =>
      fs.writeFile(remotePath(absolutePath), content, "utf8");
    const statFile = async (absolutePath: string) => {
      const stat = await fs.stat(remotePath(absolutePath));
      return {
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      } as const;
    };
    const tools = createAllTools(cwd, {
      read: { operations: { access, readFile } },
      write: {
        operations: {
          readFile,
          writeFile,
          statFile,
          mkdir: async (directory) => {
            await fs.mkdir(remotePath(directory), { recursive: true });
          },
        },
      },
      edit: { operations: { access, readFile, writeFile, statFile } },
    });

    const read = await tools.read.execute("read-remote", { path: "@target.txt" });
    expect(read.content).toEqual([{ type: "text", text: "remote before\n" }]);
    await tools.write.execute("write-remote", { path: "@target.txt", content: "remote written\n" });
    await tools.edit.execute("edit-remote", {
      path: "@target.txt",
      edits: [{ oldText: "written", newText: "edited" }],
    });
    await expect(fs.readFile(path.join(remote, "target.txt"), "utf8")).resolves.toBe(
      "remote edited\n",
    );
    await expect(fs.readFile(path.join(cwd, "@target.txt"), "utf8")).resolves.toBe(
      "local sentinel\n",
    );
    await expect(fs.stat(path.join(remote, "@target.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps ordered tool sets independent of the mutable exported inventory", () => {
    const savedNames = [...allToolNames];
    allToolNames.clear();
    try {
      for (const factory of factories) {
        expect(factory.create("/workspace").map((tool) => tool.name)).toEqual(factory.names);
      }
      expect(
        Object.entries(createAllTools("/workspace")).map(([key, tool]) => [key, tool.name]),
      ).toEqual(names.map((name) => [name, name]));
    } finally {
      for (const name of savedNames) {
        allToolNames.add(name);
      }
    }
  });

  it.each([createTool, createToolDefinition])("rejects unknown names", (create) => {
    expect(() => create("missing" as ToolName, "/workspace")).toThrow("Unknown tool name: missing");
  });

  it.each(factories)("$name preserves injected read operations", async (factory) => {
    const cwd = tempDirs.make("openclaw-tool-factories-read-");
    const tools = factory.create(cwd, {
      read: {
        operations: {
          access: async () => {},
          readFile: async (absolutePath) => Buffer.from(`remote:${absolutePath}`),
        },
      },
    });

    const result = await requireTool(tools, "read").execute("read", { path: "virtual.txt" });

    expect(result.content).toEqual([
      { type: "text", text: `remote:${path.join(cwd, "virtual.txt")}` },
    ]);
  });

  it.each(factories.filter((factory) => factory.names.includes("bash")))(
    "$name preserves shell options and file operations",
    async (factory) => {
      const cwd = tempDirs.make("openclaw-tool-factories-files-");
      const tools = factory.create(cwd, {
        bash: {
          commandPrefix: "prepare",
          operations: {
            exec: async (command, executionCwd, { onData }) => {
              onData(Buffer.from(`${executionCwd}:${command}`));
              return { exitCode: 0 };
            },
          },
        },
      });
      const written = await requireTool(tools, "write").execute("write", {
        path: "nested/file.txt",
        content: "before\n",
      });
      expect(written.details).toMatchObject({ changed: true, created: true });
      const read = await requireTool(tools, "read").execute("read", { path: "nested/file.txt" });
      expect(read.content).toEqual([{ type: "text", text: "before\n" }]);

      const edit = requireTool(tools, "edit");
      const input = edit.prepareArguments?.({
        path: "nested/file.txt",
        oldText: "before",
        newText: "after",
      });
      await edit.execute("edit", input);
      await expect(fs.readFile(path.join(cwd, "nested/file.txt"), "utf8")).resolves.toBe("after\n");

      const shell = await requireTool(tools, "bash").execute("bash", { command: "run" });
      expect(shell.content).toEqual([{ type: "text", text: `${cwd}:prepare\nrun` }]);
    },
  );

  it.each(factories.filter((factory) => factory.names.includes("find")))(
    "$name preserves injected discovery operations",
    async (factory) => {
      const cwd = tempDirs.make("openclaw-tool-factories-discovery-");
      const tools = factory.create(cwd, {
        find: { operations: { exists: () => true, glob: () => [path.join(cwd, "remote.ts")] } },
        ls: {
          operations: {
            readDirectory: () => [{ name: "remote.ts", isDirectory: false }],
          },
        },
      });

      const found = await requireTool(tools, "find").execute("find", { pattern: "*.ts" });
      const listed = await requireTool(tools, "ls").execute("ls", {});
      expect(found.content).toEqual([{ type: "text", text: "remote.ts" }]);
      expect(listed.content).toEqual([{ type: "text", text: '"remote.ts"' }]);
    },
  );
});
