// Control UI tests cover server preference replay and reconciliation through real reconnects.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function configResponse(prefs: Record<string, unknown>, hash: string) {
  const config = { ui: { prefs } };
  return {
    config,
    hash,
    configRevisionHash: hash,
    appliedConfigHash: hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe("object");
  expect(Array.isArray(value), label).toBe(false);
  return value as Record<string, unknown>;
}

function patchPrefs(request: MockGatewayRequest): Record<string, unknown> {
  const params = requireRecord(request.params, "config.patch params");
  expect(Object.hasOwn(params, "baseHash")).toBe(false);
  expect(typeof params.raw).toBe("string");
  const parsed = requireRecord(JSON.parse(String(params.raw)), "config.patch raw");
  const ui = requireRecord(parsed.ui, "config.patch ui");
  return requireRecord(ui.prefs, "config.patch ui.prefs");
}

async function createContext(): Promise<BrowserContext> {
  return browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
}

async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await gateway.getRequests(method)).length, { timeout: 10_000 })
    .toBe(count);
}

async function proxyReconnect(
  page: Page,
  gateway: MockGatewayControls,
  whileDisconnected: () => Promise<void>,
): Promise<void> {
  const socketCountBefore = await gateway.getSocketCount();
  await gateway.closeLatest(1001, "proxy idle timeout");
  await gateway.setOnline(false);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { gateway: { snapshot: { phase: string } } } };
        };
        return app.runtime?.context.gateway.snapshot.phase;
      }),
    )
    .toBe("reconnecting");
  await whileDisconnected();
  expect(await gateway.getRequests("config.patch")).toHaveLength(0);
  await expect
    .poll(() => gateway.getSocketCount(), { timeout: 10_000 })
    .toBeGreaterThan(socketCountBefore);
  await gateway.setOnline(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { gateway: { snapshot: { phase: string } } } };
        };
        return app.runtime?.context.gateway.snapshot.phase;
      }),
    )
    .toBe("connected");
  await page.locator(".settings-page").waitFor({ timeout: 10_000 });
}

async function readSettingsMirror(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith("openclaw.control.settings.v1:"),
    );
    if (!key) {
      return null;
    }
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  });
}

function themeCard(page: Page, theme: "claw" | "knot") {
  return page.locator(`.settings-theme-card--${theme}`);
}

async function expectThemeActive(page: Page, theme: "claw" | "knot"): Promise<void> {
  await expect
    .poll(() => themeCard(page, theme).getAttribute("class"), { timeout: 10_000 })
    .toContain("settings-theme-card--active");
}

describeControlUiE2e("Control UI server prefs reconnect sync", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not available at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("replays an offline theme edit after a same-client reconnect", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const initial = configResponse({ theme: "claw", themeMode: "system" }, "prefs-a-1");
    const committed = configResponse({ theme: "knot", themeMode: "system" }, "prefs-a-2");
    const gateway = await installMockGateway(page, {
      methodResponses: { "config.get": initial },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await themeCard(page, "claw").waitFor();
      await gateway.waitForRequest("config.get");
      const configGetsBeforeEdit = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("config.patch");

      await proxyReconnect(page, gateway, async () => {
        await themeCard(page, "knot").click();
        await expectThemeActive(page, "knot");
      });

      const patch = await gateway.waitForRequest("config.patch");
      expect(patchPrefs(patch)).toEqual({ theme: "knot" });
      expect(await gateway.getRequests("config.get")).toHaveLength(configGetsBeforeEdit);

      await gateway.setMethodResponse("config.get", committed);
      await gateway.resolveDeferred("config.patch", committed);
      await waitForRequestCount(gateway, "config.get", configGetsBeforeEdit + 1);
      await expectThemeActive(page, "knot");
    } finally {
      await context.close();
    }
  });

  it("keeps disjoint edits from two pages after both hash-free patches", async () => {
    const contextA = await createContext();
    const contextB = await createContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const initial = configResponse({ theme: "claw" }, "prefs-b-1");
    const gatewayA = await installMockGateway(pageA, {
      methodResponses: { "config.get": initial },
    });
    const gatewayB = await installMockGateway(pageB, {
      methodResponses: { "config.get": initial },
    });

    try {
      await Promise.all([
        pageA.goto(`${server.baseUrl}settings/appearance`),
        pageB.goto(`${server.baseUrl}settings/appearance`),
      ]);
      await Promise.all([themeCard(pageA, "claw").waitFor(), themeCard(pageB, "claw").waitFor()]);
      await Promise.all([gatewayA.deferNext("config.patch"), gatewayB.deferNext("config.patch")]);

      await themeCard(pageA, "knot").click();
      const patchA = await gatewayA.waitForRequest("config.patch");
      const prefsA = patchPrefs(patchA);
      expect(prefsA).toEqual({ theme: "knot" });
      const themeCommitted = configResponse(prefsA, "prefs-b-2");
      await gatewayA.setMethodResponse("config.get", themeCommitted);
      await gatewayA.resolveDeferred("config.patch", themeCommitted);

      await pageB.locator("[data-settings-follow-up-mode]").selectOption("queue");
      const patchB = await gatewayB.waitForRequest("config.patch");
      const prefsB = patchPrefs(patchB);
      expect(prefsB).toEqual({ chatFollowUpMode: "queue" });
      expect(Object.keys(prefsA).some((key) => Object.hasOwn(prefsB, key))).toBe(false);
      const combined = configResponse({ ...prefsA, ...prefsB }, "prefs-b-3");
      await gatewayB.setMethodResponse("config.get", combined);
      await gatewayB.resolveDeferred("config.patch", combined);
      await gatewayA.setMethodResponse("config.get", combined);
      await gatewayA.emitGatewayEvent("config.changed", {
        path: "/tmp/openclaw.json",
        hash: "prefs-b-3",
        ts: Date.now(),
      });

      await expectThemeActive(pageA, "knot");
      await expectThemeActive(pageB, "knot");
      await expect
        .poll(() => readSettingsMirror(pageA))
        .toMatchObject({
          chatFollowUpMode: "queue",
          theme: "knot",
        });
      await expect
        .poll(() => readSettingsMirror(pageB))
        .toMatchObject({
          chatFollowUpMode: "queue",
          theme: "knot",
        });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  it("applies a server delta without reverting a pending local key", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const initial = configResponse({ locale: "en", theme: "claw" }, "prefs-c-1");
    const gateway = await installMockGateway(page, {
      methodResponses: { "config.get": initial },
    });

    try {
      await page.goto(`${server.baseUrl}settings/appearance`);
      await themeCard(page, "claw").waitFor();
      await gateway.waitForRequest("config.get");
      const initialConfigGets = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("config.patch");

      await themeCard(page, "knot").click();
      const patch = await gateway.waitForRequest("config.patch");
      expect(patchPrefs(patch)).toEqual({ theme: "knot" });

      const serverChanged = configResponse({ locale: "de", theme: "claw" }, "prefs-c-2");
      await gateway.setMethodResponse("config.get", serverChanged);
      await gateway.emitGatewayEvent("config.changed", {
        path: "/tmp/openclaw.json",
        hash: "prefs-c-2",
        ts: Date.now(),
      });
      await waitForRequestCount(gateway, "config.get", initialConfigGets + 1);

      await expectThemeActive(page, "knot");
      await expect
        .poll(() => readSettingsMirror(page))
        .toMatchObject({
          locale: "de",
          theme: "knot",
        });

      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "mock validation failure",
      });
      await expectThemeActive(page, "knot");
    } finally {
      await context.close();
    }
  });
});
