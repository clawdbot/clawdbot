/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { resolveCommunityInviteVisibility } from "./app-sidebar.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

describe("resolveCommunityInviteVisibility", () => {
  const cases: ReadonlyArray<{
    name: string;
    firstShownAtMs?: number | null;
    dismissedAtMs?: number;
    expected: "visible" | "hidden";
  }> = [
    { name: "shows on the first workspace sidebar mount", expected: "visible" },
    { name: "stays hidden after dismissal", dismissedAtMs: NOW - DAY_MS, expected: "hidden" },
    {
      name: "remains visible through day thirteen",
      firstShownAtMs: NOW - 13 * DAY_MS,
      expected: "visible",
    },
    {
      name: "retires at the fourteen-day boundary",
      firstShownAtMs: NOW - 14 * DAY_MS,
      expected: "hidden",
    },
    {
      name: "fails closed when browser storage is unavailable",
      firstShownAtMs: null,
      expected: "hidden",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(
        resolveCommunityInviteVisibility({
          firstShownAtMs: testCase.firstShownAtMs,
          dismissedAtMs: testCase.dismissedAtMs,
          now: NOW,
        }),
      ).toBe(testCase.expected);
    });
  }
});
