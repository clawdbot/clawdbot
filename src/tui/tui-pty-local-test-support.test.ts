import { describe, expect, it } from "vitest";
import { createDeferred } from "../test-utils/deferred.js";
import { cleanupStartedFixture, createFreshSession } from "./tui-pty-local-test-support.js";
import type { PtyRun } from "./tui-pty-test-support.js";

const SUBMISSION_SETTLE_MS = 150;
const SESSION_ROLLOVER_BUSY_MESSAGE = "abort the current run before /new";

describe("local TUI PTY fixture support", () => {
  it("owns late fixture startup without swallowing cleanup failures", async () => {
    await expect(cleanupStartedFixture(Promise.reject(new Error("setup failed")))).resolves.toBe(
      undefined,
    );

    const cleanupError = new Error("cleanup failed");
    const fixture = {
      cleanup: async () => {
        throw cleanupError;
      },
    };
    await expect(cleanupStartedFixture(Promise.resolve(fixture))).rejects.toBe(cleanupError);
  });

  it("does not replay a session rollover when an old busy notice is redrawn", async () => {
    const newSessionPrefix = "new session: agent:main:tui-";
    const acceptedSession = createDeferred();
    const writes: string[] = [];
    let output = "";
    let acceptanceTimer: ReturnType<typeof setTimeout> | undefined;
    const run = {
      cols: 100,
      output: () => output,
      rows: 30,
      visibleOutput: () => output.replace(/\s+/gu, " "),
      write: async (data: string) => {
        writes.push(data);
        if (writes.length === 1) {
          output += `${SESSION_ROLLOVER_BUSY_MESSAGE}\n`;
          acceptanceTimer = setTimeout(() => {
            output += `${newSessionPrefix}accepted\nlocal ready | idle\n`;
            acceptedSession.resolve();
          }, SUBMISSION_SETTLE_MS + 50);
          return;
        }
        output += `${newSessionPrefix}duplicate\nlocal ready | idle\n`;
      },
      waitForOutput: async () => output,
      waitForExit: async () => ({ exitCode: 0, signal: 0 }),
      forceKill: async () => {},
      dispose: async () => {},
    } satisfies PtyRun;

    try {
      await createFreshSession(run, newSessionPrefix);
      await acceptedSession.promise;
      expect(writes).toEqual(["/new\r"]);
    } finally {
      if (acceptanceTimer) {
        clearTimeout(acceptanceTimer);
      }
    }
  });
});
