#!/usr/bin/env node
import path from "node:path";
import { chromium } from "playwright";
// Captures webchat proof that a CLI harness-injected user turn renders as a
// collapsed system notice while the operator's own message keeps its bubble.
// Usage: node --import tsx scripts/capture-injected-turn-notice-proof.mts [--mode after|before]
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { readControlUiProofOption } from "./lib/control-ui-proof-args.mts";

const mode = readControlUiProofOption(process.argv, "mode") ?? "after";
if (mode !== "after" && mode !== "before") {
  throw new Error(`Expected --mode after|before, received ${mode}`);
}
const outputDir = createControlUiE2eArtifactDir(
  "injected-turn-notice-proof",
  readControlUiProofOption(process.argv, "output-dir") ??
    ".artifacts/control-ui-e2e/injected-turn-notice-proof",
);

const baseTime = Date.parse("2026-08-26T20:37:00.000Z");
const skillBody = [
  "Base directory for this skill: /tmp/skills/autoreview",
  "",
  "# Auto Review",
  "",
  "Run the bundled structured review helper as a closeout check.",
].join("\n");
// Mirrors the chat.history payload proven by the gateway integration test:
// the operator turn is a plain user row; the harness-injected turn carries the
// provenance recorded by the claude-cli importer. Before the fix the importer
// dropped that provenance, so --mode before omits it to reproduce the shipped
// payload.
const historyMessages = [
  {
    role: "user",
    content: "Run the autoreview skill on this branch.",
    timestamp: baseTime,
    __openclaw: { id: "user-1", seq: 1 },
  },
  {
    role: "user",
    content: [{ type: "text", text: skillBody }],
    ...(mode === "after"
      ? { provenance: { kind: "internal_system", sourceTool: "cli_harness_context" } }
      : {}),
    timestamp: baseTime + 1_000,
    __openclaw: {
      id: "skill-meta-1",
      importedFrom: "claude-cli",
      cliSessionId: "cli-session-1",
      externalId: "skill-meta-1",
      seq: 2,
    },
  },
  {
    role: "assistant",
    content: "Autoreview finished: no findings.",
    timestamp: baseTime + 2_000,
    __openclaw: { id: "assistant-1", seq: 3 },
  },
];

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });
try {
  const context = await browser.newContext({
    colorScheme: "dark",
    locale: "en-US",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await installMockGateway(page, { historyMessages });
  await page.goto(`${server.baseUrl}chat`);
  await page.getByText("Autoreview finished: no findings.").waitFor({ state: "visible" });
  await page.getByText("Run the autoreview skill on this branch.").waitFor({ state: "visible" });
  if (mode === "after") {
    // The injected turn renders as a collapsed system notice; expand it so the
    // capture shows the disclosure carrying the skill body.
    const toggle = page.locator(".chat-notice__toggle");
    await toggle.waitFor({ state: "visible" });
    await toggle.click();
    await page.getByText("Base directory for this skill:", { exact: false }).waitFor({
      state: "visible",
    });
  } else {
    await page.getByText("Base directory for this skill:", { exact: false }).waitFor({
      state: "visible",
    });
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  const target = path.join(outputDir, `injected-turn-${mode}.png`);
  await page.locator(".chat-thread-inner").screenshot({ animations: "disabled", path: target });
  console.log(`captured ${target}`);
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
