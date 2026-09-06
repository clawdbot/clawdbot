// Grep tool streaming tests cover result limits, cancellation, and subprocess errors.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { validateToolArguments } from "@openclaw/llm-core/validation";
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
const GREP_JSON_RECORD_MAX_BYTES = 1024 * 1024;
const GREP_JSON_RECORD_OVERSIZED_ERROR =
  "grep stopped because ripgrep emitted a JSON record larger than 1 MiB";

afterEach(() => {
  vi.clearAllMocks();
});

type MockChild = ChildProcessWithoutNullStreams & {
  nodeChildProcess: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  stderr: PassThrough;
  readonly killCallCount: number;
};

function createChild(): MockChild {
  let killed = false;
  let killCallCount = 0;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as MockChild;
  Object.defineProperty(child, "killed", { get: () => killed });
  Object.defineProperty(child, "killCallCount", { get: () => killCallCount });
  child.kill = vi.fn(() => {
    killCallCount += 1;
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
  filePath: string | { text: string } | { bytes: string } = "/tmp/match.txt",
): string {
  return `${JSON.stringify({
    type,
    data: {
      path: typeof filePath === "string" ? { text: filePath } : filePath,
      line_number: lineNumber,
      lines,
    },
  })}\n`;
}

function grepRowWithWireBytes(bytes: number): Buffer {
  const emptyRow = grepRow(1, { text: "" }).slice(0, -1);
  return Buffer.from(
    grepRow(1, { text: "x".repeat(bytes - Buffer.byteLength(emptyRow)) }).slice(0, -1),
  );
}

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createGrepToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

async function startMockGrep(signal?: AbortSignal) {
  const child = createChild();
  const expectedSpawns = vi.mocked(spawnCommand).mock.calls.length + 1;
  vi.mocked(spawnCommand).mockReturnValueOnce(child as never);
  vi.mocked(ensureTool).mockResolvedValue("rg");
  const result = createGrepToolDefinition(process.cwd()).execute(
    "framing",
    { pattern: "foo" },
    signal,
    undefined,
    {} as never,
  );
  await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledTimes(expectedSpawns));
  return { child, result };
}

function closeChild(child: MockChild, code: number | null, stdout?: string | Buffer) {
  child.stdout.end(stdout);
  child.stderr.end();
  child.emit("close", code);
}

describe("grep tool streaming", () => {
  it.each([
    {
      chunks: ["x".repeat(65536), "y".repeat(65536), "终"],
      dropped: 65539,
      tail: "y".repeat(65533) + "终",
    },
    {
      chunks: ["aaaa😀" + "c".repeat(65527), "dddddd"],
      dropped: 8,
      tail: "c".repeat(65527) + "dddddd",
    },
    { chunks: [" ".repeat(65540)], dropped: 4, tail: "ripgrep exited with code 2" },
  ])(
    "discloses $dropped discarded stderr bytes before the ripgrep diagnostic",
    async ({ chunks, dropped, tail }) => {
      const child = createChild();
      vi.mocked(spawnCommand).mockReturnValue(child as never);
      vi.mocked(ensureTool).mockResolvedValue("rg");
      const result = createGrepToolDefinition(process.cwd()).execute(
        "stderr",
        { pattern: "needle" },
        undefined,
        undefined,
        {} as never,
      );
      await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
      for (const chunk of chunks) {
        child.stderr.write(chunk);
      }
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 2);
      await expect(result).rejects.toThrow(
        `[${dropped} UTF-8 bytes of earlier stderr discarded at the 65536-byte retention cap]\n${tail}`,
      );
    },
  );
  it.each([1, 3])("keeps colliding byte-path context separate at match limit %s", async (limit) => {
    const cwd = tempDirs.make("openclaw-grep-byte-path-");
    const child = createChild();
    vi.mocked(spawnCommand).mockReturnValue(child as never);
    vi.mocked(ensureTool).mockResolvedValue("rg");
    const tool = createGrepToolDefinition(cwd);
    const execution = tool.execute(
      "byte-path",
      { pattern: "needle", context: 1, limit },
      undefined,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
    const paths = [
      ...[0x80, 0x81].map((byte) => ({
        bytes: Buffer.concat([
          Buffer.from(path.join(cwd, "report-")),
          Buffer.from([byte]),
          Buffer.from(".txt"),
        ]).toString("base64"),
      })),
      { text: path.join(cwd, "report-�.txt") },
    ];
    for (const [index, filePath] of paths.entries()) {
      child.stdout.write(
        grepRow(1, { text: `before ${index}\n` }, "context", filePath) +
          grepRow(2, { text: `needle ${index}\n` }, "match", filePath) +
          grepRow(3, { text: `after ${index}\n` }, "context", filePath),
      );
    }
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);
    const result = await execution;
    const rows = paths
      .slice(0, limit)
      .flatMap((_, index) => [
        `report-�.txt-1- before ${index}`,
        `report-�.txt:2: needle ${index}`,
        `report-�.txt-3- after ${index}`,
      ]);
    expect(textContent(result)).toBe(
      rows.join("\n") +
        (limit === 1
          ? "\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]"
          : ""),
    );
    expect(result.details).toEqual(limit === 1 ? { matchLimitReached: 1 } : undefined);
    expect(child.killed).toBe(limit === 1);
  });

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

  it("rejects an oversized ripgrep JSON record before EOF", async () => {
    const { child, result } = await startMockGrep();
    const rejection = result.catch((error: unknown) => error);

    try {
      for (let chunk = 0; chunk < 17; chunk += 1) {
        child.stdout.write(Buffer.alloc(64 * 1024, 0x78));
      }
      await vi.waitFor(() => expect(child.killCallCount).toBe(1));
      await expect(rejection).resolves.toEqual(
        expect.objectContaining({
          message: expect.stringContaining(GREP_JSON_RECORD_OVERSIZED_ERROR),
        }),
      );
    } finally {
      closeChild(child, 1);
    }
  });

  it("frames below-cap JSON split across chunks and UTF-8 boundaries", async () => {
    const { child, result } = await startMockGrep();

    const row = Buffer.from(grepRow(1, { text: `needle ${"中".repeat(4096)}\n` }));
    const split = row.indexOf(Buffer.from("中")) + 1;
    child.stdout.write(row.subarray(0, split));
    for (let offset = split; offset < row.length; offset += 257) {
      child.stdout.write(row.subarray(offset, offset + 257));
    }
    closeChild(child, 0);

    expect(textContent(await result)).toContain("needle 中中中");
  });

  it("processes multiple records from one chunk", async () => {
    const { child, result } = await startMockGrep();
    closeChild(child, 0, grepRow(1) + grepRow(2));

    expect(textContent(await result)).toBe("match.txt:1: foo\nmatch.txt:2: foo");
  });

  it("accepts a JSON record exactly at the wire-record ceiling", async () => {
    const { child, result } = await startMockGrep();
    closeChild(
      child,
      0,
      Buffer.concat([grepRowWithWireBytes(GREP_JSON_RECORD_MAX_BYTES), Buffer.from("\n")]),
    );

    await expect(result).resolves.toMatchObject({
      details: { linesTruncated: true },
    });
    expect(child.killed).toBe(false);
  });

  it("accepts an exact-ceiling record with CRLF split across chunks", async () => {
    const { child, result } = await startMockGrep();
    child.stdout.write(grepRowWithWireBytes(GREP_JSON_RECORD_MAX_BYTES));
    child.stdout.write("\r");
    closeChild(child, 0, "\n");

    await expect(result).resolves.toMatchObject({
      details: { linesTruncated: true },
    });
    expect(child.killed).toBe(false);
  });

  it("rejects byte 1,048,577 before parsing or returning partial matches", async () => {
    const { child, result } = await startMockGrep();
    const rejection = result.catch((error: unknown) => error);

    child.stdout.write(grepRow(1));
    child.stdout.write(Buffer.alloc(GREP_JSON_RECORD_MAX_BYTES + 1, 0x78));
    await expect(rejection).resolves.toEqual(
      expect.objectContaining({
        message: expect.stringContaining(GREP_JSON_RECORD_OVERSIZED_ERROR),
      }),
    );
    expect(child.killed).toBe(true);
    closeChild(child, null);
  });

  it("does not parse an oversized record or a later record in the same chunk", async () => {
    const { child, result } = await startMockGrep();

    child.stdout.write(
      Buffer.concat([
        Buffer.alloc(GREP_JSON_RECORD_MAX_BYTES + 1, 0x78),
        Buffer.from(`\n${grepRow(1)}`),
      ]),
    );
    await expect(result).rejects.toThrow(GREP_JSON_RECORD_OVERSIZED_ERROR);
    closeChild(child, null);
  });

  it("recovers on the next grep after terminating an oversized record", async () => {
    const first = await startMockGrep();
    first.child.stdout.write(Buffer.alloc(GREP_JSON_RECORD_MAX_BYTES + 1, 0x78));
    await expect(first.result).rejects.toThrow(GREP_JSON_RECORD_OVERSIZED_ERROR);
    closeChild(first.child, null);

    const second = await startMockGrep();
    closeChild(second.child, 0, grepRow(1));

    expect(textContent(await second.result)).toBe("match.txt:1: foo");
    expect(second.child.killed).toBe(false);
  });

  it.each([
    { name: "abort first", first: "abort", expected: "Operation aborted" },
    { name: "overflow first", first: "overflow", expected: GREP_JSON_RECORD_OVERSIZED_ERROR },
  ] as const)("keeps first settlement when $name", async ({ first, expected }) => {
    const controller = new AbortController();
    const { child, result } = await startMockGrep(controller.signal);
    const rejection = result.catch((error: unknown) => error);

    if (first === "abort") {
      controller.abort();
      child.stdout.write(Buffer.alloc(GREP_JSON_RECORD_MAX_BYTES + 1, 0x78));
    } else {
      child.stdout.write(Buffer.alloc(GREP_JSON_RECORD_MAX_BYTES + 1, 0x78));
      controller.abort();
    }
    await expect(rejection).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining(expected) }),
    );
    expect(child.killCallCount).toBe(1);
    closeChild(child, null);
  });

  it("handles late stream and child errors after overflow", async () => {
    const { child, result } = await startMockGrep();

    child.stdout.write(Buffer.alloc(GREP_JSON_RECORD_MAX_BYTES + 1, 0x78));
    await expect(result).rejects.toThrow(GREP_JSON_RECORD_OVERSIZED_ERROR);
    expect(() => {
      child.stdout.emit("error", new Error("late stdout"));
      child.stderr.emit("error", new Error("late stderr"));
      child.emit("error", new Error("late child"));
    }).not.toThrow();
    closeChild(child, null);
  });

  it.each([
    { name: "unterminated EOF", prefix: "", suffix: "" },
    { name: "carriage-return EOF", prefix: "", suffix: "\r" },
    { name: "CRLF", prefix: "", suffix: "\r\n" },
    { name: "malformed then valid", prefix: "{not json}\n", suffix: "\n" },
  ])("preserves $name record handling", async ({ prefix, suffix }) => {
    const { child, result } = await startMockGrep();
    closeChild(child, 0, `${prefix}${grepRow(1).slice(0, -1)}${suffix}`);

    expect(textContent(await result)).toBe("match.txt:1: foo");
  });

  it("keeps stdout guarded after a stderr failure", async () => {
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
