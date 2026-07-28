import { expect, it } from "vitest";
import {
  actionOpacity,
  activateMenuItem,
  captureUiProof,
  collapsedSessionSectionsStorageKey,
  controlUiSessionPath,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("recovers an empty group catalog after a transient load failure", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
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
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
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
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:rename-me"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: "Open thread menu" }).click();
      page.once("dialog", (dialog) => void dialog.accept("Rejected rename"));
      await page.getByRole("menuitem", { name: "Rename…" }).click();
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
      methodResponses: {
        "sessions.list": {
          cases: [
            ...[50, 100, 150].map((offset) => ({
              match: { offset, search: "helpers" },
              response: sessionsListResponse(
                Array.from({ length: 50 }, (_, index) =>
                  sessionRow(
                    `agent:main:hidden-helper-${offset + index}`,
                    `Hidden helper ${offset + index}`,
                    baseTime - offset - index,
                    { spawnedBy: "agent:main:main" },
                  ),
                ),
                { hasMore: true, nextOffset: offset + 50, offset, totalCount: 250 },
              ),
            })),
            {
              match: { search: "helpers" },
              response: sessionsListResponse(
                Array.from({ length: 50 }, (_, index) =>
                  sessionRow(
                    `agent:main:hidden-helper-${index}`,
                    `Hidden helper ${index}`,
                    baseTime - index,
                    { spawnedBy: "agent:main:main" },
                  ),
                ),
                { hasMore: true, nextOffset: 50, totalCount: 250 },
              ),
            },
            {
              match: { offset: 50, search: "release" },
              response: sessionsListResponse(
                [sessionRow("agent:main:release", "Release planning", baseTime - 60_000)],
                { offset: 50, totalCount: 51 },
              ),
            },
            {
              match: { search: "release" },
              response: sessionsListResponse(
                Array.from({ length: 50 }, (_, index) =>
                  sessionRow(
                    `agent:main:release-helper-${index}`,
                    `Release helper ${index}`,
                    baseTime - index,
                    { spawnedBy: "agent:main:main" },
                  ),
                ),
                { hasMore: true, nextOffset: 50, totalCount: 51 },
              ),
            },
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
        .poll(() => sidebarMigration.locator(".session-run-spinner").isVisible())
        .toBe(true);

      // Hover-revealed management actions on sidebar rows.
      const sidebarResearch = sidebarRows.filter({ hasText: "Research notes" });
      const sidebarResearchPin = sidebarResearch.getByRole("button", { name: "Pin thread" });
      await page.mouse.move(900, 500);
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("0");
      const sidebarReleasePin = sidebarRows
        .filter({ hasText: "Release planning" })
        .getByRole("button", { name: "Unpin thread" });
      await expect.poll(() => actionOpacity(sidebarReleasePin)).toBe("0");
      await sidebarResearch.hover();
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("1");
      await captureUiProof(page, "sidebar-sessions.png");

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

      // The current-main full context menu remains intact: active rows cannot
      // archive, while an idle row can.
      await sidebarMigration.hover();
      await sidebarMigration.getByRole("button", { name: "Open thread menu" }).click();
      await expect
        .poll(() => page.getByRole("menuitem", { name: "Archive thread" }).isDisabled())
        .toBe(true);
      await page.keyboard.press("Escape");
      await sidebarResearch.hover();
      await sidebarResearch.getByRole("button", { name: "Open thread menu" }).click();
      await activateMenuItem(page.getByRole("menuitem", { name: "Archive thread" }));
      const archivePatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:research" && params.archived === true,
      );
      expect(requireRecord(archivePatch.params)).toMatchObject({
        archived: true,
        key: "agent:main:research",
      });

      // Selecting a visible row must not reshuffle the list: the highlight
      // moves while every row keeps its slot. (The mocked gateway keeps
      // returning the same list, so the archived row stays visible here.)
      const researchLink = sidebarResearch.locator("a").first();
      await researchLink.click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:research"));
      await expect.poll(rowNames).toEqual(["Release planning", "Data migration", "Research notes"]);
      await expect
        .poll(() =>
          chatRows
            .filter({ hasText: "Research notes" })
            .first()
            .evaluate((row) => row.classList.contains("sidebar-recent-session--active")),
        )
        .toBe(true);

      // Command palette is the single search surface: querying lists matching
      // chats from the gateway and selecting one navigates to it.
      await page.getByRole("button", { name: "Open command palette" }).click();
      const paletteInput = page.locator(".cmd-palette__input");
      await paletteInput.waitFor({ state: "visible", timeout: 10_000 });
      // Automatic search is intentionally bounded: an all-hidden result set
      // must not scan the entire session store from one palette query.
      await paletteInput.fill("helpers");
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("sessions.list");
          return requests.filter((request) => requireRecord(request.params).search === "helpers")
            .length;
        })
        .toBe(4);
      await page.clock.runFor(400);
      const boundedSearchRequests = await gateway.getRequests("sessions.list");
      expect(
        boundedSearchRequests.filter(
          (request) => requireRecord(request.params).search === "helpers",
        ),
      ).toHaveLength(4);

      await paletteInput.fill("release");
      const paletteOption = page
        .locator(".cmd-palette__item")
        .filter({ hasText: "Release planning" });
      await paletteOption.waitFor({ state: "visible", timeout: 10_000 });
      // The first result page contains 50 hidden child sessions; search must
      // follow nextOffset before exposing the visible chat on page two.
      await expect
        .poll(() =>
          page.locator(".cmd-palette__item").filter({ hasText: "Release helper" }).count(),
        )
        .toBe(0);
      const searchRequests = await gateway.getRequests("sessions.list");
      expect(
        searchRequests.some((request) => {
          const params = requireRecord(request.params);
          return params.search === "release" && params.offset === 50;
        }),
      ).toBe(true);
      await captureUiProof(page, "command-palette-session-search.png");
      await paletteOption.click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:release"));
    } finally {
      await context.close();
    }
  });

  it("shows a rejected Sessions-page custom group instead of leaking a page error", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.groups.put"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
      methodResponses: {
        "sessions.list": sessionsListResponse([]),
      },
      sessionKey: "agent:main:main",
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      await page.locator(".session-groupby__select").selectOption("category");
      page.once("dialog", (dialog) => void dialog.accept("X".repeat(513)));
      await page.getByRole("button", { name: "New group…" }).click();
      await gateway.waitForRequest("sessions.groups.put");
      await gateway.rejectDeferred("sessions.groups.put", {
        code: "INVALID_REQUEST",
        message: "group name exceeds 512 characters",
      });

      const error = page.locator(".sessions-error");
      await error.waitFor({ state: "visible" });
      await expect.poll(() => error.textContent()).toContain("group name exceeds 512 characters");
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("renames, deletes, and toggles sidebar session groups", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await suite.browser.newContext({
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
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
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
      await captureUiProof(page, "sidebar-session-groups.png");

      // Rename group: the gateway renames the catalog entry and repoints every
      // member session server-side (sessions.groups.rename), no per-member patches.
      const groupMenuButton = researchGroup.getByRole("button", {
        name: "Group options for Research",
      });
      await researchGroup.locator(".sidebar-recent-sessions__head").hover();
      await groupMenuButton.click();
      await page.getByRole("menuitem", { name: "Rename group…" }).waitFor({ state: "visible" });
      await captureUiProof(page, "sidebar-group-menu.png");
      page.once("dialog", (dialog) => void dialog.accept("Projects"));
      await activateMenuItem(page.getByRole("menuitem", { name: "Rename group…" }));
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
      page.once("dialog", (dialog) => void dialog.accept());
      await projectsMenuButton.click();
      await activateMenuItem(page.getByRole("menuitem", { name: "Delete group…" }));
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

      // Group by "None" flattens the category sections into the plain list.
      const sortSessionsButton = page.locator(
        "button.sidebar-session-sort:not(.sidebar-session-new)",
      );
      await sortSessionsButton.click();
      await page.getByRole("menuitemradio", { name: "None" }).waitFor({ state: "visible" });
      await captureUiProof(page, "sidebar-groupby-sort-menu.png");
      await sortSessionsButton.click();
      await expect.poll(() => sortSessionsButton.getAttribute("aria-expanded")).toBe("false");
      await expect.poll(() => page.getByRole("menuitemradio", { name: "None" }).count()).toBe(0);
      await captureUiProof(page, "sidebar-groupby-sort-menu-closed.png");

      await sortSessionsButton.click();
      await activateMenuItem(page.getByRole("menuitemradio", { name: "None" }));
      await expect.poll(() => groups.count()).toBe(1);
      await expect.poll(() => groups.first().locator(".sidebar-recent-session").count()).toBe(3);
    } finally {
      await context.close();
    }
  });

  it("preserves a collapsed sidebar group when its rename is rejected", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
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
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
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
      page.once("dialog", (dialog) => void dialog.accept("Projects"));
      await activateMenuItem(page.getByRole("menuitem", { name: "Rename group…" }));
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
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
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
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
      sessionKey: "agent:main:session-0",
      sessionGroups: ["Alpha", "Beta"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebarRows = page.locator(".sidebar-recent-session");
      // Category sections page independently: Alpha and Beta stay visible
      // alongside the first ten rows in the ungrouped section.
      await expect.poll(() => sidebarRows.count()).toBe(12);
      await page.getByRole("button", { name: "Show more" }).click();
      await expect.poll(() => sidebarRows.count()).toBe(13);
      await expect.poll(() => page.getByText("All threads", { exact: true }).count()).toBe(0);
      await captureUiProof(page, "sidebar-all-sessions.png");

      // New groups are created from a session's menu (Move to group → New group…),
      // which files that session into the new group.
      const sessionTen = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-10"]',
      );
      await sessionTen.hover();
      await sessionTen.getByRole("button", { name: "Open thread menu" }).click();
      const moveToGroup = page.getByRole("menuitem", { name: "Move to group" });
      await expect.poll(() => moveToGroup.getAttribute("aria-haspopup")).toBe("menu");
      const moveToGroupIndex = await moveToGroup.evaluate((element) =>
        [...(element.parentElement?.children ?? [])]
          .filter(
            (item) =>
              item.localName === "wa-dropdown-item" &&
              item.getAttribute("slot") !== "submenu" &&
              !(item as HTMLElement & { disabled?: boolean }).disabled,
          )
          .indexOf(element),
      );
      expect(moveToGroupIndex).toBeGreaterThanOrEqual(0);
      // Submenu ARIA is ready before Web Awesome finishes opening the dropdown.
      // Wait for its focus contract so navigation keys cannot outrun the menu.
      await expect
        .poll(() =>
          page.locator("openclaw-session-menu > wa-dropdown > wa-dropdown-item:focus").count(),
        )
        .toBe(1);
      await page.keyboard.press("Home");
      for (let index = 0; index < moveToGroupIndex; index += 1) {
        await page.keyboard.press("ArrowDown");
      }
      await expect
        .poll(() => moveToGroup.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => moveToGroup.getAttribute("aria-expanded")).toBe("true");
      page.once("dialog", (dialog) => void dialog.accept("Gamma"));
      await activateMenuItem(page.getByRole("menuitem", { name: "New group…" }));
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
      await captureUiProof(page, "sidebar-session-dropped-into-group.png");

      const ungrouped = page.locator('[data-session-section="ungrouped"]');
      await gamma
        .locator('.sidebar-recent-session[data-session-key="agent:main:session-11"]')
        .dragTo(ungrouped);
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
      await captureUiProof(page, "sidebar-session-group-collapsed.png");
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
      await captureUiProof(page, "sidebar-session-groups-reordered.png");

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
      const sortSessionsButton = page.getByRole("button", { name: "Sort threads" });
      await sortSessionsButton.locator("..").hover();
      await sortSessionsButton.click();
      await activateMenuItem(page.getByRole("menuitemradio", { name: "None" }));
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
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([]),
      },
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
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
      page.once("dialog", (dialog) => void dialog.accept("Second group"));
      await activateMenuItem(page.getByRole("menuitem", { name: "New group…" }));
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
});
