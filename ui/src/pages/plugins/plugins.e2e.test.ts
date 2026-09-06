// Control UI tests cover plugin catalog browsing and lifecycle mutations.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import type { PluginCatalogItem, PluginListResult } from "../../lib/plugins/index.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";
import {
  calendarInspection,
  calendarPlugin,
  calendarSearchResponse,
  configSnapshot,
  discoveryCategories,
  discoveryResult,
  enableWorkboardResult,
  finalDiscoveryPageItems,
  featuredResult,
  initialInventory,
  installResult,
  installedPluginsInventory,
  localOnlyDetail,
  localOnlyDiscoveryPlugin,
  lobsterInspection,
  lobsterPlugin,
  matrixDetail,
  matrixDiscoveryPlugin,
  remoteIconPlugin,
  secondDiscoveryPageItems,
  telegramPlugin,
  uninstallResult,
  workboardDisabled,
  workboardEnabled,
  workboardInspection,
} from "../../test-helpers/plugins-e2e-fixtures.test-support.ts";
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const updateScreenshots = process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1";
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/plugins");
const desktopViewport = { height: 1000, width: 1440 };
const pluginMethods = [
  "plugins.list",
  "plugins.inspect",
  "plugins.search",
  "plugins.catalog.browse",
  "plugins.catalog.categories",
  "plugins.catalog.get",
  "plugins.install",
  "plugins.setEnabled",
  "plugins.uninstall",
];
let browser: Browser;
let server: ControlUiE2eServer;

function inventory(plugins: PluginCatalogItem[]): PluginListResult {
  return { plugins, diagnostics: [], mutationAllowed: true };
}

function readOnlyConnectResponse() {
  return {
    auth: {
      deviceToken: "plugins-read-only-device-token",
      role: "operator",
      scopes: ["operator.read"],
    },
    features: { events: [], methods: pluginMethods },
    controlUiTabs: [],
    protocol: PROTOCOL_VERSION,
    server: { connId: "plugins-read-only", version: "e2e" },
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "main",
        scope: "agent",
      },
    },
    type: "hello-ok",
  };
}

async function captureScreenshot(page: Page, name: string): Promise<void> {
  if (!updateScreenshots) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  await page.locator(".content").screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(artifactDir, name),
  });
}

async function newContext(viewport = desktopViewport): Promise<BrowserContext> {
  return browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
  });
}

function pluginMethodResponses() {
  return {
    "config.get": configSnapshot(false),
    "plugins.list": initialInventory,
    "plugins.inspect": {
      cases: [
        { match: { pluginId: "workboard" }, response: workboardInspection },
        { match: { pluginId: "lobster" }, response: lobsterInspection },
        { match: { pluginId: "calendar-plus" }, response: calendarInspection },
      ],
    },
    "plugins.search": {
      cases: [
        {
          match: { query: "calendar", limit: 20 },
          response: calendarSearchResponse,
        },
      ],
    },
    "plugins.catalog.browse": {
      cases: [
        { match: { intent: "featured", pageSize: 9 }, response: featuredResult },
        {
          match: { intent: "all", cursor: "catalog-page-2", pageSize: 25 },
          response: {
            items: secondDiscoveryPageItems,
            nextCursor: "catalog-page-3",
          },
        },
        {
          match: { intent: "all", cursor: "catalog-page-3", pageSize: 25 },
          response: { items: finalDiscoveryPageItems },
        },
        {
          match: { intent: "official", pageSize: 25 },
          response: { items: [matrixDiscoveryPlugin] },
        },
        {
          match: { intent: "all", category: "channels", pageSize: 25 },
          response: { items: [matrixDiscoveryPlugin] },
        },
        {
          match: { intent: "all", query: "matrix", pageSize: 25 },
          response: { items: [matrixDiscoveryPlugin] },
        },
        { match: { intent: "all", pageSize: 25 }, response: discoveryResult },
      ],
    },
    "plugins.catalog.categories": discoveryCategories,
    "plugins.catalog.get": {
      cases: [
        { match: { id: matrixDiscoveryPlugin.id }, response: matrixDetail },
        { match: { id: localOnlyDiscoveryPlugin.id }, response: localOnlyDetail },
      ],
    },
    "plugins.install": {
      cases: [
        {
          match: {
            source: "clawhub",
            packageName: "calendar-plus",
            acknowledgeCapabilities: { reviewToken: calendarInspection.reviewToken },
          },
          response: installResult,
        },
      ],
    },
    "plugins.setEnabled": {
      cases: [
        {
          match: { pluginId: "workboard", enabled: true },
          response: enableWorkboardResult,
        },
      ],
    },
    "plugins.uninstall": {
      cases: [
        {
          match: { pluginId: "calendar-plus" },
          response: uninstallResult,
        },
      ],
    },
  };
}

