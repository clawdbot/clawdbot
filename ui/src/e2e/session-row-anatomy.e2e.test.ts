import { expect, it } from "vitest";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const OPEN_KEY = "agent:main:open";
const QUIET_KEY = "agent:main:quiet";
const RUNNING_KEY = "agent:main:running";
const UNREAD_KEY = "agent:main:unread";
const BLOCKED_KEY = "agent:main:blocked";
const PINNED_KEY = "agent:main:pinned";
const CREATOR_KEY = "agent:main:creator";
const DRAFT_KEY = "agent:main:draft";
const INCOGNITO_KEY = "agent:main:incognito";
const COMPOUND_KEY = "agent:main:compound";
const PARENT_KEY = "agent:main:parent";
const CHILD_RUNNING_KEY = "agent:main:child-running";
const CHILD_UNREAD_KEY = "agent:main:child-unread";
const CHILD_BLOCKED_KEY = "agent:main:child-blocked";

const ADA = { id: "ada", label: "Ada Lovelace" };
const SOL = { id: "sol", label: "Sol Reyes" };

/**
 * Every state a row can report, every origin it can carry, and none of them
 * twice. Two distinct creators are what makes ownership visible at all, so the
 * creator rows carry different actors rather than the same one.
 */
function anatomyFixture() {
  return sessionsListResponse([
    { ...sessionRow(OPEN_KEY, "Release notes", 20, { unread: true }), lastReadAt: 0 },
    sessionRow(QUIET_KEY, "Weekly digest", 19),
    sessionRow(RUNNING_KEY, "Reindexing the archive", 18, {
      hasActiveRun: true,
      status: "running",
    }),
    sessionRow(UNREAD_KEY, "Nightly export finished", 17, { unread: true }),
    sessionRow(BLOCKED_KEY, "Deploy check", 16, { status: "failed" }),
    sessionRow(PINNED_KEY, "Runbook", 15, { pinned: true, pinnedAt: 1 }),
    { ...sessionRow(CREATOR_KEY, "Handover notes", 14), createdActor: ADA },
    { ...sessionRow(DRAFT_KEY, "Untitled plan", 13), createdActor: SOL, visibility: "draft" },
    { ...sessionRow(INCOGNITO_KEY, "Private research", 12), incognito: true },
    { ...sessionRow(COMPOUND_KEY, "Sealed review", 11), createdActor: ADA, incognito: true },
    sessionRow(PARENT_KEY, "Plan the release", 10, {
      childSessions: [CHILD_RUNNING_KEY, CHILD_UNREAD_KEY, CHILD_BLOCKED_KEY],
    }),
  ]);
}

function childFixture() {
  return sessionsListResponse([
    sessionRow(CHILD_RUNNING_KEY, "Research sources", 9, {
      hasActiveRun: true,
      spawnedBy: PARENT_KEY,
      status: "running",
    }),
    sessionRow(CHILD_UNREAD_KEY, "Verify tests", 8, {
      spawnedBy: PARENT_KEY,
      status: "done",
      unread: true,
    }),
    sessionRow(CHILD_BLOCKED_KEY, "Publish artifacts", 7, {
      spawnedBy: PARENT_KEY,
      status: "failed",
    }),
  ]);
}

const APPROVAL_KEY = "agent:main:approval";
const ORDINARY_KEY = "agent:main:ordinary";

/**
 * A waiting session beside an ordinary one. The comparison row is the point: a
 * frame of the approval alone cannot show that the subtitle reads differently
 * from every other subtitle in the list.
 */
function approvalFixture() {
  return sessionsListResponse([
    sessionRow(APPROVAL_KEY, "Rotate the signing key", 21),
    {
      ...sessionRow(ORDINARY_KEY, "Draft the migration note", 20),
      lastMessagePreview: "Rewrote the rollback steps",
    },
  ]);
}

/**
 * Routes to the approving session on purpose: an approval for any other session
 * opens the approval modal, which would cover the sidebar this frame is of.
 */
