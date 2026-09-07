import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import { terminateCodexAppServerOrphan } from "./transport-process-containment.js";
import {
  acquireCodexAppServerProcessRegistrationFence,
  createCodexAppServerProcessReaperService,
  prepareCodexAppServerProcessRegistration,
} from "./transport-process-registration.js";
import { RegistrationTestChildProcess } from "./transport-process-registration.test-support.js";
import {
  ProcessInspectionError,
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
  type PosixProcess,
} from "./transport-process-snapshot.js";
import { createStdioTransport } from "./transport-stdio.js";

vi.mock("./transport-process-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport-process-snapshot.js")>()),
  readCodexAppServerProcessSnapshot: vi.fn(),
  readCodexAppServerProcessCommand: vi.fn(),
}));

vi.mock("./transport-process-containment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport-process-containment.js")>()),
  terminateCodexAppServerOrphan: vi.fn(),
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
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
const commandFingerprint = createHash("sha256").update(command).digest("hex");

async function openStore() {
  const { createPluginStateSyncKeyedStore } =
    await import("openclaw/plugin-sdk/plugin-state-store-runtime");
  return createPluginStateSyncKeyedStore<{
    parent: typeof parent;
    child: typeof child & { commandFingerprint?: string };
  }>("codex", {
    namespace: "app-server-processes",
    maxEntries: 512,
    overflowPolicy: "reject-new",
  });
}

