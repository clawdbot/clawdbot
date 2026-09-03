import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectLinuxProcessGroup,
  isQaPosixProcessGroupAlive,
  signalQaPosixProcessGroup,
} from "./posix-process-group.js";
import { inspectLinuxProcessGroupStats } from "./posix-process-stat.js";

const procFs = vi.hoisted(() => ({ readFileSync: vi.fn(), readdirSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: procFs.readFileSync.mockImplementation(actual.readFileSync),
    readdirSync: procFs.readdirSync.mockImplementation(actual.readdirSync),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POSIX process group inspection", () => {
  it("treats Linux zombie and dead members as stopped", () => {
    expect(
      inspectLinuxProcessGroupStats(123, [
        "123 (leader) Z 1 123 123 0 -1 0",
        "124 (helper (worker)) X 1 123 123 0 -1 0",
        "125 (unrelated) S 1 999 999 0 -1 0",
      ]),
    ).toEqual({
      alive: false,
      diagnostics:
        'pgid=123 members=[pid=123 state=Z command="leader", pid=124 state=X command="helper (worker)"]',
    });
  });

  it("treats runnable members as alive and empty snapshots as unknown", () => {
    expect(
      inspectLinuxProcessGroupStats(123, [
        "123 (leader) Z 1 123 123 0 -1 0",
        "124 (worker) D 1 123 123 0 -1 0",
      ]).alive,
    ).toBe(true);
    expect(inspectLinuxProcessGroupStats(123, ["125 (other) S 1 999 999 0 -1 0"])).toEqual({
      alive: null,
      diagnostics: "pgid=123 members=[]",
    });
  });

  it("bounds process group diagnostics", () => {
    const stats = Array.from(
      { length: 300 },
      (_, index) => `${index + 1} (${`worker-${index}`.padEnd(32, "x")}) S 1 123 123 0 -1 0`,
    );

    const inspection = inspectLinuxProcessGroupStats(123, stats);

    expect(inspection.alive).toBe(true);
    expect(inspection.diagnostics.length).toBeLessThanOrEqual(2_048);
    expect(inspection.diagnostics).toMatch(/\.\.\.$/u);
  });

  it.each(["ENOENT", "ESRCH", "EACCES"])(
    "distinguishes a vanished /proc member from unreadable state (%s)",
    (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      procFs.readdirSync.mockReturnValueOnce([
        { name: "123", isDirectory: () => true },
        { name: "999", isDirectory: () => true },
      ]);
      procFs.readFileSync
        .mockReturnValueOnce("123 (leader) Z 1 123 123 0 -1 0")
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("stat read failed"), { code });
        });

      const inspection = inspectLinuxProcessGroup(123);
      if (code === "EACCES") {
        expect(inspection).toBeNull();
      } else {
        expect(inspection?.alive).toBe(false);
      }
    },
  );

  it.each(["empty", "unavailable"])(
    "confirms a group reaped during an %s Linux snapshot is stopped",
    (snapshot) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      let reaped = false;
      vi.spyOn(process, "kill").mockImplementation(() => {
        if (reaped) {
          throw Object.assign(new Error("group reaped"), { code: "ESRCH" });
        }
        return true;
      });

      expect(
        isQaPosixProcessGroupAlive(123, () => {
          reaped = true;
          return snapshot === "empty" ? inspectLinuxProcessGroupStats(123, []) : null;
        }),
      ).toBe(false);
    },
  );

  it("fails closed when the Linux member snapshot is unavailable", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(isQaPosixProcessGroupAlive(123, () => null)).toBe(true);
      expect(processKill).toHaveBeenCalledWith(-123, 0);
    } finally {
      platform.mockRestore();
    }
  });

  it("treats a kill-visible Linux group with only zombie members as stopped", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(
        isQaPosixProcessGroupAlive(123, () => ({
          alive: false,
          diagnostics: 'pgid=123 members=[pid=123 state=Z command="leader"]',
        })),
      ).toBe(false);
      expect(processKill).toHaveBeenCalledWith(-123, 0);
    } finally {
      platform.mockRestore();
    }
  });

  it("stops on ESRCH and never falls back to a positive pid", () => {
    const processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-123);
      if (signal === 0) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });

    expect(isQaPosixProcessGroupAlive(123)).toBe(false);
    expect(signalQaPosixProcessGroup(123, "SIGTERM")).toBeUndefined();
    expect(processKill).not.toHaveBeenCalledWith(123, expect.anything());
  });

  it.each(["ESRCH", "EPERM"])("preserves the group signal contract on %s", (code) => {
    const failure = Object.assign(new Error("group signal failed"), { code });
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw failure;
    });

    expect(signalQaPosixProcessGroup(123, "SIGKILL")).toBe(code === "ESRCH" ? undefined : failure);
    expect(processKill.mock.calls).toEqual([[-123, "SIGKILL"]]);
  });
});
