// MCP Apps conformance uses the locked official ext-apps App implementation over real browser,
// Gateway WebSocket/HTTP, stdio MCP, and nested postMessage transports.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materializeBundleMcpToolsForRun } from "../../../src/agents/agent-bundle-mcp-materialize.js";
import {
  disposeAllSessionMcpRuntimes,
  getOrCreateSessionMcpRuntime,
} from "../../../src/agents/agent-bundle-mcp-runtime.js";
import { getMcpAppViewLease } from "../../../src/agents/mcp-ui-resource.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
} from "../../../src/config/config.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { startGatewayServer } from "../../../src/gateway/server.js";
import { getFreeGatewayPort } from "../../../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../../../src/test-utils/env.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const require = createRequire(import.meta.url);
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeConformance = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const authValue = "test";
const sessionKey = "agent:main:mcp-app-conformance";

let browser: Browser;
let controlUiServer: ControlUiE2eServer;
let gateway: Awaited<ReturnType<typeof startGatewayServer>>;
let gatewayPort: number;
let sandboxPort: number;
let tempRoot: string;
let viewId: string;
let appAssetServer: HttpServer | undefined;
let runtime: Awaited<ReturnType<typeof getOrCreateSessionMcpRuntime>>;
let envSnapshot: ReturnType<typeof captureEnv>;

const openContexts = new Set<BrowserContext>();

async function waitForText(locator: Locator, expected: string): Promise<void> {
  await expect.poll(() => locator.textContent({ timeout: 500 })).toBe(expected);
}

async function waitForTextContaining(
  locator: Locator,
  expected: string,
  present = true,
): Promise<void> {
  const assertion = expect.poll(() => locator.textContent());
  if (present) {
    await assertion.toContain(expected);
  } else {
    await assertion.not.toContain(expected);
  }
}

function appHtml(appModuleUrl: string): string {
  return `<!doctype html>
<meta charset="utf-8" />
<button id="call-app">Call app tool</button>
<button id="call-model">Call model tool</button>
<button id="read-resource">Read resource</button>
<button id="request-teardown">Request teardown</button>
<output id="initialized">pending</output>
<output id="capabilities"></output>
<output id="ping"></output>
<output id="input"></output>
<output id="result"></output>
<output id="app-tool"></output>
<output id="model-tool"></output>
<output id="resource"></output>
<output id="isolation"></output>
<script type="module">
import { App, McpUiResourceTeardownResultSchema } from ${JSON.stringify(appModuleUrl)};
const write = (id, value) => { document.getElementById(id).textContent = value; };
try { void window.top.document; write("isolation", "failed"); } catch { write("isolation", "isolated"); }
const app = new App({ name: "OpenClaw conformance fixture", version: "1.0.0" });
app.ontoolinput = ({ arguments: args }) => write("input", JSON.stringify(args ?? {}));
app.ontoolresult = (value) => write("result", JSON.stringify(value.structuredContent ?? value));
app.onteardown = async () => ({});
app.onerror = (error) => console.error("mcp-conformance-app", error);
document.getElementById("call-app").onclick = async () => {
  try {
    const value = await app.callServerTool({ name: "app_companion", arguments: {} });
    write("app-tool", JSON.stringify(value.structuredContent ?? value));
  } catch (error) { write("app-tool", "denied:" + error); }
};
document.getElementById("call-model").onclick = async () => {
  try { await app.callServerTool({ name: "model_only", arguments: {} }); write("model-tool", "allowed"); }
  catch (error) { write("model-tool", "denied:" + error); }
};
document.getElementById("read-resource").onclick = async () => {
  try {
    const value = await app.readServerResource({ uri: "data://conformance/value" });
    write("resource", JSON.stringify(value));
  } catch (error) { write("resource", "denied:" + error); }
};
document.getElementById("request-teardown").onclick = () => app.requestTeardown();
await app.connect();
write("capabilities", JSON.stringify(app.getHostCapabilities() ?? {}));
write("ping", JSON.stringify(await app.request(
  { method: "ping", params: {} },
  McpUiResourceTeardownResultSchema,
)));
write("initialized", "ready");
</script>`;
}

async function writeFixtureServer(
  serverPath: string,
  html: string,
  resourceOrigin: string,
): Promise<void> {
  const sdkMcpServerPath = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const sdkStdioServerPath = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  await fs.writeFile(
    serverPath,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(sdkMcpServerPath)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioServerPath)};
