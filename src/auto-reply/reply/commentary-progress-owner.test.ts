import { describe, expect, it, vi } from "vitest";
import { resolveTurnCommentaryPayloadsEnabled } from "./commentary-progress-owner.js";

describe("resolveTurnCommentaryPayloadsEnabled", () => {
  it("keeps visibility live and ignores the owner callback without the static opt-in", () => {
    let verboseProgressVisible = true;
    let registeredVisibility = () => false;
    const shouldDeliverCommentaryPayloads = vi.fn(() => true);

    expect(
      resolveTurnCommentaryPayloadsEnabled({
        commentaryPayloadsEnabled: false,
        options: {
          shouldDeliverCommentaryPayloads,
          onVerboseProgressVisibility: (getter) => {
            registeredVisibility = getter;
          },
        },
        resolveVerboseProgressVisibility: () => verboseProgressVisible,
      }),
    ).toBe(false);

    expect(shouldDeliverCommentaryPayloads).not.toHaveBeenCalled();
    expect(registeredVisibility()).toBe(true);
    verboseProgressVisible = false;
    expect(registeredVisibility()).toBe(false);
  });
});
