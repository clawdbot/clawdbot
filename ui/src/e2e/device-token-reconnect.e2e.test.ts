// Control UI tests cover browser-native device-token isolation and reuse.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { gatewayCredentialScope, gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
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

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();
const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];
const ROSITA_GATEWAY_URL = "wss://gateway.example/rosita";
const WILFRED_GATEWAY_URL = "wss://gateway.example/wilfred";
const ROSITA_DEVICE_TOKEN = "rosita-device-token";
const WILFRED_DEVICE_TOKEN = "wilfred-device-token";
const WILFRED_ROTATED_TOKEN = "wilfred-rotated-device-token";

const requireRecord = createRequireRecord("record", "expected-object-value");

function readConnectAuth(request: { params?: unknown }): Record<string, unknown> | undefined {
  const auth = requireRecord(request.params).auth;
  return auth == null ? undefined : requireRecord(auth);
}

function requireConnectAuth(request: { params?: unknown }): Record<string, unknown> {
  return requireRecord(readConnectAuth(request));
}

function browserPageGatewayUrl(appBaseUrl: string): string {
  const parsed = new URL(appBaseUrl);
  const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${parsed.host}`;
}

async function selectGatewayOnNextLoad(
  page: Page,
  appBaseUrl: string,
  gatewayUrl: string,
): Promise<void> {
  const settingsKey = `openclaw.control.settings.v1:${gatewayOriginScope(gatewayUrl)}`;
  const selectionKey =
    `openclaw.control.currentGateway.v1:` + gatewayOriginScope(browserPageGatewayUrl(appBaseUrl));
  await page.addInitScript(
    ({ nextGatewayUrl, nextSelectionKey, nextSettingsKey }) => {
      localStorage.setItem(nextSettingsKey, JSON.stringify({ gatewayUrl: nextGatewayUrl }));
      localStorage.setItem(nextSelectionKey, nextGatewayUrl);
    },
    {
      nextGatewayUrl: gatewayUrl,
      nextSelectionKey: selectionKey,
      nextSettingsKey: settingsKey,
    },
  );
}

async function openGatewayPage(params: {
  appBaseUrl: string;
  context: BrowserContext;
  deviceToken: string;
  gatewayUrl: string;
  methodResponses?: Record<string, unknown>;
  route?: string;
  sharedToken?: string;
}) {
  const page = await params.context.newPage();
  await selectGatewayOnNextLoad(page, params.appBaseUrl, params.gatewayUrl);
  const gateway = await installMockGateway(page, {
    deviceToken: params.deviceToken,
    methodResponses: params.methodResponses,
  });
  const tokenFragment = params.sharedToken
    ? `#token=${encodeURIComponent(params.sharedToken)}`
    : "";
  const response = await page.goto(`${params.appBaseUrl}${params.route ?? "chat"}${tokenFragment}`);
  expect(response?.status()).toBe(200);
  const connect = await gateway.waitForRequest("connect");
  await page.locator("openclaw-app-shell").waitFor();
  return { connect, gateway, page };
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

async function captureProof(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(proofDir, name) });
}

