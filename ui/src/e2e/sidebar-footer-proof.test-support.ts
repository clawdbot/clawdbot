import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const proofArtifactRoot = path.join(process.cwd(), ".artifacts", "control-ui-e2e");

export const SIDEBAR_PROOF_USER = {
  self: true,
  id: "riley",
  name: "Riley",
  email: "riley.with.a.deliberately.long.address@example.test",
} as const;

export function createSidebarFooterProofSuite(name: string, buildInfo?: ControlUiBuildInfo) {
  return createControlUiE2eSuite({
    name,
    browserLaunchOptions: { headless: process.env.OPENCLAW_UI_E2E_HEADED !== "1" },
    startServer: () => startControlUiE2eServer(buildInfo, { source: true }),
    startServerBeforeBrowser: true,
    trackBrowserContexts: true,
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

export async function openSidebarFooterProofPage(
  suite: ReturnType<typeof createSidebarFooterProofSuite>,
  options: NonNullable<Parameters<typeof installMockGateway>[1]> = {},
  beforeNavigation?: (page: Page) => Promise<void>,
) {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  await beforeNavigation?.(page);
  const gateway = await installMockGateway(page, {
    ...options,
    presenceUsers: [SIDEBAR_PROOF_USER],
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.locator(".sidebar-identity-card").waitFor();
  return { context, gateway, page, sidebar };
}

export async function setSidebarProofTheme(page: Page, mode: "dark" | "light") {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.classList.toggle("wa-light", nextMode === "light");
    root.classList.toggle("wa-dark", nextMode === "dark");
    root.style.colorScheme = nextMode;
  }, mode);
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
}

export async function captureUnionProof(
  page: Page,
  directory: string,
  fileName: string,
  locators: readonly Locator[],
) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const locator of locators) {
    await locator.waitFor({ state: "visible" });
    await locator.evaluate(async (element) => {
      const running = element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === "running");
      await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
    });
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error(`Cannot capture ${fileName}: a proof surface has no bounding box`);
    }
    boxes.push(box);
  }
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error(`Cannot capture ${fileName}: viewport is unavailable`);
  }
  const margin = 12;
  const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - margin);
  const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - margin);
  const right = Math.min(
    viewport.width,
    Math.max(...boxes.map((box) => box.x + box.width)) + margin,
  );
  const bottom = Math.min(
    viewport.height,
    Math.max(...boxes.map((box) => box.y + box.height)) + margin,
  );
  const artifactDir = path.join(proofArtifactRoot, directory);
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    clip: { x, y, width: right - x, height: bottom - y },
    path: path.join(artifactDir, fileName),
  });
}
