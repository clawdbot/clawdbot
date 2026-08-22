import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  controlUiBundledSettingsStorageKey,
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
const HIDDEN_WEB_CHROME_HOSTS = [
  { collapsed: false, label: "native web chrome", rootClass: "openclaw-native-web-chrome" },
  { collapsed: true, label: "collapsed native navigation", rootClass: "openclaw-native-nav" },
] as const;
const MANUAL_UPGRADE_GUIDANCE =
  "This browser has limited access. Manage it with openclaw devices on the Gateway or from Devices on an admin browser.";
const BANNER_MODULE_ROUTE = /device-scope-upgrade\.runtime(?:-[^/.]+)?\.(?:js|ts)/u;
const BANNER_RETRY_MODULE_ROUTE = /device-scope-upgrade-retry\.runtime(?:-[^/.]+)?\.(?:js|ts)/u;

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
  await page.waitForTimeout(250);
  await page.screenshot({ fullPage: true, path: path.join(proofDir, name) });
}

async function holdProof(page: Page, durationMs = 500): Promise<void> {
  if (proofDir) {
    await page.waitForTimeout(durationMs);
  }
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

async function createProofContext(
  viewport: { width: number; height: number },
  label: string,
): Promise<{ context: BrowserContext; page: Page; rawVideoDir: string | null }> {
  const rawVideoDir = proofDir ? path.join(proofDir, "raw-video", label) : null;
  if (rawVideoDir) {
    await mkdir(rawVideoDir, { recursive: true });
  }
  const context = await browser.newContext({
    locale: "en-US",
    ...(rawVideoDir ? { recordVideo: { dir: rawVideoDir, size: viewport } } : {}),
    serviceWorkers: "block",
    viewport,
  });
  openContexts.add(context);
  return { context, page: await context.newPage(), rawVideoDir };
}

async function closeProofContext(
  proof: { context: BrowserContext; page: Page; rawVideoDir: string | null },
  label: string,
): Promise<void> {
  const video = proof.page.video();
  openContexts.delete(proof.context);
  await proof.context.close();
  if (proofDir && video) {
    await copyFile(await video.path(), path.join(proofDir, `${label}.webm`));
  }
  if (proof.rawVideoDir) {
    await rm(proof.rawVideoDir, { force: true, recursive: true });
  }
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

  it("keeps mobile chat status inside the session menu", async () => {
    const mobile = await createProofContext({ width: 390, height: 844 }, "mobile");
    try {
      const gateway = await installMockGateway(mobile.page, { operatorScopes: LIMITED_SCOPES });
      await mobile.page.goto(`${server.baseUrl}chat`);
      await gateway.emitGatewayEvent("update.available", {
        updateAvailable: {
          channel: "stable",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
        },
      });
      const header = mobile.page.locator(".chat-pane__header").first();
      const menu = mobile.page.locator(".chat-header-session-menu__trigger");
      await header.waitFor();
      await menu.waitFor();
      expect(await mobile.page.locator(".chat-pane__palette-open").count()).toBe(0);
      expect(await mobile.page.locator(".chat-side-panel-toggle").count()).toBe(0);
      expect(await mobile.page.locator(".scope-upgrade-shell-status").count()).toBe(0);
      expect(await mobile.page.locator(".sidebar-attention--floating").count()).toBe(0);
      expect(await mobile.page.locator(".sidebar-update-card--floating").count()).toBe(0);
      expect(await mobile.page.locator(".chat-header-session-menu__status-dot").count()).toBe(1);
      await captureProof(mobile.page, "mobile-compact-header.png");
      await holdProof(mobile.page);
      await menu.click();
      const status = mobile.page.getByText("Limited access", { exact: true });
      await status.waitFor();
      await mobile.page.getByText("Update available v2.0.0", { exact: true }).waitFor();
      await captureProof(mobile.page, "mobile-status-menu.png");
      await holdProof(mobile.page);
      await status.click();
      await mobile.page.getByText("This browser has limited access.", { exact: true }).waitFor();
      await mobile.page
        .locator(".chat-header-session-menu--compact wa-dropdown-item")
        .first()
        .waitFor({ state: "hidden" });
      await captureProof(mobile.page, "mobile-access-details.png");
      await holdProof(mobile.page, 700);
      await mobile.page.getByRole("button", { name: "Close limited access details" }).click();
      await menu.waitFor();
      await holdProof(mobile.page);
    } finally {
      await closeProofContext(mobile, "mobile-compact-header");
    }
  });

  it("keeps Automations access status in shell chrome without moving routed content", async () => {
    const mobile = await createProofContext({ width: 555, height: 1000 }, "automations-mobile");
    try {
      await installMockGateway(mobile.page, { operatorScopes: LIMITED_SCOPES });
      await mobile.page.goto(`${server.baseUrl}cron`);
      const title = mobile.page.locator(".content-header .page-title");
      const status = mobile.page.locator(".scope-upgrade-shell-status");
      await title.waitFor();
      await status.waitFor();
      await status.focus();
      await mobile.page.keyboard.press("Tab");
      await expect
        .poll(() =>
          mobile.page
            .locator(".topbar-search")
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      expect(
        await mobile.page.locator(".content > openclaw-device-scope-upgrade-banner").count(),
      ).toBe(0);
      const titleTopBefore = (await title.boundingBox())?.y;
      await captureProof(mobile.page, "mobile-automations-shell-status.png");

      await status.click();
      await mobile.page.getByText("This browser has limited access.", { exact: true }).waitFor();
      await mobile.page.locator("openclaw-modal-dialog.scope-upgrade-details-dialog").waitFor();
      await captureProof(mobile.page, "mobile-automations-access-details.png");
      expect(
        Math.abs(((await title.boundingBox())?.y ?? 0) - (titleTopBefore ?? 0)),
      ).toBeLessThanOrEqual(0.5);
      await mobile.page.getByRole("button", { name: "Close limited access details" }).click();
      await status.waitFor();
    } finally {
      await closeProofContext(mobile, "automations-mobile");
    }

    const tablet = await createProofContext({ width: 900, height: 1000 }, "automations-tablet");
    try {
      await installMockGateway(tablet.page, { operatorScopes: LIMITED_SCOPES });
      await tablet.page.goto(`${server.baseUrl}cron`);
      const title = tablet.page.locator(".content-header .page-title");
      const status = tablet.page.locator(".scope-upgrade-shell-status");
      await title.waitFor();
      await status.click();
      await tablet.page.getByText("This browser has limited access.", { exact: true }).waitFor();
      await captureProof(tablet.page, "tablet-automations-access-details.png");
      const dialogBox = await tablet.page
        .locator("openclaw-modal-dialog.scope-upgrade-details-dialog")
        .evaluate(async (modal) => {
          const dialog = modal.shadowRoot?.querySelector("wa-dialog");
          const panel = dialog?.shadowRoot?.querySelector<HTMLElement>('[part="dialog"]');
          if (!panel) {
            throw new Error("Missing scope-upgrade dialog panel");
          }
          await Promise.all(
            panel.getAnimations({ subtree: true }).map((animation) => animation.finished),
          );
          const box = panel.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        });
      expect(dialogBox.x).toBe(0);
      expect(dialogBox.width).toBe(900);
      expect(dialogBox.y + dialogBox.height).toBe(1000);
    } finally {
      await closeProofContext(tablet, "automations-tablet");
    }

    const desktop = await createProofContext({ width: 1280, height: 900 }, "automations-desktop");
    try {
      await installMockGateway(desktop.page, { operatorScopes: LIMITED_SCOPES });
      await desktop.page.goto(`${server.baseUrl}cron`);
      const title = desktop.page.locator(".content-header .page-title");
      const status = desktop.page.locator(".scope-upgrade-shell-status");
      await title.waitFor();
      await status.waitFor();
      const titleTopBefore = (await title.boundingBox())?.y;
      await captureProof(desktop.page, "desktop-automations-shell-status.png");

      await status.click();
      await desktop.page.getByText("This browser has limited access.", { exact: true }).waitFor();
      await desktop.page.locator(".scope-upgrade-details-popover").waitFor();
      await captureProof(desktop.page, "desktop-automations-access-details.png");
      expect(
        Math.abs(((await title.boundingBox())?.y ?? 0) - (titleTopBefore ?? 0)),
      ).toBeLessThanOrEqual(0.5);
      await desktop.page.getByRole("button", { name: "Close limited access details" }).click();
    } finally {
      await closeProofContext(desktop, "automations-desktop");
    }
  });

  it("requests admin explicitly, shows pending repair guidance, and reconnects approved", async () => {
    const context = await createContext();
    const page = await context.newPage();
    let releaseBannerModule = () => {};
    const bannerModuleRelease = new Promise<void>((resolve) => {
      releaseBannerModule = resolve;
    });
    let heldBannerModule = false;
    let bannerModuleRouteSettled: Promise<void> | undefined;
    await page.route(BANNER_MODULE_ROUTE, async (route) => {
      if (!heldBannerModule) {
        heldBannerModule = true;
        bannerModuleRouteSettled = bannerModuleRelease.then(() => route.continue());
        await bannerModuleRouteSettled;
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
      await expect.poll(() => heldBannerModule).toBe(true);
      expect(await page.getByRole("button", { name: "Show limited access details" }).count()).toBe(
        0,
      );
      expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
      expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
    } finally {
      releaseBannerModule();
      await bannerModuleRouteSettled;
    }
    await navigation;
    await page.getByRole("button", { name: "Show limited access details" }).click();
    await limitedBanner.waitFor();
    await page.getByRole("button", { name: "Request admin" }).waitFor();
    await captureProof(page, "limited.png");
    await page.getByRole("button", { name: "Close limited access details" }).click();

    await page.locator("#new-session-project-trigger").click();
    const projectPopover = page.locator("wa-popover.new-session-page__project-popover");
    await expect
      .poll(() => projectPopover.evaluate((element) => element === document.activeElement))
      .toBe(true);
    const browse = page.getByRole("button", { name: "Browse folders" });
    await expect.poll(() => browse.isDisabled()).toBe(true);
    await browse.focus();
    await expect
      .poll(() => browse.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await page
      .locator(".tooltip-content")
      .getByText(
        "To browse outside agent workspaces, open the access status, request admin, then approve in Devices.",
        { exact: true },
      )
      .waitFor();
    await captureProof(page, "limited-picker.png");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Show limited access details" }).click();
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

  it("keeps the shell access trigger across routes and reloads", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await installMockGateway(page, { operatorScopes: LIMITED_SCOPES });

    await page.goto(`${server.baseUrl}cron`);
    const status = page.getByRole("button", { name: "Show limited access details" });
    await status.waitFor();
    expect(await page.locator(".content > openclaw-device-scope-upgrade-banner").count()).toBe(0);

    await page.goto(`${server.baseUrl}channels`);
    await status.waitFor();
    await page.reload();
    await status.waitFor();
    await status.click();
    await page.getByText("This browser has limited access.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Request admin" }).waitFor();
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
      const status = page.getByRole("button", { name: "Show limited access details" });
      await status.waitFor();
      await status.click();
      const guidance = page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true });
      await guidance.waitFor();

      expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
      expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
      await page.getByRole("button", { name: "Close limited access details" }).click();
      await status.waitFor();
      await page.reload();
      await status.waitFor();
    },
  );

  it.each(HIDDEN_WEB_CHROME_HOSTS)(
    "keeps manual guidance reachable from shell status with $label",
    async ({ collapsed, rootClass }) => {
      const context = await createContext();
      await context.addInitScript(
        ({ hostClass, settingsKey, startCollapsed }) => {
          localStorage.setItem(settingsKey, JSON.stringify({ navCollapsed: startCollapsed }));
          if (hostClass === "openclaw-native-web-chrome") {
            (window as Window & { __OPENCLAW_NATIVE_WEB_CHROME__?: boolean })[
              "__OPENCLAW_NATIVE_WEB_CHROME__"
            ] = true;
          }
          const stamp = () =>
            document.documentElement.classList.add("openclaw-native-macos", hostClass);
          if (document.documentElement) {
            stamp();
          } else {
            document.addEventListener("DOMContentLoaded", stamp);
          }
        },
        {
          hostClass: rootClass,
          settingsKey: controlUiBundledSettingsStorageKey(server.baseUrl),
          startCollapsed: collapsed,
        },
      );
      const page = await context.newPage();
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "device.scopes.requestUpgrade"],
        operatorScopes: LIMITED_SCOPES,
      });

      await page.goto(`${server.baseUrl}chat`);
      if (collapsed) {
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--nav-collapsed");
      }
      const status = page.getByRole("button", { name: "Show limited access details" });
      await status.waitFor();
      expect(await status.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
      if (rootClass === "openclaw-native-web-chrome") {
        await expect.poll(() => page.locator(".shell-chrome-controls").isVisible()).toBe(false);
        expect((await status.boundingBox())?.x).toBe(252);
      } else {
        expect((await status.boundingBox())?.x).toBe(10);
        expect(await page.locator(".shell-chrome-controls__search").isVisible()).toBe(false);
      }
      await status.click();
      await page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true }).waitFor();
    },
  );

  it("keeps native mobile access status clear of the compact topbar", async () => {
    const native = await createProofContext({ width: 555, height: 1000 }, "native-mobile-access");
    try {
      await native.context.addInitScript(() => {
        (window as Window & { __OPENCLAW_NATIVE_WEB_CHROME__?: boolean })[
          "__OPENCLAW_NATIVE_WEB_CHROME__"
        ] = true;
        document.documentElement.classList.add(
          "openclaw-native-macos",
          "openclaw-native-web-chrome",
        );
      });
      await installMockGateway(native.page, { operatorScopes: LIMITED_SCOPES });
      await native.page.goto(`${server.baseUrl}cron`);
      const status = native.page.getByRole("button", { name: "Show limited access details" });
      const search = native.page.locator(".topbar-search");
      await status.waitFor();
      await search.waitFor();
      await native.page.locator(".shell").evaluate(async (shell) => {
        await Promise.all(
          shell.getAnimations({ subtree: true }).map((animation) => animation.finished),
        );
      });
      const statusBox = await status.boundingBox();
      const searchBox = await search.boundingBox();
      expect(statusBox?.x).toBe(457);
      expect(statusBox?.y).toBe(10);
      expect((statusBox?.x ?? 0) + (statusBox?.width ?? 0)).toBeLessThanOrEqual(searchBox?.x ?? 0);
      await status.click();
      await native.page.getByText("This browser has limited access.", { exact: true }).waitFor();
    } finally {
      await closeProofContext(native, "native-mobile-access");
    }
  });

  it("does not misreport limited Custodian access as an outdated Gateway", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat", ...SCOPE_UPGRADE_METHODS],
      operatorScopes: LIMITED_SCOPES,
    });

    await page.goto(`${server.baseUrl}custodian?intent=new-agent`);
    await page.getByRole("button", { name: "Show limited access details" }).click();
    await page.getByText("This browser has limited access.", { exact: true }).waitFor();

    expect(
      await page.getByText("Update the Gateway to continue setup with OpenClaw.").count(),
    ).toBe(0);
    expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
    await captureProof(page, "custodian-limited.png");
  });

  it("recovers scope details after the lazy module initially fails", async () => {
    const context = await createContext();
    const page = await context.newPage();
    let bannerModuleRejected = false;
    const rejectBannerModule = async (route: Route) => {
      // A network abort intentionally starts whole-document stale-chunk recovery,
      // which is a different contract and can reload while this test tears down.
      // Fail module evaluation instead so the shared lazy-view error owns recovery.
      await route.fulfill({
        body: 'throw new Error("device scope banner module failed to evaluate");',
        contentType: "application/javascript",
        status: 200,
      });
      bannerModuleRejected = true;
    };
    await page.route(BANNER_MODULE_ROUTE, rejectBannerModule);
    await installMockGateway(page, { operatorScopes: LIMITED_SCOPES });

    try {
      const navigation = page.goto(`${server.baseUrl}chat`);
      await expect.poll(() => bannerModuleRejected).toBe(true);
      await navigation;
      await page.getByRole("button", { name: "Show limited access details" }).click();
      await page.getByText("This browser has limited access.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Request admin" }).waitFor();
      expect(await page.getByRole("button", { name: "Retry" }).count()).toBe(0);
    } finally {
      // A failed dynamic import can be retried by a later shell render. Remove
      // the route before closing so teardown cannot race a fresh intercepted request.
      await page.unroute(BANNER_MODULE_ROUTE, rejectBannerModule);
      await page.close({ runBeforeUnload: false });
    }
  });

  it("keeps recovery visible when both scope-upgrade entries fail", async () => {
    const context = await createContext();
    const page = await context.newPage();
    let rejectedModules = 0;
    const rejectBannerModule = async (route: Route) => {
      rejectedModules += 1;
      await route.fulfill({
        body: 'throw new Error("device scope banner module failed to evaluate");',
        contentType: "application/javascript",
        status: 200,
      });
    };
    await page.route(BANNER_MODULE_ROUTE, rejectBannerModule);
    await page.route(BANNER_RETRY_MODULE_ROUTE, rejectBannerModule);
    await installMockGateway(page, { operatorScopes: LIMITED_SCOPES });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await expect.poll(() => rejectedModules).toBe(2);
      await page.getByRole("alert").waitFor();
      await page.getByText("Panel failed to load", { exact: true }).waitFor();
      await page.getByText("Limited access", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Retry" }).waitFor();
      await captureProof(page, "scope-upgrade-load-failed.png");
    } finally {
      await page.unroute(BANNER_MODULE_ROUTE, rejectBannerModule);
      await page.unroute(BANNER_RETRY_MODULE_ROUTE, rejectBannerModule);
      await page.close({ runBeforeUnload: false });
    }
  });

  it("offers the admin upgrade without crypto.subtle", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(globalThis.crypto, "subtle", {
        configurable: true,
        value: undefined,
      });
    });
    const gateway = await installMockGateway(page, {
      operatorScopes: LIMITED_SCOPES,
      methodResponses: {
        "device.scopes.requestUpgrade": { requestId: "upgrade-insecure" },
      },
    });

    await page.goto(`${server.baseUrl}chat`);
    // Pure-JS Ed25519 signs the device connect on insecure contexts, so the
    // explicit upgrade path stays available instead of manual-only guidance.
    await page.getByRole("button", { name: "Show limited access details" }).click();
    await page.getByRole("button", { name: "Request admin" }).waitFor();
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
  });

  it("shows manual repair guidance when the browser cannot mint a device identity", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      // Without a WebCrypto RNG the identity mint fails and the client
      // degrades to a device-less connect that cannot sign upgrade requests.
      Object.defineProperty(globalThis.crypto, "subtle", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value: undefined,
      });
    });
    const gateway = await installMockGateway(page, { operatorScopes: LIMITED_SCOPES });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByRole("button", { name: "Show limited access details" }).click();
    await page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true }).waitFor();

    expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
  });

  it("never shows the upgrade status or files a request for admin connections", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { operatorScopes: FULL_SCOPES });
    await page.goto(`${server.baseUrl}chat`);
    await page.locator("openclaw-app-shell").waitFor();

    expect(await page.getByText("This browser has limited access.", { exact: true }).count()).toBe(
      0,
    );
    expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Show limited access details" }).count()).toBe(0);
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
    await captureProof(page, "admin.png");
  });
});
