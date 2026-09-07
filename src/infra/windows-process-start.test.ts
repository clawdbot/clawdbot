import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWindowsPowerShellExePath, getWindowsWmicExePath } from "./windows-install-roots.js";
import {
  isWindowsProcessDefinitelyAbsentSync,
  readWindowsProcessStartTimeSync,
} from "./windows-process-start.js";

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

describe("isWindowsProcessDefinitelyAbsentSync", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("returns true only for an exact successful zero-row result", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "COUNT=0" } as never);
    expect(isWindowsProcessDefinitelyAbsentSync(123)).toBe(true);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      getWindowsPowerShellExePath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expect.stringMatching(
          /\$rows = @\(Get-CimInstance Win32_Process -Filter "ProcessId = 123" -ErrorAction Stop\); \[Console\]::Out\.Write\("COUNT=\$\(\$rows\.Count\)"\)/,
        ),
      ],
      expect.objectContaining({
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      }),
    );
  });

  it("projects the supplied native context into the enumeration query", () => {
    const env = {
      SYSTEMROOT: "D:\\Native",
      SystemRoot: "E:\\Ignored",
      NODE_OPTIONS: "--synthetic-injection-must-not-be-inherited",
    };
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "COUNT=0" });

    expect(isWindowsProcessDefinitelyAbsentSync(123, 2000, env)).toBe(true);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(
      "D:\\Native\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({
      env: { SYSTEMROOT: "D:\\Native" },
      timeout: 2000,
    });
    expect(spawnSyncMock.mock.calls[0]?.[2].env.SystemRoot).toBeUndefined();
    expect(spawnSyncMock.mock.calls[0]?.[2].env.NODE_OPTIONS).toBeUndefined();
    expect(env.SystemRoot).toBe("E:\\Ignored");
    expect(env.NODE_OPTIONS).toBe("--synthetic-injection-must-not-be-inherited");
  });

  it.each([
    { label: "provider failure", result: { status: 1, stdout: "" } },
    { label: "spawn failure", result: { error: new Error("spawn failed"), status: null } },
    { label: "active process", result: { status: 0, stdout: "COUNT=1" } },
    { label: "malformed output", result: { status: 0, stdout: "not-count" } },
    { label: "multiple rows", result: { status: 0, stdout: "COUNT=2" } },
    { label: "extra output", result: { status: 0, stdout: "COUNT=0\nwarning" } },
    { label: "whitespace stderr", result: { status: 0, stdout: "COUNT=0", stderr: "\n" } },
    { label: "trailing newline stdout", result: { status: 0, stdout: "COUNT=0\n" } },
    { label: "leading whitespace stdout", result: { status: 0, stdout: " COUNT=0" } },
    { label: "stderr only", result: { status: 0, stdout: "", stderr: "warning" } },
    { label: "stderr with zero rows", result: { status: 0, stdout: "COUNT=0", stderr: "warning" } },
  ])("stays fail-closed for $label", ({ result }) => {
    spawnSyncMock.mockReturnValue(result as never);
    expect(isWindowsProcessDefinitelyAbsentSync(123)).toBe(false);
  });

  it("rejects invalid PIDs without spawning PowerShell", () => {
    expect(isWindowsProcessDefinitelyAbsentSync(0)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
