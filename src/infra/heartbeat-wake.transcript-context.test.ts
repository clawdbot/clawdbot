import { afterEach, expect, it, vi } from "vitest";
import {
  getOwnedSessionTranscriptWriterFence,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
import { requestHeartbeat, setHeartbeatWakeHandler } from "./heartbeat-wake.js";

let dispose = () => {};

afterEach(async () => {
  dispose();
  const disposeDrainHandler = setHeartbeatWakeHandler(async () => ({
    status: "skipped",
    reason: "disabled",
  }));
  await vi.runAllTimersAsync();
  disposeDrainHandler();
  vi.useRealTimers();
});

it("dispatches outside the requesting attempt transcript context", async () => {
  vi.useFakeTimers();
  let observedFence: ReturnType<typeof getOwnedSessionTranscriptWriterFence> | "not-called" =
    "not-called";
  dispose = setHeartbeatWakeHandler(async () => {
    observedFence = getOwnedSessionTranscriptWriterFence();
    return { status: "ran", durationMs: 1 };
  });
  await withOwnedSessionTranscriptWrites(
    {
      sessionTarget: { expectedWriterRunId: "disposed-requesting-run" },
      withTranscriptWrite: async (run) => await run(),
    },
    async () =>
      requestHeartbeat({
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        coalesceMs: 0,
      }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(observedFence).toBeUndefined();
});
