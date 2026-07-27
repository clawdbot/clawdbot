// Control UI tests cover the initial-connect splash shown instead of the
// login gate while a first connect backed by stored credentials is in flight.
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

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();

async function createPage(): Promise<Page> {
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  openContexts.add(context);
  return await context.newPage();
}

describeControlUiE2e("Control UI initial connect splash E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}.`,
      );
    }
    server = await startControlUiE2eServer();
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
    await page.locator(".connect-splash").waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);

    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();
    expect(await page.locator(".connect-splash").count()).toBe(0);
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
