// Process-boundary proof that the hard-exit watchdog survives main-thread starvation.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const WATCHDOG_DELAY_MS = 100;
const CHILD_TIMEOUT_MS = 3_000;
const watchdogModuleUrl = pathToFileURL(
  path.resolve("src/cli/gateway-cli/shutdown-hard-exit.ts"),
).href;

function runWatchdogChild(source: string) {
  const script = `
    import { armShutdownHardExitWatchdog } from ${JSON.stringify(watchdogModuleUrl)};
    ${source}
  `;
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, VITEST: undefined },
      killSignal: "SIGKILL",
      timeout: CHILD_TIMEOUT_MS,
    },
  );
  return { elapsedMs: Date.now() - startedAt, result };
}

describe("shutdown hard-exit watchdog", () => {
  it("kills a process whose main thread is synchronously blocked", () => {
    const { elapsedMs, result } = runWatchdogChild(`
      armShutdownHardExitWatchdog({
        delayMs: ${WATCHDOG_DELAY_MS},
        onError: (error) => console.error(error),
      });
      while (true) {}
    `);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBe("SIGKILL");
    expect(elapsedMs).toBeLessThan(CHILD_TIMEOUT_MS);
  });

  it("lets a cancelled process survive beyond the deadline and exit cleanly", () => {
    const { elapsedMs, result } = runWatchdogChild(`
      const watchdog = armShutdownHardExitWatchdog({
        delayMs: ${WATCHDOG_DELAY_MS},
        onError: (error) => {
          console.error(error);
          process.exitCode = 2;
        },
      });
      watchdog?.cancel();
      await new Promise((resolve) => setTimeout(resolve, ${WATCHDOG_DELAY_MS * 2}));
    `);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(elapsedMs).toBeGreaterThanOrEqual(WATCHDOG_DELAY_MS * 2);
    expect(elapsedMs).toBeLessThan(CHILD_TIMEOUT_MS);
  });
});
