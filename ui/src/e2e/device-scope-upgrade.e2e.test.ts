import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiSettingsTakeover,
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

async function createContext(viewport = { height: 900, width: 1280 }): Promise<BrowserContext> {
  const context = await browser.newContext({
    colorScheme: "dark",
    locale: "en-US",
    recordVideo: proofDir ? { dir: path.join(proofDir, "videos"), size: viewport } : undefined,
    serviceWorkers: "block",
    viewport,
  });
  openContexts.add(context);
  return context;
}

async function waitForAnimations(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    const animations = element
      .getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(animations.map((animation) => animation.finished));
  });
}

async function openInbox(page: Page, mobile = false) {
  if (mobile) {
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.locator(".nav-drawer").waitFor();
  }
  const trigger = page.locator(".sidebar-issues-button:visible");
  await trigger.waitFor();
  await trigger.click();
  const panel = page.locator("#sidebar-issues-panel");
  await panel.waitFor();
  return panel;
}

async function openLimitedAccessItem(panel: Locator) {
  await panel.getByRole("tab", { name: /System/u }).click();
  const item = panel.locator('[data-attention-kind="scopeUpgrade"]');
  await item.waitFor();
  await item.locator("summary").click();
  return item;
}

async function closeInbox(page: Page) {
  await page.locator(".sidebar-issues-button:visible").click();
  await page.locator("#sidebar-issues-panel").waitFor({ state: "detached" });
}

