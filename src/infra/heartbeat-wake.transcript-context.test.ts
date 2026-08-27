import { afterEach, expect, it } from "vitest";
import {
  getOwnedSessionTranscriptWriterFence,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
import { requestHeartbeat, setHeartbeatWakeHandler } from "./heartbeat-wake.js";

let dispose = () => {};

afterEach(() => {
  dispose();
});

// Real timers on purpose: fake timers fire callbacks from the test's own async
// context, so they cannot observe the AsyncLocalStorage inheritance under test.
it("dispatches outside the requesting attempt transcript context", async () => {
  const observedFence = new Promise<ReturnType<typeof getOwnedSessionTranscriptWriterFence>>(
    (resolve) => {
      dispose = setHeartbeatWakeHandler(async () => {
        resolve(getOwnedSessionTranscriptWriterFence());
        return { status: "ran", durationMs: 1 };
      });
    },
  );
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
  expect(await observedFence).toBeUndefined();
});
