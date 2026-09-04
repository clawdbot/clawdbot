// Dashboard MCP App E2E covers the real Control UI, sandbox proxy, and mocked Gateway lease flow.
import type { Server as HttpServer } from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { getGatewayE2ePortBlock } from "../../../src/gateway/test-helpers.e2e.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
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

function boardSnapshot(count: number, revision = 1) {
  return {
    sessionKey,
    revision,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: Array.from({ length: count }, (_, index) => widget(index)),
  };
}

async function openDashboard(page: Page): Promise<void> {
  const settingsKey = controlUiBundledSettingsStorageKey(controlUi.baseUrl);
  await page.addInitScript(
    ({ key, storageKey }) => {
      const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<
        string,
        unknown
      >;
      settings.boardSessionViews = { [key]: { activeTabId: "main" } };
      localStorage.setItem(storageKey, JSON.stringify(settings));
    },
    { key: sessionKey, storageKey: settingsKey },
  );
  await page.goto(controlUiSessionUrl(controlUi.baseUrl, sessionKey, "dashboard"));
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

async function cycleBoardProviderConnection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const surface = document.querySelector(".board-session-surface");
    const pane = surface?.closest("openclaw-chat-pane");
    const lease = pane ? Reflect.get(pane, "boardProviderLease") : undefined;
    const scopedProvider = lease?.provider;
    const transport = scopedProvider ? Reflect.get(scopedProvider, "transport") : undefined;
    const client = transport ? Reflect.get(transport, "client") : undefined;
    if (!transport || !client || typeof transport.attachClient !== "function") {
      throw new Error("Dashboard Gateway provider is unavailable");
    }
    transport.attachClient(client, false);
    transport.attachClient(client, true);
  });
}

async function captureBoardIdentity(page: Page): Promise<void> {
  await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".board-session-surface");
    const board = surface?.querySelector("openclaw-board-view");
    const cell = board?.querySelector("openclaw-board-widget-cell");
    const appView = cell?.querySelector("mcp-app-view");
    const iframe = appView?.shadowRoot?.querySelector("iframe");
    if (!surface || !board || !cell || !appView || !iframe) {
      throw new Error("Board MCP App identity is incomplete");
    }
    Reflect.set(window, "__openclawBoardIdentity", { surface, board, cell, appView, iframe });
  });
}

async function readBoardIdentity(page: Page) {
  return await page.evaluate(() => {
    const stored = Reflect.get(window, "__openclawBoardIdentity") as {
      surface: HTMLElement;
      board: Element;
      cell: Element;
      appView: Element;
      iframe: Element;
    };
    const surface = document.querySelector<HTMLElement>(".board-session-surface");
    const board = surface?.querySelector("openclaw-board-view");
    const cell = board?.querySelector("openclaw-board-widget-cell");
    const appView = cell?.querySelector("mcp-app-view");
    const iframe = appView?.shadowRoot?.querySelector("iframe");
    return {
      connected: [stored.surface, stored.board, stored.cell, stored.appView, stored.iframe].every(
        (element) => element.isConnected,
      ),
      hidden: surface?.hidden ?? null,
      inert: surface?.inert ?? null,
      same:
        surface === stored.surface &&
        board === stored.board &&
        cell === stored.cell &&
        appView === stored.appView &&
        iframe === stored.iframe,
    };
  });
}

async function expectRetainedBoardPresentation(
  page: Page,
  presentation: "split" | "expanded",
): Promise<void> {
  await expect
    .poll(() => readBoardIdentity(page))
    .toEqual({ connected: true, hidden: false, inert: false, same: true });
  await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(true);
  await expect
    .poll(() => page.locator(".sidebar-region__right-runtime .side-panel").count())
    .toBe(1);
  await expect
    .poll(() => page.locator(".sidebar-region--expanded").count())
    .toBe(presentation === "expanded" ? 1 : 0);
  await expect
    .poll(() => page.locator(".chat-thread").isVisible())
    .toBe(presentation !== "expanded");
}

