import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    proofDir = createControlUiE2eArtifactDir("image-lightbox");
  }
});

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
      recordVideo: captureUiProofEnabled
        ? { dir: proofDir, size: { height: 900, width: 1440 } }
        : undefined,
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
      const openOriginal = page.getByRole("link", { name: "Open in new tab" });
      await openOriginal.waitFor({ state: "visible" });
      await expect.poll(() => openOriginal.getAttribute("href")).toMatch(/^blob:/);
      const readControlContrast = () =>
        page.locator("openclaw-image-lightbox").evaluate((lightbox) => {
          const root = lightbox.shadowRoot!;
          return [".open-original", ".close", '[aria-label="Zoom in"]'].map((selector) => {
            const style = getComputedStyle(root.querySelector(selector)!);
            return {
              backdropFilter: style.backdropFilter,
              backgroundColor: style.backgroundColor,
              borderWidth: style.borderWidth,
              color: style.color,
            };
          });
        });
      for (const [theme, backgroundColor] of [
        ["dark", "rgba(255, 255, 255, 0.16)"],
        ["light", "rgba(12, 16, 24, 0.64)"],
      ] as const) {
        await page.evaluate(
          (mode) => document.documentElement.setAttribute("data-theme-mode", mode),
          theme,
        );
        await expect.poll(readControlContrast).toEqual([
          expect.objectContaining({
            backdropFilter: expect.stringContaining("blur(16px)"),
            backgroundColor,
            borderWidth: "0px",
            color: "rgb(255, 255, 255)",
          }),
          expect.objectContaining({
            backdropFilter: expect.stringContaining("blur(16px)"),
            backgroundColor,
            borderWidth: "0px",
            color: "rgb(255, 255, 255)",
          }),
          expect.objectContaining({
            backdropFilter: expect.stringContaining("blur(16px)"),
            backgroundColor,
            borderWidth: "0px",
            color: "rgb(255, 255, 255)",
          }),
        ]);
      }
      await page.evaluate(() => document.documentElement.setAttribute("data-theme-mode", "dark"));
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
      await page
        .locator("openclaw-image-lightbox wa-dialog dialog")
        .evaluate(finishElementAnimations);
      const desktopBox = await page.locator("openclaw-image-lightbox .lightbox").boundingBox();
      const viewport = page.viewportSize();
      expect(desktopBox?.x).toBe(0);
      expect(desktopBox?.y).toBe(0);
      expect(desktopBox?.width).toBe(viewport?.width);
      expect(desktopBox?.height).toBe(viewport?.height);
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

      await openChatSidePanelType(page, "Files");
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
      await page
        .locator("openclaw-image-lightbox wa-dialog dialog")
        .evaluate(finishElementAnimations);
      await page.locator("openclaw-image-lightbox").evaluate((lightbox) => {
        lightbox.style.setProperty("--safe-area-top", "18px");
        lightbox.style.setProperty("--safe-area-right", "12px");
        lightbox.style.setProperty("--safe-area-bottom", "22px");
        lightbox.style.setProperty("--safe-area-left", "12px");
        lightbox.setAttribute(
          "src",
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='1200'%3E%3Crect width='600' height='1200' fill='%2386a5ff'/%3E%3C/svg%3E",
        );
      });
      await expect
        .poll(() =>
          page
            .locator("openclaw-image-lightbox .image")
            .evaluate((image) =>
              image instanceof HTMLImageElement && image.complete ? image.naturalHeight : 0,
            ),
        )
        .toBe(1200);
      const mobileBox = await page.locator("openclaw-image-lightbox .lightbox").boundingBox();
      const mobileImage = page.locator("openclaw-image-lightbox .image");
      const readMobileLayout = () =>
        page.locator("openclaw-image-lightbox .stage").evaluate((stage) => {
          const root = stage.getRootNode();
          const image = stage.querySelector("img");
          const header = root instanceof ShadowRoot ? root.querySelector(".header") : null;
          const controls = root instanceof ShadowRoot ? root.querySelector(".zoom-controls") : null;
          if (!image || !header || !controls) {
            throw new Error("missing lightbox geometry");
          }
          const rect = (element: Element) => {
            const box = element.getBoundingClientRect();
            return { bottom: box.bottom, left: box.left, right: box.right, top: box.top };
          };
          const imageBox = rect(image);
          const stageBox = rect(stage);
          const overlaps = (other: ReturnType<typeof rect>) =>
            Math.min(imageBox.right, other.right) > Math.max(imageBox.left, other.left) &&
            Math.min(imageBox.bottom, other.bottom) > Math.max(imageBox.top, other.top);
          return {
            image: imageBox,
            stage: stageBox,
            overlapsControls: overlaps(rect(controls)),
            overlapsHeader: overlaps(rect(header)),
          };
        });
      const mobileImageLayout = await readMobileLayout();
      const mobileViewport = await page.evaluate(() => ({
        height: window.innerHeight,
        width: window.innerWidth,
      }));
      expect(mobileBox?.width).toBeCloseTo(mobileViewport.width, 0);
      expect(mobileBox?.height).toBeCloseTo(mobileViewport.height, 0);
      expect(mobileImageLayout.image.left).toBeGreaterThanOrEqual(mobileImageLayout.stage.left);
      expect(mobileImageLayout.image.right).toBeLessThanOrEqual(mobileImageLayout.stage.right);
      expect(mobileImageLayout.image.top).toBeGreaterThanOrEqual(mobileImageLayout.stage.top);
      expect(mobileImageLayout.image.bottom).toBeLessThanOrEqual(mobileImageLayout.stage.bottom);
      expect(mobileImageLayout.overlapsHeader).toBe(false);
      expect(mobileImageLayout.overlapsControls).toBe(false);
      await page.setViewportSize({ height: 500, width: 932 });
      const landscapeLayout = await readMobileLayout();
      expect(landscapeLayout.overlapsHeader).toBe(false);
      expect(landscapeLayout.overlapsControls).toBe(false);
      await page.setViewportSize({ height: 844, width: 390 });
      await mobileImage.dblclick();
      await expect
        .poll(() =>
          mobileImage.evaluate((image) =>
            Number(new DOMMatrixReadOnly(getComputedStyle(image).transform).a.toFixed(2)),
          ),
        )
        .toBeGreaterThan(1);
      await page.getByRole("button", { name: "Reset zoom" }).click();
      await expect
        .poll(() =>
          mobileImage.evaluate((image) =>
            Number(new DOMMatrixReadOnly(getComputedStyle(image).transform).a.toFixed(2)),
          ),
        )
        .toBe(1);
      const zoomIn = page.getByRole("button", { name: "Zoom in" });
      await zoomIn.click();
      await expect
        .poll(() =>
          mobileImage.evaluate((image) =>
            Number(new DOMMatrixReadOnly(getComputedStyle(image).transform).a.toFixed(2)),
          ),
        )
        .toBeGreaterThan(1);
      const zoomedImageBox = await mobileImage.boundingBox();
      expect((zoomedImageBox?.x ?? 0) + (zoomedImageBox?.width ?? 0)).toBeGreaterThan(0);
      expect((zoomedImageBox?.y ?? 0) + (zoomedImageBox?.height ?? 0)).toBeGreaterThan(0);
      expect(zoomedImageBox?.x ?? mobileViewport.width).toBeLessThan(mobileViewport.width);
      expect(zoomedImageBox?.y ?? mobileViewport.height).toBeLessThan(mobileViewport.height);
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(proofDir, "03-mobile-lightbox.png"),
        });
      }
      await page.keyboard.press("Escape");
      await expect.poll(() => sidebarDialog.count()).toBe(0);
    } finally {
      await closeContext(context);
    }
  });
});