describeControlUiE2e("Control UI device-token reconnect E2E", () => {
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

  it("isolates device tokens across gateways, origins, and revocation", async () => {
    const context = await createContext();
    const rositaSource = await openGatewayPage({
      appBaseUrl: server.baseUrl,
      context,
      deviceToken: ROSITA_DEVICE_TOKEN,
      gatewayUrl: ROSITA_GATEWAY_URL,
      sharedToken: "shared-rosita",
    });
    expect(requireConnectAuth(rositaSource.connect).token).toBe("shared-rosita");

    const wilfredSource = await openGatewayPage({
      appBaseUrl: server.baseUrl,
      context,
      deviceToken: WILFRED_DEVICE_TOKEN,
      gatewayUrl: WILFRED_GATEWAY_URL,
      sharedToken: "shared-wilfred",
    });
    expect(requireConnectAuth(wilfredSource.connect).token).toBe("shared-wilfred");

    const rositaReconnect = await openGatewayPage({
      appBaseUrl: server.baseUrl,
      context,
      deviceToken: ROSITA_DEVICE_TOKEN,
      gatewayUrl: ROSITA_GATEWAY_URL,
      route: "sessions",
    });
    expect(requireConnectAuth(rositaReconnect.connect)).toMatchObject({
      deviceToken: ROSITA_DEVICE_TOKEN,
      token: ROSITA_DEVICE_TOKEN,
    });
    expect(await rositaReconnect.page.locator("openclaw-login-gate").count()).toBe(0);
    await captureProof(rositaReconnect.page, "rosita-reconnected.png");

    const wilfredReconnect = await openGatewayPage({
      appBaseUrl: server.baseUrl,
      context,
      deviceToken: WILFRED_DEVICE_TOKEN,
      gatewayUrl: WILFRED_GATEWAY_URL,
    });
    expect(requireConnectAuth(wilfredReconnect.connect)).toMatchObject({
      deviceToken: WILFRED_DEVICE_TOKEN,
      token: WILFRED_DEVICE_TOKEN,
    });
    expect(await wilfredReconnect.page.locator("openclaw-login-gate").count()).toBe(0);

    const identity = await wilfredSource.page.evaluate(() => {
      const raw = localStorage.getItem("openclaw-device-identity-v1");
      return raw ? JSON.parse(raw) : null;
    });
    const deviceId = requireRecord(identity).deviceId;
    if (typeof deviceId !== "string") {
      throw new Error("Expected the browser device identity to contain a deviceId");
    }

    const otherOriginBaseUrl = server.baseUrl.replace("127.0.0.1", "localhost");
    const otherOrigin = await openGatewayPage({
      appBaseUrl: otherOriginBaseUrl,
      context,
      deviceToken: "other-origin-device-token",
      gatewayUrl: ROSITA_GATEWAY_URL,
    });
    expect(readConnectAuth(otherOrigin.connect)?.token).toBeUndefined();
    expect(readConnectAuth(otherOrigin.connect)?.deviceToken).toBeUndefined();

    const wilfredDevices = await openGatewayPage({
      appBaseUrl: server.baseUrl,
      context,
      deviceToken: WILFRED_DEVICE_TOKEN,
      gatewayUrl: WILFRED_GATEWAY_URL,
      methodResponses: {
        "device.pair.list": {
          paired: [
            {
              deviceId,
              displayName: "This browser",
              roles: ["operator"],
              scopes: OPERATOR_SCOPES,
              tokens: [
                {
                  createdAtMs: Date.now(),
                  role: "operator",
                  scopes: OPERATOR_SCOPES,
                },
              ],
            },
          ],
          pending: [],
        },
        "device.token.revoke": {},
        "device.token.rotate": {
          deviceId,
          role: "operator",
          scopes: OPERATOR_SCOPES,
          token: WILFRED_ROTATED_TOKEN,
          rotatedAtMs: Date.now(),
          tokenDelivery: "in-band",
        },
        "node.list": { nodes: [] },
      },
      // Exercise the legacy /nodes alias while asserting the renamed Devices surface.
      route: "nodes",
    });
    expect(requireConnectAuth(wilfredDevices.connect).token).toBe(WILFRED_DEVICE_TOKEN);
    await wilfredDevices.gateway.waitForRequest("device.pair.list");
    const deviceEntry = wilfredDevices.page.locator(".device-entry").filter({
      has: wilfredDevices.page.getByText("This browser", { exact: true }),
    });
    await deviceEntry.waitFor();
    await deviceEntry.locator("details.device-entry__details > summary").click();
    const revokeButton = deviceEntry.getByRole("button", { name: "Revoke", exact: true });
    await revokeButton.waitFor({ state: "visible" });
    await revokeButton.scrollIntoViewIfNeeded();
    await captureProof(wilfredDevices.page, "wilfred-before-revoke.png");
    await revokeButton.click();
    // Revoke confirms in-page, not through window.confirm: webviews without a dialog
    // bridge silently answer false and would drop the action with no visible outcome.
    const revokeConfirm = wilfredDevices.page.locator("openclaw-modal-dialog");
    await revokeConfirm.getByText("Revoke the operator token?").waitFor();
    await revokeConfirm.getByText(`Device ID: ${deviceId}`).waitFor();
    await revokeConfirm.getByRole("button", { name: "Revoke", exact: true }).click();
    const revoke = await wilfredDevices.gateway.waitForRequest("device.token.revoke");
    expect(revoke.params).toEqual({ deviceId, role: "operator" });
    const wilfredStoreKey =
      `openclaw.device.auth.v1:` + gatewayCredentialScope(WILFRED_GATEWAY_URL);
    await expect
      .poll(() =>
        wilfredDevices.page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          if (!raw) {
            return undefined;
          }
          const store = JSON.parse(raw) as { tokens?: Record<string, unknown> };
          return store.tokens?.operator;
        }, wilfredStoreKey),
      )
      .toBeUndefined();

    const rositaAfterRevoke = await openGatewayPage({
      appBaseUrl: server.baseUrl,
      context,
      deviceToken: ROSITA_DEVICE_TOKEN,
      gatewayUrl: ROSITA_GATEWAY_URL,
    });
    expect(requireConnectAuth(rositaAfterRevoke.connect)).toMatchObject({
      deviceToken: ROSITA_DEVICE_TOKEN,
      token: ROSITA_DEVICE_TOKEN,
    });

    const wilfredAfterRevoke = await openGatewayPage({
      appBaseUrl: server.baseUrl,
      context,
      deviceToken: WILFRED_DEVICE_TOKEN,
      gatewayUrl: WILFRED_GATEWAY_URL,
    });
    expect(readConnectAuth(wilfredAfterRevoke.connect)?.token).toBeUndefined();
    expect(readConnectAuth(wilfredAfterRevoke.connect)?.deviceToken).toBeUndefined();

    // Rotation hands back the only copy of the new credential, so it is revealed in-page:
    // window.prompt rendered nothing in a webview without a dialog bridge. This runs last
    // because Escape also exits the Settings takeover behind the dialog — pre-existing
    // shell behavior shared by every modal — which must not disturb the assertions above.
    await deviceEntry.getByRole("button", { name: "Rotate", exact: true }).click();
    const rotateReveal = wilfredDevices.page.locator("openclaw-modal-dialog");
    await rotateReveal.getByText("New operator token").waitFor();
    await rotateReveal.getByText(WILFRED_ROTATED_TOKEN).waitFor();
    await captureProof(wilfredDevices.page, "wilfred-rotated-token.png");
    await wilfredDevices.page.keyboard.press("Escape");
    await rotateReveal
      .getByText("This dialog stays open until you confirm the token is saved.")
      .waitFor();
    await rotateReveal.getByText(WILFRED_ROTATED_TOKEN).waitFor({ state: "visible" });
    await rotateReveal.getByRole("button", { name: "I saved this token", exact: true }).click();
    await rotateReveal.waitFor({ state: "detached" });
  });
});
