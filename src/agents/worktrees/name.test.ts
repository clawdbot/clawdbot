import { describe, expect, it } from "vitest";
import { slugifyWorktreeTitle, worktreeNameAllocationFamily } from "./name.js";

describe("slugifyWorktreeTitle", () => {
  it.each([
    ["Fix agent selection menu", "fix-agent-selection-menu"],
    ["Crème brûlée & release prep", "creme-brulee-and-release-prep"],
    ['  Title: "Worktree names"  ', "title-worktree-names"],
  ])("slugifies %s", (title, expected) => {
    expect(slugifyWorktreeTitle(title)).toBe(expected);
  });

  it("truncates at the worktree contract limit without a trailing dash", () => {
    expect(slugifyWorktreeTitle(`${"a".repeat(63)} two`)).toBe("a".repeat(63));
  });

  it("returns undefined when a title has no ASCII slug characters", () => {
    expect(slugifyWorktreeTitle("🦞 日本語")).toBeUndefined();
  });

  it("joins numeric and dash-truncated names into the same allocation family", () => {
    const base = `${"a".repeat(58)}-${"b".repeat(5)}`;
    const thousandthCandidate = `${"a".repeat(58)}-1000`;

    expect(worktreeNameAllocationFamily(base)).toBe("a".repeat(58));
    expect(worktreeNameAllocationFamily(thousandthCandidate)).toBe("a".repeat(58));
    expect(worktreeNameAllocationFamily("task-2-3")).toBe("task");
  });
});
