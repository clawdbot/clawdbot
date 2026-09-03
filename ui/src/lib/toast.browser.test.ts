import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import "../styles.css";
import { showToast } from "./toast.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

async function useViewport(width: number, height = 800) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, height);
}

async function showArchiveToast() {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  showToast({
    message: "Session archived",
    actionLabel: "Undo",
    onAction: () => undefined,
    durationMs: 60_000,
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
    expect(desktopToast.getBoundingClientRect().width).toBeLessThan(320);
  });
});