const appUri = "ui://conformance/app";
const server = new McpServer({ name: "mcp-app-conformance", version: "1.0.0" });
const show = server.tool("show", "Show the conformance app", async () => ({
  content: [{ type: "text", text: "initial-result" }],
  structuredContent: { value: "initial-result" },
}));
show.update({ _meta: { ui: { resourceUri: appUri } } });
const appOnly = server.tool("app_companion", "App-only companion", async () => ({
  content: [{ type: "text", text: "companion-called" }],
  structuredContent: { value: "companion-called" },
}));
appOnly.update({ _meta: { ui: { visibility: ["app"] } } });
const modelOnly = server.tool("model_only", "Model-only tool", async () => ({
  content: [{ type: "text", text: "model-called" }],
}));
modelOnly.update({ _meta: { ui: { visibility: ["model"] } } });
server.registerResource("conformance_app", appUri, { mimeType: "text/html;profile=mcp-app" }, async (uri) => ({
  contents: [{
    uri: uri.href,
    mimeType: "text/html;profile=mcp-app",
    text: ${JSON.stringify(html)},
    _meta: { ui: { csp: { resourceDomains: [${JSON.stringify(resourceOrigin)}] } } },
  }],
}));
server.registerResource("conformance_data", "data://conformance/value", { mimeType: "text/plain" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/plain", text: "resource-ok" }],
}));
await server.connect(new StdioServerTransport());
`,
    { encoding: "utf8", mode: 0o755 },
  );
}

async function findAppFrame(page: Page): Promise<Frame> {
  try {
    await expect
      .poll(
        async () => {
          for (const frame of page.frames()) {
            if ((await frame.locator("#initialized").count()) > 0) {
              return 1;
            }
          }
          return 0;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
  } catch (error) {
    const component = await page.evaluate(() => {
      const view = document.querySelector("mcp-app-view");
      return {
        exists: Boolean(view),
        error: view?.shadowRoot?.querySelector(".error")?.textContent ?? null,
        shadow: view?.shadowRoot?.textContent ?? null,
      };
    });
    throw new Error(
      `MCP App inner frame not found: ${JSON.stringify({ component, frames: page.frames().map((frame) => frame.url()) })}`,
      { cause: error },
    );
  }
  let frame: Frame | undefined;
  for (const candidate of page.frames()) {
    if ((await candidate.locator("#initialized").count()) > 0) {
      frame = candidate;
      break;
    }
  }
  if (!frame) {
    throw new Error("MCP App inner frame not found");
  }
  await waitForText(frame.locator("#initialized"), "ready");
  return frame;
}

async function mountControlUiHost(page: Page): Promise<void> {
  await page.route(`${controlUiServer.baseUrl}mcp-conformance`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main id="mount"></main>
<script type="module">
import { GatewayBrowserClient } from "/src/api/gateway.ts";
import "/src/components/mcp-app-view-registration.ts";
window.mcpConformanceGatewayBrowserClient = GatewayBrowserClient;
</script>`,
    });
  });
  await page.goto(`${controlUiServer.baseUrl}mcp-conformance`);
  await page.evaluate(
    async (params) => {
      const GatewayBrowserClient = Reflect.get(
        window,
        "mcpConformanceGatewayBrowserClient",
      ) as new (options: Record<string, unknown>) => {
        start(): void;
        request(method: string, params: unknown): Promise<unknown>;
      };
      let resolveHello!: () => void;
      let rejectHello!: (error: Error) => void;
      const connected = new Promise<void>((resolve, reject) => {
        resolveHello = resolve;
        rejectHello = reject;
      });
      const client = new GatewayBrowserClient({
        url: params.gatewayUrl,
        token: params.authValue,
        onHello: () => resolveHello(),
        onClose: (info: { reason: string }) =>
          rejectHello(new Error(`Gateway connection closed: ${info.reason}`)),
      });
      client.start();
      await Promise.race([
        connected,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Gateway connection timed out")), 10_000);
        }),
      ]);
      const view = document.createElement("mcp-app-view");
      Reflect.set(view, "context", {
        gateway: {
          snapshot: { client },
          connection: { gatewayUrl: params.gatewayUrl },
        },
      });
      view.sessionKey = params.sessionKey;
      view.viewId = params.viewId;
      view.title = "Conformance app";
      document.getElementById("mount")?.appendChild(view);
      Object.assign(window, { mcpConformanceClient: client, mcpConformanceView: view });
    },
    {
      gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
      authValue,
      sessionKey,
      viewId,
    },
  );
}

