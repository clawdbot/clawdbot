// Control UI chat module owns bounded camera-frame capture for realtime Talk transports.

export type RealtimeTalkVideoFrame = {
  data: string;
  mimeType: "image/jpeg";
};

const REALTIME_TALK_FRAME_MAX_ATTEMPTS = 8;

export async function captureRealtimeTalkVideoFrame(
  video: HTMLVideoElement | null,
  maxMessageSize: number,
  buildMessage: (frame: RealtimeTalkVideoFrame) => unknown,
): Promise<RealtimeTalkVideoFrame> {
  if (!video?.srcObject) {
    throw new Error("Camera preview is unavailable");
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForRealtimeTalkVideoData(video);
  }
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    !video.videoWidth ||
    !video.videoHeight
  ) {
    throw new Error("Camera frame has no image data");
  }
  let scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Camera frame capture is unavailable");
  }
  let quality = 0.8;
  for (let attempt = 0; attempt < REALTIME_TALK_FRAME_MAX_ATTEMPTS; attempt += 1) {
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageUrl = canvas.toDataURL("image/jpeg", quality);
    const frame: RealtimeTalkVideoFrame = {
      data: imageUrl.slice(imageUrl.indexOf(",") + 1),
      mimeType: "image/jpeg",
    };
    const messageBytes = new TextEncoder().encode(JSON.stringify(buildMessage(frame))).length;
    if (messageBytes <= maxMessageSize) {
      return frame;
    }
    const reduction = Math.min(0.75, Math.sqrt(maxMessageSize / messageBytes) * 0.9);
    scale *= reduction;
    quality = Math.max(0.4, quality - 0.1);
  }
  throw new Error("Camera frame is too large for the Realtime connection");
}

function waitForRealtimeTalkVideoData(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (timeout === undefined) {
        return;
      }
      globalThis.clearTimeout(timeout);
      timeout = undefined;
      video.removeEventListener("loadeddata", onData);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onData = () => finish();
    timeout = globalThis.setTimeout(
      () => finish(new Error("Camera preview did not become ready")),
      5_000,
    );
    video.addEventListener("loadeddata", onData);
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      finish();
    }
  });
}
