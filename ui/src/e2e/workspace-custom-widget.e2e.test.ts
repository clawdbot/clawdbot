// Control UI E2E for the L5 sandboxed custom-widget host against a mocked Gateway
// plus a page.route() that serves fixture widget assets with the REAL Content-
// Security-Policy header the plugin route emits. Covers the acceptance security
// list: approve flow, bridge getData round-trip with the L2 scaffold fixture,
// foreign-window message dropped, CSP blocking fetch(), throwing-widget isolation,
// and the constant sandbox attribute asserted in the DOM.
import { chromium, type Browser, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

// The strict CSP the plugin serving route emits (serve.ts WIDGET_CSP). Reproduced
// here so the fixture route mirrors production headers and the fetch()-blocked and
// sandbox assertions run against realistic frame constraints.
const WIDGET_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'";

let browser: Browser;
let server: ControlUiE2eServer;
const FRAME_TOKEN = "1111111111111111111111111111111111111111111";

function workspaceGatewayScenario() {
  return {
    controlUiTabs: [
      {
        pluginId: "workspaces",
        id: "workspaces",
        label: "Workspaces",
        group: "control",
        order: -10,
      },
    ],
    featureMethods: ["workspaces.get", "workspaces.widget.approve", "workspaces.widget.frame"],
  };
}

function frameMethodResponse() {
  return {
    "workspaces.widget.frame": {
      frameToken: FRAME_TOKEN,
      frameExpiresAt: Date.now() + 60 * 60 * 1000,
      manifest: {
        schemaVersion: 1,
        name: "revenue-chart",
        title: "Revenue Chart",
        entrypoint: "index.html",
        bindings: [{ id: "value", source: "static", value: 0 }],
        capabilities: ["data:read"],
      },
    },
  };
}

function workspaceDoc(version: number, status: "pending" | "approved", title = "Revenue Chart") {
  return {
    doc: {
      schemaVersion: 1,
      workspaceVersion: version,
      tabs: [
        {
          slug: "main",
          title: "Main",
          hidden: false,
          createdBy: "agent:main",
          widgets: [
            {
              id: "w_custom",
              kind: "custom:revenue-chart",
              title,
              grid: { x: 0, y: 0, w: 6, h: 4 },
              collapsed: false,
              createdBy: "agent:main",
              bindings: { value: { source: "static", value: { revenue: 4242 } } },
            },
          ],
        },
      ],
      widgetsRegistry: {
        "revenue-chart": { status, createdBy: "agent:main" },
      },
      prefs: { tabOrder: ["main"] },
    },
    workspaceVersion: version,
  };
}

// A framework-free fixture widget mirroring the L2 scaffold template: v1
// handshake, getData round-trip rendering into #value, and (for the CSP test) an
// attempt to fetch() that connect-src 'none' must block.
const FIXTURE_WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Revenue Chart</title></head>
<body>
<pre id="value">waiting</pre>
<pre id="fetch">idle</pre>
<footer id="footer">Built by agent:main</footer>
<script>
  const valueNode = document.getElementById("value");
  const fetchNode = document.getElementById("fetch");
  const bridge = window.openclawWorkspaceBridge;
  function post(type, payload = {}) { bridge.postMessage({ v: 1, type, ...payload }); }
  bridge.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || m.v !== 1) return;
    if (m.type === "workspace:data" || m.type === "workspace:push") {
      valueNode.textContent = JSON.stringify(m.data);
    } else if (m.type === "workspace:error") {
      valueNode.textContent = "error:" + m.code;
    }
  });
  post("workspace:ready");
  post("workspace:getData", { requestId: "initial", bindingId: "value" });
  // connect-src 'none' must reject this — the catch marks the widget as blocked.
  fetch("https://example.com/leak").then(
    () => { fetchNode.textContent = "fetch-allowed"; },
    () => { fetchNode.textContent = "fetch-blocked"; },
  );
</script>
</body></html>`;

const THROWING_WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body><script>throw new Error("widget boom");</script></body></html>`;

