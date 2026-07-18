import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const proofDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();

let browser: Browser;
let server: ControlUiE2eServer;

function workspaceDoc() {
  return {
    doc: {
      schemaVersion: 1,
      workspaceVersion: 1,
      tabs: [
        {
          slug: "previews",
          title: "Secure previews",
          hidden: false,
          createdBy: "agent:main",
          widgets: [
            {
              id: "preview_allowed",
              kind: "builtin:preview",
              title: "Local app preview",
              grid: { x: 0, y: 0, w: 8, h: 5 },
              collapsed: false,
              createdBy: "agent:main",
              props: { url: "/stale", defaultViewport: "desktop" },
              bindings: { value: { source: "static", value: "/preview-proof" } },
            },
            {
              id: "preview_blocked",
              kind: "builtin:preview",
              title: "Blocked external preview",
              grid: { x: 8, y: 0, w: 4, h: 5 },
              collapsed: false,
              createdBy: "agent:main",
              props: { url: "https://blocked.example" },
            },
          ],
        },
      ],
      widgetsRegistry: {},
      prefs: { tabOrder: ["previews"] },
    },
    workspaceVersion: 1,
  };
}

async function capture(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(proofDir, name) });
}

describeControlUiE2e("Control UI secure preview widget", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders an allowed bound origin, blocks an external origin, and preserves controls", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    let previewRequests = 0;
    await page.route("**/preview-proof", async (route) => {
      previewRequests += 1;
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><style>body{margin:0;font:24px system-ui;background:#13293d;color:#fff;display:grid;place-items:center;height:100vh}strong{color:#62d9ff}</style><p><strong>Allowed</strong> same-origin preview</p>`,
      });
    });
    await installMockGateway(page, {
      controlUiTabs: [
        {
          pluginId: "workspaces",
          id: "workspaces",
          label: "Workspaces",
          group: "control",
        },
      ],
      featureMethods: ["workspaces.get"],
      methodResponses: { "workspaces.get": workspaceDoc() },
    });

    try {
      const response = await page.goto(`${server.baseUrl}plugin?plugin=workspaces&id=workspaces`);
      expect(response?.status()).toBe(200);
      const allowed = page.locator('[data-widget-id="preview_allowed"]');
      const blocked = page.locator('[data-widget-id="preview_blocked"]');
      const frame = allowed.locator('[data-test-id="workspace-preview-frame"]');
      await frame.waitFor({ timeout: 10_000 });
      await blocked.locator('[data-test-id="workspace-preview-blocked"]').waitFor();
      expect(await frame.getAttribute("src")).toBe("/preview-proof");
      expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
      expect(await blocked.locator('[data-test-id="workspace-preview-frame"]').count()).toBe(0);
      await expect.poll(() => previewRequests).toBeGreaterThan(0);
      await capture(page, "workspace-preview-allowed-and-blocked.png");

      await allowed.locator('[data-test-id="workspace-preview-viewport-mobile"]').click();
      await expect
        .poll(() => allowed.locator(".workspace-preview__frame-wrap--mobile").count())
        .toBe(1);
      expect(
        await allowed
          .locator('[data-test-id="workspace-preview-viewport-mobile"]')
          .getAttribute("aria-pressed"),
      ).toBe("true");
      await capture(page, "workspace-preview-mobile.png");

      const requestsBeforeReload = previewRequests;
      await allowed.locator('[data-test-id="workspace-preview-reload"]').click();
      await expect.poll(() => previewRequests).toBeGreaterThan(requestsBeforeReload);
      expect(await allowed.locator(".workspace-preview__frame-wrap--mobile").count()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
