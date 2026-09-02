import { describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import {
  createHarness,
  event,
  persistedLiveDigest,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

const cases = [
  ["persistence", "session observer digest persistence failed"],
  ["terminal", "session observer terminal digest synthesis failed"],
  ["model", "session observer disabled after consecutive failures"],
] as const;

describe("session observer JSON diagnostics", () => {
  it.each(cases)("preserves the cause of a %s failure", async (kind, message) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const previousConsole = loggingState.rawConsole;
    const previousOverride = loggingState.overrideSettings;
    const lines: string[] = [];
    const capture = (line: unknown) => lines.push(String(line));
    const cause = new Error(`${kind} failed`);
    const harness = createHarness({
      subscribe: kind !== "terminal",
      completeModel: vi.fn(async () => {
        throw cause;
      }),
      persistDigest: vi.fn(async () => {
        throw cause;
      }),
      ...(kind === "terminal"
        ? {
            readSession: vi.fn(() => ({
              sessionId: "session-id",
              updatedAt: 0,
              observerDigest: persistedLiveDigest(),
            })),
          }
        : {}),
    });
    try {
      setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
      loggingState.rawConsole = { log: capture, info: capture, warn: capture, error: capture };
      if (kind === "terminal") {
        harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "end" } }));
      } else if (kind === "persistence") {
        harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
        harness.observer.handleEvent(
          event({
            stream: "item",
            data: { kind: "preamble", phase: "update", progressText: "Inspecting the output" },
          }),
        );
      } else {
        startAndAddToolNotes(harness.observer);
      }
      await vi.advanceTimersByTimeAsync(kind === "model" ? 24_000 : 0);
      const diagnostic = lines
        .map((line) => JSON.parse(line))
        .find((line) => line.message === message);
      expect(diagnostic).toMatchObject({
        level: "warn",
        subsystem: "gateway/session-observer",
        runId: "run-1",
        error: `${kind} failed`,
      });
    } finally {
      harness.observer.dispose();
      loggingState.rawConsole = previousConsole;
      setLoggerOverride(previousOverride as Parameters<typeof setLoggerOverride>[0]);
      vi.useRealTimers();
    }
  });
});
