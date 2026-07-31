import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  type AnnotationItem,
  buildOverlayClearScript,
  buildOverlayInjectionScript,
  planAnnotations,
  type RawAnnotationInput,
  scaleAnnotations,
} from "./screenshot-annotate.js";

const ANNOTATION_OVERLAY_ATTR = "data-openclaw-labels";

const sampleInputs: RawAnnotationInput[] = [
  {
    ref: "e1",
    role: "button",
    name: "Submit",
    doc: { x: 100, y: 200, width: 50, height: 20 },
  },
  {
    ref: "e2",
    role: "link",
    doc: { x: 300, y: 1500, width: 80, height: 18 },
  },
];

describe("planAnnotations - viewport mode", () => {
  it("subtracts scroll from doc coords", () => {
    const plan = planAnnotations({
      inputs: sampleInputs,
      space: "viewport",
      scroll: { x: 0, y: 1000 },
    });

    expect(plan.annotations).toHaveLength(2);
    expect(plan.annotations[0]).toEqual({
      ref: "e1",
      number: 1,
      role: "button",
      name: "Submit",
      box: { x: 100, y: -800, width: 50, height: 20 },
    });
    expect(plan.annotations[1]).toEqual({
      ref: "e2",
      number: 2,
      role: "link",
      box: { x: 300, y: 500, width: 80, height: 18 },
    });
    expect(plan.skipped).toBe(0);
  });

  it("keeps overlay items in document space regardless of mode", () => {
    const plan = planAnnotations({
      inputs: sampleInputs,
      space: "viewport",
      scroll: { x: 0, y: 1000 },
    });
    expect(plan.overlayItems).toEqual([
      { ref: "e1", x: 100, y: 200, w: 50, h: 20 },
      { ref: "e2", x: 300, y: 1500, w: 80, h: 18 },
    ]);
  });

  it("omits empty name field", () => {
    const plan = planAnnotations({
      inputs: [{ ref: "e1", role: "button", name: "", doc: { x: 0, y: 0, width: 1, height: 1 } }],
      space: "viewport",
      scroll: { x: 0, y: 0 },
    });
    expect(plan.annotations[0]).not.toHaveProperty("name");
  });

  it("throws when scroll missing in viewport mode", () => {
    expect(() => planAnnotations({ inputs: sampleInputs, space: "viewport" })).toThrow(/scroll/);
  });
});

describe("planAnnotations - viewport off-screen accounting", () => {
  it("counts off-viewport refs as skipped but keeps them in annotations when viewport size is given", () => {
    const plan = planAnnotations({
      inputs: [
        { ref: "e1", role: "button", doc: { x: 10, y: 50, width: 40, height: 20 } }, // in viewport
        { ref: "e2", role: "link", doc: { x: 10, y: 5000, width: 40, height: 20 } }, // below viewport
      ],
      space: "viewport",
      scroll: { x: 0, y: 0 },
      viewport: { width: 1280, height: 720 },
    });

    // Only the in-viewport ref is drawn.
    expect(plan.overlayItems.map((o) => o.ref)).toEqual(["e1"]);
    // Both refs are surfaced for callers (off-viewport box can be out of image).
    expect(plan.annotations.map((a) => a.ref)).toEqual(["e1", "e2"]);
    // The off-viewport ref raises skipped, preserving the shipped contract.
    expect(plan.skipped).toBe(1);
  });

  it("does not count off-viewport refs when viewport size is omitted", () => {
    const plan = planAnnotations({
      inputs: [{ ref: "e2", role: "link", doc: { x: 10, y: 5000, width: 40, height: 20 } }],
      space: "viewport",
      scroll: { x: 0, y: 0 },
    });

    expect(plan.skipped).toBe(0);
    expect(plan.overlayItems).toHaveLength(1);
    expect(plan.annotations).toHaveLength(1);
  });
});

describe("planAnnotations - fullpage mode", () => {
  it("returns box equal to doc (document coordinates)", () => {
    const plan = planAnnotations({ inputs: sampleInputs, space: "fullpage" });
    expect(expectDefined(plan.annotations[0], "first full-page annotation").box).toEqual({
      x: 100,
      y: 200,
      width: 50,
      height: 20,
    });
    expect(expectDefined(plan.annotations[1], "second full-page annotation").box).toEqual({
      x: 300,
      y: 1500,
      width: 80,
      height: 18,
    });
  });

  it("does not require scroll", () => {
    expect(() => planAnnotations({ inputs: sampleInputs, space: "fullpage" })).not.toThrow();
  });
});

