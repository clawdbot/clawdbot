import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWindowsPowerShellExePath, getWindowsWmicExePath } from "./windows-install-roots.js";
import { readWindowsProcessStartTimeSync } from "./windows-process-start.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

describe("readWindowsProcessStartTimeSync", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("reads an ISO creation time through PowerShell", () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: "2026-07-13T07:20:49.1234567Z",
    } as never);

    expect(readWindowsProcessStartTimeSync(123, 1000)).toBe(Date.parse("2026-07-13T07:20:49.123Z"));
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(getWindowsPowerShellExePath());
  });

  it("falls back to WMIC DMTF creation time output", () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "" } as never).mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
    } as never);

    expect(readWindowsProcessStartTimeSync(456, 1000)).toBe(Date.parse("2026-07-13T07:20:49.123Z"));
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe(getWindowsWmicExePath());
  });

  it("projects supplied native context with Windows key precedence for both queries", () => {
    const env = {
      SYSTEMROOT: "D:\\Native",
      SystemRoot: "E:\\Ignored",
      WINDIR: "F:\\Ignored",
      PATH: "native-path",
      PSModuleAnalysisCachePath: "D:\\NativeCache",
      DIAGNOSTIC_NEUTRAL_CANARY: "synthetic",
      NODE_OPTIONS: "--synthetic-injection-must-not-be-inherited",
    };
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "" }).mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
    });
    expect(readWindowsProcessStartTimeSync(456, 1000, env)).toBe(
      Date.parse("2026-07-13T07:20:49.123Z"),
    );
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(
      "D:\\Native\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe("D:\\Native\\System32\\wbem\\wmic.exe");
    for (const call of spawnSyncMock.mock.calls) {
      expect(call[2].env).toEqual({
        SYSTEMROOT: "D:\\Native",
        WINDIR: "F:\\Ignored",
        PATH: "native-path",
        PSModuleAnalysisCachePath: "D:\\NativeCache",
      });
      expect(call[2].timeout).toBeLessThanOrEqual(1000);
    }
    expect(env.SystemRoot).toBe("E:\\Ignored");
    expect(env.DIAGNOSTIC_NEUTRAL_CANARY).toBe("synthetic");
  });

  it("does not start WMIC once PowerShell has spent the whole budget", () => {
    vi.useFakeTimers();
    try {
      spawnSyncMock.mockImplementationOnce(() => {
        vi.advanceTimersByTime(1000);
        return { status: 1, stdout: "" };
      });

      expect(readWindowsProcessStartTimeSync(321, 1000)).toBeNull();
      // A second full-budget probe here would block a synchronous caller for
      // twice the timeout it asked for before returning this same null.
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives WMIC only the time left on the caller's budget", () => {
    vi.useFakeTimers();
    try {
      spawnSyncMock
        .mockImplementationOnce(() => {
          vi.advanceTimersByTime(600);
          return { status: 1, stdout: "" };
        })
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
        } as never);

      expect(readWindowsProcessStartTimeSync(654, 1000)).toBe(
        Date.parse("2026-07-13T07:20:49.123Z"),
      );
      expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 400 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the default WMIC fallback after PowerShell spends five seconds", () => {
    vi.useFakeTimers();
    try {
      spawnSyncMock
        .mockImplementationOnce(() => {
          vi.advanceTimersByTime(5000);
          return { status: 1, stdout: "" };
        })
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
        } as never);

      expect(readWindowsProcessStartTimeSync(987)).toBe(Date.parse("2026-07-13T07:20:49.123Z"));
      expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000 });
      expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 5000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when process creation time is unavailable", () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: Buffer.alloc(0) } as never);

    expect(readWindowsProcessStartTimeSync(789, 1000)).toBeNull();
    expect(readWindowsProcessStartTimeSync(0, 1000)).toBeNull();
  });
});
