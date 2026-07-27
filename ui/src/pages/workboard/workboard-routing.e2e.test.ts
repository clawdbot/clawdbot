import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
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

let server: ControlUiE2eServer;
let browser: Browser;

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
  await mkdir(artifactDir, { recursive: true });
  const rawVideoDir = path.join(artifactDir, `${label}-raw`);
  await rm(rawVideoDir, { force: true, recursive: true });
  await mkdir(rawVideoDir, { recursive: true });
  const context = await browser.newContext({
    locale: "en-US",
    recordVideo: { dir: rawVideoDir, size: { width: 1600, height: 1000 } },
    serviceWorkers: "block",
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
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
  await rm(recorded.rawVideoDir, { force: true, recursive: true });
}

describeControlUiE2e("Control UI Workboard routing", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not installed at ${chromiumExecutablePath}.`);
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("routes, pins, persists, and normalizes Workboard boards", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    const recorded = await newRecordedPage("routing");
    const { page } = recorded;
    try {
      await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(true),
          "sessions.list": sessionsListResponse(),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.boards.list": { boards },
          "workboard.cards.list": { boards, cards: [], statuses: ["todo", "done"] },
        },
      });

      const response = await page.goto(`${server.baseUrl}workboard/ops?agent=main`);
      expect(response?.status()).toBe(200);
      await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
      const headerGlyph = page.locator(".workboard-board-glyph--header");
      await expect.poll(() => headerGlyph.textContent()).toContain("⚙");
      await expect.poll(() => headerGlyph.getAttribute("style")).toContain("#22c55e");
      await page.locator(".workboard-select--toolbar-board").waitFor();
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "01-board-route.png"),
      });

      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-nav__head-action").click();
      await sidebar
        .locator("wa-dropdown.sidebar-more-menu")
        .getByRole("menuitem", { name: "Edit pinned items" })
        .click();
      const customize = sidebar.locator(
        "wa-dropdown.sidebar-customize-menu:not(.sidebar-more-menu)",
      );
      await customize.getByText("WorkBoard", { exact: true }).waitFor();
      await customize.getByRole("menuitemcheckbox", { name: /Operations/u }).click();
      const pinnedBoard = sidebar.locator('[data-sidebar-entry="workboard:ops"] a');
      await pinnedBoard.waitFor();
      expect(await pinnedBoard.getAttribute("href")).toBe("/workboard/ops");
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "02-pinned-board.png"),
      });

      await page.goto(`${server.baseUrl}workboard?board=ops&agent=main`);
      await expect.poll(() => new URL(page.url()).pathname).toBe("/workboard/ops");
      expect(new URL(page.url()).searchParams.get("board")).toBeNull();
      expect(new URL(page.url()).searchParams.get("agent")).toBe("main");

      await page.reload();
      await sidebar.locator('[data-sidebar-entry="workboard:ops"] a').waitFor();
      await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "03-legacy-normalized-and-persisted.png"),
      });

      await page.goto(`${server.baseUrl}workboard/deleted?agent=main`);
      await expect.poll(() => new URL(page.url()).pathname).toBe("/workboard");
      expect(new URL(page.url()).searchParams.get("agent")).toBe("main");
      await page.locator(".workboard-page-title", { hasText: "Workboard" }).waitFor();
    } finally {
      await closeRecordedPage(recorded, "routing");
    }
  });

  it("hides Workboard navigation while the plugin is inactive", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    try {
      await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(false),
          "sessions.list": sessionsListResponse(),
          "workboard.boards.list": { boards },
        },
      });
      await page.goto(`${server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-nav__head-action").click();
      const moreMenu = sidebar.locator("wa-dropdown.sidebar-more-menu");
      await moreMenu.waitFor();
      expect(await moreMenu.getByText("Workboard", { exact: true }).count()).toBe(0);
      await moreMenu.getByRole("menuitem", { name: "Edit pinned items" }).click();
      const customize = sidebar.locator(
        "wa-dropdown.sidebar-customize-menu:not(.sidebar-more-menu)",
      );
      expect(await customize.getByText("WorkBoard", { exact: true }).count()).toBe(0);
      expect(await customize.locator('[value^="workboard:"]').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