describe("planAnnotations - element mode", () => {
  const elementRect = { x: 50, y: 100, width: 200, height: 300 };

  it("projects box relative to element top-left", () => {
    const plan = planAnnotations({
      inputs: [{ ref: "e1", role: "button", doc: { x: 60, y: 110, width: 40, height: 20 } }],
      space: "element",
      elementRect,
    });
    expect(expectDefined(plan.annotations[0], "element annotation").box).toEqual({
      x: 10,
      y: 10,
      width: 40,
      height: 20,
    });
  });

  it("filters out inputs that do not overlap element rect", () => {
    const plan = planAnnotations({
      inputs: [
        { ref: "e1", role: "button", doc: { x: 60, y: 110, width: 40, height: 20 } }, // inside
        { ref: "e2", role: "link", doc: { x: 500, y: 500, width: 40, height: 20 } }, // outside
      ],
      space: "element",
      elementRect,
    });
    expect(plan.annotations).toHaveLength(1);
    expect(expectDefined(plan.annotations[0], "overlapping element annotation").ref).toBe("e1");
    expect(plan.overlayItems).toHaveLength(1);
  });

  it("throws when elementRect missing", () => {
    expect(() => planAnnotations({ inputs: [], space: "element" })).toThrow(/elementRect/);
  });
});

describe("planAnnotations - maxLabels", () => {
  it("truncates to maxLabels and reports skipped", () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      ref: `e${i + 1}`,
      role: "button",
      doc: { x: 0, y: i * 10, width: 5, height: 5 },
    }));
    const plan = planAnnotations({ inputs, space: "fullpage", maxLabels: 2 });
    expect(plan.annotations).toHaveLength(2);
    expect(plan.overlayItems).toHaveLength(2);
    expect(plan.skipped).toBe(3);
  });

  it("uses ANNOTATION_MAX_LABELS_DEFAULT when not specified", () => {
    const inputs = Array.from({ length: 200 }, (_, i) => ({
      ref: `e${i + 1}`,
      role: "button",
      doc: { x: 0, y: i, width: 5, height: 5 },
    }));
    const plan = planAnnotations({ inputs, space: "fullpage" });
    expect(plan.annotations).toHaveLength(150);
    expect(plan.skipped).toBe(50);
  });
});

describe("buildOverlayInjectionScript", () => {
  it("returns a self-contained IIFE", () => {
    const script = buildOverlayInjectionScript({
      items: [{ ref: "e1", x: 100, y: 200, w: 50, h: 20 }],
    });
    expect(script).toMatch(/^\(\s*\(\s*\)\s*=>\s*\{/);
    expect(script).toMatch(/\}\s*\)\s*\(\s*\)\s*;?\s*$/);
  });

  it("embeds the overlay attr", () => {
    const script = buildOverlayInjectionScript({ items: [] });
    expect(script).toContain(ANNOTATION_OVERLAY_ATTR);
  });

  it("embeds each item's ref text and coordinates", () => {
    const script = buildOverlayInjectionScript({
      items: [
        { ref: "e1", x: 100, y: 200, w: 50, h: 20 },
        { ref: "ax42", x: 999, y: 1500, w: 80, h: 18 },
      ],
    });
    expect(script).toMatch(/"ref":\s*"e1"/);
    expect(script).toMatch(/"ref":\s*"ax42"/);
    expect(script).toMatch(/"x":\s*100/);
    expect(script).toMatch(/"x":\s*999/);
  });

  it("handles empty items without throwing", () => {
    expect(() => buildOverlayInjectionScript({ items: [] })).not.toThrow();
  });

  it("rounds coordinates to integers", () => {
    const script = buildOverlayInjectionScript({
      items: [{ ref: "e1", x: 100.7, y: 200.4, w: 50.6, h: 20.1 }],
    });
    expect(script).toMatch(/"x":\s*101/); // 100.7 -> 101
    expect(script).toMatch(/"y":\s*200/); // 200.4 -> 200
  });

  it("clamps zero/negative-size boxes to 1px so they remain visible", () => {
    const script = buildOverlayInjectionScript({
      items: [{ ref: "e1", x: 10, y: 10, w: 0, h: 0 }],
    });
    expect(script).toMatch(/"w":\s*1/);
    expect(script).toMatch(/"h":\s*1/);
  });

  it("escapes hostile ref characters via JSON.stringify (no breakout)", () => {
    const hostile = 'e1");alert(1);//';
    const script = buildOverlayInjectionScript({
      items: [{ ref: hostile, x: 0, y: 0, w: 1, h: 1 }],
    });
    // The hostile `"` MUST be escaped as `\"` inside the JSON literal.
    expect(script).toContain('"e1\\");alert(1);//"');
    // The unescaped breakout MUST NOT appear anywhere in the script as a
    // bare statement that would terminate the JSON literal early.
    expect(script).not.toContain('e1");alert(1);');
  });

  it("flips label below the box when y < 14 (no headroom)", () => {
    const script = buildOverlayInjectionScript({
      items: [{ ref: "e1", x: 0, y: 5, w: 10, h: 10 }],
    });
    // labelTop = relativeY < 14 ? it.y + 2 : it.y - 14
    // The expression literal `relativeY < 14 ? (it.y + 2) : (it.y - 14)` is in the script.
    expect(script).toContain("relativeY < 14 ? (it.y + 2) : (it.y - 14)");
  });

  it("uses capture-relative y when deciding whether to flip labels below boxes", () => {
    const script = buildOverlayInjectionScript({
      items: [{ ref: "e1", x: 0, y: 1005, w: 10, h: 10 }],
      captureY: 1000,
    });

    expect(script).toContain("var captureY = 1000;");
    expect(script).toContain("var relativeY = it.y - captureY;");
    expect(script).toContain("relativeY < 14 ? (it.y + 2) : (it.y - 14)");
  });
});

