import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observePostCoreCommand } from "../../scripts/e2e/lib/plugin-update/process-observer.mjs";

const argv = "node\0entry.js\0update\0--json\0";
const marker = "OPENCLAW_UPDATE_POST_CORE=1\0";
const procError = (code: string) => Object.assign(new Error(`proc read: ${code}`), { code });

describe("plugin update command observation", () => {
  let files: Map<string, string | Error>;
  let child: EventEmitter & { pid: number };

  beforeEach(() => {
    vi.useFakeTimers();
    child = Object.assign(new EventEmitter(), { pid: 10 });
    files = new Map([
      ["/proc/10/task/10/children", "11 12"],
      ["/proc/11/cmdline", argv],
      ["/proc/11/environ", marker],
      ["/proc/11/task/11/children", ""],
      ["/proc/12/cmdline", argv],
      ["/proc/12/environ", marker],
      ["/proc/12/task/12/children", ""],
    ]);
    const readFile = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (!String(file).startsWith("/proc/")) {
        return readFile(file, options);
      }
      const value = files.get(String(file));
      if (value instanceof Error) {
        throw value;
      }
      if (value === undefined) {
        throw procError("ENOENT");
      }
      return value;
    });
  });

  afterEach(() => {
    const timers = vi.getTimerCount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(timers).toBe(0);
  });

  it.each(["EACCES", "EPERM", "ENOENT", "ESRCH"])(
    "%s leaves evidence unknown and keeps scanning readable siblings and grandchildren",
    async (code) => {
      files.set("/proc/11/environ", procError(code));
      files.set("/proc/11/task/11/children", "13");
      files.set("/proc/13/cmdline", argv);
      files.set("/proc/13/environ", marker);
      const outcome = observePostCoreCommand(child, "update");
      await vi.advanceTimersByTimeAsync(20);
      child.emit("exit", 0, null);
      const result = await outcome;
      expect(result.code).toBe(0);
      expect(result.children).toEqual([
        { pid: "11", argv: argv.split("\0").filter(Boolean), postCore: null },
        { pid: "13", argv: argv.split("\0").filter(Boolean), postCore: true },
        { pid: "12", argv: argv.split("\0").filter(Boolean), postCore: true },
      ]);
    },
  );

  it.each(["cmdline", "environ", "task/11/children"])(
    "does not manufacture positive handoff evidence when %s is inaccessible",
    async (file) => {
      files.set("/proc/10/task/10/children", "11");
      files.set("/proc/11/environ", "OPENCLAW_UPDATE_POST_CORE=0\0");
      files.set(`/proc/11/${file}`, procError("EACCES"));
      const outcome = observePostCoreCommand(child, "update");
      await vi.advanceTimersByTimeAsync(20);
      child.emit("exit", 0, null);
      expect((await outcome).children.some((entry) => entry.postCore)).toBe(false);
    },
  );

  it("retains positive evidence and argv after process.title changes and the process exits", async () => {
    const outcome = observePostCoreCommand(child, "update");
    await vi.advanceTimersByTimeAsync(20);
    files.set("/proc/11/cmdline", "openclaw-update\0");
    files.set("/proc/11/environ", procError("EACCES"));
    files.set("/proc/12/cmdline", procError("ESRCH"));
    await vi.advanceTimersByTimeAsync(20);
    files.set("/proc/10/task/10/children", "");
    await vi.advanceTimersByTimeAsync(20);
    child.emit("exit", 7, null);
    const result = await outcome;
    expect(result.code).toBe(7);
    expect(result.children).toEqual(
      ["11", "12"].map((pid) => ({ pid, argv: argv.split("\0").filter(Boolean), postCore: true })),
    );
  });

  it("joins unexpected observer failure with command exit instead of throwing from the timer", async () => {
    const failure = procError("EIO");
    files.set("/proc/11/environ", failure);
    const outcome = observePostCoreCommand(child, "update-denied");
    const rejected = expect(outcome).rejects.toMatchObject({
      message: "update-denied observation failed after command exit 7 (null)",
      cause: failure,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(child.listenerCount("exit")).toBe(1);
    child.emit("exit", 7, null);
    await rejected;
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("cleans up observation when command spawning fails", async () => {
    const failure = procError("ENOENT");
    const outcome = observePostCoreCommand(child, "update");
    const rejected = expect(outcome).rejects.toBe(failure);
    child.emit("error", failure);
    await rejected;
    expect(child.listenerCount("exit")).toBe(0);
  });
});
