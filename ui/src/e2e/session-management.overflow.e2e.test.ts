import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  actionOpacity,
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  hitTargetAtCentre,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const SHORT_KEY = "agent:main:short";
const LONG_KEY = "agent:main:long";
const RUNNING_KEY = "agent:main:running";
const BLOCKED_KEY = "agent:main:blocked";
const PINNED_KEY = "agent:main:pinned";

const LONG_TITLE = "Reconcile the workspace conflict that blocks the nightly export from finishing";

/**
 * Every endcap the row can rest with, so a reveal is proven against an empty
 * trail, a live run, a blocked run, and a pinned row rather than one happy row.
 */
function overflowFixture() {
  return sessionsListResponse([
    sessionRow(SHORT_KEY, "Release notes", 6),
    sessionRow(LONG_KEY, LONG_TITLE, 5),
    sessionRow(RUNNING_KEY, `${LONG_TITLE} while running`, 4, {
      hasActiveRun: true,
      status: "running",
    }),
    sessionRow(BLOCKED_KEY, `${LONG_TITLE} after failing`, 3, {
      status: "failed",
      unread: true,
    }),
    sessionRow(PINNED_KEY, `${LONG_TITLE} and pinned`, 2, { pinned: true, pinnedAt: 2 }),
  ]);
}

/**
 * The shell plays a mount entrance that slides the whole page into place, so a
 * box read while it runs measures the animation rather than the row. Only the
 * resting read is affected: Playwright settles the page before it will hover.
 * Looping animations never finish and never move the page, so they are skipped
 * rather than waited on forever.
 */
