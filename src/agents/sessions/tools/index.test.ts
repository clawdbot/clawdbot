import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { validateToolArguments } from "@openclaw/llm-core/validation";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { AgentTool } from "../../runtime/index.js";
import { ensureTool } from "../../utils/tools-manager.js";
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
            exists: () => true,
            stat: (absolutePath) => ({ isDirectory: () => absolutePath === cwd }),
            readdir: () => ["remote.ts"],
          },
        },
      });

      const found = await requireTool(tools, "find").execute("find", { pattern: "*.ts" });
      const listed = await requireTool(tools, "ls").execute("ls", {});
      expect(found.content).toEqual([{ type: "text", text: "remote.ts" }]);
      expect(listed.content).toEqual([{ type: "text", text: "remote.ts" }]);
    },
  );

  it.for([
    { context: undefined, expected: ["sample.txt:3: context needle"] },
    { context: 0, expected: ["sample.txt:3: context needle"] },
    {
      context: 1,
      expected: ["sample.txt-2- second", "sample.txt:3: context needle", "sample.txt-4- fourth"],
    },
    { context: 0.5, expected: ["sample.txt:3: context needle"] },
    {
      context: 1.5,
      expected: ["sample.txt-2- second", "sample.txt:3: context needle", "sample.txt-4- fourth"],
    },
    { context: -1, expected: ["sample.txt:3: context needle"] },
  ])(
    "normalizes native grep context $context after argument validation",
    async ({ context, expected }, { signal }) => {
      const cwd = tempDirs.make("openclaw-tool-factories-grep-");
      const filePath = path.join(cwd, "sample.txt");
      await fs.writeFile(filePath, "first\nsecond\ncontext needle\nfourth\nfifth\n");
      const rg = await ensureTool("rg", true);
      signal.throwIfAborted();
      if (!rg) {
        throw new Error("Native grep fixture requires a working ripgrep executable");
      }

      // A middle-line match exposes fractional indexing without boundary clamping.
      const nativeOutput = execFileSync(
        rg,
        [
          "--json",
          "--line-number",
          "--color=never",
          "--fixed-strings",
          "--",
          "context needle",
          filePath,
        ],
        { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      );
      const nativeEvents: unknown[] = nativeOutput
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(nativeEvents).toContainEqual({
        type: "match",
        data: expect.objectContaining({
          line_number: 3,
          lines: { text: "context needle\n" },
        }),
      });

      const tool = createTool("grep", cwd);
      const args = {
        pattern: "context needle",
        path: "sample.txt",
        literal: true,
        ...(context === undefined ? {} : { context }),
      };
      const validated = validateToolArguments(tool, {
        type: "toolCall",
        id: "grep-context",
        name: tool.name,
        arguments: args,
      });
      expect(validated).toEqual(args);
      const controller = new AbortController();
      const execution = tool.execute(
        "grep-context",
        validated,
        AbortSignal.any([signal, controller.signal]),
      );
      try {
        const result = await execution;
        expect(result.content).toEqual([{ type: "text", text: expected.join("\n") }]);
        expect(result.details).toBeUndefined();
      } finally {
        controller.abort();
        await Promise.allSettled([execution]);
      }
    },
  );
});
