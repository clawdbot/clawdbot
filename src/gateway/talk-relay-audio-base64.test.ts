import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
} from "../plugins/types.js";
import {
  createTalkRealtimeRelaySession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "./talk-realtime-relay.js";
import { decodeTalkRelayAudioBase64 } from "./talk-relay-audio-base64.js";
import {
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "./talk-transcription-relay.js";

const realtime = new Map<string, string>();
const transcription = new Map<string, string>();

function context() {
  const events: unknown[] = [];
  return {
    events,
    context: {
      getRuntimeConfig: () => ({}),
      broadcastToConnIds: (_event: string, payload: unknown) => events.push(payload),
    } as never,
  };
}

function voiceProvider(sendAudio: (audio: Buffer) => void): RealtimeVoiceProviderPlugin {
  return {
    id: "test",
    label: "Test",
    isConfigured: () => true,
    createBridge: () => ({
      connect: async () => {},
      sendAudio,
      setMediaTimestamp: () => {},
      handleBargeIn: () => {},
      submitToolResult: () => {},
      acknowledgeMark: () => {},
      close: () => {},
      isConnected: () => true,
    }),
  };
}

function transcriptionProvider(
  sendAudio: (audio: Buffer) => void,
): RealtimeTranscriptionProviderPlugin {
  return {
    id: "test",
    label: "Test",
    isConfigured: () => true,
    createSession: () => ({
      connect: async () => {},
      sendAudio,
      close: () => {},
      isConnected: () => true,
    }),
  };
}

describe("Talk relay audio base64", () => {
  afterEach(() => {
    for (const [relaySessionId, connId] of realtime) {
      stopTalkRealtimeRelaySession({ relaySessionId, connId });
    }
    for (const [transcriptionSessionId, connId] of transcription) {
      stopTalkTranscriptionRelaySession({ transcriptionSessionId, connId });
    }
    realtime.clear();
    transcription.clear();
  });

  it.each([
    ["YXVkaW8taW4=", Buffer.from("audio-in")],
    ["-_8", Buffer.from([0xfb, 0xff])],
  ])("decodes valid input", (input, expected) => {
    expect(decodeTalkRelayAudioBase64(input, "Talk")).toEqual(expected);
  });

  it.each(["not-base64!", "AB"])("rejects malformed input: %s", (input) => {
    expect(() => decodeTalkRelayAudioBase64(input, "Talk")).toThrow(
      "Talk audio frame is invalid base64",
    );
  });

  it("rejects non-round-tripping realtime audio before delivery", async () => {
    const sendAudio = vi.fn<(audio: Buffer) => void>();
    const { context: relayContext, events } = context();
    const session = createTalkRealtimeRelaySession({
      context: relayContext,
      connId: "conn",
      provider: voiceProvider(sendAudio),
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    realtime.set(session.relaySessionId, "conn");
    await Promise.resolve();
    events.length = 0;
    expect(() =>
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn",
        audioBase64: "AB",
      }),
    ).toThrow("Realtime relay audio frame is invalid base64");
    expect(sendAudio).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("forwards valid realtime audio", async () => {
    const sendAudio = vi.fn<(audio: Buffer) => void>();
    const { context: relayContext, events } = context();
    const session = createTalkRealtimeRelaySession({
      context: relayContext,
      connId: "conn",
      provider: voiceProvider(sendAudio),
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    realtime.set(session.relaySessionId, "conn");
    await Promise.resolve();
    events.length = 0;
    sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn",
      audioBase64: "YXVkaW8taW4=",
    });
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(events).toContainEqual(expect.objectContaining({ type: "inputAudio", byteLength: 8 }));
  });

  it("rejects non-round-tripping transcription audio before delivery", async () => {
    const sendAudio = vi.fn<(audio: Buffer) => void>();
    const { context: relayContext, events } = context();
    const session = createTalkTranscriptionRelaySession({
      context: relayContext,
      connId: "conn",
      provider: transcriptionProvider(sendAudio),
      providerConfig: {},
    });
    transcription.set(session.transcriptionSessionId, "conn");
    await Promise.resolve();
    events.length = 0;
    expect(() =>
      sendTalkTranscriptionRelayAudio({
        transcriptionSessionId: session.transcriptionSessionId,
        connId: "conn",
        audioBase64: "AB",
      }),
    ).toThrow("Transcription Talk audio frame is invalid base64");
    expect(sendAudio).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("forwards valid transcription audio", async () => {
    const sendAudio = vi.fn<(audio: Buffer) => void>();
    const { context: relayContext, events } = context();
    const session = createTalkTranscriptionRelaySession({
      context: relayContext,
      connId: "conn",
      provider: transcriptionProvider(sendAudio),
      providerConfig: {},
    });
    transcription.set(session.transcriptionSessionId, "conn");
    await Promise.resolve();
    events.length = 0;
    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn",
      audioBase64: "YXVkaW8taW4=",
    });
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(events).toContainEqual(expect.objectContaining({ type: "inputAudio", byteLength: 8 }));
  });
});
