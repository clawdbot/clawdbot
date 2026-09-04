// Measures the lobster dismiss menu's internal overflow in the real sidebar
// footer context, with classic (space-taking) scrollbars forced on so the
// Linux run matches what a macOS "Always show scrollbars" operator sees.
import path from "node:path";
import type { BrowserContextOptions, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI lobster dismiss menu overflow",
  startServerBeforeBrowser: true,
  browserLaunchOptions: {
    args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbar"],
  },
  unavailableMessage: (executablePath) => `Playwright Chromium cannot start at ${executablePath}`,
});

type BrowserLobsterPet = HTMLElement & {
  mode: "idle" | "busy" | "offline";
  runOutcome: "ok" | "error" | "aborted";
  seed: number;
  visitsEnabled: boolean;
  updateComplete: Promise<unknown>;
};

let artifactDir: string;

/** Shared setup for a fresh page: mock gateway, load, and park the clock so
 *  the pet's own timers don't fire mid-assertion. Reused across the default
 *  1280x900 context and the per-test contexts below (compact/edge/theme). */
async function loadControlUiPage(currentPage: Page) {
  await currentPage.clock.install({ time: new Date("2026-07-09T12:00:00") });
  await installMockGateway(currentPage);
  await currentPage.goto(suite.server.baseUrl);
  await currentPage.waitForFunction(() => Boolean(customElements.get("openclaw-lobster-pet")));
  await currentPage.locator("openclaw-app-sidebar").waitFor();
  await currentPage.locator(".community-invite-card").waitFor();
  const loadedAt = await currentPage.evaluate(() => Date.now());
  await currentPage.clock.pauseAt(loadedAt + 1_000);
}

async function withDismissMenuPage(
  options: BrowserContextOptions,
  run: (page: Page) => Promise<void>,
) {
  await suite.withPage({ viewport: { width: 1280, height: 900 }, ...options }, async ({ page }) => {
    await loadControlUiPage(page);
    await run(page);
  });
}

/** Configures the pet already mounted on the real sidebar ledge so production
 *  positioning and hit testing remain part of the assertion. */
async function configureRealSidebarPet(currentPage: Page, seed: number) {
  await currentPage.evaluate(async (petSeed) => {
    const pet = document.querySelector("openclaw-lobster-pet") as BrowserLobsterPet | null;
    if (!pet) {
      throw new Error("sidebar lobster pet not found");
    }
    pet.seed = petSeed;
    pet.mode = "offline";
    pet.runOutcome = "ok";
    pet.visitsEnabled = true;
    await pet.updateComplete;
  }, seed);
}

/** Reads the geometry that decides whether the popup scrolls or overflows
 *  the viewport. */
