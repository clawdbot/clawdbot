// Grep tool streaming tests cover result limits, cancellation, and runner-reported
// errors with the command runner mocked at its public contract; the runner owns
// spawn, stall detection, and process termination.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runUtf8CommandWithTimeout, type SpawnResult } from "../../../process/exec.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { createGrepToolDefinition } from "./grep.js";

vi.mock("../../../process/exec.js", () => ({
  runUtf8CommandWithTimeout: vi.fn(),
}));

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

type RunnerOptions = {
  signal?: AbortSignal;
  noOutputTimeoutMs?: number;
  onOutputChunk?: (chunk: Buffer, stream: "stdout" | "stderr") => boolean | void;
};

afterEach(() => {
  // Restore fake timers even when a timeout test fails mid-way; leaked fake
  // timers would otherwise poison later cases and hide the real failure.
  vi.useRealTimers();
  vi.clearAllMocks();
});

function spawnResult(overrides: Partial<SpawnResult>): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    noOutputTimedOut: false,
    ...overrides,
  };
}

// Stands in for the process the runner owns; kill() records that the runner
// terminated it. The tool itself no longer holds a process handle.
function createChild() {
  const child = {
    killed: false,
    kill: vi.fn(() => {
      child.killed = true;
      return true;
    }),
  };
  return child;
}

