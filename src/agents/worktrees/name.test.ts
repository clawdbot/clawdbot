import { describe, expect, it } from "vitest";
import { slugifyWorktreeTitle } from "./name.js";

describe("slugifyWorktreeTitle", () => {
  it.each([
    ["Fix agent selection menu", "fix-agent-selection-menu"],
    ["Crème brûlée & release prep", "creme-brulee-and-release-prep"],
    ['  Title: "Worktree names"  ', "title-worktree-names"],
  ])("slugifies %s", (title, expected) => {
    expect(slugifyWorktreeTitle(title)).toBe(expected);
  });

  it("truncates at the last complete word within the worktree contract limit", () => {
    expect(slugifyWorktreeTitle(`${"a".repeat(50)} complete unfinished`)).toBe(
      `${"a".repeat(50)}-complete`,
    );
    expect(slugifyWorktreeTitle(`${"a".repeat(63)} two`)).toBe("a".repeat(63));
  });

  it("returns undefined when a title has no ASCII slug characters", () => {
    expect(slugifyWorktreeTitle("🦞 日本語")).toBeUndefined();
  });
});
