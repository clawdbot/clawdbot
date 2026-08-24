// Control UI tests cover the initial-connect splash shown instead of the
// login gate while the Gateway resolves its first connection attempt.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  canRunPlaywrightChromium,
  controlUiE2eWaitTimeoutMs,
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
  page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
  return page;
}

async function captureProof(page: Page, name: string): Promise<void> {
  if (!artifactDir) {
    return;
  }
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, `${name}.png`) });
}

async function traceLoginGateMounts(page: Page): Promise<() => Promise<boolean>> {
  await page.addInitScript(() => {
    const trace = { mounted: false };
    (
      window as Window & {
        openclawLoginGateMountTrace?: typeof trace;
      }
    ).openclawLoginGateMountTrace = trace;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.localName === "openclaw-login-gate" || node.querySelector("openclaw-login-gate"))
          ) {
            trace.mounted = true;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(
      () =>
        (
          window as Window & {
            openclawLoginGateMountTrace?: { mounted: boolean };
          }
        ).openclawLoginGateMountTrace?.mounted ?? false,
    );
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
    const loginGateMounted = await traceLoginGateMounts(page);
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
    expect(await loginGateMounted()).toBe(false);
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

  it("shows the splash while a credential-less first connection resolves", async () => {
    const page = await createPage();
    const loginGateMounted = await traceLoginGateMounts(page);
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(server.baseUrl);
    await gateway.waitForRequest("connect");
    await page.locator(".connect-splash").waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);
    await captureProof(page, "05-credentialless-connecting-mascot");

    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();
    expect(await page.locator(".connect-splash").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);
  });

  it("redirects before setup detection without loading the discarded workspace", async () => {
    const page = await createPage();
    await page.emulateMedia({ colorScheme: "dark" });
    const workspaceModules = new Set([
      "/src/components/app-sidebar.ts",
      "/src/components/browser/browser-panel.ts",
      "/src/components/custodian/custodian-panel.ts",
      "/src/components/desktop/desktop-panel.ts",
      "/src/components/terminal/terminal-panel-registration.ts",
      "/src/pages/chat/chat-page.ts",
    ]);
    const requestedWorkspaceModules = new Set<string>();
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (workspaceModules.has(pathname)) {
        requestedWorkspaceModules.add(pathname);
      }
    });
    const gateway = await installMockGateway(page, {
      agentModel: null,
      deferredMethods: ["openclaw.setup.detect"],
      featureMethods: [
        "browser.request",
        "desktop.observe",
        "openclaw.chat",
        "openclaw.setup.detect",
        "openclaw.setup.prepare.start",
        "terminal.open",
      ],
      terminalEnabled: true,
    });

    await page.goto(server.baseUrl);
    await page.waitForURL("**/settings/model-setup?firstRun=1");
    expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
    await gateway.waitForRequest("openclaw.setup.detect");
    expect(await gateway.getRequests("openclaw.setup.detect")).toHaveLength(1);
    const loading = page.getByText("Checking this Gateway for available AI access…", {
      exact: true,
    });
    await loading.waitFor();
    const loadingSections = page.locator('.model-setup__loading[role="status"][aria-busy="true"]');
    await loadingSections.locator(".model-setup__loading-sections").waitFor();
    expect(await loadingSections.locator(".settings-section").count()).toBe(4);
    expect(await loadingSections.locator(".model-setup__loading-row").count()).toBe(5);
    expect(await loadingSections.locator("button, input, wa-dropdown").count()).toBe(0);
    await page.evaluate(() => document.fonts.ready);
    const sectionTitles = [
      "Found on this Gateway",
      "Run a model locally",
      "Sign in with a provider",
      "Connect with an API key or token",
    ];
    const loadingSectionTops = await Promise.all(
      sectionTitles.map(
        async (name) =>
          (await page.locator(".model-setup__loading-sections h2").getByText(name).boundingBox())!
            .y,
      ),
    );
    expect(await page.locator(".connect-splash").count()).toBe(0);
    expect([...requestedWorkspaceModules]).toEqual([]);
    await captureProof(page, "06-first-run-routed-before-detection");
    await page.setViewportSize({ height: 844, width: 390 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await captureProof(page, "06b-first-run-routed-before-detection-mobile");
    await page.setViewportSize(viewport);

    await gateway.resolveDeferred("openclaw.setup.detect", {
      candidates: [
        {
          kind: "claude-cli",
          brandId: "claude",
          label: "Claude Code",
          detail: "Signed in locally",
          modelRef: "claude-cli/claude-opus-5",
          recommended: false,
          credentials: true,
        },
      ],
      manualProviders: [{ id: "openai", brandId: "openai", label: "OpenAI" }],
      authOptions: [
        {
          id: "openai-oauth",
          brandId: "openai",
          label: "OpenAI",
          kind: "oauth",
          featured: true,
        },
      ],
      prepareOptions: [
        { id: "ollama", brandId: "ollama", label: "Ollama" },
        { id: "lmstudio", brandId: "lmstudio", label: "LM Studio" },
      ],
      setupComplete: false,
      workspace: "/tmp/openclaw-e2e",
    });
    await loading.waitFor({ state: "detached" });
    await page.getByRole("heading", { name: "Connect a verified AI model" }).waitFor();
    const readySectionTops = await Promise.all(
      sectionTitles.map(
        async (name) => (await page.getByRole("heading", { name }).boundingBox())!.y,
      ),
    );
    expect(
      Math.max(...readySectionTops.map((top, index) => Math.abs(top - loadingSectionTops[index]!))),
    ).toBeLessThanOrEqual(13);
    expect([...requestedWorkspaceModules]).toEqual([]);
    await captureProof(page, "07-first-run-model-setup-ready");
    await page.setViewportSize({ height: 844, width: 390 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await captureProof(page, "07b-first-run-model-setup-ready-mobile");
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

  it("keeps retryable Gateway startup on the progress splash", async () => {
    const page = await createPage();
    const loginGateMounted = await traceLoginGateMounts(page);
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(`${server.baseUrl}#token=e2e-shared-token`);
    await gateway.waitForRequest("connect");
    const initialConnectCount = (await gateway.getRequests("connect")).length;
    await gateway.deferNext("connect");
    await gateway.rejectDeferred("connect", {
      code: "UNAVAILABLE",
      message: "gateway starting; retry shortly",
      details: { reason: "startup-sidecars" },
      retryable: true,
    });

    const splash = page.locator(".connect-splash");
    await splash.getByText("Gateway starting…", { exact: true }).waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);
    await expect
      .poll(async () => await splash.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    await captureProof(page, "06-gateway-starting-progress");

    await expect
      .poll(async () => (await gateway.getRequests("connect")).length)
      .toBeGreaterThan(initialConnectCount);
    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();
  });

  it("uses the splash for a stored device token on reload", async () => {
    const page = await createPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    // First visit has no credentials, but the Gateway still owns the pending attempt.
    await page.goto(server.baseUrl);
    await gateway.waitForRequest("connect");
    await page.locator(".connect-splash").waitFor();
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