function runnerOptions(): RunnerOptions {
  const options = vi.mocked(runUtf8CommandWithTimeout).mock.calls[0]?.[1];
  if (!options || typeof options !== "object") {
    throw new Error("expected the tool to pass runner options");
  }
  return options as RunnerOptions;
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
  it.each([
    {
      name: "keeps an exact-size result complete",
      matchCount: 2,
      expectedText: "match.txt:1: foo\nmatch.txt:2: foo",
      expectedLimitReached: undefined,
      expectedKilled: false,
    },
    {
      name: "uses one extra match as the truncation sentinel",
      matchCount: 3,
      expectedText:
        "match.txt:1: foo\nmatch.txt:2: foo\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]",
      expectedLimitReached: 2,
      expectedKilled: true,
    },
  ])("$name", async ({ matchCount, expectedText, expectedLimitReached, expectedKilled }) => {
    const child = createChild();
    // Feed --json events through the runner's chunk observer; when the tool
    // declines more output (limit sentinel), the runner stops the child and
    // reports the kill.
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
      const onOutputChunk = (options as RunnerOptions).onOutputChunk;
      for (let lineNumber = 1; lineNumber <= matchCount; lineNumber += 1) {
        if (onOutputChunk?.(Buffer.from(grepMatch(lineNumber)), "stdout") === false) {
          child.kill();
          return spawnResult({
            code: null,
            signal: "SIGTERM",
            killed: true,
            termination: "signal",
            outputLimitExceeded: true,
          });
        }
      }
      return spawnResult({ code: 0 });
    });
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const tool = createGrepToolDefinition(process.cwd());
    const resultPromise = tool.execute(
      "call-limit",
      { pattern: "foo", limit: 2 },
      undefined,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

    const result = await resultPromise;
    expect(textContent(result)).toBe(expectedText);
    expect(result.details?.matchLimitReached).toBe(expectedLimitReached);
    expect(child.killed).toBe(expectedKilled);
  });

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
    expect(runUtf8CommandWithTimeout).not.toHaveBeenCalled();
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
    expect(runUtf8CommandWithTimeout).not.toHaveBeenCalled();
  });

  it("removes the abort listener after normal settlement", async () => {
    vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(spawnResult({ code: 1 }));
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
    await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

    await expect(result).resolves.toMatchObject({
      content: [{ type: "text", text: "No matches found" }],
    });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
  });

  it("settles an abort when the spawned child never closes", async () => {
    const child = createChild();
    // The runner owns killing the child on abort; its promise only settles
    // after a close that never comes here, so the tool must not wait on it.
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation(
      (_argv, options) =>
        new Promise<SpawnResult>(() => {
          (options as RunnerOptions).signal?.addEventListener("abort", () => child.kill(), {
            once: true,
          });
        }),
    );
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
    await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).rejects.toThrow("Operation aborted");
    expect(child.killed).toBe(true);
  });

  it("preserves abort precedence during async match formatting", async () => {
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
      (options as RunnerOptions).onOutputChunk?.(Buffer.from(grepMatch(1)), "stdout");
      return spawnResult({ code: 0 });
    });
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
    await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce());

    controller.abort();
    await expect(result).rejects.toThrow("Operation aborted");

    resolveReadFile?.("foo\n");
    await Promise.resolve();
  });

  it.each(["stdout", "stderr"] as const)(
    "rejects when the runner reports a %s failure",
    async (stream) => {
      // The runner terminates and reports output stream failures through the
      // outputErrorStream field on its sanitized error.
      vi.mocked(runUtf8CommandWithTimeout).mockRejectedValue(
        Object.assign(new Error(`${stream} EPIPE`), { outputErrorStream: stream }),
      );
      vi.mocked(ensureTool).mockResolvedValue("rg");

      const tool = createGrepToolDefinition(process.cwd());
      const resultPromise = tool.execute(
        "call-1",
        { pattern: "foo" },
        undefined,
        undefined,
        {} as never,
      );
      const rejection = expect(resultPromise).rejects.toThrow(
        `ripgrep ${stream} error: ${stream} EPIPE`,
      );
      await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

      await rejection;
    },
  );

  it("rejects and kills ripgrep when the search stalls without output past the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = createChild();
    // Simulate the runner contract: a silent child is killed at the no-output
    // deadline and the result reports noOutputTimedOut.
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
      await new Promise<void>((resolveWait) => {
        setTimeout(
          () => {
            child.kill();
            resolveWait();
          },
          (options as RunnerOptions).noOutputTimeoutMs,
        );
      });
      return spawnResult({
        code: 124,
        signal: "SIGKILL",
        killed: true,
        termination: "no-output-timeout",
        noOutputTimedOut: true,
      });
    });
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const tool = createGrepToolDefinition(process.cwd());
    // The child never writes output and never closes, mimicking ripgrep stalled
    // on a broken mount; the tool must reject instead of hanging for the outer abort.
    const result = tool.execute("call-1", { pattern: "foo" }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());
    expect(runnerOptions().noOutputTimeoutMs).toBe(60_000);

    const rejection = expect(result).rejects.toThrow(
      "ripgrep timed out after 60 seconds without output",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("leaves no timers behind when ripgrep exits normally", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(spawnResult({ code: 1 }));
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const tool = createGrepToolDefinition(process.cwd());
    const result = tool.execute("call-1", { pattern: "foo" }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

    await expect(result).resolves.toMatchObject({
      content: [{ type: "text", text: "No matches found" }],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not time out while formatting context after ripgrep exits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
      (options as RunnerOptions).onOutputChunk?.(Buffer.from(grepMatch(1)), "stdout");
      return spawnResult({ code: 0 });
    });
    vi.mocked(ensureTool).mockResolvedValue("rg");

    let resolveReadFile: ((value: string) => void) | undefined;
    const tool = createGrepToolDefinition(process.cwd(), {
      operations: {
        isDirectory: () => true,
        readFile: async () =>
          await new Promise<string>((resolve) => {
            resolveReadFile = resolve;
          }),
      },
    });
    const resultPromise = tool.execute(
      "call-1",
      { pattern: "foo", context: 1 },
      undefined,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

    // Context formatting awaits readFile() after the runner resolved; holding
    // it past the stall window must not reject a completed search, because no
    // stall timer survives child exit.
    await vi.advanceTimersByTimeAsync(120_000);
    resolveReadFile?.("foo\n");
    const result = await resultPromise;
    expect(textContent(result)).toContain("match.txt:1: foo");
  });

  it("reports the first output stream failure", async () => {
    // The runner records the first failing stream; later stream errors do not
    // replace it.
    vi.mocked(runUtf8CommandWithTimeout).mockRejectedValue(
      Object.assign(new Error("stderr first"), { outputErrorStream: "stderr" }),
    );
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const tool = createGrepToolDefinition(process.cwd());
    const result = tool.execute("call-1", { pattern: "foo" }, undefined, undefined, {} as never);
    const rejection = expect(result).rejects.toThrow("ripgrep stderr error: stderr first");
    await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

    await rejection;
  });

  it("keeps multibyte stderr intact in the rejection", async () => {
    // Chunk-safe multibyte decoding now belongs to the runner capture; the tool
    // must surface the decoded stderr verbatim.
    vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(
      spawnResult({ stderr: "rg 错误：权限被拒绝\n", code: 2 }),
    );
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const tool = createGrepToolDefinition(process.cwd());
    const result = tool.execute("call-1", { pattern: "foo" }, undefined, undefined, {} as never);
    const rejection = expect(result).rejects.toThrow("rg 错误：权限被拒绝");
    await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

    await rejection;
  });
});
