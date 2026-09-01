import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  for (const viewport of [
    { height: 900, label: "desktop", width: 1280 },
    { height: 844, label: "mobile", width: 390 },
  ] as const) {
    it(`keeps archived transcript actions inert on ${viewport.label}`, async () => {
      const context = await suite.browser.newContext({
        locale: "en-US",
        recordVideo: captureUiProofEnabled ? { dir: suite.artifactDir, size: viewport } : undefined,
        serviceWorkers: "block",
        viewport,
      });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(suite.server.baseUrl).origin,
      });
      const page = await context.newPage();
      const proofVideo = page.video();
      const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
      const sessionKey = "agent:main:archive-actions";
      const messageText = "Archive action proof.";
      const session = sessionRow(sessionKey, "Archive actions", baseTime);
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "sessions.branches.list",
          "sessions.branches.switch",
          "sessions.fork",
          "sessions.github.publish",
          "sessions.patch",
          "sessions.rewind",
          SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        ],
        historyMessages: [
          {
            role: "user",
            timestamp: baseTime,
            content: messageText,
            __openclaw: { id: "archive-action-user", seq: 1 },
          },
          {
            role: "assistant",
            timestamp: baseTime + 1,
            content: "Action proof response.",
            __openclaw: { id: "archive-action-assistant", seq: 2 },
          },
        ],
        mainSessionKey: "agent:main:main",
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.branches.list": {
            branches: [
              {
                active: true,
                headline: "Current branch",
                leafEntryId: "archive-action-assistant",
                messageCount: 2,
              },
              {
                active: false,
                headline: "Other branch",
                leafEntryId: "archive-action-other",
                messageCount: 1,
              },
            ],
          },
          "sessions.fork": {
            editorText: messageText,
            sessionKey: "agent:main:dashboard:archive-action-fork",
          },
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:main", "Main", baseTime + 1_000),
            session,
          ]),
        },
        sessionArchiveFiltering: true,
        sessionKey,
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const transcript = activePane.locator(".chat-thread");
        const userBubble = activePane.locator(".chat-group.user .chat-bubble", {
          hasText: messageText,
        });
        await userBubble.waitFor({ state: "visible", timeout: 10_000 });
        expect(await userBubble.getAttribute("data-entry-id")).toBe("archive-action-user");
        const branchTrigger = activePane.locator(".chat-pane__branches-trigger");
        await branchTrigger.waitFor({ state: "visible", timeout: 10_000 });
        expect(await branchTrigger.isDisabled()).toBe(false);

        await gateway.waitForRequest(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [sessionKey]: {
              branch: {
                additions: 4,
                branch: "fix/archive-actions",
                deletions: 1,
                owner: "openclaw",
                repo: "openclaw",
              },
              pullRequests: [],
              rateLimited: false,
              status: "ok",
            },
          },
        });
        await page.getByRole("button", { name: "Publish PR" }).waitFor();

        await userBubble.click({ button: "right" });
        const initialMenu = page.locator(".chat-reply-context-menu");
        await initialMenu.waitFor({ state: "visible" });
        const rewind = initialMenu.getByRole("menuitem", { name: "Rewind to here", exact: true });
        expect(await rewind.count()).toBe(1);
        await rewind.click();
        await page.locator(".chat-confirm-popover").waitFor({ state: "visible" });

        const confirmation = page.locator(".chat-confirm-popover");
        const remember = confirmation.getByRole("checkbox");
        await remember.check();
        expect(await remember.isChecked()).toBe(true);
        await remember.uncheck();
        await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
        await confirmation.waitFor({ state: "detached" });
        expect(await gateway.getRequests("sessions.rewind")).toHaveLength(0);
        expect(await initialMenu.isVisible()).toBe(true);
        expect(await rewind.evaluate((element) => element === document.activeElement)).toBe(true);
        await rewind.click();
        await confirmation.waitFor({ state: "visible" });

        await gateway.emitGatewayEvent("sessions.changed", {
          ...session,
          archived: true,
          archivedAt: baseTime + 2_000,
          reason: "update",
          sessionKey,
        });

        const archivedNotice = activePane.locator(".agent-chat__disabled-banner");
        await archivedNotice.waitFor({ state: "visible", timeout: 10_000 });
        await expect.poll(() => page.locator(".chat-reply-context-menu").count()).toBe(0);
        await expect.poll(() => page.locator(".chat-confirm-popover").count()).toBe(0);
        await expect
          .poll(() => transcript.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await expect.poll(() => branchTrigger.isDisabled()).toBe(true);
        await expect.poll(() => page.getByRole("button", { name: "Publish PR" }).count()).toBe(0);

        await userBubble.evaluate((element) => {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
        await userBubble.click({ button: "right" });
        const menu = page.locator(".chat-reply-context-menu");
        await menu.waitFor({ state: "visible" });
        const actions = menu.locator("button");
        expect(await actions.count()).toBe(2);
        for (const [index, name] of ["Copy", "Fork from here"].entries()) {
          expect(
            await menu
              .getByRole("menuitem", { name, exact: true })
              .evaluate(
                (element, expected) => element === expected,
                await actions.nth(index).elementHandle(),
              ),
          ).toBe(true);
        }
        await captureUiProof(suite, page, `archived-actions-${viewport.label}.png`);
        expect(
          await page.evaluate(() => {
            const portal = document.querySelector<HTMLElement>(".chat-reply-context-menu");
            const rect = portal?.getBoundingClientRect();
            return {
              documentOverflows: document.documentElement.scrollWidth > window.innerWidth,
              menuFits:
                Boolean(rect) &&
                rect!.left >= 0 &&
                rect!.top >= 0 &&
                rect!.right <= window.innerWidth &&
                rect!.bottom <= window.innerHeight,
            };
          }),
        ).toEqual({ documentOverflows: false, menuFits: true });

        await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(messageText);

        await userBubble.click({ button: "right" });
        await page
          .locator(".chat-reply-context-menu")
          .getByRole("menuitem", { name: "Fork from here", exact: true })
          .click();
        const fork = await gateway.waitForRequest("sessions.fork");
        expect(requireRecord(fork.params)).toMatchObject({
          entryId: "archive-action-user",
          sessionKey,
        });
        expect(await gateway.getRequests("sessions.rewind")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      } finally {
        await context.close();
        if (proofVideo) {
          await proofVideo.saveAs(
            path.join(suite.artifactDir, `archived-actions-${viewport.label}.webm`),
          );
        }
      }
    });
  }

  it("shows the archived notice when an archived session is cold-loaded outside the active list", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const archived = sessionRow(
      "agent:main:dashboard:cold-archive",
      "Archived planning",
      Date.parse("2026-07-01T16:00:00.000Z"),
      { archived: true },
    );
    const main = sessionRow("agent:main:main", "Main", archived.updatedAt + 1);
    const gateway = await installMockGateway(page, {
      mainSessionKey: "agent:main:main",
      sessions: [main, archived],
      methodResponses: {
        "sessions.branches.list": {
          branches: [
            { active: true, headline: "Current branch", leafEntryId: "current", messageCount: 2 },
            { active: false, headline: "Other branch", leafEntryId: "other", messageCount: 1 },
          ],
        },
        "sessions.list": sessionsListResponse([main]),
        "sessions.patch": {},
      },
      sessionArchiveFiltering: true,
      sessionKey: archived.key,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat?session=${encodeURIComponent(archived.key)}`);
      const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");

      const selectedRow = page.locator(
        `.sidebar-recent-session[data-session-key="${archived.key}"]`,
      );
      await selectedRow.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => selectedRow.getAttribute("class"))
        .toContain("sidebar-recent-session--active");
      await selectedRow.locator(".sidebar-session__archive-glyph").waitFor({ state: "visible" });
      await expect.poll(() => page.getByText("Archived planning", { exact: true }).count()).toBe(2);

      const archivedNotice = activePane.locator(".agent-chat__disabled-banner");
      await archivedNotice.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => archivedNotice.textContent()).toContain("This session is archived.");
      await expect.poll(() => activePane.locator(".agent-chat__input").count()).toBe(0);
      await expect
        .poll(() => activePane.locator(".chat-pane__branches-trigger").isDisabled())
        .toBe(true);
      expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(0);

      await activateSelfRemovingControl(archivedNotice.getByRole("button", { name: "Unarchive" }));
      await waitForPatch(
        gateway,
        (params) => params.key === archived.key && params.archived === false,
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        ...archived,
        archived: false,
        archivedAt: undefined,
        reason: "update",
        sessionKey: archived.key,
      });

      await archivedNotice.waitFor({ state: "detached", timeout: 10_000 });
      await activePane.locator(".agent-chat__input textarea").waitFor({ state: "visible" });
      await expect
        .poll(() =>
          activePane.evaluate(
            (element) => (element as HTMLElement & { sessionKey?: string }).sessionKey,
          ),
        )
        .toBe(archived.key);
    } finally {
      await context.close();
    }
  });
});
