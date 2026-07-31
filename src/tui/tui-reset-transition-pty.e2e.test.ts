import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  objectFieldEquals,
  readFixtureLog,
  waitForFixtureLogEntry,
  writeTuiPtyFixtureScript,
} from "./tui-pty-harness-fixture-test-support.js";
import { startPty } from "./tui-pty-test-support.js";

const STARTUP_TIMEOUT_MS = 20_000;
const OUTPUT_TIMEOUT_MS = 2_000;
const EXIT_TIMEOUT_MS = 4_000;
const TEST_TIMEOUT_MS = 25_000;

describe("TUI reset transition PTY", () => {
  it(
    "preserves overlapping input while /reset owns the terminal session transition",
    async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-reset-pty-"));
      const scriptPath = await writeTuiPtyFixtureScript(tempDir);
      const logPath = path.join(tempDir, "fixture-log.jsonl");
      const resetReleasePath = path.join(tempDir, "release-reset-session");
      const run = startPty(process.execPath, ["--import", "tsx", scriptPath], {
        cwd: process.cwd(),
        env: {
          OPENCLAW_THEME: "dark",
          OPENCLAW_TUI_PTY_LOG_PATH: logPath,
          OPENCLAW_TUI_PTY_RESET_RELEASE_PATH: resetReleasePath,
          TERM_PROGRAM: "Apple_Terminal",
          NO_COLOR: undefined,
        },
        exitTimeoutMs: EXIT_TIMEOUT_MS,
        outputTimeoutMs: OUTPUT_TIMEOUT_MS,
      });

      try {
        const waitForLogEntry = async (predicate: Parameters<typeof waitForFixtureLogEntry>[1]) =>
          await waitForFixtureLogEntry(logPath, predicate, OUTPUT_TIMEOUT_MS, run.output);

        await run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await run.write("/reset\r", { delay: false });
        await waitForLogEntry(
          (entry) => entry.method === "resetSession" && objectFieldEquals(entry, "reason", "reset"),
        );

        await run.write("overlap during reset\rnewer suffix", { delay: false });
        // Release before the 50ms paste coalescer flushes. Admission must use
        // the transition snapshot captured when Enter arrived, not live state.
        await writeFile(resetReleasePath, "released\n", "utf8");
        await run.waitForOutput("session main (Reset session after)");
        await run.waitForOutput("session change in progress; wait for /reset to finish");

        await run.write("\r", { delay: false });
        await waitForLogEntry(
          (entry) =>
            entry.method === "sendChat" &&
            objectFieldEquals(entry, "message", "overlap during reset\nnewer suffix"),
        );
        await run.waitForOutput("PTY_RESPONSE: overlap during reset");

        const sends = (await readFixtureLog(logPath)).filter(
          (entry) => entry.method === "sendChat",
        );
        expect(sends).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({ message: "overlap during reset\nnewer suffix" }),
          }),
        ]);
        console.info(
          "[behavior-evidence] tui-reset-transition",
          JSON.stringify({
            terminal: "real PTY",
            overlappingInputPreserved: true,
            resetCompleted: true,
            preservedInputDelivered: true,
          }),
        );

        await run.write("/exit\r", { delay: false });
        expect((await run.waitForExit()).exitCode).toBe(0);
      } finally {
        await run.dispose();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
