// Covers provider-owned target prefixes, generic kind prefixes, topic suffixes,
// and selected-channel prefix validation.
import { describe, expect, it } from "vitest";
import { stripOutboundTargetKindPrefix, stripTargetTopicSuffix } from "./channel-target-prefix.js";

describe("stripOutboundTargetKindPrefix", () => {
  it.each(["channel", "conversation", "dm", "group", "room", "thread", "user"])(
    "removes the default %s kind without changing target casing",
    (kind) => {
      expect(stripOutboundTargetKindPrefix(`${kind.toUpperCase()}:Room-A `)).toBe("Room-A");
    },
  );

  it.each([
    ["room:thread:Room-A", "thread:Room-A"],
    [" room:Room-A ", "room:Room-A"],
    ["custom:Room-A", "custom:Room-A"],
  ])("preserves prefix anchoring and removes at most one kind from %s", (raw, expected) => {
    expect(stripOutboundTargetKindPrefix(raw)).toBe(expected);
  });

  it("uses the current custom kinds on every call", () => {
    const kinds = ["room"];
    expect(stripOutboundTargetKindPrefix("room:Room-A", kinds)).toBe("Room-A");
    kinds[0] = "user";
    expect(stripOutboundTargetKindPrefix("room:Room-A", kinds)).toBe("room:Room-A");
    expect(stripOutboundTargetKindPrefix("user:User-A", kinds)).toBe("User-A");
    expect(stripOutboundTargetKindPrefix("room:Room-A")).toBe("Room-A");
  });

  it("preserves custom pattern and empty-list behavior", () => {
    expect(stripOutboundTargetKindPrefix("THREAD:Room-A", [" room|thread "])).toBe("Room-A");
    expect(stripOutboundTargetKindPrefix(" room:Room-A ", [])).toBe("room:Room-A");
    expect(() => stripOutboundTargetKindPrefix("room:Room-A", ["["])).toThrow(SyntaxError);
  });

  it("supports a nested default call while reading custom kinds", () => {
    const kinds = ["room"];
    Object.defineProperty(kinds, 0, {
      get: () => stripOutboundTargetKindPrefix("channel:room"),
    });
    expect(stripOutboundTargetKindPrefix("room:Room-A", kinds)).toBe("Room-A");
  });
});

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
