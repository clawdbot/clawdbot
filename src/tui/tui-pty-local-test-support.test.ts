import { describe, expect, it } from "vitest";
import { createDeferred } from "../test-utils/deferred.js";
import {
  cleanupStartedFixture,
  createChatTerminalObserver,
  createFreshSession,
  registerIdempotentCleanup,
} from "./tui-pty-local-test-support.js";
import type { PtyRun } from "./tui-pty-test-support.js";

const SUBMISSION_SETTLE_MS = 150;
const SESSION_ROLLOVER_BUSY_MESSAGE = "abort the current run before /new";

describe("local TUI PTY fixture support", () => {
  it("registers idempotent cleanup before fallible fixture setup", async () => {
    const order: string[] = [];
    let registeredCleanup: (() => Promise<void>) | undefined;
    const setupError = new Error("setup failed");
    let cleanupCalls = 0;

    await expect(
      (async () => {
        const cleanup = registerIdempotentCleanup(
          (registered) => {
            order.push("registered");
            registeredCleanup = registered;
          },
          async () => {
            cleanupCalls += 1;
            order.push("cleanup");
          },
        );
        try {
          order.push("setup");
          throw setupError;
        } finally {
          await cleanup();
        }
      })(),
    ).rejects.toBe(setupError);
    await registeredCleanup!();

    expect(order).toEqual(["registered", "setup", "cleanup"]);
    expect(cleanupCalls).toBe(1);
  });

  it("waits for the matching successful terminal event before history observation", async () => {
    const observer = createChatTerminalObserver();
    const terminal = observer.waitForFinal({
      runId: "run-history",
      sessionKey: "agent:main:history",
      timeoutMs: 1_000,
    });

    observer.onEvent({
      event: "chat",
      payload: {
        runId: "run-history",
        sessionKey: "agent:main:history",
        state: "delta",
      },
    });
    observer.onEvent({
      event: "chat",
      payload: {
        runId: "run-other",
        sessionKey: "agent:main:history",
        state: "final",
      },
    });
    observer.onEvent({
      event: "chat",
      payload: {
        runId: "run-history",
        sessionKey: "agent:main:history",
        state: "final",
      },
    });

    await expect(terminal).resolves.toMatchObject({ state: "final" });
  });

  it("fails promptly when the observed chat run terminates with an error", async () => {
    const observer = createChatTerminalObserver();
    observer.onEvent({
      event: "chat",
      payload: {
        errorMessage: "provider failed",
        runId: "run-history",
        sessionKey: "agent:main:history",
        state: "error",
      },
    });

    await expect(
      observer.waitForFinal({
        runId: "run-history",
        sessionKey: "agent:main:history",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("chat run run-history ended as error: provider failed");
  });

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
