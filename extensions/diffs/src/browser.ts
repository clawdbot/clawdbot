import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { chromium } from "playwright-core";
import type { OpenClawConfig } from "../api.js";
import type { DiffRenderOptions, DiffTheme } from "./types.js";
import { VIEWER_ASSET_PREFIX, getServedViewerAsset } from "./viewer-assets.js";

const DEFAULT_BROWSER_IDLE_MS = 30_000;
const SHARED_BROWSER_KEY = "__default__";
const IMAGE_SIZE_LIMIT_ERROR = "Diff frame did not render within image size limits.";
const PDF_REFERENCE_PAGE_HEIGHT_PX = 1_056;
const MAX_PDF_PAGES = 50;
const LOCAL_VIEWER_BASE_HREF = "http://127.0.0.1/plugins/diffs/view/local/local";

export type DiffScreenshotter = {
  screenshotHtml(params: {
    html: string;
    outputPath: string;
    theme: DiffTheme;
    image: DiffRenderOptions["image"];
  }): Promise<string>;
};

type BrowserInstance = Awaited<ReturnType<typeof chromium.launch>>;

type BrowserLease = {
  browser: BrowserInstance;
  release(): Promise<void>;
};

type SharedBrowserState = {
  browser?: BrowserInstance;
  browserPromise: Promise<BrowserInstance>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  key: string;
  users: number;
};

type ExecutablePathCache = {
  key: string;
  valuePromise: Promise<string | undefined>;
};

let sharedBrowserState: SharedBrowserState | null = null;
let executablePathCache: ExecutablePathCache | null = null;

export class PlaywrightDiffScreenshotter implements DiffScreenshotter {
  private readonly config: OpenClawConfig;
  private readonly browserIdleMs: number;

  constructor(params: { config: OpenClawConfig; browserIdleMs?: number }) {
    this.config = params.config;
    this.browserIdleMs = params.browserIdleMs ?? DEFAULT_BROWSER_IDLE_MS;
  }

