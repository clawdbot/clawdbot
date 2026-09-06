import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  objectFieldEquals,
  readFixtureLog,
  startTuiFixture,
  waitForFixtureLogEntry,
  waitForSynchronizedFrameRows,
  writeTuiPtyFixtureScript,
} from "./tui-pty-harness-fixture-test-support.js";
import { startPty } from "./tui-pty-test-support.js";

const STARTUP_TIMEOUT_MS = 20_000;
const OUTPUT_TIMEOUT_MS = 2_000;
const EXIT_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 25_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it(
  "keeps multiline exit paste in chat and preserves shared stop behavior",
  async () => {
    const stateDir = tempDirs.make("openclaw-tui-input-pty-");
    const fixture = await startTuiFixture({
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_OFFLINE: "1",
      },
    });
    try {
      await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
      await fixture.run.write("\u001b[200~/exit\n\u001b[201~\r", { delay: false });
      await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => frame.some((row) => row.includes("PTY_RESPONSE: /exit")),
        OUTPUT_TIMEOUT_MS,
      );
      await fixture.run.write("  ordinary input  \r", { delay: false });
      const rows = await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => frame.some((row) => row.includes("PTY_RESPONSE: ordinary input")),
        OUTPUT_TIMEOUT_MS,
      );
      await fixture.run.write("\u001b[200~/stop\n\u001b[201~\r", { delay: false });
      await fixture.waitForLogEntry((entry) => entry.method === "abortChat");
      const sends = (await readFixtureLog(fixture.logPath)).filter(
        (entry) => entry.method === "sendChat",
      );
      expect(sends).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ message: "/exit" }) }),
        expect.objectContaining({
          payload: expect.objectContaining({ message: "ordinary input" }),
        }),
      ]);
      console.info("[behavior-evidence] tui-multiline-exit", JSON.stringify({ rows, sends }));
      await fixture.run.write("/exit\r", { delay: false });
      expect((await fixture.run.waitForExit()).exitCode).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);

describe.each([
  { input: "typed suffix", nativePaste: false },
  { input: "large paste with default macOS coalescing", nativePaste: true },
])("TUI reset transition PTY ($input)", ({ nativePaste }) => {
  it.skipIf(nativePaste && process.platform !== "darwin")(
    "preserves overlapping input while /reset owns the terminal session transition",
    async () => {
      const tempDir = tempDirs.make("openclaw-tui-reset-pty-");
      const scriptPath = await writeTuiPtyFixtureScript(tempDir);
      const logPath = path.join(tempDir, "fixture-log.jsonl");
      const resetReleasePath = path.join(tempDir, "release-reset-session");
      const newerDraft = nativePaste
        ? Array.from({ length: 11 }, (_, index) => `line-${index}`).join("\n")
        : "newer suffix";
      const preservedDraft = `overlap during reset\n${newerDraft}`;
      const run = startPty(process.execPath, ["--import", "tsx", scriptPath], {
        cwd: process.cwd(),
        env: {
          OPENCLAW_THEME: "dark",
          OPENCLAW_TUI_PTY_LOG_PATH: logPath,
          OPENCLAW_TUI_PTY_RESET_RELEASE_PATH: resetReleasePath,
          OPENCLAW_TUI_PTY_SUBMIT_BURST_WINDOW_MS: nativePaste ? undefined : "1000",
          OPENCLAW_TUI_PTY_TYPE_CHUNK_SIZE: "1",
          OPENCLAW_TUI_PTY_TYPE_DELAY_MS: "2",
          // Emulate iTerm for Darwin's default coalescing, without Apple Terminal's
          // host modifier-state lookup for synthetic Return.
          TERM_PROGRAM: nativePaste ? "iTerm.app" : undefined,
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
        if (nativePaste) {
          await run.write(`overlap during reset\r\u001b[200~${newerDraft}\u001b[201~`, {
            delay: false,
          });
          await run.waitForOutput("session change in progress; wait for /reset to finish");
          expect(
            (await readFixtureLog(logPath)).filter((entry) => entry.method === "sendChat"),
          ).toEqual([]);
        } else {
          await run.write("overlap during reset\r");
          await waitForLogEntry(
            (entry) =>
              entry.method === "submitBurstCaptured" &&
              objectFieldEquals(entry, "value", "overlap during reset"),
          );
          await run.write(newerDraft);
          // Release before the controlled paste coalescer flushes. Admission must use
          // the transition snapshot captured when Enter arrived, not live state.
        }
        await writeFile(resetReleasePath, "released\n", "utf8");
        await run.waitForOutput("session main (Reset session after)");
        if (!nativePaste) {
          await run.waitForOutput(preservedDraft, 7_000);
        }

        await run.write("\r", { delay: false });
        await waitForLogEntry(
          (entry) =>
            entry.method === "sendChat" &&
            (nativePaste || objectFieldEquals(entry, "message", preservedDraft)),
        );
        await run.waitForOutput("PTY_RESPONSE: overlap during reset", 7_000);

        const sends = (await readFixtureLog(logPath)).filter(
          (entry) => entry.method === "sendChat",
        );
        expect(sends).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({ message: preservedDraft }),
          }),
        ]);
        if (nativePaste) {
          await run.waitForOutput("line-10");
        }
        console.info(
          "[behavior-evidence] tui-reset-transition",
          JSON.stringify({
            terminal: "real PTY",
            overlappingInputPreserved: true,
            resetCompleted: true,
            preservedInputDelivered: true,
          }),
        );
      } finally {
        await run.forceKill();
        await run.dispose();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
