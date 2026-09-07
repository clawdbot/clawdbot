import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import "../styles.css";
import { showToast, type ToastOptions } from "./toast.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

async function useViewport(width: number, height = 800) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, height);
}

async function showArchiveToast(options: Partial<ToastOptions> = {}) {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  showToast({
    message: "Session archived",
    actionLabel: "Undo",
    onAction: () => undefined,
    durationMs: 60_000,
    ...options,
  });
  await host.updateComplete;
  return host;
}

describe.skipIf(!hasBrowserLayout)("toast browser layout", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps mobile actions trailing while the desktop toast stays compact", async () => {
    await useViewport(390, 844);
    const mobileHost = await showArchiveToast();
    const mobileToast = mobileHost.querySelector<HTMLElement>(".app-toast")!;
    const mobileAction = mobileHost.querySelector<HTMLElement>(".app-toast__action")!;
    const mobileDismiss = mobileHost.querySelector<HTMLElement>(".app-toast__dismiss")!;
    const mobileToastBounds = mobileToast.getBoundingClientRect();

    expect(mobileToastBounds.top).toBeCloseTo(20, 0);
    expect(mobileToastBounds.left).toBeCloseTo(12, 0);
    expect(mobileToastBounds.right).toBeCloseTo(378, 0);
    expect(mobileAction.getBoundingClientRect().left).toBeGreaterThan(
      mobileToastBounds.left + mobileToastBounds.width * 0.6,
    );
    expect(mobileDismiss.getBoundingClientRect().right).toBeLessThanOrEqual(
      mobileToastBounds.right - 11,
    );

    mobileHost.remove();
    await useViewport(1280, 800);
    const desktopHost = await showArchiveToast();
    const desktopToast = desktopHost.querySelector<HTMLElement>(".app-toast")!;
    expect(desktopToast.getBoundingClientRect().top).toBeCloseTo(20, 0);
    expect(desktopToast.getBoundingClientRect().width).toBeLessThan(320);
  });
  it("keeps settings feedback at the safe lower edge without moving anchored notices", async () => {
    for (const width of [1280, 390]) {
      await useViewport(width, 844);
      const host = await showArchiveToast({ placement: "bottom" });
      host.style.setProperty("--safe-area-bottom", "24px");
      const toast = host.querySelector<HTMLElement>(".app-toast")!;
      await Promise.all(toast.getAnimations().map((animation) => animation.finished));
      const bounds = toast.getBoundingClientRect();
      expect(bounds.bottom).toBeCloseTo(800, 0);
      expect(bounds.right).toBeCloseTo(width - (width === 390 ? 12 : 20), 0);
      expect(host.querySelector(".app-toast__dismiss")!.getBoundingClientRect().height).toBe(44);
      host.remove();
    }

    const anchor = document.createElement("div");
    anchor.style.cssText = "position: fixed; top: 100px; left: 20px; width: 350px; height: 100px";
    document.body.append(anchor);
    const host = await showArchiveToast({ anchor, placement: "bottom" });
    const toast = host.querySelector<HTMLElement>(".app-toast")!;
    expect(toast.classList.contains("app-toast--bottom")).toBe(false);
    expect(getComputedStyle(toast).top).toBe("100px");
  });
});
