import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Plugins hub navigation",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("plugins-hub-shell");
  }
});

const workshopProposal = {
  id: "mobile-workshop-proof",
  kind: "create",
  status: "pending",
  title: "Mobile Workshop Proof",
  description: "Keep proposal details and actions reachable on narrow screens.",
  skillName: "Mobile Workshop Proof",
  skillKey: "mobile-workshop-proof",
  createdAt: "2026-08-17T12:00:00.000Z",
  updatedAt: "2026-08-17T12:00:00.000Z",
  scanState: "clean",
};

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
    proposals: [workshopProposal],
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: "2026-08-17T12:00:00.000Z",
  },
  "skills.proposals.inspect": {
    content:
      "# Mobile Workshop Proof\n\nKeep proposal details and actions reachable on narrow screens.",
    record: {
      ...workshopProposal,
      proposedVersion: "v1",
      target: {
        skillKey: workshopProposal.skillKey,
        skillName: workshopProposal.skillName,
      },
    },
    supportFiles: [],
  },
  "skills.status": {
    workspaceDir: "/tmp/openclaw-e2e/workspace",
    managedSkillsDir: "/tmp/openclaw-e2e/skills",
    skills: [],
  },
};

const emptyMethodResponses = {
  ...methodResponses,
  "skills.proposals.list": {
    ...methodResponses["skills.proposals.list"],
    proposals: [],
  },
};

const workshopFeatureMethods = [
  "agents.list",
  "config.get",
  "plugins.list",
  "skills.proposals.historyStatus",
  "skills.proposals.inspect",
  "skills.proposals.list",
  "skills.proposals.apply",
  "skills.proposals.evaluate",
  "skills.proposals.reject",
  "skills.proposals.requestRevision",
  "skills.status",
];

type HubGeometry = {
  contentLeft: number;
  contentWidth: number;
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
    const workshop = document.querySelector<HTMLElement>(".content--skill-workshop");
    const contentColumn =
      workshop && workshop.getClientRects().length > 0
        ? workshop
        : document.querySelector<HTMLElement>(".settings-page--wide");
    if (!contentColumn) {
      throw new Error("Plugins hub content column did not render");
    }
    const contentRect = contentColumn.getBoundingClientRect();
    return {
      contentLeft: contentRect.left,
      contentWidth: contentRect.width,
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
  expect(Math.abs(actual.contentLeft - expected.contentLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.contentWidth - expected.contentWidth)).toBeLessThanOrEqual(1);
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
    fullPage: false,
    path: path.join(proofDir, name),
  });
}

async function expectWorkshopActionsReachable(
  page: Page,
  label: string,
  viewport: { height: number; width: number },
) {
  const content = page.locator(".content--skill-workshop");
  const detail = page.locator(".sw-detail__body");
  const actions = page.locator(".sw-action-bar");
  await expect.poll(() => detail.textContent()).toContain("Keep proposal details and actions");
  await actions.waitFor({ state: "attached" });

  if (viewport.width <= 768) {
    await content.hover();
    await page.mouse.wheel(0, viewport.height * 2);
    await captureScreenshot(page, `${label}-06-workshop-board-after-scroll.png`);
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  }

  await expect
    .poll(() =>
      actions.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      }),
    )
    .toBe(true);
}

async function expectEmptyWorkshopDoesNotScroll(page: Page, emptySelector: string) {
  const content = page.locator(".content--skill-workshop");
  const emptyState = page.locator(emptySelector);
  await emptyState.waitFor({ state: "visible" });
  expect(await emptyState.evaluate((element) => getComputedStyle(element).minHeight)).toBe("0px");
  await content.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect
    .poll(() => content.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeLessThanOrEqual(1);
  await content.hover();
  await page.mouse.wheel(0, 844);
  expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
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
    { label: "desktop", viewport: { height: 1053, width: 2048 } },
    { label: "standard", viewport: { height: 960, width: 1440 } },
    { label: "laptop", viewport: { height: 768, width: 1366 } },
    { label: "tablet", viewport: { height: 1024, width: 768 } },
    { label: "narrow", viewport: { height: 844, width: 390 } },
  ])(
    "keeps the hub shell fixed through every $label tab transition",
    async ({ label, viewport }) => {
      const context = await createContext(viewport);
      const page = await context.newPage();
      await installMockGateway(page, {
        featureMethods: workshopFeatureMethods,
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
        await captureScreenshot(page, `${label}-04-workshop-today.png`);
        expectStableGeometry(await hubGeometry(page), installed);
        const workshopShellBottom = await page
          .locator(".plugins-hub-header")
          .evaluate((element) => element.getBoundingClientRect().bottom);
        const workshopControlsTop = await page
          .locator(".sw-header-controls")
          .evaluate((element) => element.getBoundingClientRect().top);
        expect(workshopControlsTop).toBeGreaterThanOrEqual(workshopShellBottom);

        await page.locator("#skill-workshop-mode-tab-board").click();
        await expect
          .poll(() => page.locator("#skill-workshop-mode-tab-board").getAttribute("active"))
          .not.toBeNull();
        expectStableGeometry(await hubGeometry(page), installed);
        const boardLayout = await page.locator(".content--skill-workshop").evaluate((element) => {
          const style = getComputedStyle(element);
          return { display: style.display, overflow: style.overflow };
        });
        if (viewport.width > 768) {
          expect(boardLayout).toEqual({ display: "flex", overflow: "hidden" });
        }
        if (viewport.width <= 768) {
          const workshopMinHeight = await page
            .locator(".sw-hub-panel .skill-workshop")
            .evaluate((element) => getComputedStyle(element).minHeight);
          expect(workshopMinHeight).toBe("0px");
        }
        await captureScreenshot(page, `${label}-05-workshop-board-top.png`);
        await expectWorkshopActionsReachable(page, label, viewport);

        if (label === "narrow") {
          await page.getByRole("button", { name: /^Applied/u }).click();
          await captureScreenshot(page, "narrow-07-workshop-board-filter-empty.png");
          expect(
            await page
              .locator(".sw-detail--empty")
              .evaluate((element) => getComputedStyle(element).minHeight),
          ).toBe("0px");
          await page
            .locator(".content--skill-workshop")
            .evaluate((element) => element.scrollTo({ top: 0 }));
        }

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

  it("keeps an empty mobile Workshop board from scrolling into blank space", async () => {
    const context = await createContext({ height: 844, width: 390 });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: workshopFeatureMethods,
      methodResponses: emptyMethodResponses,
    });

    try {
      await page.goto(`${suite.server.baseUrl}skills/workshop`);
      await waitForControlUiRoute(page, {
        pathname: "/skills/workshop",
        routeId: "skill-workshop",
      });
      await page.locator("#skill-workshop-mode-tab-board").click();
      await captureScreenshot(page, "narrow-empty-workshop-board.png");
      await expectEmptyWorkshopDoesNotScroll(page, ".sw-empty-state");
    } finally {
      await context.close();
    }
  });
});
