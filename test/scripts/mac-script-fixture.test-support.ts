import type { ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import { it, vi, type TestContext } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

function createMacScriptFixture({
  signal,
  onTestFinished,
}: Pick<TestContext, "signal" | "onTestFinished">) {
  const lifetime = createFixtureLifetime();
  const finished = new AbortController();
  const commandSignal = AbortSignal.any([signal, finished.signal]);
  const commands: Promise<unknown>[] = [];
  onTestFinished(async () => {
    finished.abort();
    await Promise.allSettled(commands);
  });

  function run(
    bin: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; encoding?: "utf8" } = {},
  ) {
    commandSignal.throwIfAborted();
    const completion = (async () => {
      // Match spawnSync's bounded UTF-8 capture while the managed owner joins
      // the process group before this case can remove its filesystem inputs.
      const maxBuffer = 1024 * 1024;
      const stdout = createBoundedChildOutput(maxBuffer);
      const stderr = createBoundedChildOutput(maxBuffer);
      const overflow = new AbortController();
      let child: ChildProcess | undefined;
      let error: unknown;
      let bytes = 0;
      try {
        await runManagedCommand({
          bin,
          args,
          cwd: options.cwd,
          env: options.env,
          timeoutMs: options.timeout,
          signal: AbortSignal.any([commandSignal, overflow.signal]),
          requireProcessTreeExit: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          onReady(process) {
            child = process;
            for (const [name, pipe, output] of [
              ["stdout", process.stdout!, stdout],
              ["stderr", process.stderr!, stderr],
            ] as const) {
              pipe.on("data", (chunk: Buffer) => {
                output.append(chunk);
                bytes += chunk.byteLength;
                if (bytes > maxBuffer && !overflow.signal.aborted) {
                  error = Object.assign(new Error(`${name} maxBuffer length exceeded`), {
                    code: "ENOBUFS",
                  });
                  overflow.abort(error);
                }
              });
            }
          },
        });
      } catch (cause) {
        if (!error) {
          error = cause;
        } else if (!(cause instanceof Error && "code" in cause && cause.code === "ABORT_ERR")) {
          error = new AggregateError([error, cause], "Mac script failed", { cause });
        }
      }
      // Signal-boundary cases assert the native null status and exact signal.
      return {
        status: child?.exitCode ?? null,
        signal: child?.signalCode ?? null,
        error,
        stdout: stdout.text(),
        stderr: stderr.text(),
      };
    })();
    commands.push(completion);
    return lifetime.track(completion);
  }

  return { lifetime, createTempDir: lifetime.createTempDir, run };
}

export type MacScriptFixture = ReturnType<typeof createMacScriptFixture>;

export function createMacScriptTest() {
  const test = it.extend<{ mac: MacScriptFixture }>({
    mac: async ({ signal, onTestFinished }, use) => {
      await use(createMacScriptFixture({ signal, onTestFinished }));
    },
  });
  // Resolve ownership before runTest: onTestFinished aborts outstanding commands
  // before whole-body cleanup waits for their finally blocks and removes inputs.
  test.aroundEach(async (runTest, { mac }) => {
    try {
      await runTest();
    } finally {
      await mac.lifetime.cleanup();
    }
  });
  // Keep outer suites sequential: this per-group cap is applied after Vitest's
  // file-wide limiter is created, so concurrent suites could each admit the full cap.
  test.beforeAll(() => {
    vi.setConfig({ maxConcurrency: Math.min(3, availableParallelism()) });
    return () => vi.resetConfig();
  });
  return test;
}
