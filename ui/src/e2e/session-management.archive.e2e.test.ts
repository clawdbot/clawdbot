import { expect, it } from "vitest";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import {
  activateMenuItem,
  captureUiProof,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
  waitForConfirmModal,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

async function confirmDelete(page: import("playwright").Page, proofName?: string) {
  const dialog = await waitForConfirmModal(page);
  if (proofName) {
    await captureUiProof(page, proofName);
  }
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
}

suite.define(() => {
  it("deletes every archived thread exactly once when the paged roster reorders", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const keys = ["agent:main:first", "agent:main:repeated", "agent:main:moved"];
    const archived = keys.map((key, index) =>
      sessionRow(key, key.split(":").at(-1) ?? key, 3 - index, { archived: true }),
    );
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.delete": { ok: true, deleted: true },
        "sessions.list": sessionsListResponse([archived[0]], { totalCount: 1 }),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}sessions?status=archived`);
      const remove = page.getByRole("button", { name: /Delete all archived/ });
      await remove.waitFor();
      await gateway.setMethodResponse("sessions.list", {
        sequence: [
          sessionsListResponse([archived[0], archived[1]], {
            hasMore: true,
            nextOffset: 2,
            totalCount: 3,
          }),
          sessionsListResponse([archived[1]], {
            offset: 2,
            totalCount: 3,
          }),
          sessionsListResponse(archived, { totalCount: 3 }),
        ],
      });
      await remove.click();
      await confirmDelete(page, "styled-confirm-delete-archived.png");

      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.delete")).map(
            (request) => requireRecord(request.params).key,
          ),
        )
        .toEqual(keys);
      for (const request of await gateway.getRequests("sessions.delete")) {
        expect(requireRecord(request.params)).toMatchObject({
          archivedOnly: true,
          deleteTranscript: true,
        });
      }
    } finally {
      await context.close();
    }
  });

  it("never deletes a hidden thread selected before changing the roster search", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const alpha = "agent:main:alpha";
    const bravo = "agent:main:bravo";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.delete": { ok: true, deleted: true },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(alpha, "Alpha", Date.parse("2026-07-01T15:00:00.000Z")),
          sessionRow(bravo, "Bravo", Date.parse("2026-07-01T14:00:00.000Z")),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      const rowFor = (label: string) =>
        page.locator(".session-data-row").filter({ hasText: label });

      await rowFor("Alpha").locator('input[type="checkbox"]').check();
      await page.locator(".data-table-bulk-bar").getByText("1 selected").waitFor();
      await page.locator('.sessions-toolbar__search input[type="text"]').fill("Bravo");

      await expect.poll(() => rowFor("Alpha").count()).toBe(0);
      await expect.poll(() => page.locator(".data-table-bulk-bar").count()).toBe(0);

      await rowFor("Bravo").locator('input[type="checkbox"]').check();
      await page
        .locator(".data-table-bulk-bar")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await confirmDelete(page);
      await gateway.waitForRequest("sessions.delete");

      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.delete")).map(
            (request) => requireRecord(request.params).key,
          ),
        )
        .toEqual([bravo]);
      const request = (await gateway.getRequests("sessions.delete"))[0];
      expect(requireRecord(request?.params)).toMatchObject({
        key: bravo,
        deleteTranscript: true,
      });
    } finally {
      await context.close();
    }
  });

  it("archives a session from the Sessions page context menu and kebab", async () => {
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
            { hasActiveRun: true, status: "running" },
          ),
        ]),
        "sessions.patch": {},
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      const row = page.locator(".session-data-row").filter({ hasText: "Research notes" });
      await row.waitFor({ state: "visible", timeout: 10_000 });

      await row.click({ button: "right" });
      const menuHost = page.locator("openclaw-session-menu");
      await menuHost
        .getByRole("menuitem", { name: "Archive session" })
        .waitFor({ state: "visible" });
      await page.keyboard.press("Escape");

      await row.getByRole("button", { name: "Open session menu" }).click();
      const archiveItem = menuHost.getByRole("menuitem", { name: "Archive session" });
      expect(await archiveItem.isDisabled()).toBe(false);
      expect(await menuHost.getByRole("menuitem", { name: "Delete…" }).isDisabled()).toBe(true);
      await activateMenuItem(archiveItem);
      const patch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:research" && params.archived === true,
      );
      expect(requireRecord(patch.params)).toMatchObject({
        archived: true,
        key: "agent:main:research",
      });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.abort")).toEqual([]);
      expect(await gateway.getRequests("agent.wait")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  // Batch archiving used to serialize one sessions.patch transaction per row.
  // The whole selection now crosses the Gateway once and settles from one list.

  it("archives a mixed active and idle sidebar multi-select in one RPC", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const batchKeys = ["agent:main:batch-a", "agent:main:batch-b", "agent:main:batch-c"] as const;
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", baseTime),
          sessionRow(batchKeys[0], "Batch A", baseTime - 1_000),
          sessionRow(batchKeys[1], "Batch B", baseTime - 2_000, {
            hasActiveRun: true,
            status: "running",
          }),
          sessionRow(batchKeys[2], "Batch C", baseTime - 3_000),
        ]),
        "sessions.patchMany": {
          outcomes: batchKeys.map((key) => ({ ok: true, key, agentId: "main" })),
        },
      },
      sessionArchiveFiltering: true,
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const rowFor = (key: string) =>
        sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await rowFor(batchKeys[0]).waitFor({ state: "visible", timeout: 10_000 });
      for (const key of batchKeys.slice(1)) {
        await rowFor(key).waitFor({ state: "visible" });
      }
      const listCountBeforeBatch = (await gateway.getRequests("sessions.list")).length;

      for (const key of batchKeys) {
        await rowFor(key).click({ modifiers: ["Meta"] });
      }
      await rowFor(batchKeys[0]).click({ button: "right" });
      const batchMenu = page.locator("openclaw-session-menu");
      const archiveItem = batchMenu.getByRole("menuitem", { name: `Archive ${batchKeys.length}` });
      await archiveItem.waitFor({ state: "visible", timeout: 10_000 });
      expect(await archiveItem.isDisabled()).toBe(false);
      expect(
        await batchMenu.getByRole("menuitem", { name: `Delete ${batchKeys.length}…` }).isDisabled(),
      ).toBe(true);
      await captureUiProof(page, "sidebar-multi-select-archive-menu.png");
      await page.keyboard.press("A");

      const patchMany = await gateway.waitForRequest("sessions.patchMany");
      const patchManyParams = requireRecord(patchMany.params);
      expect(patchManyParams.patch).toEqual({ archived: true });
      expect(
        (patchManyParams.targets as Array<{ key: string }>).map((target) => target.key),
      ).toEqual([...batchKeys]);
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("sessions.abort")).toEqual([]);
      expect(await gateway.getRequests("agent.wait")).toEqual([]);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length, { timeout: 10_000 })
        .toBe(listCountBeforeBatch + 1);
      for (const key of batchKeys) {
        await rowFor(key).waitFor({ state: "detached" });
      }
      await expect.poll(() => page.locator("[data-sidebar-session-error]").count()).toBe(0);
      await expect
        .poll(() => page.locator(".app-toast").textContent())
        .toContain("Archived 3 sessions");
      await captureUiProof(page, "sidebar-multi-select-archive-settled.png");
      await page.waitForTimeout(500);
      expect((await gateway.getRequests("sessions.list")).length).toBe(listCountBeforeBatch + 1);
    } finally {
      await context.close();
    }
  });

  it("keeps the selected session through archive refreshes and restores the composer", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const sessionRows = Array.from({ length: 15 }, (_, index) => {
      const row = sessionRow(
        `agent:main:archive-refresh-${index}`,
        `Archive refresh ${index}`,
        baseTime - (index + 1) * 1_000,
      );
      return index === 2
        ? {
            ...row,
            displayName: undefined,
            label: undefined,
            derivedTitle: `Archive refresh ${index}`,
            parentSessionKey: "agent:main:main",
            sessionId: `archive-refresh-${index}`,
          }
        : row;
    });
    const selected = sessionRows[2]!;
    const selectedWithoutDerivedTitle = { ...selected, derivedTitle: undefined };
    const batchRows = [sessionRows[0]!, sessionRows[1]!, sessionRows[3]!];
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", baseTime),
          ...sessionRows,
        ]),
        "sessions.patchMany": {
          outcomes: batchRows.map((row) => ({ ok: true, key: row.key, agentId: "main" })),
        },
        "sessions.patch": {},
      },
      sessionArchiveFiltering: true,
      sessionKey: "agent:main:main",
    });

    const assertSelectedRoute = async () => {
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath(selected.key));
      const row = page.locator(`.sidebar-recent-session[data-session-key="${selected.key}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => row.getAttribute("class"))
        .toContain("sidebar-recent-session--active");
    };

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const rowFor = (key: string) =>
        sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await rowFor(selected.key).waitFor({ state: "visible", timeout: 10_000 });
      await rowFor(selected.key).locator("a").first().click();
      await assertSelectedRoute();
      await page
        .locator('openclaw-chat-pane[aria-hidden="false"] .agent-chat__input textarea')
        .waitFor({ state: "visible" });
      await page.evaluate((sessionKey) => {
        const titleHistory: string[] = [];
        const paneTitleHistory: string[] = [];
        const documentTitleHistory: string[] = [];
        const sessionStateHistory: Array<{
          gatewaySessionKey?: string;
          loading?: boolean;
          selectedTitle?: string;
        }> = [];
        const recordTitle = () => {
          const row = [...document.querySelectorAll<HTMLElement>(".sidebar-recent-session")].find(
            (candidate) => candidate.dataset.sessionKey === sessionKey,
          );
          const title = row
            ?.querySelector(".sidebar-recent-session__name")
            ?.textContent?.replace(/\s+/g, " ")
            .trim();
          if (title && titleHistory.at(-1) !== title) {
            titleHistory.push(title);
          }
          const paneTitle = document
            .querySelector(".chat-pane__session-title")
            ?.textContent?.replace(/\s+/g, " ")
            .trim();
          if (paneTitle && paneTitleHistory.at(-1) !== paneTitle) {
            paneTitleHistory.push(paneTitle);
          }
          if (document.title && documentTitleHistory.at(-1) !== document.title) {
            documentTitleHistory.push(document.title);
          }
        };
        new MutationObserver(recordTitle).observe(document.documentElement, {
          childList: true,
          characterData: true,
          subtree: true,
        });
        recordTitle();
        (window as Window & { archiveTitleHistory?: string[] }).archiveTitleHistory = titleHistory;
        (
          window as Window & {
            archivePaneTitleHistory?: string[];
            archiveDocumentTitleHistory?: string[];
          }
        ).archivePaneTitleHistory = paneTitleHistory;
        (
          window as Window & {
            archivePaneTitleHistory?: string[];
            archiveDocumentTitleHistory?: string[];
            archiveSessionStateHistory?: typeof sessionStateHistory;
          }
        ).archiveDocumentTitleHistory = documentTitleHistory;
        const shell = document.querySelector("openclaw-app-shell") as HTMLElement & {
          runtime?: {
            context?: {
              gateway?: { snapshot?: { sessionKey?: string } };
              sessions?: {
                subscribe: (
                  listener: (state: {
                    loading?: boolean;
                    result?: { sessions?: Array<{ key: string; derivedTitle?: string }> } | null;
                  }) => void,
                ) => () => void;
              };
            };
          };
        };
        shell.runtime?.context?.sessions?.subscribe((state) => {
          const selectedRow = state.result?.sessions?.find((session) => session.key === sessionKey);
          sessionStateHistory.push({
            gatewaySessionKey: shell.runtime?.context?.gateway?.snapshot?.sessionKey,
            loading: state.loading,
            selectedTitle: selectedRow?.derivedTitle,
          });
        });
        (
          window as Window & {
            archiveSessionStateHistory?: typeof sessionStateHistory;
          }
        ).archiveSessionStateHistory = sessionStateHistory;
      }, selected.key);

      for (const row of batchRows) {
        await rowFor(row.key).click({ modifiers: ["Meta"] });
      }
      await rowFor(batchRows[0]!.key).click({ button: "right" });
      const batchMenu = page.locator("openclaw-session-menu");
      await activateMenuItem(
        batchMenu.getByRole("menuitem", { name: `Archive ${batchRows.length}` }),
      );
      await gateway.waitForRequest("sessions.patchMany");
      for (const row of batchRows) {
        await gateway.emitGatewayEvent("sessions.changed", {
          ...row,
          archived: true,
          reason: "update",
          sessionKey: row.key,
        });
        await assertSelectedRoute();
      }

      const selectedRow = rowFor(selected.key);
      await gateway.setMethodResponse("sessions.describe", {
        session: { ...selectedWithoutDerivedTitle, archived: true },
      });
      await selectedRow.hover();
      await selectedRow.getByRole("button", { name: "Open session menu" }).click();
      await activateMenuItem(
        page.locator("openclaw-session-menu").getByRole("menuitem", {
          name: "Archive session",
        }),
      );
      await waitForPatch(
        gateway,
        (params) => params.key === selected.key && params.archived === true,
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        ...selected,
        archived: true,
        reason: "update",
        sessionKey: selected.key,
      });
      await expect.poll(() => selectedRow.textContent()).toContain("Archive refresh 2");

      await assertSelectedRoute();
      await selectedRow.locator(".sidebar-session__archive-glyph").waitFor({ state: "visible" });
      await expect.poll(() => selectedRow.textContent()).toContain("Archive refresh 2");
      expect(
        await page.evaluate(
          () => (window as Window & { archiveTitleHistory?: string[] }).archiveTitleHistory ?? [],
        ),
      ).toEqual(["Archive refresh 2"]);
      const sessionStateHistory = await page.evaluate(
        () =>
          (
            window as Window & {
              archiveSessionStateHistory?: Array<{
                gatewaySessionKey?: string;
                loading?: boolean;
                selectedTitle?: string;
              }>;
            }
          ).archiveSessionStateHistory ?? [],
      );
      const missingTitleSnapshot = sessionStateHistory.find(
        (snapshot) => snapshot.selectedTitle !== "Archive refresh 2",
      );
      if (missingTitleSnapshot) {
        throw new Error(`Selected title changed: ${JSON.stringify(sessionStateHistory)}`);
      }
      expect(
        await page.evaluate(
          () =>
            (
              window as Window & {
                archivePaneTitleHistory?: string[];
              }
            ).archivePaneTitleHistory ?? [],
        ),
      ).toEqual(["Archive refresh 2"]);
      expect(
        await page.evaluate(
          () =>
            (
              window as Window & {
                archiveDocumentTitleHistory?: string[];
              }
            ).archiveDocumentTitleHistory ?? [],
        ),
      ).not.toContain("New session — OpenClaw");
      const archivedNotice = page.locator(".agent-chat__disabled-banner");
      await archivedNotice.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => archivedNotice.textContent()).toContain("This session is archived.");
      await expect
        .poll(() => page.locator(".chat-pane-cache__pane--visible .agent-chat__input").count())
        .toBe(0);

      const archiveToast = page.locator("openclaw-toast-host .app-toast");
      await expect.poll(() => archiveToast.textContent()).toContain("Session archived");
      await archiveToast.getByRole("button", { name: "Dismiss" }).click();
      await archivedNotice.getByRole("button", { name: "Unarchive" }).click();
      await waitForPatch(
        gateway,
        (params) => params.key === selected.key && params.archived === false,
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        ...selected,
        archived: false,
        reason: "update",
        sessionKey: selected.key,
      });

      await assertSelectedRoute();
      await archivedNotice.waitFor({ state: "detached", timeout: 10_000 });
      await page
        .locator(".chat-pane-cache__pane--visible .agent-chat__input textarea")
        .waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  });

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
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.describe": { session: archived },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", archived.updatedAt + 1),
        ]),
        "sessions.patch": {},
      },
      sessionArchiveFiltering: true,
      sessionKey: archived.key,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat?session=${encodeURIComponent(archived.key)}`);

      const selectedRow = page.locator(
        `.sidebar-recent-session[data-session-key="${archived.key}"]`,
      );
      await selectedRow.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => selectedRow.getAttribute("class"))
        .toContain("sidebar-recent-session--active");
      await selectedRow.locator(".sidebar-session__archive-glyph").waitFor({ state: "visible" });
      await expect.poll(() => page.getByText("Archived planning", { exact: true }).count()).toBe(2);

      const archivedNotice = page.locator(".agent-chat__disabled-banner");
      await archivedNotice.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => archivedNotice.textContent()).toContain("This session is archived.");
      await expect.poll(() => page.locator(".agent-chat__input").count()).toBe(0);

      await gateway.setMethodResponse("sessions.describe", {
        session: { ...archived, archived: false },
      });
      await archivedNotice.getByRole("button", { name: "Unarchive" }).click();
      await waitForPatch(
        gateway,
        (params) => params.key === archived.key && params.archived === false,
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        ...archived,
        archived: false,
        reason: "update",
        sessionKey: archived.key,
      });

      await archivedNotice.waitFor({ state: "detached", timeout: 10_000 });
      await page.locator(".agent-chat__input textarea").waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  });

  it("recovers a deleted active chat without repeatedly resolving its missing session", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const routeErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("route")) {
        routeErrors.push(message.text());
      }
    });
    const deletedKey = "agent:main:deleted-thread";
    const mainKey = "agent:main:main";
    const updatedAt = Date.parse("2026-07-01T16:00:00.000Z");
    const mainSession = sessionRow(mainKey, "Main", updatedAt);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          mainSession,
          sessionRow(deletedKey, "Deleted thread", updatedAt - 1_000),
        ]),
      },
      sessionKey: mainKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, deletedKey));
      await page
        .locator(".chat-pane-cache__pane--visible .agent-chat__input textarea")
        .waitFor({ state: "visible", timeout: 10_000 });

      const requestsBeforeDeletion = (await gateway.getRequests("sessions.list")).length;
      await gateway.setMethodResponse("sessions.list", sessionsListResponse([mainSession]));
      await gateway.emitGatewayEvent("sessions.changed", {
        agentId: "main",
        reason: "delete",
        sessionKey: deletedKey,
      });

      await expect
        .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
        .toBe(controlUiSessionPath(mainKey));
      await page
        .locator(".chat-pane-cache__pane--visible .agent-chat__input textarea")
        .waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(requestsBeforeDeletion);
      await expect
        .poll(
          async () => {
            const count = (await gateway.getRequests("sessions.list")).length;
            await new Promise((resolve) => {
              setTimeout(resolve, 350);
            });
            return (await gateway.getRequests("sessions.list")).length - count;
          },
          { timeout: 5_000 },
        )
        .toBe(0);

      const settledRequestCount = (await gateway.getRequests("sessions.list")).length;
      await expectRequestCountStable(gateway, "sessions.list", settledRequestCount);
      expect(routeErrors).toEqual([]);
      await captureUiProof(page, "deleted-active-session-fallback.png");
    } finally {
      await context.close();
    }
  });

  it("archive-gates a row-menu delete and keeps the row when the Gateway reports no deletion", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const key = "agent:main:research";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.delete": { ok: true, deleted: false },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(key, "Research notes", Date.parse("2026-07-01T15:00:00.000Z"), {
            archived: true,
          }),
        ]),
      },
      sessionKey: "agent:main:main",
    });
    try {
      await page.goto(`${suite.server.baseUrl}sessions?status=archived`);
      const row = page.locator(".session-data-row").filter({ hasText: "Research notes" });
      await row.waitFor({ state: "visible", timeout: 10_000 });

      await row.getByRole("button", { name: "Open session menu" }).click();
      await activateMenuItem(
        page.locator("openclaw-session-menu").getByRole("menuitem", { name: "Delete…" }),
      );
      await confirmDelete(page);

      const request = await gateway.waitForRequest("sessions.delete");
      expect(requireRecord(request.params)).toMatchObject({
        archivedOnly: true,
        deleteTranscript: true,
        key,
      });
      await row.waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  });
});