  async screenshotHtml(params: {
    html: string;
    outputPath: string;
    theme: DiffTheme;
    image: DiffRenderOptions["image"];
  }): Promise<string> {
    const lease = await acquireSharedBrowser({
      config: this.config,
      idleMs: this.browserIdleMs,
    });
    let page: Awaited<ReturnType<BrowserInstance["newPage"]>> | undefined;
    let currentScale = params.image.scale;
    const maxRetries = 2;

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        page = await lease.browser.newPage({
          viewport: {
            width: Math.max(Math.ceil(params.image.maxWidth + 240), 1200),
            height: 900,
          },
          deviceScaleFactor: currentScale,
          colorScheme: params.theme,
        });
        await page.route("**/*", async (route) => {
          const requestUrl = route.request().url();
          if (requestUrl === "about:blank" || requestUrl.startsWith("data:")) {
            await route.continue();
            return;
          }
          let parsed: URL;
          try {
            parsed = new URL(requestUrl);
          } catch {
            await route.abort();
            return;
          }
          if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
            await route.abort();
            return;
          }
          if (!parsed.pathname.startsWith(VIEWER_ASSET_PREFIX)) {
            await route.abort();
            return;
          }
          const pathname = parsed.pathname;
          const asset = await getServedViewerAsset(pathname);
          if (!asset) {
            await route.abort();
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: asset.contentType,
            body: asset.body,
          });
        });
        await page.setContent(injectBaseHref(params.html), { waitUntil: "load" });
        await page.waitForFunction(
          () => {
            if (document.documentElement.dataset.openclawDiffsReady === "true") {
              return true;
            }
            return [...document.querySelectorAll("[data-openclaw-diff-host]")].every((element) => {
              return (
                element instanceof HTMLElement && element.shadowRoot?.querySelector("[data-diffs]")
              );
            });
          },
          {
            timeout: 10_000,
          },
        );
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await page.evaluate(() => {
          const frame = document.querySelector(".oc-frame");
          if (frame instanceof HTMLElement) {
            frame.dataset.renderMode = "image";
          }
        });

        const frame = page.locator(".oc-frame");
        await frame.waitFor();
        const initialBox = await frame.boundingBox();
        if (!initialBox) {
          throw new Error("Diff frame did not render.");
        }

        const isPdf = params.image.format === "pdf";
        const padding = isPdf ? 0 : 20;
        const clipWidth = Math.ceil(initialBox.width + padding * 2);
        const clipHeight = Math.ceil(Math.max(initialBox.height + padding * 2, 320));
        await page.setViewportSize({
          width: Math.max(clipWidth + padding, 900),
          height: Math.max(clipHeight + padding, 700),
        });

        const box = await frame.boundingBox();
        if (!box) {
          throw new Error("Diff frame was lost after resizing.");
        }

        if (isPdf) {
          await page.emulateMedia({ media: "screen" });
          await page.evaluate(() => {
            const html = document.documentElement;
            const body = document.body;
            const frame = document.querySelector(".oc-frame");

            html.style.background = "transparent";
            body.style.margin = "0";
            body.style.padding = "0";
            body.style.background = "transparent";
            body.style.setProperty("-webkit-print-color-adjust", "exact");
            if (frame instanceof HTMLElement) {
              frame.style.margin = "0";
            }
          });

          const pdfBox = await frame.boundingBox();
          if (!pdfBox) {
            throw new Error("Diff frame was lost before PDF render.");
          }
          const pdfWidth = Math.max(Math.ceil(pdfBox.width), 1);
          const pdfHeight = Math.max(Math.ceil(pdfBox.height), 1);
          const estimatedPixels = pdfWidth * pdfHeight;
          const estimatedPages = Math.ceil(pdfHeight / PDF_REFERENCE_PAGE_HEIGHT_PX);
          if (estimatedPixels > params.image.maxPixels || estimatedPages > MAX_PDF_PAGES) {
            throw new Error(IMAGE_SIZE_LIMIT_ERROR);
          }

          const pageForPdf = page;
          await writeExternalArtifactFile({
            outputPath: params.outputPath,
            write: async (tempPath) => {
              await pageForPdf.pdf({
                path: tempPath,
                width: `${pdfWidth}px`,
                height: `${pdfHeight}px`,
                printBackground: true,
                margin: {
                  top: "0",
                  right: "0",
                  bottom: "0",
                  left: "0",
                },
              });
            },
          });
          return params.outputPath;
        }

        const dpr = await page.evaluate(() => window.devicePixelRatio || 1);

        // Raw clip in CSS px
        const rawX = Math.max(box.x - padding, 0);
        const rawY = Math.max(box.y - padding, 0);
        const rawRight = rawX + clipWidth;
        const rawBottom = rawY + clipHeight;

        // Snap to device-pixel grid to avoid soft text from sub-pixel crop
        const x = Math.floor(rawX * dpr) / dpr;
        const y = Math.floor(rawY * dpr) / dpr;
        const right = Math.ceil(rawRight * dpr) / dpr;
        const bottom = Math.ceil(rawBottom * dpr) / dpr;
        const cssWidth = Math.max(right - x, 1);
        const cssHeight = Math.max(bottom - y, 1);
        const estimatedPixels = cssWidth * cssHeight * dpr * dpr;

        if (estimatedPixels > params.image.maxPixels) {
          if (currentScale > 1) {
            const maxScaleForPixels = Math.sqrt(params.image.maxPixels / (cssWidth * cssHeight));
            const reducedScale = Math.max(
              1,
              Math.round(Math.min(currentScale, maxScaleForPixels) * 100) / 100,
            );
            if (reducedScale < currentScale - 0.01 && attempt < maxRetries) {
              await page.close().catch(() => {});
              page = undefined;
              currentScale = reducedScale;
              continue;
            }
          }
          throw new Error(IMAGE_SIZE_LIMIT_ERROR);
        }

        const pageForScreenshot = page;
        await writeExternalArtifactFile({
          outputPath: params.outputPath,
          write: async (tempPath) => {
            await pageForScreenshot.screenshot({
              path: tempPath,
              type: "png",
              scale: "device",
              clip: {
                x,
                y,
                width: cssWidth,
                height: cssHeight,
              },
            });
          },
        });
        return params.outputPath;
      }
      throw new Error(IMAGE_SIZE_LIMIT_ERROR);
    } catch (error) {
      if (error instanceof Error && error.message === IMAGE_SIZE_LIMIT_ERROR) {
        throw error;
      }
      const reason = formatErrorMessage(error);
      throw new Error(
        `Diff PNG/PDF rendering requires a Chromium-compatible browser. Set browser.executablePath or install Chrome/Chromium. ${reason}`,
        { cause: error },
      );
    } finally {
      await page?.close().catch(() => {});
      await lease.release();
    }
  }
}

async function writeExternalArtifactFile(params: {
  outputPath: string;
  write: (tempPath: string) => Promise<void>;
}): Promise<void> {
  const rootDir = path.dirname(params.outputPath);
  await fs.mkdir(rootDir, { recursive: true });
  await writeExternalFileWithinRoot({
    rootDir,
    path: path.basename(params.outputPath),
    write: params.write,
  });
}

export async function resetSharedBrowserStateForTests(): Promise<void> {
  executablePathCache = null;
  await closeSharedBrowser();
}

function injectBaseHref(html: string): string {
  if (html.includes("<base ")) {
    return html;
  }
  return html.replace("<head>", `<head><base href="${LOCAL_VIEWER_BASE_HREF}" />`);
}

