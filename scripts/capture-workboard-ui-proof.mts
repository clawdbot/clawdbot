#!/usr/bin/env node
import path from "node:path";
import { chromium } from "playwright";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { readControlUiProofOption } from "./lib/control-ui-proof-args.mts";
const DEFAULT_BASE_URL = "http://127.0.0.1:5187";
const DEFAULT_OUTPUT_DIR = path.resolve(".artifacts/control-ui-e2e/workboard-proof");
const WORKBOARD_SESSION_KEY = "agent:main:workboard-proof";

const baseUrl = new URL(readControlUiProofOption(process.argv, "base-url") ?? DEFAULT_BASE_URL);
const outputDir = createControlUiE2eArtifactDir(
  "workboard-proof",
  readControlUiProofOption(process.argv, "output-dir") ?? DEFAULT_OUTPUT_DIR,
);
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({
  colorScheme: "light",
  reducedMotion: "reduce",
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);

const gatewayUrl = new URL(baseUrl);
gatewayUrl.protocol = gatewayUrl.protocol === "https:" ? "wss:" : "ws:";
const settingsKey = `openclaw.control.settings.v1:${gatewayUrl.origin}`;
await page.addInitScript(
  ({ key, sessionKey }) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        boardSessionViews: { [sessionKey]: { activeTabId: "main" } },
        theme: "light",
      }),
    );
  },
  { key: settingsKey, sessionKey: WORKBOARD_SESSION_KEY },
);

try {
  await page.goto(new URL("/workboard/peter-tasks", baseUrl).toString());
  const automationChip = page.locator(".workboard-automation-chip");
  await automationChip.waitFor();
  if ((await automationChip.textContent())?.trim() !== "Automation") {
    throw new Error("Workboard automation chip did not render its expected label");
  }
  await page.getByText("Prepare launch readiness checklist", { exact: true }).waitFor();
  await page.screenshot({
    animations: "disabled",
    path: path.join(outputDir, "workboard-chip.png"),
  });

  await page.goto(new URL("/dashboard", baseUrl).toString());
  const widget = page.locator('[data-test-id="workboard-board-widget"]');
  await widget.waitFor();
  await widget.getByRole("heading", { name: "Validate onboarding flow", exact: true }).waitFor();
  await widget.getByRole("heading", { name: "Review accessibility audit", exact: true }).waitFor();
  await page.locator(".board-session-surface--dock-hidden").waitFor();
  const columnCount = await widget.locator(".workboard-column").count();
  if (columnCount !== 6) {
    throw new Error(`Expected 6 Workboard columns, received ${columnCount}`);
  }
  await page.screenshot({
    animations: "disabled",
    path: path.join(outputDir, "workboard-widget.png"),
  });
} finally {
  await context.close();
  await browser.close();
}

console.log(`[workboard-ui-proof] ${outputDir}`);
