// MCP Apps conformance uses the locked official ext-apps App implementation over real browser,
// Gateway WebSocket/HTTP, stdio MCP, and nested postMessage transports.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import type { Frame } from "playwright";
import { expect, inject, it } from "vitest";
import { disposeAllSessionMcpRuntimes } from "../../../src/agents/agent-bundle-mcp-manager-api.js";
import { getOrCreateSessionMcpRuntime } from "../../../src/agents/agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "../../../src/agents/agent-bundle-mcp-materialize.js";
import { getMcpAppViewLease } from "../../../src/agents/mcp-ui-resource.js";
import { readConfigFileSnapshotWithPluginMetadata } from "../../../src/config/config.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { startGatewayServer } from "../../../src/gateway/server.js";
import { getGatewayE2ePortBlock } from "../../../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import {
  appHtml,
  createMcpAppFixtureControl,
  createMcpAppTeardownRecorder,
  type McpAppFixtureEvent as FixtureEvent,
  observeMcpAppHttpResponses,
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
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  assertMcpAppTimingEvents,
  waitForMcpAppTimingEvents,
} from "./mcp-app-timing.test-support.ts";

const require = createRequire(import.meta.url);
const { executablePath: chromiumExecutablePath } = inject("controlUiE2eChromium");
const authValue = "test";
const sessionKey = "agent:main:mcp-app-conformance";
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.resolve(
  process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim() || ".artifacts/control-ui-e2e",
  "mcp-app-request-lifetime",
);
const proofOptions = { proofDir, captureUiProof };
const recordHost = recordMcpAppHost.bind(undefined, proofOptions);

let state: OpenClawTestState | undefined;
let gatewayStartup: ReturnType<typeof startGatewayServer> | undefined;
let runtimeStartup: ReturnType<typeof getOrCreateSessionMcpRuntime> | undefined;
let gatewayPort: number;
let sandboxPort: number;
let tempRoot: string;
let viewId: string;
let appAssetServer: HttpServer | undefined;
let runtime: Awaited<ReturnType<typeof getOrCreateSessionMcpRuntime>>;
let fixtureControlPath: string;
let fixtureEventsPath: string;
let fixtureHistoryUrl: string;
let fixture: ReturnType<typeof createMcpAppFixtureControl>;
let showFixture: (callId: string) => Promise<string>;

const failures: Array<{ step: string; error: string }> = [];
async function settleCleanup(step: string, cleanup: () => Promise<unknown>) {
  try {
    await cleanup();
  } catch (error) {
    failures.push({ step, error: String(error) });
  }
}
async function recordCleanup() {
  await fs.writeFile(
    path.join(proofDir, "cleanup.json"),
    JSON.stringify({ failures, terminalAtMs: Date.now() }, null, 2),
  );
  expect(failures).toEqual([]);
}

