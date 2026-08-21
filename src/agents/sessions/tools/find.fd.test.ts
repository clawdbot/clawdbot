// Find tool fd tests cover exit-code/error mapping, cancellation, and result
// limits with the command runner mocked at its public contract; the runner
// owns spawn, stall detection, and process termination.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { runUtf8CommandWithTimeout, type SpawnResult } from "../../../process/exec.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { createFindToolDefinition } from "./find.js";

vi.mock("../../../process/exec.js", () => ({
  runUtf8CommandWithTimeout: vi.fn(),
}));

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createFindToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

it("rejects partial fd output when fd exits with an error", async () => {
  vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(
    spawnResult({
      stdout: "/workspace/partial.ts\n",
      stderr: "fd failed while reading subtree\n",
      code: 2,
    }),
  );
  vi.mocked(ensureTool).mockResolvedValue("fd");

  const tool = createFindToolDefinition("/workspace");
  const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
  const rejection = expect(result).rejects.toThrow("fd failed while reading subtree");
  await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

  await rejection;
});

it("keeps multibyte stderr intact in the rejection", async () => {
  // Chunk-safe multibyte decoding now belongs to the runner capture; the tool
  // must surface the decoded stderr verbatim.
  vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(
    spawnResult({ stderr: "fd 失败：权限被拒绝\n", code: 2 }),
  );
  vi.mocked(ensureTool).mockResolvedValue("fd");

  const tool = createFindToolDefinition("/workspace");
  const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
  const rejection = expect(result).rejects.toThrow("fd 失败：权限被拒绝");
  await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

  await rejection;
});

it("rejects and kills fd when the search stalls without output past the deadline", async () => {
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
  vi.mocked(ensureTool).mockResolvedValue("fd");

  const tool = createFindToolDefinition("/workspace");
  // The child never writes output and never closes, mimicking fd stalled on a
  // broken mount; the tool must reject instead of hanging for the outer abort.
  const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
  await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());
  expect(runnerOptions().noOutputTimeoutMs).toBe(60_000);

  const rejection = expect(result).rejects.toThrow("fd timed out after 60 seconds without output");
  await vi.advanceTimersByTimeAsync(60_000);
  await rejection;
  expect(child.kill).toHaveBeenCalledOnce();
});

it("leaves no timers behind when fd exits normally", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(
    spawnResult({ stdout: "/workspace/a.ts\n" }),
  );
  vi.mocked(ensureTool).mockResolvedValue("fd");

  const tool = createFindToolDefinition("/workspace");
  const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
  await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());
  await result;

  expect(vi.getTimerCount()).toBe(0);
});

it.each(["stdout", "stderr"] as const)(
  "rejects when the runner reports a %s failure",
  async (stream) => {
    // The runner terminates and reports output stream failures through the
    // outputErrorStream field on its sanitized error.
    vi.mocked(runUtf8CommandWithTimeout).mockRejectedValue(
      Object.assign(new Error(`${stream} EPIPE`), { outputErrorStream: stream }),
    );
    vi.mocked(ensureTool).mockResolvedValue("fd");

    const tool = createFindToolDefinition("/workspace");
    const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
    const rejection = expect(result).rejects.toThrow(`fd ${stream} error: ${stream} EPIPE`);
    await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

    await rejection;
  },
);

it.each([
  { name: "inside a repository", gitBoundary: true, expected: false },
  { name: "outside a repository", gitBoundary: false, expected: true },
])("sets --no-require-git only $name", async ({ gitBoundary, expected }) => {
  const tempDir = tempDirs.make("openclaw-find-fd-");
  const searchPath = path.join(tempDir, "nested");
  await fs.mkdir(searchPath, { recursive: true });
  if (gitBoundary) {
    await fs.writeFile(path.join(tempDir, ".git"), "gitdir: /tmp/example\n");
  }

  vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(spawnResult({}));
  vi.mocked(ensureTool).mockResolvedValue("fd");
  const tool = createFindToolDefinition(tempDir);
  const result = tool.execute(
    "call-git-boundary",
    { pattern: "AGENTS.md", path: searchPath },
    undefined,
    undefined,
    {} as never,
  );
  await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());
  await result;

  const args = vi.mocked(runUtf8CommandWithTimeout).mock.calls[0]?.[0] as string[];
  expect(args.includes("--no-require-git")).toBe(expected);
});

it.each([
  {
    name: "keeps an exact-size fd result complete",
    paths: ["/workspace/a.ts", "/workspace/b.ts"],
    expectedText: "a.ts\nb.ts",
    expectedLimitReached: undefined,
  },
  {
    name: "uses one extra fd result as the truncation sentinel",
    paths: ["/workspace/a.ts", "/workspace/b.ts", "/workspace/c.ts"],
    expectedText:
      "a.ts\nb.ts\n\n[2 results limit reached. Use limit=4 for more, or refine pattern]",
    expectedLimitReached: 2,
  },
])("$name", async ({ paths, expectedText, expectedLimitReached }) => {
  vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue(
    spawnResult({ stdout: `${paths.join("\n")}\n` }),
  );
  vi.mocked(ensureTool).mockResolvedValue("fd");

  const tool = createFindToolDefinition("/workspace");
  const resultPromise = tool.execute(
    "call-limit",
    { pattern: "*.ts", limit: 2 },
    undefined,
    undefined,
    {} as never,
  );
  await vi.waitFor(() => expect(runUtf8CommandWithTimeout).toHaveBeenCalledOnce());

  const result = await resultPromise;
  const args = vi.mocked(runUtf8CommandWithTimeout).mock.calls[0]?.[0] as string[];
  expect(args).toEqual(expect.arrayContaining(["--max-results", "3"]));
  expect(textContent(result)).toBe(expectedText);
  expect(result.details?.resultLimitReached).toBe(expectedLimitReached);
});
