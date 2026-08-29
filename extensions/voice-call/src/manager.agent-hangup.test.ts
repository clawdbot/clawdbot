// Voice Call tests cover agent-requested hangup timing after playback.
import { describe, expect, it, vi } from "vitest";
import { createManagerHarness, FakeProvider, markCallAnswered } from "./manager.test-harness.js";

async function answeredCall(manager: Awaited<ReturnType<typeof createManagerHarness>>["manager"]) {
  const { callId } = await manager.initiateCall("+15550000020");
  if (!callId) {
    throw new Error("expected an initiated call");
  }
  markCallAnswered(manager, callId, "evt-agent-hangup-answered");
  return callId;
}

describe("CallManager agent-requested hangup", () => {
  it("hangs up without a grace delay when the provider confirms playback drain", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider("plivo");
      const { manager } = await createManagerHarness(
        { outbound: { notifyHangupDelaySec: 5 } },
        provider,
      );
      const callId = await answeredCall(manager);

      manager.endCallAfterPlayback(callId, "Agent hangup", "confirmed");
      await vi.advanceTimersByTimeAsync(0);

      expect(provider.hangupCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits the notify grace when the provider only acknowledges playback requests", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider("plivo");
      const { manager } = await createManagerHarness(
        { outbound: { notifyHangupDelaySec: 3 } },
        provider,
      );
      const callId = await answeredCall(manager);

      manager.endCallAfterPlayback(callId, "Agent hangup", "unconfirmed");
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.hangupCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(provider.hangupCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a hangup request for a call that already ended", async () => {
    const provider = new FakeProvider("plivo");
    const { manager } = await createManagerHarness({}, provider);
    const callId = await answeredCall(manager);
    await manager.endCall(callId);
    const hangupsAfterEnd = provider.hangupCalls.length;

    manager.endCallAfterPlayback(callId, "Agent hangup", "confirmed");

    expect(provider.hangupCalls).toHaveLength(hangupsAfterEnd);
  });

  it("keeps the line open when the caller barges in over the closing reply", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider("plivo");
      const { manager } = await createManagerHarness(
        { outbound: { notifyHangupDelaySec: 1 } },
        provider,
      );
      const callId = await answeredCall(manager);

      manager.endCallAfterPlayback(callId, "Agent hangup", "cancelled");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(provider.hangupCalls).toHaveLength(0);
      expect(manager.getCall(callId)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
