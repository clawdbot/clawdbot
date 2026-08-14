import type { Locator, Page } from "playwright";
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

const suite = createSidebarCustomizationSuite("Control UI sidebar chrome grid mocked Gateway E2E");
const visualVariants = [{ colorScheme: "light" as const }, { colorScheme: "dark" as const }];

function configResponse(colorScheme: "light" | "dark") {
  const config = { ui: { prefs: { locale: "en", themeMode: colorScheme } } };
  const hash = `sidebar-grid-${colorScheme}`;
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

async function left(locator: Locator) {
  return Math.round((await locator.boundingBox())?.x ?? Number.NaN);
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  return Math.round(box ? box.x + box.width / 2 : Number.NaN);
}

async function surfaceBounds(locator: Locator) {
  const box = await locator.boundingBox();
  return box
    ? { left: Math.round(box.x), right: Math.round(box.x + box.width) }
    : { left: Number.NaN, right: Number.NaN };
}

async function background(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

async function waitForAnimations(locator: Locator) {
  await locator.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function installGridGuides(page: Page, sidebar: Locator, text: Locator, control: Locator) {
  await page.addStyleTag({
    content: `
      .sidebar[data-grid-proof]::before,
      .sidebar[data-grid-proof]::after {
        content: "";
        position: absolute;
        inset-block: 0;
        z-index: 220;
        width: 1px;
        pointer-events: none;
      }
      .sidebar[data-grid-proof]::before {
        inset-inline-start: var(--grid-proof-text);
        background: rgb(255 64 64 / 0.82);
      }
      .sidebar[data-grid-proof]::after {
        inset-inline-start: var(--grid-proof-rail);
        background: rgb(40 180 255 / 0.82);
      }
    `,
  });
  const [sidebarBox, textBox, controlBox] = await Promise.all([
    sidebar.boundingBox(),
    text.boundingBox(),
    control.boundingBox(),
  ]);
  if (!sidebarBox || !textBox || !controlBox) {
    throw new Error("expected visible sidebar grid anchors");
  }
  await sidebar.evaluate(
    (element, offsets) => {
      element.setAttribute("data-grid-proof", "");
      (element as HTMLElement).style.setProperty("--grid-proof-text", `${offsets.text}px`);
      (element as HTMLElement).style.setProperty("--grid-proof-rail", `${offsets.rail}px`);
    },
    {
      rail: controlBox.x + controlBox.width / 2 - sidebarBox.x,
      text: textBox.x - sidebarBox.x,
    },
  );
}

async function capture(page: Page, sidebarSurface: Locator, fileName: string) {
  await captureSidebarUiUnionProof(page, [sidebarSurface], fileName);
}

suite.define(() => {
  it.each(visualVariants)(
    "keeps sidebar chrome on one structural grid in $colorScheme",
    async ({ colorScheme }) => {
      const context = await suite.newBrowserContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 600, width: 1440 },
      });
      const page = await context.newPage();
      const baseTime = Date.parse("2026-08-14T16:00:00.000Z");
      const pinnedKey = "agent:main:pinned";
      const parentKey = "agent:main:release-plan";
      const childKey = "agent:main:verify-release";
      const draftKey = "agent:main:draft";
      const overflowRows = Array.from({ length: 18 }, (_, index) =>
        sessionRow(
          `agent:main:overflow-${index}`,
          `Overflow session ${String(index + 1).padStart(2, "0")}`,
          baseTime - (index + 10) * 1_000,
        ),
      );
      await installMockGateway(page, {
        featureMethods: ["sessions.catalog.list"],
        methodResponses: {
          "config.get": configResponse(colorScheme),
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
                  sessionRow(pinnedKey, "Pinned handoff", baseTime, { pinned: true }),
                  sessionRow(parentKey, "Release plan", baseTime - 1_000, {
                    category: "Research",
                    childSessions: [childKey],
                  }),
                  {
                    ...sessionRow(draftKey, "Draft session", baseTime - 3_000),
                    visibility: "draft",
                  },
                  ...overflowRows,
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
        const sidebarRoot = sidebar.locator(".sidebar");
        const sidebarSurface = sidebar.locator(".sidebar-shell");
        const body = sidebar.locator(".sidebar-shell__body");
        const shellNav = page.locator(".shell-nav");
        const resizer = page.getByRole("separator", { name: "Resize sidebar" });
        const homeRow = sidebar.locator(".nav-item--home");
        const pageRow = sidebar.getByRole("link", { name: "Automations" });
        const pageText = homeRow.locator(".nav-item__text");
        const pageControl = sidebar.locator(".sidebar-nav__head-action");
        const pinnedRow = sidebar.locator(`[data-session-key="${pinnedKey}"]`);
        const parentRow = sidebar.locator(`[data-session-key="${parentKey}"]`);
        const draftRow = sidebar.locator(`[data-session-key="${draftKey}"]`);
        await parentRow.waitFor();
        await parentRow.locator(".sidebar-child-session-toggle").click();
        const childRow = sidebar.locator(`[data-session-key="${childKey}"]`);
        const catalogRow = sidebar.locator('[data-session-key*="catalog-session"]');
        await childRow.waitFor();
        await catalogRow.waitFor();
        await expect
          .poll(() => parentRow.getAttribute("class"))
          .toContain("sidebar-recent-session--active");
        await expect
          .poll(() => page.locator("html").getAttribute("data-theme-mode"))
          .toBe(colorScheme);

        const textAnchors = [
          pageText,
          sidebar.locator(".sidebar-nav__head .sidebar-recent-sessions__label-text"),
          pinnedRow.locator(".sidebar-recent-session__name"),
          parentRow.locator(".sidebar-recent-session__name"),
          draftRow.locator(".sidebar-recent-session__name"),
          catalogRow.locator(".sidebar-recent-session__name"),
          sidebar.locator(".sidebar-identity-card__name"),
        ];
        const textAxis = await left(pageText);
        expect(await Promise.all(textAnchors.map(left))).toEqual(
          Array(textAnchors.length).fill(textAxis),
        );
        expect(await left(childRow.locator(".sidebar-recent-session__name"))).toBe(textAxis + 16);

        const trailingAnchors = [
          pageControl,
          pinnedRow.locator("[data-session-menu]"),
          draftRow.locator("[data-session-menu]"),
          sidebar.locator(".sidebar-identity-card__chevron"),
        ];
        const trailingAxis = await center(pageControl);
        expect(await Promise.all(trailingAnchors.map(center))).toEqual(
          Array(trailingAnchors.length).fill(trailingAxis),
        );

        const pageSurface = await surfaceBounds(homeRow);
        for (const row of [pinnedRow, parentRow, draftRow]) {
          expect(await surfaceBounds(row)).toEqual(pageSurface);
        }
        expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );

        const sessionSelected = await background(parentRow);
        expect(sessionSelected).not.toBe("rgba(0, 0, 0, 0)");
        await installGridGuides(page, sidebarRoot, pageText, pageControl);
        await capture(page, sidebarSurface, `grid-${colorScheme}-current-selected.png`);

        await homeRow.click();
        await expect.poll(() => homeRow.getAttribute("class")).toContain("nav-item--active");
        await waitForAnimations(homeRow);
        expect(await background(homeRow)).toBe(sessionSelected);
        await capture(page, sidebarSurface, `grid-${colorScheme}-page-selected.png`);
        await parentRow.locator(".sidebar-recent-session__link").click();
        await expect
          .poll(() => parentRow.getAttribute("class"))
          .toContain("sidebar-recent-session--active");

        await pageRow.hover();
        await waitForAnimations(pageRow);
        const pageHover = await background(pageRow);
        await capture(page, sidebarSurface, `grid-${colorScheme}-page-hover.png`);
        await draftRow.hover();
        await waitForAnimations(draftRow);
        expect(await background(draftRow)).toBe(pageHover);
        await capture(page, sidebarSurface, `grid-${colorScheme}-session-hover.png`);

        await pageRow.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        expect(await pageRow.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        expect(await pageRow.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(
          "none",
        );
        await capture(page, sidebarSurface, `grid-${colorScheme}-page-focus.png`);

        const draftLink = draftRow.locator(".sidebar-recent-session__link");
        await draftLink.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        expect(await draftLink.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        expect(await draftRow.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(
          "none",
        );
        await capture(page, sidebarSurface, `grid-${colorScheme}-session-focus.png`);

        await page.locator("#control-ui-main").focus();
        await page.mouse.move(700, 700);
        const scrollbarRest = await body.evaluate(
          (element) => getComputedStyle(element).scrollbarColor,
        );
        await capture(page, sidebarSurface, `grid-${colorScheme}-scrollbar-rest.png`);
        await body.hover();
        const scrollbarHover = await body.evaluate(
          (element) => getComputedStyle(element).scrollbarColor,
        );
        expect(scrollbarHover).not.toBe(scrollbarRest);
        await page.mouse.wheel(0, 700);
        await expect
          .poll(() => body.getAttribute("class"))
          .toContain("sidebar-shell__body--scrolling");
        await page.mouse.move(700, 700);
        expect(await body.evaluate((element) => getComputedStyle(element).scrollbarColor)).toBe(
          scrollbarHover,
        );
        await capture(page, sidebarSurface, `grid-${colorScheme}-scrollbar-active.png`);
        await expect
          .poll(() => body.getAttribute("class"))
          .not.toContain("sidebar-shell__body--scrolling");

        await body.evaluate((element) => element.scrollTo({ top: 0 }));
        const restDivider = await resizer.evaluate((element) => ({
          railColor: getComputedStyle(element).getPropertyValue("--rail-divider-color").trim(),
          shell: getComputedStyle(element.previousElementSibling!).borderInlineEndColor,
          targetWidth: element.getBoundingClientRect().width,
        }));
        expect(restDivider.railColor).toBe("transparent");
        expect(restDivider.shell).not.toBe("rgba(0, 0, 0, 0)");
        expect(restDivider.targetWidth).toBe(6);
        await resizer.hover();
        const activeDivider = await resizer.evaluate((element) => ({
          activeColor: getComputedStyle(element).getPropertyValue("--accent").trim(),
          globalAccent: getComputedStyle(document.documentElement)
            .getPropertyValue("--accent")
            .trim(),
          hovered: element.matches(":hover"),
          shell: getComputedStyle(element.previousElementSibling!).borderInlineEndColor,
        }));
        expect(activeDivider.hovered).toBe(true);
        expect(activeDivider.activeColor).not.toBe(activeDivider.globalAccent);
        expect(activeDivider.shell).toBe("rgba(0, 0, 0, 0)");
        await capture(page, sidebarSurface, `grid-${colorScheme}-resize-hover.png`);

        const resizerBounds = await resizer.boundingBox();
        if (!resizerBounds) {
          throw new Error("expected visible sidebar resizer");
        }
        const resizerX = resizerBounds.x + resizerBounds.width / 2;
        const resizerY = resizerBounds.y + resizerBounds.height / 2;
        await page.mouse.move(resizerX, resizerY);
        await page.mouse.down();
        await page.mouse.move(resizerX + 22, resizerY);
        await expect
          .poll(async () => Math.round((await shellNav.boundingBox())?.width ?? 0))
          .toBe(280);
        await capture(page, sidebarSurface, `grid-${colorScheme}-resize-drag-280.png`);
        await page.mouse.up();
        await capture(page, sidebarSurface, `grid-${colorScheme}-width-280.png`);

        await resizer.focus();
        await expect
          .poll(() => resizer.evaluate((element) => getComputedStyle(element).outlineStyle))
          .toBe("none");
        await page.keyboard.press("End");
        await expect
          .poll(async () => Math.round((await shellNav.boundingBox())?.width ?? 0))
          .toBe(400);
        expect(await Promise.all(textAnchors.map(left))).toEqual(
          Array(textAnchors.length).fill(await left(pageText)),
        );
        expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await installGridGuides(page, sidebarRoot, pageText, pageControl);
        await capture(page, sidebarSurface, `grid-${colorScheme}-width-400.png`);

        await page.locator("html").evaluate((element) => {
          element.setAttribute("dir", "rtl");
        });
        const viewportWidth = page.viewportSize()!.width;
        const rtlStarts = await Promise.all(
          textAnchors.map(async (locator) => {
            const box = await locator.boundingBox();
            return Math.round(viewportWidth - (box?.x ?? Number.NaN) - (box?.width ?? Number.NaN));
          }),
        );
        expect(rtlStarts).toEqual(Array(rtlStarts.length).fill(rtlStarts[0]));
        const rtlParent = await parentRow.locator(".sidebar-recent-session__name").boundingBox();
        const rtlChild = await childRow.locator(".sidebar-recent-session__name").boundingBox();
        expect(
          Math.round(
            viewportWidth -
              rtlChild!.x -
              rtlChild!.width -
              (viewportWidth - rtlParent!.x - rtlParent!.width),
          ),
        ).toBe(16);
        expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await capture(page, sidebarSurface, `grid-${colorScheme}-rtl-400.png`);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
