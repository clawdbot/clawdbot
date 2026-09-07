// Qa Lab tests cover Windows process tree sampling command selection.
import path from "node:path";
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
  vi.unstubAllEnvs();
  spawnSyncMock.mockReset();
});

describe("readProcessTreeCpuMs on Windows", () => {
  it("parses single-process Windows CPU and RSS counters", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        ProcessId: 100,
        ParentProcessId: 50,
        KernelModeTime: "20000",
        UserModeTime: 30_000,
        WorkingSetSize: "1048576",
      }),
    });

    expect(readProcessTreeCpuMs(100)).toBe(5);
    expect(readProcessTreeRssBytes(100)).toBe(1_048_576);
  });

  it("parses process tree CPU and RSS metrics through the trusted PowerShell path", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", "D:\\Windows");
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          ProcessId: 100,
          ParentProcessId: 50,
          KernelModeTime: "10000",
          UserModeTime: "20000",
          WorkingSetSize: "1000",
        },
        {
          ProcessId: 101,
          ParentProcessId: 100,
          KernelModeTime: "30000",
          UserModeTime: "40000",
          WorkingSetSize: "2000",
        },
      ]),
    });

    expect(readProcessTreeCpuMs(100)).toBe(10);
    expect(readProcessTreeCpuMs(101)).toBe(7);
    expect(readProcessTreeRssBytes(100)).toBe(3_000);
    expect(readProcessTreeRssBytes(101)).toBe(2_000);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(
      path.win32.join("D:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    expect(spawnSyncMock.mock.calls[0]?.[2]).toEqual({
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  });

  it("rejects non-decimal Windows process counters", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        ProcessId: 100,
        ParentProcessId: 50,
        KernelModeTime: "0x10",
        UserModeTime: "30000",
        WorkingSetSize: "0x1000",
      }),
    });

    expect(readProcessTreeCpuMs(100)).toBeNull();
    expect(readProcessTreeRssBytes(100)).toBeNull();
  });

  it("skips Windows process entries with non-decimal process ids", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        ProcessId: "0x64",
        ParentProcessId: 50,
        KernelModeTime: "10000",
        UserModeTime: "20000",
        WorkingSetSize: "1000",
      }),
    });

    expect(readProcessTreeCpuMs(100)).toBeNull();
    expect(readProcessTreeRssBytes(100)).toBeNull();
  });

  it("rejects malformed Windows process snapshots", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "not json",
    });

    expect(readProcessTreeCpuMs(100)).toBeNull();
    expect(readProcessTreeRssBytes(100)).toBeNull();
  });
});
