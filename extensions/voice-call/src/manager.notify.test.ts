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

class FailStartListeningProvider extends FakeProvider {
  override async startListening(
    input: Parameters<FakeProvider["startListening"]>[0],
  ): Promise<void> {
    this.startListeningCalls.push(input);
    throw new Error("synthetic start listening failure");
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

type HarnessManager = Awaited<ReturnType<typeof createManagerHarness>>["manager"];

async function waitForPlaybackDispatch() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function initiateCallWithMessage(
  manager: HarnessManager,
  to: string,
  message: string,
  mode: "notify" | "conversation",
) {
  const { callId, success } = await manager.initiateCall(to, undefined, { message, mode });
  expect(success).toBe(true);
  return callId;
}

async function answerCall(
  manager: HarnessManager,
  callId: string,
  eventId: string,
  providerCallId = "call-uuid",
) {
  manager.processEvent({
    id: eventId,
    type: "call.answered",
    callId,
    providerCallId,
    timestamp: Date.now(),
  });
  await waitForPlaybackDispatch();
}

function expectFirstPlayTtsText(provider: FakeProvider, text: string) {
  expect(provider.playTtsCalls).toHaveLength(1);
  expect(requireFirstPlayTtsCall(provider).text).toBe(text);
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

      const callId = await initiateCallWithMessage(
        manager,
        "+15550000002",
        "Hello there",
        "notify",
      );
      await answerCall(manager, callId, `evt-2-${providerName}`);

      expectFirstPlayTtsText(provider, "Hello there");
    },
  );

