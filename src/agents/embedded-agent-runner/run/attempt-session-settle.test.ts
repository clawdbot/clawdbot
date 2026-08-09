import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../sessions/index.js";
import { createEmbeddedAttemptSessionSettleTracker } from "./attempt-session-settle.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createEmbeddedAttemptSessionSettleTracker", () => {
  it("waits for both prompt and abort settlement during cleanup", async () => {
    const prompt = deferred();
    const abort = deferred();
    const abortSession = vi.fn(() => abort.promise);
    const tracker = createEmbeddedAttemptSessionSettleTracker({
      abort: abortSession,
    } as unknown as Pick<AgentSession, "abort">);

    void tracker.trackPromptSettlePromise(prompt.promise);
    const abortReason = new Error("stop");
    void tracker.abortActiveSession(abortReason);
    const settled = tracker.buildAbortSettlePromise();
    expect(settled).not.toBeNull();
    expect(abortSession).toHaveBeenCalledWith(abortReason);

    let finished = false;
    void settled?.then(() => {
      finished = true;
    });
    prompt.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);

    abort.resolve();
    await settled;
    expect(finished).toBe(true);
    expect(tracker.buildAbortSettlePromise()).toBeNull();
  });

  it("settles rejected prompt work without leaking it into later cleanup", async () => {
    const tracker = createEmbeddedAttemptSessionSettleTracker({
      abort: async () => undefined,
    } as unknown as Pick<AgentSession, "abort">);
    void tracker.trackPromptSettlePromise(Promise.reject(new Error("prompt failed")));

    await expect(tracker.buildAbortSettlePromise()).resolves.toBeUndefined();
    expect(tracker.buildAbortSettlePromise()).toBeNull();
  });
});
