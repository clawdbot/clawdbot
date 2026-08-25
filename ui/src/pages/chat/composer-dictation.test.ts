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

function createHarness(
  overrides: {
    enabled?: boolean;
    realtimeTalkActive?: boolean;
    dictationAvailable?: boolean;
  } = {},
) {
  const onCommit = vi.fn();
  const onError = vi.fn();
  const onStateChange = vi.fn();
  const onTap = vi.fn();
  const onDictationUnavailable = vi.fn();
  const options = {
    client: createClient(),
    connected: true,
    enabled: overrides.enabled ?? true,
    dictationAvailable: overrides.dictationAvailable,
    realtimeTalkActive: overrides.realtimeTalkActive ?? false,
    onCommit,
    onError,
    onStateChange,
    onTap,
    onDictationUnavailable,
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
  return {
    controller,
    onCommit,
    onDictationUnavailable,
    onError,
    onStateChange,
    onTap,
    options,
    target,
  };
}

async function startHold(target: HTMLElement): Promise<void> {
  target.dispatchEvent(pointer("pointerdown"));
  await vi.advanceTimersByTimeAsync(500);
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything()),
  );
}

async function releaseLatched(target: HTMLElement): Promise<void> {
  document.dispatchEvent(pointer("pointerup"));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
}

async function commitLatched(
  controller: ComposerDictationController,
  target: HTMLElement,
): Promise<void> {
  await releaseLatched(target);
  void controller.finishActive();
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
  it("starts the canonical session immediately for a direct-dictation surface", async () => {
    const { controller } = createHarness();

    expect(controller.startDirect()).toBe(true);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything()),
    );

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(controller.active).toBe(true);
    controller.dispose();
  });

  it("commits and unlocks immediately while remote close finishes in background", async () => {
    let resolveClose: () => void = () => {};
    const close = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    request = vi.fn(async (method: string) => {
      if (method === "talk.session.create") {
        return {
          sessionId: "dictation-1",
          transcriptionSessionId: "dictation-1",
          audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
        };
      }
      if (method === "talk.session.close") {
        return close;
      }
      return { ok: true };
    });
    const { controller, onCommit, target } = createHarness();
    await startHold(target);
    emit({ transcriptionSessionId: "dictation-1", type: "partial", text: "keep this now" });

    const committed = controller.finishActive();

    expect(controller.active).toBe(false);
    expect(controller.locksComposer).toBe(false);
    expect(onCommit).toHaveBeenCalledWith("keep this now");
    await expect(committed).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" });
    resolveClose();
    await Promise.resolve();
    controller.dispose();
  });

  it("consumes the click tail when a hold falls back to unavailable dictation", async () => {
    const { controller, onDictationUnavailable, onTap, target } = createHarness({
      dictationAvailable: false,
    });

    target.dispatchEvent(pointer("pointerdown"));
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1);
    document.dispatchEvent(pointer("pointerup"));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onDictationUnavailable).toHaveBeenCalledOnce();
    expect(onTap).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(controller.locksComposer).toBe(false);

    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onTap).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("consumes release after the pointer enters the visible hold state", async () => {
    const { controller, onTap, target } = createHarness();

    target.dispatchEvent(pointer("pointerdown"));
    await vi.advanceTimersByTimeAsync(150);
    expect(controller.arming).toBe(true);
    document.dispatchEvent(pointer("pointerup"));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onTap).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(controller.locksComposer).toBe(false);

    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onTap).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("returns to idle and classifies microphone startup failures", async () => {
    getUserMedia = vi.fn(async () => {
      throw new DOMException("blocked", "NotAllowedError");
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    const { controller, onError, target } = createHarness();

    target.dispatchEvent(pointer("pointerdown"));
    await vi.advanceTimersByTimeAsync(500);
    await waitForFast(() =>
      expect(onError).toHaveBeenCalledWith(
        "Microphone access is blocked. Allow it in browser site settings to list inputs.",
        { kind: "start", preservesText: false },
      ),
    );

    expect(controller.active).toBe(false);
    expect(controller.locksComposer).toBe(false);
    expect(request).not.toHaveBeenCalledWith("talk.session.create", expect.anything());
    controller.dispose();
  });

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

  it("waits through a click grace period before drawing the hold ring", async () => {
    const { controller, onTap, target } = createHarness();

    target.dispatchEvent(pointer("pointerdown"));
    expect(controller.arming).toBe(false);
    await vi.advanceTimersByTimeAsync(149);
    expect(controller.arming).toBe(false);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.arming).toBe(true);
    await vi.advanceTimersByTimeAsync(349);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything()),
    );
    expect(onTap).not.toHaveBeenCalled();
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

  it("streams g711_ulaw audio and commits final transcript from latched Stop", async () => {
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
    expect(order.slice(0, 2)).toEqual(["microphone", "talk.session.create"]);
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
    await commitLatched(controller, target);
    expect(controller.finalizing).toBe(false);
    expect(onCommit).toHaveBeenCalledWith("hello world");
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
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

    await commitLatched(controller, target);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    expect(onCommit).toHaveBeenCalledWith("yes yes");
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

    await commitLatched(controller, target);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    expect(onCommit).toHaveBeenCalledWith("hello world");
    controller.dispose();
  });

  it("reports whether the immediate snapshot committed a transcript", async () => {
    const withTranscript = createHarness();
    await startHold(withTranscript.target);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "send these words",
      final: true,
    });
    const committed = withTranscript.controller.finishActive();
    await expect(committed).resolves.toBe(true);
    withTranscript.controller.dispose();

    const withoutTranscript = createHarness();
    await startHold(withoutTranscript.target);
    const empty = withoutTranscript.controller.finishActive();
    await expect(empty).resolves.toBe(false);
    withoutTranscript.controller.dispose();
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

    await commitLatched(controller, target);
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
    expect(onCommit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("closes a late session in background after latched Stop", async () => {
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

    await commitLatched(controller, target);
    resolveCreate({
      sessionId: "late-session",
      transcriptionSessionId: "late-session",
      audio: { inputEncoding: "unsupported", inputSampleRateHz: 48_000 },
    });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "late-session" }),
    );
    expect(onError).not.toHaveBeenCalled();
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

  it("stays latched after release until the square keeps the transcript", async () => {
    const { controller, onCommit, target } = createHarness();
    await startHold(target);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "keep recording",
      final: true,
    });

    await releaseLatched(target);
    document.dispatchEvent(pointer("pointermove", 7, 150, 50));
    target.dispatchEvent(pointer("lostpointercapture"));
    expect(controller.active).toBe(true);
    expect(controller.locksComposer).toBe(true);
    expect(request).not.toHaveBeenCalledWith("talk.session.close", expect.anything());

    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    expect(onCommit).toHaveBeenCalledWith("keep recording");
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
    await waitForFast(() => expect(harness.onCommit).toHaveBeenCalledWith("keep this unfinished"));
    expect(Date.now() - disconnectedAt).toBeLessThan(1000);
    expect(harness.onError).toHaveBeenCalledWith(
      "Dictation stopped because the Gateway disconnected.",
      { kind: "interrupted", preservesText: true },
    );
    expect(harness.onError).toHaveBeenCalledTimes(1);
    expect(harness.controller.finalizing).toBe(false);
    expect(harness.controller.locksComposer).toBe(false);
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
