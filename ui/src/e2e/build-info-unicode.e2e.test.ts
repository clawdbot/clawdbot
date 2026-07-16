// Control UI tests keep build identity readable at UTF-16 truncation boundaries.
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
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "build-info-unicode",
);

const RAW_BRANCH = `${"a".repeat(12)}😀${"b".repeat(85)}😀suffix`;
const NORMALIZED_BRANCH = `${"a".repeat(12)}😀${"b".repeat(85)}`;
const COMPACT_BRANCH = `${"a".repeat(12)}😀…`;

let browser: Browser;
let server: ControlUiE2eServer;

function containsBrokenSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function openBuildDetails(page: Page) {
  const sidebar = page.locator("openclaw-app-sidebar");
  const agentMenu = sidebar.getByRole("button", { name: /Agent menu/ });
  await agentMenu.waitFor();
  await agentMenu.click();
  const buildLink = page.getByRole("link", { name: "Control UI build details", exact: true });
  await buildLink.waitFor();
  const compactText = (await buildLink.textContent()) ?? "";
  expect(compactText).toContain(`${COMPACT_BRANCH}@0123456`);
  expect(compactText).not.toContain("�");
  expect(containsBrokenSurrogate(compactText)).toBe(false);

  await buildLink.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/about");
}

async function assertFullBranchLabel(page: Page) {
  const branchValue = page
    .locator(".settings-kv dt", { hasText: "Branch" })
    .locator("xpath=following-sibling::dd[1]/code");
  await branchValue.waitFor();
  const fullText = (await branchValue.textContent()) ?? "";
  expect(fullText).toBe(`${NORMALIZED_BRANCH}*`);
  expect(fullText).not.toContain("�");
  expect(containsBrokenSurrogate(fullText)).toBe(false);
}

describeControlUiE2e("Control UI Unicode build identity mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer({
      version: "2026.7.10",
      commit: "0123456789abcdef0123456789abcdef01234567",
      builtAt: "2026-07-10T12:34:56.000Z",
      branch: RAW_BRANCH,
      dirty: true,
      buildId: "build-info-unicode-e2e",
    });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders intact emoji at compact and metadata boundaries across navigation and reload", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      const response = await page.goto(`${server.baseUrl}chat`);
      expect(response?.status()).toBe(200);
      await openBuildDetails(page);
      await assertFullBranchLabel(page);
      await page.reload();
      await assertFullBranchLabel(page);

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "01-about-build-identity.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
