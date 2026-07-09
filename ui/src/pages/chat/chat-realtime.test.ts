// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { realtimeTalkSessionCtor, sessionStart, sessionStop } = vi.hoisted(() => ({
  realtimeTalkSessionCtor: vi.fn(function () {
    return { start: sessionStart, stop: sessionStop };
  }),
  sessionStart: vi.fn(async () => undefined),
  sessionStop: vi.fn(),
}));

vi.mock("./realtime-talk.ts", () => ({
  RealtimeTalkSession: realtimeTalkSessionCtor,
}));

import { loadSettings } from "../../app/settings.ts";
import {
  attachChatRealtimeActions,
  createInitialChatRealtimeState,
  type ChatRealtimeState,
} from "./chat-realtime.ts";
import type { RealtimeTalkCallbacks, RealtimeTalkLaunchOptions } from "./realtime-talk.ts";

function mediaDevice(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

function createState(): ChatRealtimeState {
  const settings = loadSettings();
  const state = {
    client: {},
    connected: true,
    settings,
    sessionKey: "main",
    lastError: null,
    chatError: null,
    ...createInitialChatRealtimeState(settings.realtimeTalkInputDeviceId),
    requestUpdate: vi.fn(),
  } as unknown as ChatRealtimeState;
  attachChatRealtimeActions(state);
  return state;
}

const vadThresholdCases: Array<[string, string, number | undefined]> = [
  ["zero", "0", 0],
  ["ordinary value", "0.35", 0.35],
  ["blank", "", undefined],
  ["whitespace", "  ", undefined],
  ["non-number", "loud", undefined],
  ["below range", "-0.1", undefined],
  ["above range", "1.1", undefined],
];

describe("chat realtime actions", () => {
  beforeEach(() => {
    localStorage.clear();
    realtimeTalkSessionCtor.mockClear();
    sessionStart.mockReset();
    sessionStart.mockResolvedValue(undefined);
    sessionStop.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(vadThresholdCases)(
    "normalizes a %s VAD threshold at the launch boundary",
    async (_label, input, expected) => {
      const state = createState();
      state.updateRealtimeTalkOptions({ vadThreshold: input });

      await state.toggleRealtimeTalk();

      const launchOptions = (realtimeTalkSessionCtor.mock.calls as unknown[][])[0]?.[3] as
        | RealtimeTalkLaunchOptions
        | undefined;
      expect(launchOptions?.vadThreshold).toBe(expected);
    },
  );

  it("keeps the selected input in memory when persistence fails and shares it across panes", async () => {
    const firstPane = createState();
    const secondPane = createState();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    firstPane.selectRealtimeTalkInput("usb-mic");
    await secondPane.toggleRealtimeTalk();

    expect(firstPane.realtimeTalkInputDeviceId).toBe("usb-mic");
    expect(secondPane.realtimeTalkInputDeviceId).toBe("usb-mic");
    expect(realtimeTalkSessionCtor).toHaveBeenCalledWith(
      secondPane.client,
      "main",
      expect.any(Object),
      {},
      { inputDeviceId: "usb-mic" },
    );
    expect(sessionStart).toHaveBeenCalledOnce();
  });

  it("propagates normalized microphone levels and resets them on error", async () => {
    const state = createState();
    await state.toggleRealtimeTalk();
    const constructorCalls = realtimeTalkSessionCtor.mock.calls as unknown[][];
    const callbacks = constructorCalls[0]?.[2] as RealtimeTalkCallbacks | undefined;
    if (!callbacks) {
      throw new Error("expected realtime callbacks");
    }

    const updatesBeforeLevels = vi.mocked(state.requestUpdate).mock.calls.length;
    callbacks.onInputLevel?.(0.456);
    expect(state.realtimeTalkInputLevel.value).toBe(0.46);

    callbacks.onInputLevel?.(2);
    expect(state.realtimeTalkInputLevel.value).toBe(1);
    expect(state.requestUpdate).toHaveBeenCalledTimes(updatesBeforeLevels);

    callbacks.onStatus?.("error", "capture failed");
    expect(state.realtimeTalkInputLevel.value).toBe(0);
  });

  it("ignores a stopped session that rejects after its replacement starts", async () => {
    let rejectFirstStart: (error: Error) => void = () => undefined;
    sessionStart.mockImplementationOnce(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          rejectFirstStart = reject;
        }),
    );
    const state = createState();

    const firstStart = state.toggleRealtimeTalk();
    await vi.waitFor(() => expect(realtimeTalkSessionCtor).toHaveBeenCalledTimes(1));
    const firstCallbacks = (realtimeTalkSessionCtor.mock.calls as unknown[][])[0]?.[2] as
      | RealtimeTalkCallbacks
      | undefined;
    await state.toggleRealtimeTalk();
    await state.toggleRealtimeTalk();
    const secondSession = realtimeTalkSessionCtor.mock.results[1]?.value;
    const secondCallbacks = (realtimeTalkSessionCtor.mock.calls as unknown[][])[1]?.[2] as
      | RealtimeTalkCallbacks
      | undefined;
    secondCallbacks?.onStatus?.("listening");

    rejectFirstStart(new Error("late setup failure"));
    await firstStart;
    firstCallbacks?.onInputLevel?.(0.9);
    firstCallbacks?.onTranscript?.({ role: "user", text: "stale", final: true });
    firstCallbacks?.onStatus?.("error", "stale failure");

    expect(state.realtimeTalkSession).toBe(secondSession);
    expect(state.realtimeTalkActive).toBe(true);
    expect(state.realtimeTalkStatus).toBe("listening");
    expect(state.realtimeTalkInputLevel.value).toBe(0);
    expect(state.realtimeTalkConversation).toEqual([]);
  });

  it("does not reject a persisted input from incomplete passive discovery", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          mediaDevice("audioinput", "built-in", "Built-in Microphone"),
        ]),
      },
    });
    const state = createState();
    state.settings = { ...state.settings, gatewayUrl: "ws://passive-discovery.example" };
    state.selectRealtimeTalkInput("usb-mic");

    await state.refreshRealtimeTalkInputs(false);

    expect(state.realtimeTalkInputDeviceId).toBe("usb-mic");
    expect(state.realtimeTalkInputError).toBeNull();
  });

  it("reports a missing persisted input after successful permissioned discovery", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          mediaDevice("audioinput", "built-in", "Built-in Microphone"),
        ]),
      },
    });
    const state = createState();
    state.settings = { ...state.settings, gatewayUrl: "ws://permissioned-discovery.example" };
    state.selectRealtimeTalkInput("usb-mic");

    await state.refreshRealtimeTalkInputs(true);

    expect(state.realtimeTalkInputDeviceId).toBe("usb-mic");
    expect(state.realtimeTalkInputError).toContain("The selected microphone is unavailable");
  });

  it("keeps permission guidance when permissioned discovery is incomplete", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          mediaDevice("audioinput", "built-in", "Built-in Microphone"),
          mediaDevice("audioinput", "", ""),
        ]),
        getUserMedia: vi.fn(async () => {
          throw new DOMException("denied", "NotAllowedError");
        }),
      },
    });
    const state = createState();
    state.settings = { ...state.settings, gatewayUrl: "ws://blocked-discovery.example" };
    state.selectRealtimeTalkInput("usb-mic");

    await state.refreshRealtimeTalkInputs(true);

    expect(state.realtimeTalkInputError).toContain("Microphone access is blocked");
  });
});
