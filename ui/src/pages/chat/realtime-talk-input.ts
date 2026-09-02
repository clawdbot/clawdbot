import { t } from "../../i18n/index.ts";

export type RealtimeTalkInputDevice = {
  deviceId: string;
  label: string;
};

export type RealtimeTalkCameraDevice = RealtimeTalkInputDevice;

/**
 * Why discovery stopped is a fact only this module observes. Callers need the
 * reason itself — not prose — to pick a coherent rendering, so the code travels
 * and each surface owns its own wording and tone.
 */
const deviceIssueMessageKeys = {
  "list-unsupported": [
    "chat.composer.microphoneListUnsupported",
    "chat.composer.cameraListUnsupported",
  ],
  "none-found": ["chat.composer.microphoneNoneFound", "chat.composer.cameraNoneFound"],
  "permission-blocked": [
    "chat.composer.microphonePermissionBlocked",
    "chat.composer.cameraPermissionBlocked",
  ],
  busy: ["chat.composer.microphoneBusy", "chat.composer.cameraBusy"],
  "page-inactive": ["chat.composer.microphonePageInactive", "chat.composer.cameraPageInactive"],
  failed: ["chat.composer.microphoneAccessFailed", "chat.composer.cameraAccessFailed"],
} as const;

export type RealtimeTalkDeviceIssue = keyof typeof deviceIssueMessageKeys;

type RealtimeTalkDeviceDiscovery = {
  devices: RealtimeTalkInputDevice[];
  permissionRequired: boolean;
  issue: RealtimeTalkDeviceIssue | null;
};

type RealtimeTalkDeviceKind = "audioinput" | "videoinput";

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

function deviceDetailsHidden(devices: MediaDeviceInfo[], kind: RealtimeTalkDeviceKind): boolean {
  const inputs = devices.filter((device) => device.kind === kind);
  return inputs.length === 0 || inputs.some((device) => !device.deviceId || !device.label);
}

const deviceIssueByMediaErrorName: Record<string, RealtimeTalkDeviceIssue> = {
  NotAllowedError: "permission-blocked",
  NotFoundError: "none-found",
  NotReadableError: "busy",
  InvalidStateError: "page-inactive",
};

function mediaDeviceErrorName(error: unknown): string | undefined {
  // WebKit shipped OverconstrainedError as Error instead of DOMException.
  if (error instanceof DOMException) {
    return error.name;
  }
  return error instanceof Error && error.name === "OverconstrainedError" ? error.name : undefined;
}

function deviceIssueFromError(error: unknown): RealtimeTalkDeviceIssue {
  return deviceIssueByMediaErrorName[mediaDeviceErrorName(error) ?? ""] ?? "failed";
}

export function realtimeTalkDeviceIssueMessage(
  issue: RealtimeTalkDeviceIssue,
  kind: RealtimeTalkDeviceKind,
): string {
  const [microphoneKey, cameraKey] = deviceIssueMessageKeys[issue];
  return t(kind === "audioinput" ? microphoneKey : cameraKey);
}

/**
 * Hardware appears and disappears while a picker is on screen, and the empty
 * state promises the list keeps up. The caller owns the subscription window:
 * run the returned unsubscribe when its surface closes, or the listener
 * outlives the state it refreshes.
 */
export function observeRealtimeTalkDevices(onChange: () => void): () => void {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.addEventListener) {
    return () => undefined;
  }
  devices.addEventListener("devicechange", onChange);
  return () => devices.removeEventListener("devicechange", onChange);
}

export function describeRealtimeTalkInputError(error: unknown): string {
  return realtimeTalkDeviceIssueMessage(deviceIssueFromError(error), "audioinput");
}