async function requestStandaloneUrl(page: Page): Promise<string> {
  return await page.evaluate(
    async (params) => {
      const client = Reflect.get(window, "mcpConformanceClient") as {
        request(method: string, params: unknown): Promise<unknown>;
      };
      const payload = (await client.request("mcp.app.view", {
        sessionKey: params.sessionKey,
        viewId: params.viewId,
      })) as {
        standaloneUrl: string;
      };
      return payload.standaloneUrl;
    },
    { sessionKey, viewId },
  );
}

describeConformance("MCP App Control UI and standalone host conformance", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_SKIP_CHANNELS",
      "OPENCLAW_SKIP_CRON",
      "OPENCLAW_SKIP_PROVIDERS",
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
    ]);
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-app-conformance-"));
    const stateDir = path.join(tempRoot, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const fixturePath = path.join(tempRoot, "fixture-server.mjs");
    await fs.mkdir(path.join(tempRoot, "empty-plugins"), { recursive: true });
    controlUiServer = await startControlUiE2eServer();
    const appEntryPath = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
    const appModuleSource = await fs.readFile(appEntryPath, "utf8");
    const appAssetPort = await getFreeGatewayPort();
    const fixtureAssetServer = createHttpServer((request, response) => {
      if (request.url !== "/app.js") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": "text/javascript; charset=utf-8",
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      response.end(appModuleSource);
    });
    appAssetServer = fixtureAssetServer;
    await new Promise<void>((resolve) => {
      fixtureAssetServer.listen(appAssetPort, "127.0.0.1", resolve);
    });
    const appModuleUrl = `http://127.0.0.1:${appAssetPort}/app.js`;
    const resourceOrigin = new URL(appModuleUrl).origin;
    const controlUiOrigin = new URL(controlUiServer.baseUrl).origin;
    await writeFixtureServer(fixturePath, appHtml(appModuleUrl), resourceOrigin);
    gatewayPort = await getFreeGatewayPort();
    do {
      sandboxPort = await getFreeGatewayPort();
    } while (sandboxPort === gatewayPort);
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "token", token: authValue },
        controlUi: { allowedOrigins: [controlUiOrigin] },
      },
      mcp: {
        apps: { enabled: true, sandboxPort },
        servers: { conformance: { command: process.execPath, args: [fixturePath], cwd: tempRoot } },
      },
    };
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    setTestEnvValue("HOME", tempRoot);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", authValue);
    setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
    setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
    setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(tempRoot, "empty-plugins"));
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    runtime = await getOrCreateSessionMcpRuntime({
      sessionId: `mcp-app-conformance-${randomUUID()}`,
      sessionKey,
      workspaceDir: tempRoot,
      cfg,
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    materialized.restrictAppTools?.([...materialized.tools, ...(materialized.appTools ?? [])]);
    const show = materialized.tools.find((tool) => tool.name === "conformance__show");
    if (!show) {
      throw new Error("Official MCP App fixture tool did not materialize");
    }
    const result = await show.execute("mcp-app-conformance-call", { city: "Paris" });
    viewId =
      (result.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } }).mcpAppPreview?.mcpApp
        ?.viewId ?? "";
    if (!viewId) {
      throw new Error("MCP App fixture did not create a view");
    }
    const startupConfigSnapshotRead = await readConfigFileSnapshotWithPluginMetadata({
      observe: false,
    });
    gateway = await startGatewayServer(gatewayPort, {
      bind: "loopback",
      auth: { mode: "token", token: authValue },
      controlUiEnabled: false,
      startupConfigSnapshotRead,
    });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 120_000);

  afterAll(async () => {
    for (const context of openContexts) {
      await context.close();
    }
    await browser?.close();
    await gateway?.close({ reason: "MCP App conformance complete" });
    await disposeAllSessionMcpRuntimes();
    if (appAssetServer) {
      await new Promise<void>((resolve, reject) => {
        appAssetServer?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await controlUiServer?.close();
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    envSnapshot?.restore();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("drives the authenticated Control UI bridge and read-only standalone host", async () => {
    const controlContext = await browser.newContext({ permissions: ["local-network-access"] });
    openContexts.add(controlContext);
    const controlPage = await controlContext.newPage();
    const browserDiagnostics: string[] = [];
    controlPage.on("console", (message) => {
      browserDiagnostics.push(`console:${message.type()}:${message.text()}`);
    });
    controlPage.on("requestfailed", (request) => {
      browserDiagnostics.push(`requestfailed:${request.url()}:${request.failure()?.errorText}`);
    });
    controlPage.on("response", (response) => {
      if (response.url().includes("mcp-app-sandbox")) {
        browserDiagnostics.push(`response:${response.status()}:${response.url()}`);
      }
    });
    await mountControlUiHost(controlPage);
    let app: Frame;
    try {
      app = await findAppFrame(controlPage);
    } catch (error) {
      throw new Error(`${String(error)}; browser=${JSON.stringify(browserDiagnostics)}`, {
        cause: error,
      });
    }
    await waitForText(app.locator("#input"), '{"city":"Paris"}');
    await waitForTextContaining(app.locator("#result"), "initial-result");
    await waitForTextContaining(app.locator("#capabilities"), "serverTools");
    await waitForTextContaining(app.locator("#capabilities"), "serverResources");
    await waitForText(app.locator("#ping"), "{}");
    await waitForText(app.locator("#isolation"), "isolated");
    await app.locator("#call-app").click();
    await waitForTextContaining(app.locator("#app-tool"), "companion-called");
    await app.locator("#call-model").click();
    await waitForTextContaining(app.locator("#model-tool"), "denied:");
    await app.locator("#read-resource").click();
    await waitForTextContaining(app.locator("#resource"), "resource-ok");

    const standaloneUrl = await requestStandaloneUrl(controlPage);
    await controlPage.evaluate(() => Reflect.get(window, "mcpConformanceView")?.remove());

    const standaloneContext = await browser.newContext({ permissions: ["local-network-access"] });
    openContexts.add(standaloneContext);
    const authorizationHeaders: string[] = [];
    standaloneContext.on("request", (request) => {
      const authorization = request.headers().authorization;
      if (authorization) {
        authorizationHeaders.push(authorization);
      }
    });
    const standalonePage = await standaloneContext.newPage();
    const absoluteStandaloneUrl = `http://127.0.0.1:${gatewayPort}${standaloneUrl}`;
    await standalonePage.goto(absoluteStandaloneUrl);
    app = await findAppFrame(standalonePage);
    await waitForText(app.locator("#input"), '{"city":"Paris"}');
    await waitForTextContaining(app.locator("#result"), "initial-result");
    await waitForTextContaining(app.locator("#capabilities"), "serverTools", false);
    await waitForTextContaining(app.locator("#capabilities"), "serverResources", false);
    await waitForText(app.locator("#ping"), "{}");
    await waitForText(app.locator("#isolation"), "isolated");
    await app.locator("#call-app").click();
    await waitForTextContaining(app.locator("#app-tool"), "denied:");
    await app.locator("#read-resource").click();
    await waitForTextContaining(app.locator("#resource"), "denied:");
    expect(authorizationHeaders).toHaveLength(1);
    expect(authorizationHeaders[0]).toMatch(/^MCP-App v1\./u);
    expect(authorizationHeaders).not.toContain(`Bearer ${authValue}`);

    await app.locator("#request-teardown").click();
    await expect.poll(() => standalonePage.frames().length).toBe(1);
    await standalonePage.reload();
    app = await findAppFrame(standalonePage);
    await waitForTextContaining(app.locator("#result"), "initial-result");

    const tampered = `${absoluteStandaloneUrl.slice(0, -1)}${absoluteStandaloneUrl.endsWith("a") ? "b" : "a"}`;
    await standalonePage.goto(tampered);
    await standalonePage.reload();
    await waitForText(standalonePage.locator(".error"), "MCP App ticket was rejected");

    const lease = getMcpAppViewLease(viewId, runtime);
    if (!lease) {
      throw new Error("MCP App view lease missing");
    }
    const expiresAtMs = Date.now() + 2_000;
    lease.expiresAtMs = expiresAtMs;
    const expiring = await requestStandaloneUrl(controlPage);
    const expiringUrl = `http://127.0.0.1:${gatewayPort}${expiring}`;
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, expiresAtMs - Date.now() + 50));
    });
    await standalonePage.goto(expiringUrl);
    await standalonePage.reload();
    await waitForText(standalonePage.locator(".error"), "MCP App ticket was rejected");
  }, 90_000);
});
