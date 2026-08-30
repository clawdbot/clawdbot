// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverRealtimeTalkCameras,
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  openRealtimeTalkCamera,
  RealtimeTalkInputController,
} from "./realtime-talk-input.ts";

function mediaDevice(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

function legacyWebKitOverconstrainedError(): Error & { constraint: string } {
  return Object.assign(new Error("Invalid constraint"), {
    name: "OverconstrainedError",
    constraint: "",
  });
}

function microphoneFixture() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const addEventListener = vi.spyOn(track, "addEventListener");
  return {
    track,
    addEventListener,
    stream: { getTracks: () => [track] } as unknown as MediaStream,
  };
}

function microphoneEndedListener(
  addEventListener: ReturnType<typeof microphoneFixture>["addEventListener"],
): EventListener {
  const listener = addEventListener.mock.calls.at(-1)?.[1];
  if (typeof listener !== "function") {
    throw new Error("expected microphone ended listener");
  }
  return listener;
}

const ownedInputs = new Set<RealtimeTalkInputController>();

function createMicrophoneInput(onEnded: (detail: string) => void = () => undefined) {
  const input = new RealtimeTalkInputController(onEnded);
  ownedInputs.add(input);
  return input;
}

function openMicrophone(inputDeviceId: string | undefined) {
  return createMicrophoneInput().open(inputDeviceId);
}

afterEach(() => {
  ownedInputs.forEach((input) => input.stop());
  ownedInputs.clear();
  vi.unstubAllGlobals();
});

describe("realtime Talk microphone lifetime", () => {
  it("releases input before a throwing microphone-loss callback", async () => {
    const { track, addEventListener, stream } = microphoneFixture();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    const onEnded = vi.fn(() => {
      expect(input.stream).toBeNull();
      expect(track.stop).toHaveBeenCalledOnce();
      throw new Error("consumer failed");
    });
    const input = createMicrophoneInput(onEnded);
    await input.open(undefined);
    const ended = microphoneEndedListener(addEventListener);

    expect(() => ended(new Event("ended"))).toThrow("consumer failed");
    expect(() => ended(new Event("ended"))).not.toThrow();
    input.stop();
    expect(onEnded).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    track.dispatchEvent(new Event("ended"));
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it("keeps a replacement input alive when a retired track reports ended", async () => {
    const previous = microphoneFixture();
    const replacement = microphoneFixture();
    const otherConsumer = vi.fn();
    previous.track.addEventListener("ended", otherConsumer);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(previous.stream)
          .mockResolvedValueOnce(replacement.stream),
      },
    });
    const onEnded = vi.fn();
    const input = createMicrophoneInput(onEnded);
    await input.open(undefined);
    const ended = microphoneEndedListener(previous.addEventListener);
    await input.open("replacement");

    ended(new Event("ended"));
    previous.track.dispatchEvent(new Event("ended"));
    expect(otherConsumer).toHaveBeenCalledOnce();
    expect(input.stream).toBe(replacement.stream);
    expect(previous.track.stop).toHaveBeenCalledOnce();
    expect(replacement.track.stop).not.toHaveBeenCalled();
    input.stop();
    expect(replacement.track.stop).toHaveBeenCalledOnce();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("cancels permission acquisition without retaining late microphone access", async () => {
    const { track, addEventListener, stream } = microphoneFixture();
    let resolveMedia: (stream: MediaStream) => void = () => undefined;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((resolve) => {
              resolveMedia = resolve;
            }),
        ),
      },
    });
    const onEnded = vi.fn();
    const input = createMicrophoneInput(onEnded);
    const opening = input.open(undefined);
    input.stop();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });

    resolveMedia(stream);
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
    expect(input.stream).toBeNull();
    expect(addEventListener).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
  });
});

