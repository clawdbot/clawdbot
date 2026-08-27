#!/usr/bin/env node
// Captures chat model-picker proof shots: the open picker inheriting the agent
// default, the same picker with a session override, and the picker after a
// failed catalog refresh. Also reports the x offset between the provider
// heading label and the model row name (the row-alignment change).
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outputDir = path.resolve(
  readOption("output-dir") ?? ".artifacts/control-ui-e2e/model-picker-proof",
);
const label = readOption("label") ?? "after";
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

const models = [
  { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", contextWindow: 400_000 },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", contextWindow: 1_000_000 },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", contextWindow: 1_000_000 },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai", contextWindow: 1_000_000 },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    contextWindow: 200_000,
  },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic", contextWindow: 200_000 },
];

await mkdir(outputDir, { recursive: true });
const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({
  colorScheme: "dark",
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);

try {
  const gateway = await installMockGateway(page, { agentModel: "openai/gpt-5.5", models });
  await page.goto(`${server.baseUrl}chat`);
  await gateway.waitForRequest("chat.startup");

  const composer = page.locator(".agent-chat__input");
  await composer.waitFor({ state: "visible" });
  const trigger = composer.locator('[data-chat-model-select="true"]');
  const menu = composer.locator(".chat-controls__model-menu");

  const openPicker = async () => {
    await trigger.click();
    await menu.waitFor({ state: "visible" });
    await page.waitForTimeout(500);
  };
  const closePicker = async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  };
  const shoot = async (name: string) => {
    const box = await menu.boundingBox();
    if (!box) {
      throw new Error(`model menu has no layout box for ${name}`);
    }
    await page.screenshot({
      path: path.join(outputDir, `${label}-${name}.png`),
      clip: {
        x: Math.max(0, box.x - 8),
        y: Math.max(0, box.y - 8),
        width: box.width + 16,
        height: box.height + 16,
      },
    });
  };

  await openPicker();
  await shoot("default");

  const headingLabel = menu.locator(".chat-controls__provider-heading span").last();
  const rowName = menu.locator(".chat-controls__model-option-name").first();
  const headingBox = await headingLabel.boundingBox();
  const rowBox = await rowName.boundingBox();

  const search = menu.locator("[data-chat-model-search]");
  await search.fill("default");
  await page.waitForTimeout(400);
  await shoot("search-default");
  const searchMatches = await menu
    .locator("[data-chat-model-option]:not([hidden])")
    .evaluateAll((rows) => rows.map((row) => row.textContent?.replace(/\s+/gu, " ").trim() ?? ""));
  await search.fill("");
  await page.waitForTimeout(250);

  const override = menu.locator('[data-chat-model-option="openai/gpt-5.6-terra"]');
  await override.click();
  await page.waitForTimeout(600);
  await openPicker();
  await shoot("override");
  await closePicker();

  // A fresh page drops the per-client catalog cache, so the picker's own load
  // reaches the mock gateway and fails there.
  await gateway.setMethodResponse("models.list", {
    __mockError: { code: "UNAVAILABLE", message: "mock catalog refresh failed" },
  });
  await page.reload();
  await composer.waitFor({ state: "visible" });
  await page.waitForTimeout(1000);
  await openPicker();
  await page.waitForTimeout(1500);
  await shoot("refresh-failure");
  const catalogStateText = await menu.locator("[data-chat-model-catalog-state]").allTextContents();
  const rowsAfterFailure = await menu.locator("[data-chat-model-option]").count();
  await closePicker();

  console.log(
    JSON.stringify(
      {
        label,
        outputDir,
        providerHeadingLabelX: headingBox?.x ?? null,
        modelRowNameX: rowBox?.x ?? null,
        alignmentDeltaPx: headingBox && rowBox ? rowBox.x - headingBox.x : null,
        searchDefaultMatches: searchMatches,
        catalogStateAfterRefreshFailure: catalogStateText,
        modelRowsAfterRefreshFailure: rowsAfterFailure,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