const suite = createControlUiE2eSuite({
  name: "MCP App Control UI and standalone host conformance",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  setupTimeoutMs: 120_000,
  teardownTimeoutMs: 120_000,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
  resources: {
    retainedState: () => state?.root,
    run: async (signal) => {
      // Both tests share this artifact owner; never clear between their recordings.
      await fs.rm(proofDir, { recursive: true, force: true });
      await fs.mkdir(proofDir, { recursive: true });
      signal.throwIfAborted();
      state = await createOpenClawTestState({
        prefix: "openclaw-mcp-app-conformance-",
        applyEnv: false,
        env: {
          OPENCLAW_GATEWAY_TOKEN: authValue,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        },
      });
      signal.throwIfAborted();
      tempRoot = state.root;
      const fixturePath = state.path("fixture-server.mjs");
      fixtureControlPath = state.path("fixture-control.json");
      fixtureEventsPath = state.path("fixture-events.jsonl");
      fixture = createMcpAppFixtureControl(fixtureControlPath, fixtureEventsPath);
      await fixture.configure({ scenario: "setup", callDelayMs: 0 });
      await fs.writeFile(fixtureEventsPath, "");
      const bundledPluginsDir = state.path("empty-plugins");
      await fs.mkdir(bundledPluginsDir, { recursive: true });
      // The state owner already captured this key; its value needs the allocated root.
      state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
      const appEntryPath = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
      const appModuleSource = await fs.readFile(appEntryPath, "utf8");
      const appAssetPort = await getGatewayE2ePortBlock();
      signal.throwIfAborted();
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
      await new Promise<void>((resolve, reject) => {
        fixtureAssetServer.once("error", reject);
        fixtureAssetServer.listen(appAssetPort, "127.0.0.1", () => {
          fixtureAssetServer.off("error", reject);
          resolve();
        });
      });
      signal.throwIfAborted();
      const appModuleUrl = `http://127.0.0.1:${appAssetPort}/app.js`;
      fixtureHistoryUrl = `http://127.0.0.1:${appAssetPort}/history-away`;
      const resourceOrigin = new URL(appModuleUrl).origin;
      const controlUiOrigin = new URL(suite.server.baseUrl).origin;
      await writeFixtureServer(
        fixturePath,
        appHtml(appModuleUrl),
        resourceOrigin,
        fixtureControlPath,
        fixtureEventsPath,
      );
      gatewayPort = await getGatewayE2ePortBlock();
      do {
        signal.throwIfAborted();
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
      await state.writeConfig(cfg);
      signal.throwIfAborted();
      state.applyEnv();
      // Keep rejected acquisitions: no returned handle does not prove cleanup succeeded.
      runtimeStartup = getOrCreateSessionMcpRuntime({
        sessionId: `mcp-app-conformance-${randomUUID()}`,
        sessionKey,
        workspaceDir: tempRoot,
        cfg,
      });
      runtime = await runtimeStartup;
      signal.throwIfAborted();
      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      signal.throwIfAborted();
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
        (result.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } }).mcpAppPreview
          ?.mcpApp?.viewId ?? "";
      if (!viewId) {
        throw new Error("MCP App fixture did not create a view");
      }
      signal.throwIfAborted();
      const startupConfigSnapshotRead = await readConfigFileSnapshotWithPluginMetadata({
        observe: false,
      });
      signal.throwIfAborted();
      gatewayStartup = startGatewayServer(gatewayPort, {
        bind: "loopback",
        auth: { mode: "token", token: authValue },
        controlUiEnabled: false,
        startupConfigSnapshotRead,
      });
      await gatewayStartup;
      signal.throwIfAborted();
    },
    close: async () => {
      await settleCleanup("gateway", async () => {
        const gateway = await gatewayStartup;
        await gateway?.close({ reason: "MCP App conformance complete" });
      });
      await settleCleanup("MCP startup", async () => {
        await runtimeStartup;
      });
      await settleCleanup("MCP runtimes", () => disposeAllSessionMcpRuntimes());
      if (appAssetServer) {
        await settleCleanup(
          "asset server",
          () =>
            new Promise<void>((resolve, reject) => {
              appAssetServer?.close((error) => (error ? reject(error) : resolve()));
            }),
        );
      }
      if (tempRoot) {
        await fs.mkdir(proofDir, { recursive: true });
        await settleCleanup("archive fixture events", () =>
          fs.copyFile(fixtureEventsPath, path.join(proofDir, "fixture-events.jsonl")),
        );
      }
      await recordCleanup();
    },
    release: async () => {
      // The suite joins setup and cases, then all required closes, before releasing selectors.
      await settleCleanup("fixture temp root", async () => state?.cleanup());
      await recordCleanup();
    },
  },
});

async function newProofContext() {
  const context = await suite.newBrowserContext({
    permissions: ["local-network-access"],
    ...(captureUiProof
      ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
      : {}),
  });
  // Preserve the original Playwright operation timeout, not the suite's shorter default.
  context.setDefaultTimeout(30_000);
  return context;
}

