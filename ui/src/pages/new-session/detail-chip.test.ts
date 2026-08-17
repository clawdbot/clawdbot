import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderDetailChip, resolveDetailChip } from "./detail-chip.ts";

describe("Detail chip state", () => {
  it.each([
    {
      name: "shows a node cwd decision",
      params: {
        execNode: "macbook",
        cloudProfileId: "",
        worktree: false,
        repository: { kind: "idle" as const },
      },
      expected: { mode: "node", label: "Node path", worktreeLocked: false },
    },
    {
      name: "keeps cloud worktrees visibly locked",
      params: {
        execNode: "",
        cloudProfileId: "fleet",
        worktree: true,
        repository: { kind: "git" as const, repoRoot: "/repo", branches: [] },
      },
      expected: { mode: "cloud", label: "Worktree", worktreeLocked: true },
    },
    {
      name: "explains plain-folder execution",
      params: {
        execNode: "",
        cloudProfileId: "",
        worktree: false,
        repository: { kind: "direct" as const, repoRoot: "/folder" },
      },
      expected: { mode: "direct", label: "Runs directly", worktreeLocked: false },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveDetailChip(params)).toEqual(expected);
  });

  it("renders the cloud lock reason as visible text", () => {
    const container = document.createElement("div");
    render(
      renderDetailChip({
        state: { mode: "cloud", label: "Worktree", worktreeLocked: true },
        syncLabel: "OpenClaw",
        folder: "/repo",
        execNode: "",
        worktree: true,
        worktreeAvailable: true,
        branches: { repoRoot: "/repo", branches: [] },
        branchesLoading: false,
        baseRef: "main",
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
        onNodeFolderInput: () => undefined,
      }),
      container,
    );

    const worktree = container.querySelector<HTMLButtonElement>('[data-value="worktree"]');
    expect(worktree?.disabled).toBe(true);
    expect(container.textContent).toContain("Cloud workers require a managed worktree");
    expect(container.textContent).toContain("Syncs OpenClaw to the cloud worker");
  });
});