async function routeWidgetAssets(page: Page, html: string): Promise<void> {
  await page.route("**/plugins/workspaces/widgets/*/revenue-chart/**", (route: Route) => {
    const url = route.request().url();
    const segments = new URL(url).pathname.split("/");
    const widgetsIndex = segments.indexOf("widgets");
    const bridgeToken = widgetsIndex >= 0 ? segments[widgetsIndex + 1] : null;
    const bootstrap = bridgeToken
      ? `<script>(()=>{const channel=new MessageChannel();const listeners=new Set();const port=channel.port1;port.onmessage=(event)=>{for(const listener of listeners)listener(event)};port.start();Object.defineProperty(window,"openclawWorkspaceBridge",{configurable:false,writable:false,value:Object.freeze({postMessage:(message)=>port.postMessage(message),addEventListener:(type,listener)=>{if(type==="message")listeners.add(listener)},removeEventListener:(type,listener)=>{if(type==="message")listeners.delete(listener)}})});window.parent.postMessage({v:1,type:"workspace:bridge:init",token:"${bridgeToken}"},"*",[channel.port2])})();</script>`
      : "";
    const doctype = html.match(/^\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i)?.[0] ?? "";
    const body = `${doctype}${bootstrap}${html.slice(doctype.length)}`;
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: {
        "Content-Security-Policy": WIDGET_CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
      body,
    });
  });
}

async function gotoWorkspaces(page: Page, e2eServer: ControlUiE2eServer) {
  const response = await page.goto(`${e2eServer.baseUrl}plugin?plugin=workspaces&id=workspaces`);
  expect(response?.status()).toBe(200);
}

async function newPage(): Promise<Page> {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  return context.newPage();
}

async function waitForTwoAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

