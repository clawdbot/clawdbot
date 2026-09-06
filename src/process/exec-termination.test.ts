import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants as osConstants } from "node:os";
import process from "node:process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import * as processIdentity from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";
import { createCommandTerminationController } from "./exec-termination.js";

afterEach(() => vi.restoreAllMocks());

async function withOwnedTree(
  run: (tree: { parent: ReturnType<typeof spawn>; descendantPid: number }) => Promise<void>,
) {
  const descendant = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');`;
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process');
      process.on('SIGTERM',()=>{});
      const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>process.send(child.pid));setInterval(()=>{},1000);`,
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const closed = once(parent, "close");
  let descendantPid: number | undefined;
  try {
    const [message] = await once(parent, "message", { signal: AbortSignal.timeout(2_000) });
    descendantPid = Number(message);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    await run({ parent, descendantPid });
  } finally {
    killPidIfAlive(parent.pid);
    killPidIfAlive(descendantPid);
    await closed;
    if (descendantPid) {
      expect(await waitForPidToExit(descendantPid)).toBe(true);
    }
  }
}

describe.skipIf(process.platform === "win32")("command process-group settlement", () => {
  it.each(["graceful", "force"] as const)(
    "joins observed group exit after a %s force-send receipt",
    async (mode) => {
      await withOwnedTree(async ({ parent, descendantPid }) => {
        const kill = process.kill.bind(process);
        const forced = createDeferredCore();
        let observedAbsence = false;
        const signals = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (
            pid === -parent.pid! &&
            (signal === "SIGKILL" || signal === osConstants.signals.SIGKILL)
          ) {
            // A successful send is not an exit receipt. Keep this real group alive until released below.
            forced.resolve();
            return true;
          }
          try {
            return kill(pid, signal);
          } catch (error) {
            if (
              pid === -parent.pid! &&
              signal === 0 &&
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            ) {
              observedAbsence = true;
            }
            throw error;
          }
        });
        const owner = createCommandTerminationController({
          child: parent,
          cancelController: new AbortController(),
          processTree: { mode },
          killGraceMs: 0,
          isChildExited: () => parent.exitCode !== null || parent.signalCode !== null,
          isCommandSettled: () => false,
        });
        owner.terminate();
        await forced.promise;
        let settled = false;
        const completion = owner.settle().then((result) => {
          settled = true;
          return { result, observedAbsence };
        });
        await nextTurn();
        expect(processIdentity.isPidAlive(descendantPid)).toBe(true);
        expect.soft(settled).toBe(false);
        kill(-parent.pid!, "SIGKILL");
        const outcome = await completion;
        expect(outcome.result).toBe(outcome.observedAbsence ? "forced" : "uncertain");
        if (outcome.result === "forced") {
          expect(processIdentity.isPidAlive(descendantPid)).toBe(false);
        }
        expect(
          signals.mock.calls.filter(
            ([, signal]) => signal === "SIGKILL" || signal === osConstants.signals.SIGKILL,
          ),
        ).toHaveLength(1);
      });
    },
  );

  it("reports forced cleanup when the original group is confirmed absent", async () => {
    const parent = spawn(
      process.execPath,
      ["-e", "process.on('message',()=>process.exit(0));process.send('ready');"],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const closed = once(parent, "close");
    try {
      await once(parent, "message", { signal: AbortSignal.timeout(2_000) });
      const owner = createCommandTerminationController({
        child: parent,
        cancelController: new AbortController(),
        processTree: { mode: "force" },
        killGraceMs: 0,
        isChildExited: () => parent.exitCode !== null || parent.signalCode !== null,
        isCommandSettled: () => false,
      });
      parent.send("finish");
      await closed;
      owner.terminate();
      expect(await owner.settle()).toBe("forced");
    } finally {
      killPidIfAlive(parent.pid);
      await closed;
    }
  });

  it.each([
    { observation: "live", killSignal: undefined },
    { observation: "unknown", killSignal: undefined },
    { observation: "reused", killSignal: undefined },
    { observation: "live", killSignal: "SIGKILL" },
    { observation: "live", killSignal: osConstants.signals.SIGKILL },
  ] as const)(
    "reports uncertain when the original group remains $observation after force (initial signal=$killSignal)",
    async ({ observation, killSignal }) => {
      await withOwnedTree(async ({ parent, descendantPid }) => {
        const kill = process.kill.bind(process);
        const readStart = processIdentity.getFileLockProcessStartTime;
        const originalStart = readStart(parent.pid!);
        expect(originalStart).not.toBeNull();
        let forced = false;
        const signals = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (
            pid === -parent.pid! &&
            (signal === "SIGKILL" || signal === osConstants.signals.SIGKILL)
          ) {
            forced = true;
            return true;
          }
          if (forced && pid === -parent.pid! && signal === 0 && observation === "unknown") {
            throw Object.assign(new Error("fixture observation unavailable"), { code: "EPERM" });
          }
          return kill(pid, signal);
        });
        vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation(
          (pid, ...args) =>
            forced && observation === "reused" && pid === parent.pid
              ? originalStart! + 1
              : readStart(pid, ...args),
        );
        const owner = createCommandTerminationController({
          child: parent,
          cancelController: new AbortController(),
          processTree: { mode: "graceful" },
          killSignal,
          killGraceMs: 0,
          isChildExited: () => parent.exitCode !== null || parent.signalCode !== null,
          isCommandSettled: () => false,
        });
        owner.terminate();
        expect(await owner.settle()).toBe("uncertain");
        expect(processIdentity.isPidAlive(descendantPid)).toBe(true);
        expect(
          signals.mock.calls.filter(
            ([, signal]) => signal === "SIGKILL" || signal === osConstants.signals.SIGKILL,
          ),
        ).toHaveLength(1);
      });
    },
  );
});
