import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWindowsPowerShellExePath, getWindowsWmicExePath } from "./windows-install-roots.js";
import { readWindowsProcessStartTimeSync } from "./windows-port-pids.js";

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

  it("treats timezone-less PowerShell ISO creation time as UTC", () => {
    const originalTimeZone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      spawnSyncMock.mockReturnValueOnce({
        status: 0,
        stdout: "2026-07-06T12:34:56.1234567",
      } as never);

      expect(readWindowsProcessStartTimeSync(456, 1000)).toBe(
        Date.parse("2026-07-06T12:34:56.123Z"),
      );
    } finally {
      process.env.TZ = originalTimeZone;
    }
  });

  it("falls back to WMIC DMTF creation time output", () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "" } as never).mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
    } as never);

    expect(readWindowsProcessStartTimeSync(456, 1000)).toBe(Date.parse("2026-07-13T07:20:49.123Z"));
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe(getWindowsWmicExePath());
  });

  it("returns null when process creation time is unavailable", () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: Buffer.alloc(0) } as never);

    expect(readWindowsProcessStartTimeSync(789, 1000)).toBeNull();
    expect(readWindowsProcessStartTimeSync(0, 1000)).toBeNull();
  });
});
