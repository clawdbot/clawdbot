// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { ComposerDictationController, insertComposerDictation } from "./composer-dictation.ts";

type GatewayListener = (event: GatewayEventFrame) => void;
type MockProcessor = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
};

const listeners = new Set<GatewayListener>();
const processors: MockProcessor[] = [];
let request: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;

class MockAudioContext {
  readonly destination = {};
  readonly sampleRate = 8000;
  readonly close = vi.fn(async () => undefined);

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor() {
    const processor: MockProcessor = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    };
    processors.push(processor);
    return processor;
  }

  createGain() {
    return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
    };
  }
}

function createClient(): GatewayBrowserClient {
  return {
    addEventListener: vi.fn((listener: GatewayListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    request,
  } as unknown as GatewayBrowserClient;
}

function emit(payload: Record<string, unknown>): void {
  for (const listener of listeners) {
    listener({ event: "talk.event", payload } as GatewayEventFrame);
  }
}

function pointer(type: string, pointerId = 7, x = 50, y = 50): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

function createHarness(overrides: { enabled?: boolean; realtimeTalkActive?: boolean } = {}) {
  const onCommit = vi.fn();
  const onError = vi.fn();
  const onStateChange = vi.fn();
  const onTap = vi.fn();
  const options = {
    client: createClient(),
    connected: true,
    enabled: overrides.enabled ?? true,
    realtimeTalkActive: overrides.realtimeTalkActive ?? false,
    onCommit,
    onError,
    onStateChange,
    onTap,
  };
  const controller = new ComposerDictationController(options);
  const target = document.createElement("button");
  target.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100 }) as DOMRect;
  target.setPointerCapture = vi.fn();
  target.releasePointerCapture = vi.fn();
  target.addEventListener("pointerdown", (event) =>
    controller.handlePointerDown(event as PointerEvent),
  );
  target.addEventListener("click", (event) => controller.handleClick(event));
  document.body.append(target);
  return { controller, onCommit, onError, onStateChange, onTap, options, target };
}

async function startHold(target: HTMLElement): Promise<void> {
  target.dispatchEvent(pointer("pointerdown"));
  await vi.advanceTimersByTimeAsync(250);
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything()),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  processors.length = 0;
  request = vi.fn(async (method: string) => {
    if (method === "talk.catalog") {
      return {
        modes: ["transcription"],
        transports: ["gateway-relay"],
        brains: ["none"],
        speech: { providers: [] },
        realtime: { providers: [] },
        transcription: { ready: true, activeProvider: "deepgram", providers: [] },
      };
    }
    if (method === "talk.session.create") {
      return {
        sessionId: "dictation-1",
        transcriptionSessionId: "dictation-1",
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      };
    }
    return { ok: true };
  });
  getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ stop: vi.fn() }],
  }));
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal("AudioContext", MockAudioContext);
});

