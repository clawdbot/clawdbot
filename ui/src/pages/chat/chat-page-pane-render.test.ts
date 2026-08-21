import { describe, expect, it } from "vitest";
import { bottomDockDefault } from "./chat-page-pane-render.ts";

describe("chat page pane rendering", () => {
  it.each([
    ["classic", false, false, 1, false],
    ["side-by-side split", true, false, 1, true],
    ["stacked split", true, false, 2, false],
    ["narrow split", true, true, 1, false],
  ] as const)(
    "selects the %s dock default",
    (_name, splitMode, narrow, columnPaneCount, expected) => {
      expect(bottomDockDefault(splitMode, narrow, columnPaneCount)).toBe(expected);
    },
  );
});
