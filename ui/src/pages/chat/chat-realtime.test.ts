// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { loadSettings, saveSettings } from "../../app/settings.ts";
import {
  attachChatRealtimeActions,
  createInitialChatRealtimeState,
  type ChatRealtimeState,
} from "./chat-realtime.ts";
import type { RealtimeTalkCallbacks } from "./realtime-talk-shared.ts";
import { RealtimeTalkSession } from "./realtime-talk.ts";

type InspectableRealtimeTalkSession = {
  callbacks: RealtimeTalkCallbacks;
  localOptions: { inputDeviceId?: string };
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
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.clear();
    startSpy = vi.spyOn(RealtimeTalkSession.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(RealtimeTalkSession.prototype, "stop").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    saveSettings(loadSettings());
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("launches with the microphone persisted from the Settings page", async () => {
    saveSettings({ ...loadSettings(), realtimeTalkInputDeviceId: "usb-mic" });
    const state = createState();

    await state.toggleRealtimeTalk();

    expect(inspectSession(state).localOptions.inputDeviceId).toBe("usb-mic");
    expect(startSpy).toHaveBeenCalledOnce();
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
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
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
