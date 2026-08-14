import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { sessionRow, sessionsListResponse } from "./session-management.test-support.ts";
import {
  captureSidebarUiUnionProof,
  createSidebarCustomizationSuite,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar iconography mocked Gateway E2E");

const visualVariants = [
  { colorScheme: "light" as const, deviceScaleFactor: 1 },
  { colorScheme: "light" as const, deviceScaleFactor: 2 },
  { colorScheme: "dark" as const, deviceScaleFactor: 1 },
  { colorScheme: "dark" as const, deviceScaleFactor: 2 },
];

async function expectLucideContract(root: Locator, minimumIconCount = 1) {
  const metrics = await root.locator("svg[data-lucide-icon]").evaluateAll((icons) =>
    icons.map((icon) => {
      const style = getComputedStyle(icon);
      return {
        height: Number.parseFloat(style.height),
        strokeWidth: Number.parseFloat(style.strokeWidth),
        width: Number.parseFloat(style.width),
      };
    }),
  );
  expect(metrics.length).toBeGreaterThanOrEqual(minimumIconCount);
  expect(metrics.every((icon) => icon.height <= 16 && icon.width <= 16)).toBe(true);
  expect(metrics.every((icon) => icon.strokeWidth === 1.5)).toBe(true);
}

suite.define(() => {
  it.each(visualVariants)(
    "keeps sidebar icons on the shared optical scale in $colorScheme at $deviceScaleFactor x",
    async ({ colorScheme, deviceScaleFactor }) => {
      const context = await suite.newBrowserContext({
        colorScheme,
        deviceScaleFactor,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      });
      const page = await context.newPage();
      const incognitoKey = "agent:main:private-notes";
      await installMockGateway(page, {
        methodResponses: {
          "cron.list": {
            jobs: [],
            total: 0,
            offset: 0,
            limit: 50,
            hasMore: false,
            nextOffset: null,
          },
          "models.authStatus": {
            ts: Date.now(),
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                status: "missing",
                profiles: [],
              },
            ],
          },
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:main", "Main", Date.parse("2026-08-14T16:00:00.000Z"), {
              pinned: true,
              unread: true,
            }),
            {
              ...sessionRow(incognitoKey, "Private", Date.parse("2026-08-14T15:59:00.000Z"), {
                category: "Research",
              }),
              incognito: true,
            },
          ]),
        },
        sessionGroups: ["Research"],
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebar = page.locator("openclaw-app-sidebar");
        const sidebarSurface = sidebar.locator(".sidebar-shell");
        const incognitoRow = sidebar.locator(`[data-session-key="${incognitoKey}"]`);
        await incognitoRow.waitFor();
        await sidebar.locator(".sidebar-attention__item").waitFor();

        await expectLucideContract(sidebar, 10);

        const incognitoIcon = incognitoRow.locator(".session-row-badge--incognito svg");
        await expect.poll(() => incognitoIcon.locator("circle").count()).toBe(2);
        await expect.poll(() => incognitoIcon.locator("rect").count()).toBe(0);
        const incognitoBox = await incognitoIcon.boundingBox();
        expect(incognitoBox?.width).toBeCloseTo(13, 3);
        expect(incognitoBox?.height).toBeCloseTo(13, 3);
        const incognitoTextBox = await incognitoRow
          .locator(".sidebar-recent-session__text")
          .boundingBox();
        expect(incognitoBox!.x - (incognitoTextBox!.x + incognitoTextBox!.width)).toBe(8);

        const filter = sidebar.locator(".sidebar-session-sort");
        const filterMetrics = await filter.evaluate((button) => {
          const buttonBox = button.getBoundingClientRect();
          const iconBox = button.querySelector("svg")?.getBoundingClientRect();
          return {
            button: [buttonBox.width, buttonBox.height],
            icon: iconBox ? [iconBox.width, iconBox.height] : null,
          };
        });
        expect(filterMetrics.button).toEqual([28, 28]);
        expect(filterMetrics.icon).toEqual([13, 13]);

        const variant = `${colorScheme}-${deviceScaleFactor}x`;
        await captureSidebarUiUnionProof(page, [sidebarSurface], `iconography-${variant}-base.png`);

        const groupHeader = sidebar.locator(
          '[data-session-section="category:Research"] .sidebar-recent-sessions__head',
        );
        await groupHeader.hover();
        const groupGrip = groupHeader.locator(".sidebar-session-group-drag-handle svg");
        const groupToggle = groupHeader.locator(".sidebar-session-group-toggle");
        const groupAction = groupHeader.locator(".sidebar-session-group-actions");
        await expect.poll(() => groupGrip.isVisible()).toBe(true);
        await expect.poll(() => groupAction.isVisible()).toBe(true);
        await expect.poll(() => groupAction.locator('circle[fill="currentColor"]').count()).toBe(3);
        const groupExpanded = await groupToggle.getAttribute("aria-expanded");
        await groupGrip.click();
        await expect.poll(() => groupToggle.getAttribute("aria-expanded")).not.toBe(groupExpanded);
        await groupGrip.click();
        await expect.poll(() => groupToggle.getAttribute("aria-expanded")).toBe(groupExpanded);
        await groupAction.hover();
        await expect
          .poll(() => groupAction.evaluate((button) => getComputedStyle(button).opacity))
          .toBe("1");
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface],
          `iconography-${variant}-group-controls.png`,
          { preserveHover: true },
        );
        await groupAction.click();
        const groupMenu = sidebar.locator("wa-dropdown.sidebar-session-group-menu");
        const groupMenuSurface = groupMenu.locator('[part="menu"]');
        await groupMenuSurface.waitFor();
        await expectLucideContract(groupMenu);
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, groupMenuSurface],
          `iconography-${variant}-group-menu.png`,
        );
        await page.keyboard.press("Escape");

        await incognitoRow.hover();
        const sessionAction = incognitoRow.locator("[data-session-menu]");
        await expect
          .poll(() => sessionAction.evaluate((button) => getComputedStyle(button).opacity))
          .toBe("1");
        const actionBox = await sessionAction.locator("svg").boundingBox();
        expect(actionBox?.width).toBe(15);
        expect(actionBox?.height).toBe(15);
        await sessionAction.click();
        const sessionMenu = sidebar.locator("wa-dropdown.session-menu");
        const sessionMenuSurface = sessionMenu.locator('[part="menu"]');
        await sessionMenuSurface.waitFor();
        await expectLucideContract(sessionMenu);
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, sessionMenuSurface],
          `iconography-${variant}-session-menu.png`,
        );
        await page.keyboard.press("Escape");

        await sidebar.locator(".sidebar-nav__head-action").click();
        const moreMenu = sidebar.locator("wa-dropdown.sidebar-more-menu");
        await moreMenu.getByRole("menuitem", { name: "Edit pinned items" }).click();
        const customizeMenu = sidebar.locator(
          "wa-dropdown.sidebar-customize-menu:not(.sidebar-more-menu):not(.sidebar-agent-menu)",
        );
        const customizeMenuSurface = customizeMenu.locator('[part="menu"]');
        await customizeMenuSurface.waitFor();
        await expectLucideContract(customizeMenu);
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, customizeMenuSurface],
          `iconography-${variant}-customizer.png`,
        );
        await page.keyboard.press("Escape");

        await sidebar.locator(".sidebar-agent-card__main").click();
        const agentMenu = sidebar.locator("wa-dropdown.sidebar-agent-menu");
        const agentMenuSurface = agentMenu.locator('[part="menu"]');
        await agentMenuSurface.waitFor();
        await expectLucideContract(agentMenu);
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, agentMenuSurface],
          `iconography-${variant}-agent-menu.png`,
        );
        await page.keyboard.press("Escape");

        await sidebar.locator(".sidebar-identity-card").click();
        const identityMenu = sidebar.locator("wa-dropdown.sidebar-identity-menu");
        const identityMenuSurface = identityMenu.locator('[part="menu"]');
        await identityMenuSurface.waitFor();
        await expectLucideContract(identityMenu);
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, identityMenuSurface],
          `iconography-${variant}-account-menu.png`,
        );
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