async function waitForPendingUpgradeItem(item: Locator) {
  await item
    .locator(".sidebar-issues-panel__body")
    .getByText(/Approve this browser by running openclaw devices on the Gateway/u)
    .waitFor();
  await item.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await item.getByRole("button", { name: "Cancel", exact: true }).waitFor();
  expect(await item.getByRole("button", { name: "Dismiss Limited access" }).count()).toBe(0);
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

  it("moves limited access into the Inbox and persists its dismissal", async () => {
    const desktopContext = await createContext();
    const desktop = await desktopContext.newPage();
    await installMockGateway(desktop, { operatorScopes: LIMITED_SCOPES });
    await desktop.goto(`${server.baseUrl}activity`);

    expect(await desktop.locator(".scope-upgrade-status-trigger").count()).toBe(0);
    const desktopInbox = desktop.locator(".sidebar-issues-button");
    await expect.poll(() => desktopInbox.getAttribute("aria-label")).toBe("1 inbox item");
    const desktopPanel = await openInbox(desktop);
    const desktopItem = await openLimitedAccessItem(desktopPanel);
    await desktopItem.getByRole("button", { name: "Request admin" }).waitFor();
    await captureProof(desktop, "desktop-inbox-limited-access.png");
    await desktopPanel.getByRole("button", { name: "Dismiss shown" }).click();
    await expect.poll(() => desktopInbox.getAttribute("aria-label")).toBe("0 inbox items");
    await expect.poll(() => desktopItem.count()).toBe(0);
    await desktopPanel.getByRole("tab", { name: "All", exact: true }).waitFor();
    await desktopPanel.getByRole("tab", { name: "System", exact: true }).waitFor();
    await captureProof(desktop, "desktop-inbox-limited-access-dismissed.png");

    await desktop.reload();
    await desktop.locator("openclaw-app-shell").waitFor();
    await expect.poll(() => desktopInbox.getAttribute("aria-label")).toBe("0 inbox items");
    const reloadedPanel = await openInbox(desktop);
    await reloadedPanel.getByRole("tab", { name: /System/u }).click();
    expect(await reloadedPanel.locator('[data-attention-kind="scopeUpgrade"]').count()).toBe(0);
    await captureProof(desktop, "desktop-inbox-limited-access-dismissed-reload.png");

    const mobileContext = await createContext({ width: 390, height: 844 });
    const mobile = await mobileContext.newPage();
    await installMockGateway(mobile, { operatorScopes: LIMITED_SCOPES });
    await mobile.goto(`${server.baseUrl}activity`);

    await mobile.locator(".topbar-search").waitFor();
    expect(await mobile.locator(".scope-upgrade-status-trigger").count()).toBe(0);
    await captureProof(mobile, "mobile-activity-clean-header.png");
    await mobile.getByRole("button", { name: "Expand sidebar" }).click();
    await waitForAnimations(mobile.locator(".nav-drawer"));
    const mobileInbox = mobile.locator(".sidebar-issues-button");
    await expect.poll(() => mobileInbox.getAttribute("aria-label")).toBe("1 inbox item");
    await captureProof(mobile, "mobile-sidebar-inbox-badge.png");
    await mobileInbox.click();
    const mobilePanel = mobile.locator("#sidebar-issues-panel");
    await mobilePanel.waitFor();
    await waitForAnimations(mobilePanel);
    const mobileItem = await openLimitedAccessItem(mobilePanel);
    await mobileItem.getByRole("button", { name: "Dismiss Limited access" }).waitFor();
    await captureProof(mobile, "mobile-inbox-limited-access.png");
  });

  it("resurfaces when manual guidance becomes an actionable upgrade", async () => {
    const context = await createContext();
    const guidancePage = await context.newPage();
    await installMockGateway(guidancePage, {
      featureMethods: ["chat.metadata", "chat.startup", "device.scopes.requestUpgrade"],
      operatorScopes: LIMITED_SCOPES,
    });
    await guidancePage.goto(`${server.baseUrl}activity`);

    const guidanceInbox = guidancePage.locator(".sidebar-issues-button");
    const guidanceItem = await openLimitedAccessItem(await openInbox(guidancePage));
    await guidanceItem.getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true }).waitFor();
    await guidanceItem.getByRole("button", { name: "Dismiss Limited access" }).click();
    await expect.poll(() => guidanceInbox.getAttribute("aria-label")).toBe("0 inbox items");
    await guidancePage.close();

    const availablePage = await context.newPage();
    await installMockGateway(availablePage, { operatorScopes: LIMITED_SCOPES });
    await availablePage.goto(`${server.baseUrl}activity`);

    const availableInbox = availablePage.locator(".sidebar-issues-button");
    await expect.poll(() => availableInbox.getAttribute("aria-label")).toBe("1 inbox item");
    const availableItem = await openLimitedAccessItem(await openInbox(availablePage));
    await availableItem.getByRole("button", { name: "Request admin" }).waitFor();
  });

  it("keeps a pending admin request across Inbox presenters and Settings", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["device.scopes.waitUpgrade"],
      operatorScopes: LIMITED_SCOPES,
      methodResponses: {
        "device.scopes.requestUpgrade": { requestId: "upgrade-1" },
      },
    });
    await page.goto(`${server.baseUrl}new`);

    const item = await openLimitedAccessItem(await openInbox(page));
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
    await item.getByRole("button", { name: "Request admin" }).click();
    const request = await gateway.waitForRequest("device.scopes.requestUpgrade");
    expect(request.params).toEqual({ scopes: FULL_SCOPES });
    const wait = await gateway.waitForRequest("device.scopes.waitUpgrade");
    expect(wait.params).toEqual({ requestId: "upgrade-1" });
    await waitForPendingUpgradeItem(item);
    await captureProof(page, "desktop-inbox-upgrade-pending.png");

    await closeInbox(page);
    await page
      .locator(".shell-chrome-controls")
      .getByRole("button", { name: "Collapse sidebar" })
      .click();
    const collapsedItem = await openLimitedAccessItem(await openInbox(page));
    await waitForPendingUpgradeItem(collapsedItem);
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(1);
    expect(await gateway.getRequests("device.scopes.waitUpgrade")).toHaveLength(1);

    await closeInbox(page);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    const sidebar = page.locator("openclaw-app-sidebar");
    const identityCard = sidebar.locator(".sidebar-identity-card");
    await identityCard.waitFor();
    await identityCard.click();
    await sidebar
      .locator("wa-dropdown.sidebar-identity-menu")
      .getByRole("menuitem", { exact: true, name: "Settings" })
      .click();
    await waitForControlUiSettingsTakeover(page);
    const settingsItem = await openLimitedAccessItem(await openInbox(page));
    await waitForPendingUpgradeItem(settingsItem);
    await waitForAnimations(page.locator("#sidebar-issues-panel"));
    await captureProof(page, "settings-inbox-upgrade-pending.png");
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(1);
    expect(await gateway.getRequests("device.scopes.waitUpgrade")).toHaveLength(1);

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
    await expect.poll(() => page.locator('[data-attention-kind="scopeUpgrade"]').count()).toBe(0);
    await expect.poll(() => page.locator(".sidebar-issues-button__count").count()).toBe(0);
  });

  it.each(SCOPE_UPGRADE_METHODS)(
    "shows manual repair guidance in Inbox when %s is not advertised",
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

      const item = await openLimitedAccessItem(await openInbox(page));
      await item
        .locator(".sidebar-issues-panel__body")
        .getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true })
        .waitFor();
      expect(await item.getByRole("button", { name: "Request admin" }).count()).toBe(0);
      expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
    },
  );

  it("keeps Inbox reachable at the bottom left during onboarding", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat", ...SCOPE_UPGRADE_METHODS],
      operatorScopes: LIMITED_SCOPES,
    });
    await page.goto(`${server.baseUrl}custodian?onboarding=1`);

    expect(
      await page.getByText("Update the Gateway to continue setup with OpenClaw.").count(),
    ).toBe(0);
    const inbox = page.locator(".sidebar-attention--floating .sidebar-issues-button");
    await expect.poll(() => inbox.getAttribute("aria-label")).toBe("1 inbox item");
    const item = await openLimitedAccessItem(await openInbox(page));
    await item.getByRole("button", { name: "Request admin" }).waitFor();
    await captureProof(page, "onboarding-inbox-limited-access.png");
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

    // Pure-JS Ed25519 keeps signed scope-upgrade requests available when
    // WebCrypto lacks subtle crypto (for example, an insecure LAN origin).
    const item = await openLimitedAccessItem(await openInbox(page));
    await item.getByRole("button", { name: "Request admin" }).waitFor();
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
  });

  it("shows manual repair guidance when the browser cannot mint a device identity", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
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

    // Without a secure RNG the client cannot mint the device identity that
    // binds an upgrade request, so Inbox must keep manual repair guidance.
    const item = await openLimitedAccessItem(await openInbox(page));
    await item
      .locator(".sidebar-issues-panel__body")
      .getByText(MANUAL_UPGRADE_GUIDANCE, { exact: true })
      .waitFor();
    expect(await item.getByRole("button", { name: "Request admin" }).count()).toBe(0);
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
  });

  it("never adds a limited-access Inbox item for admin connections", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { operatorScopes: FULL_SCOPES });
    await page.goto(`${server.baseUrl}chat`);
    await page.locator("openclaw-app-shell").waitFor();

    expect(await page.locator(".sidebar-issues-button__count").count()).toBe(0);
    expect(await page.locator('[data-attention-kind="scopeUpgrade"]').count()).toBe(0);
    expect(await page.getByRole("button", { name: "Request admin" }).count()).toBe(0);
    expect(await gateway.getRequests("device.scopes.requestUpgrade")).toHaveLength(0);
  });
});
