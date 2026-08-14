import { expect, it } from "vitest";
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

const OPENCLAW_ROOT = "/Users/ada/code/openclaw";
const CLAWHUB_ROOT = "/Users/ada/code/clawhub";
const ANCHOR_KEY = "agent:main:anchor";

/**
 * Two real projects, a session in its own checkout, a long branch, and a
 * duplicated name — the states a project hierarchy has to survive.
 */
function hierarchyFixture() {
  return sessionsListResponse([
    sessionRow(ANCHOR_KEY, "Release notes", 9),
    sessionRow("agent:main:oc-branch", "Sidebar rework", 8, {
      worktree: { id: "wt-1", branch: "feature/sidebar", repoRoot: OPENCLAW_ROOT },
    }),
    sessionRow("agent:main:oc-worktree", "Isolated work", 7, {
      worktree: {
        id: "wt-2",
        branch: "openclaw/session-information-cards",
        repoRoot: OPENCLAW_ROOT,
      },
    }),
    sessionRow("agent:main:oc-copy", "Sidebar rework (2)", 6, {
      worktree: { id: "wt-3", branch: "feature/sidebar-copy", repoRoot: OPENCLAW_ROOT },
    }),
    sessionRow("agent:main:ch-branch", "Publish flow", 5, {
      worktree: { id: "wt-4", branch: "main", repoRoot: CLAWHUB_ROOT },
    }),
    sessionRow("agent:main:remote", "Remote work", 4, { execNode: "node-b" }),
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
    methodResponses: { "sessions.list": hierarchyFixture() },
    sessionKey: ANCHOR_KEY,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, ANCHOR_KEY));
  await page.locator("[data-session-work-project]").first().waitFor({ state: "visible" });
  return { context, page };
}

suite.define(() => {
  it("separates the projects being worked on and keeps factless work flat", async () => {
    const { context, page } = await openSidebar();

    try {
      const projects = page.locator("[data-session-work-project]");
      await expect.poll(() => projects.count()).toBe(2);
      expect(
        await projects.locator(".sidebar-session-catalog-project__label").allTextContents(),
      ).toEqual(["openclaw", "clawhub"]);
      // A project heading counts nothing: its rows are listed right beneath it.
      expect(await projects.locator(".sidebar-session-group-count").count()).toBe(0);
      expect(
        await page
          .locator('[data-session-work-project] [data-session-key="agent:main:remote"]')
          .count(),
      ).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("marks Git facts and never fades away the worktree marker", async () => {
    const { context, page } = await openSidebar();

    try {
      const worktreeRow = page.locator('[data-session-key="agent:main:oc-worktree"]');
      const marker = worktreeRow.locator(".session-row-worktree-glyph");
      const text = worktreeRow.locator(".sidebar-recent-session__subtitle-text");
      await marker.waitFor({ state: "visible" });

      // The branch text is what runs out of room; the marker holds its slot.
      const markerBox = await marker.boundingBox();
      const textBox = await text.boundingBox();
      expect(markerBox?.width).toBeGreaterThan(0);
      expect(markerBox?.x ?? 0).toBeGreaterThan((textBox?.x ?? 0) + (textBox?.width ?? 0) - 1);
      expect(await worktreeRow.locator(".session-row-git-glyph").count()).toBe(1);

      // A row inside the openclaw group does not repeat "openclaw".
      expect(await text.textContent()).toBe("session-information-cards");
    } finally {
      await context.close();
    }
  });

  it("captures the hierarchy in both themes, open and collapsed", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      const { context, page } = await openSidebar(colorScheme);

      try {
        const coding = page.locator('[data-session-section="work"]');
        const openclaw = page.locator(`[data-session-work-project="${OPENCLAW_ROOT}"]`);
        const clawhub = page.locator(`[data-session-work-project="${CLAWHUB_ROOT}"]`);
        const tail = coding.locator('[data-session-key="agent:main:remote"]');

        await captureUiProof(page, `hierarchy-open-${colorScheme}.png`, { clip: [coding] });
        // A project that owns several checkouts, framed on its own: the branch
        // row, the worktree marker, and the duplicated name in one group.
        await captureUiProof(page, `hierarchy-project-openclaw-${colorScheme}.png`, {
          clip: [openclaw],
        });
        // The flat tail belongs to no project; framed with the last group so the
        // frame shows it sitting outside one rather than inside it.
        await captureUiProof(page, `hierarchy-ungrouped-${colorScheme}.png`, {
          clip: [clawhub, tail],
        });

        const projectHead = openclaw.locator(".sidebar-session-catalog-project__head");
        await projectHead.click();
        await expect.poll(() => projectHead.getAttribute("aria-expanded")).toBe("false");
        await captureUiProof(page, `hierarchy-project-collapsed-${colorScheme}.png`, {
          clip: [coding],
        });

        const codingHead = coding.locator(
          ".sidebar-recent-sessions__head .sidebar-session-group-toggle",
        );
        await codingHead.click();
        await expect.poll(() => codingHead.getAttribute("aria-expanded")).toBe("false");
        await captureUiProof(page, `hierarchy-section-collapsed-${colorScheme}.png`, {
          clip: [coding],
        });
      } finally {
        await context.close();
      }
    }
  });
});