async function measureDismissMenu(currentPage: Page) {
  return await currentPage.evaluate(() => {
    const dropdown = document.querySelector("wa-dropdown.lobster-pet-dismiss-menu");
    if (!dropdown?.shadowRoot) {
      throw new Error("dismiss menu dropdown not found");
    }
    const menu = dropdown.shadowRoot.querySelector<HTMLElement>("#menu");
    const popup = dropdown.shadowRoot.querySelector("wa-popup");
    const popupBox = popup?.shadowRoot?.querySelector<HTMLElement>(".popup") ?? null;
    if (!menu) {
      throw new Error("dismiss menu #menu part not found");
    }
    const menuStyle = getComputedStyle(menu);
    const menuRect = menu.getBoundingClientRect();
    const host = document.querySelector<HTMLElement>("openclaw-lobster-pet");
    const hostStyle = host ? getComputedStyle(host) : null;
    const hostRect = host?.getBoundingClientRect() ?? null;
    const invite = document.querySelector<HTMLElement>(".sidebar-shell__invite");
    const inviteCard = invite?.querySelector(".community-invite-card") ?? null;
    const inviteRect = invite?.getBoundingClientRect() ?? null;
    const footerRect = document
      .querySelector<HTMLElement>(".sidebar-shell__footer")
      ?.getBoundingClientRect();
    const firstItem = dropdown.querySelector("wa-dropdown-item");
    const firstItemLabel = firstItem?.shadowRoot?.querySelector<HTMLElement>("#label") ?? null;
    return {
      // The item's rendered label size comes from the app's own
      // .session-menu__item light-DOM class (ui/src/styles/layout.css),
      // which sets an explicit font-size from --control-ui-text-scale —
      // not from wa-dropdown-item's shadow styles. Captured here so tests
      // can prove the text-scale token actually reached the label instead
      // of trusting an unrelated Web Awesome token override.
      firstItemFontSizePx: firstItem
        ? Number.parseFloat(getComputedStyle(firstItem).fontSize)
        : null,
      // The label's own unclamped box height: .session-menu__item's
      // min-height design floor (28px, ui/src/styles/base.css) keeps a
      // single short line and a single modestly-scaled line at the same
      // 28px row height, so the row height alone can't tell a real
      // font-size increase from a no-op. The label's own height isn't
      // floor-clamped and grows with font-size regardless.
      firstItemLabelHeightPx: firstItemLabel?.getBoundingClientRect().height ?? null,
      scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight,
      offsetHeight: menu.offsetHeight,
      overflowPx: menu.scrollHeight - menu.clientHeight,
      scrollbarWidthPx: menu.offsetWidth - menu.clientWidth,
      computedMaxHeight: menuStyle.maxHeight,
      computedOverflowY: menuStyle.overflowY,
      autoSizeAvailableHeight: popup
        ? getComputedStyle(popup).getPropertyValue("--auto-size-available-height").trim()
        : "(no wa-popup)",
      resolvedPlacement: popup?.getAttribute("data-current-placement") ?? "(none)",
      anchorTop: dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.style.top ?? "(none)",
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      menuLeft: menuRect.left,
      menuRight: menuRect.right,
      menuTop: menuRect.top,
      menuBottom: menuRect.bottom,
      popupIsTopLayer: popupBox ? popupBox.matches(":popover-open") : null,
      hasOuterMenuSurface: dropdown.closest("openclaw-menu-surface") !== null,
      hostHeight: hostStyle?.height ?? null,
      hostOverflow: hostStyle?.overflow ?? null,
      hostParentClass: host?.parentElement?.className ?? null,
      hostBottom: hostRect?.bottom ?? null,
      inviteCardPresent: inviteCard !== null,
      inviteHeight: inviteRect?.height ?? null,
      inviteTop: inviteRect?.top ?? null,
      footerTop: footerRect?.top ?? null,
      itemHeights: [...dropdown.querySelectorAll("wa-dropdown-item")].map(
        (item) => (item as HTMLElement).offsetHeight,
      ),
    };
  });
}

// The largest text-scale stop a user can actually pick from Appearance
// settings (TEXT_SCALE_STOPS in ui/src/app/settings.ts), applied the same
// way ui/src/app/bootstrap.ts:79 applies it at runtime.
const ENLARGED_TEXT_SCALE = "1.4";

/** Rewrites the two dismissal items to long, wide labels and applies the
 *  real "enlarged type scale" setting. The dismiss menu's items render
 *  through the app's own `.session-menu__item` light-DOM class
 *  (ui/src/styles/layout.css), which sets an explicit
 *  `font-size: calc(13px * var(--control-ui-text-scale))` — that wins over
 *  wa-dropdown-item's inherited shadow-DOM styles, which never set
 *  font-size themselves (confirmed in the installed Web Awesome 3.10.0
 *  dropdown-item styles). So --control-ui-text-scale, not any
 *  --wa-font-size-* token, is the lever that actually changes what the
 *  operator sees. Stands in for a locale whose strings and type-scale are
 *  both larger than the pinned English default, without depending on the
 *  app's network-loaded locale chunks. */
async function useOversizedDismissLabels(currentPage: Page) {
  await currentPage.evaluate((scale) => {
    document.documentElement.style.setProperty("--control-ui-text-scale", scale);
    const labels = [
      "Postpone this lobster visit notice until the next scheduled maintenance window",
      "Permanently suppress every future lobster visit notice across all workspaces",
    ];
    document
      .querySelectorAll("wa-dropdown.lobster-pet-dismiss-menu wa-dropdown-item")
      .forEach((item, index) => {
        item.textContent = labels[index] ?? item.textContent;
      });
  }, ENLARGED_TEXT_SCALE);
}

