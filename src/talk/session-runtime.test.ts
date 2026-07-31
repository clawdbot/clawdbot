// Talk session runtime tests cover provider lifecycle and session events.
import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBridge,
} from "./provider-types.js";
import { createRealtimeVoiceBridgeSession } from "./session-runtime.js";

function makeBridge(overrides: Partial<RealtimeVoiceBridge> = {}): RealtimeVoiceBridge {
  return {
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    triggerGreeting: vi.fn(),
    ...overrides,
  };
}

function expectBridgeRequest(
  request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined,
): Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] {
  if (!request) {
    throw new Error("Expected realtime voice provider bridge request");
  }
  return request;
}

describe("realtime voice bridge session runtime", () => {
  it("routes provider output through an open audio sink", () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const bridge = makeBridge();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return bridge;
      },
    };
    const sendAudio = vi.fn();
    const clearAudio = vi.fn();
    const sendMark = vi.fn();

    createRealtimeVoiceBridgeSession({
      provider,
      cfg: { talk: { realtime: { provider: "test" } } } as never,
      providerConfig: {},
      audioSink: {
        isOpen: () => true,
        sendAudio,
        clearAudio,
        sendMark,
      },
    });

    callbacks?.onAudio(Buffer.from([1, 2]));
    callbacks?.onClearAudio("barge-in");
    callbacks?.onMark?.("mark-1");

    expect(callbacks?.cfg).toEqual({ talk: { realtime: { provider: "test" } } });
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2]));
    expect(clearAudio).toHaveBeenCalledWith("barge-in");
    expect(sendMark).toHaveBeenCalledWith("mark-1");
  });

  it("passes the requested audio format to the provider bridge", () => {
    let request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (nextRequest) => {
        request = nextRequest;
        return makeBridge();
      },
    };

    createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      audioSink: { sendAudio: vi.fn() },
    });

    expect(expectBridgeRequest(request).audioFormat).toEqual(
      REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    );
  });

  it("passes the audio auto-response preference to the provider bridge", () => {
    let request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (nextRequest) => {
        request = nextRequest;
        return makeBridge();
      },
    };

    createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      autoRespondToAudio: false,
      audioSink: { sendAudio: vi.fn() },
    });

    expect(expectBridgeRequest(request).autoRespondToAudio).toBe(false);
  });

  it("passes the audio interrupt preference to the provider bridge", () => {
    let request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (nextRequest) => {
        request = nextRequest;
        return makeBridge();
      },
    };

    createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      interruptResponseOnInputAudio: false,
      audioSink: { sendAudio: vi.fn() },
    });

    expect(expectBridgeRequest(request).interruptResponseOnInputAudio).toBe(false);
  });

  it("can acknowledge provider marks without transport mark support", () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const bridge = makeBridge();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return bridge;
      },
    };
    const sendMark = vi.fn();

    createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn(), sendMark },
      markStrategy: "ack-immediately",
    });

    callbacks?.onMark?.("mark-1");

    expect(sendMark).not.toHaveBeenCalled();
    expect(bridge["acknowledgeMark"]).toHaveBeenCalledWith("mark-1");
  });

  it("can ignore provider marks", () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const bridge = makeBridge();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return bridge;
      },
    };
    const sendMark = vi.fn();

    createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn(), sendMark },
      markStrategy: "ignore",
    });

    callbacks?.onMark?.("mark-1");

    expect(sendMark).not.toHaveBeenCalled();
    expect(bridge["acknowledgeMark"]).not.toHaveBeenCalled();
  });

  it("passes tool calls the active session and triggers initial greeting on ready", () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const bridge = makeBridge();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return bridge;
      },
    };
    const onToolCall = vi.fn();

    const session = createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
      initialGreetingInstructions: "Say hello",
      triggerGreetingOnReady: true,
      onToolCall,
    });
    const event = {
      itemId: "item-1",
      callId: "call-1",
      name: "lookup",
      args: { q: "test" },
    };

    callbacks?.onReady?.();
    callbacks?.onToolCall?.(event);

    expect(bridge["triggerGreeting"]).toHaveBeenCalledWith("Say hello");
    expect(onToolCall).toHaveBeenCalledWith(event, session);
  });

  it("routes synchronous and asynchronous tool-call callback failures to onError", async () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const onError = vi.fn();
    const syncFailure = new Error("sync callback failed");
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return makeBridge();
      },
    };
    const onToolCall = vi
      .fn()
      .mockImplementationOnce(() => {
        throw syncFailure;
      })
      .mockImplementationOnce(() => Promise.reject(new Error("async callback failed")));
    createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
      onToolCall,
      onError,
    });
    const event = {
      itemId: "item-1",
      callId: "call-1",
      name: "lookup",
      args: {},
    };

    callbacks?.onToolCall?.(event);
    callbacks?.onToolCall?.(event);
    await Promise.resolve();

    expect(onError).toHaveBeenNthCalledWith(1, syncFailure);
    expect(onError).toHaveBeenNthCalledWith(2, new Error("async callback failed"));
  });

  it("contains an onError exception after an asynchronous tool-call failure", async () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const onError = vi.fn(() => {
      throw new Error("error callback failed");
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return makeBridge();
      },
    };
    createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
      onToolCall: () => Promise.reject(new Error("tool callback failed")),
      onError,
    });

    callbacks?.onToolCall?.({
      itemId: "item-1",
      callId: "call-1",
      name: "lookup",
      args: {},
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(onError).toHaveBeenCalledWith(new Error("tool callback failed"));
  });

  it("does not report an asynchronous tool-call failure after the session closes", async () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    let rejectToolCall: ((error: Error) => void) | undefined;
    const close = vi.fn();
    const bridge = makeBridge({ close });
    const onError = vi.fn();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return bridge;
      },
    };
    const session = createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
      onToolCall: () =>
        new Promise<void>((_resolve, reject) => {
          rejectToolCall = reject;
        }),
      onError,
    });

    callbacks?.onToolCall?.({
      itemId: "item-1",
      callId: "call-1",
      name: "lookup",
      args: {},
    });
    session.close();
    rejectToolCall?.(new Error("late tool callback failure"));
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("forwards tool result continuation options and async acceptance to the provider bridge", () => {
    const acceptance = Promise.resolve();
    const submitToolResult = vi.fn(() => acceptance);
    const bridge = makeBridge({ submitToolResult });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const session = createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
    });

    const submitted = session.submitToolResult(
      "call-1",
      { status: "working" },
      { willContinue: true },
    );

    expect(submitted).toBe(acceptance);
    expect(submitToolResult).toHaveBeenCalledWith(
      "call-1",
      { status: "working" },
      { willContinue: true },
    );
  });

  it("rejects suppressed results before calling an unsupported provider bridge", () => {
    const submitToolResult = vi.fn();
    const bridge = makeBridge({
      submitToolResult,
      supportsToolResultSuppression: false,
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const session = createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
    });

    expect(() =>
      session.submitToolResult("call-1", { ok: true }, { suppressResponse: true }),
    ).toThrow("Realtime provider does not support suppressed tool results");
    expect(submitToolResult).not.toHaveBeenCalled();
  });

  it("does not expose session callbacks until the provider returns its bridge", () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const bridge = makeBridge();
    const onReady = vi.fn();
    const onToolCall = vi.fn();
    const event = {
      itemId: "item-1",
      callId: "call-1",
      name: "lookup",
      args: {},
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        request.onReady?.();
        request.onToolCall?.(event);
        return bridge;
      },
    };

    const session = createRealtimeVoiceBridgeSession({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
      onReady,
      onToolCall,
    });

    expect(onReady).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();

    callbacks?.onReady?.();
    callbacks?.onToolCall?.(event);

    expect(onReady).toHaveBeenCalledWith(session);
    expect(onToolCall).toHaveBeenCalledWith(event, session);
  });
});
