import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderCheckoutChip, resolveCheckoutChip } from "./checkout-chip.ts";

describe("Checkout chip state", () => {
  it.each([
    {
      destination: "remote",
      repository: true,
      worktree: false,
      worktreeAvailable: true,
      baseRef: "release",
      label: "Remote checkout from release",
    },
    {
      destination: "remote",
      repository: true,
      worktree: false,
      worktreeAvailable: true,
      baseRef: "",
      label: "Remote checkout",
    },
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
    { worktree: false, remotePlacement: false, repository: false },
    { worktree: true, remotePlacement: false, repository: false },
    { worktree: true, remotePlacement: true, repository: false },
    { worktree: false, remotePlacement: true, repository: true },
  ])(
    "offers explicit checkout choices (worktree=$worktree, remote=$remotePlacement)",
    ({ worktree, remotePlacement, repository }) => {
      const container = document.createElement("div");
      const onSelectWorktree = vi.fn();
      const onBaseRefInput = vi.fn();
      const onWorktreeNameInput = vi.fn();
      render(
        renderCheckoutChip({
          state: { label: worktree ? "New worktree from main" : "feature" },
          remotePlacement,
          repository,
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
          onBaseRefInput,
          onWorktreeNameInput,
        }),
        container,
      );

      if (repository) {
        expect(container.querySelector('[data-value="checkout"]')).toBeNull();
        expect(container.querySelector('[data-value="worktree"]')).toBeNull();
        const inputs = container.querySelectorAll<HTMLInputElement>("input");
        expect(inputs).toHaveLength(1);
        inputs[0]!.value = "release/next";
        inputs[0]!.dispatchEvent(new Event("input"));
        expect(onBaseRefInput).toHaveBeenCalledWith("release/next");
        expect(container.textContent).toContain(
          "Clones OpenClaw on the selected runner. No Gateway checkout is created.",
        );
        return;
      }

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
        baseRef.dispatchEvent(new Event("input"));
        name.value = " checkout-proof ";
        name.dispatchEvent(new Event("input"));
        expect(onBaseRefInput).toHaveBeenCalledWith("release");
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
});
