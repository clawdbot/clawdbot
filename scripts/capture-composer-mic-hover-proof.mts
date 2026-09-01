#!/usr/bin/env node
import path from "node:path";
import { chromium } from "playwright";
// Captures composer mic-hover proof shots: idle vs hovered talk control, plus
// the mic button's x position in both states (the hover-shift regression).
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
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

const outputDir = createControlUiE2eArtifactDir(
  "composer-mic-hover-proof",
  readOption("output-dir") ?? ".artifacts/control-ui-e2e/composer-mic-hover-proof",
);
const label = readOption("label") ?? "after";
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
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
  await installMockGateway(page);
  await page.goto(`${server.baseUrl}chat`);
  const composer = page.locator(".agent-chat__input");
  await composer.waitFor({ state: "visible" });
  const voice = page.getByRole("button", { name: "Start voice input" });
  await voice.waitFor({ state: "visible" });

  await page.mouse.move(10, 10);
  await page.waitForTimeout(400);
  const composerBox = await composer.boundingBox();
  if (!composerBox) {
    throw new Error("composer has no layout box");
  }
  const clip = {
    x: Math.max(0, composerBox.x - 12),
    y: Math.max(0, composerBox.y - 12),
    width: Math.min(1280, composerBox.width + 24),
    height: composerBox.height + 24,
  };
  const idleVoiceBox = await voice.boundingBox();
  await page.screenshot({ clip, path: path.join(outputDir, `${label}-idle.png`) });

  await voice.hover();
  await page.waitForTimeout(400);
  const hoverVoiceBox = await voice.boundingBox();
  await page.screenshot({ clip, path: path.join(outputDir, `${label}-hover.png`) });

  const picker = page.getByRole("button", { name: "Microphone input" });
  if (await picker.count()) {
    await picker.hover();
    await page.waitForTimeout(400);
    await page.screenshot({ clip, path: path.join(outputDir, `${label}-hover-chevron.png`) });
    await picker.click();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(outputDir, `${label}-picker-open.png`),
      clip: { ...clip, y: Math.max(0, clip.y - 260), height: clip.height + 260 },
    });
    await page.keyboard.press("Escape");
  }

  if (!idleVoiceBox || !hoverVoiceBox) {
    throw new Error("voice button has no layout box");
  }
  console.log(
    JSON.stringify(
      {
        label,
        idleVoiceX: idleVoiceBox.x,
        hoverVoiceX: hoverVoiceBox.x,
        hoverShiftPx: hoverVoiceBox.x - idleVoiceBox.x,
        outputDir,
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
