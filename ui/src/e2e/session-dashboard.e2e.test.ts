// Control UI E2E covers the real session-dashboard provider and transcript bridge.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
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

const sessionKey = "agent:main:dashboard";
const boardSnapshot = {
  sessionKey,
  revision: 1,
  tabs: [
    { tabId: "main", title: "Main", position: 0, chatDock: "right" },
    { tabId: "research", title: "Research", position: 1, chatDock: "right" },
  ],
  widgets: [
    {
      name: "status",
      tabId: "main",
      title: "Status",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "pending",
      revision: 1,
      frameUrl: "about:blank#status",
    },
    {
      name: "sources",
      tabId: "research",
      title: "Sources",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "pending",
      revision: 1,
      frameUrl: "about:blank#sources",
    },
  ],
};
const pinnedBoardSnapshot = {
  ...boardSnapshot,
  revision: 2,
  widgets: [
    ...boardSnapshot.widgets,
    {
      name: "canvas-cv_release",
      tabId: "main",
      title: "Release status",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 1,
      grantState: "pending",
      revision: 1,
      frameUrl: "about:blank#canvas-cv_release",
    },
  ],
};
const pinnedMcpAppBoardSnapshot = {
  ...boardSnapshot,
  revision: 2,
  widgets: [
    ...boardSnapshot.widgets,
    {
      name: "mcp-app-28b65635ecaa78ac",
      tabId: "main",
      title: "Demo App",
      contentKind: "mcp-app",
      sizeW: 6,
      sizeH: 4,
      position: 1,
      grantState: "pending",
      revision: 1,
      instanceId: "instance-pinned-app",
    },
  ],
};

async function showDashboard(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const settingsKey = "openclaw.control.settings.v1:ws://127.0.0.1:18789";
    const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Record<
      string,
      unknown
    >;
    settings.boardSessionViews = {
      [key]: { face: "dashboard", activeTabId: "main" },
    };
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  }, sessionKey);
}

describeControlUiE2e("Control UI session dashboard stitch", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("pins Canvas HTML, follows board commands, and persists dock resizing", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureCapabilities: [GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC],
      featureMethods: [
        "board.get",
        "board.update",
        "board.widget.grant",
        "board.widget.put",
        "chat.metadata",
        "chat.startup",
      ],
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "canvas",
              preview: {
                kind: "canvas",
                surface: "assistant_message",
                render: "url",
                title: "Release status",
                viewId: "cv_release",
                url: "/__openclaw__/canvas/documents/cv_release/index.html",
                preferredHeight: 240,
                sandbox: "scripts",
              },
            },
          ],
          timestamp: 1,
        },
      ],
      methodResponses: {
        "board.get": boardSnapshot,
        "board.widget.put": pinnedBoardSnapshot,
      },
    });
    await showDashboard(page);

    await page.goto(`${server.baseUrl}chat`);
    await expect
      .poll(async () => (await gateway.getRequests("board.get")).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await page.locator('wa-radio[value="dashboard"]').waitFor();
    await page.locator(".board-session-surface").waitFor();

    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    await preview.hover();
    await preview.getByRole("button", { name: "Pin to dashboard" }).click();
    await expect.poll(async () => (await gateway.getRequests("board.widget.put")).length).toBe(1);
    expect((await gateway.getRequests("board.widget.put"))[0]?.params).toEqual({
      sessionKey,
      name: "canvas-cv_release",
      title: "Release status",
      content: { kind: "canvas-doc", docId: "cv_release" },
    });
    await expect
      .poll(() => preview.getByRole("button", { name: "Pinned" }).isDisabled())
      .toBe(true);
    await gateway.setMethodResponse("board.get", pinnedBoardSnapshot);

    await gateway.emitGatewayEvent("board.command", {
      sessionKey,
      command: { kind: "focus_tab", tabId: "research" },
    });
    const researchTab = page.locator('[data-board-tab-id="research"]');
    await expect.poll(() => researchTab.getAttribute("active")).not.toBeNull();

    const divider = page.locator(".board-session-surface__divider");
    const dock = page.locator(".board-session-surface__chat");
    await divider.focus();
    await page.keyboard.press("End");
    await expect.poll(() => dock.getAttribute("style")).not.toBe("width: 420px");
    const persistedStyle = await dock.getAttribute("style");
    expect(persistedStyle).toMatch(/^width: \d+(?:\.\d+)?px$/u);

    await page.reload();
    await page.locator(".board-session-surface__chat").waitFor();
    expect(await page.locator(".board-session-surface__chat").getAttribute("style")).toBe(
      persistedStyle,
    );
    await expect
      .poll(() =>
        page.locator('.chat-tool-card__preview[data-kind="canvas"] [data-pin-widget]').isDisabled(),
      )
      .toBe(true);
    await context.close();
  });

  it("pins an inline MCP App using only its session-bound view identity", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureCapabilities: [],
      featureMethods: [
        "board.get",
        "board.widget.appView",
        "board.widget.put",
        "chat.metadata",
        "chat.startup",
      ],
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "canvas",
              preview: {
                kind: "canvas",
                surface: "assistant_message",
                render: "url",
                title: "Demo App",
                viewId: "outer-view-must-not-be-pinned",
                mcpApp: {
                  viewId: "view-session-bound",
                  serverName: "forbidden-server",
                  toolName: "forbidden-tool",
                  uiResourceUri: "ui://forbidden/app.html",
                  originSessionKey: sessionKey,
                  toolCallId: "forbidden-call",
                },
              },
            },
          ],
          timestamp: 1,
        },
      ],
      methodResponses: {
        "board.get": boardSnapshot,
        "board.widget.appView": {
          viewId: "view-pinned-lease",
          expiresAtMs: Date.now() + 60_000,
        },
        "board.widget.put": pinnedMcpAppBoardSnapshot,
      },
    });
    await showDashboard(page);

    await page.goto(`${server.baseUrl}chat`);
    await page.locator(".board-session-surface").waitFor();
    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    await preview.hover();
    await preview.getByRole("button", { name: "Pin to dashboard" }).click();

    await expect.poll(async () => (await gateway.getRequests("board.widget.put")).length).toBe(1);
    expect((await gateway.getRequests("board.widget.put"))[0]?.params).toEqual({
      sessionKey,
      name: "mcp-app-28b65635ecaa78ac",
      title: "Demo App",
      content: { kind: "mcp-app", viewId: "view-session-bound" },
    });
    await expect
      .poll(() => preview.getByRole("button", { name: "Pinned" }).isDisabled())
      .toBe(true);
    await context.close();
  });
});
