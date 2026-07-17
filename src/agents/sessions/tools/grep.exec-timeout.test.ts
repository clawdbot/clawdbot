import type { ChildProcess } from "node:child_process";
// Grep tool stall-timeout escalation tests run a real managed-bin stub that
// ignores SIGTERM: the inactivity deadline must reject the tool call, the kill
// escalation must still reap the child, and its stdio pipes must be destroyed.
// Fake timers keep the 60s stall window instantaneous; real timers return
// before the process-reaping assertions that need the real event loop.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS } from "../../../process/exec-spawn.js";
import { spawnCommand } from "../../../process/exec.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { createGrepToolDefinition } from "./grep.js";

// Keep the real exec module (real spawn) while capturing spawned children.
vi.mock("../../../process/exec.js", async (importActual) => {
  const actual = (await importActual()) as typeof import("../../../process/exec.js");
  return {
    ...actual,
    spawnCommand: vi.fn(actual.spawnCommand),
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

// execa 10 exposes the underlying ChildProcess (and its `killed` flag) through
// `nodeChildProcess`; the subprocess facade itself only carries pid/stdio/kill.
type SpawnedChild = {
  pid: number;
  stdout: { destroyed: boolean } | null;
  stderr: { destroyed: boolean } | null;
  nodeChildProcess: ChildProcess;
};

function lastSpawnedChild(): SpawnedChild {
  const child = vi.mocked(spawnCommand).mock.results.at(-1)?.value as
    | ({ pid?: number } & Partial<SpawnedChild>)
    | undefined;
  if (!child || typeof child.pid !== "number" || !child.nodeChildProcess) {
    throw new Error("expected spawnCommand to have produced a child with a pid");
  }
  return child as SpawnedChild;
}

async function pumpUntilSpawned(): Promise<void> {
  for (let i = 0; i < 50 && !vi.mocked(spawnCommand).mock.calls.length; i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(spawnCommand).toHaveBeenCalledOnce();
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

describePosix("grep tool stall-timeout escalation", () => {
  afterEach(() => {
    // Reap any stub that survived a failing run so the test process cannot
    // hang on open pipes.
    for (const result of vi.mocked(spawnCommand).mock.results) {
      const child = result.value as { pid?: number } | undefined;
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
    const rejection = expect(result).rejects.toThrow(/ripgrep timed out.*without output/);
    await pumpUntilSpawned();
    const child = lastSpawnedChild();

    // The stub never emits output, so nothing re-arms the stall timer.
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    // Stream cleanup is part of forced settlement: no pipes stay pinned.
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stderr?.destroyed).toBe(true);
    // The stub ignores SIGTERM, so only the SIGKILL escalation can reap it;
    // execa's grace timer is faked too, so advance past the grace window.
    await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_TREE_KILL_GRACE_MS + 100);
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
});
