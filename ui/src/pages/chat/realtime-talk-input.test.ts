// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverRealtimeTalkInputs, openRealtimeTalkInput } from "./realtime-talk-input.ts";

function mediaDevice(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

afterEach(() => {
  vi.unstubAllGlobals();
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
      warning: null,
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
      warning: null,
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).toHaveBeenCalledOnce();
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it("keeps System default usable when microphone permission is denied", async () => {
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
    expect(result.warning).toContain("Microphone access is blocked");
  });

  it("does not silently fall back when the selected microphone is unavailable", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("missing", "OverconstrainedError");
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openRealtimeTalkInput("missing-mic")).rejects.toThrow(
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

    await expect(openRealtimeTalkInput(" usb-mic ")).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "usb-mic" },
      },
    });
  });

  it("acquires camera separately so video errors do not mask microphone errors", async () => {
    const audioTrack = {} as MediaStreamTrack;
    const videoTrack = {} as MediaStreamTrack;
    const audio = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const camera = { getVideoTracks: () => [videoTrack] } as unknown as MediaStream;
    class TestMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
    }
    const getUserMedia = vi.fn().mockResolvedValueOnce(audio).mockResolvedValueOnce(camera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaStream", TestMediaStream);

    const combined = await openRealtimeTalkInput("usb-mic", { video: true });
    expect(combined).toBeInstanceOf(TestMediaStream);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "usb-mic" },
      },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: true });
    expect((combined as unknown as TestMediaStream).tracks).toEqual([audioTrack, videoTrack]);
  });

  it("reports camera permission denial with actionable guidance", async () => {
    const stop = vi.fn();
    const audio = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(audio)
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openRealtimeTalkInput(undefined, { video: true })).rejects.toThrow(
      "Camera access is blocked",
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it("reports a missing camera when an exact microphone is selected", async () => {
    const stop = vi.fn();
    const audio = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(audio)
      .mockRejectedValueOnce(new DOMException("missing", "NotFoundError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openRealtimeTalkInput("usb-mic", { video: true })).rejects.toThrow(
      "No camera was found",
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it("releases partial media when video acquisition is cancelled", async () => {
    const audioStop = vi.fn();
    const videoStop = vi.fn();
    const audio = {
      getAudioTracks: () => [{} as MediaStreamTrack],
      getTracks: () => [{ stop: audioStop }],
    } as unknown as MediaStream;
    const camera = {
      getVideoTracks: () => [{} as MediaStreamTrack],
      getTracks: () => [{ stop: videoStop }],
    } as unknown as MediaStream;
    let resolveCamera: (stream: MediaStream) => void = () => undefined;
    const cameraPending = new Promise<MediaStream>((resolve) => {
      resolveCamera = resolve;
    });
    const getUserMedia = vi.fn().mockResolvedValueOnce(audio).mockReturnValueOnce(cameraPending);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const controller = new AbortController();

    const opening = openRealtimeTalkInput(undefined, {
      video: true,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(audioStop).toHaveBeenCalledOnce();
    resolveCamera(camera);

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(videoStop).toHaveBeenCalledOnce();
  });

  it("enables voice processing with the system default microphone", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openRealtimeTalkInput(undefined)).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  });
});
