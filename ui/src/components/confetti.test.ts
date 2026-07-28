// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { fireFirstReplyConfetti } from "./confetti.ts";

const FLAG_KEY = "openclaw.confetti.firstReply";

function stubMatchMedia(reducedMotion: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reducedMotion && query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

describe("fireFirstReplyConfetti", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorageMock();
    vi.stubGlobal("localStorage", storage);
    stubMatchMedia(false);
    // jsdom canvases have no 2d context; stub a minimal drawing surface so the
    // burst path runs deterministically.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: () => undefined,
      clearRect: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      translate: () => undefined,
      rotate: () => undefined,
      fillRect: () => undefined,
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("requestAnimationFrame", () => 1);
  });

  afterEach(() => {
    document.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("celebrates the first reply exactly once", () => {
    fireFirstReplyConfetti();
    expect(storage.getItem(FLAG_KEY)).toBe("1");
    expect(document.querySelectorAll("canvas")).toHaveLength(1);

    fireFirstReplyConfetti();
    expect(document.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("skips a browser profile that already celebrated", () => {
    storage.setItem(FLAG_KEY, "1");
    fireFirstReplyConfetti();
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("skips reduced-motion users without burning the once-flag", () => {
    stubMatchMedia(true);
    fireFirstReplyConfetti();
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
    expect(storage.getItem(FLAG_KEY)).toBeNull();
  });
});
