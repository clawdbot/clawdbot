// Openai tests cover realtime voice provider plugin behavior.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mocks.execFileSyncMock,
  };
});

vi.mock("ws", () => ({
  default: mocks.FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  parseSent,
  createNativeBridge,
  connectReadyBridge,
  emitServerEvent,
  emitAssistantPlayback,
  expectedResponseCancelEvent,
  hasSentEventType,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice bridge events", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    restoreTestEnvironment();
  });

  it.each([
    {
      $name: "input interruption disabled",
      bridgeOptions: { autoRespondToAudio: true, interruptResponseOnInputAudio: false },
    },
    {
      $name: "automatic audio responses disabled",
      bridgeOptions: { autoRespondToAudio: false },
    },
  ])("$name", async ({ bridgeOptions }) => {
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const bridge = createNativeBridge({ ...bridgeOptions, onAudio, onClearAudio });
    const socket = await connectReadyBridge(bridge);

    emitAssistantPlayback(socket);
    emitServerEvent(socket, { type: "input_audio_buffer.speech_started" });

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onClearAudio).not.toHaveBeenCalled();
    expect(hasSentEventType(socket, "response.cancel")).toBe(false);
    expect(hasSentEventType(socket, "conversation.item.truncate")).toBe(false);
  });

  it("truncates externally interrupted playback after an immediate mark acknowledgement", async () => {
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const bridge = createNativeBridge({
      onAudio,
      onClearAudio,
      onMark: () => bridge.acknowledgeMark(),
    });
    const socket = await connectReadyBridge(bridge);

    // 2016 bytes at the default g711_ulaw/8kHz output format (1 byte/sample)
    // is 252ms of confirmed-played audio, comfortably above the default
    // 250ms minimum barge-in window - so audio_end_ms below is derived from
    // bytes actually acknowledged as played, not from a manually-set clock.
    const audio = Buffer.alloc(2016, 0x41);
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket, { audio });
    bridge.setMediaTimestamp(1300);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(parseSent(socket).slice(-2)).toEqual([
      expectedResponseCancelEvent(),
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 252,
        event_id: expect.any(String),
      },
    ]);
  });

  it("skips truncate but still cancels for a sub-minimum sliver when the caller trusts its barge-in signal", async () => {
    // Regression guard for the truncate audio_end_ms bug: before the fix,
    // audio_end_ms was derived from an unrelated input-media-timestamp diff
    // that could report tens of seconds of "played" audio for an item that
    // had only streamed a couple of bytes, which OpenAI's Realtime API
    // rejects with "Audio content of Xms is already shorter than Yms".
    // A tiny confirmed-played chunk must instead skip truncate via the
    // existing minBargeInAudioEndMs gate, never send an inflated value.
    const onClearAudio = vi.fn();
    const bridge = createNativeBridge({
      onClearAudio,
      onMark: () => bridge.acknowledgeMark(),
      // Relay-style caller: the barge-in signal is trustworthy, so the minimum
      // window governs only truncate precision.
      minBargeInScope: "truncate-only",
    });
    const socket = await connectReadyBridge(bridge);

    // A single-byte delta acknowledged immediately is far below the 250ms
    // default minimum, even though a stale/unrelated wall clock could have
    // advanced by any arbitrary amount in the meantime.
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket, { audio: Buffer.from([0x00]) });
    bridge.setMediaTimestamp(1_000_000);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    // Below minBargeInAudioEndMs, the provider-side truncate is skipped
    // (audio_end_ms isn't trustworthy enough yet to tell OpenAI precisely
    // where this item was cut) but response.cancel still fires immediately -
    // a genuine barge-in must never let the assistant keep generating/
    // talking over the user just because the played-byte confirmation
    // hasn't caught up yet.
    expect(hasSentEventType(socket, "conversation.item.truncate")).toBe(false);
    expect(hasSentEventType(socket, "response.cancel")).toBe(true);
  });

  it("clamps audio_end_ms to delivered audio when no mark has been acknowledged yet", async () => {
    // Real regression guard for the original production bug: audio_end_ms
    // was derived from an unrelated input-media-timestamp diff whenever no
    // mark had been acknowledged for the current item yet (the fast/early
    // barge-in case - the single most common interruption timing). That
    // diff could report tens of seconds of "played" audio for an item that
    // had only streamed a couple thousand bytes, which OpenAI's Realtime
    // API rejects with "Audio content of Xms is already shorter than Yms".
    // Unlike the previous test (which acknowledges a mark immediately and
    // so never touches the fallback at all), this scenario never
    // acknowledges anything, so playedAudioMsForCurrentItem() stays null
    // and the fallback path - and its delivered-bytes clamp - is what's
    // actually under test.
    const onClearAudio = vi.fn();
    const bridge = createNativeBridge({ onClearAudio });
    const socket = await connectReadyBridge(bridge);

    // 2016 bytes at g711_ulaw/8kHz (1 byte/sample) is 252ms of audio OpenAI
    // has actually sent us for this item - a hard upper bound on how much
    // could possibly have been heard, regardless of what the input-audio
    // clock below claims.
    const audio = Buffer.alloc(2016, 0x41);
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket, { audio });
    // A wildly divergent input-audio clock: pre-fix this produced
    // audio_end_ms = 999000, which sailed past the 250ms minimum and was
    // sent to OpenAI as truncate for an item that was only 252ms long.
    bridge.setMediaTimestamp(1_000_000);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(parseSent(socket).slice(-2)).toEqual([
      expectedResponseCancelEvent(),
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 252,
        event_id: expect.any(String),
      },
    ]);
  });

  it("preserves FIFO playback acknowledgements after sustained output", async () => {
    const onClearAudio = vi.fn();
    const onMark = vi.fn();
    const bridge = createNativeBridge({
      onClearAudio,
      onMark,
    });
    const socket = await connectReadyBridge(bridge);

    bridge.setMediaTimestamp(1000);
    for (let index = 0; index < 300; index += 1) {
      emitServerEvent(socket, {
        type: "response.audio.delta",
        item_id: "item_1",
        delta: Buffer.from("assistant audio").toString("base64"),
      });
    }

    const marks = onMark.mock.calls.map(([markName]) => String(markName));
    expect(marks).toHaveLength(300);
    for (let index = 0; index < 299; index += 1) {
      bridge.acknowledgeMark();
    }
    bridge.setMediaTimestamp(1300);
    bridge.handleBargeIn?.();

    // 299 acknowledged chunks * 15 bytes ("assistant audio") = 4485 bytes,
    // which at g711_ulaw/8kHz (1 byte/sample) is floor(4485 / 8) = 560ms of
    // confirmed-played audio - independent of the media-timestamp diff.
    expect(parseSent(socket).slice(-1)).toEqual([
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 560,
        event_id: expect.any(String),
      },
    ]);
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");

    for (let index = 0; index < 300; index += 1) {
      emitServerEvent(socket, {
        type: "response.audio.delta",
        item_id: "item_1",
        delta: Buffer.from("assistant audio").toString("base64"),
      });
    }
    const latestMark = onMark.mock.calls.at(-1)?.[0];
    if (typeof latestMark !== "string") {
      throw new Error("expected a playback mark");
    }
    bridge.acknowledgeMark(latestMark);
    bridge.setMediaTimestamp(1600);
    bridge.handleBargeIn?.();

    expect(
      parseSent(socket).filter((event) => event.type === "conversation.item.truncate"),
    ).toHaveLength(1);
    bridge.close();
  });

  it("treats a later named mark as cumulative playback progress", async () => {
    const onMark = vi.fn();
    const bridge = createNativeBridge({ onMark });
    const socket = await connectReadyBridge(bridge);

    bridge.setMediaTimestamp(1000);
    for (let index = 0; index < 3; index += 1) {
      emitServerEvent(socket, {
        type: "response.audio.delta",
        item_id: "item_1",
        delta: Buffer.from("assistant audio").toString("base64"),
      });
    }
    const marks = onMark.mock.calls.map(([markName]) => String(markName));
    expect(marks).toHaveLength(3);

    bridge.acknowledgeMark(marks[2]);
    bridge.acknowledgeMark(marks[0]);
    bridge.acknowledgeMark(marks[1]);
    bridge.setMediaTimestamp(1300);
    bridge.handleBargeIn?.();

    expect(
      parseSent(socket).filter((event) => event.type === "conversation.item.truncate"),
    ).toHaveLength(0);
    bridge.close();
  });

  it("forwards current realtime output audio events", async () => {
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const bridge = createNativeBridge({
      onAudio,
      onTranscript,
    });
    const socket = await connectReadyBridge(bridge);

    const audio = Buffer.from("assistant audio");
    emitServerEvent(socket, {
      type: "response.output_audio.delta",
      item_id: "item_1",
      delta: audio.toString("base64"),
    });
    emitServerEvent(socket, {
      type: "response.output_audio_transcript.done",
      transcript: "hello from current realtime events",
    });

    expect(onAudio).toHaveBeenCalledWith(audio);
    expect(onTranscript).toHaveBeenCalledWith(
      "assistant",
      "hello from current realtime events",
      true,
    );
  });

  it("surfaces input transcription failures with their provider error details", async () => {
    const onError = vi.fn();
    const onEvent = vi.fn();
    const bridge = createNativeBridge({ onError, onEvent });
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item_speech",
      error: { code: "decoder_failure", message: "speech decoder exploded" },
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "speech decoder exploded" }),
    );
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.input_audio_transcription.failed",
      itemId: "item_speech",
      detail: "speech decoder exploded",
    });
  });

  it("preserves corrected final text from legacy realtime text events", async () => {
    const onTranscript = vi.fn();
    const bridge = createNativeBridge({ onTranscript });
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, { type: "response.text.delta", delta: "draft assistant" });
    emitServerEvent(socket, { type: "response.text.done", text: "corrected assistant" });

    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "draft assistant", false],
      ["assistant", "corrected assistant", true],
    ]);
  });

  it.each([
    ["invalid alphabet", "not-base64!"],
    ["non-canonical pad bits", "ZE=="],
  ])("terminates the session for %s in output audio", async (_scenario, delta) => {
    const onAudio = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = createNativeBridge({
      onAudio,
      onError,
      onClose,
    });
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, { type: "response.output_audio.delta", item_id: "item_1", delta });

    expect(onAudio).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "OpenAI realtime stream returned malformed base64 audio data",
      }),
    );
    expect(onClose).toHaveBeenCalledWith("error");
    expect(socket.closed).toBe(true);
    await expect(bridge.connect()).rejects.toThrow(
      "OpenAI realtime stream returned malformed base64 audio data",
    );
  });

  it("forwards Codex-compatible legacy realtime audio and transcript events", async () => {
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const bridge = createNativeBridge({
      onAudio,
      onTranscript,
    });
    const socket = await connectReadyBridge(bridge);

    const audio = Buffer.from("legacy assistant audio");
    emitServerEvent(socket, {
      type: "conversation.output_audio.delta",
      data: audio.toString("base64"),
      sample_rate: 24000,
      channels: 1,
    });
    emitServerEvent(socket, {
      type: "conversation.input_transcript.delta",
      delta: "partial user",
    });
    emitServerEvent(socket, {
      type: "conversation.output_transcript.delta",
      delta: "partial assistant",
    });
    emitServerEvent(socket, {
      type: "response.output_text.done",
      text: "final assistant text",
    });

    expect(onAudio).toHaveBeenCalledWith(audio);
    expect(onTranscript).toHaveBeenCalledWith("user", "partial user", false);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "partial assistant", false);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "final assistant text", true);
  });

  it("does not send duplicate response.cancel while cancellation is pending", async () => {
    const onEvent = vi.fn();
    const bridge = createNativeBridge({ onEvent });
    const socket = await connectReadyBridge(bridge);
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_1" } });
    bridge.setMediaTimestamp(1000);
    // No mark handler is wired up here (only onEvent), so audio_end_ms is
    // computed via the media-timestamp fallback, then clamped to delivered
    // bytes (see the dedicated clamp regression test above). 2400 bytes at
    // g711_ulaw/8kHz is 300ms delivered - at or above both the fallback's
    // 300ms clock diff and the default 250ms minimum - so this scenario
    // stays focused on its actual subject (no duplicate response.cancel)
    // instead of incidentally falling below the truncate minimum.
    emitServerEvent(socket, {
      type: "response.audio.delta",
      item_id: "item_1",
      delta: Buffer.alloc(2400, 0x41).toString("base64"),
    });
    bridge.setMediaTimestamp(1300);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(parseSent(socket).filter((event) => event.type === "response.cancel")).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "response.cancel",
      detail: "reason=barge-in",
    });
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "conversation.item.truncate",
      detail: "reason=barge-in audioEndMs=300",
    });
  });

  it("drops the in-flight tail of an item abandoned below the minimum window", async () => {
    // response.cancel is asynchronous, so the provider can still emit deltas for
    // the item we just stopped playing. Forwarding them would restart playback
    // and let the assistant talk over the user - the exact failure this endpoint
    // work exists to remove.
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const bridge = createNativeBridge({
      onAudio,
      onClearAudio,
      minBargeInScope: "truncate-only",
    });
    const socket = await connectReadyBridge(bridge);
    bridge.setMediaTimestamp(0);
    emitAssistantPlayback(socket, { audio: Buffer.from([0x00]), itemId: "item_1" });
    expect(onAudio).toHaveBeenCalledTimes(1);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(parseSent(socket).some((event) => event.type === "conversation.item.truncate")).toBe(
      false,
    );

    // Same item_id keeps streaming after the cancel request.
    emitAssistantPlayback(socket, { audio: Buffer.from([0x01]), itemId: "item_1" });

    expect(onAudio).toHaveBeenCalledTimes(1);
  });

  it("leaves playback alone below the minimum window by default, preserving the shipped contract", async () => {
    // Discord voice depends on this and documents it: below
    // minBargeInAudioEndMs the signal is treated as likely echo and ignored, so
    // local playback must keep running and no response.cancel may be sent. Its
    // barge-in handler passes a deliberately empty fallback for that reason.
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const bridge = createNativeBridge({ onClearAudio, onEvent });
    const socket = await connectReadyBridge(bridge);
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onClearAudio).not.toHaveBeenCalled();
    expect(hasSentEventType(socket, "response.cancel")).toBe(false);
    expect(parseSent(socket).some((event) => event.type === "conversation.item.truncate")).toBe(
      false,
    );
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "conversation.item.truncate.skipped",
      detail: "reason=barge-in audioEndMs=0 minAudioEndMs=250",
    });
  });

  it("clears audio and cancels the response for zero-length playback barge-in when the caller trusts its signal, but skips provider truncate", async () => {
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const bridge = createNativeBridge({
      onClearAudio,
      onEvent,
      minBargeInScope: "truncate-only",
    });
    const socket = await connectReadyBridge(bridge);
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    // A genuine barge-in signal always stops local playback and cancels any
    // in-flight provider response, regardless of whether audio_end_ms is
    // trustworthy enough yet to send a precise provider-side truncate -
    // otherwise the assistant could keep talking over the user for as long
    // as confirmation lags real time.
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(hasSentEventType(socket, "response.cancel")).toBe(true);
    expect(parseSent(socket).some((event) => event.type === "conversation.item.truncate")).toBe(
      false,
    );
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "conversation.item.truncate.skipped",
      detail: "reason=barge-in audioEndMs=0 minAudioEndMs=250",
    });
  });

  it("force-cancels zero-length playback barge-in for agent handoff fallback", async () => {
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const bridge = createNativeBridge({
      onClearAudio,
      onEvent,
    });
    const socket = await connectReadyBridge(bridge);
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket);

    bridge.handleBargeIn?.({ audioPlaybackActive: true, force: true });

    expect(parseSent(socket).slice(-2)).toEqual([
      expectedResponseCancelEvent(),
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 0,
        event_id: expect.any(String),
      },
    ]);
    expect(onClearAudio).toHaveBeenCalled();
    expect(
      onEvent.mock.calls.some(
        ([event]) => isRecord(event) && event.type === "conversation.item.truncate.skipped",
      ),
    ).toBe(false);
  });

  it("allows immediate playback barge-in when the minimum audio window is zero", async () => {
    const onClearAudio = vi.fn();
    const bridge = createNativeBridge({
      providerConfig: {
        apiKey: "test-api-key-test",
        minBargeInAudioEndMs: 0,
      },
      onClearAudio,
    });
    const socket = await connectReadyBridge(bridge);
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(parseSent(socket).slice(-2)).toEqual([
      expectedResponseCancelEvent(),
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 0,
        event_id: expect.any(String),
      },
    ]);
  });
});
