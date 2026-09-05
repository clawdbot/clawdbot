import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const MAIN_KEY = "agent:main:main";
/** Categorized work sits below the recency cutoff a truncating roster applies,
 *  which is exactly the shape that emptied real sidebar categories. */
const STALE_CATEGORY = "Papercuts";
const FRESH_CATEGORY = "Automated Issue Fixes";
const BASE_TIME = Date.parse("2026-08-27T12:00:00.000Z");

function roster() {
  const rows = [
    sessionRow(MAIN_KEY, "Main", BASE_TIME, { sessionId: "main" }),
    ...Array.from({ length: 2 }, (_value, index) =>
      sessionRow(
        `agent:main:fresh-${index}`,
        `Fresh fix ${index}`,
        BASE_TIME - 1_000 * (index + 1),
        {
          category: FRESH_CATEGORY,
          sessionId: `fresh-${index}`,
        },
      ),
    ),
    // Filler outranks the categorized tail on recency, so a 50/60-row page ends
    // before the stale category is ever reached.
    ...Array.from({ length: 80 }, (_value, index) =>
      sessionRow(
        `agent:main:filler-${index}`,
        `Untitled ${index}`,
        BASE_TIME - 100_000 - index * 1_000,
        {
          sessionId: `filler-${index}`,
        },
      ),
    ),
    ...Array.from({ length: 3 }, (_value, index) =>
      sessionRow(
        `agent:main:stale-${index}`,
        `Papercut ${index}`,
        BASE_TIME - 900_000 - index * 1_000,
        {
          category: STALE_CATEGORY,
          sessionId: `stale-${index}`,
        },
      ),
    ),
  ];
  return rows;
}

function truncated(limit: number) {
  const rows = roster().slice(0, limit);
  return sessionsListResponse(rows, {
    hasMore: true,
    nextOffset: limit,
    totalCount: roster().length,
  });
}

/** Mirrors the gateway: an explicit limit truncates by recency, an absent one
 *  returns the whole roster. */
function rosterMock() {
  return {
    methodResponses: {
      "sessions.list": {
        cases: [
          // Pre-fix builds asked for these; the shipped roster asks for the define.
          { match: { limit: 50 }, response: truncated(50) },
          { match: { limit: 60 }, response: truncated(60) },
          {
            match: { limit: SIDEBAR_SESSION_ROSTER_LIMIT },
            response: sessionsListResponse(roster(), { totalCount: roster().length }),
          },
          { match: {}, response: sessionsListResponse(roster(), { totalCount: roster().length }) },
        ],
      },
      "sessions.groups.list": {
        groups: [
          { name: FRESH_CATEGORY, position: 0 },
          { name: STALE_CATEGORY, position: 1 },
        ],
        sectionOrder: [`category:${FRESH_CATEGORY}`, `category:${STALE_CATEGORY}`, "ungrouped"],
      },
      "sessions.patch": {},
    },
    sessionKey: MAIN_KEY,
  } as const;
}

suite.define(() => {
  it("fills every catalog category instead of leaving the out-of-page ones empty", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, rosterMock());
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.waitFor({ state: "visible", timeout: 10_000 });
      await sidebar
        .getByText(STALE_CATEGORY, { exact: false })
        .first()
        .waitFor({ timeout: 10_000 });
      // Captured before the row assertion so a pre-fix run still produces its
      // own proof image instead of dying at the assertion with nothing to show.
      await captureUiProof(
        suite,
        page,
        `roster-completeness-${process.env.OPENCLAW_ROSTER_PROOF ?? "after"}.png`,
      );
      // The section header renders from the group catalog either way; the proof
      // is that its rows arrived, which a truncated roster cannot deliver.
      await expect
        .poll(() => sidebar.getByText("Papercut 0", { exact: false }).count(), { timeout: 10_000 })
        .toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
