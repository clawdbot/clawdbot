// Control UI E2E proves the retired bypass upgrade is an explicit browser action.
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
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "device-auth-migration",
);

let browser: Browser;
let server: ControlUiE2eServer;

describe("Control UI device-auth migration E2E", () => {
  beforeAll(async () => {
    if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows an explicit secure action and removes it only after approval", async () => {
    if (captureProof) {
      await mkdir(path.join(artifactDir, "video"), { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: captureProof
        ? { dir: path.join(artifactDir, "video"), size: { height: 900, width: 1440 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { deviceAuthMigrationPending: true });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const action = page.getByRole("button", { name: "Secure this browser" });
      await action.waitFor();
      await expect.poll(() => gateway.getRequests("device.pair.list")).toHaveLength(1);
      if (captureProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "pending.png"),
        });
      }

      await action.click();
      await expect.poll(() => gateway.getRequests("device.pair.approve")).toHaveLength(1);
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThanOrEqual(2);
      await expect.poll(() => action.isVisible()).toBe(false);
      if (captureProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "paired.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
