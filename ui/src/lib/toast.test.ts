/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "../components/modal-dialog.ts";
import { showToast } from "./toast.ts";

async function mountHost() {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shared toast", () => {
  it("keeps three independent outcomes and evicts the oldest on saturation", async () => {
    const host = await mountHost();
    const dismissed = vi.fn();

    showToast({ message: "First", variant: "info", onDismiss: dismissed });
    showToast({ message: "Second", variant: "success" });
    showToast({ message: "Third", variant: "warning" });
    showToast({ message: "Fourth", variant: "danger" });
    await host.updateComplete;

    expect(
      [...host.querySelectorAll(".app-toast__message")].map((node) => node.textContent),
    ).toEqual(["Second", "Third", "Fourth"]);
    expect(dismissed).toHaveBeenCalledWith("replaced");
  });

  it("updates a keyed outcome without consuming another stack slot", async () => {
    const host = await mountHost();
    const dismissed = vi.fn();

    showToast({ key: "sync", message: "Syncing", variant: "info", onDismiss: dismissed });
    showToast({ key: "sync", message: "Synced", variant: "success" });
    await host.updateComplete;

    expect(host.querySelectorAll(".app-toast")).toHaveLength(1);
    expect(host.textContent).toContain("Synced");
    expect(dismissed).toHaveBeenCalledWith("replaced");
  });

  it.each([
    ["info", "status", "polite"],
    ["success", "status", "polite"],
    ["warning", "alert", "assertive"],
    ["danger", "alert", "assertive"],
  ] as const)(
    "presents %s with the matching live-region semantics",
    async (variant, role, live) => {
      const host = await mountHost();

      showToast({ message: variant, variant });
      await host.updateComplete;

      const toast = host.querySelector(".app-toast");
      expect(toast?.getAttribute("role")).toBe(role);
      expect(toast?.getAttribute("aria-live")).toBe(live);
      expect(toast?.classList.contains(`app-toast--${variant}`)).toBe(true);
    },
  );

  it("anchors a scoped outcome to the visible owning session pane", async () => {
    const host = await mountHost();
    const pane = document.createElement("openclaw-chat-pane") as HTMLElement & {
      sessionKey?: string;
    };
    pane.className = "chat-pane-cache__pane--visible";
    pane.sessionKey = "agent:main:active";
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 40, 600, 700));
    document.body.append(pane);

    showToast({
      message: "Session outcome",
      variant: "success",
      scope: { kind: "session", sessionKey: pane.sessionKey },
    });
    await host.updateComplete;

    expect(host.querySelector(".app-toast--session")).not.toBeNull();
  });

  it("uses the active modal toast layer", async () => {
    const host = await mountHost();
    const modal = document.createElement("openclaw-modal-dialog");
    modal.open = true;
    document.body.append(modal);
    await modal.updateComplete;
    const moveBefore = vi.spyOn(Element.prototype, "moveBefore");

    showToast({ message: "Above overlay", variant: "warning" });
    await host.updateComplete;

    expect(moveBefore).toHaveBeenCalledWith(host, null);
    expect(moveBefore.mock.contexts).toContain(modal);
  });

  it("dismisses only the acted-on outcome", async () => {
    const host = await mountHost();
    const onAction = vi.fn();
    showToast({ message: "Archived", variant: "success", actionLabel: "Undo", onAction });
    showToast({ message: "Still visible", variant: "info" });
    await host.updateComplete;

    host.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await host.updateComplete;

    expect(onAction).toHaveBeenCalledOnce();
    expect(host.querySelectorAll(".app-toast")).toHaveLength(1);
    expect(host.textContent).toContain("Still visible");
  });

  it("uses each variant's default lifetime", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const lifetimes = [
      ["success", 5_000],
      ["info", 6_000],
      ["warning", 8_000],
      ["danger", 12_000],
    ] as const;

    for (const [variant, duration] of lifetimes) {
      showToast({ key: "lifetime", message: variant, variant });
      await host.updateComplete;
      await vi.advanceTimersByTimeAsync(duration + 150);
      await host.updateComplete;
      expect(host.querySelector(".app-toast")).toBeNull();
    }
  });
});
