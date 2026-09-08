// A fallback candidate must not inherit a run budget the primary already spent.
import { describe, expect, it, vi } from "vitest";
import {
  registerChatAbortController,
  type ChatAbortControllerEntry,
} from "../gateway/chat-abort.js";
import { resetAgentRunDeadlineRenewersForTest } from "../infra/agent-run-deadline.js";
import { FailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";

const TIMEOUT_MS = 60_000;
const RUN_ID = "run-deadline-renewal";

function registerExecutingChatSendRun(entries: Map<string, ChatAbortControllerEntry>, now: number) {
  const registration = registerChatAbortController({
    chatAbortControllers: entries,
    runId: RUN_ID,
    sessionId: "session-1",
    sessionKey: "agent:main",
    timeoutMs: TIMEOUT_MS,
    kind: "chat-send",
    // Admitted a full timeout ago: the primary candidate has already spent the
    // whole-run budget, leaving only the abort grace window.
    now: now - TIMEOUT_MS,
  });
  expect(registration.registered).toBe(true);
  registration.markExecutionStarted();
  return registration;
}

describe("model fallback run deadline", () => {
  it("gives a fallback candidate its own run budget after the primary spent it", async () => {
    resetAgentRunDeadlineRenewersForTest();
    const entries = new Map<string, ChatAbortControllerEntry>();
    const now = Date.now();
    registerExecutingChatSendRun(entries, now);
    const entry = entries.get(RUN_ID);
    expect(entry).toBeDefined();
    // chat-send runs get no deadline refresh at execution start, so the entry
    // enters the fallback chain holding only the grace window.
    expect((entry?.expiresAtMs ?? 0) - now).toBeLessThanOrEqual(TIMEOUT_MS);

    let remainingAtFallbackMs = 0;
    const run = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new FailoverError("primary timed out", { reason: "timeout" });
      })
      .mockImplementationOnce(() => {
        remainingAtFallbackMs = (entries.get(RUN_ID)?.expiresAtMs ?? 0) - Date.now();
        return Promise.resolve("ok");
      });

    const result = await runWithModelFallback({
      cfg: createModelFallbackConfig("openai/m1", ["anthropic/m2"]),
      provider: "openai",
      model: "m1",
      runId: RUN_ID,
      manifestPlugins: [],
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    // Without renewal the fallback candidate starts with only the abort grace
    // and is killed by the run deadline instead of being given a real attempt.
    expect(remainingAtFallbackMs).toBeGreaterThan(TIMEOUT_MS);
  });

  it("leaves runs without a registered owner on their existing deadline", async () => {
    resetAgentRunDeadlineRenewersForTest();
    const run = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new FailoverError("primary timed out", { reason: "timeout" });
      })
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg: createModelFallbackConfig("openai/m1", ["anthropic/m2"]),
      provider: "openai",
      model: "m1",
      runId: "unowned-run",
      manifestPlugins: [],
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