function startOptions(spawnCommand: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: spawnCommand,
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

function buildSpawnedChild(pid: number): ChildProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const spawned = Object.assign(new ChildProcess(), {
    pid,
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
  spawned.stdin.on("error", () => undefined);
  spawned.stdout.on("error", () => undefined);
  spawned.stderr.on("error", () => undefined);
  return spawned;
}

function destroySpawnedChild(spawned: ChildProcess): void {
  spawned.stdin?.destroy();
  spawned.stdout?.destroy();
  spawned.stderr?.destroy();
  spawned.removeAllListeners();
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
    store.register("orphan", { parent, child: { ...child, commandFingerprint } });
    vi.mocked(readCodexAppServerProcessCommand).mockResolvedValue("/usr/bin/unrelated-worker");

    await expect(prepareCodexAppServerProcessRegistration()).resolves.toBeTypeOf("function");

    expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
    expect(store.lookup("orphan")).toBeUndefined();
  });

  it.for(["legacy", "matching command"])("reaps a %s registration", async (mode) => {
    const registeredChild = mode === "legacy" ? child : { ...child, commandFingerprint };
    store.register("orphan", { parent, child: registeredChild });

    await expect(prepareCodexAppServerProcessRegistration()).resolves.toBeTypeOf("function");

    expect(terminateCodexAppServerOrphan).toHaveBeenCalledExactlyOnceWith(registeredChild);
    expect(store.lookup("orphan")).toBeUndefined();
    expect(readCodexAppServerProcessCommand).toHaveBeenCalledTimes(mode === "legacy" ? 0 : 1);
  });

  it.for(["gone", "replaced"])(
    "lets containment settle a %s child after command inspection fails",
    async (mode) => {
      store.register("orphan", { parent, child: { ...child, commandFingerprint } });
      vi.mocked(readCodexAppServerProcessCommand).mockRejectedValue(
        new ProcessInspectionError("permission"),
      );
      vi.mocked(readCodexAppServerProcessSnapshot)
        .mockResolvedValueOnce([observer, liveChild])
        .mockResolvedValue([
          observer,
          ...(mode === "gone" ? [] : [{ ...liveChild, startedAt: "a later start" }]),
        ]);

      await expect(prepareCodexAppServerProcessRegistration()).resolves.toBeTypeOf("function");

      expect(terminateCodexAppServerOrphan).toHaveBeenCalledExactlyOnceWith({
        ...child,
        commandFingerprint,
      });
      expect(store.lookup("orphan")).toBeUndefined();
    },
  );

  it.for(["live", "unknown", "threaded zombie"])(
    "retains an unreadable-command registration when the child is %s",
    async (mode) => {
      const registration = { parent, child: { ...child, commandFingerprint } };
      store.register("orphan", registration);
      vi.mocked(readCodexAppServerProcessCommand).mockRejectedValue(
        new ProcessInspectionError("permission"),
      );
      if (mode === "unknown") {
        vi.mocked(readCodexAppServerProcessSnapshot)
          .mockResolvedValueOnce([observer, liveChild])
          .mockRejectedValue(new ProcessInspectionError("unavailable"));
      } else if (mode === "threaded zombie") {
        vi.mocked(readCodexAppServerProcessSnapshot).mockResolvedValue([
          observer,
          { ...liveChild, state: "Zl" },
        ]);
      }

      await expect(prepareCodexAppServerProcessRegistration()).rejects.toMatchObject({
        reason: mode === "unknown" ? "unavailable" : "permission",
      });

      expect(store.lookup("orphan")).toEqual(registration);
      expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
    },
  );

  it.for(["gone", "zombie", "replaced"])(
    "skips command inspection when the snapshot child is %s",
    async (mode) => {
      store.register("orphan", { parent, child: { ...child, commandFingerprint } });
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
    const registration = { parent, child: { ...child, commandFingerprint } };
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

  it.for(["live", "unreadable command", "exited during inspection", "windows"])(
    "registers only a live child with its command: %s",
    async (mode, ctx) => {
      if (mode === "windows") {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      }
      const spawned = new RegistrationTestChildProcess(child.pid);
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
        if (mode === "unreadable command") {
          throw new ProcessInspectionError("permission");
        }
        return command;
      });
      const register = await prepareCodexAppServerProcessRegistration();
      const registered = register(spawned);
      spawned.emit("spawn");

      if (mode === "windows") {
        await registered;
        expect(readCodexAppServerProcessSnapshot).not.toHaveBeenCalled();
        expect(readCodexAppServerProcessCommand).not.toHaveBeenCalled();
        expect(store.entries()).toEqual([]);
        expect(kill).not.toHaveBeenCalled();
      } else if (mode === "live") {
        await registered;
        expect(store.entries().map((entry) => entry.value)).toEqual([
          {
            parent: { pid: observer.pid, pgid: observer.pgid, startedAt: observer.startedAt },
            child: { ...child, commandFingerprint },
          },
        ]);
        // Durable rows must never expose the raw argv (appServer.args can carry secrets).
        expect(JSON.stringify(store.entries())).not.toContain(command);
        expect(kill).not.toHaveBeenCalled();
        spawned.emit("exit", 0, null);
        expect(store.entries()).toEqual([]);
      } else {
        await expect(registered).rejects.toThrow(
          mode === "unreadable command"
            ? "Cannot inspect Codex processes"
            : "Cannot register the Codex child process command",
        );
        expect(store.entries()).toEqual([]);
      }
    },
  );

  it.for(["success", "failure", "win32"])(
    "starts a nonblocking best-effort boot sweep: %s",
    async (mode) => {
      store.register("orphan", { parent, child: { ...child, commandFingerprint } });
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

  it("queues concurrent registration fence acquisitions without overlapping holders", async () => {
    const release = await acquireCodexAppServerProcessRegistrationFence();
    let secondAcquired = false;
    const second = acquireCodexAppServerProcessRegistrationFence().then((releaseSecond) => {
      secondAcquired = true;
      return releaseSecond;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(secondAcquired).toBe(false);

    release();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });

  it("serializes concurrent POSIX starts so process inspections never overlap", async (ctx) => {
    const children: ChildProcess[] = [];
    let activeInspections = 0;
    let maxActiveInspections = 0;
    spawnMock.mockReset().mockImplementation(() => {
      const spawned = buildSpawnedChild(process.pid + 100 + children.length);
      children.push(spawned);
      setImmediate(() => spawned.emit("spawn"));
      return spawned;
    });
    for (const spawned of children) {
      ctx.onTestFinished(() => destroySpawnedChild(spawned));
    }
    vi.mocked(readCodexAppServerProcessSnapshot).mockImplementation(async () => {
      activeInspections += 1;
      maxActiveInspections = Math.max(maxActiveInspections, activeInspections);
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
      activeInspections -= 1;
      return [
        observer,
        ...children.map((spawned) =>
          Object.assign({}, liveChild, { pid: spawned.pid!, ppid: process.pid }),
        ),
      ];
    });
    vi.mocked(readCodexAppServerProcessCommand).mockResolvedValue(command);
    vi.mocked(terminateCodexAppServerOrphan).mockResolvedValue(true);

    const starts = Array.from({ length: 5 }, () => createStdioTransport(startOptions("codex")));
    const transports = await Promise.all(starts);

    expect(transports).toHaveLength(5);
    expect(store.entries()).toHaveLength(5);
    // A burst of accepted starts must not inspect host processes concurrently
    // and exhaust every registration deadline before model work begins.
    expect(maxActiveInspections).toBe(1);
  });

  it("waits for an in-flight start registration before the boot sweep reaps", async (ctx) => {
    const inspectionGate = createDeferred<void>();
    let gatedFirstRead = true;
    const spawned = buildSpawnedChild(process.pid + 200);
    ctx.onTestFinished(() => destroySpawnedChild(spawned));
    spawnMock.mockReset().mockImplementation(() => {
      setImmediate(() => spawned.emit("spawn"));
      return spawned;
    });
    vi.mocked(readCodexAppServerProcessSnapshot).mockImplementation(async () => {
      if (gatedFirstRead) {
        gatedFirstRead = false;
        await inspectionGate.promise;
      }
      return [observer, Object.assign({}, liveChild, { pid: spawned.pid!, ppid: process.pid })];
    });
    vi.mocked(readCodexAppServerProcessCommand).mockResolvedValue(command);
    vi.mocked(terminateCodexAppServerOrphan).mockResolvedValue(true);

    const start = createStdioTransport(startOptions("codex"));
    await vi.waitFor(() => expect(readCodexAppServerProcessSnapshot).toHaveBeenCalled());

    // The start now holds the registration fence while its inspection is gated.
    // A legacy orphan (no fingerprint) would be terminated by an uncoordinated sweep.
    store.register("orphan", { parent, child });
    const warn = vi.fn();
    const service = createCodexAppServerProcessReaperService();
    expect(
      service.start({
        config: {},
        stateDir: root,
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      }),
    ).toBeUndefined();

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();

    inspectionGate.resolve();
    await start;
    await expect.poll(() => terminateCodexAppServerOrphan).toHaveBeenCalledExactlyOnceWith(child);
    expect(warn).not.toHaveBeenCalled();
  });
});
