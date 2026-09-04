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

async function openCommenterBoard(page: Page) {
  const origin = new URL(controlUi.baseUrl).origin;
  const documentHtml = buildWidgetDocument(
    "Release dashboard",
    `<style>
      body { min-height: 320px; padding: 32px; background: var(--surface); }
      .panel { max-width: 520px; padding: 28px; border: 1px solid var(--border); border-radius: 16px; background: var(--card); }
      button { margin-top: 20px; }
      #edge-target { position: fixed; inset: 2px auto auto 2px; width: 10px; height: 10px; margin: 0; padding: 0; }
    </style>
    <button id="edge-target" aria-label="Edge target"></button>
    <main class="panel">
      <h1>Release dashboard</h1>
      <p>Review the candidate before promotion.</p>
      <button id="save-profile" class="primary">Promote release</button>
    </main>`,
  );
  const frameUrl = `${origin}/__openclaw__/board/${encodeURIComponent(sessionKey)}/release-dashboard/index.html?bt=ticket`;
  await page.route("**/__openclaw__/board/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: documentHtml }),
  );
  const gateway = await installMockGateway(page, {
    sessionKey,
    featureMethods: ["board.get", "chat.metadata", "chat.send", "chat.startup"],
    methodResponses: {
      "board.get": {
        sessionKey,
        revision: 1,
        tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
        widgets: [
          {
            name: "release-dashboard",
            tabId: "main",
            title: "Release dashboard",
            contentKind: "html",
            sizeW: 8,
            sizeH: 6,
            heightMode: "fixed",
            position: 0,
            grantState: "none",
            revision: 1,
            frameUrl,
            viewTicket: "ticket",
            viewTicketTtlMs: 1_200_000,
            viewGeneration: "0123456789abcdef0123456789abcdef",
            sandboxUrl: buildBoardWidgetSandboxPath({ grantState: "none" }),
            sandboxPort,
          },
        ],
      },
    },
  });
  await openDashboard(page);
  return gateway;
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

  it("comments on a specific shared Canvas HTML element from the Dashboard side panel", async () => {
    const recordProof = process.env.OPENCLAW_UI_E2E_RECORD === "1";
    const proofDir = recordProof ? createControlUiE2eArtifactDir("canvas-element-commenter") : "";
    const context = await browser.newContext({
      permissions: ["local-network-access"],
      viewport: { width: 1280, height: 800 },
      ...(recordProof
        ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
        : {}),
    });
    contexts.add(context);
    const page = await context.newPage();
    const video = page.video();
    const gateway = await openCommenterBoard(page);
    const outer = page.locator(".board-widget__frame");
    await outer.waitFor();
    const outerFrame = await outer.elementHandle().then((handle) => handle?.contentFrame());
    await expect.poll(() => outerFrame?.childFrames().length ?? 0).toBe(1);
    const widgetFrame = outerFrame!.childFrames()[0]!;
    const target = widgetFrame.locator("#save-profile");
    await target.waitFor();
    if (recordProof) {
      await page.screenshot({ path: path.join(proofDir, "inactive.png") });
    }

    const dashboardHeader = page.locator(".side-panel__header");
    const toggle = dashboardHeader.getByRole("button", { name: "Annotate page" });
    expect(
      await page
        .locator(".chat-pane__header-trailing")
        .getByRole("button", {
          name: "Annotate page",
        })
        .count(),
    ).toBe(0);
    await toggle.click();
    await page.locator("[data-canvas-comment-overlay]").waitFor();
    await dashboardHeader.getByRole("button", { name: "Exit annotate mode" }).waitFor();
    const edgeBounds = await widgetFrame.locator("#edge-target").boundingBox();
    expect(edgeBounds).not.toBeNull();
    await page.mouse.move(
      edgeBounds!.x + edgeBounds!.width / 2,
      edgeBounds!.y + edgeBounds!.height / 2,
    );
    await expect
      .poll(() => page.locator(".board-widget__comment-label").textContent())
      .toContain("#edge-target");
    const edgeHighlightBounds = await page
      .locator(".board-widget__comment-highlight")
      .boundingBox();
    expect(edgeHighlightBounds).not.toBeNull();
    expect(Math.abs(edgeHighlightBounds!.x - edgeBounds!.x)).toBeLessThan(2);
    expect(Math.abs(edgeHighlightBounds!.y - edgeBounds!.y)).toBeLessThan(2);
    if (recordProof) {
      await page.screenshot({ path: path.join(proofDir, "annotating.png") });
      await page.waitForTimeout(600);
    }
    const targetBounds = await target.boundingBox();
    expect(targetBounds).not.toBeNull();
    await page.mouse.move(
      targetBounds!.x + targetBounds!.width / 2,
      targetBounds!.y + targetBounds!.height / 2,
    );
    await expect
      .poll(() => page.locator(".board-widget__comment-label").textContent())
      .toContain("#save-profile");
    if (recordProof) {
      await page.waitForTimeout(900);
    }
    await page.mouse.click(
      targetBounds!.x + targetBounds!.width / 2,
      targetBounds!.y + targetBounds!.height / 2,
    );
    const commentInput = page.getByRole("textbox", {
      name: "Comment on selected Canvas element",
    });
    await commentInput.fill("Make this action less prominent.");
    if (recordProof) {
      await page.screenshot({ path: path.join(proofDir, "comment-editor.png") });
      await page.waitForTimeout(700);
    }
    await page.getByRole("button", { name: "Comment on selected Canvas element" }).click();
    const stageAnnotations = dashboardHeader.getByRole("button", {
      name: "Send to chat",
    });
    await expect.poll(() => stageAnnotations.isEnabled()).toBe(true);
    expect(await page.locator(".chat-browser-annotation-group").count()).toBe(0);
    await page.keyboard.press("Escape");
    await toggle.click();
    await page.mouse.click(
      targetBounds!.x + targetBounds!.width / 2,
      targetBounds!.y + targetBounds!.height / 2,
    );
    await commentInput.fill("This in-flight capture must be discarded.");
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>(".board-widget__comment-submit")?.click();
      document.querySelector<HTMLButtonElement>('[aria-label="Clear"]')?.click();
    });
    await expect.poll(() => page.locator(".board-widget__comment-marker").count()).toBe(0);
    await page.waitForTimeout(100);
    expect(await page.locator(".board-widget__comment-marker").count()).toBe(0);

    await page.mouse.click(
      targetBounds!.x + targetBounds!.width / 2,
      targetBounds!.y + targetBounds!.height / 2,
    );
    await commentInput.fill("Make this action less prominent.");
    await page.getByRole("button", { name: "Comment on selected Canvas element" }).click();
    await expect.poll(() => stageAnnotations.isEnabled()).toBe(true);
    if (recordProof) {
      await page.screenshot({ path: path.join(proofDir, "annotation-toolbar.png") });
      await page.waitForTimeout(900);
    }
    await stageAnnotations.click();
    const annotationGroup = page.locator(".chat-browser-annotation-group");
    await annotationGroup.waitFor();
    await annotationGroup.locator(".chat-browser-annotation-group__summary").hover();
    const annotationPopover = annotationGroup.locator(".chat-browser-annotation-group__popover");
    await expect
      .poll(() => annotationPopover.getAttribute("aria-label"))
      .toBe("Browser annotation");
    await annotationPopover.getByText("#save-profile", { exact: true }).waitFor();
    await annotationPopover
      .getByText("Make this action less prominent.", { exact: true })
      .waitFor();
    await annotationPopover.locator("img").waitFor();
    if (recordProof) {
      await page.screenshot({ path: path.join(proofDir, "composer-hover.png") });
      await page.waitForTimeout(900);
    }

    const composer = page.locator(
      ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
    );
    await composer.fill("Please apply this feedback.");
    if (recordProof) {
      await page.waitForTimeout(700);
    }
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(1);
    const sent = (await gateway.getRequests("chat.send"))[0]?.params as { message?: unknown };
    expect(sent.message).toContain("Make this action less prominent.");
    expect(sent.message).toContain("#save-profile");
    await page.getByText("Please apply this feedback.", { exact: true }).waitFor();
    expect(await page.getByText("I annotated the page", { exact: false }).count()).toBe(0);
    await page.waitForTimeout(recordProof ? 1_000 : 100);

    await page.close();
    if (recordProof && video) {
      await video.saveAs(path.join(proofDir, "canvas-element-commenter.webm"));
    }
    await context.close();
    contexts.delete(context);
  });

  it("drops a Canvas capture when its originating Board becomes inactive", async () => {
    const context = await browser.newContext({
      permissions: ["local-network-access"],
      viewport: { width: 1280, height: 800 },
    });
    contexts.add(context);
    const page = await context.newPage();
    await openCommenterBoard(page);
    await page
      .locator(".side-panel__header")
      .getByRole("button", { name: "Annotate page" })
      .click();
    await page.locator("[data-canvas-comment-overlay]").waitFor();

    const outerFrame = await page
      .locator(".board-widget__frame")
      .elementHandle()
      .then((handle) => handle?.contentFrame());
    await expect.poll(() => outerFrame?.childFrames().length ?? 0).toBe(1);
    const targetBounds = await outerFrame!.childFrames()[0]!.locator("#save-profile").boundingBox();
    expect(targetBounds).not.toBeNull();
    await page.mouse.move(
      targetBounds!.x + targetBounds!.width / 2,
      targetBounds!.y + targetBounds!.height / 2,
    );
    await expect
      .poll(() => page.locator(".board-widget__comment-label").textContent())
      .toContain("#save-profile");
    await page.mouse.click(
      targetBounds!.x + targetBounds!.width / 2,
      targetBounds!.y + targetBounds!.height / 2,
    );
    await page
      .getByRole("textbox", { name: "Comment on selected Canvas element" })
      .fill("This capture must stay with its originating Board.");
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>(".board-widget__comment-submit")?.click();
      document.querySelector<HTMLButtonElement>(".side-panel__minimize")?.click();
    });

    await page.locator(".board-session-surface").waitFor({ state: "hidden" });
    await expect.poll(() => page.locator(".board-widget__comment-marker").count()).toBe(0);
    expect(await page.locator(".chat-browser-annotation-group").count()).toBe(0);
    await page.close();
    await context.close();
    contexts.delete(context);
  });

  for (const colorScheme of ["dark", "light"] as const) {
    it(`renders a v0.9 widget with the ${colorScheme} scrollbar theme`, async () => {
      const context = await browser.newContext({
        colorScheme,
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
