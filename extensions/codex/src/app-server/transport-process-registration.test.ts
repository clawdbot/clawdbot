import { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminateCodexAppServerOrphan } from "./transport-process-containment.js";
import {
  createCodexAppServerProcessReaperService,
  prepareCodexAppServerProcessRegistration,
} from "./transport-process-registration.js";
import {
  readCodexAppServerProcess,
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
  type PosixProcess,
} from "./transport-process-snapshot.js";

vi.mock("./transport-process-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport-process-snapshot.js")>()),
  readCodexAppServerProcessSnapshot: vi.fn(),
  readCodexAppServerProcess: vi.fn(),
  readCodexAppServerProcessCommand: vi.fn(),
}));

vi.mock("./transport-process-containment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport-process-containment.js")>()),
  terminateCodexAppServerOrphan: vi.fn(),
}));

const observer: PosixProcess = {
  pid: process.pid,
  ppid: process.ppid,
  pgid: process.pid,
  state: "S",
  startedAt: "Sat Aug 29 10:00:00 2026",
};
const parent = { pid: process.pid + 1, pgid: process.pid + 1, startedAt: observer.startedAt };
const child = { pid: process.pid + 2, pgid: process.pid + 2, startedAt: observer.startedAt };
const liveChild: PosixProcess = { ...child, ppid: 1, state: "S" };
const command = "/opt/codex app-server --listen stdio://";

async function openStore() {
  const { createPluginStateSyncKeyedStore } =
    await import("openclaw/plugin-sdk/plugin-state-store-runtime");
  return createPluginStateSyncKeyedStore<{
    parent: typeof parent;
    child: typeof child & { command?: string };
  }>("codex", {
    namespace: "app-server-processes",
    maxEntries: 512,
    overflowPolicy: "reject-new",
  });
}

