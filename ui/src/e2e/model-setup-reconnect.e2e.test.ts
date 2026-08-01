// Browser proof that model setup reloads after a same-client Gateway reconnect.
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
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "model-setup-reconnect",
);

function detection(modelRef: string) {
  return {
    candidates: [],
    manualProviders: [],
    configuredModel: modelRef,
    setupComplete: true,
    workspace: "/tmp/openclaw-e2e",
  };
}

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI model setup same-client reconnect", () => {
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

  it("re-detects once and replaces stale visible model state after reconnect", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const gateway = await installMockGateway(page, {
      featureMethods: ["openclaw.setup.detect"],
      methodResponses: { "openclaw.setup.detect": detection("provider/original-model") },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-setup`);
      expect(response?.status()).toBe(200);
      await page.getByText("original-model", { exact: true }).waitFor();
      const initialDetections = (await gateway.getRequests("openclaw.setup.detect")).length;
      const initialConnections = (await gateway.getRequests("connect")).length;
      await gateway.setMethodResponse(
        "openclaw.setup.detect",
        detection("provider/reconnected-model"),
      );
      await gateway.deferNext("connect");
      await gateway.closeLatest(1012, "model setup reconnect proof");
      await expect
        .poll(async () => page.getByText("original-model", { exact: true }).count())
        .toBe(0);
      await expect
        .poll(async () => (await gateway.getRequests("connect")).length)
        .toBeGreaterThan(initialConnections);
      await gateway.resolveDeferred("connect");
      await expect
        .poll(async () => (await gateway.getRequests("openclaw.setup.detect")).length)
        .toBe(initialDetections + 1);
      await page.getByText("reconnected-model", { exact: true }).waitFor();
      expect(pageErrors).toEqual([]);

      if (captureUiProofEnabled) {
        await mkdir(artifactDir, { recursive: true });
        await page.locator("openclaw-model-setup-page").screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "00-reconnected-model-visible.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
