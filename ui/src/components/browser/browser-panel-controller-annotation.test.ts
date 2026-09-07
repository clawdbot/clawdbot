import { describe, expect, it, vi } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  setupBrowserPanelTestCleanup,
} from "./browser-panel-controller-test-support.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";

setupBrowserPanelTestCleanup();

function pointer(type: string, pointerId: number, clientX: number, clientY: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
  Object.defineProperty(event, "pointerId", { configurable: true, value: pointerId });
  return event as PointerEvent;
}

function createOverlay(controller: BrowserPanelController) {
  const overlay = document.createElement("canvas");
  const capturedPointers = new Set<number>();
  overlay.setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
  overlay.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));
  overlay.releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    overlay.addEventListener(type, (event) =>
      controller.handleOverlayPointerUp(event as PointerEvent),
    );
  }
  overlay.addEventListener("pointerdown", (event) =>
    controller.handleOverlayPointerDown(event as PointerEvent),
  );
  overlay.addEventListener("pointermove", (event) =>
    controller.handleOverlayPointerMove(event as PointerEvent),
  );
  return { capturedPointers, overlay };
}

function createAnnotationController() {
  const { client } = createBrowserClient(async () => {
    throw new Error("annotation ownership does not call the gateway");
  });
  const controller = createBrowserPanelTestController(client, "tab-a");
  controller.setMode("annotate");
  return controller;
}

describe("BrowserPanelController annotation pointer ownership", () => {
  it("keeps a stroke owned until its pointer ends or loses capture", () => {
    const controller = createAnnotationController();
    const { overlay } = createOverlay(controller);

    overlay.dispatchEvent(pointer("pointerdown", 7, 10, 20));
    overlay.dispatchEvent(pointer("pointerdown", 8, 80, 90));
    overlay.dispatchEvent(pointer("pointermove", 8, 70, 80));
    overlay.dispatchEvent(pointer("pointerup", 8, 70, 80));
    overlay.dispatchEvent(pointer("lostpointercapture", 8, 70, 80));
    overlay.dispatchEvent(pointer("pointermove", 7, 30, 40));

    expect(controller.strokes).toEqual([
      {
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.3, y: 0.4 },
        ],
      },
    ]);

    overlay.dispatchEvent(pointer("lostpointercapture", 7, 30, 40));
    overlay.dispatchEvent(pointer("pointermove", 7, 50, 60));
    overlay.dispatchEvent(pointer("pointerdown", 8, 50, 60));
    overlay.dispatchEvent(pointer("pointerup", 8, 50, 60));

    expect(controller.strokes).toEqual([
      {
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.3, y: 0.4 },
        ],
      },
      { points: [{ x: 0.5, y: 0.6 }] },
    ]);
  });

  it("releases an active stroke when its owning lifecycle ends", () => {
    const controller = createAnnotationController();
    const { capturedPointers, overlay } = createOverlay(controller);

    overlay.dispatchEvent(pointer("pointerdown", 7, 10, 20));
    expect(capturedPointers.has(7)).toBe(true);

    controller.hostDisconnected();

    expect(capturedPointers.has(7)).toBe(false);
    overlay.dispatchEvent(pointer("pointermove", 7, 30, 40));
    expect(controller.strokes).toEqual([{ points: [{ x: 0.1, y: 0.2 }] }]);
  });
});
