import { describe, expect, it } from "vitest";
import { applySelectedSessionProjection } from "./chat-pane-state.ts";

function projectionState(): Parameters<typeof applySelectedSessionProjection>[0] {
  return {
    chatEffectiveQueueMode: "interrupt",
    chatQueueModeOverride: "interrupt",
    selectedChatSessionArchived: true,
  };
}

describe("applySelectedSessionProjection", () => {
  it("retains pane-owned metadata when a scoped list omits the selected session", () => {
    const state = projectionState();

    expect(applySelectedSessionProjection(state, undefined)).toBe(false);
    expect(state).toEqual({
      chatEffectiveQueueMode: "interrupt",
      chatQueueModeOverride: "interrupt",
      selectedChatSessionArchived: true,
    });
  });

  it("adopts metadata from a matching session row", () => {
    const state = projectionState();

    expect(
      applySelectedSessionProjection(state, {
        archived: false,
        effectiveQueueMode: "followup",
        key: "agent:main:main",
        kind: "direct",
        queueMode: "followup",
        updatedAt: 1,
      }),
    ).toBe(true);
    expect(state).toEqual({
      chatEffectiveQueueMode: "followup",
      chatQueueModeOverride: "followup",
      selectedChatSessionArchived: false,
    });
  });
});
