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