describe("buildOverlayClearScript", () => {
  it("returns an IIFE selecting overlay attr", () => {
    const script = buildOverlayClearScript();
    expect(script).toContain(`[${ANNOTATION_OVERLAY_ATTR}]`);
    expect(script).toMatch(/^\(\s*\(\s*\)\s*=>\s*\{/);
  });
});

describe("scaleAnnotations", () => {
  const sample: AnnotationItem[] = [
    {
      ref: "e1",
      number: 1,
      role: "button",
      name: "Submit",
      box: { x: 100, y: 200, width: 50, height: 20 },
    },
  ];

  it("returns identity (structural copy) when both factors are 1", () => {
    const out = scaleAnnotations(sample, 1, 1);
    expect(out[0]).toEqual(sample[0]);
    expect(out[0]).not.toBe(sample[0]);
    expect(out[0]?.box).not.toBe(sample[0]?.box);
  });

  it("scales box dimensions by independent x/y factors", () => {
    const out = scaleAnnotations(sample, 0.5, 0.485);
    expect(out[0]?.box).toEqual({
      x: 50,
      y: 97,
      width: 25,
      height: 10,
    });
  });

  it("clamps width/height to a minimum of 1 to avoid disappearing labels", () => {
    const tiny: AnnotationItem[] = [
      {
        ref: "e1",
        number: 1,
        role: "button",
        box: { x: 0, y: 0, width: 1, height: 1 },
      },
    ];
    const out = scaleAnnotations(tiny, 0.1, 0.1);
    expect(out[0]?.box.width).toBeGreaterThanOrEqual(1);
    expect(out[0]?.box.height).toBeGreaterThanOrEqual(1);
  });

  it("returns identity (structural copy) for invalid factors", () => {
    const out = scaleAnnotations(sample, Number.NaN, 0.5);
    expect(out[0]?.box).toEqual(sample[0]?.box);
    const out2 = scaleAnnotations(sample, 0, 0.5);
    expect(out2[0]?.box).toEqual(sample[0]?.box);
    const out3 = scaleAnnotations(sample, -1, 1);
    expect(out3[0]?.box).toEqual(sample[0]?.box);
  });

  it("preserves ref/number/role/name fields verbatim", () => {
    const out = scaleAnnotations(sample, 0.5, 0.5);
    expect(out[0]?.ref).toBe("e1");
    expect(out[0]?.number).toBe(1);
    expect(out[0]?.role).toBe("button");
    expect(out[0]?.name).toBe("Submit");
  });
});
