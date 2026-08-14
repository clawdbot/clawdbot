import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sidebarProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "sidebar-customization",
);

export function createSidebarCustomizationSuite(name: string) {
  return createControlUiE2eSuite({
    browserLaunchOptions:
      process.env.OPENCLAW_UI_E2E_HEADED === "1" ? { headless: false } : undefined,
    name,
    trackBrowserContexts: true,
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

export async function captureSidebarUiProof(page: Page, fileName: string): Promise<void> {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  await mkdir(sidebarProofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(sidebarProofArtifactDir, fileName),
  });
}

export async function captureSettingsSidebarUiProof(
  sidebar: Locator,
  fileName: string,
): Promise<void> {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  await mkdir(sidebarProofArtifactDir, { recursive: true });
  await sidebar.screenshot({
    animations: "disabled",
    path: path.join(sidebarProofArtifactDir, fileName),
  });
}

export async function captureSidebarUiUnionProof(
  page: Page,
  locators: Locator[],
  fileName: string,
): Promise<void> {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const boxes = (await Promise.all(locators.map((locator) => locator.boundingBox()))).filter(
    (box): box is NonNullable<typeof box> => box !== null,
  );
  if (boxes.length === 0) {
    throw new Error("Cannot capture sidebar proof without a visible surface");
  }
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Cannot capture sidebar proof without a fixed viewport");
  }
  const padding = 16;
  const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - padding);
  const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - padding);
  const right = Math.min(
    viewport.width,
    Math.max(...boxes.map((box) => box.x + box.width)) + padding,
  );
  const bottom = Math.min(
    viewport.height,
    Math.max(...boxes.map((box) => box.y + box.height)) + padding,
  );
  await mkdir(sidebarProofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    clip: { x: left, y: top, width: right - left, height: bottom - top },
    path: path.join(sidebarProofArtifactDir, fileName),
  });
}

export async function openSidebarCustomizationPage(
  suite: ReturnType<typeof createSidebarCustomizationSuite>,
) {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  await installMockGateway(page);
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.waitForFunction(() => Boolean(customElements.get("openclaw-lobster-pet")));
  return { context, page };
}
