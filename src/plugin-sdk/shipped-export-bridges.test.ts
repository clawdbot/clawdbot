import { describe, expect, it } from "vitest";
import { shouldAckReactionForWhatsApp, type WhatsAppAckReactionMode } from "./channel-feedback.js";
import { resolveChannelProgressDraftRender } from "./channel-outbound.js";

// Behavior locks for the deprecated load-only bridges consumed by published
// pre-split plugin artifacts (2026.7.2-beta.7 and earlier). Delete alongside
// the bridges when their upgrade window closes.
describe("shouldAckReactionForWhatsApp bridge", () => {
  const base = {
    emoji: "👍",
    isDirect: false,
    isGroup: true,
    directEnabled: true,
    groupMode: "mentions" as WhatsAppAckReactionMode,
    wasMentioned: false,
    groupActivated: false,
  };

  const cases: Array<{ name: string; params: Partial<typeof base>; expected: boolean }> = [
    { name: "empty emoji never acks", params: { emoji: "" }, expected: false },
    { name: "direct follows directEnabled true", params: { isDirect: true }, expected: true },
    {
      name: "direct follows directEnabled false",
      params: { isDirect: true, directEnabled: false },
      expected: false,
    },
    { name: "non-group non-direct never acks", params: { isGroup: false }, expected: false },
    { name: "group mode never", params: { groupMode: "never" }, expected: false },
    { name: "group mode always", params: { groupMode: "always" }, expected: true },
    { name: "mentions mode without mention", params: {}, expected: false },
    { name: "mentions mode with mention", params: { wasMentioned: true }, expected: true },
    {
      name: "mentions mode activated group bypasses mention",
      params: { groupActivated: true },
      expected: true,
    },
  ];

  it.each(cases)("$name", ({ params, expected }) => {
    expect(shouldAckReactionForWhatsApp({ ...base, ...params })).toBe(expected);
  });
});

describe("resolveChannelProgressDraftRender bridge", () => {
  it("returns the default when the retired render key is absent", () => {
    expect(resolveChannelProgressDraftRender({})).toBe("text");
    expect(resolveChannelProgressDraftRender(undefined, "rich")).toBe("rich");
  });

  it("passes through configured rich/text and ignores junk", () => {
    expect(resolveChannelProgressDraftRender({ streaming: { progress: { render: "rich" } } })).toBe(
      "rich",
    );
    expect(resolveChannelProgressDraftRender({ streaming: { progress: { render: "text" } } })).toBe(
      "text",
    );
    expect(
      resolveChannelProgressDraftRender({ streaming: { progress: { render: "bogus" } } }, "rich"),
    ).toBe("rich");
  });
});
