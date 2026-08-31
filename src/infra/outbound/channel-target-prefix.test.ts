// Covers provider-owned target prefixes, generic kind prefixes, topic suffixes,
// and selected-channel prefix validation.
import { describe, expect, it } from "vitest";
import { stripTargetTopicSuffix } from "./channel-target-prefix.js";

describe("stripTargetTopicSuffix", () => {
  it("strips explicit topic suffixes", () => {
    expect(stripTargetTopicSuffix("room-a:topic:77")).toBe("room-a");
  });

  it("strips Telegram numeric topic shorthand only when requested", () => {
    expect(stripTargetTopicSuffix("-100200300:77", { allowNumericShorthand: true })).toBe(
      "-100200300",
    );
  });

  it("keeps generic colon targets intact", () => {
    expect(stripTargetTopicSuffix("room:123")).toBe("room:123");
    expect(stripTargetTopicSuffix("room-a:child")).toBe("room-a:child");
  });
});
