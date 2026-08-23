// Dashboard A2UI E2E covers the real renderer, sandbox proxy, and tier-1 board bridge.
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { buildBoardWidgetSandboxPath } from "../../../src/gateway/board-sandbox.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { getGatewayE2ePortBlock } from "../../../src/gateway/test-helpers.e2e.js";
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
const sessionKey = "agent:main:board-a2ui";
const screenshotPath = "/tmp/pr-b-shots/a2ui-board.png";
const basicCatalog = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

let browser: Browser;
let controlUi: ControlUiE2eServer;
let sandboxServer: HttpServer;
let sandboxPort: number;
let rendererServer: HttpServer;
let rendererOrigin: string;
let rendererBundle: Buffer;
const contexts = new Set<BrowserContext>();

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
  await page.goto(`${controlUi.baseUrl}dashboard`);
  await page.locator(".board-session-surface").waitFor();
}

describeControlUiE2e("Control UI dashboard A2UI", () => {
  beforeAll(async () => {
    execFileSync(process.execPath, ["extensions/canvas/scripts/bundle-a2ui.mjs"], {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    rendererBundle = await readFile(
      path.resolve("extensions/canvas/src/host/a2ui/a2ui-v0.9.bundle.js"),
    );
    rendererServer = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(rendererBundle);
    });
    await new Promise<void>((resolve) => {
      rendererServer.listen(0, "127.0.0.1", resolve);
    });
    const rendererAddress = rendererServer.address();
    if (!rendererAddress || typeof rendererAddress === "string") {
      throw new Error("A2UI renderer server did not bind");
    }
    rendererOrigin = `http://127.0.0.1:${rendererAddress.port}`;
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
    if (rendererServer) {
      await new Promise<void>((resolve) => {
        rendererServer.close(() => resolve());
      });
    }
    await controlUi?.close();
  });

  it("renders a v0.9 widget and routes its action to a tier-1 state event", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      permissions: ["local-network-access"],
      viewport: { width: 1280, height: 800 },
    });
    contexts.add(context);
    const page = await context.newPage();
    const origin = new URL(controlUi.baseUrl).origin;
    const rendererUrl = `${rendererOrigin}/__openclaw__/cap/canvas-proof/__openclaw__/a2ui/a2ui-v0.9.bundle.js`;
    const messages = [
      {
        version: "v0.9",
        createSurface: { surfaceId: "main", catalogId: basicCatalog },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "main",
          components: [
            { id: "root", component: "Column", children: ["title", "action"] },
            { id: "title", component: "Text", text: "A2UI board widget" },
            {
              id: "action",
              component: "Button",
              child: "action-label",
              variant: "primary",
              action: { event: { name: "refresh", context: {} } },
            },
            { id: "action-label", component: "Text", text: "Refresh data" },
          ],
        },
      },
    ];
    const boot = JSON.stringify({ messages, actionTier: "state" }).replaceAll("<", "\\u003c");
    const documentHtml = buildWidgetDocument(
      "A2UI controls",
      `<script>globalThis.openclawA2UIBoot=${boot};</script><style>html,body{height:100%;background:transparent}openclaw-a2ui-host{display:block;height:100%}</style><openclaw-a2ui-host></openclaw-a2ui-host><script src="${rendererUrl}"></script>`,
      { scriptOrigins: [rendererOrigin] },
    );
    const frameUrl = `${origin}/__openclaw__/board/${encodeURIComponent(sessionKey)}/a2ui-controls/index.html?bt=ticket`;
    await page.route("**/__openclaw__/board/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: documentHtml }),
    );
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: ["board.event", "board.get", "chat.metadata", "chat.startup"],
      methodResponses: {
        "board.get": {
          sessionKey,
          revision: 1,
          tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
          widgets: [
            {
              name: "a2ui-controls",
              tabId: "main",
              title: "A2UI controls",
              contentKind: "plugin",
              pluginKind: "canvas:a2ui",
              kindLabel: "A2UI",
              sizeW: 8,
              sizeH: 5,
              position: 0,
              grantState: "none",
              revision: 1,
              instanceId: "a2ui-instance",
              frameUrl,
              viewTicket: "ticket",
              viewTicketTtlMs: 1_200_000,
              viewGeneration: "0123456789abcdef0123456789abcdef",
              sandboxUrl: buildBoardWidgetSandboxPath({
                grantState: "none",
                resourceOrigins: [rendererOrigin],
              }),
              sandboxPort,
            },
          ],
        },
        "board.event": { ok: true, appended: true },
      },
    });

    await openDashboard(page);
    const outer = page.locator(".board-widget__frame");
    await outer.waitFor();
    const outerFrame = await outer.elementHandle().then((handle) => handle?.contentFrame());
    await expect
      .poll(
        async () => {
          const child = outerFrame?.childFrames()[0];
          if (!child) {
            return false;
          }
          try {
            return await child.evaluate(() =>
              Boolean(
                customElements.get("openclaw-a2ui-host") && Reflect.get(globalThis, "openclawA2UI"),
              ),
            );
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const widgetFrame = outerFrame!.childFrames()[0]!;
    await widgetFrame.getByText("A2UI board widget").waitFor();
    await widgetFrame.getByText("Refresh data").click();

    await expect.poll(async () => (await gateway.getRequests("board.event")).length).toBe(1);
    expect((await gateway.getRequests("board.event"))[0]?.params).toMatchObject({
      ticket: "ticket",
      payload: {
        eventType: "a2ui.action",
        action: { name: "refresh", surfaceId: "main", sourceComponentId: "action" },
      },
    });
    await expect
      .poll(() =>
        widgetFrame.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--surface"),
        ),
      )
      .not.toBe("");
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
  });
});
