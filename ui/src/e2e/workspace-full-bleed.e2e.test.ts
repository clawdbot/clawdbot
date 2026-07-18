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
const baselineOnly = process.env.OPENCLAW_UI_E2E_BASELINE === "1";

let browser: Browser;
let server: ControlUiE2eServer;

function workspaceDoc() {
  return {
    doc: {
      schemaVersion: 1,
      workspaceVersion: 1,
      tabs: [
        {
          slug: "release-room",
          title: "Release room",
          hidden: false,
          layout: baselineOnly ? "grid" : "full",
          createdBy: "agent:main",
          widgets: [
            {
              id: "release_room_app",
              kind: "builtin:iframe-embed",
              title: "Release room app",
              grid: { x: 2, y: 0, w: 8, h: 6 },
              collapsed: false,
              createdBy: "agent:main",
              props: { url: "/full-bleed-proof" },
            },
          ],
        },
      ],
      widgetsRegistry: {},
      prefs: { tabOrder: ["release-room"] },
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

describeControlUiE2e("Control UI full-bleed workspace tabs", () => {
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

  it("removes grid chrome and lets the single sandboxed app fill the tab", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await page.route("**/full-bleed-proof", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #071a2b; color: #e8f4ff; font: 18px system-ui; }
          main { width: min(760px, 80%); padding: 48px; border: 1px solid #3278a8; border-radius: 18px; background: #0d2942; }
          h1 { margin-top: 0; color: #62d9ff; } .status { color: #8ce99a; }
        </style><main><p class="status">All systems ready</p><h1>Release room</h1><p>One app. The whole workspace tab.</p></main>`,
      }),
    );
    await installMockGateway(page, {
      controlUiTabs: [
        { pluginId: "workspaces", id: "workspaces", label: "Workspaces", group: "control" },
      ],
      featureMethods: ["workspaces.get"],
      methodResponses: { "workspaces.get": workspaceDoc() },
    });

    try {
      const response = await page.goto(`${server.baseUrl}plugin?plugin=workspaces&id=workspaces`);
      expect(response?.status()).toBe(200);
      await page.locator('[data-test-id="workspace-onboarding-dismiss"]').click();
      const frame = page.locator('[data-test-id="workspace-embed-frame"]');
      await frame.waitFor({ timeout: 10_000 });
      expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");

      if (baselineOnly) {
        expect(await page.locator('[data-test-id="workspace-grid"]').count()).toBe(1);
        expect(await page.locator('[data-test-id="workspace-widget"]').count()).toBe(1);
        await capture(page, "workspace-full-bleed-before.png");
        return;
      }

      const fullBleed = page.locator('[data-test-id="workspace-fullbleed"]');
      await fullBleed.waitFor();
      expect(await page.locator('[data-test-id="workspace-grid"]').count()).toBe(0);
      expect(await page.locator('[data-test-id="workspace-widget"]').count()).toBe(0);
      const [containerBox, frameBox] = await Promise.all([
        fullBleed.boundingBox(),
        frame.boundingBox(),
      ]);
      expect(containerBox).not.toBeNull();
      expect(frameBox).not.toBeNull();
      expect(Math.abs(frameBox!.width - containerBox!.width)).toBeLessThan(2);
      expect(Math.abs(frameBox!.height - containerBox!.height)).toBeLessThan(2);
      expect(frameBox!.height).toBeGreaterThanOrEqual(480);
      await capture(page, "workspace-full-bleed-after.png");
    } finally {
      await context.close();
    }
  });
});
