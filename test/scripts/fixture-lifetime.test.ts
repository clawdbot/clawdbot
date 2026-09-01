import { getEventListeners } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runNodeStep } from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { createDeferred } from "../helpers/promise.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

it("cleans independent roots after a removal failure and retries the retained root", async () => {
  const lifetime = createFixtureLifetime();
  const first = lifetime.createTempDir("fixture-lifetime-busy-");
  const second = lifetime.createTempDir("fixture-lifetime-independent-");
  const failure = Object.assign(new Error("fixture directory busy"), { code: "EBUSY" });
  const remove = fs.rmSync;
  const removal = vi.spyOn(fs, "rmSync").mockImplementation((root, options) => {
    if (root === first) {
      throw failure;
    }
    remove(root, options);
  });
  try {
    await expect(lifetime.cleanup()).rejects.toBe(failure);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(false);
    removal.mockRestore();
    await lifetime.cleanup();
    expect(fs.existsSync(first)).toBe(false);
  } finally {
    removal.mockRestore();
    for (const root of [first, second]) {
      remove(root, { recursive: true, force: true });
    }
  }
});

it
  .skipIf(process.platform === "win32")
  .for(["normal", "missing readiness", "held close", "early exit", "cleanup rejection"])(
  "keeps inputs through cancellation, child close and whole-body unwind before the next fixture (%s)",
  async (fault, { signal: contextSignal }) => {
    const driverAbort = new AbortController();
    const signal = AbortSignal.any([contextSignal, driverAbort.signal]);
    const abortReason = new Error("driver canceled");
    const prematureExit = new Error("child completed before driver gate");
    const cleanupFailure = new Error("driver cleanup rejected");
    const originalNow = Date.now;
    let finalizing = false;
    let requiredRescue = false;
    let rescue: Promise<void> | undefined;
    let driverError: unknown;
    const controls = fixture.createTempDir("fixture-lifetime-control-");
    const root = fixture.createTempDir("fixture-lifetime-input-");
    const input = path.join(root, "input");
    fs.writeFileSync(input, "preserved");
    const release = path.join(controls, "release");
    const ready = createDeferred<number>();
    const terminating = createDeferred();
    const commandJoined = createDeferred();
    const bodyRelease = createDeferred();
    const controller = new AbortController();
    const lines: string[] = [];
    let laterPhase = false;
    let pid = 0;
    const clock = vi.spyOn(Date, "now");
    let childFinished = false;
    const canceled = createDeferred<never>();
    void canceled.promise.catch(() => {});
    const releaseDriverGates = () => {
      // Cancellation must unfreeze the real supervisor's escalation deadline,
      // even when the outer driver is still waiting for readiness or close.
      clock.mockRestore();
      bodyRelease.resolve();
      try {
        if (!childFinished) {
          fs.writeFileSync(release, "release");
        }
      } finally {
        controller.abort(signal.reason);
      }
    };
    const abort = () => {
      canceled.reject(signal.reason);
      try {
        releaseDriverGates();
      } catch (error) {
        void fixture.verifyCleanup(async () => {
          throw new Error("Could not release canceled driver gates", { cause: error });
        });
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    const childEnded = commandJoined.promise.then(() => {
      throw prematureExit;
    });
    void childEnded.catch(() => {});
    const waitForGate = async <T>(gate: Promise<T>, allowChildClose = false) => {
      const result = await Promise.race(
        allowChildClose ? [gate, canceled.promise] : [gate, canceled.promise, childEnded],
      );
      signal.throwIfAborted();
      return result;
    };
    // A one-turn rescue bounds the pre-fix reproduction without replacing the
    // actual child join. Cancellation must enter finally before this turn.
    const requestRescue = () => {
      rescue = new Promise<void>((resolve) => {
        setImmediate(() => {
          requiredRescue = !finalizing;
          if (requiredRescue) {
            releaseDriverGates();
            ready.resolve(pid);
            terminating.resolve();
          }
          resolve();
        });
      });
    };
    const body = fixture.run(async () => {
      try {
        await fixture.track(
          runNodeStep(
            "lifetime-child",
            [
              "--eval",
              `
          const fs = require("node:fs");
          process.on("SIGTERM", () => {
            console.log("terminating");
            const poll = setInterval(() => {
              if (!fs.existsSync(${JSON.stringify(release)})) return;
              if (${JSON.stringify(fault)} === "held close") return;
              clearInterval(poll);
              console.log(fs.readFileSync(${JSON.stringify(input)}, "utf8"));
              process.exit(0);
            }, 5);
          });
          console.log((${JSON.stringify(fault)} === "missing readiness" || ${JSON.stringify(fault)} === "early exit" ? "started:" : "ready:") + process.pid);
          if (${JSON.stringify(fault)} === "early exit") process.exitCode = 2;
          else setInterval(() => {}, 1000);
        `,
            ],
            30_000,
            {
              abortController: controller,
              onStdoutLine(line) {
                const text = line.trim();
                lines.push(text);
                if (text.startsWith("ready:") || text.startsWith("started:")) {
                  pid = Number(text.split(":")[1]);
                  if (fault === "missing readiness") {
                    driverAbort.abort(abortReason);
                    requestRescue();
                  } else if (fault !== "early exit") {
                    ready.resolve(pid);
                  }
                }
                if (text === "terminating") {
                  terminating.resolve();
                }
                return true;
              },
            },
          ),
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          throw error;
        }
      } finally {
        childFinished = true;
        commandJoined.resolve();
        if (fault === "early exit") {
          requestRescue();
        }
        await bodyRelease.promise;
      }
      controller.signal.throwIfAborted();
      laterPhase = true;
      await runNodeStep("late-phase", ["--eval", "process.exit(0)"], 1_000, {
        abortController: controller,
      });
    });
    const outcome = body.catch((error: unknown) => error);
    let cleanup: Promise<void> | undefined;
    try {
      pid = await waitForGate(ready.promise);
      // Hold only the managed supervisor's grace clock; the child and pipes stay real.
      clock.mockReturnValue(Date.now());
      controller.abort(new Error("test canceled"));
      cleanup = fixture.cleanup();
      const repeatedCleanup = fixture.cleanup();
      cleanup = Promise.all([cleanup, repeatedCleanup]).then(() => {});
      void cleanup.catch(() => {});
      await waitForGate(terminating.promise);
      expect(fs.readFileSync(input, "utf8")).toBe("preserved");
      expect(isProcessAlive(pid)).toBe(true);
      fs.writeFileSync(release, "release");
      if (fault === "held close") {
        driverAbort.abort(abortReason);
        requestRescue();
      }
      await waitForGate(commandJoined.promise, true);
      expect(isProcessAlive(pid)).toBe(false);
      expect(lines).toContain("preserved");
      expect(fs.existsSync(root)).toBe(true);
      if (fault === "cleanup rejection") {
        await fixture
          .verifyCleanup(async () => {
            throw cleanupFailure;
          })
          .catch(() => {});
      }
      bodyRelease.resolve();
      await cleanup;
      expect(fs.existsSync(root)).toBe(false);
      expect(laterPhase).toBe(false);
      expect(await outcome).toBeInstanceOf(Error);
    } catch (error) {
      if (fault === "normal") {
        throw error;
      }
      driverError = error;
    } finally {
      finalizing = true;
      try {
        try {
          releaseDriverGates();
        } finally {
          // These are actual joins, never cancellation races. A cleanup rejection
          // must still reach timer/listener restoration and join the probe rescue.
          try {
            await outcome;
            const drain = cleanup ?? fixture.cleanup();
            if (fault === "cleanup rejection") {
              await expect(drain).rejects.toBe(driverError);
            } else {
              await drain;
            }
          } finally {
            try {
              if (pid && isProcessAlive(pid)) {
                process.kill(pid, "SIGKILL");
                await waitForDead(pid, 2_000);
              }
            } finally {
              await rescue;
            }
          }
        }
      } finally {
        clock.mockRestore();
        signal.removeEventListener("abort", abort);
      }
    }
    expect(Date.now).toBe(originalNow);
    expect(getEventListeners(signal, "abort")).toEqual([]);
    if (fault === "cleanup rejection") {
      expect(driverError).toBeInstanceOf(AggregateError);
      expect(driverError).toHaveProperty("errors", [cleanupFailure]);
      expect(isProcessAlive(pid)).toBe(false);
      expect(fs.existsSync(root)).toBe(true);
      // Only this injected failure is disposable: its real child has joined.
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(controls, { recursive: true, force: true });
    } else if (fault !== "normal") {
      expect(requiredRescue).toBe(false);
      expect(driverError).toBe(fault === "early exit" ? prematureExit : abortReason);
      expect(isProcessAlive(pid)).toBe(false);
    }
  },
);

it.each(["cause", "aggregate", "cleanup"])(
  "retains inputs and reports unverified %s cleanup even when the body handled its rejection",
  async (kind) => {
    const root = fixture.createTempDir("fixture-lifetime-retained-");
    const uncertainty = Object.assign(new Error("group not joined"), {
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      processTreeState: "indeterminate",
    });
    const error =
      kind === "cause"
        ? new Error("command failed", { cause: uncertainty })
        : kind === "aggregate"
          ? new AggregateError([new Error("primary failure"), uncertainty], "sibling cleanup")
          : new Error("orphan verification failed");
    const run = kind === "cleanup" ? fixture.verifyCleanup : fixture.run;
    await expect(
      run(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    try {
      await expect(fixture.cleanup()).rejects.toThrow("Fixture cleanup unverified");
      expect(fs.existsSync(root)).toBe(true);
    } finally {
      // The injected uncertainty has no process behind it; this test owns its disposal.
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
