// Control UI sidebar footer flags non-release gateways: a source-checkout
// gateway off main reports its branch via bootstrap config and the footer
// renders it in the danger color; release gateways omit it entirely.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
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

const DEV_BRANCH = "feat/dev-branch-badge";

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI sidebar dev branch badge E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders the dev checkout branch in the footer in the danger color", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, { devGitBranch: DEV_BRANCH });

    try {
      const response = await page.goto(server.baseUrl);
      expect(response?.status()).toBe(200);

      const badge = page.locator(".sidebar-footer-branch");
      await badge.waitFor();
      await expect.poll(() => badge.textContent()).toBe(DEV_BRANCH);
      await expect.poll(() => badge.getAttribute("title")).toBe(DEV_BRANCH);

      const colors = await badge.evaluate((element) => {
        // Compare resolved colors: getComputedStyle().color returns rgb() while
        // the raw --danger token may be hex/oklch, so resolve it via a probe.
        const probe = document.createElement("span");
        probe.style.color = "var(--danger)";
        element.append(probe);
        const danger = getComputedStyle(probe).color;
        probe.remove();
        return { badge: getComputedStyle(element).color, danger };
      });
      expect(colors.danger).not.toBe("");
      expect(colors.badge).toBe(colors.danger);

      const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "dev-branch");
      await mkdir(artifactDir, { recursive: true });
      await page
        .locator(".sidebar-shell__footer")
        .screenshot({ path: path.join(artifactDir, "footer-dev-branch.png") });
    } finally {
      await context.close();
    }
  });

  it("omits the badge when the gateway reports no dev branch", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      const response = await page.goto(server.baseUrl);
      expect(response?.status()).toBe(200);
      await page.locator(".sidebar-footer-bar").waitFor();
      expect(await page.locator(".sidebar-footer-branch").count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