describe("realtime Talk microphone inputs", () => {
  it("lists unique audio inputs without probing during passive refresh", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          mediaDevice("videoinput", "camera", "Camera"),
          mediaDevice("audioinput", "default", "Default - Built-in Microphone"),
          mediaDevice("audioinput", "built-in", "Built-in Microphone"),
          mediaDevice("audioinput", "usb", ""),
          mediaDevice("audioinput", "usb", "Duplicate"),
        ]),
        getUserMedia,
      },
    });

    await expect(discoverRealtimeTalkInputs(false)).resolves.toEqual({
      devices: [
        { deviceId: "built-in", label: "Built-in Microphone" },
        { deviceId: "usb", label: "Microphone 2" },
      ],
      permissionRequired: true,
      issue: null,
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("probes once for permission, stops every track, and re-enumerates hidden inputs", async () => {
    const stopFirst = vi.fn();
    const stopSecond = vi.fn();
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([mediaDevice("audioinput", "", "")])
      .mockResolvedValueOnce([
        mediaDevice("audioinput", "built-in", "Built-in Microphone"),
        mediaDevice("audioinput", "loopback", "Loopback Audio"),
      ]);
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: stopFirst }, { stop: stopSecond }],
    }));
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices, getUserMedia } });

    await expect(discoverRealtimeTalkInputs(true)).resolves.toEqual({
      devices: [
        { deviceId: "built-in", label: "Built-in Microphone" },
        { deviceId: "loopback", label: "Loopback Audio" },
      ],
      permissionRequired: false,
      issue: null,
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).toHaveBeenCalledOnce();
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it("reports the blocked reason when microphone permission is denied", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [mediaDevice("audioinput", "", "")]),
        getUserMedia: vi.fn(async () => {
          throw new DOMException("denied", "NotAllowedError");
        }),
      },
    });

    const result = await discoverRealtimeTalkInputs(true);

    expect(result.devices).toEqual([]);
    expect(result.permissionRequired).toBe(true);
    expect(result.issue).toBe("permission-blocked");
  });

  it("separates an empty machine from a blocked browser", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => []),
        getUserMedia: vi.fn(async () => {
          throw new DOMException("none", "NotFoundError");
        }),
      },
    });

    await expect(discoverRealtimeTalkInputs(true)).resolves.toEqual({
      devices: [],
      permissionRequired: true,
      issue: "none-found",
    });
  });

  it("subscribes to devicechange and releases the listener on unsubscribe", () => {
    const mediaDevices = new EventTarget();
    let changes = 0;
    vi.stubGlobal("navigator", { mediaDevices });

    const unsubscribe = observeRealtimeTalkDevices(() => (changes += 1));
    mediaDevices.dispatchEvent(new Event("devicechange"));
    unsubscribe();
    mediaDevices.dispatchEvent(new Event("devicechange"));

    expect(changes).toBe(1);
  });

  it("stays inert where the browser exposes no media devices to watch", () => {
    vi.stubGlobal("navigator", {});
    expect(() => observeRealtimeTalkDevices(() => undefined)()).not.toThrow();
  });

  it("reports an unsupported enumeration instead of a generic access failure", async () => {
    vi.stubGlobal("navigator", { mediaDevices: {} });

    await expect(discoverRealtimeTalkInputs(true)).resolves.toEqual({
      devices: [],
      permissionRequired: false,
      issue: "list-unsupported",
    });
  });

  it("reports microphone permission denial with actionable guidance", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openMicrophone(undefined)).rejects.toThrow(
      "Microphone access is blocked. Allow it in browser site settings to list inputs.",
    );
  });

  it("explains a legacy WebKit overconstraint without silently falling back", async () => {
    const getUserMedia = vi.fn(async () => {
      throw legacyWebKitOverconstrainedError();
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openMicrophone("missing-mic")).rejects.toThrow(
      "The selected microphone is unavailable",
    );
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "missing-mic" },
      },
    });
  });

  it("enables voice processing with exact device selection", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openMicrophone(" usb-mic ")).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "usb-mic" },
      },
    });
  });

  it("does not request camera media after cancellation", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const controller = new AbortController();
    controller.abort();

    await expect(
      openRealtimeTalkCamera(undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("releases media when cancellation follows browser permission resolution", async () => {
    const stop = vi.fn();
    let resolveMedia: (stream: MediaStream) => void = () => undefined;
    const pending = new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => pending) },
    });
    const input = createMicrophoneInput();
    const opening = input.open(undefined);

    resolveMedia({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    input.stop();

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps cancellation precedence over a late media rejection", async () => {
    let rejectMedia: (error: unknown) => void = () => undefined;
    const pending = new Promise<MediaStream>((_resolve, reject) => {
      rejectMedia = reject;
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => pending) },
    });
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const opening = openRealtimeTalkCamera(undefined, { signal: controller.signal });

    controller.abort(reason);
    rejectMedia(new DOMException("denied", "NotAllowedError"));

    await expect(opening).rejects.toBe(reason);
  });

  it("acquires camera separately so camera errors cannot stop microphone input", async () => {
    const audio = { getTracks: () => [] } as unknown as MediaStream;
    const camera = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValueOnce(audio).mockResolvedValueOnce(camera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openMicrophone("usb-mic")).resolves.toBe(audio);
    await expect(openRealtimeTalkCamera(undefined)).resolves.toBe(camera);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "usb-mic" },
      },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: true });
  });

  it("reports camera permission denial with actionable guidance", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openRealtimeTalkCamera(undefined)).rejects.toThrow("Camera access is blocked");
  });

  it("reports a missing camera", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("missing", "NotFoundError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openRealtimeTalkCamera(undefined)).rejects.toThrow("No camera was found");
  });

  it("releases camera media when acquisition is cancelled", async () => {
    const videoStop = vi.fn();
    const camera = {
      getTracks: () => [{ stop: videoStop }],
    } as unknown as MediaStream;
    let resolveCamera: (stream: MediaStream) => void = () => undefined;
    const cameraPending = new Promise<MediaStream>((resolve) => {
      resolveCamera = resolve;
    });
    const getUserMedia = vi.fn().mockReturnValue(cameraPending);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const controller = new AbortController();

    const opening = openRealtimeTalkCamera(undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    controller.abort();

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    resolveCamera(camera);
    await vi.waitFor(() => expect(videoStop).toHaveBeenCalledOnce());
  });

  it("enables voice processing with the system default microphone", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openMicrophone(undefined)).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  });
});