describeControlUiE2e("Control UI custom-widget host mocked Gateway E2E", () => {
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
    await browser?.close();
    await server?.close();
  });

  it("renders a pending widget as an approval card with NO iframe, then approves it", async () => {
    const page = await newPage();
    await routeWidgetAssets(page, FIXTURE_WIDGET_HTML);
    const gateway = await installMockGateway(page, {
      ...workspaceGatewayScenario(),
      methodResponses: {
        ...frameMethodResponse(),
        "workspaces.get": workspaceDoc(1, "pending"),
        "workspaces.widget.approve": { ok: true },
      },
    });
    try {
      await gotoWorkspaces(page, server);
      // Pending → approval card, no iframe.
      await page.locator('[data-test-id="workspace-custom-pending"]').waitFor({ timeout: 10_000 });
      expect(await page.locator("iframe").count()).toBe(0);

      // Approve → workspaces.widget.approve RPC, then a broadcast delivers the
      // approved doc; the iframe host mounts.
      await gateway.deferNext("workspaces.get");
      await page.locator('[data-test-id="workspace-custom-approve"]').click();
      await gateway.waitForRequest("workspaces.widget.approve");
      await gateway.emitGatewayEvent("plugin.workspaces.changed", { workspaceVersion: 2 });
      await gateway.resolveDeferred("workspaces.get", workspaceDoc(2, "approved"));

      const frame = page.locator('[data-test-id="workspace-custom-widget-frame"]');
      await frame.waitFor({ timeout: 10_000 });
      // Sandbox attribute is EXACTLY "allow-scripts".
      expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(await frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    } finally {
      await page.context().close();
    }
  });

  it("keeps the newest workspace when older reloads succeed or fail last", async () => {
    const page = await newPage();
    const gateway = await installMockGateway(page, {
      ...workspaceGatewayScenario(),
      methodResponses: {
        "workspaces.get": workspaceDoc(1, "pending", "Initial"),
      },
    });
    try {
      await gotoWorkspaces(page, server);
      const title = page.locator(".workspace-widget__title");
      await expect.poll(() => title.textContent()).toBe("Initial");
      await waitForTwoAnimationFrames(page);
      const initialRequestCount = (await gateway.getRequests("workspaces.get")).length;

      await gateway.deferNext("workspaces.get");
      await gateway.emitGatewayEvent("plugin.workspaces.changed", { workspaceVersion: 2 });
      await expect
        .poll(async () => (await gateway.getRequests("workspaces.get")).length)
        .toBe(initialRequestCount + 1);

      await gateway.deferNext("workspaces.get");
      await gateway.emitGatewayEvent("plugin.workspaces.changed", { workspaceVersion: 3 });
      await expect
        .poll(async () => (await gateway.getRequests("workspaces.get")).length)
        .toBe(initialRequestCount + 2);

      const requests = await gateway.getRequests("workspaces.get");
      const olderRequest = requests.at(-2);
      const newerRequest = requests.at(-1);
      expect(olderRequest?.id).toEqual(expect.any(String));
      expect(newerRequest?.id).toEqual(expect.any(String));

      await gateway.deliverLatest({
        type: "res",
        id: newerRequest?.id,
        ok: true,
        payload: workspaceDoc(3, "pending", "Newest"),
      });
      await expect.poll(() => title.textContent()).toBe("Newest");

      await gateway.deliverLatest({
        type: "res",
        id: olderRequest?.id,
        ok: true,
        payload: workspaceDoc(2, "pending", "Stale"),
      });
      await waitForTwoAnimationFrames(page);

      expect(await title.textContent()).toBe("Newest");

      await gateway.deferNext("workspaces.get");
      await gateway.emitGatewayEvent("plugin.workspaces.changed", { workspaceVersion: 4 });
      await expect
        .poll(async () => (await gateway.getRequests("workspaces.get")).length)
        .toBe(initialRequestCount + 3);

      await gateway.deferNext("workspaces.get");
      await gateway.emitGatewayEvent("plugin.workspaces.changed", { workspaceVersion: 5 });
      await expect
        .poll(async () => (await gateway.getRequests("workspaces.get")).length)
        .toBe(initialRequestCount + 4);

      const failureRequests = await gateway.getRequests("workspaces.get");
      const olderFailedRequest = failureRequests.at(-2);
      const newerSuccessfulRequest = failureRequests.at(-1);
      expect(olderFailedRequest?.id).toEqual(expect.any(String));
      expect(newerSuccessfulRequest?.id).toEqual(expect.any(String));

      await gateway.deliverLatest({
        type: "res",
        id: newerSuccessfulRequest?.id,
        ok: true,
        payload: workspaceDoc(5, "pending", "Newest after error"),
      });
      await expect.poll(() => title.textContent()).toBe("Newest after error");

      await gateway.deliverLatest({
        type: "res",
        id: olderFailedRequest?.id,
        ok: false,
        error: { code: "UNAVAILABLE", message: "stale failure" },
      });
      await waitForTwoAnimationFrames(page);

      expect(await title.textContent()).toBe("Newest after error");
    } finally {
      await page.context().close();
    }
  });

  it("round-trips getData with the fixture widget and blocks fetch() via CSP", async () => {
    const page = await newPage();
    await routeWidgetAssets(page, FIXTURE_WIDGET_HTML);
    await installMockGateway(page, {
      ...workspaceGatewayScenario(),
      methodResponses: {
        ...frameMethodResponse(),
        "workspaces.get": workspaceDoc(2, "approved"),
      },
    });
    try {
      await gotoWorkspaces(page, server);
      const frameEl = page.locator('[data-test-id="workspace-custom-widget-frame"]');
      await frameEl.waitFor({ timeout: 10_000 });
      const frame = page.frameLocator('[data-test-id="workspace-custom-widget-frame"]');
      // Bridge getData round-trip: the parent resolves the static binding and the
      // widget renders it.
      await expect
        .poll(async () => frame.locator("#value").textContent(), { timeout: 10_000 })
        .toContain("4242");
      // connect-src 'none' blocks the widget's fetch().
      await expect
        .poll(async () => frame.locator("#fetch").textContent(), { timeout: 10_000 })
        .toBe("fetch-blocked");
    } finally {
      await page.context().close();
    }
  });

  it("drops a postMessage from a foreign window (identity accept filter)", async () => {
    const page = await newPage();
    await routeWidgetAssets(page, FIXTURE_WIDGET_HTML);
    await installMockGateway(page, {
      ...workspaceGatewayScenario(),
      methodResponses: {
        ...frameMethodResponse(),
        "workspaces.get": workspaceDoc(2, "approved"),
      },
    });
    try {
      await gotoWorkspaces(page, server);
      const frameEl = page.locator('[data-test-id="workspace-custom-widget-frame"]');
      await frameEl.waitFor({ timeout: 10_000 });
      const frame = page.frameLocator('[data-test-id="workspace-custom-widget-frame"]');
      await expect
        .poll(async () => frame.locator("#value").textContent(), { timeout: 10_000 })
        .toContain("4242");
      // Post a spoofed data message from the PARENT window (event.source !== the
      // iframe's contentWindow). The bridge must ignore it: #value stays the
      // legitimate value and never shows the injected marker.
      await frame.locator("#value").evaluate((node) => {
        type SpoofObservationWindow = Window & {
          openclawSawSpoofed?: boolean;
          openclawSpoofObserver?: MutationObserver;
        };
        const targetWindow = window as SpoofObservationWindow;
        const valueNode = node as HTMLElement;
        const recordSpoof = () => {
          if (valueNode.textContent?.includes("SPOOFED")) {
            targetWindow.openclawSawSpoofed = true;
          }
        };
        targetWindow.openclawSawSpoofed = false;
        targetWindow.openclawSpoofObserver?.disconnect();
        targetWindow.openclawSpoofObserver = new MutationObserver(recordSpoof);
        targetWindow.openclawSpoofObserver.observe(valueNode, {
          characterData: true,
          childList: true,
          subtree: true,
        });
        recordSpoof();
      });
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          const onMessage = (event: MessageEvent) => {
            const data = event.data as { requestId?: string } | undefined;
            if (event.source !== window || data?.requestId !== "x") {
              return;
            }
            window.removeEventListener("message", onMessage);
            resolve();
          };
          window.addEventListener("message", onMessage);
          window.postMessage(
            { v: 1, type: "workspace:data", requestId: "x", bindingId: "value", data: "SPOOFED" },
            "*",
          );
        });
      });
      await frame.locator("#value").evaluate(async () => {
        type WidgetBridge = {
          postMessage: (message: unknown) => void;
          addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
          removeEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
        };
        const bridge = (window as Window & { openclawWorkspaceBridge?: WidgetBridge })
          .openclawWorkspaceBridge;
        if (!bridge) {
          throw new Error("workspace bridge unavailable");
        }
        await new Promise<void>((resolve) => {
          const onMessage = (event: MessageEvent) => {
            const data = event.data as { requestId?: string } | undefined;
            if (data?.requestId !== "after-spoof") {
              return;
            }
            bridge.removeEventListener("message", onMessage);
            resolve();
          };
          bridge.addEventListener("message", onMessage);
          const barrierRequest = {
            v: 1,
            type: "workspace:getData",
            requestId: "after-spoof",
            bindingId: "value",
          };
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- This is a MessagePort-style widget bridge, not Window.postMessage.
          bridge.postMessage(barrierRequest);
        });
      });
      const sawSpoofed = await frame.locator("#value").evaluate((node) => {
        type SpoofObservationWindow = Window & {
          openclawSawSpoofed?: boolean;
          openclawSpoofObserver?: MutationObserver;
        };
        const targetWindow = window as SpoofObservationWindow;
        targetWindow.openclawSpoofObserver?.disconnect();
        return targetWindow.openclawSawSpoofed === true || node.textContent?.includes("SPOOFED");
      });
      expect(sawSpoofed).toBe(false);
    } finally {
      await page.context().close();
    }
  });

  it("isolates a throwing widget to its own cell (kill test)", async () => {
    const page = await newPage();
    await routeWidgetAssets(page, THROWING_WIDGET_HTML);
    await installMockGateway(page, {
      ...workspaceGatewayScenario(),
      methodResponses: {
        ...frameMethodResponse(),
        "workspaces.get": workspaceDoc(2, "approved"),
      },
    });
    try {
      await gotoWorkspaces(page, server);
      // The host frame still mounts; the throw happens INSIDE the sandboxed iframe
      // and cannot break the parent shell (the tab strip and cell stay present).
      await page
        .locator('[data-test-id="workspace-custom-widget-frame"]')
        .waitFor({ timeout: 10_000 });
      await page.locator('[data-test-id="workspace-widget"]').waitFor({ timeout: 10_000 });
      // The parent SHELL survives the widget's throw: the workspace section and its
      // tab strip remain rendered and interactive (the throw is contained to the
      // opaque-origin iframe). We assert shell survival rather than the absence of a
      // pageerror string, because a sandboxed frame's own uncaught error can surface
      // on the parent as an opaque-origin SecurityError — which itself confirms the
      // iframe is cross-origin/isolated, not that the shell broke.
      await expect.poll(async () => page.locator('[data-test-id="workspace"]').count()).toBe(1);
      await expect
        .poll(async () => page.locator('[data-test-id="workspace-tab"]').count())
        .toBeGreaterThan(0);
      // No error leaked into the PARENT document body (the throw text stays inside
      // the sandboxed frame, never rendered by the shell).
      expect(await page.locator('[data-test-id="workspace"]').textContent()).not.toContain(
        "widget boom",
      );
    } finally {
      await page.context().close();
    }
  });
});
