import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVitestProcessCompletion,
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  parseVitestProcessGroupMembers,
  resolveVitestProcessGroupSignalTarget,
  shouldUseDetachedVitestProcessGroup,
} from "../../scripts/vitest-process-group.mts";

describe("vitest process group helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function procStat(pid: number, state: string, ppid: number, pgid: number, comm = "node") {
    return `${pid} (${comm}) ${state} ${ppid} ${pgid} 0`;
  }

  function mockLinuxProc(
    pids: string[],
    stats: Record<string, string | NodeJS.ErrnoException>,
    listError?: NodeJS.ErrnoException,
    mounts: string | NodeJS.ErrnoException = "proc /proc proc rw 0 0\n",
    taskLists: Record<string, (string[] | NodeJS.ErrnoException)[]> = {},
  ) {
    const taskReads = new Map<string, number>();
    vi.spyOn(fs, "readdirSync").mockImplementation((path) => {
      if (String(path) === "/proc") {
        if (listError) {
          throw listError;
        }
        return pids as never;
      }
      const pid = /^\/proc\/(\d+)\/task$/.exec(String(path))?.[1] ?? "";
      const lists = taskLists[pid] ?? [[pid]];
      const index = taskReads.get(pid) ?? 0;
      taskReads.set(pid, index + 1);
      const result = lists[Math.min(index, lists.length - 1)];
      if (result instanceof Error) {
        throw result;
      }
      return result as never;
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((file) => {
      if (String(file) === "/proc/self/mounts") {
        if (mounts instanceof Error) {
          throw mounts;
        }
        return mounts;
      }
      const task = /^\/proc\/(\d+)\/task\/(\d+)\/stat$/.exec(String(file));
      const pid = /^\/proc\/(\d+)\/stat$/.exec(String(file))?.[1] ?? "";
      const taskStat = task ? stats[`${task[1]}/${task[2]}`] : undefined;
      const stat = taskStat ?? stats[task && task[1] === task[2] ? task[1]! : pid];
      if (stat instanceof Error) {
        throw stat;
      }
      if (typeof stat !== "string") {
        throw new Error(`missing mocked stat for ${pid}`);
      }
      return stat;
    });
  }

  function startLinuxCompletion(
    pid = 4200,
    kill: (pid: number, signal?: NodeJS.Signals | 0) => boolean = vi.fn(() => true),
  ) {
    const child = Object.assign(new EventEmitter(), { pid });
    const completion = createVitestProcessCompletion({
      child: child as never,
      detached: true,
      platform: "linux",
      kill,
    });
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    return { completion, kill };
  }

  function getListenerSet(listeners: Map<string, Set<() => void>>, event: string) {
    const set = listeners.get(event);
    if (!set) {
      throw new Error(`expected ${event} listener set`);
    }
    return set;
  }

  function expectListenerCount(
    listeners: Map<string, Set<() => void>>,
    event: string,
    count: number,
  ) {
    expect(getListenerSet(listeners, event).size).toBe(count);
  }

  it("uses detached process groups on non-Windows hosts", () => {
    expect(shouldUseDetachedVitestProcessGroup("darwin")).toBe(true);
    expect(shouldUseDetachedVitestProcessGroup("linux")).toBe(true);
    expect(shouldUseDetachedVitestProcessGroup("win32")).toBe(false);
  });

  it("targets the process group on Unix and the direct pid on Windows", () => {
    expect(resolveVitestProcessGroupSignalTarget({ childPid: 4200, platform: "darwin" })).toBe(
      -4200,
    );
    expect(resolveVitestProcessGroupSignalTarget({ childPid: 4200, platform: "win32" })).toBe(4200);
    expect(resolveVitestProcessGroupSignalTarget({ childPid: undefined, platform: "darwin" })).toBe(
      null,
    );
  });

  it("formats bounded process-group diagnostics without command arguments", () => {
    expect(
      parseVitestProcessGroupMembers(
        [" 116 1 116 Z node", " 117 1 116 Sl claude", " 118 1 999 S unrelated"].join("\n"),
        116,
      ),
    ).toBe("pid=116 ppid=1 state=Z comm=node; pid=117 ppid=1 state=Sl comm=claude");
  });

  it.each(["rw", "rw,hidepid=0", "rw,hidepid=off"])(
    "accepts a complete zombie-only Linux process group with proc options %s",
    async (mountOptions) => {
      mockLinuxProc(
        ["4200"],
        {
          "4200": procStat(4200, "Z", 1, 4200, "node (vitest)"),
          "4200/4200": procStat(4200, "Z", 1, 4200, "node (vitest)"),
          "4200/4201": procStat(4201, "X", 1, 4200, "worker"),
        },
        undefined,
        `proc /proc proc ${mountOptions} 0 0\n`,
        { "4200": [["4201", "4200"]] },
      );

      const { completion } = startLinuxCompletion();

      await expect(completion).resolves.toEqual({ code: 0, signal: null });
    },
  );

  const missingTask = Object.assign(new Error("gone"), { code: "ENOENT" });
  const taskCases: [
    string,
    (string[] | NodeJS.ErrnoException)[],
    string | NodeJS.ErrnoException | undefined,
    string | undefined,
  ][] = [
    ["runnable worker", [["4200", "4201"]], procStat(4201, "S", 1, 4200), "tid=4201"],
    ["mismatched TID", [["4200", "4201"]], procStat(4202, "Z", 1, 4200), "unavailable"],
    ["mismatched PGID", [["4200", "4201"]], procStat(4201, "Z", 1, 999), "unavailable"],
    [
      "inaccessible task dir",
      [Object.assign(new Error("denied"), { code: "EACCES" })],
      undefined,
      "unavailable",
    ],
    ["empty task dir", [[]], undefined, "unavailable"],
    ["non-numeric task dir", [["4200", "worker"]], undefined, "unavailable"],
    ["missing task dir with leader", [missingTask], undefined, "unavailable"],
    ["disappeared TID", [["4200", "4201"], ["4200"]], missingTask, undefined],
    ["still-present TID", [["4200", "4201"]], missingTask, "unavailable"],
    ["new TID", [["4200"], ["4200", "4201"]], missingTask, "unavailable"],
  ];

  it.each(taskCases)("handles a %s fail-closed", async (_label, taskLists, workerStat, failure) => {
    if (failure) {
      vi.useFakeTimers();
    }
    mockLinuxProc(
      ["4200"],
      {
        "4200": procStat(4200, "Z", 1, 4200),
        "4200/4200": procStat(4200, "Z", 1, 4200),
        ...(workerStat ? { "4200/4201": workerStat } : {}),
      },
      undefined,
      undefined,
      { "4200": taskLists },
    );
    const completion = startLinuxCompletion().completion;
    if (!failure) {
      await expect(completion).resolves.toEqual({ code: 0, signal: null });
      return;
    }
    const rejected = expect(completion).rejects.toThrow(failure);

    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });

  it.each([
    ["hidepid=2", "proc /proc proc rw,hidepid=2 0 0\n"],
    ["hidepid=invisible", "proc /proc proc rw,hidepid=invisible 0 0\n"],
    ["hidepid=4", "proc /proc proc rw,hidepid=4 0 0\n"],
    ["pid namespace", "proc /proc proc rw,pidns=host 0 0\n"],
    ["missing proc mount", "tmpfs /tmp tmpfs rw 0 0\n"],
    ["unreadable mounts", Object.assign(new Error("denied"), { code: "EACCES" })],
  ])("fails closed before PID scans for %s", async (_label, mounts) => {
    vi.useFakeTimers();
    mockLinuxProc(["4200"], { "4200": procStat(4200, "Z", 1, 4200) }, undefined, mounts);
    const rejected = expect(startLinuxCompletion().completion).rejects.toThrow(
      "members: unavailable",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it.each([
    ["already gone", 0],
    ["gone during deadline inspection", 2],
  ])("accepts a Linux process group that is %s", async (_label, scansBeforeGone) => {
    if (scansBeforeGone > 0) {
      vi.useFakeTimers();
    }
    mockLinuxProc([], {});
    const missing = Object.assign(new Error("gone"), { code: "ESRCH" });
    const kill = vi.fn((_target: number, signal?: NodeJS.Signals | 0) => {
      const scans = vi
        .mocked(fs.readdirSync)
        .mock.calls.filter(([path]) => String(path) === "/proc").length;
      if (signal === 0 && scans >= scansBeforeGone) {
        throw missing;
      }
      return true;
    });

    const { completion } = startLinuxCompletion(4200, kill);
    const settled = expect(completion).resolves.toEqual({ code: 0, signal: null });

    if (scansBeforeGone > 0) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await settled;
    expect(
      vi.mocked(fs.readdirSync).mock.calls.filter(([path]) => String(path) === "/proc"),
    ).toHaveLength(scansBeforeGone);
  });

  it("skips ENOENT races and accepts PID/PGID 1 with PPID 0", async () => {
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    mockLinuxProc(["2", "1"], {
      "1": procStat(1, "Z", 0, 1, "init"),
      "2": missing,
    });

    const { completion } = startLinuxCompletion(1);

    await expect(completion).resolves.toEqual({ code: 0, signal: null });
  });

  it.each([
    ["an empty snapshot", [], {}, undefined],
    ["a runnable member", ["4200"], { "4200": procStat(4200, "S", 1, 4200) }, undefined],
    ["a malformed stat", ["4200"], { "4200": "malformed" }, undefined],
    ["a mismatched stat PID", ["4200"], { "4200": procStat(4201, "Z", 1, 4200) }, undefined],
    [
      "a non-ENOENT read failure",
      ["4200"],
      { "4200": Object.assign(new Error("denied"), { code: "EACCES" }) },
      undefined,
    ],
    ["unavailable proc", [], {}, Object.assign(new Error("missing"), { code: "EACCES" })],
  ])("fails closed for %s", async (_label, pids, stats, listError) => {
    vi.useFakeTimers();
    mockLinuxProc(pids, stats, listError);
    const { completion } = startLinuxCompletion();
    const rejected = expect(completion).rejects.toThrow("process group 4200 remained alive 1000ms");

    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });

  it("sorts and bounds sanitized Linux process-group diagnostics", async () => {
    vi.useFakeTimers();
    const pids = Array.from({ length: 22 }, (_, index) => String(4200 + index)).toReversed();
    const comm = `bad\n\t${"x".repeat(100)}`;
    mockLinuxProc(
      pids,
      Object.fromEntries(pids.map((pid) => [pid, procStat(Number(pid), "S", 1, 4200, comm)])),
    );
    const { completion } = startLinuxCompletion();
    const error = await (async () => {
      const rejected = completion.catch((failure: unknown) => failure);
      await vi.advanceTimersByTimeAsync(1_000);
      return rejected;
    })();

    const message = (error as Error).message;
    expect(message.indexOf("pid=4200")).toBeLessThan(message.indexOf("pid=4201"));
    expect(message).toContain("pid=4219");
    expect(message).not.toContain("pid=4220");
    expect(message).toContain(`comm=bad ${"x".repeat(76)}`);
    expect(message).not.toContain("\n");
  });

  it("forwards signals to the computed target and ignores cleanup races", () => {
    const kill = vi.fn();
    expect(
      forwardSignalToVitestProcessGroup({
        child: { pid: 4200 },
        signal: "SIGTERM",
        platform: "darwin",
        kill,
      }),
    ).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4200, "SIGTERM");

    kill.mockImplementationOnce(() => {
      const error = new Error("gone") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    expect(
      forwardSignalToVitestProcessGroup({
        child: { pid: 4200 },
        signal: "SIGTERM",
        platform: "darwin",
        kill,
      }),
    ).toBe(false);

    kill.mockImplementationOnce(() => {
      const error = new Error("permission race") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    expect(
      forwardSignalToVitestProcessGroup({
        child: { pid: 4200 },
        signal: "SIGTERM",
        platform: "darwin",
        kill,
      }),
    ).toBe(false);
  });

  it.each([
    ["Windows", { detached: true, platform: "win32" as const }],
    ["non-detached POSIX", { detached: false, platform: "darwin" as const }],
  ])("keeps %s completion on direct-child exit", async (_label, params) => {
    const child = Object.assign(new EventEmitter(), { pid: 4200 });
    const kill = vi.fn(() => true as const);
    const completion = createVitestProcessCompletion({
      child: child as never,
      kill,
      ...params,
    });

    child.emit("exit", 0, null);

    await expect(completion).resolves.toEqual({ code: 0, signal: null });
    expect(kill).not.toHaveBeenCalled();
  });

  it("installs and removes process cleanup listeners", () => {
    const listeners = new Map<string, Set<() => void>>();
    const fakeProcess = {
      on(event: string, handler: () => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
      },
      off(event: string, handler: () => void) {
        listeners.get(event)?.delete(handler);
      },
    };
    const kill = vi.fn();
    const onSignal = vi.fn();
    const teardown = installVitestProcessGroupCleanup({
      child: { pid: 4200 },
      processObject: fakeProcess as unknown as NodeJS.Process,
      platform: "darwin",
      kill,
      onSignal,
    });

    expectListenerCount(listeners, "SIGINT", 1);
    expectListenerCount(listeners, "SIGTERM", 1);
    expectListenerCount(listeners, "exit", 1);

    getListenerSet(listeners, "SIGTERM").values().next().value!();
    expect(onSignal).toHaveBeenCalledWith("SIGTERM");
    expect(kill).toHaveBeenCalledWith(-4200, "SIGTERM");

    teardown();
    expectListenerCount(listeners, "SIGINT", 0);
    expectListenerCount(listeners, "SIGTERM", 0);
    expectListenerCount(listeners, "exit", 0);
  });

  it("can force-kill process groups after forwarded parent signals", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const fakeProcess = {
      on(event: string, handler: () => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
      },
      off(event: string, handler: () => void) {
        listeners.get(event)?.delete(handler);
      },
    };
    const kill = vi.fn();
    const teardown = installVitestProcessGroupCleanup({
      child: { pid: 4200 },
      forceSignal: "SIGKILL",
      processObject: fakeProcess as unknown as NodeJS.Process,
      platform: "darwin",
      kill,
    });

    getListenerSet(listeners, "SIGTERM").values().next().value!();
    await Promise.resolve();

    expect(kill).toHaveBeenNthCalledWith(1, -4200, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, -4200, "SIGKILL");

    teardown();
  });

  it("raises process listener limits for highly parallel cleanup handlers", () => {
    const listeners = new Map<string, Set<() => void>>();
    let maxListeners = 10;
    const fakeProcess = {
      getMaxListeners: () => maxListeners,
      setMaxListeners: vi.fn((value: number) => {
        maxListeners = value;
        return fakeProcess;
      }),
      listenerCount(event: string) {
        return listeners.get(event)?.size ?? 0;
      },
      on(event: string, handler: () => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
      },
      off(event: string, handler: () => void) {
        listeners.get(event)?.delete(handler);
      },
    };

    const teardowns = Array.from({ length: 12 }, (_, index) =>
      installVitestProcessGroupCleanup({
        child: { pid: 4200 + index },
        processObject: fakeProcess as unknown as NodeJS.Process,
        platform: "darwin",
        kill: vi.fn(),
      }),
    );

    expect(maxListeners).toBeGreaterThan(10);
    expect(fakeProcess.setMaxListeners).toHaveBeenCalled();

    for (const teardown of teardowns) {
      teardown();
    }
    expectListenerCount(listeners, "SIGINT", 0);
    expectListenerCount(listeners, "SIGTERM", 0);
    expectListenerCount(listeners, "exit", 0);
  });
});
