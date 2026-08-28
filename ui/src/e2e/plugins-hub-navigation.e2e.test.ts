import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Plugins hub navigation",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "plugins-hub-shell");

const methodResponses = {
  "agents.list": {
    agents: [
      { id: "main", identity: { name: "Main" }, name: "Main" },
      { id: "reviewer", identity: { name: "Reviewer" }, name: "Reviewer" },
    ],
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  },
  "config.get": {
    config: {},
    sourceConfig: {},
    hash: "plugins-hub-config",
    issues: [],
    raw: "{}",
    valid: true,
  },
  "plugins.list": {
    plugins: [
      {
        id: "workboard",
        name: "Workboard",
        description: "Dashboard workboard for agent-owned issues and sessions.",
        kind: ["productivity"],
        origin: "bundled",
        installed: true,
        enabled: true,
        state: "enabled",
        category: "tool",
        removable: false,
      },
    ],
    diagnostics: [],
    mutationAllowed: true,
  },
  "skills.proposals.historyStatus": {
    hasScanned: false,
    hasMore: false,
    ideasFound: 0,
    reviewedSessions: 0,
    lastScanReviewed: 0,
  },
  "skills.proposals.list": {
    proposals: [],
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: "2026-08-17T12:00:00.000Z",
  },
  "skills.status": {
    workspaceDir: "/tmp/openclaw-e2e/workspace",
    managedSkillsDir: "/tmp/openclaw-e2e/skills",
    skills: [],
  },
};

type HubGeometry = {
  height: number;
  left: number;
  title: string;
  titleVisible: boolean;
  top: number;
  width: number;
};

type ControlGeometry = {
  bottom: number;
  height: number;
  top: number;
};

async function createContext(viewport: { height: number; width: number }): Promise<BrowserContext> {
  if (captureUiProof) {
    await mkdir(proofDir, { recursive: true });
  }
  return suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(captureUiProof ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
  });
}

async function hubGeometry(page: Page): Promise<HubGeometry> {
  const tabs = page.locator(".plugins-hub-tabs");
  await tabs.waitFor({ state: "visible" });
  return tabs.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const title = document.querySelector<HTMLElement>(".content-header .page-title");
    return {
      height: rect.height,
      left: rect.left,
      title: title?.textContent?.trim() ?? "",
      titleVisible: (title?.getClientRects().length ?? 0) > 0,
      top: rect.top,
      width: rect.width,
    };
  });
}

function expectStableGeometry(actual: HubGeometry, expected: HubGeometry) {
  expect(actual.title).toBe("Plugins");
  expect(actual.titleVisible).toBe(true);
  expect(Math.abs(actual.left - expected.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.top - expected.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(1);
}

async function skillsToolbarGeometry(page: Page): Promise<ControlGeometry[]> {
  const selectors = [
    ".plugins-toolbar--fields > .settings-segmented",
    ".skills-toolbar__agent .agent-select__trigger",
    ".skills-toolbar__search .settings-input",
    ".plugins-toolbar--fields > .plugins-toolbar__hint",
    ".plugins-toolbar--fields > .btn",
  ];
  return page.locator(selectors.join(", ")).evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, height: rect.height, top: rect.top };
    }),
  );
}

function expectAlignedControlRow(controls: ControlGeometry[]) {
  expect(controls).toHaveLength(5);
  for (const metric of ["top", "bottom", "height"] as const) {
    const values = controls.map((control) => control[metric]);
    expect(
      Math.max(...values) - Math.min(...values),
      `${metric}: ${values.join(", ")}`,
    ).toBeLessThanOrEqual(1);
  }
}

async function expectStatusFilterContained(page: Page) {
  const geometry = await page
    .locator(".plugins-toolbar--fields > .settings-segmented")
    .evaluate((element) => ({
      containerTop: element.getBoundingClientRect().top,
      containerBottom: element.getBoundingClientRect().bottom,
      optionTop: Math.min(
        ...Array.from(element.children, (child) => child.getBoundingClientRect().top),
      ),
      optionBottom: Math.max(
        ...Array.from(element.children, (child) => child.getBoundingClientRect().bottom),
      ),
    }));
  expect(geometry.optionTop).toBeGreaterThanOrEqual(geometry.containerTop - 1);
  expect(geometry.optionBottom).toBeLessThanOrEqual(geometry.containerBottom + 1);
}

async function captureScreenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

async function selectHubTab(
  page: Page,
  name: "Installed" | "Discover" | "Skills" | "Workshop",
  target: { pathname: string; routeId: string },
) {
  await page.getByRole("tab", { name: new RegExp(`^${name}`, "u") }).click();
  await waitForControlUiRoute(page, target);
  await expect
    .poll(() => page.getByRole("tab", { name: new RegExp(`^${name}`, "u") }).getAttribute("active"))
    .not.toBeNull();
}

