import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeTranscriptionSessionCreateRequest } from "../realtime-transcription/provider-types.js";
import {
  cancelTalkTranscriptionRelayTurn,
  clearTalkTranscriptionRelaySessionsForTest,
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "./talk-transcription-relay.js";

describe("talk transcription gateway relay", () => {
  afterEach(() => {
    clearTalkTranscriptionRelaySessionsForTest();
  });

  it("bridges browser audio into a transcription-only Talk event stream", async () => {
    let sttRequest: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sttSession = {
      connect: vi.fn(async () => {
        sttRequest?.onSpeechStart?.();
        sttRequest?.onPartial?.("hel");
        sttRequest?.onTranscript?.("hello world");
      }),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "stt-test",
      label: "STT Test",
      isConfigured: () => true,
      createSession: (req) => {
        sttRequest = req;
        return sttSession;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkTranscriptionRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: { model: "stt-model" },
    });
    await Promise.resolve();

    expect(session).toMatchObject({
      provider: "stt-test",
      mode: "transcription",
      transport: "gateway-relay",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24000,
      },
    });
    expect(sttRequest).toMatchObject({
      providerConfig: { model: "stt-model" },
    });

    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
    });
    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
    });

    expect(sttSession.sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(sttSession.close).toHaveBeenCalledOnce();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "talk.event",
          connIds: ["conn-1"],
          payload: expect.objectContaining({
            transcriptionSessionId: session.transcriptionSessionId,
            type: "ready",
            talkEvent: expect.objectContaining({
              sessionId: session.transcriptionSessionId,
              type: "session.ready",
              mode: "transcription",
              transport: "gateway-relay",
              brain: "none",
              provider: "stt-test",
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            transcriptionSessionId: session.transcriptionSessionId,
            type: "speechStart",
            talkEvent: expect.objectContaining({ type: "turn.started", turnId: "turn-1" }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            transcriptionSessionId: session.transcriptionSessionId,
            type: "partial",
            text: "hel",
            talkEvent: expect.objectContaining({
              type: "transcript.delta",
              turnId: "turn-1",
              payload: { text: "hel" },
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            transcriptionSessionId: session.transcriptionSessionId,
            type: "transcript",
            text: "hello world",
            final: true,
            talkEvent: expect.objectContaining({
              type: "transcript.done",
              turnId: "turn-1",
              final: true,
              payload: { text: "hello world" },
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            transcriptionSessionId: session.transcriptionSessionId,
            type: "inputAudio",
            byteLength: 8,
            talkEvent: expect.objectContaining({ type: "input.audio.delta" }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            transcriptionSessionId: session.transcriptionSessionId,
            type: "close",
            reason: "completed",
            talkEvent: expect.objectContaining({
              type: "session.closed",
              final: true,
            }),
          }),
        }),
      ]),
    );
  });

  it("cancels an active transcription turn and closes the provider session", async () => {
    let sttRequest: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sttSession = {
      connect: vi.fn(async () => {
        sttRequest?.onSpeechStart?.();
      }),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "stt-test",
      label: "STT Test",
      isConfigured: () => true,
      createSession: (req) => {
        sttRequest = req;
        return sttSession;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkTranscriptionRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
    });
    await Promise.resolve();

    cancelTalkTranscriptionRelayTurn({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      reason: "barge-in",
    });

    expect(sttSession.close).toHaveBeenCalledOnce();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            transcriptionSessionId: session.transcriptionSessionId,
            talkEvent: expect.objectContaining({
              type: "turn.cancelled",
              turnId: "turn-1",
              payload: { reason: "barge-in" },
              final: true,
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            transcriptionSessionId: session.transcriptionSessionId,
            type: "close",
            reason: "completed",
          }),
        }),
      ]),
    );
  });
});
