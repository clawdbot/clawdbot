// MCP Apps conformance uses the locked official ext-apps App implementation over real browser,
// Gateway WebSocket/HTTP, stdio MCP, and nested postMessage transports.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Frame } from "playwright";
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
import { getGatewayE2ePortBlock } from "../../../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../../../src/test-utils/env.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  appHtml,
  closeMcpAppProofContext,
  createMcpAppFixtureControl,
  createMcpAppTeardownRecorder,
  type McpAppFixtureEvent as FixtureEvent,
  openMcpAppProofContext,
  observeMcpAppNetwork,
  findAppFrame,
  mountControlUiHost,
  recordMcpAppHost,
  readMcpAppHistoryNavigation,
  requestStandaloneUrl,
  waitForText,
  waitForTextContaining,
  writeFixtureServer,
} from "../test-helpers/mcp-app-conformance-fixture.ts";

const require = createRequire(import.meta.url);
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeConformance = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const authValue = "test";
const sessionKey = "agent:main:mcp-app-conformance";
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.resolve(".artifacts/control-ui-e2e/mcp-app-request-lifetime");
const proofOptions = { proofDir, captureUiProof };
const recordHost = recordMcpAppHost.bind(undefined, proofOptions);

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
let fixtureControlPath: string;
let fixtureEventsPath: string;
let fixtureHistoryUrl: string;
let fixture: ReturnType<typeof createMcpAppFixtureControl>;
let showFixture: (callId: string) => Promise<string>;

const openContexts = new Set<BrowserContext>();