suite.define(() => {
  beforeEach(() => {
    artifactDir = createControlUiE2eArtifactDir("lobster-dismiss-menu-overflow");
  });
  it("keeps the lobster clickable and its dismissal menu within the viewport on both sidebar ledges", () =>
    withDismissMenuPage({}, async (page) => {
      await configureRealSidebarPet(page, 42);
      const sprite = page.locator(".lobster-pet");
      await sprite.waitFor();

      await sprite.click({ button: "right" });
      await page.locator("wa-dropdown.lobster-pet-dismiss-menu").waitFor();
      await page.getByText("Dismiss and don't show again", { exact: true }).waitFor();

      const inviteMeasurement = await measureDismissMenu(page);
      await page.screenshot({ path: path.join(artifactDir, "real-sidebar-invite-ledge.png") });

      // Asserting on the whole measurement so a regression prints the anchor
      // position and resolved max-height that explain it.
      expect(inviteMeasurement).toMatchObject({
        overflowPx: 0,
        popupIsTopLayer: true,
        hasOuterMenuSurface: false,
        hostParentClass: "sidebar-shell__invite",
        inviteCardPresent: true,
      });
      expect(inviteMeasurement.menuTop).toBeGreaterThanOrEqual(0);
      expect(inviteMeasurement.menuBottom).toBeLessThanOrEqual(inviteMeasurement.viewportHeight);
      expect(inviteMeasurement.inviteHeight).toBeGreaterThan(0);
      expect(inviteMeasurement.hostBottom).not.toBeNull();
      expect(inviteMeasurement.inviteTop).not.toBeNull();
      expect(
        Math.abs((inviteMeasurement.hostBottom ?? 0) - (inviteMeasurement.inviteTop ?? 0) - 3),
      ).toBeLessThan(0.5);

      await page.keyboard.press("Escape");
      const invite = page.locator(".community-invite-card");
      await page.getByRole("button", { name: "Dismiss and don't show again" }).click();
      await invite.waitFor({ state: "detached" });

      await sprite.click({ button: "right" });
      await page.locator("wa-dropdown.lobster-pet-dismiss-menu").waitFor();
      const footerMeasurement = await measureDismissMenu(page);
      await page.screenshot({ path: path.join(artifactDir, "real-sidebar-footer-ledge.png") });

      expect(footerMeasurement).toMatchObject({
        overflowPx: 0,
        popupIsTopLayer: true,
        hasOuterMenuSurface: false,
        hostParentClass: "sidebar-shell__invite",
        inviteCardPresent: false,
        inviteHeight: 0,
      });
      expect(footerMeasurement.menuTop).toBeGreaterThanOrEqual(0);
      expect(footerMeasurement.menuBottom).toBeLessThanOrEqual(footerMeasurement.viewportHeight);
      expect(footerMeasurement.hostBottom).not.toBeNull();
      expect(footerMeasurement.footerTop).not.toBeNull();
      expect(
        Math.abs((footerMeasurement.hostBottom ?? 0) - (footerMeasurement.footerTop ?? 0) - 3),
      ).toBeLessThan(0.5);
    }));

  // Control: the identical menu content, anchored away from the bottom edge.
  // Isolates the anchor position as the cause rather than the menu's content.
  it("has room for the same two items when the ledge is not at the viewport edge", () =>
    withDismissMenuPage({}, async (page) => {
      await configureRealSidebarPet(page, 42);
      await page.evaluate(() => {
        const ledge = document.querySelector<HTMLElement>(".sidebar-shell__invite");
        if (ledge) {
          ledge.style.transform = "translateY(-400px)";
        }
      });
      const sprite = page.locator(".lobster-pet");
      await sprite.waitFor();

      await sprite.click({ button: "right" });
      await page.locator("wa-dropdown.lobster-pet-dismiss-menu").waitFor();

      const measurement = await measureDismissMenu(page);
      await page.screenshot({ path: path.join(artifactDir, "control-away-from-edge.png") });

      expect(measurement).toMatchObject({ overflowPx: 0 });
    }));

  it("keeps both items fully visible under long labels and an enlarged type scale", () =>
    withDismissMenuPage({}, async (page) => {
      await configureRealSidebarPet(page, 42);
      const sprite = page.locator(".lobster-pet");
      await sprite.waitFor();

      await sprite.click({ button: "right" });
      await page.locator("wa-dropdown.lobster-pet-dismiss-menu").waitFor();
      await page.getByText("Dismiss and don't show again", { exact: true }).waitFor();
      const baseline = await measureDismissMenu(page);

      await useOversizedDismissLabels(page);

      // Web Awesome's popup tracks anchor/floating element size with a
      // ResizeObserver, so the label swap above reflows the popup
      // asynchronously; poll for settlement instead of asserting immediately
      // after the DOM write.
      await expect
        .poll(async () => (await measureDismissMenu(page)).overflowPx, {
          message: "menu did not settle",
        })
        .toBe(0);
      const measurement = await measureDismissMenu(page);
      await page.screenshot({ path: path.join(artifactDir, "long-labels-enlarged-scale.png") });

      // Guards against --control-ui-text-scale/the label injection silently
      // no-opping: the rendered label font-size and its unclamped box height
      // must both actually grow, or this test would pass without exercising
      // the real type-scale token (the row's own height can't tell a real
      // increase from a no-op — see firstItemLabelHeightPx above).
      expect(measurement.firstItemFontSizePx).not.toBeNull();
      expect(measurement.firstItemFontSizePx).toBeGreaterThan(baseline.firstItemFontSizePx ?? 0);
      expect(measurement.firstItemLabelHeightPx).not.toBeNull();
      expect(measurement.firstItemLabelHeightPx).toBeGreaterThan(
        baseline.firstItemLabelHeightPx ?? 0,
      );
    }));

  it("keeps the popup within the viewport at a compact sidebar height", async () => {
    await withDismissMenuPage({ viewport: { width: 1280, height: 420 } }, async (shortPage) => {
      await configureRealSidebarPet(shortPage, 42);
      const sprite = shortPage.locator(".lobster-pet");
      await sprite.waitFor();

      await sprite.click({ button: "right" });
      await shortPage.locator("wa-dropdown.lobster-pet-dismiss-menu").waitFor();
      await shortPage.getByText("Dismiss and don't show again", { exact: true }).waitFor();

      const measurement = await measureDismissMenu(shortPage);
      await shortPage.screenshot({ path: path.join(artifactDir, "compact-viewport-height.png") });

      // At this height even the "top" placement may run short, so Web
      // Awesome's own vertical auto-size may still shrink the menu in place
      // (an accepted last-resort fallback). What must hold regardless is
      // that the popup itself never renders outside the viewport.
      expect(measurement.menuTop).toBeGreaterThanOrEqual(0);
      expect(measurement.menuBottom).toBeLessThanOrEqual(measurement.viewportHeight);
    });
  });

  for (const edge of ["left", "right"] as const) {
    it(`keeps the popup within the viewport when the sidebar ledge sits near the ${edge} edge`, () =>
      withDismissMenuPage({}, async (page) => {
        await configureRealSidebarPet(page, 42);
        // Slide the ledge so the sprite's click point lands 12px from the
        // named edge, computed from its live layout rather than a guessed
        // translate distance, so the sprite stays actionable for Playwright.
        await page.evaluate((direction) => {
          const ledge = document.querySelector<HTMLElement>(".sidebar-shell__invite");
          const sprite = document.querySelector<HTMLElement>(".lobster-pet");
          if (!ledge || !sprite) {
            throw new Error("sidebar ledge or sprite not found");
          }
          const rect = sprite.getBoundingClientRect();
          const targetCenterX = direction === "left" ? 12 : window.innerWidth - 12;
          const dx = targetCenterX - (rect.left + rect.width / 2);
          ledge.style.transform = `translateX(${dx}px)`;
        }, edge);
        const sprite = page.locator(".lobster-pet");
        await sprite.waitFor();

        await sprite.click({ button: "right" });
        await page.locator("wa-dropdown.lobster-pet-dismiss-menu").waitFor();

        const measurement = await measureDismissMenu(page);
        await page.screenshot({ path: path.join(artifactDir, `edge-${edge}.png`) });

        expect(measurement.menuLeft).toBeGreaterThanOrEqual(0);
        expect(measurement.menuRight).toBeLessThanOrEqual(measurement.viewportWidth);
      }));
  }

  it("does not scroll its two dismissal items under a dark color scheme", async () => {
    await withDismissMenuPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
      async (darkPage) => {
        await configureRealSidebarPet(darkPage, 42);
        const sprite = darkPage.locator(".lobster-pet");
        await sprite.waitFor();

        await sprite.click({ button: "right" });
        await darkPage.locator("wa-dropdown.lobster-pet-dismiss-menu").waitFor();
        await darkPage.getByText("Dismiss and don't show again", { exact: true }).waitFor();

        const measurement = await measureDismissMenu(darkPage);
        await darkPage.screenshot({ path: path.join(artifactDir, "dark-theme.png") });

        expect(measurement).toMatchObject({ overflowPx: 0 });
      },
    );
  });
});
