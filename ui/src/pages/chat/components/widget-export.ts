const WIDGET_SNAPSHOT_REQUEST_TYPE = "openclaw:widget-snapshot-request";
const WIDGET_SNAPSHOT_REPLY_TYPE = "openclaw:widget-snapshot";
const WIDGET_SNAPSHOT_TIMEOUT_MS = 5_000;
const WIDGET_SNAPSHOT_MAX_DATA_URL_CHARS = 32 * 1024 * 1024;

type WidgetSnapshotReply = { type?: unknown; id?: unknown; dataUrl?: unknown; error?: unknown };
type WidgetExportRuntime = {
  timeoutMs?: number;
  requestSnapshot?: typeof requestWidgetSnapshot;
  copyImage?: (dataUrl: Promise<string>) => Promise<void>;
  download?: typeof downloadHref;
  fetch?: typeof globalThis.fetch;
};

class WidgetSnapshotUnavailableError extends Error {}

function requestWidgetSnapshot(
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
      const payload = event.data as WidgetSnapshotReply | null;
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

function downloadHref(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
}

export async function exportWidget(
  action: "copy" | "download",
  frame: HTMLIFrameElement,
  title: string | undefined,
  runtime: WidgetExportRuntime = {},
): Promise<"png" | "html" | "rerender-required"> {
  const filename =
    Array.from((title ?? "").trim(), (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f || '<>:"/\\|?*'.includes(character)
        ? "-"
        : character;
    })
      .join("")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[. -]+|[. -]+$/g, "")
      .slice(0, 120)
      .replace(/[. -]+$/g, "") || "widget";
  const snapshot = (runtime.requestSnapshot ?? requestWidgetSnapshot)(
    frame,
    runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs },
  );

  if (action === "copy") {
    const copyImage =
      runtime.copyImage ??
      ((dataUrl: Promise<string>) => {
        const blob = dataUrl.then(async (value) => (await fetch(value)).blob());
        void blob.catch(() => {});
        // ClipboardItem keeps the click's transient activation while its PNG promise resolves.
        return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      });
    try {
      await copyImage(snapshot);
      return "png";
    } catch (error) {
      const snapshotError = await snapshot.then(
        () => null,
        (reason: unknown) => reason,
      );
      if (snapshotError instanceof WidgetSnapshotUnavailableError) {
        return "rerender-required";
      }
      throw snapshotError ?? error;
    }
  }

  try {
    const dataUrl = await snapshot;
    (runtime.download ?? downloadHref)(dataUrl, `${filename}.png`);
    return "png";
  } catch (error) {
    if (!(error instanceof WidgetSnapshotUnavailableError)) {
      throw error;
    }
    const src = frame.getAttribute("src");
    if (!src) {
      throw new Error("widget document URL is unavailable", { cause: error });
    }
    const url = new URL(src, window.location.href);
    if (url.origin !== window.location.origin) {
      throw new Error("widget document URL is not same-origin", { cause: error });
    }
    const response = await (runtime.fetch ?? globalThis.fetch)(url.href);
    if (!response.ok) {
      throw new Error(`widget document download failed (${response.status})`, { cause: error });
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    try {
      (runtime.download ?? downloadHref)(objectUrl, `${filename}.html`);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    return "html";
  }
}
