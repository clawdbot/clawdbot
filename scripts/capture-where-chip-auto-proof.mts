#!/usr/bin/env node
// Captures placement, inventory, and context-meter proof in both themes.
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

const captureLabel = process.argv[2] ?? "after";
const outputDir = createControlUiE2eArtifactDir(
  "node-slot-pips-proof",
  process.argv[3] ?? "/tmp/node-slot-pips-proof",
);
const remoteExec = process.argv[4] === "remote-exec";
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error(`Playwright Chromium unavailable at ${executablePath}`);
}
const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });
const environments = [
  { id: "idle", label: "Idle runner", workerSlots: { total: 8, available: 8 } },
  { id: "partial", label: "Busy runner", workerSlots: { total: 8, available: 5 } },
  { id: "full", label: "Full runner", workerSlots: { total: 8, available: 0 } },
  { id: "offline", label: "Offline runner", workerSlots: { total: 8, available: 2 } },
  { id: "large", label: "Large runner", workerSlots: { total: 13, available: 6 } },
  { id: "exec", label: "Terminal runner" },
].map(({ id, label, workerSlots }) => ({
  id: `node:${id}`,
  label,
  workerSlots,
  type: "node",
  status: id === "offline" ? "unavailable" : "available",
  sessionHost: true,
  platform: "linux",
  capabilities: ["codex.exec-server"],
  invocableCommands: ["codex.exec-server.stdio.v2"],
}));
try {
  for (const mode of ["dark", "light"] as const) {
    const context = await browser.newContext({
      colorScheme: mode,
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const config = { ui: { prefs: { theme: "claw", themeMode: mode } } };
    await installMockGateway(page, {
      ...(remoteExec
        ? {
            agentModel: "openai/gpt-5.6-sol",
            models: [
              {
                available: true,
                id: "gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                provider: "openai",
                agentRuntime: {
                  id: "codex",
                  devicePlacementSupported: true,
                  source: "model",
                  devicePlacement: {
                    requiredNodeCommands: ["codex.exec-server.stdio.v2"],
                    consumesWorkerSlot: false,
                  },
                },
              },
            ],
          }
        : {}),
      methodResponses: {
        "config.get": { config, hash: "capacity-proof", valid: true, issues: [] },
        "environments.list": {
          environments,
          profiles: [],
        },
        "node.list": {
          nodes: environments.map((entry) => ({
            nodeId: entry.id.slice(5),
            displayName: entry.label,
            platform: entry.platform,
            paired: true,
            connected: entry.status === "available",
            approvalState: "approved",
            caps: entry.capabilities,
            commands: entry.invocableCommands,
            workerSlots: entry.workerSlots,
          })),
        },
        "sessions.list": {
          count: 4,
          ts: 0,
          path: "",
          defaults: {},
          sessions: [
            { label: "Context OK", totalTokens: 40_000 },
            { label: "Context warning", totalTokens: 140_000 },
            { label: "Context danger", totalTokens: 180_000 },
            { label: "Context approximate", totalTokens: 180_000, totalTokensFresh: false },
          ].map(({ label, totalTokens, totalTokensFresh }, index) => ({
            label,
            totalTokens,
            totalTokensFresh,
            key: `agent:main:context-${index}`,
            kind: "direct",
            updatedAt: 0,
            contextTokens: 200_000,
            hasActiveRun: false,
          })),
        },
      },
    });
    await page.goto(`${server.baseUrl}new`);
    const chip = page.getByText("Local", { exact: true }).first();
    await chip.waitFor();
    await page.waitForFunction(
      (themeMode) => document.documentElement.dataset.themeMode === themeMode,
      mode,
    );
    await page.evaluate(() => document.fonts.ready);
    await chip.click();
    await page.waitForSelector('[data-value="auto-device"]');
    await page.locator('[data-value="device:exec"]').waitFor();
    if (remoteExec) {
      assert.equal(await page.locator('[data-value="device:full"]').isEnabled(), true);
      assert.equal(await page.locator('[data-value="device:exec"]').isEnabled(), true);
    }
    await page.screenshot({
      path: path.join(outputDir, `${captureLabel}-${mode}-menu.png`),
      animations: "disabled",
    });
    await page.locator('[data-value="auto-device"]').click();
    await page.locator('#new-session-where-trigger[data-auto-device="true"]').waitFor();
    if (remoteExec) {
      await page.locator("#new-session-where-trigger").click();
      await page.locator('[data-value="device:full"]').click();
      await page.locator('#new-session-where-trigger[data-device-id="full"]').waitFor();
      console.log("SHOT_OK", captureLabel, mode, outputDir);
      await context.close();
      continue;
    }
    await page.goto(`${server.baseUrl}settings/devices`);
    await page.getByText("Terminal runner", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(outputDir, `${captureLabel}-${mode}-devices.png`),
      animations: "disabled",
    });
    await page.goto(`${server.baseUrl}sessions`);
    await page.locator(".session-context-meter").first().waitFor();
    assert.equal(await page.locator(".session-context-meter").count(), 4);
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".data-table-container").screenshot({
      path: path.join(outputDir, `${captureLabel}-${mode}-sessions.png`),
      animations: "disabled",
    });
    console.log("SHOT_OK", captureLabel, mode, outputDir);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
