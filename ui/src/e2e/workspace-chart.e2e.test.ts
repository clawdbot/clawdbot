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

const chartTypes = ["line", "bar", "area", "sparkline", "gauge"] as const;
const chartValues = [8, 16, 11, 24, 20, 31];

let browser: Browser;
let server: ControlUiE2eServer;

function workspaceDoc() {
  return {
    doc: {
      schemaVersion: 1,
      workspaceVersion: 1,
      tabs: [
        {
          slug: "charts",
          title: "Chart gallery",
          hidden: false,
          createdBy: "agent:main",
          widgets: chartTypes.map((type, index) => ({
            id: `chart_${type}`,
            kind: "builtin:chart",
            title: `${type[0]?.toUpperCase()}${type.slice(1)} chart`,
            grid:
              index < 3
                ? { x: index * 4, y: 0, w: 4, h: 3 }
                : { x: 2 + (index - 3) * 4, y: 3, w: 4, h: 3 },
            collapsed: false,
            createdBy: "agent:main",
            props: { type },
            bindings: { value: { source: "static", value: chartValues } },
          })),
        },
      ],
      widgetsRegistry: {},
      prefs: { tabOrder: ["charts"] },
    },
    workspaceVersion: 1,
  };
}

async function captureProof(page: Page): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: path.join(proofDir, "workspace-chart-gallery.png"),
  });
  const widgets = page.locator('[data-test-id="workspace-widget"]');
  for (const [index, type] of chartTypes.entries()) {
    await widgets
      .nth(index)
      .screenshot({ path: path.join(proofDir, `workspace-chart-${type}.png`) });
  }
}

describeControlUiE2e("Control UI workspace chart widgets", () => {
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

  it("renders every trusted chart type with an accessible data summary", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
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
      const widgets = page.locator('[data-test-id="workspace-widget"]');
      await expect.poll(() => widgets.count()).toBe(chartTypes.length);

      for (const [index, type] of chartTypes.entries()) {
        const widget = widgets.nth(index);
        const chart = widget.locator('[data-test-id="workspace-chart"]');
        await chart.waitFor({ timeout: 10_000 });
        expect(await widget.locator(`.workspace-chart--${type}`).count()).toBe(1);
        expect(await chart.getAttribute("role")).toBe("img");
        expect(await chart.getAttribute("aria-label")).toBe(
          `${type[0]?.toUpperCase()}${type.slice(1)} chart: 6 data points, ranging from 8 to 31.`,
        );
      }

      await captureProof(page);
    } finally {
      await context.close();
    }
  });
});
