import { describe, expect, it, vi } from "vitest";
import { createManagerHarness, FakeProvider, markCallAnswered } from "./manager.test-harness.js";

function requireCall(
  manager: Awaited<ReturnType<typeof createManagerHarness>>["manager"],
  callId: string,
) {
  const call = manager.getCall(callId);
  if (!call) {
    throw new Error(`expected active call ${callId}`);
  }
  return call;
}

function requireTurnToken(provider: Awaited<ReturnType<typeof createManagerHarness>>["provider"]) {
  const firstStart = provider.startListeningCalls[0];
  if (!firstStart?.turnToken) {
    throw new Error("expected closed-loop turn to capture a turn token");
  }
  return firstStart.turnToken;
}

function expectTranscriptWaiter(
  manager: Awaited<ReturnType<typeof createManagerHarness>>["manager"],
  callId: string,
) {
  const waiters = (
    manager as unknown as {
      transcriptWaiters: Map<string, unknown>;
    }
  ).transcriptWaiters;
  expect(waiters.has(callId)).toBe(true);
}

describe("CallManager closed-loop turns", () => {
  it("completes a closed-loop turn without live audio", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000003");
    expect(started.success).toBe(true);

    markCallAnswered(manager, started.callId, "evt-closed-loop-answered");

    const turnPromise = manager.continueCall(started.callId, "How can I help?");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });

    manager.processEvent({
      id: "evt-closed-loop-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Please check status",
      isFinal: true,
    });

    const turn = await turnPromise;
    expect(turn.success).toBe(true);
    expect(turn.transcript).toBe("Please check status");
    expect(provider.startListeningCalls).toHaveLength(1);
    expect(provider.stopListeningCalls).toHaveLength(1);

    const call = requireCall(manager, started.callId);
    expect(call.transcript.map((entry) => entry.text)).toEqual([
      "How can I help?",
      "Please check status",
    ]);
    const metadata = call.metadata ?? {};
    expect(typeof metadata.lastTurnLatencyMs).toBe("number");
    expect(typeof metadata.lastTurnListenWaitMs).toBe("number");
    expect(metadata.turnCount).toBe(1);
  });

  it("rejects overlapping continueCall requests for the same call", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000004");
    expect(started.success).toBe(true);

    markCallAnswered(manager, started.callId, "evt-overlap-answered");

    const first = manager.continueCall(started.callId, "First prompt");
    const second = await manager.continueCall(started.callId, "Second prompt");
    expect(second.success).toBe(false);
    expect(second.error).toBe("Already waiting for transcript");

    manager.processEvent({
      id: "evt-overlap-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Done",
      isFinal: true,
    });

    const firstResult = await first;
    expect(firstResult.success).toBe(true);
    expect(firstResult.transcript).toBe("Done");
    expect(provider.startListeningCalls).toHaveLength(1);
    expect(provider.stopListeningCalls).toHaveLength(1);
  });

  it("ignores speech events with mismatched turnToken while waiting for transcript", async () => {
    const { manager, provider } = await createManagerHarness(
      {
        transcriptTimeoutMs: 5000,
      },
      new FakeProvider("twilio"),
    );

    const started = await manager.initiateCall("+15550000004");
    expect(started.success).toBe(true);

    markCallAnswered(manager, started.callId, "evt-turn-token-answered");

    const turnPromise = manager.continueCall(started.callId, "Prompt");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });

    const expectedTurnToken = requireTurnToken(provider);

    manager.processEvent({
      id: "evt-turn-token-bad",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "stale replay",
      isFinal: true,
      turnToken: "wrong-token",
    });

    expectTranscriptWaiter(manager, started.callId);

    manager.processEvent({
      id: "evt-turn-token-good",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "final answer",
      isFinal: true,
      turnToken: expectedTurnToken,
    });

    const turnResult = await turnPromise;
    expect(turnResult.success).toBe(true);
    expect(turnResult.transcript).toBe("final answer");

    const call = requireCall(manager, started.callId);
    expect(call.transcript.map((entry) => entry.text)).toEqual(["Prompt", "final answer"]);
  });

  it("tracks latency metadata across multiple closed-loop turns", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000005");
    expect(started.success).toBe(true);

    markCallAnswered(manager, started.callId, "evt-multi-answered");

    const firstTurn = manager.continueCall(started.callId, "First question");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });
    manager.processEvent({
      id: "evt-multi-speech-1",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "First answer",
      isFinal: true,
    });
    await firstTurn;

    const secondTurn = manager.continueCall(started.callId, "Second question");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(2);
      expectTranscriptWaiter(manager, started.callId);
    });
    manager.processEvent({
      id: "evt-multi-speech-2",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Second answer",
      isFinal: true,
    });
    const secondResult = await secondTurn;

    expect(secondResult.success).toBe(true);

    const call = requireCall(manager, started.callId);
    expect(call.transcript.map((entry) => entry.text)).toEqual([
      "First question",
      "First answer",
      "Second question",
      "Second answer",
    ]);
    const metadata = call.metadata ?? {};
    expect(metadata.turnCount).toBe(2);
    expect(typeof metadata.lastTurnLatencyMs).toBe("number");
    expect(typeof metadata.lastTurnListenWaitMs).toBe("number");
    expect(provider.startListeningCalls).toHaveLength(2);
    expect(provider.stopListeningCalls).toHaveLength(2);
  });

  it("handles repeated closed-loop turns without waiter churn", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000006");
    expect(started.success).toBe(true);

    markCallAnswered(manager, started.callId, "evt-loop-answered");

    for (let i = 1; i <= 5; i++) {
      const turnPromise = manager.continueCall(started.callId, `Prompt ${i}`);
      await vi.waitFor(() => {
        expect(provider.startListeningCalls).toHaveLength(i);
        expectTranscriptWaiter(manager, started.callId);
      });
      manager.processEvent({
        id: `evt-loop-speech-${i}`,
        type: "call.speech",
        callId: started.callId,
        providerCallId: "request-uuid",
        timestamp: Date.now(),
        transcript: `Answer ${i}`,
        isFinal: true,
      });
      const result = await turnPromise;
      expect(result.success).toBe(true);
      expect(result.transcript).toBe(`Answer ${i}`);
    }

    const call = requireCall(manager, started.callId);
    const metadata = call.metadata ?? {};
    expect(metadata.turnCount).toBe(5);
    expect(provider.startListeningCalls).toHaveLength(5);
    expect(provider.stopListeningCalls).toHaveLength(5);
  });
});
