// Control UI tests cover the initial-connect splash shown instead of the
// login gate while a first connect backed by stored credentials is in flight.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
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
const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const viewport = { height: 900, width: 1280 };

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();

async function createPage(): Promise<Page> {
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
  }
  const context = await browser.newContext({
    viewport,
    ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
  });
  openContexts.add(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return page;
}

async function captureProof(page: Page, name: string): Promise<void> {
  if (!artifactDir) {
    return;
  }
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, `${name}.png`) });
}

describeControlUiE2e("Control UI initial connect splash E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}.`,
      );
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    await browser?.close();
    await server?.close();
  });

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
  });

  it("shows the splash instead of the login gate while a configured token connects", async () => {
    const page = await createPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(`${server.baseUrl}#token=e2e-shared-token`);
    await gateway.waitForRequest("connect");
    const splash = page.locator(".connect-splash");
    await splash.waitFor();
    const mascot = splash.locator('openclaw-mascot[mood="thinking"]');
    await mascot.waitFor();
    const mascotBounds = await mascot.boundingBox();
    expect(mascotBounds).not.toBeNull();
    expect(
      Math.abs((mascotBounds?.x ?? 0) + (mascotBounds?.width ?? 0) / 2 - viewport.width / 2),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((mascotBounds?.y ?? 0) + (mascotBounds?.height ?? 0) / 2 - viewport.height / 2),
    ).toBeLessThanOrEqual(1);
    expect(await page.getByText("Loading panel", { exact: true }).count()).toBe(0);
    expect(await page.locator("openclaw-app-sidebar").count()).toBe(0);
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    await captureProof(page, "01-centered-connecting-mascot");

    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();
    expect(await page.locator(".connect-splash").count()).toBe(0);
    await captureProof(page, "02-connected-content");
  });

  it("centers the animated mascot until the chat route finishes loading", async () => {
    const page = await createPage();
    let chatModuleRequested = false;
    let releaseChatModule!: () => void;
    const chatModuleReady = new Promise<void>((resolve) => {
      releaseChatModule = resolve;
    });
    await page.route(`${new URL(server.baseUrl).origin}/**`, async (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/chat-page.ts")) {
        chatModuleRequested = true;
        await chatModuleReady;
      }
      await route.continue();
    });
    await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat?session=main`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("openclaw-app-shell").waitFor();
      await expect.poll(() => chatModuleRequested).toBe(true);

      const loadingState = page.locator(".lazy-view-state--loading");
      await loadingState.waitFor();
      expect(await loadingState.getAttribute("role")).toBe("status");
      expect(await loadingState.getAttribute("aria-label")).toBe("Loading…");
      expect((await loadingState.textContent())?.trim()).toBe("");
      expect(await page.getByText("Loading panel", { exact: true }).count()).toBe(0);

      const mascot = loadingState.locator('openclaw-mascot[mood="thinking"]');
      await mascot.waitFor();
      const [loadingBounds, mascotBounds] = await Promise.all([
        loadingState.boundingBox(),
        mascot.boundingBox(),
      ]);
      expect(loadingBounds).not.toBeNull();
      expect(mascotBounds).not.toBeNull();
      expect(
        Math.abs(
          (mascotBounds?.x ?? 0) +
            (mascotBounds?.width ?? 0) / 2 -
            ((loadingBounds?.x ?? 0) + (loadingBounds?.width ?? 0) / 2),
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          (mascotBounds?.y ?? 0) +
            (mascotBounds?.height ?? 0) / 2 -
            ((loadingBounds?.y ?? 0) + (loadingBounds?.height ?? 0) / 2),
        ),
      ).toBeLessThanOrEqual(1);
      await captureProof(page, "03-centered-pending-chat-mascot");

      releaseChatModule();
      await page.locator("openclaw-chat-page").waitFor();
      expect(await loadingState.count()).toBe(0);
      await captureProof(page, "04-loaded-chat-content");
    } finally {
      releaseChatModule();
    }
  });

  it("keeps the login gate for first connects without stored credentials", async () => {
    const page = await createPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(server.baseUrl);
    await gateway.waitForRequest("connect");
    await page.locator("openclaw-login-gate").waitFor();
    expect(await page.locator(".connect-splash").count()).toBe(0);
  });

  it("falls back to the login gate when stored credentials are rejected", async () => {
    const page = await createPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(`${server.baseUrl}#token=stale-token`);
    await gateway.waitForRequest("connect");
    await page.locator(".connect-splash").waitFor();

    await gateway.rejectDeferred("connect", {
      code: "UNAUTHORIZED",
      message: "unauthorized: gateway token mismatch",
      details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH },
    });
    await page.locator("openclaw-login-gate").waitFor();
    expect(await page.locator(".connect-splash").count()).toBe(0);
  });

  it("uses the splash for a stored device token on reload", async () => {
    const page = await createPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    // First visit has no credentials: the login gate owns the pending connect.
    await page.goto(server.baseUrl);
    await gateway.waitForRequest("connect");
    await page.locator("openclaw-login-gate").waitFor();
    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();

    // The hello stored a device token, so the reload connect is authenticated
    // and must paint the splash instead of flashing the gate.
    await page.reload();
    await gateway.waitForRequest("connect");
    await page.locator(".connect-splash").waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);

    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();
  });
});
