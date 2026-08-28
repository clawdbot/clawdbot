#!/usr/bin/env node
// Captures Where-chip placement proof: the open picker with the Auto row and
// its least-busy subtitle, and the collapsed chip after selecting Auto.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

const label = process.argv[2] ?? "after";
const outputDir = path.resolve(".artifacts/control-ui-e2e/where-chip-auto-proof");
await mkdir(outputDir, { recursive: true });
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error(`Playwright Chromium unavailable at ${executablePath}`);
}
const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({
  colorScheme: "dark",
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);
try {
  await installMockGateway(page, {
    methodResponses: {
      "environments.list": {
        environments: [
          {
            id: "node:studio",
            type: "node",
            label: "steipete-studio-sf",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 50, available: 50 },
          },
        ],
        profiles: [],
      },
    },
  });
  await page.goto(`${server.baseUrl}new`);
  const chip = page.getByText("Local", { exact: true }).first();
  await chip.waitFor();
  await page.waitForTimeout(600);
  await chip.click();
  await page.waitForSelector('[data-value="auto-device"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outputDir, `${label}-menu.png`) });
  await page.locator('[data-value="auto-device"]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outputDir, `${label}-selected.png`) });
  console.log("SHOT_OK", label);
} finally {
  await browser.close();
  await server.close();
}
