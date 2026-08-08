import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import "../components/sidebar-update-card.ts";
import "../styles.css";
import { renderFloatingUpdateCard } from "./navigation-surface.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
});

async function useDesktopViewport() {
  const { page } = await import("vitest/browser");
  await page.viewport(1280, 800);
}

function overlaps(left: DOMRect, right: DOMRect): boolean {
  return !(
    left.right <= right.left ||
    left.left >= right.right ||
    left.bottom <= right.top ||
    left.top >= right.bottom
  );
}

describe.skipIf(!hasBrowserLayout)("navigation surface browser layout", () => {
  it("keeps the floating refresh card clear of the collapsed chrome cluster", async () => {
    await useDesktopViewport();
    render(
      html`
        <div class="shell shell--nav-collapsed" style="animation: none">
          <div class="shell-chrome-controls">
            <button
              class="shell-chrome-controls__button shell-chrome-controls__nav-toggle"
              type="button"
              aria-label="Expand navigation"
            ></button>
            <button
              class="shell-chrome-controls__button shell-chrome-controls__new-thread"
              type="button"
              aria-label="New thread"
            ></button>
            <button
              class="shell-chrome-controls__button shell-chrome-controls__search"
              type="button"
              aria-label="Search"
            ></button>
          </div>
          <main class="content">
            ${renderFloatingUpdateCard({
              navigationSurfaceHidden: true,
              onboarding: false,
              updateAvailable: null,
              updateRunning: false,
              onUpdate: () => undefined,
              refreshRequired: true,
              onRefresh: () => undefined,
            })}
          </main>
        </div>
      `,
      document.body,
    );

    const refreshCardHost = document.querySelector<
      HTMLElement & { updateComplete: Promise<boolean> }
    >("openclaw-sidebar-update-card");
    await refreshCardHost?.updateComplete;
    const refreshCard = refreshCardHost?.querySelector<HTMLElement>(".sidebar-update-card");
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>(".shell-chrome-controls__button"),
    );
    expect(refreshCard).not.toBeNull();
    expect(buttons).toHaveLength(3);

    const cardBounds = refreshCard!.getBoundingClientRect();
    const buttonBounds = buttons.map((button) => button.getBoundingClientRect());
    expect(cardBounds.width).toBeGreaterThan(0);
    for (const bounds of buttonBounds) {
      expect(bounds.width).toBeGreaterThan(0);
      expect(overlaps(cardBounds, bounds)).toBe(false);
    }
    expect(
      cardBounds.left - Math.max(...buttonBounds.map((bounds) => bounds.right)),
    ).toBeGreaterThanOrEqual(8);
  });
});
