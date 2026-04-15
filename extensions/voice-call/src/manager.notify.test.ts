import { describe, expect, it, vi } from "vitest";
import { createManagerHarness, FakeProvider } from "./manager.test-harness.js";

class FailFirstPlayTtsProvider extends FakeProvider {
  private failed = false;

  override async playTts(input: Parameters<FakeProvider["playTts"]>[0]): Promise<void> {
    this.playTtsCalls.push(input);
    if (!this.failed) {
      this.failed = true;
      throw new Error("synthetic tts failure");
    }
  }
}

class DelayedPlayTtsProvider extends FakeProvider {
  private releasePlayTts: (() => void) | null = null;
  private resolvePlayTtsStarted: (() => void) | null = null;
  readonly playTtsStarted = vi.fn();
  readonly playTtsStartedPromise = new Promise<void>((resolve) => {
    this.resolvePlayTtsStarted = resolve;
  });

  override async playTts(input: Parameters<FakeProvider["playTts"]>[0]): Promise<void> {
    this.playTtsCalls.push(input);
    this.playTtsStarted();
    this.resolvePlayTtsStarted?.();
    this.resolvePlayTtsStarted = null;
    await new Promise<void>((resolve) => {
      this.releasePlayTts = resolve;
    });
  }

  releaseCurrentPlayback(): void {
    this.releasePlayTts?.();
    this.releasePlayTts = null;
  }
}

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

function requireMappedCall(
  manager: Awaited<ReturnType<typeof createManagerHarness>>["manager"],
  providerCallId: string,
) {
  const call = manager.getCallByProviderCallId(providerCallId);
  if (!call) {
    throw new Error(`expected mapped provider call ${providerCallId}`);
  }
  return call;
}

function requireFirstPlayTtsCall(provider: FakeProvider) {
  const call = provider.playTtsCalls[0];
  if (!call) {
    throw new Error("expected provider.playTts to be called once");
  }
  return call;
}

describe("CallManager notify and mapping", () => {
  it("upgrades providerCallId mapping when provider ID changes", async () => {
    const { manager } = await createManagerHarness();

    const { callId, success, error } = await manager.initiateCall("+15550000001");
    expect(success).toBe(true);
    expect(error).toBeUndefined();

    expect(requireCall(manager, callId).providerCallId).toBe("request-uuid");
    expect(requireMappedCall(manager, "request-uuid").callId).toBe(callId);

    manager.processEvent({
      id: "evt-1",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    expect(requireCall(manager, callId).providerCallId).toBe("call-uuid");
    expect(requireMappedCall(manager, "call-uuid").callId).toBe(callId);
    expect(manager.getCallByProviderCallId("request-uuid")).toBeUndefined();
  });

  it.each(["plivo", "twilio"] as const)(
    "speaks initial message on answered for notify mode (%s)",
    async (providerName) => {
      const { manager, provider } = await createManagerHarness({}, new FakeProvider(providerName));

      const { callId, success } = await manager.initiateCall("+15550000002", undefined, {
        message: "Hello there",
        mode: "notify",
      });
      expect(success).toBe(true);

      manager.processEvent({
        id: `evt-2-${providerName}`,
        type: "call.answered",
        callId,
        providerCallId: "call-uuid",
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(provider.playTtsCalls).toHaveLength(1);
      expect(requireFirstPlayTtsCall(provider).text).toBe("Hello there");
    },
  );

  it("speaks initial message on answered for conversation mode with non-stream provider", async () => {
    const { manager, provider } = await createManagerHarness({}, new FakeProvider("plivo"));

    const { callId, success } = await manager.initiateCall("+15550000003", undefined, {
      message: "Hello from conversation",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-conversation-plivo",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.playTtsCalls).toHaveLength(1);
    expect(requireFirstPlayTtsCall(provider).text).toBe("Hello from conversation");
  });

  it("speaks initial message on answered for conversation mode when Twilio streaming is disabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: false } },
      new FakeProvider("twilio"),
    );

    const { callId, success } = await manager.initiateCall("+15550000004", undefined, {
      message: "Twilio non-stream",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-conversation-twilio-no-stream",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.playTtsCalls).toHaveLength(1);
    expect(requireFirstPlayTtsCall(provider).text).toBe("Twilio non-stream");
  });

  it("waits for stream connect in conversation mode when Twilio streaming is enabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true } },
      new FakeProvider("twilio"),
    );

    const { callId, success } = await manager.initiateCall("+15550000005", undefined, {
      message: "Twilio stream",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-conversation-twilio-stream",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.playTtsCalls).toHaveLength(0);
  });

  it("speaks on answered when Twilio streaming is enabled but stream-connect path is unavailable", async () => {
    const twilioProvider = new FakeProvider("twilio");
    twilioProvider.twilioStreamConnectEnabled = false;
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true } },
      twilioProvider,
    );

    const { callId, success } = await manager.initiateCall("+15550000009", undefined, {
      message: "Twilio stream unavailable",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-conversation-twilio-stream-unavailable",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.playTtsCalls).toHaveLength(1);
    expect(requireFirstPlayTtsCall(provider).text).toBe("Twilio stream unavailable");
  });

  it("preserves initialMessage after a failed first playback and retries on next trigger", async () => {
    const provider = new FailFirstPlayTtsProvider("plivo");
    const { manager } = await createManagerHarness({}, provider);

    const { callId, success } = await manager.initiateCall("+15550000006", undefined, {
      message: "Retry me",
      mode: "notify",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-retry-1",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const afterFailure = requireCall(manager, callId);
    expect(provider.playTtsCalls).toHaveLength(1);
    expect(afterFailure.metadata).toEqual(expect.objectContaining({ initialMessage: "Retry me" }));
    expect(afterFailure.state).toBe("listening");

    manager.processEvent({
      id: "evt-retry-2",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const afterSuccess = requireCall(manager, callId);
    expect(provider.playTtsCalls).toHaveLength(2);
    expect(afterSuccess.metadata).not.toHaveProperty("initialMessage");
  });

  it("speaks initial message only once on repeated stream-connect triggers", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true } },
      new FakeProvider("twilio"),
    );

    const { callId, success } = await manager.initiateCall("+15550000007", undefined, {
      message: "Stream hello",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-stream-answered",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.playTtsCalls).toHaveLength(0);

    await manager.speakInitialMessage("call-uuid");
    await manager.speakInitialMessage("call-uuid");

    expect(provider.playTtsCalls).toHaveLength(1);
    expect(requireFirstPlayTtsCall(provider).text).toBe("Stream hello");
  });

  it("prevents concurrent initial-message replays while first playback is in flight", async () => {
    const provider = new DelayedPlayTtsProvider("twilio");
    const { manager } = await createManagerHarness({ streaming: { enabled: true } }, provider);

    const { callId, success } = await manager.initiateCall("+15550000008", undefined, {
      message: "In-flight hello",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-stream-answered-concurrent",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.playTtsCalls).toHaveLength(0);

    const first = manager.speakInitialMessage("call-uuid");
    await provider.playTtsStartedPromise;
    expect(provider.playTtsStarted).toHaveBeenCalledTimes(1);

    const second = manager.speakInitialMessage("call-uuid");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.playTtsCalls).toHaveLength(1);

    provider.releaseCurrentPlayback();
    await Promise.all([first, second]);

    const call = requireCall(manager, callId);
    expect(call.metadata).not.toHaveProperty("initialMessage");
    expect(provider.playTtsCalls).toHaveLength(1);
    expect(requireFirstPlayTtsCall(provider).text).toBe("In-flight hello");
  });
});
