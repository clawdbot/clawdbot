import { expect, it } from "vitest";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  expandStoredSessionSections,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const PLAIN_KEY = "agent:main:plain";
const WORK_KEY = "agent:main:work";
const CLOUD_KEY = "agent:main:cloud";

const LONG_TITLE = "Reconcile the workspace conflict that blocks the nightly export from finishing";

/** Facts a real Gateway reports, so every card row is backed by one. */
function cardFixture() {
  return sessionsListResponse([
    sessionRow(PLAIN_KEY, "Release notes", 6),
    sessionRow(WORK_KEY, LONG_TITLE, 5, {
      worktree: {
        id: "wt-1",
        branch: "feature/sidebar-cards",
        repoRoot: "/Users/ada/code/openclaw",
      },
    }),
    sessionRow(CLOUD_KEY, "Nightly export", 4),
  ]);
}

async function openSidebar(colorScheme: "light" | "dark" = "light") {
  const context = await suite.browser.newContext({
    colorScheme,
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  const page = await context.newPage();
  await expandStoredSessionSections(page);
  await installMockGateway(page, {
    methodResponses: { "sessions.list": cardFixture() },
    sessionKey: PLAIN_KEY,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, PLAIN_KEY));
  await page.locator(`[data-session-key="${WORK_KEY}"]`).waitFor({ state: "visible" });
  return { context, page };
}

function card(page: Awaited<ReturnType<typeof openSidebar>>["page"]) {
  return page.locator(".session-hover-card:visible");
}

suite.define(() => {
  it("waits for a deliberate hover, then lets the reader scan siblings at once", async () => {
    const { context, page } = await openSidebar();

    try {
      await pauseVirtualClock(page);
      await page.locator(`[data-session-key="${WORK_KEY}"]`).hover();
      await page.clock.runFor(300);
      expect(await card(page).count()).toBe(0);
      await page.clock.runFor(150);
      await expect.poll(() => card(page).count(), { timeout: 2_000 }).toBe(1);

      // Leaving and arriving on a sibling inside the shared skip-delay window
      // opens the next card without asking for the deliberate hover again.
      await page.locator(`[data-session-key="${CLOUD_KEY}"]`).hover();
      await page.clock.runFor(150);
      await expect
        .poll(() => card(page).locator(".session-hover-card__title").textContent(), {
          timeout: 2_000,
        })
        .toBe("Nightly export");

      // Once that window expires the next row is cold again.
      await page
        .locator(".app-shell, body")
        .first()
        .hover({ position: { x: 900, y: 700 } });
      await page.clock.runFor(1_000);
      await page.locator(`[data-session-key="${PLAIN_KEY}"]`).hover();
      await page.clock.runFor(300);
      expect(await card(page).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("reveals the whole title and the checkout behind it", async () => {
    const { context, page } = await openSidebar();

    try {
      await page.locator(`[data-session-key="${WORK_KEY}"]`).hover();
      await expect.poll(() => card(page).count(), { timeout: 3_000 }).toBe(1);

      expect(await card(page).locator(".session-hover-card__title").textContent()).toBe(LONG_TITLE);
      const rows = await card(page).locator(".session-hover-card__row").allTextContents();
      expect(rows.map((row) => row.replace(/\s+/gu, " ").trim())).toEqual([
        "Project /Users/ada/code/openclaw",
        "Branch feature/sidebar-cards",
      ]);
      // Two lines of title, not one clipped line.
      const title = await card(page).locator(".session-hover-card__title").boundingBox();
      expect(title?.height ?? 0).toBeGreaterThan(20);
    } finally {
      await context.close();
    }
  });

  it("keeps the card while the pointer reaches the row's own controls", async () => {
    const { context, page } = await openSidebar();

    try {
      const row = page.locator(`[data-session-key="${WORK_KEY}"]`);
      await row.hover();
      await expect.poll(() => card(page).count(), { timeout: 3_000 }).toBe(1);

      await row.locator("[data-sidebar-session-pin]").hover();
      expect(await card(page).count()).toBe(1);

      await row.locator("[data-session-menu]").click();
      // The menu host owns a popover and carries no box of its own; its items
      // are what actually reaches the screen.
      await page.getByRole("menuitem").first().waitFor({ state: "visible" });
      await expect.poll(() => card(page).count(), { timeout: 2_000 }).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("captures the card variants in both themes", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      const { context, page } = await openSidebar(colorScheme);

      try {
        for (const key of [PLAIN_KEY, WORK_KEY]) {
          const row = page.locator(`[data-session-key="${key}"]`);
          await row.hover();
          await expect.poll(() => card(page).count(), { timeout: 3_000 }).toBe(1);
          await captureUiProof(page, `card-${key.split(":").pop()}-${colorScheme}.png`, {
            clip: [row, card(page)],
          });
        }

        // Reaching the row's own controls must not dismiss the card the reader
        // opened, so the frame has to show both at once.
        const workRow = page.locator(`[data-session-key="${WORK_KEY}"]`);
        await workRow.locator("[data-sidebar-session-pin]").hover();
        await expect.poll(() => card(page).count(), { timeout: 3_000 }).toBe(1);
        await captureUiProof(page, `card-pin-hover-${colorScheme}.png`, {
          clip: [workRow, card(page)],
        });

        // An open row menu is the one surface that replaces the card rather
        // than stacking on it.
        await workRow.locator("[data-session-menu]").click();
        const items = page.getByRole("menuitem");
        await items.first().waitFor({ state: "visible" });
        await expect.poll(() => card(page).count(), { timeout: 2_000 }).toBe(0);
        await captureUiProof(page, `card-menu-open-${colorScheme}.png`, {
          clip: [workRow, items.first(), items.last()],
        });
      } finally {
        await context.close();
      }
    }
  });
});
