import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { ManagedHandoffLeaseAction } from "./update-managed-service-handoff-lease-state.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "./update-managed-service-handoff-runtime-assets.js";
import { HANDOFF_SCRIPT } from "./update-managed-service-handoff-script.js";

function createChild(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null,
    connected: true,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
    kill: vi.fn(),
    send: vi.fn((_message: { type: string }, callback?: () => void) => callback?.()),
    disconnect() {
      child.connected = false;
      child.emit("disconnect");
    },
  });
  return child;
}

// Only the helper orchestration is real. Staged runtime/native inspection and
// the process are in-memory adapters; this fixture opens no DB, file, or child.
function createNativeHelper() {
  const helperPid = 41000;
  const executor = createChild(41001);
  const admitted = createDeferredCore();
  const scopeUnit = "openclaw-triage-unit.scope";
  const controlGroup = "/synthetic/" + scopeUnit;
  const unit = "openclaw-gateway.service";
  const fragment = "/synthetic/gateway.service";
  const parameters = {
    action: "triage",
    triageTransition: true,
    parentExitTimeoutMs: 30_000,
    parentExitDeadlineAt: Date.now() + 30_000,
    serviceRecovery: { kind: "systemd", unit },
    serviceManagerEnv: {},
    primaryFragment: fragment,
    scopeUnit,
    updateLeaseKey: "/synthetic/install",
    updateLeaseOwner: "unit-owner",
    cwd: "/synthetic",
    logPath: "/synthetic/handoff.log",
    nodeExecArgv: [],
    commandArgv: ["synthetic-node", "synthetic-cli", "triage"],
    commandLabel: "synthetic triage",
    failure: { kind: "update", phase: "install", error: "synthetic failure", gateway: "preserve" },
  };
  const logs: string[] = [];
  const output: string[] = [];
  const cleanupOrder: string[] = [];
  let revision = 0;
  const issueLease = (pid: number, action: ManagedHandoffLeaseAction) => ({
    key: parameters.updateLeaseKey,
    owner: parameters.updateLeaseOwner,
    helper: { pid: helperPid },
    executor: { pid },
    action,
    payload: `fixture-revision-${++revision}`,
  });
  type Lease = ReturnType<typeof issueLease>;
  const store = {
    acquire: (_root: string, _owner: string, action: ManagedHandoffLeaseAction) => ({
      kind: "acquired",
      lease: issueLease(helperPid, action),
    }),
    bind: (lease: Lease, pid: number, action = lease.action) => issueLease(pid, action),
    activate: (lease: Lease) => {
      if (lease.action.kind !== "triage") {
        throw new Error("Expected triage fixture admission");
      }
      return issueLease(lease.executor.pid, { ...lease.action, phase: "running" });
    },
    owns: () => true,
    properties: (raw: string) => JSON.parse(raw),
    isPidAlive: () => true,
    readProcessStartIdentity: () => "synthetic-start",
    revoke: vi.fn((lease: Lease, uncertain = false) => {
      cleanupOrder.push(uncertain ? "uncertain" : "revoke");
      return lease;
    }),
    release: vi.fn(),
    stopNative: vi.fn((_lease: Lease, _ownPlacement: boolean) => {
      cleanupOrder.push("stop");
      return false;
    }),
  };
  const helperProcess = Object.assign(new EventEmitter(), {
    pid: helperPid,
    platform: "linux",
    env: {},
    execPath: "synthetic-node",
    argv: ["synthetic-node", "/synthetic/helper.cjs", "/synthetic/params.json"],
    stdin: new PassThrough(),
    exitCode: 0,
    exit: vi.fn(),
  });
  const fakeFs = {
    readFileSync: (file: string) => {
      if (file === "/synthetic/params.json") {
        return JSON.stringify(parameters);
      }
      if (file === "/proc/self/cgroup" || file === `/proc/${executor.pid}/cgroup`) {
        return "0::" + controlGroup;
      }
      throw new Error(`Unexpected fixture read: ${file}`);
    },
    mkdirSync: vi.fn(),
    appendFileSync: (_file: string, line: string) => logs.push(line),
    openSync: () => 37,
    closeSync: vi.fn(),
    rmSync: vi.fn(),
    writeSync: (fd: number, chunk: string | Buffer) => {
      if (fd === 37) {
        output.push(chunk.toString());
      }
    },
  };
  const spawn = (command: string, args: string[]) => {
    if (command === "synthetic-node") {
      queueMicrotask(() => executor.emit("spawn"));
      return executor;
    }
    if (command !== "systemctl" || args[0] !== "--user" || args[1] !== "show") {
      throw new Error(`Unexpected fixture command: ${command}`);
    }
    const child = createChild(42000);
    const facts =
      args[2] === scopeUnit
        ? {
            Id: scopeUnit,
            LoadState: "loaded",
            ActiveState: "active",
            CanStart: "no",
            KillMode: "control-group",
            PartOf: unit,
            InvocationID: "a".repeat(32),
            ControlGroup: controlGroup,
          }
        : { Id: unit, LoadState: "loaded", FragmentPath: fragment };
    queueMicrotask(() => {
      child.emit("spawn");
      child.stdout.write(JSON.stringify(facts));
      child.stdout.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  executor.stdin.on("data", () =>
    queueMicrotask(() => executor.emit("message", { type: "triage-ready", version: 2 })),
  );
  executor.send.mockImplementation((message, callback) => {
    if (message.type === "triage") {
      admitted.resolve();
    }
    callback?.();
  });
  const modules: Record<string, unknown> = {
    "node:child_process": {
      spawn,
      spawnSync: () => {
        throw new Error("Unexpected synchronous process request");
      },
    },
    "node:fs": fakeFs,
    "node:path": path,
    "node:url": { pathToFileURL },
    [`./runtime/${MANAGED_HANDOFF_RUNTIME_ENTRY}`]: {
      createManagedHandoffLeaseRuntime: () => store,
    },
  };
  let settled = false;
  const completion: Promise<void> = runInNewContext(HANDOFF_SCRIPT, {
    Buffer,
    Date,
    process: helperProcess,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    require: (id: string) => {
      if (!Object.hasOwn(modules, id)) {
        throw new Error(`Unexpected staged helper import: ${id}`);
      }
      return modules[id];
    },
  });
  void completion.then(() => {
    settled = true;
  });
  const close = () => {
    executor.exitCode = 0;
    executor.stdout.end();
    executor.emit("close", 0, null);
  };
  return {
    executor,
    output,
    logs,
    cleanupOrder,
    store,
    helperProcess,
    completion,
    get settled() {
      return settled;
    },
    ready: Promise.race([
      // The child can acknowledge admission before the parent's gate write callback.
      // Exit cases start only after both sides have completed that handoff.
      Promise.all([admitted.promise, finished(executor.stdin, { readable: false, cleanup: true })]),
      completion.then(() => {
        throw new Error(logs.join(""));
      }),
    ]),
    close,
    observe(event: "exit" | "disconnect") {
      if (event === "disconnect") {
        executor.disconnect();
      } else {
        executor.exitCode = 0;
        executor.emit("exit", 0, null);
      }
    },
    async dispose() {
      close();
      await completion;
      executor.stdin.destroy();
      executor.stdout.destroy();
      helperProcess.stdin.destroy();
    },
  };
}

let helper: ReturnType<typeof createNativeHelper> | undefined;
beforeEach(() =>
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  }),
);
afterEach(async () => {
  await helper?.dispose();
  helper = undefined;
  vi.useRealTimers();
});

it.each(["exit", "disconnect"] as const)(
  "preserves final output when %s precedes normal close",
  async (event) => {
    helper = createNativeHelper();
    await helper.ready;
    helper.executor.stdout.write("first\n");
    helper.observe(event);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(helper.settled).toBe(false);
    helper.executor.stdout.write("last\n");
    helper.close();
    await helper.completion;
    expect(helper.output.join("")).toBe("first\nlast\n");
    expect(helper.helperProcess.exitCode, helper.logs.join("")).toBe(0);
    expect(helper.cleanupOrder).not.toContain("uncertain");
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["exit", "disconnect"] as const)(
  "reports incomplete cleanup when %s is never followed by close",
  async (event) => {
    helper = createNativeHelper();
    await helper.ready;
    helper.observe(event);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(helper.settled).toBe(false);
    expect(helper.store.stopNative).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(helper.settled).toBe(true);
    expect(helper.helperProcess.exitCode).toBe(1);
    expect(helper.logs.join("")).toContain("native cleanup remains unconfirmed");
    expect(helper.cleanupOrder).toContain("uncertain");
    expect(helper.cleanupOrder.indexOf("uncertain")).toBeLessThan(
      helper.cleanupOrder.indexOf("stop"),
    );
    expect(helper.store.stopNative).toHaveBeenCalledOnce();
    expect(helper.store.release).not.toHaveBeenCalled();
    expect(helper.executor.stdout.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);
