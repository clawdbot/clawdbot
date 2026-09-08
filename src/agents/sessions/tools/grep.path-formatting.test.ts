// Grep tool path formatting tests verify that match paths stay relative to the
// search directory, including children whose names begin with two dots.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnCommand } from "../../../process/exec.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { createGrepToolDefinition } from "./grep.js";

vi.mock("../../../process/exec.js", () => ({
  spawnCommand: vi.fn(),
}));

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

type MockChild = ChildProcessWithoutNullStreams & {
  nodeChildProcess: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  stderr: PassThrough;
};

function createChild(): MockChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as MockChild;
  child.kill = vi.fn(() => true);
  child.nodeChildProcess = child;
  return child;
}

function rgMatchLine(filePath: string, lineNumber: number, text: string): string {
  return `${JSON.stringify({
    type: "match",
    data: {
      path: { text: filePath },
      line_number: lineNumber,
      lines: { text: `${text}\n` },
    },
  })}\n`;
}

async function runGrepAgainst(searchRoot: string, matchPaths: string[]): Promise<string> {
  const child = createChild();
  vi.mocked(spawnCommand).mockReturnValue(child as never);
  vi.mocked(ensureTool).mockResolvedValue("rg");

  const tool = createGrepToolDefinition(searchRoot, {
    operations: { isDirectory: () => true, readFile: () => "" },
  });
  const result = tool.execute(
    "call-1",
    { pattern: "needle" },
    new AbortController().signal,
    undefined,
    {} as never,
  );

  await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
  for (const [index, matchPath] of matchPaths.entries()) {
    child.stdout.write(rgMatchLine(matchPath, index + 1, "needle here"));
  }
  child.stdout.end();
  child.emit("close", 0);

  const resolved = (await result) as { content: Array<{ type: string; text: string }> };
  return resolved.content.map((part) => part.text).join("\n");
}

describe("grep tool path formatting", () => {
  it("keeps match paths relative for children whose names start with two dots", async () => {
    const searchRoot = path.resolve("/grep-root");

    const output = await runGrepAgainst(searchRoot, [
      path.join(searchRoot, "..cache", "notes.txt"),
      path.join(searchRoot, "src", "app.ts"),
    ]);

    expect(output).toContain("..cache/notes.txt:1:");
    expect(output).toContain("src/app.ts:2:");
  });

  it("falls back to the basename for matches outside the search directory", async () => {
    const searchRoot = path.resolve("/grep-root");

    // A sibling sharing the root's prefix is not inside it, so the relative form
    // would be misleading and the basename is used instead.
    const output = await runGrepAgainst(searchRoot, [
      path.resolve("/grep-root..backup/secret.txt"),
    ]);

    expect(output).toContain("secret.txt:1:");
    expect(output).not.toContain("..backup");
  });
});
