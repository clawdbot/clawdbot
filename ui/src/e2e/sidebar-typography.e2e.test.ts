import type { Locator } from "playwright";
import { expect, it } from "vitest";
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

const suite = createSidebarCustomizationSuite("Control UI sidebar typography mocked Gateway E2E");

const visualVariants = [{ colorScheme: "light" as const }, { colorScheme: "dark" as const }];

type TypeMetrics = {
  family: string;
  size: string;
  lineHeight: string;
  tracking: string;
  weight: string;
};

function typeMetrics(locator: Locator): Promise<TypeMetrics> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      family: style.fontFamily,
      size: style.fontSize,
      lineHeight: style.lineHeight,
      tracking: style.letterSpacing,
      weight: style.fontWeight,
    };
  });
}

suite.define(() => {
  it.each(visualVariants)(
    "keeps sidebar type roles invariant in $colorScheme",
    async ({ colorScheme }) => {
      const context = await suite.newBrowserContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      });
      const page = await context.newPage();
      const baseTime = Date.parse("2026-08-14T16:00:00.000Z");
      const pinnedKey = "agent:main:pinned";
      const parentKey = "agent:main:release-plan";
      const childKey = "agent:main:verify-release";
      const draftKey = "agent:main:draft";
      await installMockGateway(page, {
        featureMethods: ["sessions.catalog.list"],
        methodResponses: {
          "sessions.list": {
            cases: [
              {
                match: { spawnedBy: parentKey },
                response: sessionsListResponse([
                  sessionRow(childKey, "Verify release evidence", baseTime - 2_000, {
                    spawnedBy: parentKey,
                    startedAt: baseTime - 62_000,
                    status: "done",
                  }),
                ]),
              },
              {
                response: sessionsListResponse([
                  {
                    ...sessionRow(pinnedKey, "Pinned handoff", baseTime, {
                      pinned: true,
                      unread: true,
                      worktree: {
                        branch: "feat/pinned-handoff",
                        repoRoot: "/workspace/openclaw",
                      },
                    }),
                  },
                  {
                    ...sessionRow(parentKey, "Release plan", baseTime - 1_000, {
                      category: "Research",
                      childSessions: [childKey],
                      worktree: {
                        branch: "feat/release-plan",
                        repoRoot: "/workspace/openclaw",
                      },
                    }),
                  },
                  {
                    ...sessionRow(
                      draftKey,
                      "Draft with a deliberately long title that must truncate cleanly",
                      baseTime - 3_000,
                    ),
                    visibility: "draft",
                  },
                ]),
              },
            ],
          },
          "sessions.catalog.list": {
            catalogs: [
              {
                id: "codex",
                label: "Codex",
                capabilities: { continueSession: true, archive: true },
                hosts: [
                  {
                    hostId: "gateway:local",
                    label: "Gateway",
                    kind: "gateway",
                    connected: true,
                    sessions: [
                      {
                        threadId: "catalog-session",
                        name: "Catalog session",
                        cwd: "/workspace/openclaw",
                        status: "idle",
                        archived: false,
                        canContinue: true,
                        canArchive: true,
                        updatedAt: baseTime - 4_000,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        sessionGroups: ["Research"],
        sessionKey: parentKey,
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
        const sidebar = page.locator("openclaw-app-sidebar");
        const sidebarSurface = sidebar.locator(".sidebar-shell");
        const pinnedRow = sidebar.locator(`[data-session-key="${pinnedKey}"]`);
        const parentRow = sidebar.locator(`[data-session-key="${parentKey}"]`);
        const draftRow = sidebar.locator(`[data-session-key="${draftKey}"]`);
        const catalogRow = sidebar.locator('[data-session-key*="catalog-session"]');
        await parentRow.waitFor();
        await catalogRow.waitFor();

        await parentRow.locator(".sidebar-child-session-toggle").click();
        const childRow = sidebar.locator(`[data-session-key="${childKey}"]`);
        await childRow.waitFor();

        const parentTitle = parentRow.locator(".sidebar-recent-session__name");
        const titleContract = await typeMetrics(parentTitle);
        for (const title of [
          childRow.locator(".sidebar-recent-session__name"),
          draftRow.locator(".sidebar-recent-session__name"),
          catalogRow.locator(".sidebar-recent-session__name"),
        ]) {
          expect(await typeMetrics(title)).toEqual(titleContract);
        }
        const pinnedTitleMetrics = await typeMetrics(
          pinnedRow.locator(".sidebar-recent-session__name"),
        );
        expect({ ...pinnedTitleMetrics, weight: titleContract.weight }).toEqual(titleContract);
        expect(Number(pinnedTitleMetrics.weight)).toBeGreaterThan(Number(titleContract.weight));
        await expect
          .poll(() => parentRow.getAttribute("class"))
          .toContain("sidebar-recent-session--active");

        const pinnedSubtitle = pinnedRow.locator(".sidebar-recent-session__subtitle");
        const parentSubtitle = parentRow.locator(".sidebar-recent-session__subtitle");
        expect(await typeMetrics(pinnedSubtitle)).toEqual(await typeMetrics(parentSubtitle));

        const sectionLabels = sidebar.locator(".sidebar-recent-sessions__label-text");
        const sectionContract = await typeMetrics(sectionLabels.first());
        expect(sectionContract).toMatchObject({
          lineHeight: "11px",
          size: "11px",
          tracking: "0.44px",
          weight: "650",
        });
        expect(
          await sectionLabels.evaluateAll((labels) => labels.map((label) => label.textContent)),
        ).toEqual(expect.arrayContaining(["Sessions", "Research", "Codex"]));

        const variant = `typography-${colorScheme}`;
        await captureSidebarUiUnionProof(page, [sidebarSurface], `${variant}-full.png`);

        const navLabel = sidebar
          .getByRole("link", { name: "Automations" })
          .locator(".nav-item__text");
        const navMetrics = await typeMetrics(navLabel);
        await sidebar.locator(".sidebar-nav__more").click();
        const moreMenu = sidebar.locator("wa-dropdown.sidebar-more-menu");
        await moreMenu.getByRole("menuitem", { name: "Customize sidebar" }).click();
        const customizeMenu = sidebar.locator(
          "wa-dropdown.sidebar-customize-menu:not(.sidebar-more-menu):not(.sidebar-agent-menu)",
        );
        const customizeSurface = customizeMenu.locator('[part="menu"]');
        await customizeSurface.waitFor();
        expect(
          await typeMetrics(
            customizeMenu.locator(".sidebar-customize-menu__item", { hasText: "Automations" }),
          ),
        ).toEqual(navMetrics);
        expect(await typeMetrics(customizeMenu.locator(".sidebar-customize-menu__title"))).toEqual(
          sectionContract,
        );

        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, customizeSurface],
          `${variant}-customizer.png`,
        );
        await page.keyboard.press("Escape");

        await draftRow.hover();
        await draftRow.locator("[data-session-menu]").click();
        const sessionMenu = sidebar.locator("wa-dropdown.session-menu");
        const sessionMenuSurface = sessionMenu.locator('[part="menu"]');
        await sessionMenuSurface.waitFor();
        const menuRows = sessionMenu.locator(".session-menu__item");
        const menuContract = await typeMetrics(menuRows.first());
        expect(
          await menuRows.evaluateAll((rows) => rows.map((row) => getComputedStyle(row).lineHeight)),
        ).toEqual(Array(await menuRows.count()).fill(menuContract.lineHeight));
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, sessionMenuSurface],
          `${variant}-context-menu.png`,
        );
        await page.keyboard.press("Escape");

        await sidebar.locator(".sidebar-identity-card").click();
        const identityMenu = sidebar.locator("wa-dropdown.sidebar-identity-menu");
        const identitySurface = identityMenu.locator('[part="menu"]');
        await identitySurface.waitFor();
        const buildChip = identityMenu.locator(".sidebar-footer-build");
        await buildChip.hover();
        const hoverCard = identityMenu.locator(".sidebar-hover-card");
        await hoverCard.waitFor({ state: "visible" });
        await captureSidebarUiUnionProof(
          page,
          [sidebarSurface, identitySurface, hoverCard],
          `${variant}-hover-card.png`,
        );
        await page.keyboard.press("Escape");

        await page.evaluate(() => {
          document.documentElement.style.zoom = "2";
        });
        const zoomMetrics = await draftRow
          .locator(".sidebar-recent-session__name")
          .evaluate((name) => {
            const style = getComputedStyle(name);
            const box = name.getBoundingClientRect();
            return {
              lineHeight: Number.parseFloat(style.lineHeight),
              height: box.height,
              overflowY: name.scrollHeight - name.clientHeight,
              textOverflow: style.textOverflow,
            };
          });
        expect(zoomMetrics.textOverflow).toBe("ellipsis");
        expect(zoomMetrics.height).toBeGreaterThanOrEqual(zoomMetrics.lineHeight - 0.5);
        expect(zoomMetrics.overflowY).toBeLessThanOrEqual(1);
        await captureSidebarUiUnionProof(page, [draftRow], `${variant}-zoom-200.png`);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
