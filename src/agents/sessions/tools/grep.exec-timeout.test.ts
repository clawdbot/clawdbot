import type { ChildProcess } from "node:child_process";
// Grep tool stall-timeout escalation tests run a real managed-bin stub that
// ignores SIGTERM: the inactivity deadline (the runner's noOutputTimeoutMs)
// must reject the tool call, the kill escalation must still reap the child,
// and its stdio pipes must be released.
// Fake timers keep the 60s stall window instantaneous; real timers return
// before the process-reaping assertions that need the real event loop.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  COMMAND_PROCESS_TREE_KILL_GRACE_MS,
  spawnCommandWithInvocation,
} from "../../../process/exec-spawn.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { createGrepToolDefinition } from "./grep.js";

// Keep the real spawn (the runner spawns through exec-spawn) while capturing
// spawned children.
vi.mock("../../../process/exec-spawn.js", async (importActual) => {
  const actual = (await importActual()) as typeof import("../../../process/exec-spawn.js");
  return {
    ...actual,
    spawnCommandWithInvocation: vi.fn(actual.spawnCommandWithInvocation),
  };
});

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Shebang execution and SIGTERM semantics are POSIX-only.
const describePosix = process.platform === "win32" ? describe.skip : describe;

// Captured at module load, before any fake-timer install; lets a test wait
// real wall-clock time (for child-process output) while the fake clock drives
// the stall deadline.
const realSetTimeout = globalThis.setTimeout;
const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });

function writeSigtermIgnoringStub(dir: string): string {
  const stubPath = path.join(dir, "stub-rg");
  fs.writeFileSync(
    stubPath,
    `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 60_000);\n`,
    { mode: 0o755 },
  );
  return stubPath;
}

function writeChattyStub(dir: string): string {
  const stubPath = path.join(dir, "stub-rg-chatty");
  fs.writeFileSync(
    stubPath,
    `#!${process.execPath}\nsetInterval(() => console.log("not-json"), 100);\n`,
    { mode: 0o755 },
  );
  return stubPath;
}

// One large ripgrep JSON record streamed in newline-less chunks: the tool's
// line buffer emits no completed event until the final chunk, so the runner's
// stall deadline must re-arm on raw stdout data or an active search is killed
// as silent.
function writeChunkedRecordStub(dir: string): string {
  const stubPath = path.join(dir, "stub-rg-chunked");
  fs.writeFileSync(
    stubPath,
    `#!${process.execPath}\nconst payload = JSON.stringify({type:"match",data:{path:{text:"big.txt"},line_number:1,lines:{text:"x".repeat(8192)}}});\nlet offset = 0;\nconst timer = setInterval(() => {\n  if (offset >= payload.length) {\n    clearInterval(timer);\n    process.stdout.write("\\n");\n    return;\n  }\n  process.stdout.write(payload.slice(offset, offset + 64));\n  offset += 64;\n}, 100);\n`,
    { mode: 0o755 },
  );
  return stubPath;
}

// execa 10 exposes the underlying ChildProcess (and its `killed` flag) through
// `nodeChildProcess`; the subprocess facade itself only carries pid/stdio/kill.
type SpawnedChild = {
  pid: number;
  stdout: { destroyed: boolean } | null;
  stderr: { destroyed: boolean } | null;
  nodeChildProcess: ChildProcess;
};

function lastSpawnedChild(): SpawnedChild {
  const child = vi.mocked(spawnCommandWithInvocation).mock.results.at(-1)?.value?.child as
    | ({ pid?: number } & Partial<SpawnedChild>)
    | undefined;
  if (!child || typeof child.pid !== "number" || !child.nodeChildProcess) {
    throw new Error("expected spawnCommandWithInvocation to have produced a child with a pid");
  }
  return child as SpawnedChild;
}