describeControlUiE2e("Control UI dashboard MCP Apps", () => {
  beforeAll(async () => {
    controlUi = await startControlUiE2eServer();
    sandboxPort = await getGatewayE2ePortBlock();
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
    const context = await browser.newContext({
      colorScheme: "dark",
      permissions: ["local-network-access"],
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
        timeout: 15_000,
      })
      .toBe(2);
    // Renewal replaces the iframe. The new-binding request follows teardown,
    // so wait for it before sampling the replacement's rendered background.
    await expect
      .poll(async () =>
        (await gateway.getRequests("mcp.app.view")).map((request) => request.params),
      )
      .toContainEqual({ sessionKey, viewId: "renewed-view" });
    await waitForMountedApp(page);
    const widgetBackgrounds = await page.evaluate(() => {
      const widgetElement = document.querySelector<HTMLElement>('[data-test-id="board-widget"]');
      const frame = document
        .querySelector("mcp-app-view")
        ?.shadowRoot?.querySelector<HTMLIFrameElement>("iframe");
      if (!widgetElement || !frame) {
        throw new Error("dashboard MCP App frame is missing");
      }
      return {
        frame: getComputedStyle(frame).backgroundColor,
        widget: getComputedStyle(widgetElement).backgroundColor,
      };
    });
    expect(widgetBackgrounds.frame).toBe(widgetBackgrounds.widget);
    expect(widgetBackgrounds.frame).not.toBe("rgba(0, 0, 0, 0)");
    expect((await gateway.getRequests("board.widget.appView"))[0]?.params).toEqual({
      sessionKey,
      agentId: "main",
      name: "app-0",
      revision: 1,
      instanceId: "instance-0",
    });
  });

  it("drops a pending app view across reconnect and mounts the current lease", async () => {
    const context = await browser.newContext({
      permissions: ["local-network-access"],
      viewport: { width: 1280, height: 800 },
    });
    contexts.add(context);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["board.widget.appView"],
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
          viewId: "current-view",
          expiresAtMs: Date.now() + 3_600_000,
        },
        "mcp.app.view": appViewPayload(),
      },
    });

    await openDashboard(page);
    await gateway.waitForRequest("board.widget.appView");
    await gateway.deferNext("board.widget.appView");
    const boardGetCount = (await gateway.getRequests("board.get")).length;
    await cycleBoardProviderConnection(page);
    await expect
      .poll(async () => (await gateway.getRequests("board.get")).length)
      .toBeGreaterThan(boardGetCount);

    await gateway.resolveDeferred("board.widget.appView", {
      viewId: "retired-view",
      expiresAtMs: Date.now() + 3_600_000,
    });
    await page.evaluate(
      async () =>
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(await gateway.getRequests("mcp.app.view")).toEqual([]);

    await expect
      .poll(async () => (await gateway.getRequests("board.widget.appView")).length)
      .toBe(2);
    await gateway.resolveDeferred("board.widget.appView", {
      viewId: "current-view",
      expiresAtMs: Date.now() + 3_600_000,
    });
    await waitForMountedApp(page);
    await expect
      .poll(async () =>
        (await gateway.getRequests("mcp.app.view")).map((request) => request.params),
      )
      .toContainEqual({
        sessionKey,
        viewId: "current-view",
      });
    expect(await gateway.getRequests("mcp.app.view")).not.toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ viewId: "retired-view" }),
      }),
    );
  });

  it("retains one board runtime across split, expanded, and inactive panel states", async () => {
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("board-panel-retention", artifactRoot)
      : undefined;
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
        "sessions.patch",
      ],
      methodResponses: {
        "board.get": boardSnapshot(1),
        "board.widget.appView": {
          viewId: "retained-view",
          expiresAtMs: Date.now() + 3_600_000,
        },
        "mcp.app.view": appViewPayload(),
        "tasks.list": { tasks: [] },
      },
    });

    await openDashboard(page);
    await waitForMountedApp(page);
    await captureBoardIdentity(page);
    const stableCounts = {
      boardGet: (await gateway.getRequests("board.get")).length,
      appView: (await gateway.getRequests("board.widget.appView")).length,
      mcpView: (await gateway.getRequests("mcp.app.view")).length,
    };
    const stablePatchCount = (await gateway.getRequests("sessions.patch")).length;
    const stableListCount = (await gateway.getRequests("sessions.list")).length;
    const sidePanel = page.locator(".sidebar-region__right-runtime .side-panel");
    const appContent = page
      .frameLocator("mcp-app-view iframe")
      .frameLocator("iframe")
      .getByText("Dashboard app", { exact: true });
    await expectRetainedBoardPresentation(page, "split");
    if (artifactDir) {
      await appContent.waitFor();
      await page.screenshot({ path: `${artifactDir}/01-dashboard.png`, fullPage: true });
    }

    await sidePanel.getByRole("button", { name: "Expand side panel" }).click();
    await expectRetainedBoardPresentation(page, "expanded");

    await sidePanel.getByRole("button", { name: "Collapse" }).click();
    await expectRetainedBoardPresentation(page, "split");

    const typeMenu = sidePanel.locator("wa-dropdown.side-panel-type-menu");
    await typeMenu.getByRole("button", { name: "Add side panel tab" }).click();
    await typeMenu.locator("wa-dropdown-item").filter({ hasText: "Tasks" }).click();
    await expect
      .poll(() => typeMenu.evaluate((element) => Reflect.get(element, "open")))
      .toBe(false);
    await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(false);
    const inactiveIdentity = await readBoardIdentity(page);
    if (artifactDir) {
      await page.screenshot({ path: `${artifactDir}/02-tasks.png`, fullPage: true });
    }

    await sidePanel.getByRole("tab", { name: "Dashboard", exact: true }).click();
    await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(true);
    if (artifactDir) {
      await appContent.waitFor();
      await page.screenshot({ path: `${artifactDir}/03-dashboard-restored.png`, fullPage: true });
    }
    expect(inactiveIdentity).toEqual({ connected: true, hidden: true, inert: true, same: true });
    await expectRetainedBoardPresentation(page, "split");
    expect(await gateway.getRequests("board.update")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.patch")).toHaveLength(stablePatchCount);
    expect(await gateway.getRequests("sessions.list")).toHaveLength(stableListCount);
    expect(await gateway.getRequests("board.get")).toHaveLength(stableCounts.boardGet);
    expect(await gateway.getRequests("board.widget.appView")).toHaveLength(stableCounts.appView);
    expect(await gateway.getRequests("mcp.app.view")).toHaveLength(stableCounts.mcpView);
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