async function openApprovalSidebar(colorScheme: "light" | "dark") {
  const context = await suite.browser.newContext({
    colorScheme,
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 1000, width: 1280 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    methodResponses: { "sessions.list": approvalFixture() },
    sessionKey: APPROVAL_KEY,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, APPROVAL_KEY));
  await page.locator(`[data-session-key="${ORDINARY_KEY}"]`).waitFor({ state: "visible" });
  await gateway.emitGatewayEvent("exec.approval.requested", {
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    id: "approval-1",
    kind: "exec",
    request: { command: "openclaw keys rotate --signing", sessionKey: APPROVAL_KEY },
  });
  return { context, page };
}

async function openSidebar(colorScheme: "light" | "dark") {
  const context = await suite.browser.newContext({
    colorScheme,
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 1000, width: 1280 },
  });
  const page = await context.newPage();
  await installMockGateway(page, {
    methodResponses: {
      "sessions.list": {
        cases: [
          { match: { spawnedBy: PARENT_KEY }, response: childFixture() },
          { response: anatomyFixture() },
        ],
      },
    },
    sessionKey: OPEN_KEY,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, OPEN_KEY));
  await page.locator(`[data-session-key="${PARENT_KEY}"]`).waitFor({ state: "visible" });
  return { context, page };
}

function row(page: Awaited<ReturnType<typeof openSidebar>>["page"], key: string) {
  return page.locator(`[data-session-key="${key}"]`);
}

