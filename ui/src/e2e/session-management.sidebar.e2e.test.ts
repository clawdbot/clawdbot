import path from "node:path";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import {
  actionOpacity,
  actionPointerEvents,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
  trimmedTextContents,
  uiProofArtifactDir,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("shows an unsent-draft pencil after switching sessions and removes it after clearing", async () => {
    const firstKey = "agent:main:draft-first";
    const secondKey = "agent:main:draft-second";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(firstKey, "Draft first", 2),
          sessionRow(secondKey, "Draft second", 1),
        ]),
      },
      sessionKey: firstKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstKey));
      const firstRow = page.locator(`[data-session-key="${firstKey}"]`);
      const secondRow = page.locator(`[data-session-key="${secondKey}"]`);
      const composer = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox > textarea',
      );
      await firstRow.waitFor({ state: "visible", timeout: 10_000 });
      await secondRow.waitFor({ state: "visible" });
      await composer.waitFor({ state: "visible" });
      await captureUiProof(page, "draft-indicator-before.png");

      await composer.fill("Keep this unsent");
      await secondRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(secondKey));
      await firstRow.getByRole("img", { name: "Unsent draft" }).waitFor();
      await captureUiProof(page, "draft-indicator-after.png");

      await firstRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(firstKey));
      expect(await firstRow.getByRole("img", { name: "Unsent draft" }).count()).toBe(0);

      await composer.fill("");
      await secondRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(secondKey));
      await expect.poll(() => firstRow.getByRole("img", { name: "Unsent draft" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("expands and manages child sessions inline before opening a child chat", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const parentKey = "agent:main:release-plan";
    const childOneKey = "agent:main:research-sources";
    const childTwoKey = "agent:main:verify-tests";
    const staleRunningChildKey = "agent:main:stale-running";
    const failedChildKey = "agent:main:failed-checks";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { spawnedBy: parentKey },
              response: sessionsListResponse([
                sessionRow(childOneKey, "Research sources", baseTime - 1_000, {
                  hasActiveRun: true,
                  spawnedBy: parentKey,
                  startedAt: baseTime - 61_000,
                  status: "running",
                }),
                sessionRow(childTwoKey, "Verify tests", baseTime - 2_000, {
                  endedAt: baseTime - 2_000,
                  spawnedBy: parentKey,
                  startedAt: baseTime - 62_000,
                  status: "done",
                }),
                {
                  ...sessionRow(staleRunningChildKey, "Stale activity", baseTime - 3_000, {
                    hasActiveRun: false,
                    spawnedBy: parentKey,
                    startedAt: baseTime - 64_000,
                    status: "running",
                  }),
                  runtimeMs: 61_000,
                  runtimeSampledAt: baseTime,
                },
                {
                  ...sessionRow(failedChildKey, "Failed checks", baseTime - 4_000, {
                    endedAt: baseTime - 4_000,
                    hasActiveRun: true,
                    spawnedBy: parentKey,
                    startedAt: baseTime - 64_000,
                    status: "failed",
                  }),
                  lastReadAt: baseTime,
                  runtimeMs: 60_000,
                  runtimeSampledAt: baseTime,
                },
              ]),
            },
            {
              response: sessionsListResponse([
                sessionRow(parentKey, "Plan release", baseTime, {
                  childSessions: [childOneKey, childTwoKey, staleRunningChildKey, failedChildKey],
                }),
              ]),
            },
          ],
        },
      },
      sessionKey: parentKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const parent = page.locator(`[data-session-key="${parentKey}"]`);
      await parent.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => page.locator(".sidebar-recent-session--child").count()).toBe(0);
      await captureUiProof(page, "child-sessions-collapsed.png");

      await parent.getByRole("button", { name: "Show 4 child sessions for Plan release" }).click();
      await page.getByText("Research sources", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("Verify tests", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("Stale activity", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("Failed checks", { exact: true }).waitFor({ state: "visible" });
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) => requireRecord(request.params).spawnedBy === parentKey,
          ),
        )
        .toBe(true);

      const childRows = page.locator(".sidebar-recent-session--child");
      await expect.poll(() => childRows.count()).toBe(4);
      expect(await childRows.getByRole("button", { name: "Open session menu" }).count()).toBe(4);
      await childRows.nth(0).getByRole("img", { name: "Active run" }).waitFor();
      await childRows.nth(1).getByRole("img", { name: "Done" }).waitFor();

      const staleRunningChild = page.locator(`[data-session-key="${staleRunningChildKey}"]`);
      const failedChild = page.locator(`[data-session-key="${failedChildKey}"]`);
      expect(await staleRunningChild.getByRole("img", { name: "Active run" }).count()).toBe(0);
      expect(await failedChild.getByRole("img", { name: "Active run" }).count()).toBe(0);
      await failedChild.getByRole("img", { name: "Failed" }).waitFor();
      await expect.poll(() => childRows.getByRole("img", { name: "Active run" }).count()).toBe(1);

      const childToggle = parent.locator(`[data-child-session-toggle="${parentKey}"]`);
      expect(await childToggle.getAttribute("class")).toContain(
        "sidebar-child-session-toggle--running",
      );
      for (const child of [staleRunningChild, failedChild]) {
        expect(await child.locator("openclaw-elapsed-time").count()).toBe(0);
        expect((await child.locator(".session-row-trail").textContent())?.trim()).toBeTruthy();
      }
      await captureUiProof(page, "child-sessions-expanded.png");
      await captureUiProof(page, "child-sessions-run-state-precedence.png");

      const completedChild = childRows.nth(1);
      const childMenuButton = completedChild.getByRole("button", {
        name: "Open session menu: Verify tests",
        exact: true,
      });
      await completedChild.hover();
      await expect.poll(() => actionOpacity(childMenuButton)).toBe("1");
      await expect.poll(() => actionPointerEvents(childMenuButton)).toBe("auto");
      await childMenuButton.click();
      const childMenu = page.getByRole("menu", { name: "Actions for Verify tests" });
      await childMenu.waitFor({ state: "visible" });
      await page.getByRole("menuitem", { name: "Mark as unread" }).waitFor();
      await page.getByRole("menuitem", { name: "Rename…" }).waitFor();
      await page.getByRole("menuitem", { name: "Set icon" }).waitFor();
      await page.getByRole("menuitem", { name: "Fork" }).waitFor();
      await page.getByRole("menuitem", { name: "Archive session" }).waitFor();
      await page.getByRole("menuitem", { name: "Delete…" }).waitFor();
      expect(await page.getByRole("menuitem", { name: "Pin session" }).count()).toBe(0);
      expect(await page.getByRole("menuitem", { name: "Move to group" }).count()).toBe(0);
      await captureUiProof(page, "child-session-menu.png");
      await page.keyboard.press("Escape");
      await childMenu.waitFor({ state: "detached" });

      await childRows.nth(1).getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(childTwoKey));
    } finally {
      await context.close();
    }
  });

  it("dismisses fixed session menus before the sidebar or drawer hides", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(
            "agent:main:research",
            "Research notes",
            Date.parse("2026-07-01T15:00:00.000Z"),
          ),
        ]),
        "sessions.patch": {},
      },
      sessionKey: "agent:main:main",
    });
    // Control UI confirms in-app; a native dialog here would be a regression.
    const nativeDialogs: string[] = [];
    page.on("dialog", (dialog) => {
      nativeDialogs.push(dialog.message());
      void dialog.dismiss();
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const row = sidebar.locator(
        '.sidebar-recent-session[data-session-key="agent:main:research"]',
      );
      const shell = page.locator(".shell");
      const shellNav = page.locator(".shell-nav");
      const collapseButton = page
        .locator(".shell-chrome-controls")
        .getByRole("button", { name: "Collapse sidebar" });
      const expandButton = page.locator(".shell-chrome-controls__nav-toggle");
      const drawerToggle = page
        .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
        .first();
      const sessionMenu = page.getByRole("menu", { name: "Actions for Research notes" });
      await row.waitFor({ state: "visible", timeout: 10_000 });

      const openSessionMenu = async () => {
        await row.hover();
        await row.getByRole("button", { name: "Open session menu" }).click();
        await page
          .getByRole("menu", { name: "Actions for Research notes" })
          .waitFor({ state: "visible" });
      };
      const expectDesktopCollapsed = async () => {
        await expect.poll(() => sidebar.isVisible()).toBe(false);
        await expect.poll(() => expandButton.isVisible()).toBe(true);
        await expect
          .poll(() => expandButton.evaluate((element) => element === document.activeElement))
          .toBe(true);
      };
      const expectDrawerClosed = async () => {
        await expect
          .poll(() => shell.getAttribute("class"))
          .not.toContain("shell--nav-drawer-open");
        await expect
          .poll(() => shellNav.evaluate((element) => element.getBoundingClientRect().right))
          .toBeLessThanOrEqual(0);
      };
      const hiddenActionCounts = async () => ({
        confirms: await page.locator("openclaw-modal-dialog .exec-approval-actions").count(),
        nativeDialogs: nativeDialogs.length,
        patches: (await gateway.getRequests("sessions.patch")).length,
      });
      const expectHiddenShortcutsInert = async (
        before: Awaited<ReturnType<typeof hiddenActionCounts>>,
      ) => {
        for (const shortcut of ["p", "a", "d"] as const) {
          await page.keyboard.press(shortcut);
        }
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        expect(await hiddenActionCounts()).toEqual(before);
      };

      // Keyboard collapse bypasses the menu's outside-pointer handler. The shell
      // must explicitly unmount it before the sidebar becomes display:none.
      await openSessionMenu();
      const beforeKeyboardCollapse = await hiddenActionCounts();
      await page.keyboard.press("Meta+B");
      await expectDesktopCollapsed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expectHiddenShortcutsInert(beforeKeyboardCollapse);

      await expandButton.click();
      await expect.poll(() => sidebar.isVisible()).toBe(true);

      // The visible desktop control follows the same focus handoff contract.
      await openSessionMenu();
      await collapseButton.click();
      await expectDesktopCollapsed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expandButton.click();
      await expect.poll(() => sidebar.isVisible()).toBe(true);

      // Crossing into drawer layout hides the desktop sidebar without toggling
      // persisted collapse state, so resize owns this dismissal and focus move.
      await openSessionMenu();
      const beforeNarrowTransition = await hiddenActionCounts();
      await page.setViewportSize({ height: 900, width: 900 });
      await expectDrawerClosed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expect
        .poll(() => drawerToggle.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await expectHiddenShortcutsInert(beforeNarrowTransition);

      await drawerToggle.click();
      await expect.poll(() => shell.getAttribute("class")).toContain("shell--nav-drawer-open");
      await expect
        .poll(() => shellNav.evaluate((element) => element.getBoundingClientRect().left))
        .toBe(0);

      // Leaving an open drawer must close its fixed menu and clear the drawer
      // before the same sidebar moves back into the desktop navigation slot.
      await openSessionMenu();
      const beforeWideTransition = await hiddenActionCounts();
      await page.setViewportSize({ height: 900, width: 1280 });
      await expect.poll(() => shell.getAttribute("class")).not.toContain("shell--mobile-nav");
      await expect.poll(() => shell.getAttribute("class")).not.toContain("shell--nav-drawer-open");
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expectHiddenShortcutsInert(beforeWideTransition);

      // Returning to drawer layout must not resurrect the prior open drawer.
      await page.setViewportSize({ height: 900, width: 900 });
      await expectDrawerClosed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await drawerToggle.click();
      await expect.poll(() => shell.getAttribute("class")).toContain("shell--nav-drawer-open");
      await expect
        .poll(() => shellNav.evaluate((element) => element.getBoundingClientRect().left))
        .toBe(0);
      await openSessionMenu();
      const beforeDrawerCollapse = await hiddenActionCounts();
      await page.keyboard.press("Meta+B");
      await expectDrawerClosed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expect
        .poll(() => drawerToggle.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await expectHiddenShortcutsInert(beforeDrawerCollapse);
    } finally {
      await context.close();
    }
  });

  it("names session-row actions and tabs from their menu into the next visible session", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(
            "agent:main:research",
            "Research notes",
            Date.parse("2026-07-01T15:00:00.000Z"),
          ),
          sessionRow(
            "agent:main:follow-up",
            "Follow-up work",
            Date.parse("2026-07-01T14:00:00.000Z"),
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const researchRow = page.locator('[data-session-key="agent:main:research"]');
      const followUpRow = page.locator('[data-session-key="agent:main:follow-up"]');
      const researchMenu = researchRow.getByRole("button", {
        name: "Open session menu: Research notes",
        exact: true,
      });
      await researchRow
        .getByRole("button", { name: "Pin session: Research notes", exact: true })
        .waitFor();
      await followUpRow
        .getByRole("button", { name: "Open session menu: Follow-up work", exact: true })
        .waitFor();

      await researchMenu.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: "Actions for Research notes" });
      await menu.waitFor({ state: "visible" });

      await expect
        .poll(() =>
          page
            .locator("openclaw-session-menu")
            .getByRole("menuitem", { name: "Pin session" })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press("Tab");

      await expect.poll(() => menu.count()).toBe(0);
      await expect
        .poll(() =>
          followUpRow
            .locator(".sidebar-recent-session__link")
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);

      await researchRow.locator(".sidebar-recent-session__link").focus();
      await page.keyboard.press("Shift+F10");
      await menu.waitFor({ state: "visible" });
      await expect
        .poll(() =>
          page
            .locator("openclaw-session-menu")
            .getByRole("menuitem", { name: "Pin session" })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press("Tab");

      await expect.poll(() => menu.count()).toBe(0);
      await expect
        .poll(() =>
          followUpRow
            .locator(".sidebar-recent-session__link")
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("keeps sidebar sessions visible through a same-client Gateway reconnect", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:disconnect-proof";
    const otherSessionKeys = ["agent:main:other-a", "agent:main:other-b"] as const;
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(sessionKey, "Disconnect proof", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(otherSessionKeys[0], "Other A", Date.parse("2026-07-01T15:59:00.000Z")),
          sessionRow(otherSessionKeys[1], "Other B", Date.parse("2026-07-01T15:58:00.000Z")),
        ]),
      },
      sessionKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebarRow = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      await sidebarRow.waitFor({ state: "visible", timeout: 10_000 });
      const sidebarRows = page.locator(".sidebar-recent-session");
      await expect.poll(() => sidebarRows.count()).toBe(3);
      const initialListCount = (await gateway.getRequests("sessions.list")).length;

      const socketsBefore = await gateway.getSocketCount();
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await expect.poll(() => sidebarRow.textContent()).toContain("Disconnect proof");
      await expect.poll(() => sidebarRows.count()).toBe(3);
      for (const otherKey of otherSessionKeys) {
        await page
          .locator(`.sidebar-recent-session[data-session-key="${otherKey}"]`)
          .waitFor({ state: "visible" });
      }
      await captureUiProof(page, "sidebar-sessions-during-reconnect.png");

      await expect
        .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
        .toBe(socketsBefore + 1);
      await gateway.deferNext("sessions.list", { includeLastMessage: true });
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length, { timeout: 15_000 })
        .toBeGreaterThan(initialListCount);
      await sidebarRow.waitFor({ state: "visible" });
      expect(await sidebarRows.count()).toBe(3);
      for (const otherKey of otherSessionKeys) {
        await page
          .locator(`.sidebar-recent-session[data-session-key="${otherKey}"]`)
          .waitFor({ state: "visible" });
      }

      const firstReconnectListCount = (await gateway.getRequests("sessions.list")).length;
      const refreshedResponse = sessionsListResponse([
        sessionRow(sessionKey, "Reconnect refreshed", Date.parse("2026-07-01T16:01:00.000Z")),
        sessionRow(otherSessionKeys[0], "Other A", Date.parse("2026-07-01T15:59:00.000Z")),
        sessionRow(otherSessionKeys[1], "Other B", Date.parse("2026-07-01T15:58:00.000Z")),
      ]);
      await gateway.resolveDeferred("sessions.list", refreshedResponse);
      await expect.poll(() => sidebarRow.textContent()).toContain("Reconnect refreshed");
      await expect.poll(() => sidebarRows.count()).toBe(3);
      await expectRequestCountStable(gateway, "sessions.list", firstReconnectListCount);
    } finally {
      await context.close();
    }
  });

  it("retains the selected session and one observer while reconnecting across route changes", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const firstKey = "agent:main:reconnect-first";
    const selectedKey = "agent:main:reconnect-selected";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(firstKey, "First session", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(selectedKey, "Selected session", Date.parse("2026-07-01T15:59:00.000Z")),
        ]),
      },
      sessionKey: firstKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstKey));
      const firstRow = page.locator(`.sidebar-recent-session[data-session-key="${firstKey}"]`);
      const selectedRow = page.locator(
        `.sidebar-recent-session[data-session-key="${selectedKey}"]`,
      );
      await firstRow.waitFor({ state: "visible", timeout: 10_000 });
      await selectedRow.waitFor({ state: "visible" });
      await gateway.waitForRequest("sessions.subscribe");

      await selectedRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(selectedKey));
      await expect.poll(() => selectedRow.getAttribute("class")).toContain("--active");
      const initialObserverCount = (await gateway.getRequests("sessions.subscribe")).length;
      const initialListCount = (await gateway.getRequests("sessions.list")).length;

      const socketsBefore = await gateway.getSocketCount();
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await expect.poll(() => selectedRow.getAttribute("class")).toContain("--active");
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(selectedKey));
      await expect
        .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
        .toBe(socketsBefore + 1);
      await gateway.deferNext("sessions.subscribe");
      await gateway.deferNext("sessions.list", { includeLastMessage: true });
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.subscribe")).length, {
          timeout: 15_000,
        })
        .toBe(initialObserverCount + 1);

      await firstRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(firstKey));
      await selectedRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(selectedKey));
      expect(await gateway.getRequests("sessions.subscribe")).toHaveLength(
        initialObserverCount + 1,
      );

      await gateway.resolveDeferred("sessions.subscribe", { subscribed: true });
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list"))
            .slice(initialListCount)
            .some((request) => requireRecord(request.params).includeLastMessage === true),
        )
        .toBe(true);
      await gateway.resolveDeferred(
        "sessions.list",
        sessionsListResponse([
          sessionRow(firstKey, "First session", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(
            selectedKey,
            "Selected session recovered",
            Date.parse("2026-07-01T16:01:00.000Z"),
          ),
        ]),
      );
      await expect.poll(() => selectedRow.textContent()).toContain("Selected session recovered");
      await expect.poll(() => selectedRow.getAttribute("class")).toContain("--active");
      await expect.poll(() => page.locator(".sidebar-recent-session--active").count()).toBe(1);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(selectedKey));
      expect(await gateway.getRequests("sessions.subscribe")).toHaveLength(
        initialObserverCount + 1,
      );
      await captureUiProof(page, "sidebar-selected-session-route-reconnect.png");
    } finally {
      await context.close();
    }
  });

  it("does not duplicate the active chat when its only session is pinned", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:pinned", "Pinned only", Date.parse("2026-07-01T16:00:00.000Z"), {
            pinned: true,
          }),
        ]),
        "sessions.patch": {},
      },
      sessionKey: "agent:main:pinned",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const pinnedEntry = page.locator('[data-sidebar-entry="session:agent:main:pinned"]');
      const chatsGroup = page.locator('[data-session-section="ungrouped"]');
      await expect
        .poll(() => trimmedTextContents(pinnedEntry.locator(".sidebar-recent-session__name")))
        .toEqual(["Pinned only"]);
      await expect.poll(() => chatsGroup.locator(".sidebar-recent-session").count()).toBe(0);
      await expect.poll(() => page.locator(".sidebar-recent-session--active").count()).toBe(1);
      // The empty Threads section only materializes after dragstart. Move the
      // real pointer first so Playwright does not wait for a hidden target.
      const pinnedRow = pinnedEntry.locator(".sidebar-recent-session");
      const sourceBox = await pinnedRow.boundingBox();
      if (!sourceBox) {
        throw new Error("expected pinned session bounds");
      }
      await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 12, sourceBox.y + 12, {
        steps: 4,
      });
      const sessionList = page.locator(".sidebar-sessions");
      await sessionList.waitFor({ state: "visible" });
      const targetBox = await sessionList.boundingBox();
      if (!targetBox) {
        throw new Error("expected session list bounds");
      }
      await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
        steps: 8,
      });
      await page.mouse.up();
      const unpinPatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:pinned" && params.pinned === false,
      );
      expect(requireRecord(unpinPatch.params)).toMatchObject({
        key: "agent:main:pinned",
        pinned: false,
      });
      await expect.poll(() => pinnedEntry.count()).toBe(0);
      await expect.poll(() => chatsGroup.locator(".sidebar-recent-session").count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("pins a session dropped below an existing row in the interleaved sidebar zone", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(
            "agent:main:pinned",
            "Already pinned",
            Date.parse("2026-07-01T16:00:00.000Z"),
            {
              pinned: true,
            },
          ),
          sessionRow("agent:main:candidate", "Pin me", Date.parse("2026-07-01T15:59:00.000Z"), {
            category: "Research",
          }),
        ]),
        "sessions.patch": {},
      },
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.put",
        "sessions.patch",
      ],
      sessionKey: "agent:main:candidate",
      sessionGroups: ["Research"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const pinnedEntry = page.locator('[data-sidebar-entry="session:agent:main:pinned"]');
      const researchGroup = page.locator('[data-session-section="category:Research"]');
      await expect
        .poll(() => trimmedTextContents(pinnedEntry.locator(".sidebar-recent-session__name")))
        .toEqual(["Already pinned"]);
      await captureUiProof(page, "sidebar-session-before-pinned-drop.png");
      const pinnedBox = await pinnedEntry.boundingBox();
      if (!pinnedBox) {
        throw new Error("expected the pinned row to be laid out");
      }
      // The drop slot is decided by which half of the row the pointer is in, so
      // aim below its midpoint instead of the default centre landing on the edge.
      await researchGroup
        .locator('.sidebar-recent-session[data-session-key="agent:main:candidate"]')
        .dragTo(pinnedEntry, {
          targetPosition: { x: pinnedBox.width / 2, y: pinnedBox.height - 2 },
        });

      const pinPatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:candidate" && params.pinned === true,
      );
      expect(requireRecord(pinPatch.params)).toMatchObject({
        key: "agent:main:candidate",
        pinned: true,
      });
      expect(requireRecord(pinPatch.params)).not.toHaveProperty("category");
      await expect
        .poll(() =>
          trimmedTextContents(
            page.locator('[data-sidebar-entry^="session:"] .sidebar-recent-session__name'),
          ),
        )
        .toEqual(["Already pinned", "Pin me"]);
      await expect.poll(() => researchGroup.locator(".sidebar-recent-session").count()).toBe(0);

      const pinnedCandidate = page.locator(
        '[data-sidebar-entry="session:agent:main:candidate"] .sidebar-recent-session',
      );
      await pinnedCandidate.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Unpin session" }).waitFor();
      expect(await page.getByRole("menuitem", { name: "Reset pinned items" }).count()).toBe(0);
      await captureUiProof(page, "sidebar-session-dropped-into-pinned.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(uiProofArtifactDir, "sidebar-session-pinned-drop.webm"));
      }
    }
  });

  it("keeps raw ids out of work rows while their metadata grows in place", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const nodeHash = "11c38726acc6fac280357576c87acc6fac280357";
    const rows = (withWork: boolean) => {
      const ts = baseTime + (withWork ? 5_000 : 0);
      return [
        sessionRow("agent:main:main", "Main", ts),
        sessionRow(
          "agent:main:dashboard:0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6d",
          "",
          ts - 60_000,
          withWork ? { execNode: nodeHash } : {},
        ),
        sessionRow(
          "agent:main:dashboard:0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6e",
          "",
          ts - 120_000,
          withWork
            ? {
                execNode: nodeHash,
                worktree: { branch: "openclaw/wt-1", repoRoot: "/Users/dev/Projects/clawdbot" },
              }
            : {},
        ),
        sessionRow("agent:main:node-mcp-debug-4de003fbff138fcb9239c9378b2e", "", ts - 180_000),
      ];
    };
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse(rows(false)),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(() => page.locator(".sidebar-recent-session").count(), { timeout: 15_000 })
        .toBeGreaterThan(0);
      // Add work metadata only after first layout so the WebKit overlap
      // regression still exercises in-place row growth.
      const listRequests = (await gateway.getRequests("sessions.list")).length;
      await gateway.setMethodResponse("sessions.list", sessionsListResponse(rows(true)));
      await gateway.emitGatewayEvent("sessions.changed", {
        reason: "update",
        sessionKey: "agent:main:dashboard:0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6e",
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(listRequests);
      const codingToggle = page.locator(
        '[data-session-section="work"] .sidebar-session-group-toggle',
      );
      await codingToggle.waitFor({ state: "visible" });
      await expect.poll(() => codingToggle.getAttribute("aria-expanded")).toBe("false");
      await codingToggle.click();
      const namesLocator = page.locator(".sidebar-recent-session__name");
      await expect
        .poll(() => trimmedTextContents(namesLocator))
        .toContain("clawdbot ⎇ wt-1 · …0357");

      // Names and subtitles never show raw node ids or raw agent keys.
      const names = await trimmedTextContents(page.locator(".sidebar-recent-session__name"));
      expect(names).toContain("New session");
      expect(names).toContain("clawdbot ⎇ wt-1 · …0357");
      expect(names).toContain("node-mcp-debug-…8b2e");
      const subtitles = await trimmedTextContents(
        page.locator(".sidebar-recent-session__subtitle"),
      );
      expect(subtitles).toContain("…0357");
      for (const text of [...names, ...subtitles]) {
        expect(text).not.toContain(nodeHash);
        expect(text).not.toContain("agent:main:");
      }

      // Sections must lay out below the rows above them, not paint over them.
      const overlaps = await page.evaluate(() => {
        const rects = [
          ...document.querySelectorAll(".sidebar-recent-session, .sidebar-recent-sessions__head"),
        ]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          })
          .filter((rect) => rect.bottom > rect.top)
          .toSorted((a, b) => a.top - b.top);
        let bad = 0;
        let previousBottom: number | undefined;
        for (const rect of rects) {
          if (previousBottom !== undefined && rect.top < previousBottom - 2) {
            bad += 1;
          }
          previousBottom = rect.bottom;
        }
        return bad;
      });
      expect(overlaps).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("scrolls long session lists in short windows instead of squeezing sections", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        sessionRow(`agent:main:work-${index}`, `Work session ${index}`, baseTime - index * 60_000, {
          worktree: { branch: `openclaw/wt-${index}`, repoRoot: "/Users/dev/Projects/clawdbot" },
        }),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - (index + 10) * 60_000),
      ),
    ];
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 620, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse(rows),
      },
      sessionKey: "agent:main:main",
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator('[data-session-section="work"] .sidebar-session-group-toggle').click();
      const loadMore = page
        .locator('[data-session-section="ungrouped"]')
        .getByRole("button", { name: "Show more" });
      for (let pageIndex = 0; pageIndex < 3 && (await loadMore.isVisible()); pageIndex += 1) {
        await loadMore.click();
      }
      await page.locator(".sidebar-shell__body").evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(() => page.locator(".sidebar-recent-session").count(), { timeout: 15_000 })
        .toBe(rows.length);
      await captureUiProof(page, "short-window-session-sections.png");

      // Sections must stack below each other, not paint over the rows above.
      const overlaps = await page.evaluate(() => {
        const rects = [
          ...document.querySelectorAll(".sidebar-recent-session, .sidebar-recent-sessions__head"),
        ]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          })
          .filter((rect) => rect.bottom > rect.top)
          .toSorted((a, b) => a.top - b.top);
        let bad = 0;
        let previousBottom: number | undefined;
        for (const rect of rects) {
          if (previousBottom !== undefined && rect.top < previousBottom - 2) {
            bad += 1;
          }
          previousBottom = rect.bottom;
        }
        return bad;
      });
      expect(overlaps).toBe(0);

      // The squeeze regression compressed sections into the viewport with no
      // overflow; a healthy sidebar body is taller than its viewport and scrolls.
      const scroll = await page.evaluate(() => {
        const list = document.querySelector(".sidebar-shell__body");
        if (!list) {
          return null;
        }
        list.scrollTop = list.scrollHeight;
        return {
          clientHeight: list.clientHeight,
          scrollHeight: list.scrollHeight,
          scrollTop: list.scrollTop,
        };
      });
      expect(scroll).not.toBeNull();
      expect(scroll?.scrollHeight ?? 0).toBeGreaterThan(scroll?.clientHeight ?? 0);
      expect(scroll?.scrollTop ?? 0).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it("keeps sidebar session controls reachable on touch pointers", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(
            "agent:main:research",
            "Research notes",
            Date.parse("2026-07-01T15:00:00.000Z"),
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page
        .locator(".sidebar-recent-sessions__list .sidebar-recent-session")
        .filter({ hasText: "Research notes" });
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionPointerEvents(pin)).toBe("auto");
      await expect.poll(() => actionOpacity(menu)).toBe("1");
      await expect.poll(() => actionPointerEvents(menu)).toBe("auto");
      await menu.click();
      await page.getByRole("menuitem", { name: "Archive session" }).waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  });
});
