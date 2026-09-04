import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

const WIDGET_SNAPSHOT_REQUEST_TYPE = "openclaw:widget-snapshot-request";
const WIDGET_SNAPSHOT_REPLY_TYPE = "openclaw:widget-snapshot";
const WIDGET_SNAPSHOT_TIMEOUT_MS = 5_000;
const WIDGET_SNAPSHOT_MAX_DATA_URL_CHARS = 32 * 1024 * 1024;

export class WidgetSnapshotUnavailableError extends Error {}

export function requestWidgetSnapshot(
  frame: HTMLIFrameElement,
  options: { id?: string; timeoutMs?: number } = {},
): Promise<string> {
  const target = frame.contentWindow;
  if (!target) {
    return Promise.reject(new Error("widget frame is unavailable"));
  }
  const id =
    options.id ??
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
      value.toString(16).padStart(8, "0"),
    ).join("");
  const timeoutMs = options.timeoutMs ?? WIDGET_SNAPSHOT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      globalThis.clearTimeout(timeout);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== target) {
        return;
      }
      const payload = asNullableRecord(event.data);
      if (!payload || payload.type !== WIDGET_SNAPSHOT_REPLY_TYPE || payload.id !== id) {
        return;
      }
      if (typeof payload.error === "string") {
        fail(new Error(payload.error));
      } else if (
        typeof payload.dataUrl !== "string" ||
        !payload.dataUrl.startsWith("data:image/png;base64,") ||
        payload.dataUrl.length > WIDGET_SNAPSHOT_MAX_DATA_URL_CHARS
      ) {
        fail(new Error("widget returned an invalid snapshot"));
      } else {
        cleanup();
        resolve(payload.dataUrl);
      }
    };

    window.addEventListener("message", handleMessage);
    const timeout = globalThis.setTimeout(
      () => fail(new WidgetSnapshotUnavailableError("widget snapshot request timed out")),
      timeoutMs,
    );
    try {
      target.postMessage({ type: WIDGET_SNAPSHOT_REQUEST_TYPE, id }, "*");
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
