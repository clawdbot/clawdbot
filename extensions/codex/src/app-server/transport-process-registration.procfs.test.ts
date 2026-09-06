import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  terminateCodexAppServerDescendants,
  terminateCodexAppServerOrphan,
} from "./transport-process-containment.js";
import { prepareCodexAppServerProcessRegistration } from "./transport-process-registration.js";
import { RegistrationTestChildProcess } from "./transport-process-registration.test-support.js";
import { readCodexAppServerProcessSnapshot } from "./transport-process-snapshot.js";

const procfs = vi.hoisted(() => ({ files: new Map<string, string | Error | (() => string)>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: (...args: Parameters<typeof original.readFile>) => {
      const file = args[0];
      if (typeof file !== "string" || !file.startsWith("/proc/")) {
        return original.readFile(...args);
      }
      const stored = procfs.files.get(file);
      const value = typeof stored === "function" ? stored() : stored;
      return typeof value === "string"
        ? Promise.resolve(value)
        : Promise.reject(value ?? Object.assign(new Error("gone"), { code: "ENOENT" }));
    },
    readdir: (...args: Parameters<typeof original.readdir>) =>
      args[0] === "/proc"
        ? Promise.resolve(
            [...procfs.files.keys()].flatMap(
              (file) => /^\/proc\/(\d+)\/stat$/.exec(file)?.[1] ?? [],
            ),
          )
        : original.readdir(...args),
  };
});

const bootId = "00000000-0000-0000-0000-000000000001";
const identity = (pid: number) => ({ pid, pgid: pid, startedAt: `${bootId}:12345` });
const parent = identity(500001);
const child = identity(500002);
const neighbor = 500003;
const command = "/opt/codex app-server --listen stdio://";
const commandFingerprint = createHash("sha256").update(command).digest("hex");

function addProcess(pid: number, ppid: number, state = "S", threads = 1) {
  procfs.files.set(
    `/proc/${pid}/stat`,
    `${pid} (worker) ${state} ${ppid} ${pid}${" 0".repeat(14)} ${threads} 0 12345\n`,
  );
  procfs.files.set(`/proc/${pid}/cmdline`, command.replaceAll(" ", "\0"));
}

