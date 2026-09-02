// Qa Lab tests cover POSIX process tree metric sampling.
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

import { readProcessTreeCpuMs, readProcessTreeRssBytes } from "./process-tree-cpu.js";

afterEach(() => {
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
});

function usePsOutput(stdout: string): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  spawnSyncMock.mockReturnValue({ status: 0, stdout });
}

describe("POSIX process tree metrics", () => {
  it("parses ps CPU time formats", () => {
    usePsOutput(
      [
        "100 0 00:01",
        "101 0 00:00.12",
        "102 0 01:02",
        "103 0 01:02:03.45",
        "104 0 1-02:03:04.5",
      ].join("\n"),
    );

    expect(readProcessTreeCpuMs(100)).toBe(1_000);
    expect(readProcessTreeCpuMs(101)).toBe(120);
    expect(readProcessTreeCpuMs(102)).toBe(62_000);
    expect(readProcessTreeCpuMs(103)).toBe(3_723_450);
    expect(readProcessTreeCpuMs(104)).toBe(93_784_500);
    expect(spawnSyncMock).toHaveBeenCalledWith("ps", ["-eo", "pid=,ppid=,time="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  });

  it("rejects malformed ps CPU time strings", () => {
    usePsOutput(
      [
        "101 0 nope",
        "102 0 1::02",
        "103 0 1-02:03",
        "104 0 01:60",
        "105 0 01:02:60",
        "106 0 1:2:3:4",
      ].join("\n"),
    );

    expect(readProcessTreeCpuMs(100)).toBeNull();
    expect(readProcessTreeCpuMs(101)).toBeNull();
    expect(readProcessTreeCpuMs(102)).toBeNull();
    expect(readProcessTreeCpuMs(103)).toBeNull();
    expect(readProcessTreeCpuMs(104)).toBeNull();
    expect(readProcessTreeCpuMs(105)).toBeNull();
    expect(readProcessTreeCpuMs(106)).toBeNull();
  });

  it("parses ps RSS KiB values as bytes", () => {
    usePsOutput(["100 0 1024", "101 0 1.5"].join("\n"));

    expect(readProcessTreeRssBytes(100)).toBe(1_048_576);
    expect(readProcessTreeRssBytes(101)).toBe(1_536);
    expect(spawnSyncMock).toHaveBeenCalledWith("ps", ["-eo", "pid=,ppid=,rss="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  });

  it("rejects malformed ps RSS values", () => {
    usePsOutput(["101 0 nope", "102 0 -1", "103 0 0x10"].join("\n"));

    expect(readProcessTreeRssBytes(100)).toBeNull();
    expect(readProcessTreeRssBytes(101)).toBeNull();
    expect(readProcessTreeRssBytes(102)).toBeNull();
    expect(readProcessTreeRssBytes(103)).toBeNull();
  });
});
