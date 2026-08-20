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

async function useMobileViewport() {
  const { page } = await import("vitest/browser");
  await page.viewport(390, 844);
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
  it("folds an actionable update into the compact mobile chat header", async () => {
    await useMobileViewport();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`
        <div
          class="shell shell--chat shell--mobile-nav shell--merged-chat-chrome"
          style="display: block; --shell-topbar-height: 0px"
        >
          <main class="content content--chat">
            ${renderFloatingUpdateCard({
              navigationSurfaceHidden: true,
              onboarding: false,
              updateAvailable: null,
              updateBusy: false,
              onUpdate: () => undefined,
              refreshRequired: true,
              onRefresh: () => undefined,
            })}
            <div class="chat-pane__header">
              <button
                class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle"
                type="button"
                aria-label="Navigation"
              ></button>
              <span class="chat-pane__session-title">Compact mobile header</span>
              <div class="chat-pane__actions">
                <button
                  class="btn btn--ghost btn--icon chat-icon-btn chat-header-session-menu__trigger"
                  type="button"
                  aria-label="Actions"
                ></button>
              </div>
            </div>
          </main>
        </div>
      `,
      container,
    );

    const cardHost = document.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-sidebar-update-card",
    );
    await cardHost?.updateComplete;
    const header = document.querySelector<HTMLElement>(".chat-pane__header");
    const action = document.querySelector<HTMLElement>(".sidebar-update-card__action");
    const menu = document.querySelector<HTMLElement>(".chat-header-session-menu__trigger");
    expect(header).not.toBeNull();
    expect(action).not.toBeNull();
    expect(menu).not.toBeNull();

    const headerBounds = header!.getBoundingClientRect();
    const actionBounds = action!.getBoundingClientRect();
    const menuBounds = menu!.getBoundingClientRect();
    expect(actionBounds.width).toBe(32);
    expect(actionBounds.top).toBeGreaterThanOrEqual(headerBounds.top);
    expect(actionBounds.bottom).toBeLessThanOrEqual(headerBounds.bottom);
    expect(overlaps(actionBounds, menuBounds)).toBe(false);
  });

  it("keeps the floating refresh card clear of the collapsed chrome cluster", async () => {
    await useDesktopViewport();
    const container = document.createElement("div");
    document.body.append(container);
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
              aria-label="New session"
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
              updateBusy: false,
              onUpdate: () => undefined,
              refreshRequired: true,
              onRefresh: () => undefined,
            })}
          </main>
        </div>
      `,
      container,
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
