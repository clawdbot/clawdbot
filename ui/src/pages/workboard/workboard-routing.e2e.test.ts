import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  waitForControlUiRoute,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard routing",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/workboard-routing");
const boards = [
  { id: "default", total: 0, active: 0, archived: 0, byStatus: {} },
  {
    id: "ops",
    name: "Operations",
    icon: "⚙",
    color: "#22c55e",
    total: 0,
    active: 0,
    archived: 0,
    byStatus: {},
  },
];

function configSnapshot(enabled: boolean) {
  const config = { plugins: { entries: { workboard: { enabled } } } };
  return {
    config,
    hash: `workboard-routing-${enabled}`,
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config),
    resolved: config,
    sourceConfig: config,
  };
}

function sessionsListResponse() {
  return {
    count: 0,
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [],
    ts: 1,
  };
}

async function newRecordedPage(label: string): Promise<{
  context: BrowserContext;
  page: Page;
  rawVideoDir: string;
}> {
  const rawVideoDir = path.join(artifactDir, `${label}-raw`);
  if (captureUiProofEnabled) {
    await rm(rawVideoDir, { force: true, recursive: true });
    await mkdir(rawVideoDir, { recursive: true });
  }
  const context = await suite.browser.newContext({
    locale: "en-US",
    recordVideo: captureUiProofEnabled
      ? { dir: rawVideoDir, size: { width: 1600, height: 1000 } }
      : undefined,
    serviceWorkers: "block",
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
  return { context, page, rawVideoDir };
}

async function closeRecordedPage(
  recorded: Awaited<ReturnType<typeof newRecordedPage>>,
  label: string,
) {
  const video = recorded.page.video();
  await recorded.context.close();
  if (video) {
    await copyFile(await video.path(), path.join(artifactDir, `${label}.webm`));
  }
  if (captureUiProofEnabled) {
    await rm(recorded.rawVideoDir, { force: true, recursive: true });
  }
}

suite.define(() => {
  it("routes, pins, persists, and normalizes Workboard boards", async () => {
    if (captureUiProofEnabled) {
      await rm(artifactDir, { force: true, recursive: true });
    }
    const recorded = await newRecordedPage("routing");
    const { page } = recorded;
    try {
      await installMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "config.get": configSnapshot(true),
          "sessions.list": sessionsListResponse(),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.boards.list": { boards },
          "workboard.cards.list": { boards, cards: [], statuses: ["todo", "done"] },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}workboard/ops?agent=main`);
      expect(response?.status()).toBe(200);
      await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
      const headerGlyph = page.locator(".workboard-board-glyph--header");
      await expect.poll(() => headerGlyph.textContent()).toContain("⚙");
      await expect.poll(() => headerGlyph.getAttribute("style")).toContain("#22c55e");
      await page.locator(".workboard-select--toolbar-board").waitFor();
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "01-board-route.png"),
        });
      }

      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-nav__head-action").click();
      await sidebar
        .locator("wa-dropdown.sidebar-more-menu")
        .getByRole("menuitem", { name: "Edit pinned items" })
        .click();
      const customize = sidebar.locator(
        "wa-dropdown.sidebar-customize-menu:not(.sidebar-more-menu)",
      );
      await customize.getByRole("menuitemcheckbox", { name: /Operations/u }).click();
      const pinnedBoard = sidebar.locator('[data-sidebar-entry="plugin:workboard/board-ops"] a');
      await pinnedBoard.waitFor();
      expect(await pinnedBoard.getAttribute("href")).toBe("/workboard/ops");
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "02-pinned-board.png"),
        });
      }

      await page.goto(`${suite.server.baseUrl}workboard?board=ops&agent=main`);
      await waitForControlUiRoute(page, {
        pathname: "/workboard/ops",
        routeId: "workboard",
        search: "?agent=main",
      });
      expect(new URL(page.url()).searchParams.get("board")).toBeNull();
      expect(new URL(page.url()).searchParams.get("agent")).toBe("main");

      await page.reload();
      await sidebar.locator('[data-sidebar-entry="plugin:workboard/board-ops"] a').waitFor();
      await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "03-legacy-normalized-and-persisted.png"),
        });
      }

      const historyBeforeMissingBoard = await page.evaluate(() => history.length);
      await page.goto(`${suite.server.baseUrl}workboard/deleted?agent=main`);
      await waitForControlUiRoute(page, {
        pathname: "/workboard",
        routeId: "workboard",
        search: "?agent=main",
      });
      expect(new URL(page.url()).searchParams.get("agent")).toBe("main");
      await page.locator(".workboard-page-title", { hasText: "Workboard" }).waitFor();
      expect(await page.evaluate(() => history.length)).toBe(historyBeforeMissingBoard + 1);
    } finally {
      await closeRecordedPage(recorded, "routing");
    }
  });

  it("creates cards for the selected named agent without hiding them", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1600, height: 1000 },
      },
      async ({ page }) => {
        const createdCard = {
          id: "writer-card",
          title: "Keep the writer task visible",
          status: "todo",
          priority: "normal",
          labels: [],
          agentId: "writer",
          position: 1000,
          createdAt: 1,
          updatedAt: 1,
        };

        const gateway = await installMockGateway(page, {
          ...workboardUi,
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
              agents: [
                { id: "main", name: "Main" },
                { id: "writer", name: "Writer" },
              ],
            },
            "config.get": configSnapshot(true),
            "sessions.list": sessionsListResponse(),
            "tasks.list": { nextCursor: null, tasks: [] },
            "workboard.boards.list": { boards },
            "workboard.cards.list": { boards, cards: [], statuses: ["todo", "done"] },
          },
        });
        await page.goto(`${suite.server.baseUrl}workboard`);
        await gateway.waitForRequest("agents.list");

        const agentScope = page.locator(".agent-scope-control openclaw-agent-select");
        await agentScope.locator(".agent-select__trigger").click();
        await expect
          .poll(() =>
            agentScope
              .locator("wa-dropdown-item[data-agent-option]")
              .filter({ hasText: "Main" })
              .evaluate((option) => option === document.activeElement),
          )
          .toBe(true);
        await agentScope
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "Writer" })
          .click();
        await expect
          .poll(() =>
            agentScope.evaluate((select) => (select as HTMLElement & { value: string }).value),
          )
          .toBe("writer");
        await expect
          .poll(
            () =>
              agentScope.locator("wa-dropdown").evaluate((dropdown) => {
                const popup = dropdown.shadowRoot?.querySelector("wa-popup");
                return {
                  open: (dropdown as HTMLElement & { open: boolean }).open,
                  popupActive: Boolean(
                    (popup as (HTMLElement & { active: boolean }) | null)?.active,
                  ),
                };
              }),
            { timeout: 5_000 },
          )
          .toEqual({ open: false, popupActive: false });

        await gateway.deferNext("workboard.cards.create");
        await page.getByRole("button", { name: /New card/u }).click();

        const createForm = page.locator(".workboard-draft");
        await expect
          .poll(() =>
            createForm
              .locator(".workboard-agent-select openclaw-agent-select")
              .evaluate((select) => (select as HTMLElement & { value: string }).value),
          )
          .toBe("writer");
        await createForm.getByLabel("Title").fill(createdCard.title);
        await createForm.getByRole("button", { name: /^Create$/u }).click();

        const createRequest = await gateway.waitForRequest("workboard.cards.create");
        expect(createRequest.params).toMatchObject({
          agentId: "writer",
          title: createdCard.title,
        });
        await gateway.resolveDeferred("workboard.cards.create", { card: createdCard });

        await page.locator(".workboard-card", { hasText: createdCard.title }).waitFor({
          state: "visible",
        });
      },
    );
  });

  it("hides Workboard navigation while the plugin is inactive", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        nativePlugins: [],
        methodResponses: {
          "config.get": configSnapshot(false),
          "sessions.list": sessionsListResponse(),
          "workboard.boards.list": { boards },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-nav__head-action").click();
      const moreMenu = sidebar.locator("wa-dropdown.sidebar-more-menu");
      await moreMenu.waitFor();
      expect(await moreMenu.getByText("Workboard", { exact: true }).count()).toBe(0);
      await moreMenu.getByRole("menuitem", { name: "Edit pinned items" }).click();
      const customize = sidebar.locator(
        "wa-dropdown.sidebar-customize-menu:not(.sidebar-more-menu)",
      );
      expect(await customize.getByText("Workboard", { exact: true }).count()).toBe(0);
      expect(await customize.locator('[value^="plugin:workboard/"]').count()).toBe(0);
    });
  });
});
