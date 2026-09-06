import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Plugins workspace navigation",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("plugins-workspace-shell");
  }
});

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
    hash: "plugins-workspace-config",
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

type HeaderGeometry = {
  height: number;
  left: number;
  title: string;
  top: number;
  width: number;
};

async function createContext(viewport: { height: number; width: number }): Promise<BrowserContext> {
  return suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(captureUiProof ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
  });
}

async function headerGeometry(page: Page): Promise<HeaderGeometry> {
  const header = page.locator(".plugins-hub-header");
  await header.waitFor({ state: "visible" });
  return header.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      height: rect.height,
      left: rect.left,
      title: element.querySelector("h1")?.textContent?.trim() ?? "",
      top: rect.top,
      width: rect.width,
    };
  });
}

function expectStableHeader(actual: HeaderGeometry, expected: HeaderGeometry) {
  expect(Math.abs(actual.left - expected.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.top - expected.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(1);
}

async function expectHeaderCopy(page: Page, active: "plugins" | "skills") {
  const expected =
    active === "plugins"
      ? {
          title: "Plugins",
          subtitle: "Extend your Claw with tools",
          docs: "https://docs.openclaw.ai/plugins/manage-plugins",
        }
      : {
          title: "Skills",
          subtitle: "Manage agent skills and find new ones on ClawHub.",
          docs: "https://docs.openclaw.ai/tools/skills",
        };
  const header = page.locator(".plugins-hub-header");
  expect(await header.getByRole("heading", { level: 1 }).textContent()).toBe(expected.title);
  expect(await header.locator(".page-subtitle").textContent()).toContain(expected.subtitle);
  expect(await header.getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe(
    expected.docs,
  );
}

async function captureScreenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await writeFile(
    path.join(proofDir, name),
    await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
      page.locator(".plugins-hub-tabs"),
    ]),
  );
}

async function expectActivePanelLabel(page: Page, labelId: string) {
  const panel = page.locator("#plugins-hub-panel");
  await panel.waitFor({ state: "visible" });
  expect(await panel.getAttribute("aria-labelledby")).toBe(labelId);
  expect(await page.locator(`#${labelId}`).count()).toBe(1);
}

suite.define(() => {
  it("redirects the retired discovery URL to the Plugins workspace", async () => {
    const context = await createContext({ height: 768, width: 1366 });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["config.get", "plugins.list"],
      methodResponses,
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/plugins/discover?query=calendar#featured`);
      await waitForControlUiRoute(page, { pathname: "/plugins", routeId: "plugins" });
      const location = new URL(page.url());
      expect(`${location.pathname}${location.search}${location.hash}`).toBe(
        "/plugins?query=calendar#featured",
      );
      await page.getByRole("heading", { name: "Installed plugins", exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });

  it.each([
    { label: "desktop", viewport: { height: 1053, width: 2048 } },
    { label: "laptop", viewport: { height: 768, width: 1366 } },
    { label: "tablet", viewport: { height: 1024, width: 768 } },
    { label: "narrow", viewport: { height: 852, width: 393 } },
  ])(
    "keeps the Plugins/Skills shell coherent through every $label transition",
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
        await page.goto(`${suite.server.baseUrl}plugins`);
        await page.addStyleTag({
          content:
            "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
        });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await waitForControlUiRoute(page, { pathname: "/plugins", routeId: "plugins" });
        await page.getByRole("heading", { name: "Installed plugins" }).waitFor();
        const pluginsHeader = await headerGeometry(page);
        expect(pluginsHeader.title).toBe("Plugins");
        await expectHeaderCopy(page, "plugins");
        expect(await page.locator(".plugins-hub-tabs").getByRole("tab").count()).toBe(2);
        expect(
          await page.getByRole("tab", { name: "Plugins", exact: true }).getAttribute("active"),
        ).not.toBeNull();
        expect(await page.getByRole("tab", { name: /Installed|Discover/u }).count()).toBe(0);
        expect(await page.locator(".plugins-tabs.oc-segmented").count()).toBe(1);
        const tabBox = await page.locator(".plugins-tabs").boundingBox();
        const pluginTabBox = await page
          .getByRole("tab", { name: "Plugins", exact: true })
          .boundingBox();
        const titleBox = await page.locator(".plugins-hub-header .page-title").boundingBox();
        expect(tabBox).not.toBeNull();
        expect(pluginTabBox).not.toBeNull();
        expect(titleBox).not.toBeNull();
        expect((tabBox?.y ?? 0) + (tabBox?.height ?? 0)).toBeLessThanOrEqual(titleBox?.y ?? 0);
        expect(Math.abs((tabBox?.x ?? 0) - (titleBox?.x ?? 0))).toBeLessThanOrEqual(1);
        expect(pluginTabBox?.height ?? 0).toBeLessThanOrEqual(36);
        await expectActivePanelLabel(page, "plugins-tab-plugins");
        await captureScreenshot(page, `${label}-01-installed-plugins.png`);

        await page.getByRole("tab", { name: "Skills", exact: true }).click();
        await waitForControlUiRoute(page, { pathname: "/skills", routeId: "skills" });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await expectHeaderCopy(page, "skills");
        await expectActivePanelLabel(page, "plugins-tab-skills");
        expect(await page.getByRole("button", { name: "Workshop", exact: true }).isVisible()).toBe(
          true,
        );
        await captureScreenshot(page, `${label}-02-skills.png`);

        await page.getByRole("button", { name: "Workshop", exact: true }).click();
        await waitForControlUiRoute(page, {
          pathname: "/skills/workshop",
          routeId: "skill-workshop",
        });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await expectHeaderCopy(page, "skills");
        await expectActivePanelLabel(page, "plugins-tab-skills");
        expect(
          await page.getByRole("button", { name: "Back to Skills", exact: true }).isVisible(),
        ).toBe(true);
        await captureScreenshot(page, `${label}-03-workshop.png`);

        await page.getByRole("button", { name: "Back to Skills", exact: true }).click();
        await waitForControlUiRoute(page, { pathname: "/skills", routeId: "skills" });
        await page.getByRole("tab", { name: "Plugins", exact: true }).click();
        await waitForControlUiRoute(page, { pathname: "/plugins", routeId: "plugins" });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await expectHeaderCopy(page, "plugins");
      } finally {
        await context.close();
      }
    },
  );
});