async function settleEntranceAnimations(page: Page) {
  await page.evaluate(async () => {
    const entrances = document.getAnimations().filter((animation) => {
      const endTime = animation.effect?.getComputedTiming().endTime;
      return endTime !== undefined && Number.isFinite(Number(endTime));
    });
    await Promise.all(entrances.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function openSidebar(
  colorScheme: "light" | "dark",
  reducedMotion: "no-preference" | "reduce" = "no-preference",
) {
  const context = await suite.browser.newContext({
    colorScheme,
    locale: "en-US",
    reducedMotion,
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  const page = await context.newPage();
  await installMockGateway(page, {
    methodResponses: { "sessions.list": overflowFixture() },
    sessionKey: SHORT_KEY,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, SHORT_KEY));
  await page.locator(`[data-session-key="${LONG_KEY}"]`).waitFor({ state: "visible" });
  await settleEntranceAnimations(page);
  return { context, page };
}

function requireBox(box: Awaited<ReturnType<typeof boxOf>>) {
  expect(box).not.toBeNull();
  return box as NonNullable<typeof box>;
}

function boxOf(page: Awaited<ReturnType<typeof openSidebar>>["page"], selector: string) {
  return page.locator(selector).boundingBox();
}

suite.define(() => {
  it("reserves only the state it is showing and never moves the row to reveal actions", async () => {
    const { context, page } = await openSidebar("light");

    try {
      for (const key of [SHORT_KEY, RUNNING_KEY]) {
        const row = page.locator(`[data-session-key="${key}"]`);
        const link = row.locator(".sidebar-recent-session__link");
        const aside = row.locator(".sidebar-recent-session__aside");

        const restLink = requireBox(await link.boundingBox());
        const restAside = requireBox(await aside.boundingBox());
        // The link stops exactly where the endcap starts: the row reserves the
        // trail it actually renders, never a guessed action width.
        expect(Math.abs(restLink.x + restLink.width - restAside.x)).toBeLessThanOrEqual(1);

        await row.hover();
        await expect.poll(() => actionOpacity(row.locator("[data-session-menu]"))).toBe("1");
        const hoverLink = requireBox(await link.boundingBox());
        expect(hoverLink).toEqual(restLink);
      }

      // An empty endcap leaves the title measurably more room than a live one.
      const emptyLink = requireBox(
        await boxOf(page, `[data-session-key="${SHORT_KEY}"] .sidebar-recent-session__link`),
      );
      const stateLink = requireBox(
        await boxOf(page, `[data-session-key="${RUNNING_KEY}"] .sidebar-recent-session__link`),
      );
      expect(emptyLink.width).toBeGreaterThan(stateLink.width);
    } finally {
      await context.close();
    }
  });

  it("travels only titles that are genuinely clipped", async () => {
    const { context, page } = await openSidebar("light");

    try {
      const shortLabel = page.locator(
        `[data-session-key="${SHORT_KEY}"] .sidebar-recent-session__name`,
      );
      const longLabel = page.locator(
        `[data-session-key="${LONG_KEY}"] .sidebar-recent-session__name`,
      );
      const restIndent = await shortLabel.evaluate((el) => getComputedStyle(el).textIndent);

      await page.locator(`[data-session-key="${SHORT_KEY}"]`).hover();
      await page.waitForTimeout(900);
      expect(await shortLabel.evaluate((el) => el.className)).not.toContain(
        "hover-marquee--scrolling",
      );
      expect(await shortLabel.evaluate((el) => getComputedStyle(el).textIndent)).toBe(restIndent);
      // Not merely unmoved: a title that ends before the controls is never
      // armed at all, so no traversal is even queued behind the entry delay.
      expect(
        await shortLabel.evaluate((el) => el.style.getPropertyValue("--hover-marquee-shift")),
      ).toBe("");

      await page.locator(`[data-session-key="${LONG_KEY}"]`).hover();
      await expect
        .poll(() => longLabel.evaluate((el) => el.className), { timeout: 2_000 })
        .toContain("hover-marquee--scrolling");
      // The published overlap is what the traversal and the fade both consume.
      const cover = await page
        .locator(`[data-session-key="${LONG_KEY}"]`)
        .evaluate((el) => el.style.getPropertyValue("--session-row-action-cover"));
      expect(Number.parseFloat(cover)).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it("hands the trailing edge to the actions exactly when it reveals them", async () => {
    const { context, page } = await openSidebar("light");

    try {
      const row = page.locator(`[data-session-key="${LONG_KEY}"]`);
      const more = row.locator("[data-session-menu]");

      // At rest the row offers nothing there, so the point still belongs to the
      // link: an invisible control may not silently eat the row's own click.
      await page.locator(`[data-session-key="${SHORT_KEY}"]`).hover();
      await expect.poll(() => actionOpacity(more)).toBe("0");
      expect(await hitTargetAtCentre(more)).toBe("link");

      // Revealed, the same point belongs to the button, and the click has to
      // produce the menu rather than merely dispatch an event.
      await row.hover();
      await expect.poll(() => actionOpacity(more)).toBe("1");
      expect(await hitTargetAtCentre(more)).toBe("action");
      await more.click();
      await expect.poll(() => page.getByRole("menuitem", { name: "Pin session" }).count()).toBe(1);
      expect(await row.evaluate((el) => el.className)).toContain("session-row-host--menu-open");
    } finally {
      await context.close();
    }
  });

  it("leaves clipped titles still under reduced motion", async () => {
    const { context, page } = await openSidebar("light", "reduce");

    try {
      const longRow = page.locator(`[data-session-key="${LONG_KEY}"]`);
      const longLabel = longRow.locator(".sidebar-recent-session__name");
      await longRow.hover();
      await page.waitForTimeout(900);

      expect(await longLabel.evaluate((el) => el.className)).not.toContain(
        "hover-marquee--scrolling",
      );
      expect(
        Number.parseFloat(
          await longRow.evaluate((el) => el.style.getPropertyValue("--session-row-action-cover")),
        ),
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it("captures the rest and management matrix in both themes", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      const { context, page } = await openSidebar(colorScheme);

      try {
        const sidebar = page.locator("openclaw-app-sidebar aside.sidebar");
        await captureUiProof(page, `overflow-rest-${colorScheme}.png`, { clip: [sidebar] });

        for (const key of [SHORT_KEY, LONG_KEY, RUNNING_KEY, BLOCKED_KEY, PINNED_KEY]) {
          const row = page.locator(`[data-session-key="${key}"]`);
          await row.hover();
          await expect.poll(() => actionOpacity(row.locator("[data-session-menu]"))).toBe("1");
          await captureUiProof(page, `overflow-hover-${key.split(":").pop()}-${colorScheme}.png`, {
            clip: [row],
          });
        }

        const menuRow = page.locator(`[data-session-key="${LONG_KEY}"]`);
        await menuRow.hover();
        await expect.poll(() => actionOpacity(menuRow.locator("[data-session-menu]"))).toBe("1");
        await menuRow.locator("[data-session-menu]").click();
        // The menu host is a zero-box popover owner; its items are the surface
        // that has to be on screen, and the frame is clipped to them.
        const items = page.getByRole("menuitem");
        await items.first().waitFor({ state: "visible" });
        await captureUiProof(page, `overflow-menu-open-${colorScheme}.png`, {
          clip: [menuRow, items.first(), items.last()],
        });
      } finally {
        await context.close();
      }
    }
  });
});
