import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createManagerHarness, FakeProvider } from "./manager.test-harness.js";
import type { HangupCallInput } from "./types.js";

class DeferredHangupProvider extends FakeProvider {
  readonly attempts: Array<ReturnType<typeof createDeferred<void>>> = [];

  override hangupCall(input: HangupCallInput): Promise<void> {
    this.hangupCalls.push(input);
    const attempt = createDeferred<void>();
    this.attempts.push(attempt);
    return attempt.promise;
  }
}

async function initiateCall() {
  const provider = new DeferredHangupProvider();
  const { manager } = await createManagerHarness({}, provider);
  const result = await manager.initiateCall("+15550000001");
  expect(result.success).toBe(true);
  const call = manager.getCall(result.callId);
  if (!call) {
    throw new Error("expected initiated call");
  }
  return { call, manager, provider };
}

describe("CallManager termination lifecycle", () => {
  it("preserves the first provider terminal facts when a pending manager hangup settles", async () => {
    const { call, manager, provider } = await initiateCall();
    const endedAt = Date.now() + 1_000;

    const pendingEnd = manager.endCall(call.callId, { reason: "timeout" });
    expect(provider.attempts).toHaveLength(1);

    manager.processEvent({
      id: "provider-terminal",
      type: "call.ended",
      callId: call.callId,
      providerCallId: call.providerCallId,
      timestamp: endedAt,
      reason: "completed",
    });
    provider.attempts[0]?.resolve();

    await expect(pendingEnd).resolves.toEqual({ success: true });
    expect(call).toMatchObject({
      state: "completed",
      endReason: "completed",
      endedAt,
    });
  });

  it("shares one carrier hangup result and releases a failed operation for retry", async () => {
    const { call, manager, provider } = await initiateCall();

    const first = manager.endCall(call.callId, { reason: "error" });
    const second = manager.endCall(call.callId, { reason: "error" });
    const firstAttemptCount = provider.attempts.length;
    for (const attempt of provider.attempts) {
      attempt.reject(new Error("carrier unavailable"));
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);

    const retry = manager.endCall(call.callId, { reason: "error" });
    const retryAttempt = provider.attempts.at(-1);
    if (!retryAttempt) {
      throw new Error("expected retry hangup attempt");
    }
    retryAttempt.resolve();
    await expect(retry).resolves.toEqual({ success: true });

    expect(second).toBe(first);
    expect(firstAttemptCount).toBe(1);
    expect(secondResult).toBe(firstResult);
    expect(firstResult).toEqual({ success: false, error: "carrier unavailable" });
    expect(provider.hangupCalls).toHaveLength(2);
  });
});