async function resolveBrowserExecutablePath(config: OpenClawConfig): Promise<string | undefined> {
  const cacheKey = JSON.stringify({
    configPath: config.browser?.executablePath?.trim() || "",
    env: [
      process.env.OPENCLAW_BROWSER_EXECUTABLE_PATH ?? "",
      process.env.BROWSER_EXECUTABLE_PATH ?? "",
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "",
    ],
    path: process.env.PATH ?? "",
  });

  if (executablePathCache?.key === cacheKey) {
    return await executablePathCache.valuePromise;
  }

  const valuePromise = resolveBrowserExecutablePathUncached(config).catch((error) => {
    if (executablePathCache?.valuePromise === valuePromise) {
      executablePathCache = null;
    }
    throw error;
  });
  executablePathCache = {
    key: cacheKey,
    valuePromise,
  };
  return await valuePromise;
}

async function resolveBrowserExecutablePathUncached(
  config: OpenClawConfig,
): Promise<string | undefined> {
  const configPath = config.browser?.executablePath?.trim();
  if (configPath) {
    await assertExecutable(configPath, "browser.executablePath");
    return configPath;
  }

  const envCandidates = [
    process.env.OPENCLAW_BROWSER_EXECUTABLE_PATH,
    process.env.BROWSER_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of envCandidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  for (const candidate of await collectExecutableCandidates()) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function acquireSharedBrowser(params: {
  config: OpenClawConfig;
  idleMs: number;
}): Promise<BrowserLease> {
  const executablePath = await resolveBrowserExecutablePath(params.config);
  const desiredKey = executablePath || SHARED_BROWSER_KEY;
  if (sharedBrowserState && sharedBrowserState.key !== desiredKey) {
    await closeSharedBrowser();
  }

  if (!sharedBrowserState) {
    const browserPromise = chromium
      .launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: ["--disable-dev-shm-usage"],
      })
      .then((browser) => {
        if (sharedBrowserState?.browserPromise === browserPromise) {
          sharedBrowserState.browser = browser;
          browser.on("disconnected", () => {
            if (sharedBrowserState?.browser === browser) {
              clearIdleTimer(sharedBrowserState);
              sharedBrowserState = null;
            }
          });
        }
        return browser;
      })
      .catch((error) => {
        if (sharedBrowserState?.browserPromise === browserPromise) {
          sharedBrowserState = null;
        }
        throw error;
      });

    sharedBrowserState = {
      browserPromise,
      idleTimer: null,
      key: desiredKey,
      users: 0,
    };
  }

  clearIdleTimer(sharedBrowserState);
  const state = sharedBrowserState;
  const browser = await state.browserPromise;
  state.users += 1;

  let released = false;
  return {
    browser,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      state.users = Math.max(0, state.users - 1);
      if (state.users === 0) {
        scheduleIdleBrowserClose(state, params.idleMs);
      }
    },
  };
}

function scheduleIdleBrowserClose(state: SharedBrowserState, idleMs: number): void {
  clearIdleTimer(state);
  state.idleTimer = setTimeout(() => {
    if (sharedBrowserState === state && state.users === 0) {
      void closeSharedBrowser();
    }
  }, idleMs);
}

function clearIdleTimer(state: SharedBrowserState): void {
  if (!state.idleTimer) {
    return;
  }
  clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

async function closeSharedBrowser(): Promise<void> {
  const state = sharedBrowserState;
  if (!state) {
    return;
  }
  sharedBrowserState = null;
  clearIdleTimer(state);
  const browser = state.browser ?? (await state.browserPromise.catch(() => null));
  await browser?.close().catch(() => {});
}

async function collectExecutableCandidates(): Promise<string[]> {
  const candidates = new Set<string>();

  for (const command of pathCommandsForPlatform()) {
    const resolved = await findExecutableInPath(command);
    if (resolved) {
      candidates.add(resolved);
    }
  }

  for (const candidate of commonExecutablePathsForPlatform()) {
    candidates.add(candidate);
  }

  return [...candidates];
}

function pathCommandsForPlatform(): string[] {
  if (process.platform === "win32") {
    return ["chrome.exe", "msedge.exe", "brave.exe"];
  }
  if (process.platform === "darwin") {
    return ["google-chrome", "chromium", "msedge", "brave-browser", "brave"];
  }
  return [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "msedge",
    "brave-browser",
    "brave",
  ];
}

function commonExecutablePathsForPlatform(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ];
  }

  return [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/msedge",
    "/usr/bin/brave-browser",
    "/snap/bin/chromium",
  ];
}

async function findExecutableInPath(command: string): Promise<string | undefined> {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return undefined;
  }

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, command);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function assertExecutable(candidate: string, label: string): Promise<void> {
  if (!(await isExecutable(candidate))) {
    throw new Error(`${label} not found or not executable: ${candidate}`);
  }
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
