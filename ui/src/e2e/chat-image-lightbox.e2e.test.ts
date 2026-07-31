import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "image-lightbox");

let server: ControlUiE2eServer;
let browser: Browser;
const openContexts = new Set<BrowserContext>();

async function newContext(options: Parameters<Browser["newContext"]>[0]) {
  const context = await browser.newContext(options);
  openContexts.add(context);
  return context;
}

async function closeContext(context: BrowserContext) {
  openContexts.delete(context);
  await context.close().catch(() => {});
}

describeControlUiE2e("Control UI image lightbox", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    server = await startControlUiE2eServer();
  });

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => closeContext(context)));
  });

  afterAll(async () => {
    await Promise.all([...openContexts].map((context) => closeContext(context)));
    await browser?.close();
    await server?.close();
  });

  it("opens transcript and sidebar images in one accessible modal", async () => {
    const banner = await readFile(path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"));
    const bannerBase64 = banner.toString("base64");
    const dataUrl = `data:image/png;base64,${bannerBase64}`;
    const context = await newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "image",
              url: dataUrl,
              alt: "OpenClaw banner",
            },
          ],
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "artifacts.list": {
          artifacts: [
            {
              download: { mode: "bytes" },
              id: "artifact-image-lightbox",
              mimeType: "image/png",
              sizeBytes: banner.byteLength,
              title: "openclaw-banner.png",
              type: "image",
            },
          ],
        },
        "artifacts.download": {
          artifact: {
            id: "artifact-image-lightbox",
            mimeType: "image/png",
            sizeBytes: banner.byteLength,
            title: "openclaw-banner.png",
            type: "image",
          },
          data: bannerBase64,
          encoding: "base64",
        },
        "sessions.files.list": {
          browser: { entries: [], path: "" },
          files: [],
          root: "/workspace",
          sessionKey: "main",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const transcriptTrigger = page.getByRole("button", { name: "Open image OpenClaw banner" });
      await transcriptTrigger.waitFor({ state: "visible", timeout: 10_000 });
      await transcriptTrigger.click();

      const dialog = page.getByRole("dialog", { name: "Image preview: OpenClaw banner" });
      await dialog.waitFor({ state: "visible" });
      const closeButton = page.getByRole("button", { name: "Close image preview" });
      const openOriginal = page.getByRole("link", { name: "Open original" });
      await openOriginal.waitFor({ state: "visible" });
      await expect.poll(() => openOriginal.getAttribute("href")).toMatch(/^blob:/);
      const focusIsInsideLightbox = () =>
        page.locator("openclaw-image-lightbox").evaluate((lightbox) => {
          let active: Element | null = document.activeElement;
          while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
            active = active.shadowRoot.activeElement;
          }
          let node: Node | null = active;
          while (node) {
            if (node === lightbox) {
              return true;
            }
            const root = node.getRootNode();
            node = root instanceof ShadowRoot ? root.host : node.parentNode;
          }
          return false;
        });
      await expect
        .poll(() => closeButton.evaluate((element) => element.matches(":focus")))
        .toBe(true);
      const displayedImage = page.getByAltText("OpenClaw banner").last();
      await expect
        .poll(() =>
          displayedImage.evaluate((image) =>
            image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
          ),
        )
        .toBeGreaterThan(0);
      const desktopBox = await page.locator("openclaw-image-lightbox .lightbox").boundingBox();
      expect(desktopBox?.width ?? 0).toBeGreaterThan(1000);
      expect(desktopBox?.height ?? 0).toBeGreaterThan(700);
      const originalPopup = page.waitForEvent("popup");
      await openOriginal.click();
      const originalPage = await originalPopup;
      await expect.poll(() => originalPage.url()).toMatch(/^blob:/);
      await originalPage.close();
      await closeButton.focus();
      await page.keyboard.press("Tab");
      await expect.poll(focusIsInsideLightbox).toBe(true);
      await page.keyboard.press("Shift+Tab");
      await expect.poll(focusIsInsideLightbox).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count()).toBe(0);
      await expect
        .poll(() => transcriptTrigger.evaluate((element) => element.matches(":focus")))
        .toBe(true);

      await page.locator(".chat-workspace-toggle").click();
      const artifactRow = page.locator(".chat-workspace-rail__file-open", {
        hasText: "openclaw-banner.png",
      });
      await artifactRow.waitFor({ state: "visible", timeout: 10_000 });
      await artifactRow.click();
      const sidebarTrigger = page.getByRole("button", {
        name: "Open image openclaw-banner.png",
      });
      await sidebarTrigger.waitFor({ state: "visible", timeout: 10_000 });

      if (captureUiProofEnabled) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({
          fullPage: true,
          path: path.join(proofDir, "01-sidebar-image.png"),
        });
      }

      await sidebarTrigger.click();
      const sidebarDialog = page.getByRole("dialog", {
        name: "Image preview: openclaw-banner.png",
      });
      await sidebarDialog.waitFor({ state: "visible" });
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(proofDir, "02-sidebar-lightbox.png"),
        });
      }
      await page.getByRole("button", { name: "Close image preview" }).click();
      await expect.poll(() => sidebarDialog.count()).toBe(0);
      await expect
        .poll(() => sidebarTrigger.evaluate((element) => element.matches(":focus")))
        .toBe(true);

      await page.setViewportSize({ height: 844, width: 390 });
      await sidebarTrigger.click();
      await sidebarDialog.waitFor({ state: "visible" });
      const mobileBox = await page.locator("openclaw-image-lightbox .lightbox").boundingBox();
      const mobileViewport = await page.evaluate(() => ({
        height: window.innerHeight,
        width: window.innerWidth,
      }));
      expect((mobileBox?.width ?? 0) / mobileViewport.width).toBeGreaterThanOrEqual(0.75);
      expect((mobileBox?.height ?? 0) / mobileViewport.height).toBeGreaterThanOrEqual(0.65);
      await page.keyboard.press("Escape");
      await expect.poll(() => sidebarDialog.count()).toBe(0);
    } finally {
      await closeContext(context);
    }
  });
});
