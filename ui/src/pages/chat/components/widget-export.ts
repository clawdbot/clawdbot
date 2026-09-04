import {
  requestWidgetSnapshot,
  WidgetSnapshotUnavailableError,
} from "../../../lib/board/widget-snapshot.ts";

type WidgetExportRuntime = {
  timeoutMs?: number;
  requestSnapshot?: typeof requestWidgetSnapshot;
  copyImage?: (dataUrl: Promise<string>) => Promise<void>;
  download?: typeof downloadHref;
  fetch?: typeof globalThis.fetch;
};

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
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
          throw new Error("image clipboard is unavailable");
        }
        const blob = dataUrl.then(async (value) => (await globalThis.fetch(value)).blob());
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
