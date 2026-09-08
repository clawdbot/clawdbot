import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inspectUpdateFinalizationChildren } from "./update-finalization-processes.js";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn(), readlinkSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:fs", () => ({ readlinkSync: mocks.readlinkSync }));

const originalPlatform = process.platform;
beforeEach(() => {
  mocks.spawnSync.mockReset();
  mocks.readlinkSync.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.restoreAllMocks();
});

it("reports nested children without unrelated processes, paths, or the diagnostic subprocess", () => {
  const executables = new Map([
    ["/proc/101/exe", "/private/runtime/node"],
    ["/proc/102/exe", "/usr/bin/security"],
    ["/proc/103/exe", "/private/workspace/blocked-child"],
  ]);
  mocks.readlinkSync.mockImplementation((file: string) => executables.get(file));
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
  mocks.readlinkSync.mockReturnValue(`/private/${"n".repeat(100)}`);
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
  expect(result.childProcesses.every(({ command }) => command?.length === 64)).toBe(true);
  if (process.platform === "linux") {
    expect(mocks.readlinkSync).toHaveBeenCalledTimes(8);
  }
});

it.each([false, true])(
  "uses Linux executable identity, never a mutable title (unreadable=%s)",
  (unreadable) => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mocks.spawnSync.mockReturnValue({ pid: 900, status: 0, stdout: `101 ${process.pid}\n` });
    mocks.readlinkSync.mockImplementation(() => {
      if (unreadable) {
        throw new Error("process executable unavailable");
      }
      return "/private/runtime/node";
    });
    expect(inspectUpdateFinalizationChildren().childProcesses).toEqual([
      { pid: 101, parentPid: process.pid, command: unreadable ? null : "node" },
    ]);
    expect(mocks.spawnSync.mock.calls[0]?.[1]).toEqual(["-axo", "pid=,ppid="]);
  },
);

it("reports an unavailable process snapshot instead of claiming there are no children", () => {
  mocks.spawnSync.mockReturnValue({ status: null, error: new Error("timeout") });
  expect(inspectUpdateFinalizationChildren()).toEqual({
    childProcessInspection: "unavailable",
    childProcessesTruncated: false,
    childProcesses: [],
  });
});
