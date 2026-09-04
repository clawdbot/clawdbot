import path from "node:path";
import {
  buildControlUiFocusPath,
  type ControlUiFocusBuildTarget,
} from "@openclaw/session-url-contract";
import type { Page, Route, Video } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

let artifactDir: string;
beforeEach(() => {
  if (captureUiProof) {
    artifactDir = createControlUiE2eArtifactDir("lazy-custom-element-recovery");
  }
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const railProofDirParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
let railProofDir: string | undefined;
beforeEach(() => {
  railProofDir = railProofDirParent
    ? createControlUiE2eArtifactDir("lazy-custom-element-recovery", railProofDirParent)
    : undefined;
});
const nativeTitlebarChunk = /\/assets\/macos-titlebar-controls\.runtime-[^/?]+\.js(?:\?.*)?$/u;
const viewport = { height: 900, width: 1280 };
const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";

const suite = createControlUiE2eSuite({
  name: "Control UI lazy custom-element recovery",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

async function installChunkFailure(page: Page, chunk: RegExp, manualProbe?: Promise<void>) {
  let headCount = 0;
  let chunkRequestCount = 0;
  await page.route("**/*", async (route) => {
    if (route.request().method() !== "HEAD") {
      await route.fallback();
      return;
    }
    headCount += 1;
    if (headCount === 1) {
      await route.fulfill({ status: 503 });
      return;
    }
    await manualProbe;
    await route.fallback();
  });
  await page.route(chunk, async (route: Route) => {
    chunkRequestCount += 1;
    if (chunkRequestCount === 1) {
      await route.abort("internetdisconnected");
      return;
    }
    await route.fallback();
  });
  return { chunkRequestCount: () => chunkRequestCount, headCount: () => headCount };
}

function focusPath(target: ControlUiFocusBuildTarget): string {
  const resolvedPath = buildControlUiFocusPath(target, "");
  if (!resolvedPath) {
    throw new Error(`Could not build focus path for ${target.kind}`);
  }
  return resolvedPath;
}

async function expectRealChunkFailure(page: Page, label: string) {
  const error = page.locator(".lazy-view-error");
  await error.waitFor();
  const text = await error.textContent();
  expect(text).toContain(label);
  expect(text).toContain("Failed to fetch dynamically imported module");
  await error.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await error.getByRole("button", { name: "Close", exact: true }).waitFor();
  return error;
}

async function retryThroughReload(page: Page, error: ReturnType<Page["locator"]>): Promise<void> {
  const reloaded = page.waitForEvent("domcontentloaded");
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await reloaded;
}

const focusedCases = [
  {
    name: "terminal",
    label: "terminal panel",
    path: focusPath({ kind: "terminal" }),
    chunk: /\/assets\/terminal-panel-registration-[^/?]+\.js(?:\?.*)?$/u,
    gateway: {
      featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
      methodResponses: {
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "lazy-terminal-e2e",
          shell: "/bin/bash",
        },
      },
      terminalEnabled: true,
    },
    ready: (page: Page) => page.locator("openclaw-terminal-panel .tp-header").waitFor(),
  },
  {
    name: "desktop",
    label: "desktop panel",
    path: focusPath({ kind: "desktop", control: false }),
    chunk: /\/assets\/desktop-panel-[^/?]+\.js(?:\?.*)?$/u,
    gateway: {
      featureMethods: [...defaultControlUiFeatureMethods, "desktop.observe", "environments.list"],
      methodResponses: {
        "environments.list": {
          environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
        },
      },
    },
    ready: (page: Page) => page.getByText("Desktop sources", { exact: true }).waitFor(),
  },
  {
    name: "dashboard",
    label: "dashboard document",
    path: focusPath({ kind: "dashboard", path: "/dashboard/main/12345678" }),
    chunk: /\/assets\/board-document-[^/?]+\.js(?:\?.*)?$/u,
    gateway: {
      sessionKey,
      featureMethods: [...defaultControlUiFeatureMethods, "board.get"],
      methodResponses: {
        "sessions.resolve": {
          ok: true,
          key: sessionKey,
          agentId: "main",
          boardFace: "dashboard",
          displayName: "Lazy dashboard",
        },
        "sessions.describe": {
          session: {
            key: sessionKey,
            kind: "direct",
            boardFace: "dashboard",
            displayName: "Lazy dashboard",
            updatedAt: 1,
          },
        },
        "board.get": { sessionKey, revision: 1, tabs: [], widgets: [] },
      },
    },
    ready: (page: Page) => page.locator("openclaw-board-document openclaw-board-view").waitFor(),
  },
];

suite.define(() => {
  it("recovers the login gate after its chunk fails without loading it during admission", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport },
      async ({ page }) => {
        const failure = await installChunkFailure(
          page,
          /\/assets\/login-gate-[^/?]+\.js(?:\?.*)?$/u,
        );
        const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
        const rejectLogin = async () => {
          await gateway.waitForRequest("connect");
          await gateway.rejectDeferred("connect", {
            code: "INVALID_REQUEST",
            message: "token missing",
            details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
          });
        };
        await page.goto(suite.server.baseUrl);
        await gateway.waitForRequest("connect");
        await page.locator(".connect-splash").waitFor();
        expect(failure.chunkRequestCount()).toBe(0);
        await rejectLogin();
        const error = page.locator(".lazy-view-error");
        await error.waitFor();
        expect(await error.textContent()).toContain("Failed to fetch dynamically imported module");
        expect(failure.chunkRequestCount()).toBe(1);
        await expect.poll(failure.headCount).toBe(1);
        await Promise.all([
          page.waitForEvent("domcontentloaded"),
          error.getByRole("button", { name: "Reload", exact: true }).click(),
        ]);
        await rejectLogin();
        await page.locator('.login-gate__failure[data-kind="auth-required"]').waitFor();
        expect(failure.chunkRequestCount()).toBe(2);
        expect(await error.count()).toBe(0);
        const connectCount = (await gateway.getRequests("connect")).length;
        await gateway.deferNext("connect");
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await gateway.waitForRequest("connect", { after: connectCount });
        await gateway.resolveDeferred("connect");
        await waitForControlUiGatewayReady(page);
        expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      },
    );
  });

  it("does not reload after a lazy surface is dismissed during its retry probe", async () => {
    let releaseProbe = () => {};
    const manualProbe = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    try {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          await page.addInitScript(() => {
            const observed = window as Window & { completedHeadFrames?: number };
            const originalFetch = window.fetch;
            window.fetch = async (...args) => {
              const response = await originalFetch(...args);
              if (args[1]?.method === "HEAD") {
                // Observe the frame after the real fetch and its reload promise chain settle.
                requestAnimationFrame(() => {
                  observed.completedHeadFrames = (observed.completedHeadFrames ?? 0) + 1;
                });
              }
              return response;
            };
          });
          const failure = await installChunkFailure(
            page,
            /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
            manualProbe,
          );
          await installMockGateway(page);
          let documentRequests = 0;
          page.on("request", (request) => {
            if (request.resourceType() === "document") {
              documentRequests += 1;
            }
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await waitForControlUiGatewayReady(page);
          await page.keyboard.press("ControlOrMeta+k");
          const error = await expectRealChunkFailure(page, "command palette");
          await expect.poll(failure.headCount).toBe(1);
          if (captureUiProof) {
            await page.screenshot({ path: path.join(artifactDir, "dismissed-retry-before.png") });
          }

          const reloaded = new Promise<void>((resolve) => {
            page.once("domcontentloaded", () => resolve());
          });
          await error.getByRole("button", { name: "Retry", exact: true }).click();
          await expect.poll(failure.headCount).toBe(2);
          await page.keyboard.press("Escape");
          const paletteModal = page.locator('openclaw-modal-dialog[label="command palette"]');
          await expect.poll(() => paletteModal.count()).toBe(0);
          releaseProbe();
          await expect
            .poll(
              async () =>
                documentRequests > 1 ||
                (await page.evaluate(
                  () =>
                    (window as Window & { completedHeadFrames?: number }).completedHeadFrames ?? 0,
                )) >= 2,
            )
            .toBe(true);
          if (documentRequests > 1) {
            await reloaded;
          }
          await waitForControlUiGatewayReady(page);
          if (captureUiProof) {
            await page.screenshot({ path: path.join(artifactDir, "dismissed-retry-after.png") });
          }
          console.info("LAZY_RETRY_DISMISSED", {
            documentRequests,
            headCount: failure.headCount(),
          });
          expect(documentRequests).toBe(1);
          expect(await paletteModal.count()).toBe(0);
          expect(
            await page.evaluate(() => sessionStorage.getItem("openclaw:lazy-event")),
          ).toBeNull();
        },
      );
    } finally {
      releaseProbe();
    }
  });

  for (const testCase of focusedCases) {
    it(`reloads the focused ${testCase.name} after its real hashed chunk fails`, async () => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          const failure = await installChunkFailure(page, testCase.chunk);
          await installMockGateway(page, testCase.gateway);
          let documentRequests = 0;
          page.on("request", (request) => {
            if (request.resourceType() === "document") {
              documentRequests += 1;
            }
          });

          expect(
            (await page.goto(new URL(testCase.path, suite.server.baseUrl).href))?.status(),
          ).toBe(200);
          const error = await expectRealChunkFailure(page, testCase.label);
          const failedPathname = new URL(page.url()).pathname;
          expect(failure.chunkRequestCount()).toBe(1);
          await expect.poll(failure.headCount).toBe(1);
          expect(documentRequests).toBe(1);

          await retryThroughReload(page, error);
          await testCase.ready(page);

          await expect.poll(failure.chunkRequestCount).toBe(2);
          expect(new URL(page.url()).pathname).toBe(failedPathname);
          expect(documentRequests).toBe(2);
        },
      );
    });
  }

  it("restores the command-palette action after a real stale-chunk reload", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(captureUiProof ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
    });
    let video: Video | null = null;
    try {
      const page = await context.newPage();
      if (captureUiProof) {
        video = page.video();
      }
      const failure = await installChunkFailure(
        page,
        /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
      );
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
      });
      const error = await expectRealChunkFailure(page, "command palette");
      await expect.poll(failure.headCount).toBe(1);
      expect(failure.chunkRequestCount()).toBe(1);
      if (captureUiProof) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "failure.png"),
        });
      }

      await retryThroughReload(page, error);
      await page.getByRole("combobox", { name: "Search chats and commands…" }).waitFor();

      await expect.poll(failure.chunkRequestCount).toBe(2);
      expect(await page.locator("openclaw-command-palette").count()).toBe(1);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "recovered.png"),
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
      if (captureUiProof && video) {
        await video.saveAs(path.join(artifactDir, "recovery.webm"));
      }
    }
  });

  it("keeps native titlebar state and actions current while its chunk is loading", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(railProofDir ? { recordVideo: { dir: railProofDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        await installNativeWebChrome(page);
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const held = await holdModuleResponse(page, nativeTitlebarChunk);
        try {
          const response = await page.goto(suite.server.baseUrl, { waitUntil: "domcontentloaded" });
          expect(response?.status()).toBe(200);
          await page.locator(".sidebar-brand").waitFor({ state: "attached" });
          await held.request;
          const element = page.locator("openclaw-macos-titlebar-controls");
          expect(await element.evaluate((node) => node.matches(":defined"))).toBe(false);
          await page.evaluate(() => {
            window.dispatchEvent(
              new CustomEvent("openclaw:native-history-state", {
                detail: { canGoBack: true, canGoForward: false },
              }),
            );
            window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
          });
          await expect
            .poll(() => page.locator(".shell").getAttribute("class"))
            .toContain("shell--nav-collapsed");
          if (railProofDir) {
            await page.screenshot({ path: path.join(railProofDir, "native-titlebar-loading.png") });
          }

          held.release();
          const toolbar = page.locator(".macos-titlebar-controls");
          await toolbar.waitFor({ state: "visible" });
          await expect
            .poll(() => toolbar.getByRole("button", { name: "Back" }).isDisabled())
            .toBe(false);
          await expect
            .poll(() => toolbar.getByRole("button", { name: "Forward" }).isDisabled())
            .toBe(true);
          await toolbar.getByRole("button", { name: "New session", exact: true }).click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
          await page.locator(".new-session-page__message").waitFor({ state: "visible" });
          expect(held.requests()).toBe(1);
          expect(errors).toEqual([]);
          if (railProofDir) {
            await page.screenshot({ path: path.join(railProofDir, "native-titlebar-loaded.png") });
          }
        } finally {
          held.release();
        }
      },
    );
  });

  it.each([
    {
      name: "native titlebar",
      chunk: nativeTitlebarChunk,
      label: "openclaw-macos-titlebar-controls",
      webChrome: true,
      pathname: "",
      readySelector: ".sidebar-brand",
      preserveCollapsedNavigation: false,
      proofName: "native-titlebar",
    },
    {
      name: "floating sidebar attention",
      chunk: /\/assets\/sidebar-attention-[A-Za-z0-9_-]{8}\.js(?:\?.*)?$/u,
      label: "sidebar-attention",
      webChrome: false,
      pathname: "chat/main?nav=collapsed",
      readySelector: ".shell--nav-collapsed",
      preserveCollapsedNavigation: true,
      proofName: "sidebar-attention",
    },
  ])("recovers $name visibly after its chunk fails", async (testCase) => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(railProofDir ? { recordVideo: { dir: railProofDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        if (testCase.webChrome) {
          await installNativeWebChrome(page);
        }
        const failure = await installChunkFailure(page, testCase.chunk);
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
        });
        const response = await page.goto(`${suite.server.baseUrl}${testCase.pathname}`, {
          waitUntil: "domcontentloaded",
        });
        expect(response?.status()).toBe(200);
        await page.locator(testCase.readySelector).waitFor({ state: "attached" });
        const error = await expectRealChunkFailure(page, testCase.label);
        await expect.poll(failure.headCount).toBe(1);
        expect(failure.chunkRequestCount()).toBe(1);
        if (railProofDir) {
          await page.screenshot({
            path: path.join(railProofDir, `${testCase.proofName}-failed.png`),
          });
        }

        if (testCase.preserveCollapsedNavigation) {
          await page.evaluate(() => {
            const url = new URL(window.location.href);
            url.searchParams.set("nav", "collapsed");
            window.history.replaceState(window.history.state, "", url);
          });
        }
        await retryThroughReload(page, error);
        if (testCase.webChrome) {
          const toolbar = page.locator(".macos-titlebar-controls");
          await toolbar.waitFor({ state: "visible" });
          await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
          await toolbar.getByRole("button", { name: "New session", exact: true }).click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
          await page.locator(".new-session-page__message").waitFor({ state: "visible" });
        } else {
          await page.locator(".sidebar-attention--floating .sidebar-issues-button").click();
          await page.locator("#sidebar-issues-panel").waitFor({ state: "visible" });
        }
        expect(await error.count()).toBe(0);
        expect(failure.chunkRequestCount()).toBe(2);
        if (railProofDir) {
          await page.screenshot({
            path: path.join(railProofDir, `${testCase.proofName}-recovered.png`),
          });
        }
      },
    );
  });
});
