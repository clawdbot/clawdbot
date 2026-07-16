// Control UI tests cover shared Settings control styling through the mocked Gateway.
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

let browser: Browser;
let server: ControlUiE2eServer;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "settings-controls",
);

async function resolvedBackground(page: Page, value: string): Promise<string> {
  return page.evaluate((background) => {
    const probe = document.createElement("div");
    probe.style.background = background;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, value);
}

describeControlUiE2e("Control UI Settings controls mocked Gateway E2E", () => {
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

  it("keeps the view selector compact and checked switches on the scene accent", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const config = { browser: { enabled: true } };
    await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config,
          hash: "hash-1",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}config`);
      expect(response?.status()).toBe(200);

      const viewSelector = page
        .locator(".content-header")
        .getByRole("radiogroup", { name: "Settings view", exact: true });
      await viewSelector.waitFor();
      const activeMode = page.locator('.content-header wa-radio[value="quick"]');
      expect(
        await activeMode.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeLessThanOrEqual(40);
      expect(
        await page.locator('.content-header [slot="label"]').evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            height: box.height,
            overflow: getComputedStyle(element).overflow,
            width: box.width,
          };
        }),
      ).toEqual({ height: 1, overflow: "hidden", width: 1 });
      expect(
        await activeMode.evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe(await resolvedBackground(page, "var(--bg-elevated)"));

      const browserSwitchRole = page
        .locator("#settings-general-security")
        .getByRole("switch", { name: "Browser enabled", exact: true });
      await browserSwitchRole.waitFor();
      expect(await browserSwitchRole.getAttribute("aria-checked")).toBe("true");
      const browserSwitch = page.locator("#settings-general-security wa-switch.settings-toggle");
      expect(
        await browserSwitch.evaluate((element) => {
          const control = element.shadowRoot?.querySelector<HTMLElement>('[part="control"]');
          return control ? getComputedStyle(control).backgroundColor : null;
        }),
      ).toBe(await resolvedBackground(page, "var(--accent)"));

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await page.locator(".content-header").screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "01-settings-view.png"),
        });
        await page.locator("#settings-general-security").screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "02-security-controls.png"),
        });
      }

      await browserSwitch.click();
      await expect.poll(() => browserSwitchRole.getAttribute("aria-checked")).toBe("false");
      await page.locator('.content-header wa-radio[value="advanced"]').click();
      await expect
        .poll(() =>
          page
            .locator('.content-header wa-radio[value="advanced"]')
            .evaluate((element) => (element as HTMLElement & { checked: boolean }).checked),
        )
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
