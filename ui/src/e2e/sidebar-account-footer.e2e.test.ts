import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  captureUnionProof,
  createSidebarFooterProofSuite,
  openSidebarFooterProofPage,
  setSidebarProofTheme,
} from "./sidebar-footer-proof.test-support.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function buildInfo(branch: string): ControlUiBuildInfo {
  return {
    version: "2026.8.14",
    commit: COMMIT,
    commitAt: "2026-08-14T12:00:00.000Z",
    builtAt: "2026-08-14T12:00:00.000Z",
    branch,
    dirty: false,
    release: false,
    buildId: `sidebar-account-footer-${branch.replaceAll("/", "-")}`,
  };
}

async function closeIdentityMenu(page: Page, sidebar: Locator) {
  await page.keyboard.press("Escape");
  await expect.poll(() => sidebar.locator("wa-dropdown.sidebar-identity-menu").count()).toBe(0);
}

async function assertSingleAccountTarget(page: Page, sidebar: Locator) {
  const identity = sidebar.locator(".sidebar-identity-card");
  const parts = [
    identity.locator("openclaw-viewer-avatar"),
    identity.locator(".sidebar-identity-card__name"),
  ];
  for (const part of parts) {
    await part.click();
    await expect.poll(() => sidebar.locator("wa-dropdown.sidebar-identity-menu").count()).toBe(1);
    await closeIdentityMenu(page, sidebar);
  }
}

async function assertIdentityMenuContract(sidebar: Locator, menu: Locator) {
  expect(await menu.locator('wa-dropdown-item[value="command:recent-activity"]').count()).toBe(0);
  expect(
    await menu.evaluate((dropdown) => dropdown.closest("openclaw-menu-surface") !== null),
  ).toBe(false);
}

async function runAccountFooterProof(page: Page, sidebar: Locator, branch: "feature" | "main") {
  const footer = sidebar.locator(".sidebar-footer-bar");
  const identity = sidebar.locator(".sidebar-identity-card");
  await assertSingleAccountTarget(page, sidebar);

  for (const theme of ["light", "dark"] as const) {
    await setSidebarProofTheme(page, theme);
    await page.mouse.move(0, 0);
    await captureUnionProof(page, "sidebar-account-footer", `${branch}-${theme}-footer.png`, [
      footer,
    ]);

    await identity.focus();
    await page.keyboard.press("Enter");
    const menu = sidebar.locator("wa-dropdown.sidebar-identity-menu");
    const menuSurface = menu.locator('[part="menu"]');
    await menu.waitFor();
    await assertIdentityMenuContract(sidebar, menu);

    const buildLabel = (
      await menu.getByRole("link", { name: "Control UI build details" }).textContent()
    )?.trim();
    const buildPrefix = branch === "main" ? "git@0123456" : "feat/sidebar-f…@0123456";
    expect(buildLabel?.startsWith(`${buildPrefix} · `)).toBe(true);
    const buildLink = menu.getByRole("link", { name: "Control UI build details" });
    const buildTooltip = sidebar.locator("openclaw-sidebar-build-chip openclaw-tooltip wa-tooltip");
    const buildTooltipCard = sidebar.locator(".sidebar-build-hover-card");
    await page.clock.install();
    await buildLink.hover();
    await page.clock.runFor(300);
    await page.mouse.move(0, 0);
    await page.clock.runFor(300);
    expect(await buildTooltip.getAttribute("open")).toBeNull();
    await buildLink.hover();
    await page.clock.runFor(600);
    await expect.poll(() => buildTooltip.getAttribute("open")).not.toBeNull();
    await page.clock.resume();
    await captureUnionProof(page, "build-chip-hover-intent", `${branch}-${theme}-intent-open.png`, [
      footer,
      menuSurface,
      buildTooltipCard,
    ]);
    await page.mouse.move(0, 0);
    await buildTooltipCard.waitFor({ state: "hidden" });
    await captureUnionProof(page, "sidebar-account-footer", `${branch}-${theme}-menu-default.png`, [
      footer,
      menuSurface,
    ]);

    const settings = menu.locator('wa-dropdown-item[value="command:settings"]');
    const settingsRestBackground = await settings.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await settings.hover();
    await expect.poll(() => settings.evaluate((element) => element.matches(":hover"))).toBe(true);
    await expect
      .poll(() => settings.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(settingsRestBackground);
    await captureUnionProof(
      page,
      "sidebar-account-footer",
      `${branch}-${theme}-menu-settings-hover.png`,
      [footer, menuSurface, settings],
    );

    const usage = menu.locator('wa-dropdown-item[value="command:usage"]');
    await usage.focus();
    await captureUnionProof(
      page,
      "sidebar-account-footer",
      `${branch}-${theme}-menu-usage-focus.png`,
      [footer, menuSurface],
    );

    const themeToggle = menu.locator(".theme-mode-toggle");
    const themeLabel = await themeToggle.getAttribute("aria-label");
    await themeToggle.click();
    await expect.poll(() => themeToggle.getAttribute("aria-label")).not.toBe(themeLabel);

    const help = menu.locator('wa-dropdown-item[value="command:help"]');
    await help.hover();
    const submenu = help.locator('[part="submenu"]');
    await submenu.waitFor({ state: "visible" });
    await captureUnionProof(
      page,
      "sidebar-account-footer",
      `${branch}-${theme}-menu-help-submenu.png`,
      [footer, menuSurface, submenu],
    );

    await page.keyboard.press("Escape");
    await submenu.waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await expect.poll(() => menu.count()).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement instanceof HTMLElement ? document.activeElement.className : "",
        ),
      )
      .toContain("sidebar-identity-card");
  }
}

