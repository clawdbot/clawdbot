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

type BoundingBox = { x: number; y: number; width: number; height: number };

function boxesIntersect(left: BoundingBox, right: BoundingBox): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

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

async function waitForLayoutSettled(page: Page, selector: string): Promise<void> {
  // content-visibility, grid transitions, and lazy styles can defer layout beyond
  // a fixed rAF pair. Measure the owning geometry until two frames agree.
  await page.evaluate(
    async ({ maxFrames, selector: targetSelector }) => {
      let previousGeometry: string | undefined;
      let stableFrames = 0;
      for (let frame = 0; frame < maxFrames; frame += 1) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        const elements = [...document.querySelectorAll<HTMLElement>(targetSelector)];
        if (elements.length === 0) {
          throw new Error(`No layout elements matched ${targetSelector}`);
        }
        const geometry = JSON.stringify(
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          }),
        );
        stableFrames = geometry === previousGeometry ? stableFrames + 1 : 1;
        if (stableFrames >= 2) {
          return;
        }
        previousGeometry = geometry;
      }
      throw new Error(`Layout did not stabilize for ${targetSelector} within ${maxFrames} frames`);
    },
    { maxFrames: 60, selector },
  );
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

  it("keeps mobile status inside the overflow menu while leaving desktop chrome unchanged", async () => {
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
      expect(await mobile.page.locator(".scope-upgrade-chip").count()).toBe(0);
      expect(await mobile.page.locator(".sidebar-attention--floating").count()).toBe(0);
      expect(await mobile.page.locator(".sidebar-update-card--floating").count()).toBe(0);
      expect(await mobile.page.locator(".chat-header-session-menu__status-dot").count()).toBe(1);
      await captureProof(mobile.page, "mobile-compact-header.png");
      await mobile.page.waitForTimeout(500);
      await menu.click();
      const status = mobile.page.getByText("Limited access", { exact: true });
      await status.waitFor();
      await mobile.page.getByText("Update available v2.0.0", { exact: true }).waitFor();
      await captureProof(mobile.page, "mobile-status-menu.png");
      await mobile.page.waitForTimeout(500);
      await status.click();
      await mobile.page.getByText("This browser has limited access.", { exact: true }).waitFor();
      await mobile.page
        .locator(".chat-header-session-menu--compact wa-dropdown-item")
        .first()
        .waitFor({ state: "hidden" });
      await captureProof(mobile.page, "mobile-access-details.png");
      await mobile.page.waitForTimeout(700);
      await mobile.page.getByRole("button", { name: "Collapse limited access banner" }).click();
      await menu.waitFor();
      await mobile.page.waitForTimeout(500);
    } finally {
      await closeProofContext(mobile, "mobile-compact-header");
    }

    const desktop = await createProofContext({ width: 1280, height: 900 }, "desktop");
    try {
      await installMockGateway(desktop.page, { operatorScopes: LIMITED_SCOPES });
      await desktop.page.goto(`${server.baseUrl}chat`);
      await desktop.page.getByText("This browser has limited access.", { exact: true }).waitFor();
      await desktop.page.locator(".shell-chrome-controls__search").first().waitFor();
      await desktop.page.locator(".chat-side-panel-toggle").first().waitFor();
      await captureProof(desktop.page, "desktop-unchanged.png");
      await desktop.page.waitForTimeout(500);
      await desktop.page.getByRole("button", { name: "Collapse limited access banner" }).click();
      await desktop.page.getByRole("button", { name: "Show limited access details" }).waitFor();
      await desktop.page.waitForTimeout(500);
    } finally {
      await closeProofContext(desktop, "desktop-unchanged");
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
      await page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true }).waitFor();
      await expect.poll(() => heldBannerModule).toBe(true);
      expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
      expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
      await captureProof(page, "limited.png");
    } finally {
      releaseBannerModule();
      await bannerModuleRouteSettled;
    }
    await navigation;
    await page.getByRole("button", { name: "Request admin" }).waitFor();

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

  it("collapses the limited-access banner into a persistent status chip", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await installMockGateway(page, { operatorScopes: LIMITED_SCOPES });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByText("This browser has limited access.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Collapse limited access banner" }).click();

    const statusChip = page.getByRole("button", { name: "Show limited access details" });
    await statusChip.waitFor();
    expect(await statusChip.getAttribute("aria-expanded")).toBe("false");
    await waitForLayoutSettled(page, ".content, .scope-upgrade-chip-row");
    const chipInset = await statusChip.evaluate((chip) => {
      const content = document.querySelector<HTMLElement>(".content");
      if (!content) {
        throw new Error("Missing content around limited-access status chip");
      }
      const contentBox = content.getBoundingClientRect();
      const chipBox = chip.getBoundingClientRect();
      return {
        right: contentBox.right - chipBox.right,
        top: chipBox.top - contentBox.top,
      };
    });
    await captureProof(page, "collapsed.png");
    expect(chipInset).toEqual({ right: 20, top: 8 });
    expect(await page.getByText("This browser has limited access.", { exact: true }).count()).toBe(
      0,
    );

    await page.reload();
    await statusChip.waitFor();
    expect(await page.getByText("This browser has limited access.", { exact: true }).count()).toBe(
      0,
    );

    await statusChip.click();
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
      const scopeUpgradeCallout = page.locator("openclaw-device-scope-upgrade-banner .callout");
      await scopeUpgradeCallout.waitFor();
      const guidance = scopeUpgradeCallout.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true });
      await guidance.waitFor();
      await waitForLayoutSettled(
        page,
        "openclaw-device-scope-upgrade-banner .callout, .shell-chrome-controls",
      );

      const guidanceBox = await guidance.boundingBox();
      const chromeControls = page.locator(".shell-chrome-controls__button");
      expect(guidanceBox).not.toBeNull();
      expect(await chromeControls.count()).toBe(2);
      for (let index = 0; index < (await chromeControls.count()); index += 1) {
        const control = chromeControls.nth(index);
        const controlBox = await control.boundingBox();
        expect(controlBox).not.toBeNull();
        if (guidanceBox && controlBox) {
          const label = await control.getAttribute("aria-label");
          expect(
            boxesIntersect(guidanceBox, controlBox),
            `guidance ${JSON.stringify(guidanceBox)} intersects ${label} ${JSON.stringify(controlBox)}`,
          ).toBe(false);
        }
      }

      expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
      expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
      await page.getByRole("button", { name: "Collapse limited access banner" }).click();
      expect(await page.getByRole("button", { name: "Show limited access details" }).count()).toBe(
        0,
      );
      await page.reload();
      await page.locator("openclaw-app-shell").waitFor();
      expect(await page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true }).count()).toBe(0);
    },
  );

  it.each(HIDDEN_WEB_CHROME_HOSTS)(
    "keeps manual guidance at the normal content inset with $label",
    async ({ collapsed, rootClass }) => {
      const context = await createContext();
      await context.addInitScript(
        ({ hostClass, settingsKey, startCollapsed }) => {
          localStorage.setItem(settingsKey, JSON.stringify({ navCollapsed: startCollapsed }));
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
      const guidance = page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true });
      await guidance.waitFor();
      if (collapsed) {
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--nav-collapsed");
      }
      await expect.poll(() => page.locator(".shell-chrome-controls").isVisible()).toBe(false);

      const scopeUpgradeCallout = page.locator("openclaw-device-scope-upgrade-banner .callout");
      await scopeUpgradeCallout.waitFor();
      await waitForLayoutSettled(page, ".content, openclaw-device-scope-upgrade-banner .callout");
      const calloutInsetDelta = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>(".content");
        const callout = document.querySelector<HTMLElement>(
          "openclaw-device-scope-upgrade-banner .callout",
        );
        if (!content || !callout) {
          throw new Error("Missing content or scope-upgrade callout after layout settled");
        }
        return (
          callout.getBoundingClientRect().x -
          content.getBoundingClientRect().x -
          Number.parseFloat(getComputedStyle(content).paddingLeft)
        );
      });
      expect(calloutInsetDelta).toBe(0);
    },
  );

  it("does not misreport limited Custodian access as an outdated Gateway", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat", ...SCOPE_UPGRADE_METHODS],
      operatorScopes: LIMITED_SCOPES,
    });

    await page.goto(`${server.baseUrl}custodian?intent=new-agent`);
    await page.getByText("This browser has limited access.", { exact: true }).waitFor();

    expect(
      await page.getByText("Update the Gateway to continue setup with OpenClaw.").count(),
    ).toBe(0);
    expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
    await captureProof(page, "custodian-limited.png");
  });

  it("keeps manual repair guidance when the banner module fails to load", async () => {
    const context = await createContext();
    const page = await context.newPage();
    let bannerModuleRejected = false;
    const rejectBannerModule = async (route: Route) => {
      // A network abort intentionally starts whole-document stale-chunk recovery,
      // which is a different contract and can reload while this test tears down.
      // Fail module evaluation instead so only the optional-banner fallback owns it.
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
      await page.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true }).waitFor();

      expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
    } finally {
      // A failed dynamic import can be retried by a later shell render. Remove
      // the route before closing so teardown cannot race a fresh intercepted request.
      await page.unroute(BANNER_MODULE_ROUTE, rejectBannerModule);
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
