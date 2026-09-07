import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const imageSize = vi.hoisted(() => ({ width: 1280, height: 720 }));
vi.mock("../media/media-services.js", () => ({ getImageMetadata: async () => imageSize }));
beforeEach(() => {
  imageSize.width = 1280;
});
const mod = await import("./pw-tools-core.interactions.js");

function evaluateMockReturning(view: { x: number; y: number; width?: number; height?: number }) {
  // Caller reads { x, y, width, height } in one evaluate; default to a normal
  // desktop viewport so refs near the top stay in-viewport unless a test puts
  // them out of range explicitly.
  const result = {
    width: 1280,
    height: 720,
    fullWidth: 1280,
    nativeCaptureWidth: 1280,
    ...view,
  };
  return vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return result;
    }
    return true;
  });
}

describe("screenshotWithLabelsViaPlaywright (viewport)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls page.screenshot without fullPage and returns annotations", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 100 });
    const screenshot = vi.fn(async () => Buffer.from("PNG"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot, url: () => "https://example.com" });
    setPwToolsCoreCurrentRefLocator({
      boundingBox: async () => ({ x: 10, y: 200, width: 50, height: 20 }),
    });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      refs: { e1: { role: "button", name: "Submit" } },
      type: "png",
    });

    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: "png" }));
    expect(screenshot).not.toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]).toMatchObject({
      ref: "e1",
      number: 1,
      role: "button",
      name: "Submit",
    });
    // viewport-mode box = doc(box.x + scroll.x, box.y + scroll.y) - scroll = bbox
    expect(result.annotations[0]?.box).toEqual({ x: 10, y: 200, width: 50, height: 20 });
    expect(result.skipped).toBe(0);
  });

  it("runs the clear script even when screenshot throws", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 0 });
    const screenshot = vi.fn(async () => {
      throw new Error("boom");
    });
    setPwToolsCoreCurrentPage({ evaluate, screenshot });
    setPwToolsCoreCurrentRefLocator({
      boundingBox: async () => ({ x: 0, y: 0, width: 1, height: 1 }),
    });

    await expect(
      mod.screenshotWithLabelsViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        refs: { e1: { role: "button" } },
      }),
    ).rejects.toThrow(/boom/);

    // The clear script must have run (string evaluate calls include the overlay attr)
    const clearCalls = evaluate.mock.calls.filter(
      ([arg]) => typeof arg === "string" && arg.includes("data-openclaw-labels"),
    );
    // inject + clear = at least 2 string evaluations
    expect(clearCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("counts off-viewport refs as skipped but still surfaces them in annotations", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 0, width: 1280, height: 720 });
    const screenshot = vi.fn(async () => Buffer.from("PNG"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot });
    // bbox is far below the viewport (y: 5000): not drawn, but still reported
    // so callers keep the position and a non-zero skipped count.
    setPwToolsCoreCurrentRefLocator({
      boundingBox: async () => ({ x: 0, y: 5000, width: 50, height: 20 }),
    });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      refs: { e1: { role: "button" } },
    });

    expect(result.skipped).toBe(1);
    expect(result.labels).toBe(0);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]?.ref).toBe("e1");
  });
});

