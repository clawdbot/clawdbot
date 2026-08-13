import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
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
const proofDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();

const LIMITED_SCOPES = ["operator.read", "operator.write"];
const FULL_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
];
const SCOPE_UPGRADE_METHODS = [
  "device.scopes.requestUpgrade",
  "device.scopes.waitUpgrade",
] as const;
const MANUAL_UPGRADE_GUIDANCE =
  "This browser has limited access. Manage it with openclaw devices on the Gateway or from Devices on an admin browser.";

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

async function captureProof(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(proofDir, name) });
}

async function createContext(): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  openContexts.add(context);
  return context;
}

describeControlUiE2e("Control UI live device scope upgrade", () => {
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

  it("requests admin explicitly, shows pending repair guidance, and reconnects approved", async () => {
    const context = await createContext();
    const page = await context.newPage();
    let releaseBannerModule = () => {};
    const bannerModuleRelease = new Promise<void>((resolve) => {
      releaseBannerModule = resolve;
    });
    let heldBannerModule = false;
    await page.route(/device-scope-upgrade\.runtime(?:-[^/.]+)?\.(?:js|ts)/u, async (route) => {
      if (!heldBannerModule) {
        heldBannerModule = true;
        void bannerModuleRelease.then(() => route.continue());
        return;
      }
      await route.continue();
    });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["device.scopes.waitUpgrade"],
      operatorScopes: LIMITED_SCOPES,
      methodResponses: {
        "device.scopes.requestUpgrade": { requestId: "upgrade-1" },
      },
    });
    const navigation = page.goto(`${server.baseUrl}new`);

    const limitedBanner = page.getByText("This browser has limited access.", { exact: true });
    try {
      await page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true }).waitFor();
      await expect.poll(() => heldBannerModule).toBe(true);
      expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
      expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
      await captureProof(page, "limited.png");
    } finally {
      releaseBannerModule();
    }
    await navigation;
    await page.getByRole("button", { name: "Request admin" }).waitFor();

    await page.locator("#new-session-project-trigger").click();
    const browse = page.getByRole("button", { name: "Browse folders" });
    await expect.poll(() => browse.isDisabled()).toBe(true);
    await browse.focus();
    await expect
      .poll(() => browse.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await page
      .locator(".tooltip-content")
      .getByText(
        "To browse outside agent workspaces, request admin in the access banner, then approve in Devices.",
        { exact: true },
      )
      .waitFor();
    await captureProof(page, "limited-picker.png");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Request admin" }).click();
    const request = await gateway.waitForRequest("device.scopes.requestUpgrade");
    expect(request.params).toEqual({ scopes: FULL_SCOPES });
    const wait = await gateway.waitForRequest("device.scopes.waitUpgrade");
    expect(wait.params).toEqual({ requestId: "upgrade-1" });
    await page
      .getByText(/Approve this browser by running openclaw devices on the Gateway/)
      .waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).waitFor();
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(1);
    expect(await gateway.getRequests("device.scopes.waitUpgrade")).toHaveLength(1);
    await captureProof(page, "pending.png");

    await gateway.setOperatorScopes(FULL_SCOPES);
    await gateway.resolveDeferred("device.scopes.waitUpgrade", {
      status: "approved",
      requestId: "upgrade-1",
      deviceToken: "rotated-device-token",
      scopes: FULL_SCOPES,
    });
    await expect.poll(() => gateway.getSocketCount()).toBe(2);
    await expect.poll(async () => (await gateway.getRequests("connect")).length).toBe(2);
    const connects = await gateway.getRequests("connect");
    const reconnectParams = requireRecord(connects.at(-1)?.params);
    expect(reconnectParams.scopes).toEqual(FULL_SCOPES.toSorted());
    expect(requireRecord(reconnectParams.auth)).toMatchObject({
      token: "rotated-device-token",
      deviceToken: "rotated-device-token",
    });
    await expect.poll(() => limitedBanner.count()).toBe(0);
    await captureProof(page, "approved.png");
  });

  it.each(SCOPE_UPGRADE_METHODS)(
    "shows manual repair guidance when %s is not advertised",
    async (missingMethod) => {
      const context = await createContext();
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          ...SCOPE_UPGRADE_METHODS.filter((method) => method !== missingMethod),
        ],
        operatorScopes: LIMITED_SCOPES,
      });

      await page.goto(`${server.baseUrl}chat`);
      await page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true }).waitFor();

      expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
      expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
    },
  );

  it("keeps manual repair guidance when the banner module fails to load", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await page.route(/device-scope-upgrade\.runtime(?:-[^/.]+)?\.(?:js|ts)/u, (route) =>
      route.abort("failed"),
    );
    await installMockGateway(page, { operatorScopes: LIMITED_SCOPES });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true }).waitFor();

    expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
  });

  it("shows manual repair guidance without a signed browser device", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(globalThis.crypto, "subtle", {
        configurable: true,
        value: undefined,
      });
    });
    const gateway = await installMockGateway(page, { operatorScopes: LIMITED_SCOPES });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true }).waitFor();

    expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
  });

  it("never shows the upgrade banner or files a request for admin connections", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { operatorScopes: FULL_SCOPES });
    await page.goto(`${server.baseUrl}chat`);
    await page.locator("openclaw-app-shell").waitFor();

    expect(await page.getByText("This browser has limited access.", { exact: true }).count()).toBe(
      0,
    );
    expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
    await captureProof(page, "admin.png");
  });
});
