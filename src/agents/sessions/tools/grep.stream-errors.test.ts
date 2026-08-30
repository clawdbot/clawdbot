// Grep tool streaming tests cover result limits, cancellation, and subprocess errors.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { validateToolArguments } from "@openclaw/llm-core/validation";
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
  let killed = false;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as MockChild;
  Object.defineProperty(child, "killed", { get: () => killed });
  child.kill = vi.fn(() => {
    killed = true;
    return true;
  });
  child.nodeChildProcess = child;
  return child;
}

function grepMatch(lineNumber: number): string {
  return `${JSON.stringify({
    type: "match",
    data: {
      path: { text: "/tmp/match.txt" },
      line_number: lineNumber,
      lines: { text: "foo\n" },
    },
  })}\n`;
}

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createGrepToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("grep tool streaming", () => {
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
    "normalizes grep context $context after argument validation",
    async ({ context, expected }) => {
      const child = createChild();
      vi.mocked(spawnCommand).mockReturnValue(child as never);
      vi.mocked(ensureTool).mockResolvedValue("rg");

      const cwd = "/workspace";
      const filePath = `${cwd}/sample.txt`;
      const tool = createGrepToolDefinition(cwd, {
        operations: {
          isDirectory: () => false,
          readFile: () => "first\nsecond\ncontext needle\nfourth\nfifth\n",
        },
      });
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
      }) as Parameters<typeof tool.execute>[1];
      expect(validated).toEqual(args);

      const resultPromise = tool.execute(
        "grep-context",
        validated,
        undefined,
        undefined,
        {} as never,
      );
      await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
      child.stdout.end(
        `${JSON.stringify({
          type: "match",
          data: {
            path: { text: filePath },
            line_number: 3,
            lines: { text: "context needle\n" },
          },
        })}\n`,
      );
      child.stderr.end();
      child.emit("close", 0);

      const result = await resultPromise;
      expect(result.content).toEqual([{ type: "text", text: expected.join("\n") }]);
      expect(result.details).toBeUndefined();
    },
  );

  it.each([
    {
      name: "keeps an exact-size result complete",
      matchCount: 2,
      closeCode: 0,
      expectedText: "match.txt:1: foo\nmatch.txt:2: foo",
      expectedLimitReached: undefined,
      expectedKilled: false,
    },
    {
      name: "uses one extra match as the truncation sentinel",
      matchCount: 3,
      closeCode: null,
      expectedText:
        "match.txt:1: foo\nmatch.txt:2: foo\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]",
      expectedLimitReached: 2,
      expectedKilled: true,
    },
  ])(
    "$name",
    async ({ matchCount, closeCode, expectedText, expectedLimitReached, expectedKilled }) => {
      const child = createChild();
      vi.mocked(spawnCommand).mockReturnValue(child as never);
      vi.mocked(ensureTool).mockResolvedValue("rg");

      const tool = createGrepToolDefinition(process.cwd());
      const resultPromise = tool.execute(
        "call-limit",
        { pattern: "foo", limit: 2 },
        undefined,
        undefined,
        {} as never,
      );
      await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
      for (let lineNumber = 1; lineNumber <= matchCount; lineNumber += 1) {
        child.stdout.write(grepMatch(lineNumber));
      }
      child.stdout.end();
      child.stderr.end();
      child.emit("close", closeCode);

      const result = await resultPromise;
      expect(textContent(result)).toBe(expectedText);
      expect(result.details?.matchLimitReached).toBe(expectedLimitReached);
      expect(child.killed).toBe(expectedKilled);
    },
  );

  it("settles promptly when aborted while resolving rg", async () => {
    let resolveEnsureTool: ((value: string) => void) | undefined;
    vi.mocked(ensureTool).mockImplementationOnce(
      async () =>
        await new Promise<string>((resolve) => {
          resolveEnsureTool = resolve;
        }),
    );

    const controller = new AbortController();
    const tool = createGrepToolDefinition(process.cwd());
    const result = tool.execute(
      "call-1",
      { pattern: "foo" },
      controller.signal,
      undefined,
      {} as never,
    );

    await vi.waitFor(() => expect(ensureTool).toHaveBeenCalledOnce());
    controller.abort();
    await expect(result).rejects.toThrow("Operation aborted");

    resolveEnsureTool?.("rg");
    await Promise.resolve();
    expect(spawnCommand).not.toHaveBeenCalled();
  });

  it("does not spawn after an aborted search-path check later resolves", async () => {
    let resolveIsDirectory: ((value: boolean) => void) | undefined;
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const controller = new AbortController();
    const tool = createGrepToolDefinition(process.cwd(), {
      operations: {
        isDirectory: async () =>
          await new Promise<boolean>((resolve) => {
            resolveIsDirectory = resolve;
          }),
        readFile: () => "",
      },
    });
    const result = tool.execute(
      "call-1",
      { pattern: "foo" },
      controller.signal,
      undefined,
      {} as never,
    );

    await vi.waitFor(() => expect(resolveIsDirectory).toBeDefined());
    controller.abort();
    await expect(result).rejects.toThrow("Operation aborted");

    resolveIsDirectory?.(true);
    await Promise.resolve();
    expect(spawnCommand).not.toHaveBeenCalled();
  });

  it("removes the abort listener after normal settlement", async () => {
    const child = createChild();
    vi.mocked(spawnCommand).mockReturnValue(child as never);
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const tool = createGrepToolDefinition(process.cwd());
    const result = tool.execute(
      "call-1",
      { pattern: "foo" },
      controller.signal,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
    child.emit("close", 1);

    await expect(result).resolves.toMatchObject({
      content: [{ type: "text", text: "No matches found" }],
    });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(child.killed).toBe(false);
  });

  it("settles an abort when the spawned child never closes", async () => {
    const child = createChild();
    vi.mocked(spawnCommand).mockReturnValue(child as never);
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const controller = new AbortController();
    const tool = createGrepToolDefinition(process.cwd());
    const result = tool.execute(
      "call-1",
      { pattern: "foo" },
      controller.signal,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).rejects.toThrow("Operation aborted");
    expect(child.killed).toBe(true);
  });

  it("preserves abort precedence during async match formatting", async () => {
    const child = createChild();
    vi.mocked(spawnCommand).mockReturnValue(child as never);
    vi.mocked(ensureTool).mockResolvedValue("rg");
    let resolveReadFile: ((value: string) => void) | undefined;
    const readFile = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          resolveReadFile = resolve;
        }),
    );

    const controller = new AbortController();
    const tool = createGrepToolDefinition(process.cwd(), {
      operations: { isDirectory: () => true, readFile },
    });
    const result = tool.execute(
      "call-1",
      { pattern: "foo", context: 1 },
      controller.signal,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
    child.stdout.write(
      `${JSON.stringify({
        type: "match",
        data: { path: { text: "/tmp/match.txt" }, line_number: 1, lines: { text: "foo\n" } },
      })}\n`,
    );
    child.emit("close", 0);
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce());

    controller.abort();
    await expect(result).rejects.toThrow("Operation aborted");
    expect(child.killed).toBe(false);

    resolveReadFile?.("foo\n");
    await Promise.resolve();
  });

  it.each(["stdout", "stderr"] as const)(
    "rejects and terminates ripgrep when %s fails",
    async (stream) => {
      const child = createChild();
      vi.mocked(spawnCommand).mockReturnValue(child as never);
      vi.mocked(ensureTool).mockResolvedValue("rg");

      const tool = createGrepToolDefinition(process.cwd());
      const resultPromise = tool.execute(
        "call-1",
        { pattern: "foo" },
        undefined,
        undefined,
        {} as never,
      );
      await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
      child[stream].emit("error", new Error(`${stream} EPIPE`));

      await expect(resultPromise).rejects.toThrow(`${stream} EPIPE`);
      expect(child.killed).toBe(true);
    },
  );

  it("keeps stdout guarded after a stderr failure closes readline", async () => {
    const child = createChild();
    vi.mocked(spawnCommand).mockReturnValue(child as never);
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const tool = createGrepToolDefinition(process.cwd());
    const result = tool.execute("call-1", { pattern: "foo" }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());

    expect(() => {
      child.stderr.emit("error", new Error("stderr first"));
      child.stdout.emit("error", new Error("stdout later"));
    }).not.toThrow();
    await expect(result).rejects.toThrow("stderr first");
  });

  it("keeps multibyte stderr intact when pipe chunks split a character", async () => {
    const child = createChild();
    vi.mocked(spawnCommand).mockReturnValue(child as never);
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const tool = createGrepToolDefinition(process.cwd());
    const result = tool.execute("call-1", { pattern: "foo" }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
    const stderrBytes = Buffer.from("rg 错误：权限被拒绝\n");
    child.stdout.end();
    // Split inside the first multibyte character to mimic a pipe chunk boundary.
    child.stderr.write(stderrBytes.subarray(0, 4));
    child.stderr.end(stderrBytes.subarray(4));
    child.emit("close", 2);

    await expect(result).rejects.toThrow("rg 错误：权限被拒绝");
  });
});