describeConformance("MCP App Control UI and standalone host conformance", () => {
  beforeAll(async () => {
    // Both tests share this artifact owner; never clear between their recordings.
    await fs.rm(proofDir, { recursive: true, force: true });
    await fs.mkdir(proofDir, { recursive: true });
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
      "OPENCLAW_TEST_MINIMAL_GATEWAY",
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
    ]);
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-app-conformance-"));
    const stateDir = path.join(tempRoot, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const fixturePath = path.join(tempRoot, "fixture-server.mjs");
    fixtureControlPath = path.join(tempRoot, "fixture-control.json");
    fixtureEventsPath = path.join(tempRoot, "fixture-events.jsonl");
    fixture = createMcpAppFixtureControl(fixtureControlPath, fixtureEventsPath);
    await fixture.configure({ scenario: "setup", callDelayMs: 0 });
    await fs.writeFile(fixtureEventsPath, "");
    await fs.mkdir(path.join(tempRoot, "empty-plugins"), { recursive: true });
    controlUiServer = await startControlUiE2eServer(undefined, { source: true });
    const appEntryPath = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
    const appModuleSource = await fs.readFile(appEntryPath, "utf8");
    const appAssetPort = await getGatewayE2ePortBlock();
    const fixtureAssetServer = createHttpServer((request, response) => {
      if (request.url === "/history-away") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>History control</title><p>History control</p>");
        return;
      }
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
    fixtureHistoryUrl = `http://127.0.0.1:${appAssetPort}/history-away`;
    const resourceOrigin = new URL(appModuleUrl).origin;
    const controlUiOrigin = new URL(controlUiServer.baseUrl).origin;
    await writeFixtureServer(
      fixturePath,
      appHtml(appModuleUrl),
      resourceOrigin,
      fixtureControlPath,
      fixtureEventsPath,
    );
    gatewayPort = await getGatewayE2ePortBlock();
    do {
      sandboxPort = await getGatewayE2ePortBlock();
    } while (sandboxPort === gatewayPort);
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "token", token: authValue },
        controlUi: { allowedOrigins: [controlUiOrigin] },
      },
      mcp: {
        apps: { enabled: true, sandboxPort },
        servers: {
          conformance: {
            command: process.execPath,
            args: [fixturePath],
            cwd: tempRoot,
            requestTimeoutMs: 10_000,
          },
        },
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
    setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "1");
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
    showFixture = async (callId) => {
      const nextResult = await show.execute(callId, { city: "Paris" });
      const nextViewId = (
        nextResult.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } }
      ).mcpAppPreview?.mcpApp?.viewId;
      if (!nextViewId) {
        throw new Error("Fixture did not create a view: " + callId);
      }
      return nextViewId;
    };
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
    const failures: Array<{ step: string; error: string }> = [];
    const settle = async (step: string, cleanup: () => Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        failures.push({ step, error: String(error) });
      }
    };
    for (const context of openContexts) {
      await settle("context", () => context.close());
    }
    await settle("browser", () => browser?.close());
    await settle("gateway", () => gateway?.close({ reason: "MCP App conformance complete" }));
    await settle("MCP runtimes", () => disposeAllSessionMcpRuntimes());
    if (appAssetServer) {
      await settle(
        "asset server",
        () =>
          new Promise<void>((resolve, reject) => {
            appAssetServer?.close((error) => (error ? reject(error) : resolve()));
          }),
      );
    }
    await settle("Control UI server", () => controlUiServer?.close());
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    envSnapshot?.restore();
    if (tempRoot) {
      await fs.mkdir(proofDir, { recursive: true });
      await settle("archive fixture events", () =>
        fs.copyFile(fixtureEventsPath, path.join(proofDir, "fixture-events.jsonl")),
      );
      await settle("fixture temp root", () => fs.rm(tempRoot, { recursive: true, force: true }));
    }
    await fs.writeFile(
      path.join(proofDir, "cleanup.json"),
      JSON.stringify({ failures, terminalAtMs: Date.now() }, null, 2),
    );
    expect(failures).toEqual([]);
  }, 120_000);

  it("drives the authenticated Control UI and ticketed standalone bridges", async () => {
    if (captureUiProof) {
      await fs.mkdir(proofDir, { recursive: true });
    }
    const teardownProof = createMcpAppTeardownRecorder(proofDir, fixtureEventsPath);
    const controlContext = await openMcpAppProofContext(browser, openContexts, proofOptions);
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
    await mountControlUiHost(controlPage, {
      baseUrl: controlUiServer.baseUrl,
      gatewayPort,
      authValue,
      sessionKey,
      viewId,
    });
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
    await waitForTextContaining(app.locator("#capabilities"), "updateModelContext");
    await waitForText(app.locator("#ping"), "{}");
    await waitForText(app.locator("#isolation"), "isolated");
    await waitForText(app.locator("#host-theme"), "dark");
    await waitForTextContaining(
      app.locator("#host-variables"),
      '"--color-background-primary":"#161920"',
    );
    await waitForTextContaining(app.locator("#host-variables"), '"--color-text-primary":"#d4d4d8"');
    await waitForText(
      app.locator("#computed-theme"),
      JSON.stringify({
        background: "rgb(22, 25, 32)",
        color: "rgb(212, 212, 216)",
        accent: "rgb(255, 79, 79)",
      }),
    );
    await controlPage.evaluate(() => {
      const setTheme = Reflect.get(window, "mcpConformanceSetTheme") as
        | ((theme: "light" | "dark") => void)
        | undefined;
      setTheme?.("light");
    });
    await waitForText(app.locator("#host-theme"), "light");
    await waitForTextContaining(
      app.locator("#host-variables"),
      '"--color-background-primary":"#ffffff"',
    );
    await waitForTextContaining(app.locator("#host-variables"), '"--color-text-primary":"#403c35"');
    await waitForText(
      app.locator("#computed-theme"),
      JSON.stringify({
        background: "rgb(255, 255, 255)",
        color: "rgb(64, 60, 53)",
        accent: "rgb(255, 79, 79)",
      }),
    );
    await app.locator("#call-app").click();
    await waitForTextContaining(app.locator("#app-tool"), "companion-called");
    await app.locator("#call-model").click();
    await waitForTextContaining(app.locator("#model-tool"), "denied:");
    await app.locator("#read-resource").click();
    await waitForTextContaining(app.locator("#resource"), "resource-ok");
    if (captureUiProof) {
      await controlPage.screenshot({
        path: path.join(proofDir, "control-ui-resource-allowed.png"),
      });
    }
    const confirmedPrompts: string[] = [];
    controlPage.on("dialog", async (dialog) => {
      confirmedPrompts.push(dialog.message());
      await dialog.accept();
    });
    await app.locator("#update-context").click();
    await waitForText(app.locator("#context-update"), "accepted");
    await app.locator("#send-message").click();
    await waitForText(app.locator("#message"), "accepted");
    await expect
      .poll(() => controlPage.evaluate(() => Reflect.get(window, "mcpConformancePrompt") as string))
      .toBe("summarize selection");
    expect(confirmedPrompts).toEqual(["Confirm:\n\nsummarize selection"]);
    expect(runtime.pendingMcpAppModelContext).toMatchObject({ text: "selected item 42" });

    const standaloneUrl = await requestStandaloneUrl(controlPage, { sessionKey, viewId });
    await fixture.configure({
      scenario: "control-ui-graceful-teardown",
      callDelayMs: 0,
    });
    await teardownProof.run("control-ui-graceful-teardown", controlPage, app, async () => {
      await controlPage.evaluate(async () => {
        const unmount = Reflect.get(window, "mcpConformanceUnmount") as
          | (() => Promise<void>)
          | undefined;
        await unmount?.();
      });
    });

    const standaloneContext = await openMcpAppProofContext(browser, openContexts, proofOptions);
    const authorizationHeaders: string[] = [];
    const requestUrls: string[] = [];
    const referrers: string[] = [];
    const standaloneDiagnostics: string[] = [];
    standaloneContext.on("request", (request) => {
      requestUrls.push(request.url());
      const authorization = request.headers().authorization;
      if (authorization) {
        authorizationHeaders.push(authorization);
      }
      const referrer = request.headers().referer;
      if (referrer) {
        referrers.push(referrer);
      }
    });
    const standalonePage = await standaloneContext.newPage();
    standalonePage.on("console", (message) => standaloneDiagnostics.push(message.text()));
    await fixture.configure({
      scenario: "standalone-bridge",
      callDelayMs: 0,
    });
    const absoluteStandaloneUrl = `http://127.0.0.1:${gatewayPort}${standaloneUrl}`;
    const ticket = standaloneUrl.split("#")[1] ?? "";
    await standalonePage.goto(absoluteStandaloneUrl);
    app = await findAppFrame(standalonePage);
    await waitForText(app.locator("#input"), '{"city":"Paris"}');
    await waitForTextContaining(app.locator("#result"), "initial-result");
    await waitForTextContaining(app.locator("#capabilities"), "serverTools");
    await waitForTextContaining(app.locator("#capabilities"), "serverResources");
    await waitForTextContaining(app.locator("#capabilities"), "updateModelContext", false);
    await waitForText(app.locator("#ping"), "{}");
    await waitForText(app.locator("#isolation"), "isolated");
    await app.locator("#call-app").click();
    await waitForTextContaining(app.locator("#app-tool"), "companion-called");
    await app.locator("#call-model").click();
    await waitForTextContaining(app.locator("#model-tool"), "denied:");
    await app.locator("#read-resource").click();
    await waitForTextContaining(app.locator("#resource"), "resource-ok");
    expect(authorizationHeaders.length).toBeGreaterThanOrEqual(3);
    expect(authorizationHeaders.every((value) => value.startsWith("MCP-App v1."))).toBe(true);
    expect(authorizationHeaders.some((value) => value === `Bearer ${authValue}`)).toBe(false);
    expect(ticket).not.toBe("");
    expect(requestUrls.some((value) => value.includes(ticket))).toBe(false);
    expect(referrers.some((value) => value.includes(ticket))).toBe(false);
    expect(standaloneDiagnostics.some((value) => value.includes(ticket))).toBe(false);

    await fixture.configure({
      scenario: "standalone-graceful-teardown",
      callDelayMs: 0,
    });
    await teardownProof.run("standalone-graceful-teardown", standalonePage, app, async () => {
      await app.locator("#request-teardown").click();
    });
    for (const { events } of teardownProof.records) {
      const calls = events.filter(
        (event) => event.event === "incoming" && event.tool === "cleanup_save",
      );
      expect(calls).toHaveLength(1);
      const id = calls[0]?.id;
      expect(id).toBeDefined();
      expect(events.filter((event) => event.event === "cleanup-save")).toMatchObject([
        { requestId: id },
      ]);
      expect(
        events.filter(
          (event) => event.event === "response-written" && event.tool === "cleanup_save",
        ),
      ).toMatchObject([{ id, isError: false }]);
    }
    await fixture.configure({
      scenario: "standalone-after-teardown",
      callDelayMs: 0,
    });
    await standalonePage.reload();
    app = await findAppFrame(standalonePage);
    await waitForTextContaining(app.locator("#result"), "initial-result");
    await app.locator("#call-app").click();
    await waitForTextContaining(app.locator("#app-tool"), "companion-called");

    const activeView = getMcpAppViewLease(viewId, runtime);
    if (!activeView) {
      throw new Error("MCP App conformance view expired before revocation proof");
    }
    activeView.authorizeAppInteraction = async () => false;

    // The already-initialized App retains its capability snapshot, so the
    // authoritative request-time check must still withhold the resource.
    await app.locator("#read-resource").click();
    await waitForTextContaining(app.locator("#resource"), "denied:");
    await waitForTextContaining(app.locator("#resource"), "resource-ok", false);
    if (captureUiProof) {
      await standalonePage.screenshot({
        path: path.join(proofDir, "standalone-resource-revoked.png"),
      });
    }

    await standalonePage.reload();
    app = await findAppFrame(standalonePage);
    await waitForTextContaining(app.locator("#capabilities"), "serverResources", false);
    await app.locator("#read-resource").click();
    await waitForTextContaining(app.locator("#resource"), "denied:");

    const revokedControlPage = await controlContext.newPage();
    await mountControlUiHost(revokedControlPage, {
      baseUrl: controlUiServer.baseUrl,
      gatewayPort,
      authValue,
      sessionKey,
      viewId,
    });
    const revokedControlApp = await findAppFrame(revokedControlPage);
    await waitForTextContaining(
      revokedControlApp.locator("#capabilities"),
      "serverResources",
      false,
    );
    await revokedControlApp.locator("#read-resource").click();
    await waitForTextContaining(revokedControlApp.locator("#resource"), "denied:");
    if (captureUiProof) {
      await revokedControlPage.screenshot({
        path: path.join(proofDir, "control-ui-resource-revoked.png"),
      });
    }
    await revokedControlPage.close();

    const tampered = `${absoluteStandaloneUrl.slice(0, -1)}${absoluteStandaloneUrl.endsWith("a") ? "b" : "a"}`;
    const tamperedPage = await standaloneContext.newPage();
    await tamperedPage.goto(tampered);
    await tamperedPage.reload();
    await waitForText(tamperedPage.locator(".error"), "MCP App ticket was rejected");
    await tamperedPage.close();

    const lease = getMcpAppViewLease(viewId, runtime);
    if (!lease) {
      throw new Error("MCP App view lease missing");
    }
    lease.expiresAtMs = Date.now() - 1;
    await app.locator("#call-app").click();
    await waitForText(standalonePage.locator(".error"), "MCP App ticket was rejected");
    await fs.writeFile(
      path.join(proofDir, "bridge-conformance.json"),
      JSON.stringify(
        {
          test: "drives the authenticated Control UI and ticketed standalone bridges",
          result: "passed",
          completedAtMs: Date.now(),
          sourceBoundary:
            "real source-mounted component, Gateway and official App; not full dashboard",
        },
        null,
        2,
      ),
    );
  }, 90_000);

  it("preserves composed operations and propagates caller cancellation through real transports", async () => {
    await fs.mkdir(proofDir, { recursive: true });
    await fs.writeFile(
      path.join(proofDir, "runtime.json"),
      JSON.stringify(
        {
          node: process.version,
          chromium: browser.version(),
          executable: chromiumExecutablePath,
          sourceBoundary:
            "real Gateway/stdio/official App; source-mounted Control UI component, not full dashboard",
        },
        null,
        2,
      ),
    );
    const diagnostics: Array<Record<string, unknown>> = [];
    const cancellationResults: Array<Record<string, unknown>> = [];
    const timingResults: Array<{
      scenario: string;
      output: string | null;
      events: FixtureEvent[];
      startedAtMs: number;
      settledAtMs: number;
    }> = [];
    try {
      await fixture.configure({
        scenario: "timing-setup",
        callDelayMs: 0,
      });
      viewId = await showFixture("timing-view");
      const controlContext = await openMcpAppProofContext(browser, openContexts, proofOptions);
      const standaloneContext = await openMcpAppProofContext(browser, openContexts, proofOptions);
      try {
        const controlPage = await controlContext.newPage();
        await mountControlUiHost(controlPage, {
          baseUrl: controlUiServer.baseUrl,
          gatewayPort,
          authValue,
          sessionKey,
          viewId,
        });
        await findAppFrame(controlPage);
        const standaloneUrl = await requestStandaloneUrl(controlPage, { sessionKey, viewId });
        const standalonePage = await standaloneContext.newPage();
        observeMcpAppNetwork(standalonePage, "timing", diagnostics);
        await standalonePage.goto("http://127.0.0.1:" + gatewayPort + standaloneUrl);
        let app = await findAppFrame(standalonePage);
        for (const spec of [
          { scenario: "warm-call8", callDelayMs: 8000, refresh: false },
          { scenario: "list8-call1", callDelayMs: 1000, refresh: true },
          { scenario: "list8-call8", callDelayMs: 8000, refresh: true },
        ]) {
          await fixture.configure(spec);
          if (spec.refresh) {
            await app.locator("#arm-refresh").click();
            await waitForText(app.locator("#arm-result"), "armed");
            // The real notification owns this transition. No catalog field is assigned.
            await expect.poll(() => runtime.peekCatalog()).toBeNull();
          } else {
            expect(runtime.peekCatalog()).not.toBeNull();
          }
          const startedAtMs = Date.now();
          diagnostics.push({
            event: "timing-call-start",
            atMs: startedAtMs,
            scenario: spec.scenario,
          });
          await app.locator("#call-app").click();
          await expect
            .poll(() => app.locator("#app-tool").textContent(), { timeout: 25_000 })
            .not.toBe("pending");
          const settledAtMs = Date.now();
          const output = await app.locator("#app-tool").textContent();
          // Retain upstream terminal evidence even when the browser already failed.
          await expect
            .poll(
              async () =>
                (await fixture.readEvents()).filter(
                  (event) => event.scenario === spec.scenario && event.event === "tool-complete",
                ).length,
              { timeout: 12_000 },
            )
            .toBe(1);
          await expect
            .poll(
              async () =>
                (await fixture.readEvents()).filter(
                  (event) =>
                    event.scenario === spec.scenario &&
                    event.event === "response-written" &&
                    event.method === "tools/call" &&
                    event.tool === "app_companion",
                ).length,
              { timeout: 3000 },
            )
            .toBe(1);
          const events = (await fixture.readEvents()).filter(
            (event) => event.scenario === spec.scenario,
          );
          timingResults.push({ scenario: spec.scenario, output, events, startedAtMs, settledAtMs });
          await recordHost(standalonePage, spec.scenario);
          await fs.writeFile(
            path.join(proofDir, "timing-results.json"),
            JSON.stringify(timingResults, null, 2),
          );
          expect(events.filter((event) => event.event === "tool-start")).toHaveLength(1);
          expect(events.filter((event) => event.event === "tool-complete")).toHaveLength(1);
          const start = events.find((event) => event.event === "tool-start");
          const complete = events.find((event) => event.event === "tool-complete");
          if (!start || !complete) {
            throw new Error("Missing upstream terminal events");
          }
          const call = events.find(
            (event) =>
              event.event === "incoming" &&
              event.method === "tools/call" &&
              event.tool === "app_companion",
          );
          expect(
            events.filter(
              (event) =>
                event.event === "incoming" &&
                event.method === "tools/call" &&
                event.tool === "app_companion",
            ),
          ).toHaveLength(1);
          if (!call) {
            throw new Error("Missing actual tools/call ingress");
          }
          const callWritten = events.find(
            (event) => event.event === "response-written" && event.id === call.id,
          );
          if (!callWritten) {
            throw new Error("No correlated tools/call response; inspect cancellation events");
          }
          expect(callWritten.monotonicMs - call.monotonicMs).toBeLessThan(10_000);
          expect(start.requestId).toBe(call.id);
          expect(complete.requestId).toBe(call.id);
          expect(complete.monotonicMs - call.monotonicMs).toBeLessThan(10_000);
          expect(complete.monotonicMs - start.monotonicMs).toBeGreaterThanOrEqual(
            spec.callDelayMs - 100,
          );
          expect(complete.monotonicMs - start.monotonicMs).toBeLessThan(10_000);
          if (spec.refresh) {
            expect(
              events.filter((event) => event.event === "incoming" && event.method === "tools/list"),
            ).toHaveLength(1);
            expect(events.filter((event) => event.event === "notification-sent")).toHaveLength(1);
            const ready = events.find((event) => event.event === "list-response-ready");
            const sent = events.find((event) => event.event === "list-response-send");
            const written = events.find(
              (event) => event.event === "response-written" && event.method === "tools/list",
            );
            const incoming = events.find(
              (event) => event.event === "incoming" && event.method === "tools/list",
            );
            if (!ready || !sent || !written || !incoming) {
              throw new Error("Missing correlated catalog response events");
            }
            expect(written.id).toBe(incoming.id);
            expect(ready.id).toBe(incoming.id);
            expect(written.monotonicMs - incoming.monotonicMs).toBeLessThan(10_000);
            expect(sent.monotonicMs - ready.monotonicMs).toBeGreaterThanOrEqual(7900);
            expect(sent.monotonicMs - ready.monotonicMs).toBeLessThan(10_000);
            expect(start.monotonicMs).toBeGreaterThanOrEqual(written.monotonicMs);
          }
          expect(output).toContain("companion-called");
        }
        const initializations = (await fixture.readEvents()).filter(
          (event) => event.method === "initialize",
        ).length;
        for (const spec of [
          { scenario: "caller-timeout", action: "timeout" },
          { scenario: "caller-abort", action: "abort" },
          { scenario: "caller-cooperative", action: "abort", callDelayMs: 5000, cooperative: true },
          { scenario: "frame-teardown", action: "teardown" },
          { scenario: "pagehide", action: "pagehide" },
        ]) {
          const releasePath = spec.cooperative
            ? undefined
            : path.join(tempRoot, spec.scenario + ".released");
          await fixture.configure({ ...spec, releasePath });
          const startedAtMs = Date.now();
          const networkStart = diagnostics.length;
          const observation: Record<string, unknown> = { scenario: spec.scenario, startedAtMs };
          cancellationResults.push(observation);
          try {
            await app.locator(spec.action === "timeout" ? "#call-expiring" : "#call-app").click();
            await expect
              .poll(
                async () =>
                  (await fixture.readEvents()).filter(
                    (event) => event.scenario === spec.scenario && event.event === "tool-start",
                  ).length,
              )
              .toBe(1);
            if (spec.action === "abort") {
              await app.locator("#cancel-call").click();
            }
            if (spec.action === "teardown") {
              await app.locator("#request-teardown").click();
              await expect.poll(() => standalonePage.frames().length).toBe(1);
            } else if (spec.action === "pagehide") {
              await standalonePage.goto("about:blank");
            } else {
              await waitForTextContaining(app.locator("#app-tool"), "denied:");
            }
            await expect
              .poll(
                async () =>
                  (await fixture.readEvents()).filter(
                    (event) =>
                      event.scenario === spec.scenario &&
                      event.event === "tool-cancellation-observed",
                  ).length,
              )
              .toBe(1);
            // Release noncooperative work only after cancellation really reached the SDK.
            if (releasePath) {
              await fs.writeFile(releasePath, "released");
            }
            // The SDK suppresses late replies even when a server ignores cancellation.
            await expect
              .poll(
                async () =>
                  (await fixture.readEvents()).filter(
                    (event) =>
                      event.scenario === spec.scenario &&
                      event.event === (spec.cooperative ? "tool-stopped" : "tool-complete"),
                  ).length,
                { timeout: 8000 },
              )
              .toBe(1);
            const events = (await fixture.readEvents()).filter(
              (event) => event.scenario === spec.scenario,
            );
            const calls = events.filter(
              (event) => event.event === "incoming" && event.tool === "app_companion",
            );
            expect(calls).toHaveLength(1);
            const call = calls[0]!;
            expect(
              events.filter(
                (event) =>
                  event.method === "notifications/cancelled" && event.requestId === call.id,
              ),
            ).toHaveLength(1);
            expect(events.filter((event) => event.event === "tool-complete")).toMatchObject(
              spec.cooperative ? [] : [{ requestId: call.id, aborted: true }],
            );
            // Fixture stdio and Playwright network events arrive independently.
            await expect
              .poll(() =>
                diagnostics
                  .slice(networkStart)
                  .filter((event) => event.event === "requestfailed" && event.method === "POST"),
              )
              .toHaveLength(1);
          } finally {
            if (releasePath) {
              await fs.writeFile(releasePath, "released");
            }
            Object.assign(observation, {
              settledAtMs: Date.now(),
              network: diagnostics.slice(networkStart),
              events: (await fixture.readEvents()).filter(
                (event) => event.scenario === spec.scenario,
              ),
              state: await recordHost(standalonePage, spec.scenario + "-after"),
            });
            await fs.writeFile(
              path.join(proofDir, "cancellation-results.json"),
              JSON.stringify(cancellationResults, null, 2),
            );
          }
          if (spec.action === "teardown" || spec.action === "pagehide") {
            const reopenNetworkStart = diagnostics.length;
            const previousTimeOrigin = await standalonePage.evaluate(() => performance.timeOrigin);
            // Navigating to the same fragment URL need not replace a closed heap.
            const response =
              spec.action === "teardown"
                ? await standalonePage.reload()
                : await standalonePage.goto("http://127.0.0.1:" + gatewayPort + standaloneUrl);
            const timeOrigin = await standalonePage.evaluate(() => performance.timeOrigin);
            observation.reopen = { previousTimeOrigin, timeOrigin, status: response?.status() };
            expect(response?.status()).toBe(200);
            expect(timeOrigin).not.toBe(previousTimeOrigin);
            app = await findAppFrame(standalonePage);
            for (const pathname of ["/__openclaw__/mcp-app", "/__openclaw__/mcp-app/view"]) {
              expect(
                diagnostics
                  .slice(reopenNetworkStart)
                  .filter(
                    (event) =>
                      event.event === "request" &&
                      event.method === "GET" &&
                      event.pathname === pathname,
                  ),
              ).toHaveLength(1);
            }
          }
          await fixture.configure({
            scenario: spec.scenario + "-control",
            callDelayMs: 0,
          });
          await app.locator("#call-app").click();
          await waitForTextContaining(app.locator("#app-tool"), "companion-called");
          const controlEvents = (await fixture.readEvents()).filter(
            (event) => event.scenario === spec.scenario + "-control",
          );
          expect(
            controlEvents.filter(
              (event) => event.event === "incoming" && event.tool === "app_companion",
            ),
          ).toHaveLength(1);
          expect(
            controlEvents.filter(
              (event) => event.event === "response-written" && event.tool === "app_companion",
            ),
          ).toHaveLength(1);
          // A subsequent real response is a causal barrier for the cancelled handler's late reply.
          const settledEvents = (await fixture.readEvents()).filter(
            (event) => event.scenario === spec.scenario,
          );
          observation.events = settledEvents;
          observation.afterControlAtMs = Date.now();
          await fs.writeFile(
            path.join(proofDir, "cancellation-results.json"),
            JSON.stringify(cancellationResults, null, 2),
          );
          expect(
            settledEvents.filter(
              (event) => event.event === "response-written" && event.tool === "app_companion",
            ),
          ).toEqual([]);
          expect(
            settledEvents.filter(
              (event) => event.event === "incoming" && event.tool === "app_companion",
            ),
          ).toHaveLength(1);
          await recordHost(standalonePage, spec.scenario + "-control");
        }
        expect(
          (await fixture.readEvents()).filter((event) => event.method === "initialize"),
        ).toHaveLength(initializations);

        // Playwright does not support BFCache restoration; use its supported history flow.
        // Production no-store headers stay unchanged, and ordinary history is not BFCache proof.
        const historyContext = await openMcpAppProofContext(browser, openContexts, proofOptions);
        const historyPage = await historyContext.newPage();
        const historyStates: Array<Record<string, unknown>> = [];
        const historyObservations: Record<string, unknown> = {
          mode: "ordinary-history",
          bfcache: "unsupported-by-playwright; restoration unproven",
          phase: "setup",
          states: historyStates,
          responses: [],
        };
        const recordHistory = async () => {
          historyStates.push({
            phase: historyObservations.phase,
            ...(await readMcpAppHistoryNavigation(historyPage)),
          });
        };
        try {
          await historyPage.addInitScript(() => {
            const shown: Array<{ persisted: boolean; atMs: number }> = [];
            Reflect.set(window, "mcpConformancePageShows", shown);
            addEventListener("pageshow", (event) =>
              shown.push({ persisted: event.persisted, atMs: Date.now() }),
            );
          });
          const responses: Array<Record<string, unknown>> = [];
          historyObservations.responses = responses;
          historyPage.on("response", (response) => {
            if (response.url().includes("mcp-app")) {
              responses.push({
                pathname: new URL(response.url()).pathname,
                status: response.status(),
                cacheControl: response.headers()["cache-control"],
              });
            }
          });
          await fixture.configure({
            scenario: "history-forward",
            callDelayMs: 0,
          });
          historyObservations.phase = "initial-control";
          await historyPage.goto(fixtureHistoryUrl);
          await recordHistory();
          historyObservations.phase = "initial-app";
          await historyPage.goto("http://127.0.0.1:" + gatewayPort + standaloneUrl);
          await findAppFrame(historyPage);
          await recordHistory();
          historyObservations.phase = "back";
          await historyPage.goBack({ timeout: 15_000 });
          expect(historyPage.url()).toBe(fixtureHistoryUrl);
          await waitForText(historyPage.locator("p"), "History control");
          await recordHistory();
          historyObservations.phase = "forward";
          await historyPage.goForward({ timeout: 15_000 });
          const historyApp = await findAppFrame(historyPage);
          await recordHistory();
          historyObservations.phase = "returned-app-call";
          await historyApp.locator("#call-app").click();
          await waitForTextContaining(historyApp.locator("#app-tool"), "companion-called");
          historyObservations.returnedApp = await recordHost(historyPage, "history-forward");
          const historyEvents = (await fixture.readEvents()).filter(
            (event) => event.scenario === "history-forward" && event.tool === "app_companion",
          );
          historyObservations.events = historyEvents;
          const historyCalls = historyEvents.filter((event) => event.event === "incoming");
          expect(historyCalls).toHaveLength(1);
          const historyCallId = historyCalls[0]?.id;
          expect(historyCallId).toBeDefined();
          expect(historyEvents.filter((event) => event.event === "response-written")).toMatchObject(
            [{ id: historyCallId, isError: false }],
          );
          for (const pathname of [
            "/__openclaw__/mcp-app",
            "/__openclaw__/mcp-app/view",
            "/mcp-app-sandbox",
          ]) {
            expect(responses.filter((response) => response.pathname === pathname)).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ status: 200, cacheControl: "no-store" }),
              ]),
            );
          }
          historyObservations.phase = "complete";
        } finally {
          try {
            await recordHistory().catch((error: unknown) => {
              historyObservations.observationError =
                error instanceof Error ? error.name : "unknown";
            });
            await fs.writeFile(
              path.join(proofDir, "history-navigation.json"),
              JSON.stringify(historyObservations, null, 2),
            );
          } finally {
            await closeMcpAppProofContext(historyContext, openContexts);
          }
        }
      } finally {
        await fs.writeFile(
          path.join(proofDir, "timing-results.json"),
          JSON.stringify(timingResults, null, 2),
        );
        await Promise.allSettled(
          standaloneContext.pages().map((page, index) => recordHost(page, "timing-final-" + index)),
        );
        const closed = await Promise.allSettled([
          closeMcpAppProofContext(controlContext, openContexts),
          closeMcpAppProofContext(standaloneContext, openContexts),
        ]);
        for (const result of closed) {
          if (result.status === "rejected") {
            diagnostics.push({ event: "context-cleanup-error", error: String(result.reason) });
          }
        }
      }
      expect(timingResults.find((result) => result.scenario === "list8-call8")?.output).toContain(
        "companion-called",
      );
    } finally {
      await fs.writeFile(
        path.join(proofDir, "browser-diagnostics.json"),
        JSON.stringify(diagnostics, null, 2),
      );
      await fs.writeFile(
        path.join(proofDir, "cancellation-results.json"),
        JSON.stringify(cancellationResults, null, 2),
      );
      await fs.writeFile(
        path.join(proofDir, "timing-results.json"),
        JSON.stringify(timingResults, null, 2),
      );
      await fs.copyFile(fixtureEventsPath, path.join(proofDir, "fixture-events.jsonl"));
    }
  }, 240_000);
});
