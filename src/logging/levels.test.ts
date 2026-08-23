// Log level tests cover allowed levels and level ordering.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { levelToMinLevel } from "./levels.js";

describe("levelToMinLevel", () => {
  it("returns tslog v4 logLevelId values in ascending order", () => {
    expect(levelToMinLevel("trace")).toBe(1);
    expect(levelToMinLevel("debug")).toBe(2);
    expect(levelToMinLevel("info")).toBe(3);
    expect(levelToMinLevel("warn")).toBe(4);
    expect(levelToMinLevel("error")).toBe(5);
    expect(levelToMinLevel("fatal")).toBe(6);
  });

  it("maps silent to Infinity to suppress all logs", () => {
    expect(levelToMinLevel("silent")).toBe(Number.POSITIVE_INFINITY);
  });

  it("fatal has a higher value than trace (not inverted)", () => {
    expect(levelToMinLevel("fatal")).toBeGreaterThan(levelToMinLevel("trace"));
  });

  it("each level is strictly more restrictive than the one below it", () => {
    const ordered = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
    for (let i = 1; i < ordered.length; i++) {
      expect(
        levelToMinLevel(expectDefined(ordered[i], "ordered[i] test invariant")),
      ).toBeGreaterThan(
        levelToMinLevel(expectDefined(ordered[i - 1], "ordered[i - 1] test invariant")),
      );
    }
  });
});