async function discoverRealtimeTalkDevices(
  requestPermission: boolean,
  kind: RealtimeTalkDeviceKind,
): Promise<RealtimeTalkDeviceDiscovery> {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.enumerateDevices) {
    return { devices: [], permissionRequired: false, issue: "list-unsupported" };
  }
  let entries: MediaDeviceInfo[];
  try {
    entries = await devices.enumerateDevices();
  } catch (error) {
    return { devices: [], permissionRequired: false, issue: deviceIssueFromError(error) };
  }
  const permissionRequired = deviceDetailsHidden(entries, kind);
  if (!requestPermission || !permissionRequired || !devices.getUserMedia) {
    return { devices: normalizeDevices(entries, kind), permissionRequired, issue: null };
  }

  try {
    const probe = await devices.getUserMedia(
      kind === "audioinput" ? { audio: true } : { video: true },
    );
    probe.getTracks().forEach((track) => track.stop());
    entries = await devices.enumerateDevices();
    return {
      devices: normalizeDevices(entries, kind),
      permissionRequired: deviceDetailsHidden(entries, kind),
      issue: null,
    };
  } catch (error) {
    return {
      devices: normalizeDevices(entries, kind),
      permissionRequired,
      issue: deviceIssueFromError(error),
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

async function awaitRealtimeTalkMediaRequest(
  startRequest: () => Promise<MediaStream>,
  signal: AbortSignal | undefined,
): Promise<MediaStream> {
  if (signal?.aborted) {
    throw realtimeTalkAbortReason(signal);
  }
  const request = startRequest();
  if (!signal) {
    return await request;
  }
  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(realtimeTalkAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([request, aborted]);
  } catch (error) {
    if (signal.aborted) {
      // Browser permission prompts are not cancellable. Release any stream that
      // arrives after the lifecycle owner has already moved on.
      void request.then(
        (stream) => stream.getTracks().forEach((track) => track.stop()),
        () => undefined,
      );
      throw realtimeTalkAbortReason(signal);
    }
    throw error;
  } finally {
    removeAbortListener();
  }
}

async function openRealtimeTalkInput(
  inputDeviceId: string | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<MediaStream> {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.getUserMedia) {
    throw new Error(t("chat.composer.realtimeTalkRequiresMicrophone"));
  }
  let acquisition: { stream: MediaStream } | { failure: string };
  try {
    acquisition = {
      stream: await awaitRealtimeTalkMediaRequest(
        () =>
          devices.getUserMedia({
            audio: realtimeTalkAudioConstraints(inputDeviceId),
          }),
        options.signal,
      ),
    };
  } catch (error) {
    const errorName = mediaDeviceErrorName(error);
    if (!errorName || errorName === "AbortError") {
      throw error;
    }
    acquisition = {
      failure:
        inputDeviceId?.trim() && errorName === "OverconstrainedError"
          ? t("chat.composer.selectedMicrophoneUnavailable")
          : describeRealtimeTalkInputError(error),
    };
  }
  if ("failure" in acquisition) {
    throw new Error(acquisition.failure);
  }
  const { stream: audio } = acquisition;
  if (options.signal?.aborted) {
    audio.getTracks().forEach((track) => track.stop());
    throw realtimeTalkAbortReason(options.signal);
  }
  return audio;
}

export class RealtimeTalkInputController {
  private controller: AbortController | null = null;
  private media: MediaStream | null = null;

  constructor(
    private onEnded: (detail: string) => void,
    private readonly onConnecting?: (detail?: string) => void,
  ) {}

  get stream(): MediaStream | null {
    return this.media;
  }

  requireStream(): MediaStream {
    const media = this.media;
    if (!media) {
      throw new Error(t("chat.composer.microphoneStopped"));
    }
    return media;
  }

  adopt(onEnded: (detail: string) => void): MediaStream {
    const media = this.requireStream();
    // Keep the same stream and listener across the candidate-to-transport handoff.
    this.onEnded = onEnded;
    return media;
  }

  async open(inputDeviceId: string | undefined): Promise<MediaStream> {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    try {
      this.onConnecting?.(t("chat.composer.microphoneAccessPending"));
      const media = await openRealtimeTalkInput(inputDeviceId, { signal: controller.signal });
      if (controller.signal.aborted) {
        media.getTracks().forEach((track) => track.stop());
        throw realtimeTalkAbortReason(controller.signal);
      }
      this.media = media;
      const onEnded = () => {
        // A queued event from a retired microphone must not end its replacement.
        if (this.controller !== controller) {
          return;
        }
        this.stop();
        this.onEnded(t("chat.composer.microphoneStopped"));
      };
      for (const track of media.getTracks()) {
        track.addEventListener("ended", onEnded, { signal: controller.signal });
      }
      // Only the current, successful acquisition advances the visible startup phase.
      // Cancellation must not overwrite idle or a replacement's microphone prompt.
      this.onConnecting?.();
      return media;
    } catch (error) {
      if (this.controller === controller) {
        this.stop();
      }
      throw error;
    }
  }

  stop(): void {
    const controller = this.controller;
    const media = this.media;
    this.controller = null;
    this.media = null;
    // Abort removes only this acquisition's listeners before releasing tracks,
    // keeping normal stop quiet without disturbing other consumers' listeners.
    controller?.abort();
    media?.getTracks().forEach((track) => track.stop());
  }
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
  let acquisition: { stream: MediaStream } | { failure: string };
  try {
    const stream = await awaitRealtimeTalkMediaRequest(
      () => devices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true }),
      options.signal,
    );
    if (options.signal?.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      throw realtimeTalkAbortReason(options.signal);
    }
    acquisition = { stream };
  } catch (error) {
    if (options.signal?.aborted) {
      throw realtimeTalkAbortReason(options.signal);
    }
    const errorName = mediaDeviceErrorName(error);
    acquisition = {
      failure:
        deviceId && errorName === "OverconstrainedError"
          ? t("chat.composer.selectedCameraUnavailable")
          : realtimeTalkDeviceIssueMessage(deviceIssueFromError(error), "videoinput"),
    };
  }
  if ("failure" in acquisition) {
    throw new Error(acquisition.failure);
  }
  return acquisition.stream;
}