async function pumpUntilSpawned(): Promise<void> {
  for (let i = 0; i < 50 && !vi.mocked(spawnCommandWithInvocation).mock.calls.length; i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(spawnCommandWithInvocation).toHaveBeenCalledOnce();
}

async function expectProcessReaped(pid: number): Promise<void> {
  await vi.waitFor(
    () => {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
    { timeout: 5_000, interval: 25 },
  );
}

// The tool rejects only after the runner resolves post-kill, so pump the real
// event loop until the SIGKILLed stub's exit propagates.
async function pumpUntilSettled(isSettled: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !isSettled(); i++) {
    await realDelay(10);
    await vi.advanceTimersByTimeAsync(10);
  }
}

describePosix("grep tool stall-timeout escalation", () => {
  afterEach(() => {
    // Reap any stub that survived a failing run so the test process cannot
    // hang on open pipes.
    for (const result of vi.mocked(spawnCommandWithInvocation).mock.results) {
      const child = result.value?.child as { pid?: number } | undefined;
      if (typeof child?.pid === "number") {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("rejects after a silent window, reaps a SIGTERM-ignoring ripgrep via escalation, and releases its pipes", async () => {
    const dir = tempDirs.make("openclaw-grep-stub-");
    const stubPath = writeSigtermIgnoringStub(dir);
    vi.mocked(ensureTool).mockResolvedValue(stubPath);

    vi.useFakeTimers();
    const tool = createGrepToolDefinition(dir);
    const result = tool.execute("call-1", { pattern: "foo" }, undefined, undefined, {} as never);
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejection = expect(result).rejects.toThrow(/ripgrep timed out.*without output/);
    await pumpUntilSpawned();
    const child = lastSpawnedChild();

    // The stub never emits output, so nothing re-arms the runner's stall timer.
    await vi.advanceTimersByTimeAsync(60_000);
    // The stub ignores the runner's SIGTERM, so only execa's SIGKILL escalation
    // can reap it; the grace timer is faked too, so advance past the grace
    // window.
    await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_TREE_KILL_GRACE_MS + 100);
    await pumpUntilSettled(() => settled);
    await rejection;
    // Stream cleanup is part of child exit: no pipes stay pinned.
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stderr?.destroyed).toBe(true);
    expect(child.nodeChildProcess.killed).toBe(true);

    vi.useRealTimers();
    await expectProcessReaped(child.pid);
  });

  it("does not kill ripgrep while output keeps arriving past the stall window", async () => {
    const dir = tempDirs.make("openclaw-grep-active-");
    const stubPath = writeChattyStub(dir);
    vi.mocked(ensureTool).mockResolvedValue(stubPath);

    vi.useFakeTimers();
    const tool = createGrepToolDefinition(dir);
    const controller = new AbortController();
    const result = tool.execute(
      "call-1",
      { pattern: "foo" },
      controller.signal,
      undefined,
      {} as never,
    );
    let outcome: "resolved" | "rejected" | undefined;
    void result.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await pumpUntilSpawned();

    // 70s of fake time in 5s chunks, with real wall-clock pauses so the
    // chatty stub's lines arrive and re-arm the stall timer each chunk.
    for (let i = 0; i < 14; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      await realDelay(150);
    }
    expect(outcome).toBeUndefined();

    controller.abort();
    await expect(result).rejects.toThrow(/aborted/);
  });

  it("does not kill ripgrep while one large record streams in chunks without a newline", async () => {
    const dir = tempDirs.make("openclaw-grep-chunked-");
    const stubPath = writeChunkedRecordStub(dir);
    vi.mocked(ensureTool).mockResolvedValue(stubPath);

    vi.useFakeTimers();
    const tool = createGrepToolDefinition(dir);
    const controller = new AbortController();
    const result = tool.execute(
      "call-1",
      { pattern: "foo" },
      controller.signal,
      undefined,
      {} as never,
    );
    let outcome: "resolved" | "rejected" | undefined;
    void result.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await pumpUntilSpawned();

    // 70s of fake time in 5s chunks, with real wall-clock pauses so the
    // stub's newline-less chunks keep arriving. The tool's line buffer emits
    // no completed JSON event here, so only raw stdout activity can re-arm
    // the runner's stall timer.
    for (let i = 0; i < 14; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      await realDelay(150);
    }
    expect(outcome).toBeUndefined();

    controller.abort();
    await expect(result).rejects.toThrow(/aborted/);
  });
});