describeControlUiE2e("Control UI Plugins mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    if (updateScreenshots) {
      await rm(artifactDir, { force: true, recursive: true });
      await mkdir(artifactDir, { recursive: true });
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows a prioritized installed plugins inventory with inline search and settings navigation", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": installedPluginsInventory,
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      await page.getByRole("heading", { name: "Installed plugins", exact: true }).waitFor();
      await page.getByRole("heading", { name: "Explore plugins", exact: true }).waitFor();
      const marketplaceRow = page.locator(".plugin-catalog-result", { hasText: "Matrix" });
      await marketplaceRow.waitFor();
      expect(await marketplaceRow.textContent()).toContain("@openclaw");
      expect(await marketplaceRow.textContent()).toContain("52.2k");
      expect(await marketplaceRow.textContent()).not.toContain("downloads");
      const cards = page.locator(".installed-plugins-card");
      expect(await cards.count()).toBe(9);
      expect(
        await cards.evaluateAll((elements) =>
          elements.slice(0, 5).map((card) => card.dataset.pluginId),
        ),
      ).toEqual(["enabled-a", "enabled-b", "attention-a", "attention-b", "disabled-01"]);
      expect(await page.getByRole("searchbox", { name: "Search plugins" }).count()).toBe(0);
      const firstCard = page.locator('[data-plugin-id="attention-a"]');
      expect(
        await firstCard
          .getByText("Operator-visible capability for attention-a.", { exact: true })
          .count(),
      ).toBe(1);
      expect(await firstCard.textContent()).not.toContain("internal-category");
      const geometry = await firstCard.evaluate((card) => {
        const cardRect = card.getBoundingClientRect();
        return {
          aspectRatio: cardRect.width / cardRect.height,
          cursor: getComputedStyle(card).cursor,
        };
      });
      expect(geometry.aspectRatio).toBeGreaterThan(1.5);
      expect(geometry.cursor).toBe("pointer");
      const titleColor = await firstCard
        .locator(".installed-plugins-card__identity h3")
        .evaluate((element) => getComputedStyle(element).color);
      await firstCard.hover();
      expect(
        await firstCard
          .locator(".installed-plugins-card__identity h3")
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe(titleColor);
      expect(await firstCard.locator("wa-switch").count()).toBe(0);
      const grid = page.locator(".installed-plugins__grid");
      const columnCount = () =>
        grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
      await expect.poll(columnCount).toBe(3);
      await page.setViewportSize({ height: 900, width: 768 });
      await expect.poll(columnCount).toBe(2);
      await page.setViewportSize({ height: 852, width: 393 });
      await expect.poll(columnCount).toBe(1);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
              window.innerWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      await page.setViewportSize(desktopViewport);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await captureScreenshot(page, "9-installed-plugins-desktop.png");

      const settingsButton = page.getByRole("button", { name: "Plugin settings", exact: true });
      const searchButton = page.getByRole("button", { name: "Search plugins", exact: true });
      for (const iconButton of [searchButton, settingsButton]) {
        const appearance = await iconButton.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            width: rect.width,
            height: rect.height,
            borderWidth: style.borderWidth,
            borderColor: style.borderColor,
            backgroundColor: style.backgroundColor,
          };
        });
        expect(appearance).toMatchObject({
          width: 24,
          height: 24,
          borderColor: "rgba(0, 0, 0, 0)",
          backgroundColor: "rgba(0, 0, 0, 0)",
        });
      }
      const settingsBeforeSearch = await settingsButton.boundingBox();
      await searchButton.click();
      const search = page.getByRole("searchbox", { name: "Search plugins" });
      await expect
        .poll(() => search.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(
        await search
          .locator("xpath=ancestor::*[contains(@class, 'installed-plugins__actions')]")
          .count(),
      ).toBe(1);
      const settingsDuringSearch = await settingsButton.boundingBox();
      expect(
        Math.abs((settingsDuringSearch?.x ?? 0) - (settingsBeforeSearch?.x ?? 0)),
      ).toBeLessThan(1);
      await search.fill("Disabled 10");
      expect(await cards.count()).toBe(1);
      expect(await cards.first().getAttribute("data-plugin-id")).toBe("disabled-10");
      const closeSearch = page.getByRole("button", { name: "Close", exact: true });
      const closeAppearance = await closeSearch.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          width: rect.width,
          height: rect.height,
          borderColor: style.borderColor,
          backgroundColor: style.backgroundColor,
        };
      });
      expect(closeAppearance).toMatchObject({
        width: 24,
        height: 24,
        borderColor: "rgba(0, 0, 0, 0)",
        backgroundColor: "rgba(0, 0, 0, 0)",
      });
      await closeSearch.hover();
      expect(await closeSearch.evaluate((element) => getComputedStyle(element).borderColor)).toBe(
        "rgba(0, 0, 0, 0)",
      );
      await closeSearch.click();
      expect(await search.count()).toBe(0);
      expect(await cards.count()).toBe(9);
      await expect
        .poll(() =>
          page
            .getByRole("button", { name: "Search plugins", exact: true })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      const settingsAfterSearch = await settingsButton.boundingBox();
      expect(Math.abs((settingsAfterSearch?.x ?? 0) - (settingsBeforeSearch?.x ?? 0))).toBeLessThan(
        1,
      );

      const showAll = page.getByRole("button", { name: "Show all 16", exact: true });
      const restingMoreAppearance = await showAll.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
        };
      });
      expect(restingMoreAppearance).toMatchObject({
        backgroundColor: "rgba(0, 0, 0, 0)",
        borderColor: "rgba(0, 0, 0, 0)",
      });
      await showAll.hover();
      const hoverMoreAppearance = await showAll.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          filter: style.filter,
        };
      });
      expect(hoverMoreAppearance).toMatchObject({
        backgroundColor: "rgba(0, 0, 0, 0)",
        borderColor: "rgba(0, 0, 0, 0)",
      });
      expect(hoverMoreAppearance.filter).toBe("brightness(1.35)");
      await showAll.click();
      expect(await cards.count()).toBe(16);
      expect(await page.locator('[data-plugin-id="needs-setup"]').textContent()).toContain(
        "Setup required",
      );
      await page.getByRole("button", { name: "Hide", exact: true }).click();
      expect(await cards.count()).toBe(9);

      expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
      expect(await gateway.getRequests("plugins.search")).toEqual([]);
      expect(await gateway.getRequests("plugins.install")).toEqual([]);

      await page.getByRole("button", { name: "Plugin settings", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins");
      await page.goto(`${server.baseUrl}plugins`);
      await page.getByRole("button", { name: "Show all 16", exact: true }).click();
      await page.locator('[data-plugin-id="workboard"]').click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins/workboard");
      expect(new URL(page.url()).search).toBe("?from=plugins");
      const pluginsBreadcrumb = page
        .getByRole("navigation", { name: "Breadcrumb", exact: true })
        .getByRole("link", { name: "Plugins", exact: true });
      await pluginsBreadcrumb.waitFor();
      expect(await pluginsBreadcrumb.getAttribute("href")).toBe("/plugins");
      await page.reload();
      await page.getByRole("heading", { level: 1, name: "Workboard", exact: true }).waitFor();
      await page
        .getByRole("navigation", { name: "Breadcrumb", exact: true })
        .getByRole("link", { name: "Plugins", exact: true })
        .click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/plugins");
      expect(new URL(page.url()).search).toBe("");
      const openAttentionSettings = page.locator('[data-plugin-id="attention-a"]');
      await openAttentionSettings.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins/attention-a");
    } finally {
      await context.close();
    }
  });

  it("opens a routed ClawHub-style plugin detail page with normalized metadata", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      await page.getByRole("heading", { level: 1, name: "Matrix", exact: true }).waitFor();
      expect(
        (await gateway.getRequests("plugins.catalog.get")).map((request) => request.params),
      ).toContainEqual({ id: matrixDiscoveryPlugin.id });
      expect(
        await page.getByText("Connect OpenClaw to Matrix rooms and direct messages.").count(),
      ).toBe(1);
      const detailTabs = page.getByRole("tablist", { name: "Plugin details" });
      expect(await detailTabs.getByRole("tab", { name: "README" }).count()).toBe(1);
      expect(await detailTabs.getByRole("tab", { name: "Skills" }).count()).toBe(1);
      expect(await detailTabs.getByRole("tab", { name: "Configuration" }).count()).toBe(1);
      expect(await detailTabs.getByRole("tab", { name: "Compatibility" }).count()).toBe(1);
      expect(await detailTabs.getByRole("tab", { name: "Versions" }).count()).toBe(1);
      expect(await detailTabs.getByRole("tab", { name: "Advanced" }).count()).toBe(1);
      expect(await page.getByText("52.2k", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Capabilities match the stated purpose.").count()).toBe(1);
      expect(
        await page
          .getByRole("link", { name: "openclaw/openclaw", exact: true })
          .getAttribute("href"),
      ).toBe("https://github.com/openclaw/openclaw");
      expect(
        await page.getByRole("link", { name: "@openclaw", exact: true }).getAttribute("href"),
      ).toBe("https://clawhub.ai/user/openclaw");

      await detailTabs.getByRole("tab", { name: "Versions" }).click();
      expect(await page.getByText("2.1.0", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Current release", { exact: true }).count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("renders local-only discovery without inventing ClawHub popularity or provenance", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });
    try {
      await page.goto(`${server.baseUrl}plugins`);
      const row = page.locator(`[data-plugin-id="${localOnlyDiscoveryPlugin.id}"]`);
      await row.waitFor();
      expect(await row.getByText("Local Calendar", { exact: true }).count()).toBe(1);
      expect(await row.getByText(/downloads/u).count()).toBe(0);
      expect(await row.getByText(/not been published to ClawHub/u).count()).toBe(1);
      await row.getByRole("link", { name: "Local Calendar", exact: true }).click();
      await page.getByRole("heading", { level: 1, name: "Local Calendar", exact: true }).waitFor();
      expect(
        (await gateway.getRequests("plugins.catalog.get")).map((request) => request.params),
      ).toContainEqual({ id: localOnlyDiscoveryPlugin.id });
      expect(await page.getByText("@openclaw", { exact: true }).count()).toBe(0);
      expect(await page.getByText("Security", { exact: true }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("keeps local-only rows visible beside an isolated ClawHub outage", async () => {
    const context = await newContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.browse": {
          items: [localOnlyDiscoveryPlugin],
          remoteError: "ClawHub is unavailable. Local plugins remain available.",
        },
      },
    });
    try {
      await page.goto(`${server.baseUrl}plugins`);
      await page.getByText("Local Calendar", { exact: true }).waitFor();
      expect(await page.getByText(/ClawHub is unavailable/u).count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("renders the full ClawHub catalog with stable featured cards and discovery controls", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      await page.getByRole("heading", { name: "Featured", exact: true }).waitFor();
      const featured = page.getByRole("region", { name: "Featured", exact: true });
      const featuredCards = featured.locator(".plugin-featured-card");
      await expect.poll(() => featuredCards.count()).toBe(9);
      expect((await featuredCards.allTextContents()).join(" ")).not.toContain("Already Enabled");
      const matrixFeatured = featured.locator('[data-plugin-id="ch_bWF0cml4"]');
      expect(
        await matrixFeatured.locator(".plugin-featured-card__primary-link").getAttribute("href"),
      ).toBe("/plugins/ch_bWF0cml4");
      expect(await matrixFeatured.getByText("@openclaw", { exact: true }).count()).toBe(1);
      expect(
        await matrixFeatured
          .getByRole("link", { name: "@openclaw", exact: true })
          .getAttribute("href"),
      ).toBe("https://clawhub.ai/user/openclaw");
      expect(await matrixFeatured.getByLabel("Official", { exact: true }).count()).toBe(1);
      expect(await matrixFeatured.getByText("52.2k downloads", { exact: true }).count()).toBe(1);
      expect(await matrixFeatured.locator(".plugin-download-count svg").count()).toBe(1);
      expect(await matrixFeatured.textContent()).not.toContain("Available");
      expect(
        await matrixFeatured.evaluate((card) =>
          Number.parseFloat(getComputedStyle(card).paddingTop),
        ),
      ).toBeGreaterThanOrEqual(12);
      expect(
        await matrixFeatured
          .locator(".plugin-featured-card__footer")
          .evaluate((footer) => getComputedStyle(footer).borderTopWidth),
      ).toBe("0px");
      const featuredIdentityGap = await matrixFeatured.evaluate((card) => {
        const title = card.querySelector(".plugin-card-title-row");
        const author = card.querySelector(".plugin-card-author");
        if (!(title instanceof HTMLElement) || !(author instanceof HTMLElement)) {
          return null;
        }
        return Math.round(
          author.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
        );
      });
      expect(featuredIdentityGap).toBeLessThanOrEqual(2);

      const categories = page.getByRole("complementary", { name: "Plugin categories" });
      const categoryLabels = (await categories.getByRole("button").allTextContents()).map((label) =>
        label.trim(),
      );
      expect(categoryLabels.join(" | ")).toBe(
        "All categories | Channels | Models | Memory | Context | Voice | Media | Web | Tools | Runtime | Gateway | Security | Other",
      );
      expect(await categories.getByRole("link").count()).toBe(0);
      expect(
        await categories.getByRole("button", { name: "Memory", exact: true }).getAttribute("title"),
      ).toBeNull();
      const telegramInstalled = page.locator('[data-plugin-id="telegram"]');
      expect(await telegramInstalled.getByText("@openclaw", { exact: true }).count()).toBe(0);
      expect(await telegramInstalled.getByLabel("Official", { exact: true }).count()).toBe(1);
      expect(
        await telegramInstalled
          .locator(".installed-plugins-card__identity .installed-plugins-card__summary")
          .count(),
      ).toBe(1);
      const telegramCatalog = page.locator('[data-plugin-id="ch_QG9wZW5jbGF3L3RlbGVncmFt"]');
      expect(await telegramCatalog.count()).toBe(0);
      expect(await page.locator('[data-plugin-id="ch_bWVtb3J5LXBsdXM"]').count()).toBe(1);

      const matrixCatalog = page.locator('.plugin-catalog-result[data-plugin-id="ch_bWF0cml4"]');
      await matrixCatalog.waitFor();
      expect(await matrixCatalog.textContent()).not.toContain("Available");
      expect(await matrixCatalog.textContent()).not.toContain("channels");
      expect(await matrixCatalog.getByText("52.2k", { exact: true }).count()).toBe(1);
      expect(await matrixCatalog.textContent()).not.toContain("downloads");
      expect(await matrixCatalog.locator(".plugin-download-count svg").count()).toBe(1);
      expect(
        await matrixCatalog
          .getByRole("link", { name: "@openclaw", exact: true })
          .getAttribute("href"),
      ).toBe("https://clawhub.ai/user/openclaw");
      expect(await page.getByText("Plugin", { exact: true }).count()).toBeGreaterThan(0);
      expect(await page.getByText("Downloads", { exact: true }).count()).toBeGreaterThan(0);
      expect(
        await page
          .locator(".plugin-catalog-layout__results")
          .evaluate((results) => getComputedStyle(results).borderLeftStyle),
      ).toBe("solid");
      const controlsToResultsGap = await page.evaluate(() => {
        const controls = document.querySelector(".plugin-catalog-controls");
        const layout = document.querySelector(".plugin-catalog-layout");
        if (!(controls instanceof HTMLElement) || !(layout instanceof HTMLElement)) {
          return null;
        }
        return Math.round(
          layout.getBoundingClientRect().top - controls.getBoundingClientRect().bottom,
        );
      });
      expect(controlsToResultsGap).toBeGreaterThanOrEqual(20);
      expect(
        await page
          .locator(".plugin-catalog-results__list")
          .evaluate((list) => getComputedStyle(list).backgroundColor),
      ).toBe("rgba(0, 0, 0, 0)");

      let requestCount = (await gateway.getRequests("plugins.catalog.browse")).length;
      await page.getByRole("tab", { name: "Official", exact: true }).click();
      const officialRequest = await gateway.waitForRequest("plugins.catalog.browse", {
        after: requestCount,
      });
      expect(officialRequest.params).toMatchObject({ intent: "official", pageSize: 25 });
      expect(await telegramInstalled.getByLabel("Official", { exact: true }).count()).toBe(1);
      const explore = page.getByRole("region", { name: "Explore plugins", exact: true });
      await explore.getByRole("link", { name: /Matrix/u }).waitFor();
      expect(await featuredCards.count()).toBe(9);

      await page.getByRole("tab", { name: "All", exact: true }).click();
      const search = page.getByRole("searchbox", { name: "Search ClawHub plugins" });
      requestCount = (await gateway.getRequests("plugins.catalog.browse")).length;
      await search.fill("matrix");
      await expect
        .poll(async () =>
          (await gateway.getRequests("plugins.catalog.browse"))
            .slice(requestCount)
            .some(
              (request) =>
                JSON.stringify(request.params) ===
                JSON.stringify({ intent: "all", query: "matrix", pageSize: 25 }),
            ),
        )
        .toBe(true);
      await explore.getByRole("link", { name: /Matrix/u }).waitFor();
      expect(await featuredCards.count()).toBe(9);

      requestCount = (await gateway.getRequests("plugins.catalog.browse")).length;
      await search.fill("");
      await expect
        .poll(async () =>
          (await gateway.getRequests("plugins.catalog.browse"))
            .slice(requestCount)
            .some(
              (request) =>
                JSON.stringify(request.params) === JSON.stringify({ intent: "all", pageSize: 25 }),
            ),
        )
        .toBe(true);
      await expect.poll(() => explore.locator(".plugin-catalog-result").count()).toBe(25);
      expect(await page.getByRole("button", { name: "Back", exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.locator(".plugin-catalog-result", { hasText: "Slack" }).waitFor();
      expect(await explore.locator(".plugin-catalog-result").count()).toBe(25);
      expect(await page.getByText("Page 2", { exact: true }).count()).toBe(1);
      expect(await explore.getByRole("link", { name: /Matrix/u }).count()).toBe(0);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await explore.getByRole("link", { name: /Matrix/u }).waitFor();
      expect(await explore.locator(".plugin-catalog-result").count()).toBe(25);
      expect(await page.getByText("Page 1", { exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Back", exact: true }).count()).toBe(0);
      expect(await page.locator(".plugin-catalog-result", { hasText: "Slack" }).count()).toBe(0);
      expect(
        await page.getByText("You’ve reached the end of the catalog.", { exact: true }).count(),
      ).toBe(0);

      await matrixFeatured
        .locator(".plugin-featured-card__primary-link")
        .click({ position: { x: 10, y: 10 } });
      await expect.poll(() => new URL(page.url()).pathname).toBe("/plugins/ch_bWF0cml4");
      await page.goto(`${server.baseUrl}plugins`);
      await page.getByRole("heading", { name: "Featured", exact: true }).waitFor();
      requestCount = (await gateway.getRequests("plugins.catalog.browse")).length;
      await categories.getByRole("button", { name: "Channels", exact: true }).click();
      const categoryRequest = await gateway.waitForRequest("plugins.catalog.browse", {
        after: requestCount,
      });
      expect(categoryRequest.params).toMatchObject({ category: "channels", pageSize: 25 });

      await page.setViewportSize({ height: 1024, width: 768 });
      const categorySelect = page.getByRole("combobox", { name: "Plugin categories" });
      await categorySelect.waitFor();
      expect(await categories.isVisible()).toBe(false);
      await categorySelect.selectOption("models");
      expect(await categorySelect.inputValue()).toBe("models");
    } finally {
      await context.close();
    }
  });

  it("keeps plugin mutations unavailable to read-only operators", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        connect: readOnlyConnectResponse(),
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const discoveryWorkboardCard = page.locator('[data-plugin-id="workboard"]');
      await discoveryWorkboardCard.waitFor({ state: "visible" });
      expect(await discoveryWorkboardCard.locator("wa-switch").count()).toBe(0);
      expect(new URL(page.url()).pathname).toBe("/plugins");
      expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
      await discoveryWorkboardCard.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins/workboard");
    } finally {
      await context.close();
    }
  });

  it("keeps installed inventory usable while ClawHub discovery retries", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.browse": {
          __mockError: {
            code: "UNAVAILABLE",
            message: "Plugin discovery is unavailable. Retry to reconnect to ClawHub.",
          },
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      await page.locator('[data-plugin-id="workboard"]').waitFor();
      const discoveryError = page.locator('.plugin-catalog-results [role="alert"]');
      await discoveryError.waitFor();
      expect(await discoveryError.textContent()).toContain("Plugin discovery is unavailable");
      await gateway.setMethodResponse("plugins.catalog.browse", { items: discoveryResult.items });
      await discoveryError.getByRole("button", { name: "Try again" }).click();
      await page.locator('.plugin-catalog-result[data-plugin-id="ch_bWF0cml4"]').waitFor();
      expect(await page.locator('[data-plugin-id="workboard"]').isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("explains a successful empty ClawHub response", async () => {
    const context = await newContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.browse": { items: [] },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      await page.getByText("No ClawHub plugins match this view.", { exact: true }).waitFor();
      expect(await page.locator(".plugin-catalog-result").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("reloads ClawHub discovery after the Gateway reconnects", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      await page.locator('.plugin-catalog-result[data-plugin-id="ch_bWF0cml4"]').waitFor();
      const requestsBeforeReconnect = (await gateway.getRequests("plugins.catalog.browse")).length;
      const discoveryPlugin = discoveryResult.items.find((plugin) => !plugin.local.installed);
      if (!discoveryPlugin) {
        throw new Error("Expected the discovery fixture to contain a plugin.");
      }
      await gateway.setMethodResponse("plugins.catalog.browse", {
        items: [
          {
            ...discoveryPlugin,
            catalog: { ...discoveryPlugin.catalog, name: "Memory Reconnected" },
          },
        ],
      });

      await gateway.setOnline(false);
      await gateway.setOnline(true);
      await gateway.waitForRequest("plugins.catalog.browse", { after: requestsBeforeReconnect });
      await page.locator(".plugin-catalog-result", { hasText: "Memory Reconnected" }).waitFor();
    } finally {
      await context.close();
    }
  });
});
