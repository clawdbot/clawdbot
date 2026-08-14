import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiSettingsTakeover } from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import {
  captureSidebarUiUnionProof,
  createSidebarCustomizationSuite,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite(
  "Control UI sidebar transient surfaces mocked Gateway E2E",
);

const visualVariants = [
  { colorScheme: "light", resolvedTheme: "light", theme: "claw" },
  { colorScheme: "dark", resolvedTheme: "dark", theme: "claw" },
  { colorScheme: "light", resolvedTheme: "openknot-light", theme: "knot" },
  { colorScheme: "dark", resolvedTheme: "openknot", theme: "knot" },
  { colorScheme: "light", resolvedTheme: "dash-light", theme: "dash" },
  { colorScheme: "dark", resolvedTheme: "dash", theme: "dash" },
] as const;

function configResponse(theme: "claw" | "knot" | "dash", colorScheme: "light" | "dark") {
  const config = { ui: { prefs: { locale: "en", theme, themeMode: colorScheme } } };
  const hash = `transient-surfaces-${theme}-${colorScheme}`;
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

async function surfaceMetrics(surface: Locator) {
  return surface.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      padding: style.padding,
      width: box.width,
    };
  });
}

async function waitForAnimations(surface: Locator) {
  await surface.evaluate(async (element) => {
    const animations = element.getAnimations({ subtree: true });
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function computedShadowFromToken(root: Locator, token: "--overlay-shadow" | "--shadow-md") {
  return root.evaluate((_, tokenName) => {
    const probe = document.createElement("div");
    probe.style.boxShadow = `var(${tokenName})`;
    document.body.append(probe);
    const shadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    return shadow;
  }, token);
}

suite.define(() => {
  it.each(visualVariants)(
    "keeps sidebar transient surfaces on one contract in $theme $colorScheme",
    async ({ colorScheme, resolvedTheme, theme }) => {
      const context = await suite.newBrowserContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      });
      const page = await context.newPage();
      const sessionKey = "agent:main:release-notes";
      await installMockGateway(page, {
        featureMethods: [
          "sessions.create",
          "sessions.delete",
          "sessions.groups.put",
          "sessions.patch",
        ],
        methodResponses: {
          "config.get": configResponse(theme, colorScheme),
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:main", "Main", Date.parse("2026-08-14T16:00:00.000Z")),
            {
              ...sessionRow(sessionKey, "Release notes", Date.parse("2026-08-14T15:59:00.000Z"), {
                category: "Research",
              }),
              modelSelectionLocked: true,
            },
          ]),
        },
        sessionGroups: ["Research"],
        sessionKey,
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const sidebar = page.locator("openclaw-app-sidebar");
        const sidebarSurface = sidebar.locator(".sidebar-shell");
        const session = sidebar.locator(`[data-session-key="${sessionKey}"]`);
        await session.waitFor();
        await expect
          .poll(() => page.locator("html").getAttribute("data-theme-mode"))
          .toBe(colorScheme);
        const root = page.locator("html");
        await expect.poll(() => root.getAttribute("data-theme")).toBe(resolvedTheme);

        const newSessionButton = sidebar.locator(".sidebar-brand__new-thread");
        await newSessionButton.hover();
        const tooltip = newSessionButton.locator("xpath=..");
        const tooltipSurface = tooltip.locator("wa-tooltip[open] .body");
        await tooltipSurface.waitFor({ state: "visible" });
        await waitForAnimations(tooltipSurface);
        const tooltipContract = await surfaceMetrics(tooltipSurface);
        const overlayShadow = await computedShadowFromToken(root, "--overlay-shadow");
        const expectedShadow = await computedShadowFromToken(
          root,
          theme === "claw" ? "--overlay-shadow" : "--shadow-md",
        );
        expect(overlayShadow).toBe(expectedShadow);
        expect(tooltipContract.boxShadow).toBe(overlayShadow);
        expect(
          await tooltip
            .locator("wa-tooltip")
            .evaluate((element) =>
              getComputedStyle(element).getPropertyValue("--wa-tooltip-arrow-size"),
            ),
        ).toBe("0px");
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, tooltipSurface],
          `transient-${theme}-${colorScheme}-tooltip.png`,
          { animations: "allow" },
        );

        await page.mouse.move(700, 700);
        await session.hover();
        await session.locator("[data-session-menu]").click();
        const sessionMenu = sidebar.locator("wa-dropdown.session-menu");
        const sessionMenuSurface = sessionMenu.locator('[part="menu"]');
        await sessionMenuSurface.waitFor();
        await expect
          .poll(async () => (await sessionMenuSurface.boundingBox())?.width ?? 0)
          .toBeGreaterThanOrEqual(224);
        await waitForAnimations(sessionMenuSurface);
        const menuContract = await surfaceMetrics(sessionMenuSurface);
        expect(menuContract).toMatchObject({
          borderColor: tooltipContract.borderColor,
          borderRadius: "12px",
          boxShadow: tooltipContract.boxShadow,
          padding: "6px",
        });
        expect(menuContract.width).toBeGreaterThanOrEqual(224);
        expect(menuContract.width).toBeLessThanOrEqual(232);

        const pinItem = sessionMenu.getByRole("menuitem", { name: /Pin session/ });
        const pinGeometry = await pinItem.evaluate((element) => {
          const icon = element.querySelector(".session-menu__icon")!.getBoundingClientRect();
          const label = element.querySelector(".session-menu__text")!.getBoundingClientRect();
          const row = element.getBoundingClientRect();
          return {
            gap: label.left - icon.right,
            icon: [icon.width, icon.height],
            rowHeight: row.height,
          };
        });
        expect(pinGeometry.icon).toEqual([16, 16]);
        expect(pinGeometry.gap).toBeGreaterThanOrEqual(9);
        expect(pinGeometry.gap).toBeLessThanOrEqual(11);
        expect(pinGeometry.rowHeight).toBe(36);

        const shortcut = pinItem.locator(".session-menu__shortcut");
        const shortcutContract = await shortcut.evaluate((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            borderWidth: style.borderWidth,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            height: box.height,
            paddingInline: style.paddingInline,
            width: box.width,
          };
        });
        expect(shortcutContract).toMatchObject({
          borderWidth: "0px",
          fontSize: "11px",
          fontWeight: "500",
          height: 18,
          paddingInline: "7px",
        });
        expect(shortcutContract.width).toBeGreaterThanOrEqual(24);

        const disabledItem = sessionMenu.getByRole("menuitem", { name: /^Fork/ });
        expect(await disabledItem.isDisabled()).toBe(true);
        expect(await disabledItem.getAttribute("aria-disabled")).toBe("true");
        expect(
          await disabledItem.evaluate((element) => {
            const style = getComputedStyle(element);
            return { cursor: style.cursor, opacity: style.opacity };
          }),
        ).toEqual({ cursor: "default", opacity: "0.42" });

        const deleteItem = sessionMenu.getByRole("menuitem", { name: /Delete/ });
        await expect
          .poll(() => deleteItem.locator(".session-menu__text").textContent())
          .toBe("Delete…");
        expect(await deleteItem.locator(".session-menu__shortcut").textContent()).toBe("D");
        const deleteRest = await deleteItem.evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor,
          icon: getComputedStyle(element.querySelector(".session-menu__icon")!).color,
          text: getComputedStyle(element).color,
        }));
        expect(deleteRest.background).toBe("rgba(0, 0, 0, 0)");
        expect(deleteRest.icon).toBe(deleteRest.text);
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, sessionMenuSurface],
          `transient-${theme}-${colorScheme}-session-default-disabled.png`,
          { animations: "allow" },
        );

        await pinItem.hover();
        await expect
          .poll(() => pinItem.evaluate((element) => getComputedStyle(element).backgroundColor))
          .not.toBe("rgba(0, 0, 0, 0)");
        await waitForAnimations(pinItem);
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, sessionMenuSurface],
          `transient-${theme}-${colorScheme}-session-hover.png`,
          { animations: "allow" },
        );
        await deleteItem.hover();
        await expect
          .poll(() => deleteItem.evaluate((element) => getComputedStyle(element).backgroundColor))
          .not.toBe(deleteRest.background);
        await waitForAnimations(deleteItem);
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, sessionMenuSurface],
          `transient-${theme}-${colorScheme}-session-delete-hover.png`,
          { animations: "allow" },
        );
        await page.mouse.move(700, 700);
        await page.keyboard.press("Home");
        const focusedItem = sessionMenu.locator("wa-dropdown-item:focus");
        await expect.poll(() => focusedItem.count()).toBe(1);
        expect(await focusedItem.evaluate((element) => element.matches(":focus-visible"))).toBe(
          true,
        );
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, sessionMenuSurface],
          `transient-${theme}-${colorScheme}-session-focus.png`,
          { animations: "allow" },
        );
        await page.keyboard.press("Escape");

        await sidebar.locator(".sidebar-nav__head-action").click();
        const moreMenu = sidebar.locator("wa-dropdown.sidebar-more-menu");
        const moreMenuSurface = moreMenu.locator('[part="menu"]');
        await moreMenuSurface.waitFor();
        await waitForAnimations(moreMenuSurface);
        expect(await surfaceMetrics(moreMenuSurface)).toMatchObject({
          borderColor: tooltipContract.borderColor,
          borderRadius: "12px",
          boxShadow: tooltipContract.boxShadow,
          padding: "6px",
        });
        expect(await moreMenu.locator(".session-menu__shortcut").count()).toBe(0);
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, moreMenuSurface],
          `transient-${theme}-${colorScheme}-navigation-menu.png`,
          { animations: "allow" },
        );
        await page.keyboard.press("Escape");

        await sidebar.locator(".sidebar-identity-card").click();
        const identityMenu = sidebar.locator("wa-dropdown.sidebar-identity-menu");
        const identitySurface = identityMenu.locator('[part="menu"]');
        await identitySurface.waitFor();
        await waitForAnimations(identitySurface);
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, identitySurface],
          `transient-${theme}-${colorScheme}-identity-menu.png`,
          { animations: "allow" },
        );
        const buildChip = identityMenu.locator(".sidebar-footer-build");
        await buildChip.hover();
        const richTooltip = identityMenu
          .locator("openclaw-tooltip.sidebar-hover-tooltip")
          .locator("wa-tooltip[open] .body");
        await richTooltip.waitFor({ state: "visible" });
        await waitForAnimations(richTooltip);
        expect(await surfaceMetrics(richTooltip)).toMatchObject({
          borderColor: tooltipContract.borderColor,
          boxShadow: tooltipContract.boxShadow,
        });
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, identitySurface, richTooltip],
          `transient-${theme}-${colorScheme}-rich-popover.png`,
          { animations: "allow" },
        );

        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await waitForControlUiSettingsTakeover(page);
        const languageRow = page.locator("#settings-language .settings-row");
        const languageSelect = languageRow.locator("wa-select");
        await languageSelect.click();
        const listbox = languageSelect.locator('[part="listbox"]');
        await listbox.waitFor({ state: "visible" });
        await waitForAnimations(listbox);
        expect(await surfaceMetrics(listbox)).toMatchObject({
          borderColor: tooltipContract.borderColor,
          boxShadow: tooltipContract.boxShadow,
        });
        await captureSidebarUiUnionProof(
          page,
          [languageRow, listbox],
          `transient-${theme}-${colorScheme}-select-listbox.png`,
          { animations: "allow" },
        );
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