describe("realtime Talk camera inputs", () => {
  it("lists unique cameras in enumeration order with normalized labels", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          mediaDevice("audioinput", "mic", "Microphone"),
          mediaDevice("videoinput", "default", "Default Camera"),
          mediaDevice("videoinput", "front", "Front Camera"),
          mediaDevice("videoinput", "back", ""),
          mediaDevice("videoinput", "back", "Duplicate"),
        ]),
        getUserMedia,
      },
    });

    await expect(discoverRealtimeTalkCameras(false)).resolves.toEqual({
      devices: [
        { deviceId: "front", label: "Front Camera" },
        { deviceId: "back", label: "Camera 2" },
      ],
      permissionRequired: true,
      issue: null,
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("probes video permission and re-enumerates hidden cameras", async () => {
    const stop = vi.fn();
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([mediaDevice("videoinput", "", "")])
      .mockResolvedValueOnce([mediaDevice("videoinput", "camera", "Desk Camera")]);
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices, getUserMedia } });

    await expect(discoverRealtimeTalkCameras(true)).resolves.toEqual({
      devices: [{ deviceId: "camera", label: "Desk Camera" }],
      permissionRequired: false,
      issue: null,
    });
    expect(getUserMedia).toHaveBeenCalledWith({ video: true });
    expect(stop).toHaveBeenCalledOnce();
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it("uses an exact selected-camera constraint", async () => {
    const camera = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => camera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openRealtimeTalkCamera(" back-camera ")).resolves.toBe(camera);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { deviceId: { exact: "back-camera" } },
    });
  });

  it("does not silently fall back when the selected camera is unavailable", async () => {
    const getUserMedia = vi.fn(async () => {
      throw legacyWebKitOverconstrainedError();
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openRealtimeTalkCamera("missing-camera")).rejects.toThrow(
      "The selected camera is unavailable",
    );
  });
});
