import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_ANNOTATION_EVENT, type BrowserAnnotationDraft } from "./browser-annotation.ts";
import {
  dispatchCompositedBrowserAnnotation,
  type BrowserPanelView,
} from "./browser-panel-surface.ts";

describe("dispatchCompositedBrowserAnnotation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["remote", "native"] as const)(
    "keeps an unconsumed %s annotation retryable and dispatches the canonical draft",
    (kind) => {
      const drawImage = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage,
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
      } as unknown as CanvasRenderingContext2D);
      const toDataUrl = vi
        .spyOn(HTMLCanvasElement.prototype, "toDataURL")
        .mockReturnValue("data:image/png;base64,annotated");
      const view = {
        kind,
        browserTab: { target: "host", profile: "managed", targetId: "tab-1" },
        targetId: "tab-1",
        dataUrl: "data:image/png;base64,source",
        image: { naturalWidth: 800, naturalHeight: 600 } as HTMLImageElement,
        url: "https://user:secret@example.com/path",
        metrics: null,
      } satisfies BrowserPanelView;
      const strokes = [{ points: [{ x: 0.25, y: 0.5 }] }];

      expect(dispatchCompositedBrowserAnnotation(view, undefined, strokes, null, null)).toBe(
        "unhandled",
      );
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect(toDataUrl).toHaveBeenCalledTimes(1);

      let draft: BrowserAnnotationDraft | undefined;
      const consume = (event: Event) => {
        draft = (event as CustomEvent<BrowserAnnotationDraft>).detail;
        event.preventDefault();
      };
      window.addEventListener(BROWSER_ANNOTATION_EVENT, consume);
      try {
        expect(dispatchCompositedBrowserAnnotation(view, undefined, strokes, null, null)).toBe(
          "accepted",
        );
      } finally {
        window.removeEventListener(BROWSER_ANNOTATION_EVENT, consume);
      }

      expect(drawImage).toHaveBeenCalledTimes(2);
      expect(toDataUrl).toHaveBeenCalledTimes(2);
      expect(draft).toMatchObject({
        modelContext: expect.stringContaining("https://example.com/path"),
        card: {
          title: "example.com",
          displayUrl: "example.com",
          markedRegionCount: 1,
          inspectedElement: false,
        },
        dataUrl: "data:image/png;base64,annotated",
        fileName: "annotated-page.png",
      });
      expect(draft?.modelContext.includes(JSON.stringify(view.browserTab))).toBe(kind === "remote");
      expect(draft).not.toHaveProperty("text");
    },
  );

  it("distinguishes a rejected capture from an unhandled one", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,annotated",
    );
    const reject = (event: Event) => {
      (event as Event & { rejection?: "limit" }).rejection = "limit";
    };
    window.addEventListener(BROWSER_ANNOTATION_EVENT, reject);
    try {
      expect(
        dispatchCompositedBrowserAnnotation(
          {
            targetId: "tab-1",
            dataUrl: "data:image/png;base64,source",
            image: { naturalWidth: 800, naturalHeight: 600 } as HTMLImageElement,
            url: "https://example.com",
            metrics: null,
          },
          undefined,
          [{ points: [{ x: 0.25, y: 0.5 }] }],
          null,
          null,
        ),
      ).toBe("rejected");
    } finally {
      window.removeEventListener(BROWSER_ANNOTATION_EVENT, reject);
    }
  });
});
