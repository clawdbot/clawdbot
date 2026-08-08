// Control UI tests keep build identity readable at UTF-16 truncation boundaries.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Unicode build identity mocked Gateway E2E",
  startServer: () =>
    startControlUiE2eServer({
      version: "2026.7.10",
      commit: "0123456789abcdef0123456789abcdef01234567",
      commitAt: "2026-07-10T11:22:33.000Z",
      builtAt: "2026-07-10T12:34:56.000Z",
      branch: RAW_BRANCH,
      dirty: true,
      release: false,
      buildId: "build-info-unicode-e2e",
    }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

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
  await sidebar.getByRole("button", { name: /^Identity and app menu for / }).click();
  const buildLink = sidebar.getByRole("link", { name: "Control UI build details", exact: true });
  await buildLink.waitFor();
  const compactText = (await buildLink.textContent()) ?? "";
  expect(compactText).toContain(`${COMPACT_BRANCH}@0123456`);
  expect(compactText).not.toContain("�");
  expect(containsBrokenSurrogate(compactText)).toBe(false);

  await buildLink.hover();
  const tooltip = sidebar.locator("openclaw-sidebar-build-chip openclaw-tooltip wa-tooltip");
  await expect.poll(() => tooltip.evaluate((element) => element.hasAttribute("open"))).toBe(true);
  const buildLinkHandle = await buildLink.elementHandle();
  if (!buildLinkHandle) {
    throw new Error("Expected the identity-menu build link to be attached");
  }
  const afterHideMarker = "data-openclaw-test-after-hide";
  await tooltip.evaluate((element, marker) => {
    element.removeAttribute(marker);
    element.addEventListener("wa-after-hide", () => element.setAttribute(marker, ""), {
      once: true,
    });
  }, afterHideMarker);
  await page.mouse.down();
  await expect
    .poll(() =>
      tooltip.evaluate((element, marker) => element.hasAttribute(marker), afterHideMarker),
    )
    .toBe(true);
  expect(await buildLinkHandle.evaluate((element) => element.isConnected)).toBe(true);
  await tooltip.evaluate((element, marker) => element.removeAttribute(marker), afterHideMarker);
  await page.mouse.up();
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

suite.define(() => {
  it("keeps slow build-link navigation intact across Unicode boundaries and reload", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installMockGateway(page);

        const response = await page.goto(`${suite.server.baseUrl}chat`);
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
      },
    );
  });
});
