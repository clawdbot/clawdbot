import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderCheckoutChip, resolveCheckoutChip } from "./checkout-chip.ts";

describe("Checkout chip state", () => {
  it.each([
    {
      destination: "remote",
      worktree: true,
      worktreeAvailable: true,
      headBranch: "main",
      baseRef: "main",
      label: "New worktree from main",
    },
    {
      destination: "remote",
      worktree: true,
      worktreeAvailable: false,
      baseRef: "",
      label: "New worktree",
    },
    { destination: "local", worktree: false, worktreeAvailable: false, baseRef: "", label: null },
    {
      destination: "local",
      worktree: false,
      worktreeAvailable: true,
      headBranch: "feature",
      baseRef: "main",
      label: "feature",
    },
    {
      destination: "local",
      worktree: false,
      worktreeAvailable: true,
      baseRef: "main",
      label: "Current checkout",
    },
    {
      destination: "local",
      worktree: true,
      worktreeAvailable: true,
      headBranch: "feature",
      baseRef: "main",
      label: "New worktree from main",
    },
    {
      destination: "local",
      worktree: true,
      worktreeAvailable: true,
      baseRef: "release",
      label: "New worktree from release",
    },
    {
      destination: "local",
      worktree: true,
      worktreeAvailable: true,
      baseRef: "",
      label: "New worktree",
    },
    {
      destination: "local",
      worktree: true,
      worktreeAvailable: false,
      baseRef: "",
      label: "New worktree",
    },
  ] as const)(
    "$destination worktree=$worktree available=$worktreeAvailable: $label",
    ({ label, ...params }) => {
      expect(resolveCheckoutChip(params)).toEqual(label === null ? null : { label });
    },
  );

  it.each([
    { worktree: false, remotePlacement: false },
    { worktree: true, remotePlacement: false },
    { worktree: true, remotePlacement: true },
  ])(
    "offers explicit checkout choices (worktree=$worktree, remote=$remotePlacement)",
    ({ worktree, remotePlacement }) => {
      const container = document.createElement("div");
      const onSelectWorktree = vi.fn();
      const onBaseRefChange = vi.fn();
      const onWorktreeNameInput = vi.fn();
      render(
        renderCheckoutChip({
          state: { label: worktree ? "New worktree from main" : "feature" },
          remotePlacement,
          folderLabel: "OpenClaw",
          worktree,
          worktreeAvailable: true,
          branches: { repoRoot: "/repo", branches: [], headBranch: "feature" },
          branchesLoading: false,
          baseRef: "main",
          worktreeName: "",
          submitting: false,
          pendingPlacement: false,
          popoverOpen: true,
          popoverHiding: false,
          onGuardTransition: () => undefined,
          onPopoverShow: () => undefined,
          onPopoverHide: () => undefined,
          onPopoverAfterHide: () => undefined,
          onSelectWorktree,
          onManageWorktrees: () => undefined,
          onBaseRefChange,
          onWorktreeNameInput,
        }),
        container,
      );

      const current = container.querySelector<HTMLButtonElement>('[data-value="checkout"]')!;
      const isolated = container.querySelector<HTMLButtonElement>('[data-value="worktree"]')!;
      expect(current.textContent).toContain("Current checkout");
      expect(current.querySelector(".session-menu__sub")?.textContent).toBe("feature");
      expect(current.getAttribute("aria-pressed")).toBe(String(!worktree));
      expect(current.disabled).toBe(remotePlacement);
      expect(current.getAttribute("title")).toBe(
        remotePlacement ? "Devices and cloud run in a worktree" : null,
      );
      expect(isolated.textContent).toContain("New worktree");
      expect(isolated.textContent).toContain("Isolated copy of the repo");
      expect(isolated.getAttribute("aria-pressed")).toBe(String(worktree));
      expect(isolated.disabled).toBe(false);
      expect(isolated.hasAttribute("title")).toBe(false);
      expect(current.hasAttribute("data-popover")).toBe(false);
      expect(isolated.hasAttribute("data-popover")).toBe(false);
      current.click();
      isolated.click();
      expect(onSelectWorktree.mock.calls).toEqual(remotePlacement ? [[true]] : [[false], [true]]);

      const fields = container.querySelectorAll<HTMLLabelElement>(".new-session-page__menu-field");
      expect(fields).toHaveLength(worktree ? 2 : 0);
      if (worktree) {
        expect(fields[0]?.querySelector("span")?.textContent).toBe("From");
        expect(fields[1]?.querySelector("span")?.textContent).toBe("Name");
        const baseRef = fields[0]!.querySelector("input")!;
        const name = fields[1]!.querySelector("input")!;
        expect(baseRef.value).toBe("main");
        expect(name.placeholder).toBe("Named from the session title");
        baseRef.value = " release ";
        baseRef.dispatchEvent(new Event("change"));
        name.value = " checkout-proof ";
        name.dispatchEvent(new Event("input"));
        expect(onBaseRefChange).toHaveBeenCalledWith("release");
        expect(onWorktreeNameInput).toHaveBeenCalledWith("checkout-proof");
        expect(container.textContent).toContain(
          "Creates branch openclaw/<name> in a separate checkout.",
        );
      } else {
        expect(container.querySelector(".new-session-page__menu-note")).toBeNull();
      }
      expect(container.textContent?.includes("Syncs OpenClaw to the selected runner")).toBe(
        remotePlacement,
      );
    },
  );
  it.each(["insufficient-space", "unavailable"] as const)(
    "blocks worktree selection when allocation is %s",
    (status) => {
      const container = document.createElement("div");
      const onSelectWorktree = vi.fn();
      const onManageWorktrees = vi.fn();
      const onBaseRefChange = vi.fn();
      render(
        renderCheckoutChip({
          state: { label: "feature" },
          remotePlacement: false,
          folderLabel: "OpenClaw",
          worktree: false,
          worktreeAvailable: true,
          allocationBlockedReason:
            status === "insufficient-space"
              ? "No space for a worktree"
              : "Worktree capacity unknown",
          branches: { repoRoot: "/repo", branches: [], headBranch: "feature" },
          branchesLoading: false,
          baseRef: "main",
          worktreeName: "",
          submitting: false,
          pendingPlacement: false,
          popoverOpen: true,
          popoverHiding: false,
          onGuardTransition: () => undefined,
          onPopoverShow: () => undefined,
          onPopoverHide: () => undefined,
          onPopoverAfterHide: () => undefined,
          onSelectWorktree,
          onManageWorktrees,
          onBaseRefChange,
          onWorktreeNameInput: () => undefined,
        }),
        container,
      );

      expect(container.querySelector(".new-session-page__capacity-warning")?.textContent).toContain(
        status === "insufficient-space" ? "No space for a worktree" : "Worktree capacity unknown",
      );
      const isolated = container.querySelector<HTMLButtonElement>('[data-value="worktree"]')!;
      expect(isolated.disabled).toBe(true);
      isolated.click();
      expect(onSelectWorktree).not.toHaveBeenCalled();
      const fields = container.querySelectorAll<HTMLLabelElement>(".new-session-page__menu-field");
      expect(fields).toHaveLength(1);
      const baseRef = fields[0]!.querySelector("input")!;
      baseRef.value = " local-branch ";
      baseRef.dispatchEvent(new Event("change"));
      expect(onBaseRefChange).toHaveBeenCalledWith("local-branch");
      container.querySelector<HTMLButtonElement>(".new-session-page__capacity-warning")!.click();
      expect(onManageWorktrees).toHaveBeenCalledOnce();
    },
  );
});
