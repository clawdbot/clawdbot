// System prompt cache-boundary tests cover the internal marker that separates
// stable prompt text from dynamic per-turn additions.
import { describe, expect, it } from "vitest";
import {
  ensureSystemPromptCacheBoundary,
  prependSystemPromptAdditionAfterCacheBoundary,
  splitSystemPromptCacheBoundary,
  splitSystemPromptRelocatableBoundary,
  stripSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "./system-prompt-cache-boundary.js";

describe("system prompt cache boundary helpers", () => {
  it("splits stable and dynamic prompt regions", () => {
    expect(
      splitSystemPromptCacheBoundary(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`),
    ).toEqual({
      stablePrefix: "Stable prefix",
      dynamicSuffix: "Dynamic suffix",
    });
  });

  it("strips the internal marker from prompt text", () => {
    expect(
      stripSystemPromptCacheBoundary(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`),
    ).toBe("Stable prefix\nDynamic suffix");
  });

  it("inserts prompt additions after the cache boundary", () => {
    expect(
      prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        systemPromptAddition: "Per-turn lab context",
      }),
    ).toBe(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Per-turn lab context\n\nDynamic suffix`);
  });

  it("normalizes structured additions and dynamic suffix whitespace", () => {
    expect(
      prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix  \r\n\r\nMore detail \t\r\n`,
        systemPromptAddition: "  Per-turn lab context \r\nSecond line\t\r\n",
      }),
    ).toBe(
      `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Per-turn lab context\nSecond line\n\nDynamic suffix\n\nMore detail`,
    );
  });

  it("normalizes malformed surrogates in dynamic prompt sections", () => {
    const high = String.fromCharCode(0xd83d);

    expect(
      prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic${high} suffix`,
        systemPromptAddition: `Per-turn${high} context`,
      }),
    ).toBe(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Per-turn context\n\nDynamic suffix`);
  });
});

describe("ensureSystemPromptCacheBoundary", () => {
  it("returns a marker-bearing prompt unchanged", () => {
    const prompt = `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`;
    expect(ensureSystemPromptCacheBoundary(prompt)).toBe(prompt);
  });

  it("appends the boundary to a marker-free prompt", () => {
    expect(ensureSystemPromptCacheBoundary("Marker-free override")).toBe(
      `Marker-free override${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
    );
  });

  it("does not add a boundary for an empty prompt", () => {
    expect(ensureSystemPromptCacheBoundary("")).toBe("");
    expect(ensureSystemPromptCacheBoundary(" \n\t ")).toBe(" \n\t ");
  });

  it("uses a per-turn addition directly when the base prompt is empty", () => {
    expect(
      prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: ensureSystemPromptCacheBoundary(""),
        systemPromptAddition: "Per-turn media task hint",
      }),
    ).toBe("Per-turn media task hint");
  });

  it("is idempotent for a marker-free prompt", () => {
    const once = ensureSystemPromptCacheBoundary("Marker-free override");
    expect(ensureSystemPromptCacheBoundary(once)).toBe(once);
  });

  it("lets a per-turn addition split into the uncached suffix for a marker-free prompt", () => {
    // Marker-free overrides become stable prefixes; additions stay in the
    // dynamic suffix so prompt-cache bytes remain deterministic.
    const result = prependSystemPromptAdditionAfterCacheBoundary({
      systemPrompt: ensureSystemPromptCacheBoundary("Marker-free override"),
      systemPromptAddition: "Per-turn media task hint",
    });
    expect(splitSystemPromptCacheBoundary(result)).toEqual({
      stablePrefix: "Marker-free override",
      dynamicSuffix: "Per-turn media task hint",
    });
  });
});

describe("relocatable region splitting", () => {
  const marked = (facts: string) =>
    `${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}${facts}${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`;

  it("cuts the marked region out of the prompt", () => {
    expect(
      splitSystemPromptRelocatableBoundary(
        `Behavioral guidance${marked("Runtime: session=alpha")}`,
      ),
    ).toEqual({
      remainingPrompt: "Behavioral guidance",
      relocatable: "Runtime: session=alpha",
    });
  });

  it("keeps text appended after the region in the prompt", () => {
    // Hook context and permission notices are appended once the prompt is
    // built. They must not travel with the runtime facts.
    expect(
      splitSystemPromptRelocatableBoundary(
        `Behavioral guidance${marked("Runtime: session=alpha")}Hook instruction`,
      ),
    ).toEqual({
      remainingPrompt: "Behavioral guidance\nHook instruction",
      relocatable: "Runtime: session=alpha",
    });
  });

  it("returns undefined when the region is never closed", () => {
    expect(
      splitSystemPromptRelocatableBoundary(
        `Behavioral guidance${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Runtime: session=alpha`,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an unmarked prompt", () => {
    expect(splitSystemPromptRelocatableBoundary("Behavioral guidance")).toBeUndefined();
  });

  it("strips both markers from prompt text", () => {
    const stripped = stripSystemPromptCacheBoundary(
      `Behavioral guidance${marked("Runtime: session=alpha")}`,
    );
    expect(stripped).not.toContain("OPENCLAW-RELOCATABLE-BOUNDARY");
    expect(stripped).toContain("Runtime: session=alpha");
  });
});
