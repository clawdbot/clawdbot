// Dashboard MCP App E2E covers the real Control UI, sandbox proxy, and mocked Gateway lease flow.
import type { Server as HttpServer } from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { getFreeGatewayPort } from "../../../src/gateway/test-helpers.e2e.js";
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
const sessionKey = "agent:main:board-mcp-app";

let browser: Browser;
let controlUi: ControlUiE2eServer;
let sandboxServer: HttpServer;
let sandboxPort: number;
const contexts = new Set<BrowserContext>();

function widget(index: number) {
  return {
    name: `app-${index}`,
    tabId: "main",
    title: `App ${index}`,
    contentKind: "mcp-app",
    sizeW: 12,
    sizeH: 3,
    position: index,
    grantState: "none",
    revision: 1,
    instanceId: `instance-${index}`,
  } as const;
}

function boardSnapshot(count: number) {
  return {
    sessionKey,
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: Array.from({ length: count }, (_, index) => widget(index)),
  };
}

async function openDashboard(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const settingsKey = "openclaw.control.settings.v1:ws://127.0.0.1:18789";
    const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Record<
      string,
      unknown
    >;
    settings.boardSessionViews = { [key]: { face: "dashboard", activeTabId: "main" } };
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  }, sessionKey);
  await page.goto(`${controlUi.baseUrl}chat`);
  await page.locator(".board-session-surface").waitFor();
}

function appViewPayload() {
  return {
    sandboxUrl: "/mcp-app-sandbox",
    sandboxPort,
    html: "<!doctype html><output>Dashboard app</output>",
    toolInput: {},
    toolResult: { content: [{ type: "text", text: "ready" }] },
    messageSupported: false,
    updateModelContextSupported: false,
  };
}

async function waitForMountedApp(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Boolean(document.querySelector("mcp-app-view")?.shadowRoot?.querySelector("iframe")),
    undefined,
    { timeout: 15_000 },
  );
}

describeControlUiE2e("Control UI dashboard MCP Apps", () => {
  beforeAll(async () => {
    controlUi = await startControlUiE2eServer();
    sandboxPort = await getFreeGatewayPort();
    sandboxServer = createSandboxHostHttpServer();
    await new Promise<void>((resolve) => {
      sandboxServer.listen(sandboxPort, "127.0.0.1", resolve);
    });

    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 120_000);

  afterAll(async () => {
    for (const context of contexts) {
      await context.close();
    }
    await browser?.close();
    if (sandboxServer) {
      await new Promise<void>((resolve) => {
        sandboxServer.close(() => resolve());
      });
    }
    await controlUi?.close();
  });

  it("renders a pinned app and proactively renews its board lease", async () => {
    const context = await browser.newContext({ permissions: ["local-network-access"] });
    contexts.add(context);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: [
        "board.get",
        "board.widget.appView",
        "chat.history",
        "chat.metadata",
        "chat.startup",
        "mcp.app.view",
      ],
      methodResponses: {
        "board.get": boardSnapshot(1),
        "board.widget.appView": {
          sequence: [
            { viewId: "short-view", expiresAtMs: Date.now() + 7_000 },
            { viewId: "renewed-view", expiresAtMs: Date.now() + 3_600_000 },
          ],
        },
        "mcp.app.view": appViewPayload(),
      },
    });

    await openDashboard(page);
    await expect
      .poll(async () => (await gateway.getRequests("board.widget.appView")).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    await waitForMountedApp(page);
    await expect
      .poll(async () => (await gateway.getRequests("board.widget.appView")).length, {
        timeout: 15_000,
      })
      .toBe(2);
    expect((await gateway.getRequests("board.widget.appView"))[0]?.params).toEqual({
      sessionKey,
      name: "app-0",
      revision: 1,
      instanceId: "instance-0",
    });
  });

  it("does not eagerly mint leases for all 48 offscreen cells", async () => {
    const context = await browser.newContext({
      permissions: ["local-network-access"],
      viewport: { width: 1280, height: 800 },
    });
    contexts.add(context);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: [
        "board.get",
        "board.widget.appView",
        "chat.history",
        "chat.metadata",
        "chat.startup",
        "mcp.app.view",
      ],
      methodResponses: {
        "board.get": boardSnapshot(48),
        "board.widget.appView": { viewId: "shared-view", expiresAtMs: Date.now() + 3_600_000 },
        "mcp.app.view": appViewPayload(),
      },
    });

    await openDashboard(page);
    await expect
      .poll(async () => (await gateway.getRequests("board.widget.appView")).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    await waitForMountedApp(page);
    await page.waitForTimeout(500);
    const requests = await gateway.getRequests("board.widget.appView");
    expect(requests.length).toBeLessThan(48);
  });
});
