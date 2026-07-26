// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { loadSettings, saveSettings } from "../../app/settings.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  attachChatRealtimeActions,
  createInitialChatRealtimeState,
  type ChatRealtimeState,
} from "./chat-realtime.ts";
import type { RealtimeTalkCallbacks } from "./realtime-talk-shared.ts";
import { RealtimeTalkSession } from "./realtime-talk.ts";

type InspectableRealtimeTalkSession = {
  callbacks: RealtimeTalkCallbacks;
  options: { provider?: string; transport?: string };
  localOptions: { inputDeviceId?: string; videoDeviceId?: string };
};

function inspectSession(state: ChatRealtimeState): InspectableRealtimeTalkSession {
  const session = state.realtimeTalkSession;
  if (!session) {
    throw new Error("expected realtime session");
  }
  return session as unknown as InspectableRealtimeTalkSession;
}

function createState(): ChatRealtimeState {
  const state = {
    client: {},
    connected: true,
    settings: loadSettings(),
    sessionKey: "main",
    lastError: null,
    chatError: null,
    ...createInitialChatRealtimeState(),
    requestUpdate: vi.fn(),
  } as unknown as ChatRealtimeState;
  attachChatRealtimeActions(state);
  return state;
}

describe("chat realtime actions", () => {
  // Capture the spy instead of re-reading it off the prototype so assertions do
  // not reference an unbound method (typescript/unbound-method).
  let startSpy: MockInstance<RealtimeTalkSession["start"]>;

  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    startSpy = vi.spyOn(RealtimeTalkSession.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(RealtimeTalkSession.prototype, "stop").mockImplementation(() => undefined);
    vi.spyOn(RealtimeTalkSession.prototype, "switchCamera").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    saveSettings(loadSettings());
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("launches with the microphone persisted from the Settings page", async () => {
    saveSettings({
      ...loadSettings(),
      realtimeTalkInputDeviceId: "usb-mic",
      realtimeTalkVideoDeviceId: "desk-camera",
    });
    const state = createState();

    await state.toggleRealtimeTalk();

    expect(inspectSession(state).localOptions.inputDeviceId).toBe("usb-mic");
    expect(inspectSession(state).localOptions.videoDeviceId).toBe("desk-camera");
    expect(startSpy).toHaveBeenCalledOnce();
  });

  it("enables camera only after a video-capable voice session starts", async () => {
    const state = createState();
    const setVideoEnabled = vi
      .spyOn(RealtimeTalkSession.prototype, "setVideoEnabled")
      .mockResolvedValue(undefined);

    await state.toggleRealtimeTalk();
    const session = inspectSession(state);
    const stream = {} as MediaStream;
    session.callbacks.onVideoCapability?.(true);
    await state.toggleRealtimeTalkCamera();
    session.callbacks.onVideoStream?.(stream);

    expect(session.options.provider).toBeUndefined();
    expect(session.options.transport).toBeUndefined();
    expect(setVideoEnabled).toHaveBeenCalledWith(true);
    expect(state.realtimeTalkVideoStream).toBe(stream);
    expect(loadSettings().talkCameraAutoEnable).toBe(true);

    await state.toggleRealtimeTalkCamera();
    expect(setVideoEnabled).toHaveBeenLastCalledWith(false);
    session.callbacks.onVideoStream?.(null);
    expect(state.realtimeTalkVideoStream).toBeNull();
    expect(loadSettings().talkCameraAutoEnable).toBe(false);
  });

  it("auto-enables camera once after the session reaches listening", async () => {
    saveSettings({ ...loadSettings(), talkCameraAutoEnable: true });
    const state = createState();
    const setVideoEnabled = vi
      .spyOn(RealtimeTalkSession.prototype, "setVideoEnabled")
      .mockResolvedValue(undefined);

    await state.toggleRealtimeTalk();
    const session = inspectSession(state);
    session.callbacks.onVideoCapability?.(true);
    await Promise.resolve();
    expect(setVideoEnabled).not.toHaveBeenCalled();

    session.callbacks.onStatus?.("listening");
    session.callbacks.onStatus?.("listening");
    await vi.waitFor(() => expect(setVideoEnabled).toHaveBeenCalledOnce());

    expect(setVideoEnabled).toHaveBeenCalledWith(true);
  });

  it("uses the latest Settings camera choice on the next enable", async () => {
    const state = createState();
    const switchCamera = vi.spyOn(RealtimeTalkSession.prototype, "switchCamera");
    vi.spyOn(RealtimeTalkSession.prototype, "setVideoEnabled").mockResolvedValue(undefined);

    await state.toggleRealtimeTalk();
    inspectSession(state).callbacks.onVideoCapability?.(true);
    saveSettings({ ...loadSettings(), realtimeTalkVideoDeviceId: "back-camera" });
    await state.toggleRealtimeTalkCamera();

    expect(switchCamera).toHaveBeenCalledWith("back-camera");
  });

  it("does not touch the camera when the session never reaches listening", async () => {
    saveSettings({ ...loadSettings(), talkCameraAutoEnable: true });
    const state = createState();
    const setVideoEnabled = vi
      .spyOn(RealtimeTalkSession.prototype, "setVideoEnabled")
      .mockResolvedValue(undefined);

    await state.toggleRealtimeTalk();
    const session = inspectSession(state);
    session.callbacks.onVideoCapability?.(true);
    session.callbacks.onStatus?.("error", "Microphone access failed");
    await Promise.resolve();

    expect(setVideoEnabled).not.toHaveBeenCalled();
    expect(loadSettings().talkCameraAutoEnable).toBe(true);
  });

  it.each([undefined, false])(
    "does not auto-enable camera when the remembered preference is %s",
    async (talkCameraAutoEnable) => {
      saveSettings({ ...loadSettings(), talkCameraAutoEnable });
      const state = createState();
      const setVideoEnabled = vi
        .spyOn(RealtimeTalkSession.prototype, "setVideoEnabled")
        .mockResolvedValue(undefined);

      await state.toggleRealtimeTalk();
      const session = inspectSession(state);
      session.callbacks.onVideoCapability?.(true);
      session.callbacks.onStatus?.("listening");
      await Promise.resolve();

      expect(setVideoEnabled).not.toHaveBeenCalled();
    },
  );

  it("turns off remembered auto-enable after an automatic camera failure", async () => {
    saveSettings({ ...loadSettings(), talkCameraAutoEnable: true });
    const state = createState();
    vi.spyOn(RealtimeTalkSession.prototype, "setVideoEnabled").mockRejectedValue(
      new Error("Camera access is blocked"),
    );

    await state.toggleRealtimeTalk();
    const failingSession = inspectSession(state);
    failingSession.callbacks.onVideoCapability?.(true);
    failingSession.callbacks.onStatus?.("listening");
    await vi.waitFor(() => expect(state.realtimeTalkCameraError).toBe(true));

    expect(state.realtimeTalkDetail).toBe("Camera access is blocked");
    expect(loadSettings().talkCameraAutoEnable).toBe(false);
  });

  it("does not change the remembered preference when the camera track ends", async () => {
    const state = createState();
    vi.spyOn(RealtimeTalkSession.prototype, "setVideoEnabled").mockResolvedValue(undefined);

    await state.toggleRealtimeTalk();
    const session = inspectSession(state);
    session.callbacks.onVideoCapability?.(true);
    await state.toggleRealtimeTalkCamera();
    session.callbacks.onVideoStream?.({} as MediaStream);
    expect(loadSettings().talkCameraAutoEnable).toBe(true);

    session.callbacks.onVideoStream?.(null);

    expect(state.realtimeTalkVideoStream).toBeNull();
    expect(loadSettings().talkCameraAutoEnable).toBe(true);
  });

  it("does not let a stale camera-off completion overwrite a newer camera stream", async () => {
    const state = createState();
    let resolveCameraOff: () => void = () => undefined;
    const setVideoEnabled = vi
      .spyOn(RealtimeTalkSession.prototype, "setVideoEnabled")
      .mockImplementation((enabled) =>
        enabled
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              resolveCameraOff = resolve;
            }),
      );

    await state.toggleRealtimeTalk();
    const firstSession = inspectSession(state);
    firstSession.callbacks.onVideoCapability?.(true);
    await state.toggleRealtimeTalkCamera();
    firstSession.callbacks.onVideoStream?.({} as MediaStream);

    const disabling = state.toggleRealtimeTalkCamera();
    expect(loadSettings().talkCameraAutoEnable).toBe(false);
    await state.toggleRealtimeTalk();
    await state.toggleRealtimeTalk();
    const secondSession = inspectSession(state);
    secondSession.callbacks.onVideoCapability?.(true);
    await state.toggleRealtimeTalkCamera();
    secondSession.callbacks.onVideoStream?.({} as MediaStream);
    expect(loadSettings().talkCameraAutoEnable).toBe(true);

    resolveCameraOff();
    await disabling;

    expect(setVideoEnabled).toHaveBeenCalledTimes(3);
    expect(loadSettings().talkCameraAutoEnable).toBe(true);
  });

  it("keeps voice active and surfaces a non-fatal camera error", async () => {
    const state = createState();
    vi.spyOn(RealtimeTalkSession.prototype, "setVideoEnabled").mockRejectedValue(
      new Error("Camera access is blocked"),
    );

    await state.toggleRealtimeTalk();
    const session = inspectSession(state);
    session.callbacks.onVideoCapability?.(true);
    session.callbacks.onStatus?.("listening");
    await state.toggleRealtimeTalkCamera();

    expect(state.realtimeTalkSession).not.toBeNull();
    expect(state.realtimeTalkActive).toBe(true);
    expect(state.realtimeTalkStatus).toBe("listening");
    expect(state.realtimeTalkVideoStream).toBeNull();
    expect(state.realtimeTalkDetail).toBe("Camera access is blocked");
    expect(state.realtimeTalkCameraError).toBe(true);
  });

  it("cycles live cameras in enumeration order and persists the successful switch", async () => {
    const state = createState();
    const switchCamera = vi
      .spyOn(RealtimeTalkSession.prototype, "switchCamera")
      .mockResolvedValue(undefined);

    await state.toggleRealtimeTalk();
    const stream = {
      getVideoTracks: () => [
        {
          getSettings: () => ({ deviceId: "front" }),
        } as MediaStreamTrack,
      ],
    } as unknown as MediaStream;
    state.realtimeTalkVideoStream = stream;
    state.realtimeTalkCameraDevices = [
      { deviceId: "front", label: "Front Camera" },
      { deviceId: "back", label: "Back Camera" },
    ];

    await state.switchRealtimeTalkCamera();

    expect(switchCamera).toHaveBeenCalledWith("back");
    expect(loadSettings().realtimeTalkVideoDeviceId).toBe("back");
    expect(state.realtimeTalkCameraError).toBe(false);
  });

  it("keeps the restored preview and reports a failed live camera switch", async () => {
    const state = createState();
    vi.spyOn(RealtimeTalkSession.prototype, "switchCamera").mockRejectedValue(
      new Error("The selected camera is unavailable"),
    );

    await state.toggleRealtimeTalk();
    const stream = {
      getVideoTracks: () => [
        {
          getSettings: () => ({ deviceId: "front" }),
        } as MediaStreamTrack,
      ],
    } as unknown as MediaStream;
    state.realtimeTalkVideoStream = stream;
    state.realtimeTalkCameraDevices = [
      { deviceId: "front", label: "Front Camera" },
      { deviceId: "missing", label: "Missing Camera" },
    ];

    await state.switchRealtimeTalkCamera();

    expect(state.realtimeTalkVideoStream).toBe(stream);
    expect(state.realtimeTalkCameraError).toBe(true);
    expect(state.realtimeTalkDetail).toBe("The selected camera is unavailable");
    expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();
  });

  it("keeps the connection error when camera toggle is requested after failure", async () => {
    const state = createState();
    const setVideoEnabled = vi
      .spyOn(RealtimeTalkSession.prototype, "setVideoEnabled")
      .mockResolvedValue(undefined);

    await state.toggleRealtimeTalk();
    const session = inspectSession(state);
    session.callbacks.onVideoCapability?.(true);
    session.callbacks.onStatus?.("error", "Realtime connection closed");
    await state.toggleRealtimeTalkCamera();

    expect(setVideoEnabled).not.toHaveBeenCalled();
    expect(state.realtimeTalkDetail).toBe("Realtime connection closed");
    expect(state.realtimeTalkCameraError).toBe(false);
  });

  it("keeps a connection error authoritative over an in-flight camera rejection", async () => {
    const state = createState();
    let rejectCamera: (error: Error) => void = () => undefined;
    vi.spyOn(RealtimeTalkSession.prototype, "setVideoEnabled").mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCamera = reject;
        }),
    );

    await state.toggleRealtimeTalk();
    const session = inspectSession(state);
    session.callbacks.onVideoCapability?.(true);
    session.callbacks.onStatus?.("listening");
    const toggling = state.toggleRealtimeTalkCamera();
    await Promise.resolve();
    session.callbacks.onStatus?.("error", "Realtime connection closed");
    rejectCamera(new Error("Camera access is blocked"));
    await toggling;

    expect(state.realtimeTalkDetail).toBe("Realtime connection closed");
    expect(state.realtimeTalkCameraError).toBe(false);
  });

  it("releases a camera stream that arrives after a connection error", async () => {
    const state = createState();
    let resolveCamera: () => void = () => undefined;
    const setVideoEnabled = vi
      .spyOn(RealtimeTalkSession.prototype, "setVideoEnabled")
      .mockImplementation((enabled) =>
        enabled
          ? new Promise<void>((resolve) => {
              resolveCamera = resolve;
            })
          : Promise.resolve(),
      );

    await state.toggleRealtimeTalk();
    const session = inspectSession(state);
    session.callbacks.onVideoCapability?.(true);
    session.callbacks.onStatus?.("listening");
    const toggling = state.toggleRealtimeTalkCamera();
    await Promise.resolve();
    session.callbacks.onStatus?.("error", "Realtime connection closed");
    session.callbacks.onVideoStream?.({} as MediaStream);
    resolveCamera();
    await toggling;

    expect(setVideoEnabled).toHaveBeenLastCalledWith(false);
    expect(state.realtimeTalkVideoStream).toBeNull();
    expect(state.realtimeTalkDetail).toBe("Realtime connection closed");
    expect(state.realtimeTalkCameraError).toBe(false);
  });

  it("re-reads the persisted microphone on every launch instead of caching it", async () => {
    const state = createState();
    await state.toggleRealtimeTalk();
    expect(inspectSession(state).localOptions.inputDeviceId).toBeUndefined();
    await state.toggleRealtimeTalk();

    // A microphone picked in Settings after the chat page mounted must apply
    // to the next session without a reload.
    saveSettings({ ...loadSettings(), realtimeTalkInputDeviceId: "usb-mic" });
    await state.toggleRealtimeTalk();

    expect(inspectSession(state).localOptions.inputDeviceId).toBe("usb-mic");
  });

  it("keeps a microphone picked while storage is blocked for the next launch", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    saveSettings({ ...loadSettings(), realtimeTalkInputDeviceId: "usb-mic" });
    const state = createState();

    await state.toggleRealtimeTalk();

    expect(inspectSession(state).localOptions.inputDeviceId).toBe("usb-mic");
  });

  it("propagates normalized microphone levels and resets them on error", async () => {
    const state = createState();
    await state.toggleRealtimeTalk();
    const { callbacks } = inspectSession(state);

    const updatesBeforeLevels = vi.mocked(state.requestUpdate).mock.calls.length;
    callbacks.onInputLevel?.(0.456);
    expect(state.realtimeTalkInputLevel.value).toBe(0.46);

    callbacks.onInputLevel?.(2);
    expect(state.realtimeTalkInputLevel.value).toBe(1);
    expect(state.requestUpdate).toHaveBeenCalledTimes(updatesBeforeLevels);

    callbacks.onStatus?.("error", "capture failed");
    expect(state.realtimeTalkInputLevel.value).toBe(0);
  });

  it("keeps a late final rewrite in its original user bubble", async () => {
    const state = createState();
    await state.toggleRealtimeTalk();
    const { callbacks } = inspectSession(state);

    callbacks.onTranscript?.({ role: "user", text: "Can you tack", final: false });
    callbacks.onTranscript?.({ role: "assistant", text: "Checking", final: false });
    callbacks.onTranscript?.({ role: "user", text: "Can you check?", final: true });

    expect(state.realtimeTalkConversation).toMatchObject([
      { role: "user", text: "Can you check?", isStreaming: false },
      { role: "assistant", text: "Checking", isStreaming: true },
    ]);
  });

  it("starts a new user bubble after assistant output for a distinct final turn", async () => {
    const state = createState();
    await state.toggleRealtimeTalk();
    const { callbacks } = inspectSession(state);

    callbacks.onTranscript?.({ role: "user", text: "First request", final: false });
    callbacks.onTranscript?.({ role: "assistant", text: "Checking", final: false });
    callbacks.onTranscript?.({ role: "user", text: "Second request", final: true });

    expect(state.realtimeTalkConversation).toMatchObject([
      { role: "user", text: "First request", isStreaming: false },
      { role: "assistant", text: "Checking", isStreaming: false },
      { role: "user", text: "Second request", isStreaming: false },
    ]);
  });

  it("ignores a stopped session that rejects after its replacement starts", async () => {
    let rejectFirstStart: (error: Error) => void = () => undefined;
    startSpy.mockImplementationOnce(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          rejectFirstStart = reject;
        }),
    );
    const state = createState();

    const firstStart = state.toggleRealtimeTalk();
    await vi.waitFor(() => expect(state.realtimeTalkSession).not.toBeNull());
    const firstCallbacks = inspectSession(state).callbacks;
    await state.toggleRealtimeTalk();
    await state.toggleRealtimeTalk();
    const secondSession = inspectSession(state);
    secondSession.callbacks.onStatus?.("listening");

    rejectFirstStart(new Error("late setup failure"));
    await firstStart;
    firstCallbacks.onInputLevel?.(0.9);
    firstCallbacks.onTranscript?.({ role: "user", text: "stale", final: true });
    firstCallbacks.onStatus?.("error", "stale failure");

    expect(state.realtimeTalkSession).toBe(secondSession);
    expect(state.realtimeTalkActive).toBe(true);
    expect(state.realtimeTalkStatus).toBe("listening");
    expect(state.realtimeTalkInputLevel.value).toBe(0);
    expect(state.realtimeTalkConversation).toEqual([]);
  });
});
