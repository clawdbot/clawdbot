import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderDetailChip, resolveDetailChip } from "./detail-chip.ts";

describe("Detail chip state", () => {
  it.each([
    {
      name: "hides the detail chip for remote destinations",
      params: {
        destination: "remote" as const,
        worktree: false,
        worktreeAvailable: true,
      },
      expected: null,
    },
    {
      name: "hides the detail chip when local isolation is unavailable",
      params: {
        destination: "local" as const,
        worktree: false,
        worktreeAvailable: false,
      },
      expected: null,
    },
    {
      name: "shows the local isolation choice when it is available",
      params: {
        destination: "local" as const,
        worktree: false,
        worktreeAvailable: true,
      },
      expected: { label: "Runs directly" },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveDetailChip(params)).toEqual(expected);
  });

  it("keeps local isolation terminology as Worktree", () => {
    const container = document.createElement("div");
    render(
      renderDetailChip({
        state: { label: "Worktree" },
        worktree: true,
        worktreeAvailable: true,
        branches: { repoRoot: "/repo", branches: [], headBranch: "main" },
        branchesLoading: false,
        baseRef: "",
        worktreeName: "",
        submitting: false,
        pendingCloud: false,
        popoverOpen: true,
        popoverHiding: false,
        onGuardTransition: () => undefined,
        onPopoverShow: () => undefined,
        onPopoverHide: () => undefined,
        onPopoverAfterHide: () => undefined,
        onToggleWorktree: () => undefined,
        onBaseRefInput: () => undefined,
        onWorktreeNameInput: () => undefined,
      }),
      container,
    );

    const worktree = container.querySelector<HTMLButtonElement>('[data-value="worktree"]');
    const baseBranch = container.querySelector<HTMLInputElement>(
      'input[list="new-session-branches"]',
    );
    expect(worktree?.disabled).toBe(false);
    expect(baseBranch?.value).toBe("");
    expect(baseBranch?.placeholder).toBe("main");
    expect(container.textContent).toContain("Worktree name");
  });
});
