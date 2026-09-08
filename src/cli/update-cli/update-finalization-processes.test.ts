import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inspectUpdateFinalizationChildren } from "./update-finalization-processes.js";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));

beforeEach(() => mocks.spawnSync.mockReset());
afterEach(() => vi.restoreAllMocks());

it("reports nested children without unrelated processes, paths, or the diagnostic subprocess", () => {
  mocks.spawnSync.mockReturnValue({
    pid: 900,
    status: 0,
    stdout: [
      "103 102 /private/workspace/blocked-child",
      `101 ${process.pid} /private/runtime/node`,
      "102 101 /usr/bin/security",
      `900 ${process.pid} /bin/ps`,
      "901 900 /private/query-helper",
      "800 1 /private/unrelated-process",
    ].join("\n"),
  });
  expect(inspectUpdateFinalizationChildren()).toEqual({
    childProcessInspection: "complete",
    childProcessesTruncated: false,
    childProcesses: [
      { pid: 101, parentPid: process.pid, command: "node" },
      { pid: 102, parentPid: 101, command: "security" },
      { pid: 103, parentPid: 102, command: "blocked-child" },
    ],
  });
  expect(mocks.spawnSync).toHaveBeenCalledWith(expect.any(String), expect.any(Array), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
});

it("bounds child count and command names and reports truncation", () => {
  mocks.spawnSync.mockReturnValue({
    pid: 900,
    status: 0,
    stdout: Array.from(
      { length: 10 },
      (_, index) => `${100 + index} ${process.pid} /private/${"n".repeat(100)}`,
    ).join("\n"),
  });
  const result = inspectUpdateFinalizationChildren();
  expect(result.childProcessesTruncated).toBe(true);
  expect(result.childProcesses.map(({ pid }) => pid)).toEqual([
    100, 101, 102, 103, 104, 105, 106, 107,
  ]);
  expect(result.childProcesses.every(({ command }) => command.length === 64)).toBe(true);
});

it("reports an unavailable process snapshot instead of claiming there are no children", () => {
  mocks.spawnSync.mockReturnValue({ status: null, error: new Error("timeout") });
  expect(inspectUpdateFinalizationChildren()).toEqual({
    childProcessInspection: "unavailable",
    childProcessesTruncated: false,
    childProcesses: [],
  });
});
