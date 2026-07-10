// Control UI tests cover session management through the sidebar, Sessions page, and command palette.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options: {
    archived?: boolean;
    category?: string;
    pinned?: boolean;
    pinnedAt?: number;
    hasActiveRun?: boolean;
    status?: string;
    spawnedBy?: string;
  } = {},
) {
  return {
    contextTokens: null,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: "gpt-5.5",
    modelProvider: "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
    ...options,
  };
}

function sessionsListResponse(
  sessions: unknown[],
  options: {
    hasMore?: boolean;
    nextOffset?: number | null;
    offset?: number;
    totalCount?: number;
  } = {},
) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    hasMore: options.hasMore ?? false,
    limitApplied: 50,
    nextOffset: options.nextOffset ?? null,
    offset: options.offset ?? 0,
    path: "",
    sessions,
    totalCount: options.totalCount ?? sessions.length,
    ts: Date.now(),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

async function waitForPatch(
  gateway: MockGatewayControls,
  predicate: (params: Record<string, unknown>) => boolean,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  let requests: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    requests = await gateway.getRequests("sessions.patch");
    const match = requests.find((request) => predicate(requireRecord(request.params)));
    if (match) {
      return match;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`No matching sessions.patch request found: ${JSON.stringify(requests)}`);
}

function trimmedTextContents(locator: Locator): Promise<string[]> {
  return locator.evaluateAll((elements) =>
    elements.map((element) => element.textContent?.trim() ?? ""),
  );
}

function actionOpacity(button: Locator): Promise<string> {
  return button.evaluate((element) => globalThis.getComputedStyle(element).opacity);
}

function actionPointerEvents(button: Locator): Promise<string> {
  return button.evaluate((element) => globalThis.getComputedStyle(element).pointerEvents);
}

async function captureUiProof(page: Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "thread-management");
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, fileName) });
}

