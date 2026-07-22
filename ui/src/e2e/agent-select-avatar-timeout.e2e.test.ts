// Control UI tests cover bounded authenticated agent-picker avatar fetches.
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
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "agent-select-avatar-timeout",
);

let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

describeControlUiE2e("Control UI agent picker avatar timeout", () => {
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

  it("aborts a stalled authenticated avatar request and keeps the text fallback", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.clock.install();

    let avatarRequestCount = 0;
    let avatarAuthorization: string | undefined;
    const failedAvatarRequests: string[] = [];
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname === "/avatar/main") {
        failedAvatarRequests.push(request.failure()?.errorText ?? "unknown");
      }
    });
    await page.route(/\/avatar\/main$/, (route) => {
      avatarRequestCount += 1;
      avatarAuthorization = route.request().headers().authorization;
      // Leave the route unanswered. The page-owned deadline must cancel it.
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agent.identity.get": {
          agentId: "main",
          avatar: "/avatar/main",
          avatarStatus: "local",
          name: "Main agent",
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}agents`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agent.identity.get");
      await expect.poll(() => avatarRequestCount).toBe(1);
      const picker = page.locator("openclaw-agent-select");
      await expect
        .poll(() =>
          picker.locator(".agent-select__avatar--text").first().getAttribute("data-avatar"),
        )
        .toBe("O");
      expect(avatarAuthorization).toBe("Bearer e2e-device-token");
      await screenshot(page, "01-request-stalled.png");

      await page.clock.runFor(30_000);
      await expect.poll(() => failedAvatarRequests.length).toBe(1);
      await expect.poll(() => picker.locator("img.agent-select__avatar").count()).toBe(0);
      await expect
        .poll(() =>
          picker.locator(".agent-select__avatar--text").first().getAttribute("data-avatar"),
        )
        .toBe("O");

      // A later render must use the cached miss instead of launching another fetch.
      await picker.locator(".agent-select__trigger").click();
      expect(avatarRequestCount).toBe(1);
      await screenshot(page, "02-timeout-fallback.png");
    } finally {
      await context.close();
    }
  });
});