afterEach(() => {
  document.body.replaceChildren();
  listeners.clear();
  processors.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ComposerDictationController", () => {
  it("keeps a quick pointer gesture as the existing tap action", async () => {
    const { controller, onTap, target } = createHarness();

    target.dispatchEvent(pointer("pointerdown"));
    expect(controller.locksComposer).toBe(true);
    document.dispatchEvent(pointer("pointerup"));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(300);

    expect(onTap).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(controller.locksComposer).toBe(false);
    controller.dispose();
  });

  it("does not swallow the next click after a hold is cancelled by blur", async () => {
    const { controller, onTap, target } = createHarness();

    target.dispatchEvent(pointer("pointerdown"));
    window.dispatchEvent(new Event("blur"));
    await Promise.resolve();
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onTap).toHaveBeenCalledOnce();
    expect(controller.locksComposer).toBe(false);
    controller.dispose();
  });

  it("streams g711_ulaw audio and commits final transcript on release", async () => {
    const order: string[] = [];
    getUserMedia = vi.fn(async () => {
      order.push("microphone");
      return { getTracks: () => [{ stop: vi.fn() }] };
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    request = vi.fn(async (method: string, params: unknown) => {
      order.push(method);
      if (method === "talk.catalog") {
        return {
          transcription: { ready: true, providers: [] },
          realtime: { providers: [] },
          speech: { providers: [] },
          modes: [],
          transports: [],
          brains: [],
        };
      }
      if (method === "talk.session.create") {
        return {
          sessionId: "dictation-1",
          transcriptionSessionId: "dictation-1",
          audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
        };
      }
      return params;
    });
    const { controller, onCommit, target } = createHarness();

    await startHold(target);
    expect(order.slice(0, 3)).toEqual(["talk.catalog", "microphone", "talk.session.create"]);
    const processor = processors.at(-1);
    if (!processor) {
      throw new Error("expected microphone processor");
    }
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0, 1, -1]) },
    });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.appendAudio", {
        sessionId: "dictation-1",
        audioBase64: "/4AA",
      }),
    );
    emit({
      transcriptionSessionId: "dictation-1",
      type: "partial",
      text: "hello wor",
    });
    expect(controller.partial).toBe("hello wor");
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "hello world",
      final: true,
    });
    document.dispatchEvent(pointer("pointerup"));
    expect(controller.finalizing).toBe(true);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    await vi.advanceTimersByTimeAsync(1500);

    await waitForFast(() => expect(onCommit).toHaveBeenCalledWith("hello world"));
    expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" });
    expect(order.indexOf("talk.session.appendAudio")).toBeLessThan(
      order.indexOf("talk.session.close"),
    );
    controller.dispose();
  });

  it("preserves repeated final transcript segments", async () => {
    const { controller, onCommit, target } = createHarness();
    await startHold(target);
    emit({ transcriptionSessionId: "dictation-1", type: "transcript", text: "yes", final: true });
    emit({ transcriptionSessionId: "dictation-1", type: "transcript", text: "yes", final: true });

    document.dispatchEvent(pointer("pointerup"));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    await vi.advanceTimersByTimeAsync(1500);

    await waitForFast(() => expect(onCommit).toHaveBeenCalledWith("yes yes"));
    controller.dispose();
  });

  it("previews non-final transcript frames without committing them", async () => {
    const { controller, onCommit, target } = createHarness();
    await startHold(target);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "hello",
      final: false,
    });
    expect(controller.partial).toBe("hello");
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "hello world",
      final: true,
    });

    document.dispatchEvent(pointer("pointerup"));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    await vi.advanceTimersByTimeAsync(1500);

    await waitForFast(() => expect(onCommit).toHaveBeenCalledWith("hello world"));
    controller.dispose();
  });

  it("keeps listening for a final transcript after close is acknowledged", async () => {
    const { controller, onCommit, target } = createHarness();
    await startHold(target);

    document.dispatchEvent(pointer("pointerup"));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "late final",
      final: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "second late",
      final: true,
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(onCommit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await waitForFast(() => expect(onCommit).toHaveBeenCalledWith("late final second late"));
    controller.dispose();
  });

  it("waits beyond the quiet interval for the first post-close transcript", async () => {
    const { controller, onCommit, target } = createHarness();
    await startHold(target);

    document.dispatchEvent(pointer("pointerup"));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    await vi.advanceTimersByTimeAsync(1600);
    expect(onCommit).not.toHaveBeenCalled();
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "slow first final",
      final: true,
    });
    await vi.advanceTimersByTimeAsync(1500);

    await waitForFast(() => expect(onCommit).toHaveBeenCalledWith("slow first final"));
    expect(controller.finalizing).toBe(false);
    expect(controller.locksComposer).toBe(false);
    controller.dispose();
  });

  it("extends the finalization window while partial transcript activity continues", async () => {
    const { controller, onCommit, target } = createHarness();
    await startHold(target);

    document.dispatchEvent(pointer("pointerup"));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    await vi.advanceTimersByTimeAsync(1400);
    emit({ transcriptionSessionId: "dictation-1", type: "partial", text: "still finalizing" });
    await vi.advanceTimersByTimeAsync(200);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "still finalizing",
      final: true,
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(onCommit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await waitForFast(() => expect(onCommit).toHaveBeenCalledWith("still finalizing"));
    controller.dispose();
  });

  it("surfaces provider errors raised while final text is draining", async () => {
    const { controller, onCommit, onError, target } = createHarness();
    await startHold(target);

    document.dispatchEvent(pointer("pointerup"));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    emit({
      transcriptionSessionId: "dictation-1",
      type: "error",
      message: "provider drain failed",
    });
    await vi.advanceTimersByTimeAsync(1500);

    expect(onError).toHaveBeenCalledWith("provider drain failed");
    expect(onCommit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("ignores extra clicks while final text is draining", async () => {
    const { controller, onTap, target } = createHarness();
    await startHold(target);
    document.dispatchEvent(pointer("pointerup"));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onTap).not.toHaveBeenCalled();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    controller.dispose();
  });

  it("buffers microphone audio while the transcription session is being created", async () => {
    const order: string[] = [];
    let resolveCreate: (result: {
      sessionId: string;
      transcriptionSessionId: string;
      audio: { inputEncoding: string; inputSampleRateHz: number };
    }) => void = () => undefined;
    const createResult = new Promise<{
      sessionId: string;
      transcriptionSessionId: string;
      audio: { inputEncoding: string; inputSampleRateHz: number };
    }>((resolve) => {
      resolveCreate = resolve;
    });
    request = vi.fn(async (method: string, params: unknown) => {
      order.push(method);
      if (method === "talk.catalog") {
        return {
          transcription: { ready: true, providers: [] },
          realtime: { providers: [] },
          speech: { providers: [] },
          modes: [],
          transports: [],
          brains: [],
        };
      }
      if (method === "talk.session.create") {
        return createResult;
      }
      return params;
    });
    const { controller, onCommit, target } = createHarness();
    await startHold(target);
    const processor = processors.at(-1);
    if (!processor) {
      throw new Error("expected microphone processor before session creation completes");
    }
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0, 1, -1]) },
    });
    expect(request).not.toHaveBeenCalledWith("talk.session.appendAudio", expect.anything());

    document.dispatchEvent(pointer("pointerup"));
    resolveCreate({
      sessionId: "late-session",
      transcriptionSessionId: "late-session",
      audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
    });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.appendAudio", {
        sessionId: "late-session",
        audioBase64: "/4AA",
      }),
    );
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "late-session" }),
    );
    expect(order.indexOf("talk.session.appendAudio")).toBeLessThan(
      order.indexOf("talk.session.close"),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onCommit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("closes a session created after the held pointer was released", async () => {
    let resolveCreate: (result: {
      sessionId: string;
      transcriptionSessionId: string;
      audio: { inputEncoding: string; inputSampleRateHz: number };
    }) => void = () => undefined;
    const createResult = new Promise<{
      sessionId: string;
      transcriptionSessionId: string;
      audio: { inputEncoding: string; inputSampleRateHz: number };
    }>((resolve) => {
      resolveCreate = resolve;
    });
    request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return {
          transcription: { ready: true, providers: [] },
          realtime: { providers: [] },
          speech: { providers: [] },
          modes: [],
          transports: [],
          brains: [],
        };
      }
      if (method === "talk.session.create") {
        return createResult;
      }
      return { ok: true };
    });
    const { controller, onError, target } = createHarness();
    await startHold(target);

    document.dispatchEvent(pointer("pointerup"));
    resolveCreate({
      sessionId: "late-session",
      transcriptionSessionId: "late-session",
      audio: { inputEncoding: "unsupported", inputSampleRateHz: 48_000 },
    });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "late-session" }),
    );
    expect(onError).toHaveBeenCalledWith(
      "The Gateway returned an unsupported dictation audio format.",
    );
    controller.dispose();
  });

  it("closes and discards transcript when Escape cancels", async () => {
    const { controller, onCommit, target } = createHarness();
    await startHold(target);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "discard me",
      final: true,
    });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    expect(onCommit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("cancels when the held pointer slides off the button", async () => {
    const { controller, onCommit, target } = createHarness();
    await startHold(target);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "discard me too",
      final: true,
    });

    document.dispatchEvent(pointer("pointermove", 7, 150, 50));

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    expect(onCommit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("cancels if the browser unexpectedly releases pointer capture", async () => {
    const { controller, onCommit, target } = createHarness();
    await startHold(target);

    target.dispatchEvent(pointer("lostpointercapture"));

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    expect(onCommit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("fails before microphone acquisition when transcription is unavailable", async () => {
    request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return {
          transcription: { ready: false, providers: [] },
          realtime: { providers: [] },
          speech: { providers: [] },
          modes: [],
          transports: [],
          brains: [],
        };
      }
      return { ok: true };
    });
    const { controller, onError, onTap, target } = createHarness();

    target.dispatchEvent(pointer("pointerdown"));
    await vi.advanceTimersByTimeAsync(250);

    await waitForFast(() =>
      expect(onError).toHaveBeenCalledWith(
        "No transcription provider is configured for dictation.",
      ),
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalledWith("talk.session.create", expect.anything());
    document.dispatchEvent(pointer("pointerup"));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onTap).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("commits final text promptly when the Gateway disconnects during a partial drain", async () => {
    const harness = createHarness();
    await startHold(harness.target);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "keep this",
      final: true,
    });
    emit({
      transcriptionSessionId: "dictation-1",
      type: "partial",
      text: "unfinished",
    });

    const disconnectedAt = Date.now();
    harness.controller.update({ ...harness.options, connected: false });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    await waitForFast(() => expect(harness.onCommit).toHaveBeenCalledWith("keep this"));
    expect(Date.now() - disconnectedAt).toBeLessThan(1000);
    expect(harness.onError).toHaveBeenCalledWith(
      "Dictation stopped because the Gateway disconnected.",
    );
    expect(harness.onError).toHaveBeenCalledTimes(1);
    expect(harness.controller.finalizing).toBe(false);
    expect(harness.controller.locksComposer).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.onError).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" });
    harness.controller.dispose();
  });

  it("disables hold while Talk owns the microphone and when the setting is off", async () => {
    const talk = createHarness({ realtimeTalkActive: true });
    talk.target.dispatchEvent(pointer("pointerdown"));
    await vi.advanceTimersByTimeAsync(300);
    expect(request).not.toHaveBeenCalled();
    expect(talk.onTap).not.toHaveBeenCalled();
    talk.controller.dispose();

    const settingOff = createHarness({ enabled: false });
    settingOff.target.dispatchEvent(pointer("pointerdown"));
    settingOff.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(settingOff.onTap).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    settingOff.controller.dispose();
  });
});

describe("insertComposerDictation", () => {
  it("inserts at the selection and joins surrounding text with sensible spaces", () => {
    expect(insertComposerDictation("hello world", "brave new", 6, 6)).toEqual({
      value: "hello brave new world",
      caret: 16,
    });
    expect(insertComposerDictation("hello world", "there", 6, 11)).toEqual({
      value: "hello there",
      caret: 11,
    });
  });
});