for (const colorScheme of ["light", "dark"] as const) {
  suite.define(() => {
    it(`reports exactly one state per row in ${colorScheme}`, async () => {
      const { context, page } = await openSidebar(colorScheme);

      try {
        // A row with nothing to report renders no state element at all: the
        // absence is what leaves its title the full resting width.
        expect(await row(page, QUIET_KEY).locator(".session-row-state").count()).toBe(0);
        await expect
          .poll(() => row(page, RUNNING_KEY).locator(".session-run-spinner").count())
          .toBe(1);
        await expect
          .poll(() => row(page, UNREAD_KEY).locator(".session-state-dot--unread").count())
          .toBe(1);
        await expect
          .poll(() => row(page, BLOCKED_KEY).locator(".session-state-dot--blocked").count())
          .toBe(1);
        // Opening a session consumes the attention it was carrying; the row it
        // is opened from must not keep advertising an unread it already showed.
        expect(await row(page, OPEN_KEY).locator(".session-row-state").count()).toBe(0);

        await captureUiProof(page, `row-state-matrix-${colorScheme}.png`, {
          clip: [row(page, PINNED_KEY), row(page, BLOCKED_KEY)],
        });
      } finally {
        await context.close();
      }
    });

    it(`spends width on origin only when a session has one in ${colorScheme}`, async () => {
      const { context, page } = await openSidebar(colorScheme);

      try {
        // Absent origin is not an empty slot: nothing is rendered, so the title
        // starts on the same axis as a row that has no origin to show.
        expect(await row(page, QUIET_KEY).locator(".session-row-origin").count()).toBe(0);
        // Two distinct creators make ownership visible, so a creator-only row
        // shows its owner chip and nothing else.
        const creatorOrigin = row(page, CREATOR_KEY).locator(".session-row-origin");
        await expect
          .poll(() => creatorOrigin.locator("openclaw-session-owner-chip").count())
          .toBe(1);
        expect(await creatorOrigin.locator(".session-row-origin__qualifier").count()).toBe(0);
        expect(await creatorOrigin.locator(".session-row-origin__draft").count()).toBe(0);

        expect(await row(page, DRAFT_KEY).locator(".session-row-origin__draft").count()).toBe(1);
        // Incognito-only is the qualifier alone, with no owner chip beside it.
        const incognitoOrigin = row(page, INCOGNITO_KEY).locator(".session-row-origin");
        expect(await incognitoOrigin.locator(".session-row-origin__qualifier").count()).toBe(1);
        expect(await incognitoOrigin.locator("openclaw-session-owner-chip").count()).toBe(0);

        // Creator plus a privacy qualifier collapses into one compound origin,
        // creator first, rather than two badges competing for the same space.
        const compound = row(page, COMPOUND_KEY).locator(".session-row-origin");
        expect(await compound.locator("openclaw-session-owner-chip").count()).toBe(1);
        expect(await compound.locator(".session-row-origin__qualifier").count()).toBe(1);

        await captureUiProof(page, `row-origin-matrix-${colorScheme}.png`, {
          clip: [row(page, CREATOR_KEY), row(page, COMPOUND_KEY)],
        });
      } finally {
        await context.close();
      }
    });

    it(`keeps child rows to one state and nothing else in ${colorScheme}`, async () => {
      const { context, page } = await openSidebar(colorScheme);

      try {
        const parent = row(page, PARENT_KEY);
        await parent.getByRole("button", { name: /child sessions/ }).click();
        const children = page.locator(".sidebar-recent-session--child");
        await expect.poll(() => children.count()).toBe(3);

        await expect
          .poll(() => row(page, CHILD_RUNNING_KEY).locator(".session-run-spinner").count())
          .toBe(1);
        await expect
          .poll(() => row(page, CHILD_UNREAD_KEY).locator(".session-state-dot--unread").count())
          .toBe(1);
        await expect
          .poll(() => row(page, CHILD_BLOCKED_KEY).locator(".session-state-dot--blocked").count())
          .toBe(1);
        // A child says only what it is doing: no subtitle, no duration, no menu.
        expect(await children.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
        expect(await children.locator("openclaw-elapsed-time").count()).toBe(0);

        await captureUiProof(page, `row-children-${colorScheme}.png`, {
          clip: [parent, row(page, CHILD_BLOCKED_KEY)],
        });
      } finally {
        await context.close();
      }
    });

    it(`hands the endcap to the actions on hover in ${colorScheme}`, async () => {
      const { context, page } = await openSidebar(colorScheme);

      try {
        const target = row(page, RUNNING_KEY);
        await captureUiProof(page, `row-endcap-rest-${colorScheme}.png`, { clip: [target] });

        await target.hover();
        const menu = target.getByRole("button", { name: "Open session menu" });
        await expect
          .poll(() => menu.evaluate((element) => globalThis.getComputedStyle(element).opacity))
          .toBe("1");
        await captureUiProof(page, `row-endcap-hover-${colorScheme}.png`, { clip: [target] });
      } finally {
        await context.close();
      }
    });

    it(`asks in the subtitle while an approval waits in ${colorScheme}`, async () => {
      const { context, page } = await openApprovalSidebar(colorScheme);

      try {
        const target = row(page, APPROVAL_KEY);
        const asking = target.locator(".sidebar-recent-session__subtitle--approval");
        await expect.poll(() => asking.count()).toBe(1);
        await expect.poll(() => asking.textContent()).toBe("Waiting for approval");
        // The subtitle already says it, so the key glyph would be the same fact
        // twice in one row.
        expect(await target.locator('[data-session-attention="approval"]').count()).toBe(0);
        // The marking belongs to the request, not to subtitles in general.
        const ordinary = row(page, ORDINARY_KEY);
        expect(await ordinary.locator(".sidebar-recent-session__subtitle").count()).toBe(1);
        expect(await ordinary.locator(".sidebar-recent-session__subtitle--approval").count()).toBe(
          0,
        );

        // A still of an endless sweep has to choose a moment. Hold the shipped
        // animation at 900ms of its 1800ms travel, where the band is crossing
        // the text, rather than letting the capture cancel it to frame zero.
        await asking.evaluate((element) => {
          const [sweep] = element.getAnimations();
          sweep?.pause();
          if (sweep) {
            sweep.currentTime = 900;
          }
        });
        await captureUiProof(page, `row-approval-${colorScheme}.png`, {
          clip: [target, ordinary],
          keepAnimations: true,
        });
      } finally {
        await context.close();
      }
    });
  });
}
