// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverRealtimeTalkCameras,
  discoverRealtimeTalkInputs,
  openRealtimeTalkCamera,
  openRealtimeTalkInput,
} from "./realtime-talk-input.ts";

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
      permissionRequired: true,
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
      permissionRequired: false,
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
    expect(result.permissionRequired).toBe(true);
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

  it("acquires camera separately so camera errors cannot stop microphone input", async () => {
    const audio = { getTracks: () => [] } as unknown as MediaStream;
    const camera = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValueOnce(audio).mockResolvedValueOnce(camera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openRealtimeTalkInput("usb-mic")).resolves.toBe(audio);
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
      warning: null,
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
      warning: null,
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
      throw new DOMException("missing", "OverconstrainedError");
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openRealtimeTalkCamera("missing-camera")).rejects.toThrow(
      "The selected camera is unavailable",
    );
  });
});