describeControlUiE2e("Control UI session management mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("manages sessions through the sidebar groups and command palette", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await browser.newContext({
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
      await page.goto(`${server.baseUrl}chat`);

      // Sidebar: pinned rows form their own group ahead of the Sessions group.
      const sidebarRows = page.locator(".sidebar-recent-sessions__list .sidebar-recent-session");
      await sidebarRows.first().waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sidebarRows.first().textContent()).toContain("Release planning");
      const groups = page.locator(".sidebar-recent-sessions__group");
      await expect.poll(() => groups.count()).toBe(2);
      await expect
        .poll(() => groups.first().locator(".sidebar-recent-sessions__label-text").textContent())
        .toContain("Pinned");

      // Chats keep recency order with the open session highlighted in place —
      // selecting a row must not reshuffle the list.
      const chatRows = page.locator('[data-session-section="ungrouped"] .sidebar-recent-session');
      const rowNames = () =>
        chatRows.evaluateAll((rows) =>
          rows.map((row) => row.querySelector(".sidebar-recent-session__name")?.textContent ?? ""),
        );
      await expect.poll(rowNames).toEqual(["Main", "Data migration", "Research notes"]);
      const sidebarMigration = sidebarRows.filter({ hasText: "Data migration" });
      await expect
        .poll(() => sidebarMigration.locator(".session-run-spinner").isVisible())
        .toBe(true);

      // Hover-revealed management actions on sidebar rows.
      const sidebarResearch = sidebarRows.filter({ hasText: "Research notes" });
      const sidebarResearchPin = sidebarResearch.getByRole("button", { name: "Pin session" });
      await page.mouse.move(900, 500);
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("0");
      const sidebarReleasePin = sidebarRows
        .filter({ hasText: "Release planning" })
        .getByRole("button", { name: "Unpin session" });
      // Pinned badge stays visible without hover.
      await expect.poll(() => actionOpacity(sidebarReleasePin)).toBe("1");
      await sidebarResearch.hover();
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("1");
      await captureUiProof(page, "sidebar-sessions.png");

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
      await sidebarMigration.getByRole("button", { name: "Open session menu" }).click();
      await expect
        .poll(() => page.getByRole("menuitem", { name: "Archive session" }).isDisabled())
        .toBe(true);
      await page.keyboard.press("Escape");
      await sidebarResearch.hover();
      await sidebarResearch.getByRole("button", { name: "Open session menu" }).click();
      await page.getByRole("menuitem", { name: "Archive session" }).click();
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
      await expect.poll(() => page.url()).toContain("session=agent%3Amain%3Aresearch");
      await expect
        .poll(rowNames)
        .toEqual(["Main", "Release planning", "Data migration", "Research notes"]);
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
      await page.waitForTimeout(400);
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
      await expect.poll(() => page.url()).toContain("session=agent%3Amain%3Arelease");
    } finally {
      await context.close();
    }
  });

  it("dismisses fixed session menus before the sidebar or drawer hides", async () => {
    const context = await browser.newContext({
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
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const row = sidebar.locator(
        '.sidebar-recent-session[data-session-key="agent:main:research"]',
      );
      const shell = page.locator(".shell");
      const shellNav = page.locator(".shell-nav");
      const collapseButton = sidebar
        .locator(".sidebar-brand")
        .getByRole("button", { name: "Collapse sidebar" });
      const expandButton = page.locator(".shell-nav-expand");
      const drawerToggle = page.locator(".topbar-nav-toggle");
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
        dialogs: dialogs.length,
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

  it("archives a session from the Sessions page context menu and kebab", async () => {
    const context = await browser.newContext({
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

    try {
      await page.goto(`${server.baseUrl}sessions`);
      const row = page.locator(".session-data-row").filter({ hasText: "Research notes" });
      await row.waitFor({ state: "visible", timeout: 10_000 });

      await row.click({ button: "right" });
      const menu = page.getByRole("menu", { name: "Actions for Research notes" });
      await menu.getByRole("menuitem", { name: "Archive session" }).waitFor({ state: "visible" });
      await page.keyboard.press("Escape");

      await row.getByRole("button", { name: "Open session menu" }).click();
      await menu.getByRole("menuitem", { name: "Archive session" }).click();
      const patch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:research" && params.archived === true,
      );
      expect(requireRecord(patch.params)).toMatchObject({
        archived: true,
        key: "agent:main:research",
      });
    } finally {
      await context.close();
    }
  });

  it("keeps sidebar sessions visible through a same-client Gateway reconnect", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:disconnect-proof";
    const otherSessionKeys = ["agent:main:other-a", "agent:main:other-b"];
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
      await page.goto(`${server.baseUrl}chat`);
      const sidebarRow = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      await sidebarRow.waitFor({ state: "visible", timeout: 10_000 });
      const sidebarRows = page.locator(".sidebar-recent-session");
      await expect.poll(() => sidebarRows.count()).toBe(3);
      const initialListCount = (await gateway.getRequests("sessions.list")).length;

      await gateway.closeLatest(1006, "disconnect proof");
      await page.locator(".connection-banner").waitFor({ state: "visible", timeout: 10_000 });
      await gateway.deferNext("sessions.list");
      await sidebarRow.waitFor({ state: "visible" });
      await captureUiProof(page, "sidebar-sessions-during-reconnect.png");

      await expect.poll(() => gateway.getSocketCount(), { timeout: 15_000 }).toBeGreaterThan(1);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length, { timeout: 15_000 })
        .toBeGreaterThan(initialListCount);
      await page.locator(".connection-banner").waitFor({ state: "detached", timeout: 15_000 });
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
      // Reconnect can queue a second refresh behind session hydration. Hold both
      // so each response carries the changed black-box fixture.
      await gateway.deferNext("sessions.list");
      await gateway.resolveDeferred("sessions.list", refreshedResponse);
      await expect.poll(() => sidebarRow.textContent()).toContain("Reconnect refreshed");
      await expect.poll(() => sidebarRows.count()).toBe(3);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length, { timeout: 10_000 })
        .toBeGreaterThan(firstReconnectListCount);
      await gateway.resolveDeferred("sessions.list", refreshedResponse);
      await expect.poll(() => sidebarRow.textContent()).toContain("Reconnect refreshed");
    } finally {
      await context.close();
    }
  });

  it("renames, deletes, and toggles sidebar session groups", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await browser.newContext({
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
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      // Categorized rows render as their own sidebar group section.
      const groups = page.locator(".sidebar-recent-sessions__group");
      const researchGroup = groups.filter({ hasText: "Research" });
      await researchGroup.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => researchGroup.locator(".sidebar-recent-session").count()).toBe(2);
      await captureUiProof(page, "sidebar-session-groups.png");

      // Rename group: every member session is patched, including the archived
      // row that only the unbounded archived list window can see.
      const groupMenuButton = researchGroup.getByRole("button", {
        name: "Group options for Research",
      });
      await researchGroup.locator(".sidebar-recent-sessions__head").hover();
      await groupMenuButton.click();
      await page.getByRole("menuitem", { name: "Rename group…" }).waitFor({ state: "visible" });
      await captureUiProof(page, "sidebar-group-menu.png");
      page.once("dialog", (dialog) => void dialog.accept("Projects"));
      await page.getByRole("menuitem", { name: "Rename group…" }).click();
      for (const key of ["agent:main:paper-a", "agent:main:paper-b", "agent:main:old-notes"]) {
        const patch = await waitForPatch(
          gateway,
          (params) => params.key === key && params.category === "Projects",
        );
        expect(requireRecord(patch.params)).toMatchObject({ category: "Projects", key });
      }
      await expect
        .poll(() =>
          page
            .locator('[data-session-section^="category:"]')
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-session-section")),
            ),
        )
        .toEqual(["category:Apps", "category:Projects"]);

      // Delete group: sessions survive and move back to Ungrouped.
      const projectsGroup = groups.filter({ hasText: "Projects" });
      await projectsGroup.waitFor({ state: "visible" });
      const projectsMenuButton = projectsGroup.getByRole("button", {
        name: "Group options for Projects",
      });
      await projectsGroup.locator(".sidebar-recent-sessions__head").hover();
      page.once("dialog", (dialog) => void dialog.accept());
      await projectsMenuButton.click();
      await page.getByRole("menuitem", { name: "Delete group…" }).click();
      const dissolvePatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:paper-a" && params.category === null,
      );
      expect(requireRecord(dissolvePatch.params)).toMatchObject({
        category: null,
        key: "agent:main:paper-a",
      });

      // Group by "None" flattens the category sections into the plain list.
      const sortSessionsButton = page.getByRole("button", { name: "Sort sessions" });
      await sortSessionsButton.click();
      await page.getByRole("menuitemradio", { name: "None" }).waitFor({ state: "visible" });
      await captureUiProof(page, "sidebar-groupby-sort-menu.png");
      await sortSessionsButton.click();
      await expect.poll(() => sortSessionsButton.getAttribute("aria-expanded")).toBe("false");
      await expect.poll(() => page.getByRole("menuitemradio", { name: "None" }).count()).toBe(0);
      await captureUiProof(page, "sidebar-groupby-sort-menu-closed.png");

      await sortSessionsButton.click();
      await page.getByRole("menuitemradio", { name: "None" }).click();
      await expect.poll(() => groups.count()).toBe(1);
      await expect.poll(() => groups.first().locator(".sidebar-recent-session").count()).toBe(4);
    } finally {
      await context.close();
    }
  });

  it("shows every sidebar session and supports complete drag-managed groups", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessions = Array.from({ length: 12 }, (_, index) =>
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
      sessionKey: "agent:main:session-0",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const sidebarRows = page.locator(".sidebar-recent-session");
      await expect.poll(() => sidebarRows.count()).toBe(12);
      await expect.poll(() => page.getByText("All sessions", { exact: true }).count()).toBe(0);
      await captureUiProof(page, "sidebar-all-sessions.png");

      page.once("dialog", (dialog) => void dialog.accept("Gamma"));
      await page.getByRole("button", { name: "New group…" }).click();
      const gamma = page.locator('[data-session-section="category:Gamma"]');
      await gamma.waitFor({ state: "visible" });

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
        .toBe(1);
      await captureUiProof(page, "sidebar-session-dropped-into-group.png");

      const ungrouped = page.locator('[data-session-section="ungrouped"]');
      await gamma.locator(".sidebar-recent-session").dragTo(ungrouped);
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
      const sortSessionsButton = page.getByRole("button", { name: "Sort sessions" });
      await sortSessionsButton.click();
      await page.getByRole("menuitemradio", { name: "None" }).click();
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
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      page.once("dialog", (dialog) => void dialog.accept("First group"));
      await page.getByRole("button", { name: "New group…" }).click();
      await page.locator('[data-session-section="category:First group"]').waitFor({
        state: "visible",
      });
      await page.locator('[data-session-section="ungrouped"] .sidebar-recent-session').waitFor({
        state: "visible",
      });
    } finally {
      await context.close();
    }
  });

  it("does not duplicate the active chat when its only session is pinned", async () => {
    const context = await browser.newContext({
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
      await page.goto(`${server.baseUrl}chat`);

      const pinnedGroup = page.locator('[data-session-section="pinned"]');
      const chatsGroup = page.locator('[data-session-section="ungrouped"]');
      await expect
        .poll(() => trimmedTextContents(pinnedGroup.locator(".sidebar-recent-session__name")))
        .toEqual(["Pinned only"]);
      await expect.poll(() => chatsGroup.locator(".sidebar-recent-session").count()).toBe(0);
      await expect.poll(() => page.locator(".sidebar-recent-session--active").count()).toBe(1);
      await pinnedGroup.locator(".sidebar-recent-session").dragTo(chatsGroup);
      const unpinPatch = await waitForPatch(
        gateway,
        (params) =>
          params.key === "agent:main:pinned" && params.category === null && params.pinned === false,
      );
      expect(requireRecord(unpinPatch.params)).toMatchObject({
        category: null,
        key: "agent:main:pinned",
        pinned: false,
      });
      await expect.poll(() => pinnedGroup.locator(".sidebar-recent-session").count()).toBe(0);
      await expect.poll(() => chatsGroup.locator(".sidebar-recent-session").count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("keeps sidebar session controls reachable on touch pointers", async () => {
    const context = await browser.newContext({
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
      await page.goto(`${server.baseUrl}chat`);
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
