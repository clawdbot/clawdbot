import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildProductionControlUiE2e,
  canRunPlaywrightChromium,
  captureControlUiE2eFailureDiagnostics,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
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

type InstallGate = {
  url: string;
  requested: Promise<void>;
  release: () => void;
  close: () => Promise<void>;
};

let browser: Browser;
let outDir: string;
let server: ControlUiE2eServer;

async function findBuildAsset(buildId: string, buildDir = outDir): Promise<BuildAsset> {
  const assetsDir = path.join(buildDir, "assets");
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

async function createInstallGate(): Promise<InstallGate> {
  let releaseResponse = () => {};
  let resolveRequested = () => {};
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });
  const gateServer = createHttpServer((_request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    releaseResponse = () => {
      if (!response.writableEnded) {
        response.statusCode = 204;
        response.end();
      }
    };
    resolveRequested();
  });
  await new Promise<void>((resolve, reject) => {
    gateServer.once("error", reject);
    gateServer.listen(0, "127.0.0.1", () => {
      gateServer.off("error", reject);
      resolve();
    });
  });
  const address = gateServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Install gate did not expose a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/release-install`,
    requested,
    release: () => releaseResponse(),
    close: async () => {
      releaseResponse();
      await new Promise<void>((resolve, reject) => {
        gateServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function holdReplacementWorkerInstalling(buildDir: string, gateUrl: string): Promise<void> {
  const workerPath = path.join(buildDir, "sw.js");
  const source = await readFile(workerPath, "utf8");
  const install =
    "event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));";
  if (!source.includes(install)) {
    throw new Error("Production service worker did not contain the expected install lifetime");
  }
  await writeFile(
    workerPath,
    source.replace(
      install,
      `event.waitUntil(Promise.all([fetch(${JSON.stringify(gateUrl)}), caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))]));`,
    ),
  );
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
    // Reload once so the freshly activated worker controls the page. The
    // reload may land on a router deep link like /chat/research; the preview
    // server mirrors the Gateway's depth-insensitive /assets/ resolution, so
    // that boots correctly. (A racy replaceState("/") used to canonicalize
    // the URL here and could interleave with the router's own redirect.)
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
    const response = await fetch(new URL(`/${relativePath}`, window.location.origin));
    if (!response.ok) {
      throw new Error(`Build asset request failed with HTTP ${response.status}`);
    }
    const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
    await new Promise<void>((resolve) => {
      let observedController: ServiceWorker | null = null;
      const observeController = () => {
        const controller = navigator.serviceWorker.controller;
        if (controller !== observedController) {
          observedController?.removeEventListener("statechange", observeController);
          observedController = controller;
          observedController?.addEventListener("statechange", observeController);
        }
        if (controller?.state !== "activated") {
          return;
        }
        observedController?.removeEventListener("statechange", observeController);
        navigator.serviceWorker.removeEventListener("controllerchange", observeController);
        resolve();
      };
      navigator.serviceWorker.addEventListener("controllerchange", observeController);
      observeController();
    });
    return {
      controllerState: navigator.serviceWorker.controller?.state ?? null,
      sha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  }, assetPath);
}

describe("Control UI service-worker production update E2E", () => {
  it("boots a document loaded on a deep link (Gateway asset-path contract)", async () => {
    // The built index.html references ./assets/* relatively, so a document at
    // /chat/research requests /chat/assets/*. The Gateway resolves /assets/
    // at any depth (src/gateway/control-ui.ts); the preview server must honor
    // the same contract or reloads on deep links serve HTML as the module and
    // the app silently never boots.
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(`${error.name}:${error.message}`));
    await installMockGateway(page, {
      assistantAgentId: "research",
      defaultAgentId: "research",
      serverBuildId: buildA,
    });
    try {
      expect((await page.goto(`${server.baseUrl}chat/research`))?.status()).toBe(200);
      await page.waitForFunction(() => Boolean(customElements.get("openclaw-app")), undefined, {
        timeout: controlUiE2eWaitTimeoutMs,
      });
    } catch (error) {
      if (error instanceof Error) {
        await captureControlUiE2eFailureDiagnostics(page, {
          error,
          label: "deep-link-boot",
          pageErrors,
        });
      }
      throw error;
    } finally {
      await context.close();
    }
  }, 60_000);

  beforeAll(async () => {
    if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    outDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-service-worker-update-"));
    server = await startProductionControlUiE2eServer(outDir, buildA, {
      assistantAgentId: "research",
      assistantAvatar: "",
      assistantName: "OpenClaw",
      basePath: "/",
      terminalEnabled: true,
    });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (outDir) {
      await Promise.all(
        [outDir, `${outDir}-next`, `${outDir}-previous`].map((dir) =>
          rm(dir, { force: true, recursive: true }),
        ),
      );
    }
  });

  it("refreshes a same-version build on reconnect before restoring an owned terminal", async () => {
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
    const gateway = await installMockGateway(page, {
      assistantAgentId: "research",
      defaultAgentId: "research",
      serverBuildId: buildA,
      serverVersion: "2026.7.10",
      featureMethods: ["terminal.open"],
      methodResponses: {
        "terminal.open": {
          agentId: "research",
          confined: false,
          cwd: "/workspace/research",
          sessionId: "terminal-after-worker-refresh",
          shell: "/bin/bash",
        },
      },
      terminalEnabled: true,
    });
    let installGate: InstallGate | null = null;

    try {
      expect((await page.goto(`${server.baseUrl}chat`))?.status()).toBe(200);
      await ensureControlledPage(page, pageErrors, buildA);
      await expect.poll(() => readWorkerUpdateVersions(page)).toContain(buildA);
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const panel = document.querySelector("openclaw-terminal-panel") as
                | (HTMLElement & { available: boolean })
                | null;
              const shell = document.querySelector("openclaw-app-shell") as HTMLElement & {
                runtime?: {
                  context?: {
                    config: { current: { terminalEnabled: boolean } };
                    gateway: { snapshot: { phase: string; hello: unknown } };
                  };
                };
              };
              return {
                available: panel?.available ?? null,
                phase: shell?.runtime?.context?.gateway.snapshot.phase ?? null,
                terminalEnabled: shell?.runtime?.context?.config.current.terminalEnabled ?? null,
                hasHello: shell?.runtime?.context?.gateway.snapshot.hello != null,
              };
            }),
          { timeout: controlUiE2eWaitTimeoutMs },
        )
        .toMatchObject({
          available: true,
          phase: "connected",
          terminalEnabled: true,
          hasHello: true,
        });

      const assetA = await findBuildAsset(buildA);
      const initialAsset = await fetchControlledAsset(page, assetA.path);
      expect(initialAsset).toEqual({
        controllerState: "activated",
        sha256: assetA.sha256,
      });
      await expect
        .poll(() => page.evaluate(() => caches.keys()))
        .toContain(`openclaw-control-${buildA}`);

      const nextOutDir = `${outDir}-next`;
      const previousOutDir = `${outDir}-previous`;
      installGate = await createInstallGate();
      await buildProductionControlUiE2e(nextOutDir, buildB);
      await holdReplacementWorkerInstalling(nextOutDir, installGate.url);
      const assetB = await findBuildAsset(buildB, nextOutDir);
      expect(assetB.path).not.toBe(assetA.path);
      expect(assetB.sha256).not.toBe(assetA.sha256);

      await page.evaluate(() => {
        localStorage.setItem(
          "openclaw.terminal.panel.v1",
          JSON.stringify({ open: true, dock: "bottom", height: 320, width: 520 }),
        );
      });
      await gateway.setOnline(false);
      await page.waitForFunction(() => {
        const panel = document.querySelector("openclaw-terminal-panel") as
          | (HTMLElement & { available: boolean })
          | null;
        return panel?.available === false;
      });
      await rename(outDir, previousOutDir);
      await rename(nextOutDir, outDir);
      await rm(previousOutDir, { force: true, recursive: true });
      // The production preview serves static files directly instead of applying
      // the Gateway's deep-link canonicalization before returning index.html.
      await page.evaluate(() => window.history.replaceState(window.history.state, "", "/"));
      const reloaded = page.waitForEvent("domcontentloaded");
      await gateway.setOnline(true);
      await installGate.requested;
      await page.waitForFunction(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.installing?.state === "installing";
      });
      await page.waitForFunction(() => {
        const panel = document.querySelector("openclaw-terminal-panel") as
          | (HTMLElement & { available: boolean; terminalPanelOpen: boolean })
          | null;
        return panel?.available === true && panel.terminalPanelOpen;
      });
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("openclaw:terminal-toggle", {
            detail: {
              open: true,
              catalog: {
                catalogId: "codex",
                hostId: "gateway:local",
                threadId: "thread-during-worker-refresh",
              },
            },
          }),
        );
      });
      await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem("openclaw.terminal.actions.v1")))
        .toContain("thread-during-worker-refresh");
      await page.waitForTimeout(300);
      expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
      await gateway.setServerBuildId(buildB);
      installGate.release();
      await reloaded;
      await ensureControlledPage(page, pageErrors, buildB);
      await expect.poll(() => readWorkerUpdateVersions(page)).toContain(buildB);

      const terminal = page.locator("openclaw-terminal-panel[embedded]");
      await terminal.waitFor({ state: "attached" });
      await expect
        .poll(() =>
          terminal.evaluate((element) => {
            const panel = element as HTMLElement & {
              agentId: string | null;
              available: boolean;
              terminalPanelOpen: boolean;
            };
            return {
              agentId: panel.agentId,
              available: panel.available,
              open: panel.terminalPanelOpen,
            };
          }),
        )
        .toEqual({ agentId: "research", available: true, open: true });
      const terminalOpen = await gateway.waitForRequest("terminal.open");
      expect(terminalOpen.params).toMatchObject({
        agentId: "research",
        cols: expect.any(Number),
        rows: expect.any(Number),
        catalog: {
          catalogId: "codex",
          hostId: "gateway:local",
          threadId: "thread-during-worker-refresh",
        },
      });
      expect(await gateway.getRequests("terminal.open")).toHaveLength(1);

      await expect
        .poll(() => page.evaluate(() => caches.keys()))
        .toContain(`openclaw-control-${buildB}`);
      const refreshedAsset = await fetchControlledAsset(page, assetB.path);
      expect(refreshedAsset).toMatchObject({
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
    } catch (error) {
      // Boot/readiness stalls otherwise fail as all-null poll snapshots with
      // no CI evidence; capture page state before the context closes.
      if (error instanceof Error) {
        await captureControlUiE2eFailureDiagnostics(page, {
          error,
          label: "service-worker-update-reconnect",
          pageErrors,
        });
      }
      throw error;
    } finally {
      await installGate?.close();
      await context.close();
    }
  }, 120_000);
});
