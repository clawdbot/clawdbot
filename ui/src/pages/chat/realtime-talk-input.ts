import { t } from "../../i18n/index.ts";

export type RealtimeTalkInputDevice = {
  deviceId: string;
  label: string;
};

type RealtimeTalkInputDiscovery = {
  devices: RealtimeTalkInputDevice[];
  warning: string | null;
};

function mediaDevices(): MediaDevices {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.enumerateDevices) {
    throw new Error(t("chat.composer.microphoneListUnsupported"));
  }
  return devices;
}

function normalizeInputDevices(devices: MediaDeviceInfo[]): RealtimeTalkInputDevice[] {
  const normalized: RealtimeTalkInputDevice[] = [];
  const seen = new Set<string>();
  for (const device of devices) {
    const deviceId = device.deviceId.trim();
    // Chromium exposes a synthetic `default` alias. The picker already owns a
    // provider-neutral System default entry, so listing the alias duplicates it.
    if (device.kind !== "audioinput" || !deviceId || deviceId === "default" || seen.has(deviceId)) {
      continue;
    }
    seen.add(deviceId);
    normalized.push({
      deviceId,
      label:
        device.label.trim() ||
        t("chat.composer.microphoneFallback", { number: String(normalized.length + 1) }),
    });
  }
  return normalized;
}

function describeInputError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError") {
    return t("chat.composer.microphonePermissionBlocked");
  }
  if (name === "NotFoundError") {
    return t("chat.composer.microphoneNoneFound");
  }
  if (name === "NotReadableError") {
    return t("chat.composer.microphoneBusy");
  }
  if (name === "InvalidStateError") {
    return t("chat.composer.microphonePageInactive");
  }
  return t("chat.composer.microphoneAccessFailed");
}

export async function discoverRealtimeTalkInputs(
  requestPermission: boolean,
): Promise<RealtimeTalkInputDiscovery> {
  let devices: MediaDevices;
  let entries: MediaDeviceInfo[];
  try {
    devices = mediaDevices();
    entries = await devices.enumerateDevices();
  } catch (error) {
    return { devices: [], warning: describeInputError(error) };
  }
  const inputs = entries.filter((device) => device.kind === "audioinput");
  const detailsHidden =
    inputs.length === 0 || inputs.some((device) => !device.deviceId || !device.label);
  if (!requestPermission || !detailsHidden || !devices.getUserMedia) {
    return { devices: normalizeInputDevices(entries), warning: null };
  }

  try {
    const probe = await devices.getUserMedia({ audio: true });
    probe.getTracks().forEach((track) => track.stop());
    entries = await devices.enumerateDevices();
    return { devices: normalizeInputDevices(entries), warning: null };
  } catch (error) {
    return {
      devices: normalizeInputDevices(entries),
      warning: describeInputError(error),
    };
  }
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
  options: { video?: boolean; signal?: AbortSignal } = {},
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
  if (!options.video) {
    return audio;
  }

  let audioStopped = false;
  const stopAudio = () => {
    if (audioStopped) {
      return;
    }
    audioStopped = true;
    audio.getTracks().forEach((track) => track.stop());
  };
  options.signal?.addEventListener("abort", stopAudio, { once: true });
  let camera: MediaStream | undefined;
  try {
    camera = await devices.getUserMedia({ video: true });
    if (options.signal?.aborted) {
      throw realtimeTalkAbortReason(options.signal);
    }
    return new MediaStream([...audio.getAudioTracks(), ...camera.getVideoTracks()]);
  } catch (error) {
    camera?.getTracks().forEach((track) => track.stop());
    stopAudio();
    if (options.signal?.aborted) {
      throw realtimeTalkAbortReason(options.signal);
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
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", stopAudio);
  }
}
