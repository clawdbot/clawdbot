import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildProductionControlUiE2e,
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startProductionControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const artifactDir = path.resolve(".artifacts/control-ui-e2e/service-worker-update");
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const workerUpdateVersionsStorageKey = "openclaw.control-ui-e2e.worker-update-versions";

const buildA = "service-worker-build-a";
const buildB = "service-worker-build-b";

type BuildAsset = {
  path: string;
  sha256: string;
};

let browser: Browser;
let outDir: string;
let server: ControlUiE2eServer;

async function findBuildAsset(buildId: string): Promise<BuildAsset> {
  const assetsDir = path.join(outDir, "assets");
  for (const fileName of await readdir(assetsDir)) {
    if (!fileName.endsWith(".js")) {
      continue;
    }
    const source = await readFile(path.join(assetsDir, fileName));
    if (source.includes(Buffer.from(buildId))) {
      return {
        path: `assets/${fileName}`,
        sha256: createHash("sha256").update(source).digest("hex"),
      };
    }
  }
  throw new Error(`Production Control UI output did not contain build id ${buildId}`);
}

async function ensureControlledPage(page: Page, pageErrors: string[], expectedBuildId: string) {
  const registration = await page.evaluate(async (workerBuildId) => {
    const ready = navigator.serviceWorker.ready.then((value) => ({
      activeState: value.active?.state ?? null,
      controlled: navigator.serviceWorker.controller !== null,
      error: null,
    }));
    const timeout = new Promise<{
      activeState: null;
      controlled: boolean;
      error: string;
    }>((resolve) => {
      window.setTimeout(() => {
        void (async () => {
          const registrations = await navigator.serviceWorker.getRegistrations();
          const response = await fetch(`/sw.js?v=${workerBuildId}`);
          resolve({
            activeState: null,
            controlled: navigator.serviceWorker.controller !== null,
            error: JSON.stringify({
              isSecureContext,
              location: window.location.href,
              registrations: registrations.map((value) => ({
                active: value.active?.state ?? null,
                activeScriptUrl: value.active?.scriptURL ?? null,
                installing: value.installing?.state ?? null,
                scope: value.scope,
                waiting: value.waiting?.state ?? null,
              })),
              serviceWorker: {
                contentType: response.headers.get("content-type"),
                status: response.status,
              },
            }),
          });
        })();
      }, 10_000);
    });
    return Promise.race([ready, timeout]);
  }, expectedBuildId);
  if (registration.error) {
    throw new Error(
      `Service worker did not become ready: ${registration.error}; page errors: ${JSON.stringify(pageErrors)}`,
    );
  }
  await page.waitForFunction(async () => {
    const value = await navigator.serviceWorker.ready;
    return value.active?.state === "activated";
  });
  if (!registration.controlled) {
    await page.reload();
  }
  await page.waitForFunction(() => navigator.serviceWorker?.controller?.state === "activated");
}

async function readWorkerUpdateVersions(page: Page): Promise<string[]> {
  return page.evaluate((storageKey) => {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]") as unknown;
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : [];
  }, workerUpdateVersionsStorageKey);
}

async function fetchControlledAsset(
  page: Page,
  assetPath: string,
): Promise<{ controllerState: string | null; sha256: string }> {
  return page.evaluate(async (relativePath) => {
    const controller = navigator.serviceWorker.controller;
    if (controller && controller.state !== "activated") {
      await new Promise<void>((resolve) => {
        controller.addEventListener(
          "statechange",
          () => {
            if (controller.state === "activated") {
              resolve();
            }
          },
          { once: true },
        );
      });
    }
    const response = await fetch(new URL(relativePath, window.location.href));
    if (!response.ok) {
      throw new Error(`Build asset request failed with HTTP ${response.status}`);
    }
    const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
    return {
      controllerState: controller?.state ?? null,
      sha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  }, assetPath);
}

describe("Control UI service-worker production update E2E", () => {
  beforeAll(async () => {
    if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    outDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-service-worker-update-"));
    server = await startProductionControlUiE2eServer(outDir, buildA);
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (outDir) {
      await rm(outDir, { force: true, recursive: true });
    }
  });

  it("activates the next production worker and serves its refreshed build asset", async () => {
    if (captureUiProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "allow",
      viewport: { height: 720, width: 1280 },
      ...(captureUiProof
        ? { recordVideo: { dir: artifactDir, size: { height: 720, width: 1280 } } }
        : {}),
    });
    // An update keeps the incumbent script URL while installing changed bytes.
    // The worker emits its embedded version only after clients.claim() resolves.
    await context.addInitScript((storageKey) => {
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type !== "sw-updated" || typeof event.data.version !== "string") {
          return;
        }
        const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]") as unknown;
        const versions = Array.isArray(stored)
          ? stored.filter((value): value is string => typeof value === "string")
          : [];
        versions.push(event.data.version);
        sessionStorage.setItem(storageKey, JSON.stringify(versions));
      });
    }, workerUpdateVersionsStorageKey);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(`${error.name}:${error.message}`));

    try {
      expect((await page.goto(`${server.baseUrl}chat`))?.status()).toBe(200);
      await ensureControlledPage(page, pageErrors, buildA);
      await expect.poll(() => readWorkerUpdateVersions(page)).toContain(buildA);

      const assetA = await findBuildAsset(buildA);
      const initialAsset = await fetchControlledAsset(page, assetA.path);
      expect(initialAsset).toEqual({
        controllerState: "activated",
        sha256: assetA.sha256,
      });
      await expect
        .poll(() => page.evaluate(() => caches.keys()))
        .toContain(`openclaw-control-${buildA}`);

      await buildProductionControlUiE2e(outDir, buildB);
      const assetB = await findBuildAsset(buildB);
      expect(assetB.path).not.toBe(assetA.path);
      expect(assetB.sha256).not.toBe(assetA.sha256);

      const reloaded = page.waitForEvent("domcontentloaded");
      await page.evaluate(() => {
        void navigator.serviceWorker.ready.then((registration) => registration.update());
      });
      await reloaded;
      await ensureControlledPage(page, pageErrors, buildB);
      await expect.poll(() => readWorkerUpdateVersions(page)).toContain(buildB);

      await expect
        .poll(() => page.evaluate(() => caches.keys()))
        .toContain(`openclaw-control-${buildB}`);
      const refreshedAsset = await fetchControlledAsset(page, assetB.path);
      expect(refreshedAsset).toEqual({
        controllerState: "activated",
        sha256: assetB.sha256,
      });
      expect(refreshedAsset.sha256).not.toBe(initialAsset.sha256);

      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "updated-worker-controlled-page.png"),
        });
      }
    } finally {
      await context.close();
    }
  }, 120_000);
});
