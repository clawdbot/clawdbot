import * as childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";

type ChildExit = { code: number | null; signal: NodeJS.Signals | null };
type Settlement =
  | { state: "pending" }
  | { state: "fulfilled" }
  | { state: "rejected"; error: unknown };

function observeSettlement(promise: Promise<unknown>) {
  const observed: { value: Settlement } = { value: { state: "pending" } };
  void promise.then(
    () => {
      observed.value = { state: "fulfilled" };
    },
    (error: unknown) => {
      observed.value = { state: "rejected", error };
    },
  );
  return observed;
}

it.skipIf(process.platform === "win32")(
  "rejects queued completions and settles close when a real child exits before READY",
  async () => {
    const tempDirs = createTempDirTracker();
    const children: Promise<ChildExit>[] = [];
    try {
      const executable = path.join(tempDirs.make("openclaw-completion-exit-"), "pwsh");
      writeFileSync(executable, "#!/bin/sh\nexit 23\n", { mode: 0o700 });
      const closed = createDeferred<ChildExit>();
      vi.resetModules();
      vi.stubEnv("OPENCLAW_TEST_PWSH", executable);
      vi.doMock("node:child_process", () => ({
        ...childProcess,
        spawn(...args: Parameters<typeof childProcess.spawn>) {
          const child = childProcess.spawn(...args);
          if (args[0] === executable) {
            const exit = createDeferred<ChildExit>();
            child.once("close", (code, signal) => exit.resolve({ code, signal }));
            children.push(exit.promise);
            void exit.promise.then(closed.resolve);
          }
          return child;
        },
      }));
      const { PowerShellCompletionRunner } = await import("./completion-cli.test-support.js");
      const runner = new PowerShellCompletionRunner();
      const program = new Command().name("openclaw");
      const first = observeSettlement(runner.complete(program, "openclaw "));
      const second = observeSettlement(runner.complete(program, "openclaw --"));

      expect(await closed.promise).toEqual({ code: 23, signal: null });
      // The real child is closed; only promise continuations remain.
      // Node drains those before setImmediate's check phase, regardless of chain depth.
      await setImmediate();
      const exitFailure = expect.objectContaining({
        message: expect.stringContaining("code 23 signal null"),
      });
      expect(first.value).toEqual({ state: "rejected", error: exitFailure });
      expect(second.value).toEqual(first.value);
      expect(children).toHaveLength(1);

      const closing = observeSettlement(runner.close());
      // The exit promise is settled; observe close's remaining promise continuations.
      await setImmediate();
      expect(closing.value).toEqual({ state: "rejected", error: exitFailure });
    } finally {
      // Joining the actual close latches also cleans up when the pre-fix readiness assertion fails.
      await Promise.all(children);
      vi.doUnmock("node:child_process");
      vi.unstubAllEnvs();
      vi.resetModules();
      tempDirs.cleanup();
    }
  },
);
