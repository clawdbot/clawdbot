import { LiveServerMessage, type LiveConnectParameters, type Session } from "@google/genai";
import {
  startMeetingRealtimeEngine,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRealtimeAudioTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

function createSdkSession() {
  return {
    close: vi.fn(),
    sendRealtimeInput: vi.fn<Session["sendRealtimeInput"]>(),
    sendClientContent: vi.fn(),
    sendToolResponse: vi.fn(),
  };
}

const { connectMock } = vi.hoisted(() => ({
  connectMock:
    vi.fn<(params: LiveConnectParameters) => Promise<ReturnType<typeof createSdkSession>>>(),
}));
vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: () => ({ live: { connect: connectMock } }),
}));

type Connection = { params: LiveConnectParameters; session: ReturnType<typeof createSdkSession> };
const connections: Connection[] = [];
let meeting: MeetingRealtimeAudioEngineHandle | undefined;
const input = Buffer.alloc(960, 1);
const output = Buffer.alloc(960, 2);

function currentConnection() {
  const connection = connections.at(-1);
  if (!connection) {
    throw new Error("Expected Google Live connection");
  }
  return connection;
}

function receive(message: Partial<LiveServerMessage>, connection = currentConnection()) {
  connection.params.callbacks.onmessage(Object.assign(new LiveServerMessage(), message));
}

function remoteClose() {
  currentConnection().params.callbacks.onclose?.(
    new CloseEvent("close", { code: 1011, reason: "temporary upstream close", wasClean: false }),
  );
}

function receiveAudio(connection = currentConnection()) {
  receive(
    {
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: output.toString("base64") } },
          ],
        },
      },
    },
    connection,
  );
}

async function startMeeting() {
  const transport = {
    onFatal: vi.fn(),
    startInput: vi.fn<MeetingRealtimeAudioTransport["startInput"]>(),
    clearOutput: vi.fn(async () => {}),
    writeOutput: vi.fn<MeetingRealtimeAudioTransport["writeOutput"]>(async () => {}),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } satisfies MeetingRealtimeAudioTransport;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  meeting = await startMeetingRealtimeEngine({
    config: {
      chrome: { audioFormat: "pcm16-24khz" },
      realtime: {
        strategy: "bidi",
        provider: "google",
        providers: { google: { apiKey: "test-key" } },
      },
    },
    fullConfig: {},
    runtime: {} as never,
    platform: {
      displayName: "Test Meeting",
      logScope: "[meeting-test]",
      sessionIdPrefix: "meeting-test",
    },
    meetingSessionId: "meeting-1",
    providers: [buildGoogleRealtimeVoiceProvider()],
    transport,
    logger,
    consultAgent: async () => ({ text: "unused" }),
    handleToolCall: async () => {},
    tools: [],
  });
  const onInput = transport.startInput.mock.calls[0]?.[0];
  if (!onInput) {
    throw new Error("Expected meeting audio capture");
  }
  expect(meeting.getHealth()).toMatchObject({
    providerConnected: true,
    realtimeReady: true,
    bridgeClosed: false,
  });
  onInput(input);
  expect(currentConnection().session.sendRealtimeInput).toHaveBeenCalledOnce();
  return { handle: meeting, transport, logger, onInput };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  connections.length = 0;
  connectMock.mockReset().mockImplementation(async (params) => {
    const connection = { params, session: createSdkSession() };
    connections.push(connection);
    // The SDK delivers open and setupComplete before returning its Session.
    params.callbacks.onopen?.();
    receive({ setupComplete: {} }, connection);
    return connection.session;
  });
});

afterEach(async () => {
  try {
    await meeting?.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    meeting = undefined;
    vi.useRealTimers();
  }
});

afterAll(() => {
  vi.doUnmock("./google-genai-runtime.js");
  vi.resetModules();
});

describe("Google Live meeting recovery", () => {
  it.each([
    { name: "close without a resume handle", reconnect: true, resume: false },
    { name: "close with a resume handle", reconnect: true, resume: true },
    { name: "goAway while connected", reconnect: false, resume: false },
  ])("keeps meeting audio alive after $name", async ({ reconnect, resume }) => {
    const { handle, transport, logger, onInput } = await startMeeting();
    if (resume) {
      receive({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" } });
    }
    if (reconnect) {
      remoteClose();
    } else {
      receive({ goAway: { timeLeft: "30s" } });
    }
    expect(handle.getHealth().bridgeClosed).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(handle.getHealth().recentTalkEvents.map((event) => event.type)).toContain(
      "session.error",
    );

    onInput(input);
    await vi.advanceTimersByTimeAsync(250);

    expect(connectMock).toHaveBeenCalledTimes(reconnect ? 2 : 1);
    expect(currentConnection().params.config?.sessionResumption).toEqual(
      resume ? { handle: "resume-1" } : {},
    );
    expect(handle.getHealth()).toMatchObject({
      providerConnected: true,
      realtimeReady: true,
      bridgeClosed: false,
    });
    onInput(input);
    expect(currentConnection().session.sendRealtimeInput).toHaveBeenCalledTimes(reconnect ? 2 : 3);
    expect(currentConnection().session.sendRealtimeInput).toHaveBeenLastCalledWith({
      audio: { data: Buffer.alloc(640, 1).toString("base64"), mimeType: "audio/pcm;rate=16000" },
    });
    receiveAudio();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.writeOutput).toHaveBeenCalledExactlyOnceWith(output);
    expect(transport.stop).not.toHaveBeenCalled();
    expect(transport.dispose).not.toHaveBeenCalled();
  });

  it("disposes the meeting only when provider recovery is exhausted", async () => {
    const { handle, transport, onInput } = await startMeeting();
    const original = currentConnection();
    connectMock.mockRejectedValue(new Error("upstream unavailable"));
    remoteClose();
    for (const delay of [250, 500]) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(handle.getHealth().bridgeClosed).toBe(false);
      expect(transport.stop).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(1_000);

    expect(connectMock).toHaveBeenCalledTimes(4);
    expect(handle.getHealth()).toMatchObject({
      providerConnected: false,
      realtimeReady: false,
      bridgeClosed: true,
    });
    expect(
      handle.getHealth().recentTalkEvents.filter((event) => event.type === "session.closed"),
    ).toHaveLength(1);
    expect(transport.stop).toHaveBeenCalledOnce();
    expect(transport.dispose).toHaveBeenCalledOnce();
    onInput(input);
    receiveAudio(original);
    await vi.advanceTimersByTimeAsync(0);
    expect(original.session.sendRealtimeInput).toHaveBeenCalledOnce();
    expect(transport.writeOutput).not.toHaveBeenCalled();
  });
});
