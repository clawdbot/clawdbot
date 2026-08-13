import { describe, expect, it, vi } from "vitest";
import { resolveTurnCommentaryProgressOwner } from "./commentary-progress-owner.js";

describe("resolveTurnCommentaryProgressOwner", () => {
  it("keeps visibility live and ignores the owner callback without the static opt-in", () => {
    let verboseProgressVisible = true;
    let registeredVisibility = () => false;
    const shouldDeliverCommentaryPayloads = vi.fn(() => true);

    expect(
      resolveTurnCommentaryProgressOwner({
        commentaryPayloadsEnabled: false,
        options: {
          shouldDeliverCommentaryPayloads,
          onVerboseProgressVisibility: (getter) => {
            registeredVisibility = getter;
          },
        },
        resolveVerboseProgressVisibility: () => verboseProgressVisible,
      }),
    ).toEqual({ commentaryPayloadsEnabled: false, draftOwnsCommentaryProgress: false });

    expect(shouldDeliverCommentaryPayloads).not.toHaveBeenCalled();
    expect(registeredVisibility()).toBe(true);
    verboseProgressVisible = false;
    expect(registeredVisibility()).toBe(false);
  });

  it.each([
    {
      owner: "static opt-in without a callback",
      shouldDeliverCommentaryPayloads: undefined,
      expected: { commentaryPayloadsEnabled: true, draftOwnsCommentaryProgress: false },
    },
    {
      owner: "draft callback",
      shouldDeliverCommentaryPayloads: () => false,
      expected: { commentaryPayloadsEnabled: false, draftOwnsCommentaryProgress: true },
    },
    {
      owner: "durable callback",
      shouldDeliverCommentaryPayloads: () => true,
      expected: { commentaryPayloadsEnabled: true, draftOwnsCommentaryProgress: false },
    },
  ])("records $owner ownership", ({ shouldDeliverCommentaryPayloads, expected }) => {
    expect(
      resolveTurnCommentaryProgressOwner({
        commentaryPayloadsEnabled: true,
        options: {
          shouldDeliverCommentaryPayloads,
        },
        resolveVerboseProgressVisibility: () => false,
      }),
    ).toEqual(expected);
  });
});
