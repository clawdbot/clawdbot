/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { resolveCommunityInviteVisibility } from "./community-invite-state.ts";

const NOW = 1_760_000_000_000;

describe("resolveCommunityInviteVisibility", () => {
  const cases: ReadonlyArray<{
    name: string;
    dismissedAtMs?: number | null;
    expected: "visible" | "hidden";
  }> = [
    { name: "shows on the first workspace sidebar mount", expected: "visible" },
    { name: "stays hidden after dismissal", dismissedAtMs: NOW, expected: "hidden" },
    {
      name: "fails closed when browser storage is unavailable",
      dismissedAtMs: null,
      expected: "hidden",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(
        resolveCommunityInviteVisibility({
          dismissedAtMs: testCase.dismissedAtMs,
        }),
      ).toBe(testCase.expected);
    });
  }
});