  it("speaks initial message on answered for conversation mode with non-stream provider", async () => {
    const { manager, provider } = await createManagerHarness({}, new FakeProvider("plivo"));

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000003",
      "Hello from conversation",
      "conversation",
    );
    await answerCall(manager, callId, "evt-conversation-plivo");

    expectFirstPlayTtsText(provider, "Hello from conversation");
  });

  it("speaks initial message on answered for conversation mode when Twilio streaming is disabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: false } },
      new FakeProvider("twilio"),
    );

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000004",
      "Twilio non-stream",
      "conversation",
    );
    await answerCall(manager, callId, "evt-conversation-twilio-no-stream");

    expectFirstPlayTtsText(provider, "Twilio non-stream");
  });

  it("lets realtime conversations own the initial greeting instead of posting legacy TwiML", async () => {
    const { manager, provider } = await createManagerHarness(
      { realtime: { enabled: true, provider: "openai" } },
      new FakeProvider("twilio"),
    );

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000010",
      "Tell Nana dinner is at 6pm.",
      "conversation",
    );
    await answerCall(manager, callId, "evt-conversation-twilio-realtime");

    expect(provider.playTtsCalls).toHaveLength(0);
    expect(requireCall(manager, callId).metadata).toEqual(
      expect.objectContaining({ initialMessage: "Tell Nana dinner is at 6pm." }),
    );
  });

  it("still speaks initial message in notify mode when realtime is enabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { realtime: { enabled: true, provider: "openai" } },
      new FakeProvider("twilio"),
    );

    const callId = await initiateCallWithMessage(manager, "+15550000011", "Notify text", "notify");
    await answerCall(manager, callId, "evt-notify-twilio-realtime");

    expectFirstPlayTtsText(provider, "Notify text");
  });

  it("waits for stream connect in conversation mode when Twilio streaming is enabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true } },
      new FakeProvider("twilio"),
    );

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000005",
      "Twilio stream",
      "conversation",
    );
    await answerCall(manager, callId, "evt-conversation-twilio-stream");

    expect(provider.playTtsCalls).toHaveLength(0);
  });

  it("speaks on answered when Twilio streaming is enabled but stream-connect path is unavailable", async () => {
    const twilioProvider = new FakeProvider("twilio");
    twilioProvider.twilioStreamConnectEnabled = false;
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true } },
      twilioProvider,
    );

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000009",
      "Twilio stream unavailable",
      "conversation",
    );
    await answerCall(manager, callId, "evt-conversation-twilio-stream-unavailable");

    expectFirstPlayTtsText(provider, "Twilio stream unavailable");
  });

  it("starts listening after the initial greeting for Telnyx conversation calls", async () => {
    const { manager, provider } = await createManagerHarness({}, new FakeProvider("telnyx"));

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000012",
      "Telnyx hello",
      "conversation",
    );
    await answerCall(manager, callId, "evt-conversation-telnyx");

    expectFirstPlayTtsText(provider, "Telnyx hello");
    expect(provider.startListeningCalls).toEqual([
      expect.objectContaining({
        callId,
        providerCallId: "call-uuid",
      }),
    ]);
    expect(requireCall(manager, callId).state).toBe("listening");
  });

  it("logs fire-and-forget initial-message failures instead of leaking unhandled rejections", async () => {
    const provider = new FailStartListeningProvider("twilio");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { manager } = await createManagerHarness({ streaming: { enabled: false } }, provider);

      const callId = await initiateCallWithMessage(
        manager,
        "+15550000013",
        "Twilio hello",
        "conversation",
      );
      await answerCall(manager, callId, "evt-initial-message-start-listening-fails");

      expectFirstPlayTtsText(provider, "Twilio hello");
      expect(provider.startListeningCalls).toEqual([
        expect.objectContaining({
          callId,
          providerCallId: "call-uuid",
        }),
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `[voice-call] Failed to speak initial message for call ${callId}: synthetic start listening failure`,
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves initialMessage after a failed first playback and retries on next trigger", async () => {
    const provider = new FailFirstPlayTtsProvider("plivo");
    const { manager } = await createManagerHarness({}, provider);

    const callId = await initiateCallWithMessage(manager, "+15550000006", "Retry me", "notify");
    await answerCall(manager, callId, "evt-retry-1");

    const afterFailure = requireCall(manager, callId);
    expect(provider.playTtsCalls).toHaveLength(1);
    expect(afterFailure.metadata).toEqual(expect.objectContaining({ initialMessage: "Retry me" }));
    expect(afterFailure.state).toBe("listening");

    await answerCall(manager, callId, "evt-retry-2");

    const afterSuccess = requireCall(manager, callId);
    expect(provider.playTtsCalls).toHaveLength(2);
    expect(afterSuccess.metadata).not.toHaveProperty("initialMessage");
  });

  it("speaks initial message only once on repeated stream-connect triggers", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true } },
      new FakeProvider("twilio"),
    );

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000007",
      "Stream hello",
      "conversation",
    );
    await answerCall(manager, callId, "evt-stream-answered");
    expect(provider.playTtsCalls).toHaveLength(0);

    await manager.speakInitialMessage("call-uuid");
    await manager.speakInitialMessage("call-uuid");

    expectFirstPlayTtsText(provider, "Stream hello");
  });

  it("prevents concurrent initial-message replays while first playback is in flight", async () => {
    const provider = new DelayedPlayTtsProvider("twilio");
    const { manager } = await createManagerHarness({ streaming: { enabled: true } }, provider);

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000008",
      "In-flight hello",
      "conversation",
    );
    await answerCall(manager, callId, "evt-stream-answered-concurrent");
    expect(provider.playTtsCalls).toHaveLength(0);

    const first = manager.speakInitialMessage("call-uuid");
    await provider.playTtsStartedPromise;
    expect(provider.playTtsStarted).toHaveBeenCalledTimes(1);

    const second = manager.speakInitialMessage("call-uuid");
    await waitForPlaybackDispatch();
    expect(provider.playTtsCalls).toHaveLength(1);

    provider.releaseCurrentPlayback();
    await Promise.all([first, second]);

    const call = requireCall(manager, callId);
    expect(call.metadata).not.toHaveProperty("initialMessage");
    expectFirstPlayTtsText(provider, "In-flight hello");
  });
});
