// Grep tool streaming tests cover result limits, cancellation, and subprocess errors.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { spawnCommand } from "../../../process/exec.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { createGrepToolDefinition } from "./grep.js";

vi.mock("../../../process/exec.js", () => ({
  spawnCommand: vi.fn(),
}));

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

function grepRow(
  lineNumber: number,
  lines: { text: string } | { bytes: string } = { text: "foo\n" },
  type: "match" | "context" = "match",
  filePath = "/tmp/match.txt",
): string {
  return `${JSON.stringify({
    type,
    data: {
      path: { text: filePath },
      line_number: lineNumber,
      lines,
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
  it.each(["..notes/sub/sample.txt", ...(path.sep === "/" ? ["literal\\name.txt"] : [])])(
    "preserves readable result path %s",
    async (relativePath) => {
      const cwd = tempDirs.make("openclaw-grep-path-");
      const filePath = path.join(cwd, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "needle\n");
      const child = createChild();
      vi.mocked(spawnCommand).mockReturnValue(child as never);
      vi.mocked(ensureTool).mockResolvedValue("rg");
      const tool = createGrepToolDefinition(cwd);
      const execution = tool.execute(
        "path",
        { pattern: "needle" },
        undefined,
        undefined,
        {} as never,
      );
      await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
      child.stdout.end(grepRow(1, { text: "needle\n" }, "match", filePath));
      child.stderr.end();
      child.emit("close", 0);
      expect(textContent(await execution)).toBe(`${relativePath}:1: needle`);
    },
  );

  it.each(["utf8", "utf16le", "utf16be", "byte-form"] as const)(
    "renders the searched %s context without decoding the file again",
    async (encoding) => {
      const cwd = tempDirs.make("openclaw-grep-context-");
      const filePath = path.join(cwd, "sample.txt");
      const text = "before\nneedle中\nafter\n";
      const bytes =
        encoding === "byte-form"
          ? Buffer.from("before\xff\nneedle\xff\nafter\n", "latin1")
          : encoding === "utf8"
            ? Buffer.from(text)
            : Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
      await writeFile(filePath, encoding === "utf16be" ? bytes.swap16() : bytes);
      const child = createChild();
      vi.mocked(spawnCommand).mockReturnValue(child as never);
      vi.mocked(ensureTool).mockResolvedValue("rg");
      const tool = createGrepToolDefinition(cwd);
      const execution = tool.execute(
        "context",
        { pattern: "needle", context: 1 },
        undefined,
        undefined,
        {} as never,
      );
      await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
      child.stdout.end(
        grepRow(
          1,
          encoding === "byte-form"
            ? { bytes: Buffer.from("before\xff\n", "latin1").toString("base64") }
            : { text: "before\n" },
          "context",
          filePath,
        ) +
          grepRow(
            2,
            encoding === "byte-form"
              ? { bytes: Buffer.from("needle\xff\n", "latin1").toString("base64") }
              : { text: "needle中\n" },
            "match",
            filePath,
          ) +
          grepRow(3, { text: "after\n" }, "context", filePath),
      );
      child.stderr.end();
      child.emit("close", 0);
      const result = await execution;
      expect(result.content).toEqual([
        {
          type: "text",
          text: `sample.txt-1- ${encoding === "byte-form" ? "before�" : "before"}\nsample.txt:2: ${encoding === "byte-form" ? "needle�" : "needle中"}\nsample.txt-3- after`,
        },
      ]);
      expect(result.details).toBeUndefined();
      expect(vi.mocked(spawnCommand).mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining(["--context", "1"]),
      );
    },
  );

  it.each([3, 4, 5])("captures context before stopping at sentinel line %s", async (sentinel) => {
    const cwd = tempDirs.make("openclaw-grep-sentinel-");
    const filePath = path.join(cwd, "sample.txt");
    const lines = ["before", "foo retained", "middle", "tail", "outside"];
    lines[sentinel - 1] = "foo extra";
    await writeFile(filePath, lines.join("\n"));
    const child = createChild();
    vi.mocked(spawnCommand).mockReturnValue(child as never);
    vi.mocked(ensureTool).mockResolvedValue("rg");
    const tool = createGrepToolDefinition(cwd);
    const execution = tool.execute(
      "limit",
      { pattern: "foo", context: 2, limit: 1 },
      undefined,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
    const killedAfterRows: boolean[] = [];
    for (let lineNumber = 1; lineNumber <= Math.max(4, sentinel); lineNumber++) {
      child.stdout.write(
        grepRow(
          lineNumber,
          { text: `${lines[lineNumber - 1]}\n` },
          lineNumber === 2 || lineNumber === sentinel ? "match" : "context",
          filePath,
        ),
      );
      killedAfterRows.push(child.killed);
    }
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null);
    const result = await execution;
    expect(killedAfterRows).toEqual(
      sentinel === 5 ? [false, false, false, false, true] : [false, false, false, true],
    );
    expect(textContent(result)).toBe(
      `sample.txt-1- before\nsample.txt:2: foo retained\nsample.txt-3- ${lines[2]}\nsample.txt-4- ${lines[3]}\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]`,
    );
    expect(result.details).toEqual({ matchLimitReached: 1 });
  });

  it("keeps exact-limit overlapping windows in match order", async () => {
    const cwd = tempDirs.make("openclaw-grep-overlap-");
    const filePath = path.join(cwd, "match.txt");
    await writeFile(filePath, "before\nfoo first\nfoo second\nafter");
    const child = createChild();
    vi.mocked(spawnCommand).mockReturnValue(child as never);
    vi.mocked(ensureTool).mockResolvedValue("rg");
    const tool = createGrepToolDefinition(cwd);
    const execution = tool.execute(
      "overlap",
      { pattern: "foo", context: 1, limit: 2 },
      undefined,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
    child.stdout.end(
      grepRow(1, { text: "before\n" }, "context", filePath) +
        grepRow(2, { text: "foo first\n" }, "match", filePath) +
        grepRow(3, { text: "foo second\n" }, "match", filePath) +
        grepRow(4, { text: "after" }, "context", filePath),
    );
    child.stderr.end();
    child.emit("close", 0);
    const result = await execution;
    expect(textContent(result)).toBe(
      "match.txt-1- before\nmatch.txt:2: foo first\nmatch.txt-3- foo second\nmatch.txt-2- foo first\nmatch.txt:3: foo second\nmatch.txt-4- after",
    );
    expect(result.details).toBeUndefined();
    expect(child.killed).toBe(false);
  });

  it.each(["", "\n"])(
    "finishes a retained window at file end with terminator %j",
    async (terminator) => {
      const cwd = tempDirs.make("openclaw-grep-eof-");
      const filePath = path.join(cwd, "sample.txt");
      await writeFile(filePath, `before\nfoo retained\nfoo extra${terminator}`);
      const child = createChild();
      vi.mocked(spawnCommand).mockReturnValue(child as never);
      vi.mocked(ensureTool).mockResolvedValue("rg");
      const tool = createGrepToolDefinition(cwd);
      const execution = tool.execute(
        "eof",
        { pattern: "foo", context: 3, limit: 1 },
        undefined,
        undefined,
        {} as never,
      );
      await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
      child.stdout.write(
        grepRow(1, { text: "before\n" }, "context", filePath) +
          grepRow(2, { text: "foo retained\n" }, "match", filePath) +
          grepRow(3, { text: `foo extra${terminator}` }, "match", filePath),
      );
      const killedBeforeEnd = child.killed;
      child.stdout.end(`${JSON.stringify({ type: "end", data: { path: { text: filePath } } })}\n`);
      const killedAfterEnd = child.killed;
      child.stderr.end();
      child.emit("close", null);
      const result = await execution;
      expect([killedBeforeEnd, killedAfterEnd]).toEqual([false, true]);
      expect(textContent(result)).toBe(
        "sample.txt-1- before\nsample.txt:2: foo retained\nsample.txt-3- foo extra\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]",
      );
    },
  );

  it.each([
    { context: 0, hasText: true, reads: 0, expected: "match.txt:2: native needle" },
    { context: 0, hasText: false, reads: 1, expected: "match.txt:2: custom needle" },
    {
      context: 1,
      hasText: true,
      reads: 1,
      expected: "match.txt-1- remote\nmatch.txt:2: custom needle\nmatch.txt-3- tail",
    },
  ])(
    "preserves custom reader ownership for context $context and native text $hasText",
    async ({ context, hasText, reads, expected }) => {
      const child = createChild();
      vi.mocked(spawnCommand).mockReturnValue(child as never);
      vi.mocked(ensureTool).mockResolvedValue("rg");
      const readFile = vi.fn(async () => "remote\r\ncustom needle\rtail\n");
      const tool = createGrepToolDefinition("/workspace", {
        operations: { isDirectory: () => true, readFile },
      });
      const execution = tool.execute(
        "custom",
        { pattern: "needle", context },
        undefined,
        undefined,
        {} as never,
      );
      await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
      child.stdout.end(
        grepRow(
          2,
          hasText
            ? { text: "native needle\n" }
            : { bytes: Buffer.from("native needle\xff\n", "latin1").toString("base64") },
        ),
      );
      child.stderr.end();
      child.emit("close", 0);
      expect(textContent(await execution)).toBe(expected);
      expect(readFile).toHaveBeenCalledTimes(reads);
    },
  );

  it("settles cancellation while draining a retained context window", async () => {
    const child = createChild();
    const kill = vi.spyOn(child, "kill");
    vi.mocked(spawnCommand).mockReturnValue(child as never);
    vi.mocked(ensureTool).mockResolvedValue("rg");
    const controller = new AbortController();
    const tool = createGrepToolDefinition(process.cwd());
    const execution = tool.execute(
      "drain-abort",
      { pattern: "foo", context: 2, limit: 1 },
      controller.signal,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
    child.stdout.write(grepRow(1) + grepRow(2));
    const killedBeforeAbort = child.killed;
    const rejection = expect(execution).rejects.toThrow("Operation aborted");
    controller.abort();
    await rejection;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null);
    expect(killedBeforeAbort).toBe(false);
    expect(kill).toHaveBeenCalledOnce();
  });

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
        child.stdout.write(grepRow(lineNumber));
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
