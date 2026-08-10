import { describe, expect, it } from "vitest";
import { makePlaceholderUsageSnapshot, makeZeroUsageSnapshot } from "../usage.js";
import { isZeroUsageEmptyStopAssistantTurn } from "./empty-assistant-turn.js";

describe("isZeroUsageEmptyStopAssistantTurn", () => {
  it("drops an explicit provider-observed all-zero stop turn", () => {
    expect(
      isZeroUsageEmptyStopAssistantTurn({
        content: [],
        stopReason: "stop",
        usage: {
          ...makeZeroUsageSnapshot(),
          tokenCountsObserved: ["input", "output", "cacheRead", "cacheWrite", "total"],
        },
      }),
    ).toBe(true);
  });

  it("preserves a structural runtime placeholder stop turn", () => {
    expect(
      isZeroUsageEmptyStopAssistantTurn({
        content: [],
        stopReason: "stop",
        usage: makePlaceholderUsageSnapshot(),
      }),
    ).toBe(false);
  });
});
