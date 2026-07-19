import { t } from "../../i18n/index.ts";

export type RealtimeTalkInputDevice = {
  deviceId: string;
  label: string;
};

export type RealtimeTalkCameraDevice = RealtimeTalkInputDevice;

type RealtimeTalkDeviceDiscovery = {
  devices: RealtimeTalkInputDevice[];
  warning: string | null;
};

type RealtimeTalkDeviceKind = "audioinput" | "videoinput";

function mediaDevices(kind: RealtimeTalkDeviceKind): MediaDevices {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.enumerateDevices) {
    throw new Error(
      t(
        kind === "audioinput"
          ? "chat.composer.microphoneListUnsupported"
          : "chat.composer.cameraListUnsupported",
      ),
    );
  }
  return devices;
}

function normalizeDevices(
  devices: MediaDeviceInfo[],
  kind: RealtimeTalkDeviceKind,
): RealtimeTalkInputDevice[] {
  const normalized: RealtimeTalkInputDevice[] = [];
  const seen = new Set<string>();
  for (const device of devices) {
    const deviceId = device.deviceId.trim();
    // Chromium exposes a synthetic `default` alias. The picker already owns a
    // provider-neutral System default entry, so listing the alias duplicates it.
    if (device.kind !== kind || !deviceId || deviceId === "default" || seen.has(deviceId)) {
      continue;
    }
    seen.add(deviceId);
    normalized.push({
      deviceId,
      label:
        device.label.trim() ||
        t(
          kind === "audioinput"
            ? "chat.composer.microphoneFallback"
            : "chat.composer.cameraFallback",
          { number: String(normalized.length + 1) },
        ),
    });
  }
  return normalized;
}

function describeDeviceError(error: unknown, kind: RealtimeTalkDeviceKind): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError") {
    return t(
      kind === "audioinput"
        ? "chat.composer.microphonePermissionBlocked"
        : "chat.composer.cameraPermissionBlocked",
    );
  }
  if (name === "NotFoundError") {
    return t(
      kind === "audioinput" ? "chat.composer.microphoneNoneFound" : "chat.composer.cameraNoneFound",
    );
  }
  if (name === "NotReadableError") {
    return t(kind === "audioinput" ? "chat.composer.microphoneBusy" : "chat.composer.cameraBusy");
  }
  if (name === "InvalidStateError") {
    return t(
      kind === "audioinput"
        ? "chat.composer.microphonePageInactive"
        : "chat.composer.cameraPageInactive",
    );
  }
  return t(
    kind === "audioinput"
      ? "chat.composer.microphoneAccessFailed"
      : "chat.composer.cameraAccessFailed",
  );
}

export function describeRealtimeTalkInputError(error: unknown): string {
  return describeDeviceError(error, "audioinput");
}

async function discoverRealtimeTalkDevices(
  requestPermission: boolean,
  kind: RealtimeTalkDeviceKind,
): Promise<RealtimeTalkDeviceDiscovery> {
  let devices: MediaDevices;
  let entries: MediaDeviceInfo[];
  try {
    devices = mediaDevices(kind);
    entries = await devices.enumerateDevices();
  } catch (error) {
    return { devices: [], warning: describeDeviceError(error, kind) };
  }
  const inputs = entries.filter((device) => device.kind === kind);
  const detailsHidden =
    inputs.length === 0 || inputs.some((device) => !device.deviceId || !device.label);
  if (!requestPermission || !detailsHidden || !devices.getUserMedia) {
    return { devices: normalizeDevices(entries, kind), warning: null };
  }

  try {
    const probe = await devices.getUserMedia(
      kind === "audioinput" ? { audio: true } : { video: true },
    );
    probe.getTracks().forEach((track) => track.stop());
    entries = await devices.enumerateDevices();
    return { devices: normalizeDevices(entries, kind), warning: null };
  } catch (error) {
    return {
      devices: normalizeDevices(entries, kind),
      warning: describeDeviceError(error, kind),
    };
  }
}

export async function discoverRealtimeTalkInputs(
  requestPermission: boolean,
): Promise<RealtimeTalkDeviceDiscovery> {
  return discoverRealtimeTalkDevices(requestPermission, "audioinput");
}

export async function discoverRealtimeTalkCameras(
  requestPermission: boolean,
): Promise<RealtimeTalkDeviceDiscovery> {
  return discoverRealtimeTalkDevices(requestPermission, "videoinput");
}

function realtimeTalkAudioConstraints(inputDeviceId: string | undefined): MediaTrackConstraints {
  const deviceId = inputDeviceId?.trim();
  return {
    autoGainControl: true,
    echoCancellation: true,
    noiseSuppression: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

function realtimeTalkAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Realtime Talk input cancelled", "AbortError");
}

export async function openRealtimeTalkInput(
  inputDeviceId: string | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<MediaStream> {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.getUserMedia) {
    throw new Error(t("chat.composer.realtimeTalkRequiresMicrophone"));
  }
  let audio: MediaStream;
  try {
    audio = await devices.getUserMedia({
      audio: realtimeTalkAudioConstraints(inputDeviceId),
    });
  } catch (error) {
    if (
      inputDeviceId?.trim() &&
      error instanceof DOMException &&
      error.name === "OverconstrainedError"
    ) {
      throw new Error(t("chat.composer.selectedMicrophoneUnavailable"), { cause: error });
    }
    throw error;
  }
  if (options.signal?.aborted) {
    audio.getTracks().forEach((track) => track.stop());
    throw realtimeTalkAbortReason(options.signal);
  }
  return audio;
}

export async function openRealtimeTalkCamera(
  videoDeviceId: string | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<MediaStream> {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.getUserMedia) {
    throw new Error(t("chat.composer.cameraAccessFailed"));
  }
  const deviceId = videoDeviceId?.trim();
  let camera: MediaStream;
  try {
    camera = await devices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    if (options.signal?.aborted) {
      camera.getTracks().forEach((track) => track.stop());
      throw realtimeTalkAbortReason(options.signal);
    }
    return camera;
  } catch (error) {
    if (options.signal?.aborted) {
      throw realtimeTalkAbortReason(options.signal);
    }
    if (deviceId && error instanceof DOMException && error.name === "OverconstrainedError") {
      throw new Error(t("chat.composer.selectedCameraUnavailable"), { cause: error });
    }
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new Error(t("chat.composer.cameraPermissionBlocked"), { cause: error });
    }
    if (error instanceof DOMException && error.name === "NotFoundError") {
      throw new Error(t("chat.composer.cameraNoneFound"), { cause: error });
    }
    if (error instanceof DOMException && error.name === "NotReadableError") {
      throw new Error(t("chat.composer.cameraBusy"), { cause: error });
    }
    throw new Error(t("chat.composer.cameraAccessFailed"), { cause: error });
  }
}
