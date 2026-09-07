import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";

export const agentFileProofDir =
  process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
    ? createControlUiE2eArtifactDir("agent-file-lifecycle")
    : undefined;

export async function captureAgentFileScreenshot(page: Page, name: string) {
  if (!agentFileProofDir) {
    return;
  }
  if (page.video()) {
    await writeFile(
      path.join(agentFileProofDir, name),
      await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
        page.locator(".agent-file-textarea"),
      ]),
    );
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(agentFileProofDir, name),
  });
}

export async function selectAgentFileWorkspace(page: Page, name: string) {
  const select = page.locator(".agents-control-select openclaw-agent-select");
  await select.locator(".agent-select__trigger").click();
  await select.locator("wa-dropdown-item[data-agent-option]").filter({ hasText: name }).click();
  await expect
    .poll(async () => (await select.locator(".agent-select__label").textContent())?.trim())
    .toBe(name);
}