describe("screenshotWithLabelsViaPlaywright (fullpage)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards fullPage:true to page.screenshot and uses doc-space annotations", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 1000 });
    const screenshot = vi.fn(async () => Buffer.from("FULL"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot });
    setPwToolsCoreCurrentRefLocator({
      boundingBox: async () => ({ x: 10, y: 200, width: 50, height: 20 }),
    });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      refs: { e1: { role: "button" } },
      fullPage: true,
    });

    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
    // doc-space: scroll y=1000 + bbox y=200 = 1200
    expect(result.annotations[0]?.box.y).toBe(1200);
    expect(result.annotations[0]?.box.x).toBe(10);
  });

  it("stops reading geometry after filling the label budget and counts remaining refs as skipped", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 1000 });
    const screenshot = vi.fn(async () => Buffer.from("FULL"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot });
    const boundingBox = vi
      .fn<() => Promise<{ x: number; y: number; width: number; height: number } | null>>()
      .mockRejectedValueOnce(new Error("detached"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ x: 10, y: 20, width: 30, height: 40 })
      .mockResolvedValueOnce({ x: 50, y: 60, width: 70, height: 80 })
      .mockResolvedValueOnce({ x: 90, y: 100, width: 30, height: 40 })
      .mockRejectedValueOnce(new Error("detached tail"));
    setPwToolsCoreCurrentRefLocator({ boundingBox });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      refs: Object.fromEntries(
        ["e1", "e2", "e3", "e4", "e5", "e6"].map((ref) => [ref, { role: "button" }]),
      ),
      fullPage: true,
      maxLabels: 2,
    });

    expect(result.annotations).toEqual([
      {
        ref: "e3",
        number: 3,
        role: "button",
        box: { x: 10, y: 1020, width: 30, height: 40 },
      },
      {
        ref: "e4",
        number: 4,
        role: "button",
        box: { x: 50, y: 1060, width: 70, height: 80 },
      },
    ]);
    expect(result.labels).toBe(2);
    expect(result.skipped).toBe(4);
    expect(boundingBox).toHaveBeenCalledTimes(4);
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
  });

  it("still rejects unknown refs after filling the full-page label budget", async () => {
    const screenshot = vi.fn(async () => Buffer.from("FULL"));
    setPwToolsCoreCurrentPage({ evaluate: evaluateMockReturning({ x: 0, y: 0 }), screenshot });
    getPwToolsCoreSessionMocks()
      .refLocator.mockImplementationOnce(() => ({
        boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
      }))
      .mockImplementationOnce(() => {
        throw new Error('Unknown ref "e2". Run a new snapshot.');
      });

    await expect(
      mod.screenshotWithLabelsViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        refs: { e1: { role: "button" }, e2: { role: "button" } },
        fullPage: true,
        maxLabels: 1,
      }),
    ).rejects.toThrow('Unknown ref "e2"');
    expect(screenshot).not.toHaveBeenCalled();
  });
});

describe("screenshotWithLabelsViaPlaywright (element/ref)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures the resolved ref element and projects relative to it", async () => {
    imageSize.width = 200;
    const evaluate = evaluateMockReturning({ x: 0, y: 0 });
    // First call resolves the element rect (container), second resolves e1 annotation bbox.
    const boundingBox = vi
      .fn<() => Promise<{ x: number; y: number; width: number; height: number } | null>>()
      .mockResolvedValueOnce({ x: 50, y: 100, width: 200, height: 300 })
      .mockResolvedValueOnce({ x: 60, y: 110, width: 30, height: 20 });
    const elementScreenshot = vi.fn(async () => Buffer.from("ELEM"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot: vi.fn() });
    setPwToolsCoreCurrentRefLocator({
      boundingBox,
      elementHandle: async () => ({
        screenshot: elementScreenshot,
        scrollIntoViewIfNeeded: async () => {},
        dispose: async () => {},
      }),
    });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      refs: { e1: { role: "button" } },
      ref: "container",
    });

    expect(elementScreenshot).toHaveBeenCalledTimes(1);
    // Element-relative: doc(60,110) - elementRect(50,100) = (10,10)
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]?.box).toEqual({ x: 10, y: 10, width: 30, height: 20 });
  });

  it("throws when ref/element cannot be resolved", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 0 });
    setPwToolsCoreCurrentPage({ evaluate, screenshot: vi.fn() });
    setPwToolsCoreCurrentRefLocator({
      boundingBox: async () => null,
      screenshot: vi.fn(),
    });

    await expect(
      mod.screenshotWithLabelsViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        refs: { e1: { role: "button" } },
        ref: "missing",
      }),
    ).rejects.toThrow(/element not found/i);
  });
});

describe("screenshotWithLabelsViaPlaywright (skipped accounting)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts refs whose boundingBox is null toward skipped", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 0 });
    const screenshot = vi.fn(async () => Buffer.from("PNG"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot });
    // Two refs: first returns a box, second returns null (e.g. element detached).
    const boundingBox = vi
      .fn<() => Promise<{ x: number; y: number; width: number; height: number } | null>>()
      .mockResolvedValueOnce({ x: 10, y: 20, width: 30, height: 40 })
      .mockResolvedValueOnce(null);
    setPwToolsCoreCurrentRefLocator({ boundingBox });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      refs: { e1: { role: "button" }, e2: { role: "link" } },
    });

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]?.ref).toBe("e1");
    expect(result.skipped).toBe(1);
  });
});