suite.define(() => {
  it.each([
    { label: "desktop", viewport: { height: 960, width: 1440 } },
    { label: "narrow", viewport: { height: 852, width: 393 } },
  ])(
    "keeps the hub shell fixed through every $label tab transition",
    async ({ label, viewport }) => {
      const context = await createContext(viewport);
      const page = await context.newPage();
      await installMockGateway(page, {
        featureMethods: [
          "agents.list",
          "config.get",
          "plugins.list",
          "skills.proposals.historyStatus",
          "skills.proposals.list",
          "skills.status",
        ],
        methodResponses,
      });

      try {
        await page.goto(`${suite.server.baseUrl}settings/plugins`);
        await page.addStyleTag({
          content:
            "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
        });
        await waitForControlUiRoute(page, { pathname: "/settings/plugins", routeId: "plugins" });
        const installed = await hubGeometry(page);
        expect(installed.title).toBe("Plugins");
        expect(installed.titleVisible).toBe(true);
        const layout = await page.evaluate(() => {
          const title = document.querySelector<HTMLElement>(".hub-page-header__title");
          const tabs = document.querySelector<HTMLElement>(".plugins-hub-tabs");
          const content = document.querySelector<HTMLElement>("#plugins-global-search");
          if (!title || !tabs || !content) {
            throw new Error("Plugins hub layout did not render");
          }
          return {
            aboveTabs: tabs.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
            belowTabs: content.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom,
            contentLeft: content.getBoundingClientRect().left,
            tabsLeft: tabs.getBoundingClientRect().left,
            titleLeft: title.getBoundingClientRect().left,
          };
        });
        expect(Math.abs(layout.tabsLeft - layout.titleLeft)).toBeLessThanOrEqual(1);
        expect(layout.aboveTabs).toBeGreaterThan(0);
        expect(Math.abs(layout.belowTabs - layout.aboveTabs)).toBeLessThanOrEqual(1);
        if (label === "desktop") {
          expect(Math.abs(layout.tabsLeft - layout.contentLeft)).toBeLessThanOrEqual(1);
        }
        await captureScreenshot(page, `${label}-01-installed.png`);

        await selectHubTab(page, "Discover", {
          pathname: "/settings/plugins/discover",
          routeId: "plugins",
        });
        expectStableGeometry(await hubGeometry(page), installed);
        await captureScreenshot(page, `${label}-02-discover.png`);

        await selectHubTab(page, "Skills", { pathname: "/skills", routeId: "skills" });
        expectStableGeometry(await hubGeometry(page), installed);
        const needsSetupFilter = page.locator(
          'wa-radio.settings-segmented__btn[value="needs-setup"]',
        );
        await needsSetupFilter.click();
        await expect
          .poll(() =>
            needsSetupFilter.evaluate((element) =>
              element.classList.contains("settings-segmented__btn--active"),
            ),
          )
          .toBe(true);
        if (label === "desktop") {
          expectAlignedControlRow(await skillsToolbarGeometry(page));
        }
        await expectStatusFilterContained(page);
        await captureScreenshot(page, `${label}-03-skills.png`);

        await selectHubTab(page, "Workshop", {
          pathname: "/skills/workshop",
          routeId: "skill-workshop",
        });
        expectStableGeometry(await hubGeometry(page), installed);
        const workshopShellBottom = await page
          .locator(".plugins-hub-header")
          .evaluate((element) => element.getBoundingClientRect().bottom);
        const workshopControlsTop = await page
          .locator(".sw-header-controls")
          .evaluate((element) => element.getBoundingClientRect().top);
        expect(workshopControlsTop).toBeGreaterThanOrEqual(workshopShellBottom);
        await captureScreenshot(page, `${label}-04-workshop-today.png`);

        await page.locator("#skill-workshop-mode-tab-board").click();
        await expect
          .poll(() => page.locator("#skill-workshop-mode-tab-board").getAttribute("active"))
          .not.toBeNull();
        expectStableGeometry(await hubGeometry(page), installed);
        const boardLayout = await page.locator(".content--skill-workshop").evaluate((element) => {
          const style = getComputedStyle(element);
          return { display: style.display, overflow: style.overflow };
        });
        expect(boardLayout).toEqual({ display: "flex", overflow: "hidden" });
        await captureScreenshot(page, `${label}-05-workshop-board.png`);

        await page.locator("#skill-workshop-mode-tab-today").click();
        await expect
          .poll(() => page.locator("#skill-workshop-mode-tab-today").getAttribute("active"))
          .not.toBeNull();
        expectStableGeometry(await hubGeometry(page), installed);
        const todayLayout = await page
          .locator(".content--skill-workshop-today")
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return { display: style.display, overflowY: style.overflowY };
          });
        expect(todayLayout).toEqual({ display: "block", overflowY: "auto" });

        await selectHubTab(page, "Skills", { pathname: "/skills", routeId: "skills" });
        expectStableGeometry(await hubGeometry(page), installed);
        await selectHubTab(page, "Discover", {
          pathname: "/settings/plugins/discover",
          routeId: "plugins",
        });
        expectStableGeometry(await hubGeometry(page), installed);
        await selectHubTab(page, "Installed", {
          pathname: "/settings/plugins",
          routeId: "plugins",
        });
        expectStableGeometry(await hubGeometry(page), installed);
      } finally {
        await context.close();
      }
    },
  );
});
