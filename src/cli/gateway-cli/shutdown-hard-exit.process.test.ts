// Process-boundary proof that the hard-exit watchdog survives main-thread starvation.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const WATCHDOG_DELAY_MS = 100;
const CHILD_TIMEOUT_MS = 3_000;
const watchdogModuleUrl = pathToFileURL(
  path.resolve("src/cli/gateway-cli/shutdown-hard-exit.ts"),
).href;

function runWatchdogChild() {
  const script = `
    import { writeSync } from "node:fs";
    import { armShutdownHardExitWatchdog } from ${JSON.stringify(watchdogModuleUrl)};

    const fail = (message) => {
      writeSync(2, \`error:\${message}\\n\`);
      process.exit(2);
    };
    const firstWatchdog = armShutdownHardExitWatchdog({
      delayMs: ${WATCHDOG_DELAY_MS},
      onError: (error) => fail(String(error)),
    });
    if (firstWatchdog === null) {
      fail("first-watchdog-not-armed");
    }
    firstWatchdog.cancel();
    await new Promise((resolve) => setTimeout(resolve, ${WATCHDOG_DELAY_MS * 2}));
    writeSync(1, "cancelled-watchdog-deadline-survived\\n");

    process.once("beforeExit", () => {
      // Reaching beforeExit proves the cancelled worker no longer retains process liveness.
      writeSync(1, "cancelled-watchdog-released-liveness\\n");
      const secondWatchdog = armShutdownHardExitWatchdog({
        delayMs: ${WATCHDOG_DELAY_MS},
        onError: (error) => fail(String(error)),
      });
      if (secondWatchdog === null) {
        fail("second-watchdog-not-armed");
      }
      writeSync(1, "second-watchdog-armed\\n");
      while (true) {}
    });
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

it("cancels one watchdog before another kills a blocked main thread", () => {
  const { elapsedMs, result } = runWatchdogChild();
  const diagnostics = JSON.stringify(
    {
      elapsedMs,
      status: result.status,
      signal: result.signal,
      error: result.error ? String(result.error) : undefined,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    null,
    2,
  );
  const markers = [
    "cancelled-watchdog-deadline-survived",
    "cancelled-watchdog-released-liveness",
    "second-watchdog-armed",
  ];
  let previousMarkerIndex = -1;
  for (const marker of markers) {
    const markerIndex = result.stdout.indexOf(marker);
    expect(markerIndex, diagnostics).toBeGreaterThan(previousMarkerIndex);
    previousMarkerIndex = markerIndex;
  }

  expect(result.error, diagnostics).toBeUndefined();
  expect(result.status, diagnostics).toBeNull();
  expect(result.signal, diagnostics).toBe("SIGKILL");
  expect(elapsedMs, diagnostics).toBeLessThan(CHILD_TIMEOUT_MS);
});