const suite = createSidebarFooterProofSuite(
  "Control UI sidebar account footer feature build E2E",
  buildInfo("feat/sidebar-footer"),
);

suite.define(() => {
  it("shows visible offline retry and immediate announced-restart states", async () => {
    const opened = await openSidebarFooterProofPage(suite);
    try {
      const { gateway, page, sidebar } = opened;
      const footer = sidebar.locator(".sidebar-footer-bar");
      await setSidebarProofTheme(page, "dark");
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await waitForControlUiGatewayReady(page);

      await gateway.setOnline(false);
      // The offline pill waits out the store's 2s offline-stability debounce.
      const offline = footer.locator("button.sidebar-footer-bar__status");
      await offline.waitFor({ state: "visible", timeout: 10_000 });
      expect(await offline.textContent()).toContain("Offline");
      expect(await offline.textContent()).toContain("Reconnecting…");
      await expect.poll(() => page.title()).toContain("(Disconnected)");
      await captureUnionProof(page, "sidebar-account-footer", "feature-dark-offline.png", [footer]);

      const socketCount = await gateway.getSocketCount();
      await offline.click();
      await expect
        .poll(() => gateway.getSocketCount(), { timeout: 10_000 })
        .toBeGreaterThan(socketCount);

      await gateway.setOnline(true);
      await expect
        .poll(() => footer.locator(".sidebar-footer-bar__status").count(), { timeout: 10_000 })
        .toBe(0);
      await expect.poll(() => page.title()).not.toContain("Disconnected");
      await gateway.emitGatewayEvent("shutdown", {
        reason: "gateway restart",
        restartExpectedMs: 5_000,
      });
      const restarting = footer.locator(".sidebar-footer-bar__status--restarting");
      await restarting.waitFor({ state: "visible" });
      expect(await restarting.textContent()).toBe("Restarting…");
      await captureUnionProof(page, "sidebar-account-footer", "feature-dark-restarting.png", [
        footer,
      ]);
    } finally {
      await suite.closeBrowserContext(opened.context);
    }
  });

  it("keeps the feature account target, identity menu, and visual states coherent", async () => {
    const opened = await openSidebarFooterProofPage(suite);
    try {
      await runAccountFooterProof(opened.page, opened.sidebar, "feature");
    } finally {
      await suite.closeBrowserContext(opened.context);
    }
  });

  it("navigates from the build link without opening its hovercard", async () => {
    const opened = await openSidebarFooterProofPage(suite);
    try {
      const { page, sidebar } = opened;
      await sidebar.locator(".sidebar-identity-card").click();
      const buildLink = sidebar.getByRole("link", {
        name: "Control UI build details",
        exact: true,
      });
      const tooltip = sidebar.locator("openclaw-sidebar-build-chip openclaw-tooltip wa-tooltip");
      await tooltip.evaluate((element) => {
        document.documentElement.dataset.buildTooltipOpenedByClick = "false";
        element.addEventListener(
          "wa-show",
          () => {
            document.documentElement.dataset.buildTooltipOpenedByClick = "true";
          },
          { once: true },
        );
      });

      await buildLink.click();

      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/about");
      expect(await page.locator("html").getAttribute("data-build-tooltip-opened-by-click")).toBe(
        "false",
      );
    } finally {
      await suite.closeBrowserContext(opened.context);
    }
  });
});
