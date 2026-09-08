import path from "node:path";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  actionOpacity,
  activateSelfRemovingControl,
  captureUiProof,
  captureUiProofEnabled,
  collapsedSessionSectionsStorageKey,
  controlUiSessionPath,
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  openSessionMenuSubmenu,
  requireRecord,
  sessionsListResponse,
  submitInputDialog,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps long group titles on one line and reveals them on hover", async () => {
    const groupName = "OpenClaw Bugfixes / Miscellaneous Product Work and Release Coordination";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, "sessions.groups.list"],
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:group-title", "Group title behavior", Date.now(), {
            category: groupName,
          }),
        ]),
      },
      sessionGroups: [groupName],
      sessionKey: "agent:main:group-title",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:group-title"));
      const group = page.locator(`[data-session-section="category:${groupName}"]`);
      const header = group.locator(":scope > .sidebar-recent-sessions__head");
      const label = header.locator(".sidebar-recent-sessions__label-text");
      await group.waitFor({ state: "visible", timeout: 10_000 });
      await captureUiProof(suite, page, "sidebar-group-title-resting.png");

      const resting = await label.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          clientWidth: element.clientWidth,
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(style.lineHeight),
          scrollWidth: element.scrollWidth,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
        };
      });
      expect(resting.whiteSpace).toBe("nowrap");
      expect(resting.textOverflow).toBe("ellipsis");
      expect(resting.height).toBeLessThanOrEqual(resting.lineHeight + 1);
      expect(resting.scrollWidth).toBeGreaterThan(resting.clientWidth);

      await label.hover();
      await expect
        .poll(() => label.getAttribute("class"), { timeout: 3_000 })
        .toContain("hover-marquee--scrolling");
      await expect
        .poll(() =>
          label.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).getPropertyValue("text-indent")),
          ),
        )
        .toBeLessThan(-1);
      await captureUiProof(suite, page, "sidebar-group-title-hovered.png");
    } finally {
      await context.close();
    }
  });

  it("recovers an empty group catalog after a transient load failure", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.groups.list"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
      methodResponses: {
        "sessions.list": sessionsListResponse([]),
      },
      sessionGroups: ["Recovered group"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.groups.list");
      await gateway.rejectDeferred("sessions.groups.list", {
        code: "UNAVAILABLE",
        message: "temporary catalog failure",
        retryable: true,
      });

      await expect
        .poll(async () => (await gateway.getRequests("sessions.groups.list")).length, {
          timeout: 10_000,
        })
        .toBe(2);
      await page.locator('[data-session-section="category:Recovered group"]').waitFor({
        state: "visible",
      });
    } finally {
      await context.close();
    }
  });

  it("keeps a rejected sidebar mutation visible until the user dismisses it", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:rename-me", "Rename me", Date.now()),
        ]),
      },
      sessionKey: "agent:main:rename-me",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:rename-me"));
      const row = page.locator('[data-session-key="agent:main:rename-me"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await page.getByRole("menuitem", { name: "Rename…" }).click();
      const dialog = page.locator('openclaw-modal-dialog[label="Rename session"]');
      await dialog.getByRole("textbox", { name: "Rename session" }).fill("Rejected rename");
      await dialog.getByRole("button", { name: "Save" }).click();
      await gateway.waitForRequest("sessions.patch");
      await gateway.rejectDeferred("sessions.patch", {
        code: "INVALID_REQUEST",
        message: "sidebar rename rejected",
      });

      const error = page.locator("[data-sidebar-session-error]");
      await error.waitFor({ state: "visible" });
      await expect.poll(() => error.textContent()).toContain("sidebar rename rejected");
      expect(
        await error
          .locator("xpath=ancestor::*[contains(@class, 'sidebar-recent-sessions')]")
          .count(),
      ).toBe(0);

      await error.getByRole("button", { name: "Dismiss error" }).click();
      await expect.poll(() => error.count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("renames a sidebar session through an in-app dialog", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: suite.artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:rename-me", "Original name", Date.now()),
        ]),
        "sessions.patch": {},
      },
      sessionKey: "agent:main:rename-me",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:rename-me"));
      const row = page.locator('[data-session-key="agent:main:rename-me"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await page.getByRole("menuitem", { name: "Rename…" }).click();

      await page.getByRole("dialog", { name: "Rename session" }).waitFor({ state: "visible" });
      const dialog = page.locator('openclaw-modal-dialog[label="Rename session"]');
      const name = dialog.getByRole("textbox", { name: "Rename session" });
      await name.waitFor({ state: "visible" });
      await expect.poll(() => name.inputValue()).toBe("Original name");
      await captureUiProof(
        suite,
        page,
        "sidebar-session-rename-dialog.png",
        dialog.locator("dialog"),
        [name],
      );
      await name.fill("Renamed session");
      await dialog.getByRole("button", { name: "Save" }).click();

      const patch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:rename-me" && params.label === "Renamed session",
      );
      expect(patch.params).toMatchObject({
        key: "agent:main:rename-me",
        label: "Renamed session",
      });
      await expect.poll(() => row.textContent()).toContain("Renamed session");
      await captureUiProof(suite, page, "sidebar-session-renamed.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(suite.artifactDir, "sidebar-session-rename.webm"));
      }
    }
  });

  it("manages sessions through the sidebar groups and command palette", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.clock.install();
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, "cron.list"],
      methodResponses: {
        "cron.list": {
          jobs: [
            {
              id: "nightly-invoices",
              name: "Nightly invoices",
              description: "Reconciles customer billing",
            },
          ],
          snapshotRevision: "1",
          total: 1,
          limit: 200,
          offset: 0,
          nextOffset: null,
          hasMore: false,
        },
        "sessions.list": {
          cases: [
            {
              match: {},
              response: sessionsListResponse([
                sessionRow("agent:main:main", "Main", baseTime),
                sessionRow("agent:main:release", "Release planning", baseTime - 60_000, {
                  pinned: true,
                  pinnedAt: baseTime - 30_000,
                }),
                sessionRow("agent:main:migration", "Data migration", baseTime - 90_000, {
                  hasActiveRun: true,
                  status: "running",
                }),
                sessionRow("agent:main:research", "Research notes", baseTime - 120_000),
              ]),
            },
          ],
        },
        "sessions.search": {
          results: [
            {
              messageId: "message-release-context",
              role: "assistant",
              score: 4.2,
              sessionId: "release",
              sessionKey: "agent:main:release",
              snippet: "The view-only handshake is ready for final review.",
              timestamp: baseTime - 45_000,
            },
          ],
        },
        "sessions.patch": {},
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      // Sidebar: pinned rows join the ordered page zone while staying out of Threads.
      const sidebarRows = page.locator(".sidebar-recent-session");
      await sidebarRows.first().waitFor({ state: "visible", timeout: 10_000 });
      const pinnedZoneRow = page.locator(
        '[data-sidebar-entry="session:agent:main:release"] .sidebar-recent-session',
      );
      await expect.poll(() => pinnedZoneRow.textContent()).toContain("Release planning");
      const groups = page.locator(".sidebar-recent-sessions__group");
      await expect.poll(() => groups.count()).toBe(1);
      await expect
        .poll(() => groups.first().getAttribute("data-session-section"))
        .toBe("ungrouped");
      await expect.poll(() => page.locator('[data-session-section="pinned"]').count()).toBe(0);

      // Chats keep recency order with the open session highlighted in place —
      // selecting a row must not reshuffle the list.
      const chatRows = page.locator('[data-session-section="ungrouped"] .sidebar-recent-session');
      const rowNames = () =>
        chatRows.evaluateAll((rows) =>
          rows.map((row) => row.querySelector(".sidebar-recent-session__name")?.textContent ?? ""),
        );
      await expect.poll(rowNames).toEqual(["Data migration", "Research notes"]);
      const sidebarMigration = sidebarRows.filter({ hasText: "Data migration" });
      await expect
        .poll(() =>
          sidebarMigration.locator(".sidebar-session-indicator .session-glyph__ring").isVisible(),
        )
        .toBe(true);

      // Hover-revealed management actions on sidebar rows.
      const sidebarResearch = sidebarRows.filter({ hasText: "Research notes" });
      const sidebarResearchPin = sidebarResearch.getByRole("button", { name: "Pin session" });
      await page.mouse.move(900, 500);
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("0");
      const sidebarReleasePin = sidebarRows
        .filter({ hasText: "Release planning" })
        .getByRole("button", { name: "Unpin session" });
      await expect.poll(() => actionOpacity(sidebarReleasePin)).toBe("0");
      await sidebarResearch.hover();
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("1");
      await captureUiProof(suite, page, "sidebar-sessions.png");

      await sidebarRows.filter({ hasText: "Release planning" }).hover();
      await expect.poll(() => actionOpacity(sidebarReleasePin)).toBe("1");
      await sidebarReleasePin.click();
      const pinPatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:release" && params.pinned === false,
      );
      expect(requireRecord(pinPatch.params)).toMatchObject({
        key: "agent:main:release",
        pinned: false,
      });

      // Active rows can archive through the Gateway's stop-and-drain lifecycle,
      // while Delete keeps its separate active-run guard.
      await sidebarMigration.hover();
      await sidebarMigration.getByRole("button", { name: "Open session menu" }).click();
      await expect
        .poll(() => page.getByRole("menuitem", { name: "Archive session" }).isDisabled())
        .toBe(false);
      await expect
        .poll(() => page.getByRole("menuitem", { name: "Delete…" }).isDisabled())
        .toBe(true);
      await page.keyboard.press("Escape");
      await sidebarResearch.hover();
      await sidebarResearch.getByRole("button", { name: "Open session menu" }).click();
      await activateSelfRemovingControl(page.getByRole("menuitem", { name: "Archive session" }));
      const archivePatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:research" && params.archived === true,
      );
      expect(requireRecord(archivePatch.params)).toMatchObject({
        archived: true,
        key: "agent:main:research",
      });

      // The confirmed archive wins over the mocked Gateway's stale active row,
      // while selecting another visible row keeps the remaining order stable.
      await sidebarResearch.waitFor({ state: "detached" });
      const migrationLink = sidebarMigration.locator("a").first();
      await migrationLink.click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:migration"));
      await expect.poll(rowNames).toEqual(["Release planning", "Data migration"]);
      await expect
        .poll(() =>
          chatRows
            .filter({ hasText: "Data migration" })
            .first()
            .evaluate((row) => row.classList.contains("sidebar-recent-session--active")),
        )
        .toBe(true);

      // The same palette lazily loads small non-session catalogs once and
      // matches both item names and descriptions without involving FTS.
      const cronRequestsBeforePalette = (await gateway.getRequests("cron.list")).length;
      const transcriptRequestsBeforePalette = (await gateway.getRequests("sessions.search")).length;
      await page.getByRole("button", { name: "Open command palette" }).click();
      const paletteInput = page.locator(".cmd-palette__input");
      await paletteInput.waitFor({ state: "visible", timeout: 10_000 });
      await paletteInput.fill("reconciles customer billing");
      await page.clock.runFor(50);
      const automationOption = page.getByRole("option", { name: /Nightly invoices/u });
      await automationOption.waitFor({ state: "visible", timeout: 10_000 });
      expect(await gateway.getRequests("cron.list")).toHaveLength(cronRequestsBeforePalette + 1);
      await page.keyboard.press("Escape");

      // Command palette is the single search surface: metadata and indexed
      // conversation text share one field, and selecting either navigates.
      await page.getByRole("button", { name: "Open command palette" }).click();
      await paletteInput.waitFor({ state: "visible", timeout: 10_000 });
      await paletteInput.fill("view-only handshake");
      await page.clock.runFor(50);
      const paletteOption = page
        .locator(".cmd-palette__item")
        .filter({ hasText: "Release planning" });
      await paletteOption.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => paletteOption.textContent()).toContain("view-only handshake");
      expect(await gateway.getRequests("cron.list")).toHaveLength(cronRequestsBeforePalette + 1);
      const transcriptRequests = await gateway.getRequests("sessions.search");
      expect(transcriptRequests).toHaveLength(transcriptRequestsBeforePalette + 2);
      expect(requireRecord(transcriptRequests.at(-1)?.params)).toMatchObject({
        agentId: "main",
        query: "view-only handshake",
      });
      await captureUiProof(suite, page, "command-palette-session-search.png");
      await paletteOption.click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:release"));
    } finally {
      await context.close();
    }
  });

  it("sorts threads from the keyboard and identifies destructive selection targets", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:alpha", "Alpha thread", 1),
          sessionRow("agent:main:zulu", "Zulu thread", 2),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      const table = page.locator(".sessions-table");
      const rowNames = () =>
        table.locator("tbody .session-data-row .session-label-chip").allTextContents();
      await expect.poll(rowNames).toEqual(["Zulu thread", "Alpha thread"]);

      for (const name of ["Key", "Kind", "Updated", "Tokens"]) {
        await table.getByRole("columnheader", { name }).getByRole("button", { name }).waitFor();
      }

      const updatedHeader = table.getByRole("columnheader", { name: "Updated" });
      expect(await updatedHeader.getAttribute("aria-sort")).toBe("descending");
      await updatedHeader.getByRole("button", { name: "Updated" }).press("Space");
      await expect.poll(rowNames).toEqual(["Alpha thread", "Zulu thread"]);
      expect(await updatedHeader.getAttribute("aria-sort")).toBe("ascending");

      const keyHeader = table.getByRole("columnheader", { name: "Key" });
      await keyHeader.getByRole("button", { name: "Key" }).press("Enter");
      await expect.poll(rowNames).toEqual(["Zulu thread", "Alpha thread"]);
      expect(await keyHeader.getAttribute("aria-sort")).toBe("descending");
      expect(await updatedHeader.getAttribute("aria-sort")).toBeNull();

      const keyHeaderBounds = await keyHeader.boundingBox();
      if (!keyHeaderBounds) {
        throw new Error("Expected visible session sort header");
      }
      await page.mouse.click(
        keyHeaderBounds.x + keyHeaderBounds.width - 2,
        keyHeaderBounds.y + keyHeaderBounds.height / 2,
      );
      await expect.poll(rowNames).toEqual(["Alpha thread", "Zulu thread"]);
      expect(await keyHeader.getAttribute("aria-sort")).toBe("ascending");

      await table.getByRole("checkbox", { name: "Select session: agent:main:alpha" }).waitFor();
      await table.getByRole("checkbox", { name: "Select session: agent:main:zulu" }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("shows a rejected Sessions-page custom group instead of leaking a page error", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.groups.put"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.put",
      ],
      methodResponses: {
        "sessions.list": sessionsListResponse([]),
      },
      sessionKey: "agent:main:main",
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      await page.getByRole("button", { name: "Filters" }).click();
      await page.locator("wa-popover.sessions-filter-popover[open]").waitFor();
      await page.locator(".session-groupby__select").selectOption("category");
      await page.getByRole("button", { name: "New group" }).click();
      const field = page.locator("openclaw-modal-dialog input");
      await field.waitFor({ state: "visible" });
      await field.fill("X".repeat(513));
      await field.press("Enter");
      await gateway.waitForRequest("sessions.groups.put");
      await gateway.rejectDeferred("sessions.groups.put", {
        code: "INVALID_REQUEST",
        message: "group name exceeds 512 characters",
      });

      const error = page.locator('openclaw-modal-dialog [role="alert"]');
      await error.waitFor({ state: "visible" });
      await expect.poll(() => error.textContent()).toContain("group name exceeds 512 characters");
      expect(await field.inputValue()).toBe("X".repeat(513));
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("renames, deletes, and toggles sidebar session groups", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { archived: true },
              response: sessionsListResponse([
                sessionRow("agent:main:old-notes", "Old notes", baseTime - 300_000, {
                  archived: true,
                  category: "Research",
                }),
              ]),
            },
            {
              match: {},
              response: sessionsListResponse([
                sessionRow("agent:main:main", "Main", baseTime),
                sessionRow("agent:main:apps", "Apps", baseTime - 30_000, {
                  category: "Apps",
                }),
                sessionRow("agent:main:paper-a", "Paper A", baseTime - 60_000, {
                  category: "Research",
                }),
                sessionRow("agent:main:paper-b", "Paper B", baseTime - 90_000, {
                  category: "Research",
                }),
              ]),
            },
          ],
        },
        "sessions.patch": {},
      },
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.delete",
        "sessions.groups.list",
        "sessions.groups.rename",
      ],
      sessionKey: "agent:main:main",
      sessionGroups: ["Apps", "Research"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      // Categorized rows render as their own sidebar group section.
      const groups = page.locator(".sidebar-recent-sessions__group");
      const researchGroup = groups.filter({ hasText: "Research" });
      await researchGroup.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => researchGroup.locator(".sidebar-recent-session").count()).toBe(2);
      await captureUiProof(suite, page, "sidebar-session-groups.png");

      // Rename group: the gateway renames the catalog entry and repoints every
      // member session server-side (sessions.groups.rename), no per-member patches.
      const groupMenuButton = researchGroup.getByRole("button", {
        name: "Group options for Research",
      });
      await researchGroup.locator(".sidebar-recent-sessions__head").hover();
      await groupMenuButton.click();
      await page.getByRole("menuitem", { name: "Rename group" }).waitFor({ state: "visible" });
      await captureUiProof(suite, page, "sidebar-group-menu.png");
      await activateSelfRemovingControl(page.getByRole("menuitem", { name: "Rename group" }));
      // The rename runs in the owned dialog, prefilled with the name it is
      // changing; a native prompt here would be a regression.
      const renameDialog = page.getByRole("dialog", { name: 'Rename group "Research"' });
      await renameDialog.waitFor({ state: "visible" });
      await expect
        .poll(() => page.locator("openclaw-modal-dialog input").inputValue())
        .toBe("Research");
      await captureUiProof(suite, page, "sidebar-group-rename-dialog.png");
      await submitInputDialog(page, "Projects");
      const renameRequest = await gateway.waitForRequest("sessions.groups.rename");
      expect(requireRecord(renameRequest.params)).toMatchObject({
        name: "Research",
        to: "Projects",
      });
      await expect
        .poll(() =>
          page
            .locator('[data-session-section^="category:"]')
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-session-section")),
            ),
        )
        .toEqual(["category:Apps", "category:Projects"]);
      const projectsGroup = groups.filter({ hasText: "Projects" });
      await expect.poll(() => projectsGroup.locator(".sidebar-recent-session").count()).toBe(2);

      // Delete group: the gateway drops the catalog entry and moves member
      // sessions back to Chats server-side (sessions.groups.delete).
      const projectsMenuButton = projectsGroup.getByRole("button", {
        name: "Group options for Projects",
      });
      await projectsGroup.locator(".sidebar-recent-sessions__head").hover();
      await projectsMenuButton.click();
      await activateSelfRemovingControl(page.getByRole("menuitem", { name: "Delete group" }));
      // The confirm names the group and what happens to its sessions, and only
      // the operator's answer sends sessions.groups.delete.
      await page
        .getByRole("dialog", { name: 'Delete group "Projects"' })
        .waitFor({ state: "visible" });
      const deleteConfirm = page.locator("openclaw-modal-dialog");
      await expect
        .poll(() => deleteConfirm.textContent())
        .toContain("The group is removed. Its sessions move back to the session list.");
      await captureUiProof(suite, page, "sidebar-group-delete-confirm.png");
      await deleteConfirm.getByRole("button", { name: "Delete", exact: true }).click();
      const deleteRequest = await gateway.waitForRequest("sessions.groups.delete");
      expect(requireRecord(deleteRequest.params)).toMatchObject({ name: "Projects" });
      await expect
        .poll(() =>
          page
            .locator('[data-session-section^="category:"]')
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-session-section")),
            ),
        )
        .toEqual(["category:Apps"]);
      await expect
        .poll(() =>
          page.locator('[data-session-section="ungrouped"] .sidebar-recent-session').count(),
        )
        .toBe(2);

      // Group by "None" flattens the category sections into the plain list. The
      // confirm left the pointer over the dialog rather than the sidebar; the
      // global toolbar remains available without revealing a section action.
      const filterAndSortButton = page.getByRole("button", { name: "Filter & sort" });
      await filterAndSortButton.click();
      const showAutomationSessions = page.getByRole("menuitemcheckbox", {
        name: "Show automation sessions",
      });
      await activateSelfRemovingControl(showAutomationSessions);
      await expect.poll(() => filterAndSortButton.getAttribute("aria-expanded")).toBe("false");

      await filterAndSortButton.click();
      await expect.poll(() => showAutomationSessions.getAttribute("aria-checked")).toBe("true");
      await page.getByRole("menuitemradio", { name: "None" }).waitFor({ state: "visible" });
      await captureUiProof(suite, page, "sidebar-groupby-sort-menu.png");
      const groupingCheck = page
        .getByRole("menuitemradio", { name: "Custom groups" })
        .locator(".session-menu__check");
      const nativeAutomationCheck = showAutomationSessions.locator('[part="checkmark"]');
      await expect.poll(() => nativeAutomationCheck.count()).toBe(1);
      expect(await nativeAutomationCheck.boundingBox()).toBeNull();
      const automationCheck = showAutomationSessions.locator(".session-menu__check");
      await expect.poll(() => automationCheck.count()).toBe(1);
      await expect
        .poll(async () => {
          const [groupingBounds, automationBounds] = await Promise.all([
            groupingCheck.boundingBox(),
            automationCheck.boundingBox(),
          ]);
          if (!groupingBounds || !automationBounds) {
            return Number.POSITIVE_INFINITY;
          }
          const groupingRight = groupingBounds.x + groupingBounds.width;
          const automationRight = automationBounds.x + automationBounds.width;
          return Math.abs(automationRight - groupingRight);
        })
        .toBeLessThanOrEqual(1);
      await filterAndSortButton.click();
      await expect.poll(() => filterAndSortButton.getAttribute("aria-expanded")).toBe("false");
      await expect.poll(() => page.getByRole("menuitemradio", { name: "None" }).count()).toBe(0);
      await captureUiProof(suite, page, "sidebar-groupby-sort-menu-closed.png");

      await filterAndSortButton.click();
      await activateSelfRemovingControl(page.getByRole("menuitemradio", { name: "None" }));
      await expect.poll(() => groups.count()).toBe(1);
      await expect.poll(() => groups.first().locator(".sidebar-recent-session").count()).toBe(3);
    } finally {
      await context.close();
    }
  });

  it("preserves a collapsed sidebar group when its rename is rejected", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await page.addInitScript(
      ({ key, value }) => {
        try {
          if (localStorage.getItem(key) === null) {
            localStorage.setItem(key, value);
          }
        } catch {
          // The opaque initial document has no storage; the app origin does.
        }
      },
      {
        key: collapsedSessionSectionsStorageKey,
        value: JSON.stringify(["category:Research"]),
      },
    );
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.groups.rename"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.rename",
      ],
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", baseTime),
          sessionRow("agent:main:paper", "Paper", baseTime - 60_000, {
            category: "Research",
          }),
        ]),
      },
      sessionGroups: ["Research"],
      sessionKey: "agent:main:main",
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const researchGroup = page.locator('[data-session-section="category:Research"]');
      await researchGroup.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => researchGroup.locator(".sidebar-recent-session").count()).toBe(0);
      await researchGroup.locator(".sidebar-recent-sessions__head").hover();
      await researchGroup.getByRole("button", { name: "Group options for Research" }).click();
      await activateSelfRemovingControl(page.getByRole("menuitem", { name: "Rename group" }));
      await submitInputDialog(page, "Projects");
      await gateway.waitForRequest("sessions.groups.rename");
      await gateway.rejectDeferred("sessions.groups.rename", {
        code: "INVALID_REQUEST",
        message: "rejected group rename",
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );

      expect(
        await page.evaluate((key) => localStorage.getItem(key), collapsedSessionSectionsStorageKey),
      ).toBe(JSON.stringify(["category:Research"]));
      await researchGroup.waitFor({ state: "visible" });
      expect(await page.locator('[data-session-section="category:Projects"]').count()).toBe(0);
      expect(pageErrors).toEqual([]);

      await page.reload();
      await researchGroup.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => researchGroup.locator(".sidebar-recent-session").count()).toBe(0);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), collapsedSessionSectionsStorageKey),
      ).toBe(JSON.stringify(["category:Research"]));
    } finally {
      await context.close();
    }
  });

  it("pages sidebar sessions and supports complete drag-managed groups", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const sessions = Array.from({ length: 13 }, (_, index) =>
      sessionRow(`agent:main:session-${index}`, `Session ${index}`, baseTime - index * 60_000, {
        ...(index === 0 ? { category: "Alpha" } : {}),
        ...(index === 1 ? { category: "Beta" } : {}),
      }),
    );
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse(sessions),
        "sessions.patch": {},
      },
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.put",
        "sessions.patch",
      ],
      sessionKey: "agent:main:session-0",
      sessionGroups: ["Alpha", "Beta"],
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-0"));
      const sidebarRows = page.locator(".sidebar-recent-session");
      // Category sections page independently: Alpha and Beta stay visible
      // alongside the first ten rows in the ungrouped section.
      await expect.poll(() => sidebarRows.count()).toBe(12);
      await page.getByRole("button", { name: "Show more" }).click();
      await expect.poll(() => sidebarRows.count()).toBe(13);
      await expect.poll(() => page.getByText("All sessions", { exact: true }).count()).toBe(0);
      await captureUiProof(suite, page, "sidebar-all-sessions.png");

      // New groups are created from a session's menu (Move to group → New group),
      // which files that session into the new group.
      const sessionTen = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-10"]',
      );
      await sessionTen.hover();
      await sessionTen.getByRole("button", { name: "Open session menu" }).click();
      await openSessionMenuSubmenu(page, "Move to group");
      await activateSelfRemovingControl(page.getByRole("menuitem", { name: "New group" }));
      await submitInputDialog(page, "Gamma");
      const gamma = page.locator('[data-session-section="category:Gamma"]');
      await gamma.waitFor({ state: "visible" });
      const createdPatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:session-10" && params.category === "Gamma",
      );
      expect(requireRecord(createdPatch.params)).toMatchObject({
        category: "Gamma",
        key: "agent:main:session-10",
      });

      const sessionEleven = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-11"]',
      );
      await sessionEleven.dragTo(gamma);
      const groupedPatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:session-11" && params.category === "Gamma",
      );
      expect(requireRecord(groupedPatch.params)).toMatchObject({
        category: "Gamma",
        key: "agent:main:session-11",
      });
      await expect
        .poll(() => gamma.locator(".sidebar-recent-session").count(), { timeout: 10_000 })
        .toBe(2);
      await captureUiProof(suite, page, "sidebar-session-dropped-into-group.png");

      const ungrouped = page.locator('[data-session-section="ungrouped"]');
      const ungroupedHead = ungrouped.locator(":scope > .sidebar-recent-sessions__head");
      await gamma
        .locator('.sidebar-recent-session[data-session-key="agent:main:session-11"]')
        .dragTo(ungroupedHead, { targetPosition: { x: 4, y: 2 } });
      const ungroupedPatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:session-11" && params.category === null,
      );
      expect(requireRecord(ungroupedPatch.params)).toMatchObject({
        category: null,
        key: "agent:main:session-11",
      });
      await expect
        .poll(() => ungrouped.locator(".sidebar-recent-session").count(), { timeout: 10_000 })
        .toBe(10);

      const alpha = page.locator('[data-session-section="category:Alpha"]');
      const alphaToggle = alpha.getByRole("button", { name: "Alpha", exact: true });
      await alphaToggle.click();
      await expect.poll(() => alpha.locator(".sidebar-recent-session").count()).toBe(0);
      await captureUiProof(suite, page, "sidebar-session-group-collapsed.png");
      await alphaToggle.click();
      await expect.poll(() => alpha.locator(".sidebar-recent-session").count()).toBe(1);
      await alphaToggle.click();
      await expect.poll(() => alpha.locator(".sidebar-recent-session").count()).toBe(0);

      // Header buttons intentionally keep their click behavior; reorder from
      // the dedicated grip beside them.
      await gamma.locator(".sidebar-session-group-drag-handle").dragTo(alpha, {
        targetPosition: { x: 4, y: 2 },
      });
      const customGroupOrder = () =>
        page
          .locator('[data-session-section^="category:"]')
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-session-section")),
          );
      await expect
        .poll(customGroupOrder)
        .toEqual(["category:Gamma", "category:Alpha", "category:Beta"]);
      await captureUiProof(suite, page, "sidebar-session-groups-reordered.png");

      await page.reload();
      await expect
        .poll(customGroupOrder)
        .toEqual(["category:Gamma", "category:Alpha", "category:Beta"]);
      await expect
        .poll(() =>
          page
            .locator('[data-session-section="category:Alpha"] .sidebar-session-group-toggle')
            .getAttribute("aria-expanded"),
        )
        .toBe("false");
      await expect.poll(() => page.locator(".sidebar-recent-session").count()).toBe(11);

      const patchCountBeforeFlatDrag = (await gateway.getRequests("sessions.patch")).length;
      const filterAndSortButton = page.getByRole("button", { name: "Filter & sort" });
      await filterAndSortButton.click();
      await activateSelfRemovingControl(page.getByRole("menuitemradio", { name: "None" }));
      const flatSection = page.locator('[data-session-section="ungrouped"]');
      await flatSection
        .locator('.sidebar-recent-session[data-session-key="agent:main:session-1"]')
        .dragTo(flatSection);
      expect((await gateway.getRequests("sessions.patch")).length).toBe(patchCountBeforeFlatDrag);
    } finally {
      await context.close();
    }
  });

  it("keeps a new empty group visible before the first saved session", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([]),
      },
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.put",
      ],
      sessionKey: "agent:main:main",
      // Stored-but-empty catalog groups stay visible as sections/move targets.
      sessionGroups: ["First group"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const firstGroup = page.locator('[data-session-section="category:First group"]');
      await firstGroup.waitFor({ state: "visible" });

      // A header-menu-created group starts empty and still gets a section.
      await firstGroup.locator(".sidebar-recent-sessions__head").hover();
      await firstGroup.getByRole("button", { name: "Group options for First group" }).click();
      await activateSelfRemovingControl(page.getByRole("menuitem", { name: "New group" }));
      await submitInputDialog(page, "Second group");
      await page.locator('[data-session-section="category:Second group"]').waitFor({
        state: "visible",
      });
      const putRequest = await gateway.waitForRequest("sessions.groups.put");
      expect(requireRecord(putRequest.params)).toMatchObject({
        names: ["First group", "Second group"],
      });
    } finally {
      await context.close();
    }
  });

  it("keeps empty gateway groups compact for the selected agent", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantName: "Ivan",
      defaultAgentId: "ivan",
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { agentId: "ivan" },
              response: sessionsListResponse([
                sessionRow("agent:ivan:main", "Ivan", Date.parse("2026-07-28T18:00:00.000Z")),
              ]),
            },
            {
              match: { agentId: "main" },
              response: sessionsListResponse([
                sessionRow("agent:main:email", "Email intake", 1, { category: "Email intake" }),
                sessionRow("agent:main:replies", "Customer replies", 1, {
                  category: "Customer replies",
                }),
              ]),
            },
          ],
        },
      },
      sessionGroups: ["Email intake", "Customer replies"],
      sessionKey: "agent:ivan:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) => requireRecord(request.params).agentId === "ivan",
          ),
        )
        .toBe(true);

      const emptyGroups = page.locator('[data-session-section^="category:"]');
      await expect.poll(() => emptyGroups.count()).toBe(2);

      for (const name of ["Email intake", "Customer replies"]) {
        const group = page.locator(`[data-session-section="category:${name}"]`);
        await group.waitFor({ state: "visible" });
        await expect
          .poll(() => group.locator(":scope > .sidebar-recent-sessions__head").count())
          .toBe(1);
        const toggle = group.getByRole("button", { name, exact: true });
        await toggle.waitFor({ state: "visible" });
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
      }

      await expect.poll(() => emptyGroups.locator(".sidebar-session-empty-hint").count()).toBe(0);
      await expect
        .poll(() => emptyGroups.locator(".sidebar-recent-sessions__list").count())
        .toBe(0);

      const firstEmptyGroup = emptyGroups.first();
      const groupHeight = () =>
        firstEmptyGroup.evaluate((element) => element.getBoundingClientRect().height);
      await expect.poll(groupHeight).toBeGreaterThan(0);
      const expandedHeight = await groupHeight();
      await captureUiProof(suite, page, "sidebar-empty-cross-agent-groups.png");

      const toggle = firstEmptyGroup.locator(".sidebar-session-group-toggle");
      await toggle.click();
      await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
      // DOMRect measurements can differ by subpixel rounding without a layout change.
      await expect.poll(groupHeight).toBeCloseTo(expandedHeight, 2);
      await expect
        .poll(() => firstEmptyGroup.locator(".sidebar-session-empty-hint").count())
        .toBe(0);
      await expect
        .poll(() => firstEmptyGroup.locator(".sidebar-recent-sessions__list").count())
        .toBe(0);
    } finally {
      await context.close();
    }
  });
});