describe("Codex process registration", () => {
  let root: string;
  let store: Awaited<ReturnType<typeof openStore>>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-process-registration-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    store = await openStore();
    vi.mocked(readCodexAppServerProcessSnapshot).mockResolvedValue([
      observer,
      { ...parent, ppid: 1, state: "Z" },
      liveChild,
    ]);
    vi.mocked(readCodexAppServerProcessCommand).mockResolvedValue(command);
    vi.mocked(terminateCodexAppServerOrphan).mockResolvedValue(true);
  });

  afterEach(async () => {
    store.clear();
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("never kills a same-second replacement process running a different command", async () => {
    store.register("orphan", { parent, child: { ...child, command } });
    vi.mocked(readCodexAppServerProcessCommand).mockResolvedValue("/usr/bin/unrelated-worker");

    await expect(prepareCodexAppServerProcessRegistration()).resolves.toBeTypeOf("function");

    expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
    expect(store.lookup("orphan")).toBeUndefined();
  });

  it.for(["legacy", "matching command"])("reaps a %s registration", async (mode) => {
    const registeredChild = mode === "legacy" ? child : { ...child, command };
    store.register("orphan", { parent, child: registeredChild });

    await expect(prepareCodexAppServerProcessRegistration()).resolves.toBeTypeOf("function");

    expect(terminateCodexAppServerOrphan).toHaveBeenCalledExactlyOnceWith(registeredChild);
    expect(store.lookup("orphan")).toBeUndefined();
    expect(readCodexAppServerProcessCommand).toHaveBeenCalledTimes(mode === "legacy" ? 0 : 1);
  });

  it.for(["gone", "replaced"])(
    "lets containment settle a %s child after command inspection fails",
    async (mode) => {
      store.register("orphan", { parent, child: { ...child, command } });
      vi.mocked(readCodexAppServerProcessCommand).mockResolvedValue(undefined);
      vi.mocked(readCodexAppServerProcess).mockResolvedValue(
        mode === "gone" ? undefined : { ...liveChild, startedAt: "a later start" },
      );

      await expect(prepareCodexAppServerProcessRegistration()).resolves.toBeTypeOf("function");

      expect(terminateCodexAppServerOrphan).toHaveBeenCalledExactlyOnceWith({ ...child, command });
      expect(store.lookup("orphan")).toBeUndefined();
    },
  );

  it("refuses a spawn and retains the row when the matching child's command is unreadable", async () => {
    const registration = { parent, child: { ...child, command } };
    store.register("orphan", registration);
    vi.mocked(readCodexAppServerProcessCommand).mockResolvedValue(undefined);
    vi.mocked(readCodexAppServerProcess).mockResolvedValue(liveChild);

    await expect(prepareCodexAppServerProcessRegistration()).rejects.toThrow(
      `Cannot inspect registered Codex process ${child.pid} command. Check process command inspection permissions (/proc on Linux, ps on macOS), then retry.`,
    );

    expect(store.lookup("orphan")).toEqual(registration);
    expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
  });

  it.for(["gone", "zombie", "replaced"])(
    "skips command inspection when the snapshot child is %s",
    async (mode) => {
      store.register("orphan", { parent, child: { ...child, command } });
      vi.mocked(readCodexAppServerProcessSnapshot).mockResolvedValue([
        observer,
        ...(mode === "gone"
          ? []
          : [{ ...liveChild, ...(mode === "zombie" ? { state: "Z" } : { startedAt: "later" }) }]),
      ]);

      await prepareCodexAppServerProcessRegistration();

      expect(readCodexAppServerProcessCommand).not.toHaveBeenCalled();
      expect(terminateCodexAppServerOrphan).toHaveBeenCalledOnce();
      expect(store.lookup("orphan")).toBeUndefined();
    },
  );

  it("leaves a live parent's child registered without inspecting its command", async () => {
    const registration = { parent, child: { ...child, command } };
    store.register("owned", registration);
    vi.mocked(readCodexAppServerProcessSnapshot).mockResolvedValue([
      observer,
      { ...parent, ppid: 1, state: "S" },
      liveChild,
    ]);

    await prepareCodexAppServerProcessRegistration();

    expect(readCodexAppServerProcessCommand).not.toHaveBeenCalled();
    expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
    expect(store.lookup("owned")).toEqual(registration);
  });

  it.for(["live", "unreadable command", "exited during inspection"])(
    "registers only a live child with its command: %s",
    async (mode, ctx) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      // The typed stdio tuple makes this fixture structurally a
      // ChildProcessWithoutNullStreams without widening casts.
      const spawned = Object.assign(new ChildProcess(), {
        pid: child.pid,
        stdin,
        stdout,
        stderr,
        stdio: [stdin, stdout, stderr, null, null] as [
          PassThrough,
          PassThrough,
          PassThrough,
          null,
          null,
        ],
      });
      ctx.onTestFinished(() => {
        spawned.stdin.destroy();
        spawned.stdout.destroy();
        spawned.stderr.destroy();
        spawned.removeAllListeners();
      });
      const kill = vi.spyOn(spawned, "kill").mockReturnValue(true);
      vi.mocked(readCodexAppServerProcessSnapshot).mockResolvedValue([
        observer,
        { ...liveChild, ppid: process.pid },
      ]);
      vi.mocked(readCodexAppServerProcessCommand).mockImplementation(async () => {
        if (mode === "exited during inspection") {
          Object.defineProperty(spawned, "exitCode", { value: 0, configurable: true });
          spawned.emit("exit", 0, null);
        }
        return mode === "unreadable command" ? undefined : command;
      });
      const register = await prepareCodexAppServerProcessRegistration();
      const registered = register(spawned);
      spawned.emit("spawn");

      if (mode === "live") {
        await registered;
        expect(store.entries().map((entry) => entry.value)).toEqual([
          {
            parent: { pid: observer.pid, pgid: observer.pgid, startedAt: observer.startedAt },
            child: { ...child, command },
          },
        ]);
        expect(kill).not.toHaveBeenCalled();
        spawned.emit("exit", 0, null);
        expect(store.entries()).toEqual([]);
      } else {
        await expect(registered).rejects.toThrow("Cannot register the Codex child process command");
        expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
        expect(
          [spawned.stdin, spawned.stdout, spawned.stderr].every((stream) => stream.destroyed),
        ).toBe(true);
        expect(store.entries()).toEqual([]);
      }
    },
  );

  it.for(["success", "failure", "win32"])(
    "starts a nonblocking best-effort boot sweep: %s",
    async (mode) => {
      store.register("orphan", { parent, child: { ...child, command } });
      const warn = vi.fn();
      const service = createCodexAppServerProcessReaperService();
      const sweep = createDeferred<boolean>();
      vi.mocked(terminateCodexAppServerOrphan).mockReturnValue(sweep.promise);
      if (mode === "win32") {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      }

      expect(
        service.start({
          config: {},
          stateDir: root,
          logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
        }),
      ).toBeUndefined();

      if (mode === "win32") {
        expect(readCodexAppServerProcessSnapshot).not.toHaveBeenCalled();
        expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
        expect(store.lookup("orphan")).toBeDefined();
        expect(warn).not.toHaveBeenCalled();
        return;
      }
      await expect.poll(() => vi.mocked(terminateCodexAppServerOrphan).mock.calls.length).toBe(1);
      if (mode === "failure") {
        sweep.reject(new Error("inspection unavailable"));
        await expect
          .poll(() => warn.mock.calls)
          .toEqual([["Codex app-server orphan cleanup failed: Error: inspection unavailable"]]);
        expect(store.lookup("orphan")).toBeDefined();
      } else {
        sweep.resolve(true);
        await expect.poll(() => store.lookup("orphan")).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );
});
