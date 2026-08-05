/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { exportWidget } from "./widget-export.ts";

const PNG_DATA_URL = "data:image/png;base64,aW1hZ2U=";

function createWidgetFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.src = "/__openclaw__/canvas/documents/cv_export/index.html";
  document.body.append(frame);
  expect(frame.contentWindow).not.toBeNull();
  return frame;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("widget export", () => {
  it("matches snapshot replies by frame source and request id", async () => {
    const frame = createWidgetFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const download = vi.fn();
    let settled = false;
    const result = exportWidget("download", frame, "Current widget", {
      download,
      timeoutMs: 1_000,
    });
    void result.finally(() => {
      settled = true;
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openclaw:widget-snapshot-request" }),
      "*",
    );
    const request = postMessage.mock.calls[0]?.[0] as { id: string };
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "openclaw:widget-snapshot", id: "snapshot-2", dataUrl: PNG_DATA_URL },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { type: "openclaw:widget-snapshot", id: request.id, dataUrl: PNG_DATA_URL },
      }),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "openclaw:widget-snapshot", id: request.id, dataUrl: PNG_DATA_URL },
      }),
    );
    await expect(result).resolves.toBe("png");
    expect(download).toHaveBeenCalledWith(PNG_DATA_URL, "Current-widget.png");
  });

  it("selects the copy notice and HTML download fallbacks after a timeout", async () => {
    vi.useFakeTimers();
    const frame = createWidgetFrame();
    const fetchDocument = vi.fn(async () => new Response("<p>Legacy</p>", { status: 200 }));
    const download = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:legacy-widget");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const copyResult = exportWidget("copy", frame, "Legacy widget", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(copyResult).resolves.toBe("rerender-required");
    expect(fetchDocument).not.toHaveBeenCalled();

    const downloadResult = exportWidget("download", frame, "Legacy widget", {
      timeoutMs: 10,
      fetch: fetchDocument,
      download,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(downloadResult).resolves.toBe("html");
    expect(fetchDocument).toHaveBeenCalledWith(frame.src);
    expect(download).toHaveBeenCalledWith("blob:legacy-widget", "Legacy-widget.html");
  });

  it("starts clipboard writing before the snapshot resolves", async () => {
    const frame = createWidgetFrame();
    let resolveSnapshot: ((dataUrl: string) => void) | undefined;
    const snapshot = new Promise<string>((resolve) => {
      resolveSnapshot = resolve;
    });
    const copyImage = vi.fn(async (pending: Promise<string>) => {
      expect(pending).toBe(snapshot);
      await pending;
    });

    const result = exportWidget("copy", frame, "Current widget", {
      requestSnapshot: () => snapshot,
      copyImage,
    });
    expect(copyImage).toHaveBeenCalledOnce();
    resolveSnapshot?.(PNG_DATA_URL);
    await expect(result).resolves.toBe("png");
  });

  it("does not use legacy fallbacks for an explicit bridge error", async () => {
    const frame = createWidgetFrame();
    const fetchDocument = vi.fn();
    const captureError = new Error("canvas is not exportable");
    const result = exportWidget("download", frame, "Broken widget", {
      requestSnapshot: () => Promise.reject(captureError),
      fetch: fetchDocument,
    });

    await expect(result).rejects.toBe(captureError);
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("sanitizes PNG download filenames and falls back to widget", async () => {
    const frame = createWidgetFrame();
    const download = vi.fn();
    await exportWidget("download", frame, "  Quarterly / status: Q3?  ", {
      requestSnapshot: () => Promise.resolve(PNG_DATA_URL),
      download,
    });
    await exportWidget("download", frame, "... <> ", {
      requestSnapshot: () => Promise.resolve(PNG_DATA_URL),
      download,
    });
    expect(download.mock.calls).toEqual([
      [PNG_DATA_URL, "Quarterly-status-Q3.png"],
      [PNG_DATA_URL, "widget.png"],
    ]);
  });

  it("rejects non-PNG and oversized snapshot replies", async () => {
    for (const dataUrl of [
      "data:image/jpeg;base64,aW1hZ2U=",
      "https://example.com/widget.png",
      `data:image/png;base64,${"A".repeat(32 * 1024 * 1024)}`,
    ]) {
      const frame = createWidgetFrame();
      const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
      const result = exportWidget("download", frame, "Current widget");
      expect(postMessage).toHaveBeenCalledOnce();
      const request = postMessage.mock.calls[0]?.[0];
      expect(request).toBeDefined();
      const id = (request as { id: string }).id;
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "openclaw:widget-snapshot", id, dataUrl },
        }),
      );
      await expect(result).rejects.toThrow("widget returned an invalid snapshot");
    }
  });
});
