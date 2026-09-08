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
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  clickBoardWidgetControl,
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { installA2uiFailureDiagnostics } from "./board-a2ui.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const sessionKey = "agent:main:board-a2ui";
const scrollbarProofLabel = process.env.OPENCLAW_WIDGET_SCROLLBAR_PROOF_LABEL;
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
      // Init scripts also run in opaque widget frames; only the dashboard owns settings.
      if (window !== window.top) {
        return;
      }
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
    browser = await chromium.launch({
      executablePath: chromiumExecutablePath,
      ignoreDefaultArgs: ["--hide-scrollbars"],
    });
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

  for (const { colorScheme, rejectsAction, name } of [
    ...(["dark", "light"] as const).map((theme) => ({
      colorScheme: theme,
      rejectsAction: false,
      name: `renders a v0.9 widget with the ${theme} scrollbar theme`,
    })),
    {
      colorScheme: "light" as const,
      rejectsAction: true,
      name: "shows rejected v0.9 actions and clears the widget on reset",
    },
  ]) {
    it(name, async ({ onTestFailed }) => {
      const context = await browser.newContext({
        colorScheme,
        permissions: ["local-network-access"],
        viewport: { width: 1280, height: 800 },
      });
      contexts.add(context);
      const page = await context.newPage();
      const pageErrors: string[] = [];
      let pageErrorCount = 0;
      page.on("pageerror", (error) => {
        pageErrorCount += 1;
        if (pageErrors.length < 8) {
          pageErrors.push(error.message.slice(0, 512));
        }
      });
      const diagnostics = await installA2uiFailureDiagnostics(page);
      let actionStage = "opening dashboard";
      onTestFailed(async () => {
        console.error(
          "[board-a2ui] action diagnostics",
          JSON.stringify({
            colorScheme,
            actionStage,
            pageErrorCount,
            pageErrors,
            ...(await diagnostics.snapshot()),
          }),
        );
      });
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
        `<script>globalThis.openclawA2UIBoot=${boot};</script><style>html,body{height:100%;background:var(--surface)}body{min-height:2400px}openclaw-a2ui-host{display:block;height:100%}</style><openclaw-a2ui-host></openclaw-a2ui-host><script src="${rendererUrl}"></script>`,
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
                heightMode: "fixed",
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
                  customElements.get("openclaw-a2ui-host") &&
                  Reflect.get(globalThis, "openclawA2UI"),
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
      diagnostics.target(widgetFrame);
      await widgetFrame.getByText("A2UI board widget").waitFor();
      await expect
        .poll(() => outer.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      expect(await outer.getAttribute("inert")).toBeNull();
      if (rejectsAction) {
        actionStage = "installing oversized action";
        await widgetFrame.evaluate(() => {
          Reflect.get(globalThis, "openclawA2UI").applyMessages([
            {
              version: "v0.9",
              updateComponents: {
                surfaceId: "main",
                components: [
                  {
                    id: "action",
                    component: "Button",
                    child: "action-label",
                    variant: "primary",
                    action: {
                      event: { name: "refresh", context: { diagnostic: "x".repeat(8193) } },
                    },
                  },
                ],
              },
            },
          ]);
        });
        actionStage = "clicking oversized action";
        await clickBoardWidgetControl(page, widgetFrame.getByText("Refresh data"));
        actionStage = "waiting for rejected-action alert";
        await expect
          .poll(() => widgetFrame.getByRole("alert").allTextContents())
          .toEqual(["widget state payload exceeds 8192 UTF-8 bytes"]);
        expect(await widgetFrame.getByRole("alert").isVisible()).toBe(true);
        expect(await gateway.getRequests("board.event")).toHaveLength(0);
        expect(pageErrors).toEqual([]);

        actionStage = "resetting renderer after rejection";
        await widgetFrame.evaluate(() => Reflect.get(globalThis, "openclawA2UI").reset());
        await expect.poll(() => widgetFrame.getByRole("alert").count()).toBe(0);
        await expect.poll(() => widgetFrame.locator("a2ui-surface").count()).toBe(0);
        await widgetFrame.evaluate(
          (initialMessages) =>
            Reflect.get(globalThis, "openclawA2UI").applyMessages(initialMessages),
          messages,
        );
        await widgetFrame.getByText("A2UI board widget").waitFor();
      }
      actionStage = "waiting for native pointer entry and clicking refresh";
      await clickBoardWidgetControl(page, widgetFrame.getByText("Refresh data"));
      actionStage = "waiting for board.event";
      await expect.poll(async () => (await gateway.getRequests("board.event")).length).toBe(1);
      actionStage = "validating delivered action and scrollbar";
      expect((await gateway.getRequests("board.event"))[0]?.params).toMatchObject({
        ticket: "ticket",
        payload: {
          eventType: "a2ui.action",
          action: { name: "refresh", surfaceId: "main", sourceComponentId: "action" },
        },
      });
      if (rejectsAction) {
        expect(await widgetFrame.getByRole("alert").count()).toBe(0);
        expect(pageErrors).toEqual([]);
        return;
      }
      await page.mouse.move(40, 40);

      const scrollbar = await widgetFrame.evaluate(() => {
        const root = document.documentElement;
        const probe = document.createElement("div");
        probe.style.background = "var(--scrollbar-thumb)";
        document.body.append(probe);
        const expectedThumb = getComputedStyle(probe).backgroundColor;
        probe.style.background = "var(--scrollbar-thumb-hover)";
        const expectedThumbHover = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const styles = getComputedStyle(root);
        return {
          background: getComputedStyle(root, "::-webkit-scrollbar").backgroundColor,
          colorScheme: styles.colorScheme,
          expectedBackground: getComputedStyle(document.body).backgroundColor,
          expectedThumb,
          expectedThumbHover,
          ratio: root.clientHeight / root.scrollHeight,
          size: styles.getPropertyValue("--scrollbar-size"),
          thumbBackground: getComputedStyle(root, "::-webkit-scrollbar-thumb").backgroundColor,
          trackBackground: getComputedStyle(root, "::-webkit-scrollbar-track").backgroundColor,
          width: getComputedStyle(root, "::-webkit-scrollbar").width,
        };
      });
      expect(scrollbar).toMatchObject({
        colorScheme,
        expectedBackground: expect.any(String),
        expectedThumb: expect.not.stringMatching(/^(?:rgba\(0, 0, 0, 0\)|transparent)$/),
        expectedThumbHover: expect.not.stringMatching(/^(?:rgba\(0, 0, 0, 0\)|transparent)$/),
        size: "12px",
        trackBackground: "rgba(0, 0, 0, 0)",
        width: "12px",
      });
      expect(scrollbar.background).toBe(scrollbar.expectedBackground);
      expect([scrollbar.expectedThumb, scrollbar.expectedThumbHover]).toContain(
        scrollbar.thumbBackground,
      );
      expect(scrollbar.ratio).toBeLessThan(0.2);
      expect(pageErrors).toEqual([]);
      if (scrollbarProofLabel) {
        const screenshotPath = path.resolve(
          createControlUiE2eArtifactDir("widget-scrollbar"),
          `${scrollbarProofLabel}-${colorScheme}.png`,
        );
        await mkdir(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ animations: "disabled", path: screenshotPath, fullPage: true });
      }
    });
  }
});