suite.define(() => {
  it("drives the authenticated Control UI and ticketed standalone bridges", async (context) => {
    await suite.runScenario(context, {
      run: async (signal) => {
        signal.throwIfAborted();
        if (captureUiProof) {
          await fs.mkdir(proofDir, { recursive: true });
        }
        const teardownProof = createMcpAppTeardownRecorder(proofDir, fixtureEventsPath);
        const controlContext = await newProofContext();
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
          baseUrl: suite.server.baseUrl,
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
        await waitForTextContaining(
          app.locator("#host-variables"),
          '"--color-text-primary":"#d4d4d8"',
        );
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
        await waitForTextContaining(
          app.locator("#host-variables"),
          '"--color-text-primary":"#403c35"',
        );
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
          .poll(() =>
            controlPage.evaluate(() => Reflect.get(window, "mcpConformancePrompt") as string),
          )
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

        const standaloneContext = await newProofContext();
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
          baseUrl: suite.server.baseUrl,
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
      },
    });
  }, 90_000);

  it("preserves composed operations and propagates caller cancellation through real transports", async (context) => {
    await suite.runScenario(context, {
      run: async (signal) => {
        signal.throwIfAborted();
        await fs.mkdir(proofDir, { recursive: true });
        await fs.writeFile(
          path.join(proofDir, "runtime.json"),
          JSON.stringify(
            {
              node: process.version,
              chromium: suite.browser.version(),
              executable: chromiumExecutablePath,
              sourceBoundary:
                "real Gateway/stdio/official App; source-mounted Control UI component, not full dashboard",
            },
            null,
            2,
          ),
        );
        const diagnostics: Array<Record<string, unknown>> = [];
        const http = observeMcpAppHttpResponses(gatewayPort);
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
          const controlContext = await newProofContext();
          const standaloneContext = await newProofContext();
          try {
            const controlPage = await controlContext.newPage();
            await mountControlUiHost(controlPage, {
              baseUrl: suite.server.baseUrl,
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
            // Each RPC stays below 10s; their composition must cross the former 15s HTTP cutoff.
            const timingSpec = { scenario: "list8-call8", callDelayMs: 8000 };
            await fixture.configure(timingSpec);
            await app.locator("#arm-refresh").click();
            await waitForText(app.locator("#arm-result"), "armed");
            // The real notification owns this transition. No catalog field is assigned.
            await expect.poll(() => runtime.peekCatalog()).toBeNull();
            const timingStartedAtMs = Date.now();
            diagnostics.push({
              event: "timing-call-start",
              atMs: timingStartedAtMs,
              scenario: timingSpec.scenario,
            });
            await app.locator("#call-app").click();
            await expect
              .poll(() => app.locator("#app-tool").textContent(), { timeout: 25_000 })
              .not.toBe("pending");
            const settledAtMs = Date.now();
            const output = await app.locator("#app-tool").textContent();
            const timingEvents = await waitForMcpAppTimingEvents(
              fixture.readEvents,
              timingSpec.scenario,
            );
            timingResults.push({
              scenario: timingSpec.scenario,
              output,
              events: timingEvents,
              startedAtMs: timingStartedAtMs,
              settledAtMs,
            });
            await recordHost(standalonePage, timingSpec.scenario);
            await fs.writeFile(
              path.join(proofDir, "timing-results.json"),
              JSON.stringify(timingResults, null, 2),
            );
            assertMcpAppTimingEvents(timingEvents, timingSpec);
            expect(output).toContain("companion-called");
            const initializations = (await fixture.readEvents()).filter(
              (event) => event.method === "initialize",
            ).length;
            for (const spec of [
              { scenario: "caller-timeout", action: "timeout" },
              { scenario: "caller-abort", action: "abort" },
              {
                scenario: "caller-cooperative",
                action: "abort",
                callDelayMs: 5000,
                cooperative: true,
              },
              { scenario: "frame-teardown", action: "teardown" },
              { scenario: "pagehide", action: "pagehide" },
            ]) {
              const releasePath = spec.cooperative
                ? undefined
                : path.join(tempRoot, spec.scenario + ".released");
              await fixture.configure({ ...spec, releasePath });
              const startedAtMs = Date.now();
              const networkStart = diagnostics.length;
              const httpStart = http.responses.length;
              const observation: Record<string, unknown> = { scenario: spec.scenario, startedAtMs };
              cancellationResults.push(observation);
              try {
                await app
                  .locator(spec.action === "timeout" ? "#call-expiring" : "#call-app")
                  .click();
                await expect
                  .poll(
                    async () =>
                      (await fixture.readEvents()).filter(
                        (event) => event.scenario === spec.scenario && event.event === "tool-start",
                      ).length,
                  )
                  .toBe(1);
                const startedResponses = http.responses.slice(httpStart);
                expect(startedResponses).toHaveLength(1);
                const response = startedResponses[0]!;
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
                // Chromium may omit requestfailed when navigation destroys the old document.
                // Observe the exact Gateway response, not an unrelated teardown/control POST.
                await expect.poll(() => response.destroyed).toBe(true);
                observation.transport = {
                  closed: response.destroyed,
                  writableFinished: response.writableFinished,
                };
                expect(response.writableFinished).toBe(false);
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
                const previousTimeOrigin = await standalonePage.evaluate(
                  () => performance.timeOrigin,
                );
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
              const controlHttpStart = http.responses.length;
              await app.locator("#call-app").click();
              await waitForTextContaining(app.locator("#app-tool"), "companion-called");
              const controlResponses = http.responses.slice(controlHttpStart);
              expect(controlResponses).toHaveLength(1);
              expect(controlResponses[0]?.writableFinished).toBe(true);
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
            const historyContext = await newProofContext();
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
              expect(
                historyEvents.filter((event) => event.event === "response-written"),
              ).toMatchObject([{ id: historyCallId, isError: false }]);
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
                await suite.closeBrowserContext(historyContext);
              }
            }
          } finally {
            await fs.writeFile(
              path.join(proofDir, "timing-results.json"),
              JSON.stringify(timingResults, null, 2),
            );
            await Promise.allSettled(
              standaloneContext
                .pages()
                .map((page, index) => recordHost(page, "timing-final-" + index)),
            );
            const closed = await Promise.allSettled([
              suite.closeBrowserContext(controlContext),
              suite.closeBrowserContext(standaloneContext),
            ]);
            for (const result of closed) {
              if (result.status === "rejected") {
                diagnostics.push({ event: "context-cleanup-error", error: String(result.reason) });
              }
            }
          }
          expect(
            timingResults.find((result) => result.scenario === "list8-call8")?.output,
          ).toContain("companion-called");
        } finally {
          http.stop();
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
      },
    });
  }, 240_000);
});