describe("Codex registration procfs boundary", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let store: ReturnType<
    typeof createPluginStateSyncKeyedStore<{
      parent: ReturnType<typeof identity>;
      child: ReturnType<typeof identity> & { commandFingerprint: string };
    }>
  >;
  let kill: MockInstance<typeof process.kill>;

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "codex-registration-procfs-" });
    store = createPluginStateSyncKeyedStore("codex", {
      namespace: "app-server-processes",
      maxEntries: 512,
      overflowPolicy: "reject-new",
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    // Synthetic PIDs must never reach the real signal syscall, even on regression.
    kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("unexpected signal");
    });
    procfs.files.set("/proc/sys/kernel/random/boot_id", bootId);
    addProcess(process.pid, process.ppid);
    addProcess(parent.pid, 1);
    addProcess(child.pid, parent.pid);
    procfs.files.set(
      `/proc/${neighbor}/stat`,
      Object.assign(new Error("unreadable neighbor"), { code: "EACCES" }),
    );
  });

  afterEach(async () => {
    store.clear();
    vi.restoreAllMocks();
    procfs.files.clear();
    await state.cleanup();
  });

  it.for(["immediate", "delayed", "threaded zombie"])(
    "preserves a live owner's registration during %s inspection despite an unreadable unrelated process",
    async (mode) => {
      const registration = { parent, child: { ...child, commandFingerprint } };
      store.register("owned", registration);
      if (mode === "threaded zombie") {
        addProcess(parent.pid, 1, "Z", 2);
      }
      if (mode === "delayed") {
        let now = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => now);
        procfs.files.set("/proc/sys/kernel/random/boot_id", () => {
          now += 3_000;
          return bootId;
        });
      }

      await expect(
        Promise.all([
          prepareCodexAppServerProcessRegistration(),
          prepareCodexAppServerProcessRegistration(),
        ]),
      ).resolves.toHaveLength(2);

      expect(store.lookup("owned")).toEqual(registration);
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it.for([
    "readable",
    "startup",
    "slow-snapshot",
    "slow-command",
    "slow-inspection",
    "exhausted-inspection",
    "permission",
    "malformed",
    "deadline",
    "missing-observer",
  ])(
    "registers a direct child despite an unreadable unrelated process only with usable ownership: %s",
    async (mode, ctx) => {
      addProcess(child.pid, process.pid);
      const spawned = new RegistrationTestChildProcess(child.pid);
      ctx.onTestFinished(() => {
        spawned.stdin.destroy();
        spawned.stdout.destroy();
        spawned.stderr.destroy();
        spawned.removeAllListeners();
      });
      const register = await prepareCodexAppServerProcessRegistration();
      if (mode.startsWith("slow-") || mode === "exhausted-inspection") {
        let now = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const delayMs = mode === "exhausted-inspection" ? 6_000 : 3_000;
        if (mode !== "slow-command") {
          procfs.files.set("/proc/sys/kernel/random/boot_id", () => {
            now += delayMs;
            return bootId;
          });
        }
        if (mode !== "slow-snapshot") {
          procfs.files.set(`/proc/${child.pid}/cmdline`, () => {
            expect(store.entries()).toEqual([]);
            now += delayMs;
            return command.replaceAll(" ", "\0");
          });
        }
      } else if (mode === "startup") {
        let reads = 0;
        procfs.files.set(`/proc/${child.pid}/cmdline`, () => {
          expect(store.entries()).toEqual([]);
          return reads++ === 0 ? "" : command.replaceAll(" ", "\0");
        });
      } else if (mode === "missing-observer") {
        procfs.files.delete(`/proc/${process.pid}/stat`);
      } else if (mode !== "readable") {
        procfs.files.set(
          `/proc/${child.pid}/stat`,
          mode === "malformed"
            ? ""
            : Object.assign(new Error("child inspection failed"), {
                code: mode === "deadline" ? "ABORT_ERR" : "EACCES",
              }),
        );
      }
      const registered = register(spawned);
      spawned.emit("spawn");

      if (mode !== "readable" && mode !== "startup" && !mode.startsWith("slow-")) {
        await expect(registered).rejects.toMatchObject({
          reason:
            mode === "exhausted-inspection"
              ? "deadline"
              : mode === "permission" || mode === "deadline"
                ? mode
                : "unavailable",
        });
        expect(store.entries()).toEqual([]);
        expect(kill).not.toHaveBeenCalled();
        return;
      }
      await registered;

      expect(store.entries().map((entry) => entry.value)).toEqual([
        { parent: identity(process.pid), child: { ...child, commandFingerprint } },
      ]);
      expect(kill).not.toHaveBeenCalled();
      spawned.emit("exit", 0, null);
      expect(store.entries()).toEqual([]);
    },
  );

  it.for([
    ["permission", "EACCES"],
    ["unavailable", "EIO"],
    ["deadline", "ABORT_ERR"],
    ["unavailable", "empty"],
    ["unavailable", "group-zero"],
    ["unavailable", "missing-observer"],
  ] as const)(
    "retains registrations when required identity inspection fails: %s/%s",
    async ([reason, fault]) => {
      const registration = { parent, child: { ...child, commandFingerprint } };
      store.register("owned", registration);
      if (fault === "missing-observer") {
        procfs.files.delete(`/proc/${process.pid}/stat`);
      } else {
        procfs.files.set(
          `/proc/${parent.pid}/stat`,
          fault === "empty"
            ? ""
            : fault === "group-zero"
              ? `${parent.pid} (worker) S 1 0${" 0".repeat(14)} 1 0 12345\n`
              : Object.assign(new Error("required inspection failed"), { code: fault }),
        );
      }

      await expect(prepareCodexAppServerProcessRegistration()).rejects.toMatchObject({ reason });
      expect(store.lookup("owned")).toEqual(registration);
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it("keeps full-tree inspection fail-closed with the same unreadable neighbor", async () => {
    await expect(readCodexAppServerProcessSnapshot()).rejects.toMatchObject({
      reason: "permission",
    });
    await expect(terminateCodexAppServerOrphan(child)).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it.for(["dead descendant", "threaded descendant", "threaded root", "unrelated threaded zombie"])(
    "requires whole-process quiescence only from the owned tree: %s",
    async (mode) => {
      const threadedRoot = mode === "threaded root";
      const related = mode !== "unrelated threaded zombie";
      addProcess(child.pid, process.pid, threadedRoot ? "Z" : "S", threadedRoot ? 2 : 1);
      addProcess(neighbor, related ? child.pid : 1, "Z", mode === "dead descendant" ? 1 : 2);
      kill.mockImplementation((pid, signal) => {
        if (pid === child.pid && !threadedRoot) {
          addProcess(child.pid, process.pid, signal === "SIGSTOP" ? "T" : "S");
        }
        return true;
      });

      const contained = await terminateCodexAppServerDescendants({
        pid: child.pid,
        kill: (signal) => process.kill(child.pid, signal),
      });

      if (mode === "threaded descendant" || threadedRoot) {
        expect(contained).toBeUndefined();
        expect(kill).toHaveBeenCalledWith(child.pid, "SIGCONT");
        if (!threadedRoot) {
          expect(kill).toHaveBeenCalledWith(neighbor, "SIGSTOP");
          expect(kill).toHaveBeenCalledWith(neighbor, "SIGCONT");
        }
      } else {
        expect(contained).toMatchObject({ root: child });
        if (contained && contained !== "exited") {
          contained.resume();
        }
        expect(kill.mock.calls.every(([pid]) => pid === child.pid)).toBe(true);
      }
      expect(kill.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    },
  );

  it.for(["ENOENT", "ESRCH"])(
    "retires verified disappeared identities only after full containment inspection: %s",
    async (code) => {
      store.register("orphan", { parent, child: { ...child, commandFingerprint } });
      for (const pid of [parent.pid, child.pid]) {
        procfs.files.set(`/proc/${pid}/stat`, Object.assign(new Error("gone"), { code }));
      }
      // Selected identities are gone, but an unreadable full tree still blocks retirement.
      await expect(prepareCodexAppServerProcessRegistration()).rejects.toThrow(
        "Cannot reap registered Codex process",
      );
      expect(store.lookup("orphan")).toBeDefined();
      procfs.files.delete(`/proc/${neighbor}/stat`);
      await prepareCodexAppServerProcessRegistration();
      expect(store.lookup("orphan")).toBeUndefined();
      expect(kill).not.toHaveBeenCalled();
    },
  );
});
