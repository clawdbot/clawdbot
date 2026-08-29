import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { chromium, type BrowserContext } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeMcpSessions } from "../src/browser/chrome-mcp-state.js";
import {
  chromeProductRoots,
  generateChromeExtensionIdForPath,
  stableChromeExtensionDir,
} from "../src/browser/extension-install-layout.js";
import { installChromeExtensionBootstrap } from "../src/browser/extension-install.js";
import { useNativeHostLaunchFixture } from "../src/browser/extension-install.test-support.js";
import { handleGatewayExtensionUpgrade } from "../src/browser/extension-relay/gateway-relay-route.js";
import { getPageForTargetId } from "../src/browser/pw-session.js";
import { createBrowserRouteDispatcher } from "../src/browser/routes/dispatcher.js";
import { createBrowserRouteContext } from "../src/browser/server-context.js";
import { getFreePort } from "../src/browser/test-port.js";
import { getBrowserControlState, stopBrowserControlService } from "../src/control-service.js";
import { createBootstrapDiagnostic } from "./bootstrap-diagnostics.test-support.js";
import { proveLabeledRefScreenshot } from "./labeled-screenshot.test-support.js";
import chromeExtensionManifest from "./manifest.json" with { type: "json" };
import { holdNavigationAccessCheck } from "./navigation-race.test-support.js";
import { relayTestKey } from "./relay-key.test-support.js";
import { assertRelayTabCreation } from "./tab-creation.test-support.js";

declare const chrome: {
  runtime: { sendMessage: (message: unknown) => Promise<Record<string, unknown>> };
};

const runE2E =
  process.env.OPENCLAW_BROWSER_EXTENSION_E2E === "1" &&
  (process.platform === "linux" || process.platform === "darwin");
const cleanups: Array<() => Promise<void>> = [];
const STORE_ORIGIN = "chrome-extension://kcdjddhmeafeomebliikmbpblkmkfoig/";
const nativeHostFixture = useNativeHostLaunchFixture();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup().catch(() => undefined);
  }
});

async function waitForExtensionId(context: BrowserContext, extensionPath: string): Promise<string> {
  const browser = context.browser();
  if (!browser) {
    throw new Error("Chromium browser connection unavailable");
  }
  const cdp = await browser.newBrowserCDPSession();
  const expected = await fs.realpath(extensionPath);
  const deadline = Date.now() + 15_000;
  do {
    const result = (await cdp.send("Extensions.getExtensions")) as {
      extensions: Array<{ id: string; path: string }>;
    };
    for (const extension of result.extensions) {
      if (
        (await fs.realpath(extension.path).catch(() => path.resolve(extension.path))) === expected
      ) {
        return extension.id;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  } while (Date.now() < deadline);
  throw new Error("Chromium did not report the loaded OpenClaw extension");
}

async function loadUnpackedExtension(
  context: BrowserContext,
  extensionPath: string,
): Promise<void> {
  const browser = context.browser();
  if (!browser) {
    throw new Error("Chromium browser connection unavailable");
  }
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: extensionPath });
}

async function exactOwnedManifestsExist(
  manifestPaths: string[],
  expectedOrigins: string[],
): Promise<boolean> {
  for (const manifestPath of manifestPaths) {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        name?: unknown;
        path?: unknown;
        allowed_origins?: unknown;
        key?: unknown;
      };
      if (
        manifest.name !== "ai.openclaw.browser_bootstrap" ||
        typeof manifest.path !== "string" ||
        Object.hasOwn(manifest, "key") ||
        !Array.isArray(manifest.allowed_origins) ||
        JSON.stringify(manifest.allowed_origins) !== JSON.stringify(expectedOrigins) ||
        !(await fs.readFile(manifest.path, "utf8")).includes(
          "# OpenClaw native messaging bootstrap v1",
        )
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return manifestPaths.length > 0;
}

async function seedLinuxSecurePreferences(params: {
  userDataDir: string;
  extensionId: string;
  extensionPath: string;
}): Promise<void> {
  const profileDir = path.join(params.userDataDir, "Default");
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(profileDir, "Secure Preferences"),
    `${JSON.stringify({
      extensions: {
        settings: {
          [params.extensionId]: { location: 4, path: params.extensionPath },
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
}

function decodeSingleNativeResponse(frame: Buffer): Record<string, unknown> {
  if (frame.length < 4) {
    throw new Error("native host returned no response frame");
  }
  const length = os.endianness() === "LE" ? frame.readUInt32LE() : frame.readUInt32BE();
  if (frame.length !== length + 4) {
    throw new Error(
      `native host did not return exactly one response frame (bytes=${frame.length}, declared=${length})`,
    );
  }
  const parsed: unknown = JSON.parse(frame.subarray(4).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("native host returned an invalid response payload");
  }
  return parsed as Record<string, unknown>;
}

describe.runIf(runE2E)("Chrome native bootstrap Chromium E2E", () => {
  it("pre-registers before the first native call, auto-pairs, and revokes a paused tab", async () => {
    const diagnostic = createBootstrapDiagnostic();
    cleanups.push(async () => {
      diagnostic.dispose();
      diagnostic.flush();
    });
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-extension-e2e-")),
    );
    cleanups.push(async () => await fs.rm(root, { recursive: true, force: true }));
    const homeDir = path.join(root, "home");
    const stateDir = path.join(root, "custom-state");
    const configPath = path.join(root, "custom-config", "openclaw.json");
    const gatewayPort = await getFreePort();
    let relayPort = await getFreePort();
    while (relayPort === gatewayPort) {
      relayPort = await getFreePort();
    }
    const linuxConfigHome = path.join(homeDir, ".config");
    const chromeRootEnv =
      process.platform === "linux"
        ? { CHROME_CONFIG_HOME: linuxConfigHome, XDG_CONFIG_HOME: linuxConfigHome }
        : {};
    const userDataDir =
      process.platform === "darwin"
        ? path.join(homeDir, "Library", "Application Support", "Google", "Chrome for Testing")
        : path.join(linuxConfigHome, "chromium");
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const token = relayTestKey(3);
    await fs.writeFile(
      path.join(stateDir, "credentials", "browser-extension-relay.secret"),
      `${token}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ gateway: { port: gatewayPort }, browser: { profiles: { e2e: { driver: "extension", cdpPort: relayPort } } } })}\n`,
      { mode: 0o600 },
    );
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_PORT: String(gatewayPort),
      },
      async () => {
        const extensionSource = path.dirname(fileURLToPath(import.meta.url));
        // Match installation: Chrome launches the built host, not a fresh tsx
        // compilation of the source graph inside each bounded native request.
        const launchFixture = await nativeHostFixture(
          root,
          path.resolve("dist/extensions/browser/native-host-entry.js"),
        );
        const deps = {
          platform: process.platform,
          homeDir,
          stateDir,
          env: {
            HOME: homeDir,
            ...chromeRootEnv,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_GATEWAY_PORT: String(gatewayPort),
          },
          ...launchFixture,
        };
        const gatewayServer = http.createServer((req, res) => {
          if (req.url === "/browser-owner-proof") {
            diagnostic.mark("http.request", true);
            res.once("finish", () => diagnostic.mark("http.finish", res.statusCode));
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<title>OpenClaw selected tab</title><h1>OpenClaw created destination</h1>");
            return;
          }
          res.writeHead(426);
          res.end();
        });
        let extensionTransport: Duplex | undefined;
        let extensionConnections = 0;
        gatewayServer.on("upgrade", (req, socket, head) => {
          extensionTransport = socket;
          extensionConnections += 1;
          void handleGatewayExtensionUpgrade(req, socket, head);
        });
        await new Promise<void>((resolve) => {
          gatewayServer.listen(gatewayPort, "127.0.0.1", resolve);
        });
        cleanups.push(
          async () =>
            await new Promise<void>((resolve) => {
              gatewayServer.close(() => {
                diagnostic.mark("http.closed", !gatewayServer.listening);
                resolve();
              });
            }),
        );
        cleanups.push(async () => {
          const bridge = getBrowserControlState()?.extensionRelays?.get("e2e")?.bridge;
          const sessions = [...chromeMcpSessions.values()].slice(0, 8);
          try {
            await stopBrowserControlService();
          } finally {
            diagnostic.mark(
              "relay.closed",
              Boolean(bridge && !bridge.extensionConnected && bridge.cdpClientCount === 0),
            );
            for (const session of sessions) {
              diagnostic.mark(
                "mcp.closed",
                session.transport.pid === null && session.processCleanup?.status === "closed",
              );
            }
          }
        });
        // Real Chrome/native children must not inherit Vitest's source overrides
        // or fast-test flags; the launcher owns the installation selectors.
        const browserEnv: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          // Chromium's macOS singleton sockets use this instead of TMPDIR.
          MAC_CHROMIUM_TMPDIR: process.env.TMPDIR,
          HOME: homeDir,
          ...chromeRootEnv,
        };

        const launchChromium = async () =>
          await chromium.launchPersistentContext(userDataDir, {
            channel: "chromium",
            headless: true,
            env: browserEnv,
            ignoreDefaultArgs: ["--disable-extensions"],
            args: ["--enable-unsafe-extension-debugging"],
          });
        let context = await launchChromium();
        process.stderr.write("[browser-extension-e2e] chromium launched\n");
        cleanups.push(async () => await context.close());
        const installed = stableChromeExtensionDir(deps);
        const predictedId = generateChromeExtensionIdForPath(installed, process.platform);
        const expectedOrigins = [
          predictedId,
          generateChromeExtensionIdForPath(extensionSource, process.platform),
        ]
          .toSorted()
          .map((id) => `chrome-extension://${id}/`);
        expectedOrigins.push(STORE_ORIGIN);
        expectedOrigins.sort();
        const relevantManifestPaths = chromeProductRoots(deps)
          .filter((productRoot) => productRoot.userDataDir === userDataDir)
          .map((productRoot) =>
            path.join(productRoot.nativeManifestDir, "ai.openclaw.browser_bootstrap.json"),
          );
        const installPromise = installChromeExtensionBootstrap({
          bundledDir: extensionSource,
          pluginRoot: path.resolve("extensions/browser"),
          waitMs: 15_000,
          deps,
        });
        try {
          await expect
            .poll(
              async () => await exactOwnedManifestsExist(relevantManifestPaths, expectedOrigins),
              {
                timeout: 15_000,
              },
            )
            .toBe(true);
        } catch (error) {
          const status = await installPromise;
          const modes = await Promise.all(
            Object.entries(launchFixture).map(async ([kind, target]) => [
              kind,
              ((await fs.stat(target)).mode & 0o777).toString(8),
            ]),
          );
          const issues = status.issues.map((issue) =>
            issue
              .replaceAll(launchFixture.nativeHostPath, "<native-host>")
              .replaceAll(launchFixture.nodePath, "<node>")
              .replaceAll(root, "<fixture>")
              .replaceAll(extensionSource, "<bundled-extension>"),
          );
          throw new Error(
            `Native host pre-registration failed: ${JSON.stringify({ modes: Object.fromEntries(modes), issues })}`,
            { cause: error },
          );
        }
        process.stderr.write("[browser-extension-e2e] deterministic native host pre-registered\n");
        await loadUnpackedExtension(context, installed);
        const extensionId = await waitForExtensionId(context, installed);
        expect(extensionId).toBe(predictedId);
        process.stderr.write("[browser-extension-e2e] unpacked extension loaded\n");
        await context.close();
        if (process.platform === "linux") {
          // Linux CDP loads are transient and omit the protected record written by Load unpacked.
          // Seed that exact record only after Chromium confirms the path-derived extension ID.
          await seedLinuxSecurePreferences({ userDataDir, extensionId, extensionPath: installed });
        }

        const status = await installPromise;
        expect(status.manualSetupRequired, JSON.stringify(status)).toBe(false);
        expect(
          status.discovered.some(
            (entry) => entry.extensionPath === installed && entry.extensionId === predictedId,
          ),
        ).toBe(true);
        process.stderr.write("[browser-extension-e2e] Secure Preferences identity verified\n");
        context = await launchChromium();
        await loadUnpackedExtension(context, installed);
        expect(await waitForExtensionId(context, installed)).toBe(predictedId);
        process.stderr.write("[browser-extension-e2e] persisted extension reloaded\n");
        const controlled = await context.newPage();
        await controlled.goto(
          `data:text/html,${encodeURIComponent(
            '<title>OpenClaw E2E</title><style>body{margin:0}#spacer{height:2200px}#target{display:block;width:240px;height:96px;background:#1457d9;color:white;border:0;font:20px sans-serif}</style><div id="spacer"></div><button id="target">Offscreen target</button>',
          )}`,
        );

        const extensionPage = await context.newPage();
        await extensionPage.goto(`chrome-extension://${extensionId}/options.html`);
        let extensionStatus: Record<string, unknown> = {};
        try {
          await expect
            .poll(
              async () => {
                extensionStatus = await extensionPage.evaluate(
                  async () => await chrome.runtime.sendMessage({ type: "getStatus" }),
                );
                return extensionStatus.paired;
              },
              { timeout: 15_000 },
            )
            .toBe(true);
        } catch (error) {
          throw new Error(`Extension did not auto-pair: ${JSON.stringify(extensionStatus)}`, {
            cause: error,
          });
        }
        expect(extensionStatus).toMatchObject({ paired: true, accessMode: "all" });
        try {
          await expect
            .poll(
              () =>
                getBrowserControlState()?.extensionRelays?.get("e2e")?.bridge.extensionConnected,
              { timeout: 15_000 },
            )
            .toBe(true);
        } catch (error) {
          extensionStatus = await extensionPage.evaluate(
            async () => await chrome.runtime.sendMessage({ type: "getStatus" }),
          );
          throw new Error(`Extension relay did not connect: ${JSON.stringify(extensionStatus)}`, {
            cause: error,
          });
        }
        const relay = getBrowserControlState()?.extensionRelays?.get("e2e");
        if (!relay || relay.port !== relayPort) {
          throw new Error("Gateway wakeup did not start the configured extension relay");
        }
        diagnostic.watchRelay(relay.bridge);
        const browserState = getBrowserControlState();
        const extensionProfile = browserState?.resolved.profiles.e2e;
        if (!browserState || !extensionProfile) {
          throw new Error("Browser E2E state did not contain the extension profile");
        }
        const existingSessionProfile = "e2e-existing-session";
        const relayAuthorization = `Basic ${Buffer.from(
          `openclaw-internal:${relay.internalToken}`,
        ).toString("base64")}`;
        const relayVersionResponse = await fetch(`http://127.0.0.1:${relay.port}/json/version`, {
          headers: { Authorization: relayAuthorization },
        });
        const relayVersion = (await relayVersionResponse.json()) as {
          webSocketDebuggerUrl?: string;
        };
        if (!relayVersion.webSocketDebuggerUrl) {
          throw new Error("Authenticated extension relay did not return a WebSocket endpoint");
        }
        browserState.resolved.profiles[existingSessionProfile] = {
          ...extensionProfile,
          driver: "existing-session",
          attachOnly: true,
          cdpUrl: `http://openclaw-internal:${encodeURIComponent(relay.internalToken)}@127.0.0.1:${relay.port}`,
          mcpArgs: [
            "--wsEndpoint",
            relayVersion.webSocketDebuggerUrl,
            "--wsHeaders",
            JSON.stringify({ Authorization: relayAuthorization }),
          ],
        };
        browserState.resolved.ssrfPolicy = undefined;
        const routeContext = createBrowserRouteContext({
          getState: () => browserState,
          refreshConfigFromDisk: false,
        });
        const dispatcher = createBrowserRouteDispatcher(routeContext);
        const playwrightTabsResponse = await dispatcher.dispatch({
          method: "GET",
          path: "/tabs",
          query: { profile: "e2e" },
        });
        expect(playwrightTabsResponse.status, JSON.stringify(playwrightTabsResponse.body)).toBe(
          200,
        );
        expect(playwrightTabsResponse.body).toMatchObject({ running: true });
        const matchingDoctor = await dispatcher.dispatch({
          method: "GET",
          path: "/doctor",
          query: { profile: "e2e" },
        });
        expect(matchingDoctor.status).toBe(200);
        expect(matchingDoctor.body).toMatchObject({
          checks: expect.arrayContaining([
            expect.objectContaining({
              id: "extension-version",
              status: "pass",
              summary: `running ${chromeExtensionManifest.version}; bundled ${chromeExtensionManifest.version} (match)`,
            }),
          ]),
        });
        process.stderr.write(
          `[browser-extension-e2e] doctor version match ${chromeExtensionManifest.version}\n`,
        );
        const tabsResponse = await dispatcher.dispatch({
          method: "GET",
          path: "/tabs",
          query: { profile: existingSessionProfile },
        });
        const tabs = (tabsResponse.body as { tabs?: Array<{ targetId?: string; url?: string }> })
          .tabs;
        const controlledTab = tabs?.find((tab) => tab.url?.startsWith("data:text/html"));
        if (!controlledTab?.targetId) {
          throw new Error(`Existing-session E2E tab missing: ${JSON.stringify(tabsResponse.body)}`);
        }
        await proveLabeledRefScreenshot({
          dispatcher,
          controlled,
          profile: existingSessionProfile,
          targetId: controlledTab.targetId,
          proofName: "existing-session-offscreen-labeled-ref.png",
        });

        const earlyPlaywrightTarget = (
          playwrightTabsResponse.body as { tabs?: Array<{ targetId?: string; url?: string }> }
        ).tabs?.find((tab) => tab.url === controlled.url())?.targetId;
        if (!earlyPlaywrightTarget) {
          throw new Error("Initial Playwright inventory did not contain the controlled target");
        }
        // Capture the existing context before the socket fault; target detachment keeps it alive.
        const connectOverCdp = vi.spyOn(chromium, "connectOverCDP");
        let relayPlaywrightContext: BrowserContext;
        try {
          const relayPage = await getPageForTargetId({
            cdpUrl: routeContext.forProfile("e2e").profile.cdpUrl,
            targetId: earlyPlaywrightTarget,
          });
          relayPlaywrightContext = relayPage.context();
          expect(connectOverCdp).not.toHaveBeenCalled();
          const bindingSession = await relayPlaywrightContext.newCDPSession(relayPage);
          const bindingName = "__openclawRelayBindingProof";
          const bindingPayloads: string[] = [];
          bindingSession.on("Runtime.bindingCalled", (event) => {
            if (event.name === bindingName) {
              bindingPayloads.push(event.payload);
            }
          });
          try {
            await bindingSession.send("Runtime.addBinding", { name: bindingName });
            await bindingSession.send("Runtime.evaluate", {
              expression: "globalThis.__openclawRelayBindingProof('before-enable')",
            });
            await expect.poll(() => bindingPayloads).toEqual(["before-enable"]);
            await bindingSession.send("Runtime.enable");
            await bindingSession.send("Runtime.disable");
            await bindingSession.send("Runtime.evaluate", {
              expression: "globalThis.__openclawRelayBindingProof('after-disable')",
            });
            await expect.poll(() => bindingPayloads).toEqual(["before-enable", "after-disable"]);
          } finally {
            await bindingSession
              .send("Runtime.removeBinding", { name: bindingName })
              .catch(() => {});
            await bindingSession.detach().catch(() => {});
          }
        } finally {
          connectOverCdp.mockRestore();
        }

        expect(relay.bridge.cdpClientCount).toBeGreaterThanOrEqual(2);
        const previousConnections = extensionConnections;
        if (!extensionTransport) {
          throw new Error("Test-owned extension transport missing");
        }
        extensionTransport.destroy();
        await expect
          .poll(() => extensionConnections, { timeout: 15_000 })
          .toBeGreaterThan(previousConnections);
        await expect.poll(() => relay.bridge.extensionConnected).toBe(true);
        const reconnectedTabsResponse = await dispatcher.dispatch({
          method: "GET",
          path: "/tabs",
          query: { profile: existingSessionProfile },
        });
        const reconnectedTarget = (
          reconnectedTabsResponse.body as { tabs?: Array<{ targetId?: string; url?: string }> }
        ).tabs?.find((tab) => tab.url === controlled.url())?.targetId;
        if (!reconnectedTarget) {
          throw new Error(
            `Reconnected target missing: ${JSON.stringify(reconnectedTabsResponse.body)}`,
          );
        }
        await proveLabeledRefScreenshot({
          dispatcher,
          controlled,
          profile: existingSessionProfile,
          targetId: reconnectedTarget,
          proofName: "existing-session-reconnected-offscreen-labeled-ref.png",
        });
        expect(relay.bridge.cdpClientCount).toBeGreaterThanOrEqual(2);
        process.stderr.write(
          "[browser-extension-e2e] same-browser transport-reconnect labeled-ref screenshot passed\n",
        );

        const distractingPage = await context.newPage();
        const distractingUrl = `data:text/html,${encodeURIComponent("<title>Unrelated tab</title>")}`;
        await distractingPage.goto(distractingUrl);
        await expect
          .poll(() => relayPlaywrightContext.pages().some((page) => page.url() === distractingUrl))
          .toBe(true);
        const liveTabsResponse = await dispatcher.dispatch({
          method: "GET",
          path: "/tabs",
          query: { profile: "e2e" },
        });
        const liveTabs = (
          liveTabsResponse.body as { tabs?: Array<{ targetId?: string; url?: string }> }
        ).tabs;
        const selectedTab = liveTabs?.find((tab) => tab.url === controlled.url());
        const unrelatedTab = liveTabs?.find((tab) => tab.url === distractingUrl);
        if (!selectedTab?.targetId || !unrelatedTab?.targetId) {
          throw new Error(
            `Extension navigation proof tabs missing: ${JSON.stringify(liveTabsResponse)}`,
          );
        }
        expect(selectedTab.targetId).not.toBe(unrelatedTab.targetId);
        const previousSsrfPolicy = browserState.resolved.ssrfPolicy;
        browserState.resolved.ssrfPolicy = { allowPrivateNetwork: true };
        const extensionCdpUrl = routeContext.forProfile("e2e").profile.cdpUrl;
        const proofUrl = `http://127.0.0.1:${gatewayPort}/browser-owner-proof`;
        diagnostic.arm(selectedTab.targetId, unrelatedTab.targetId);
        diagnostic.mark("relay.clients", relay.bridge.cdpClientCount);
        for (const session of [...chromeMcpSessions.values()].slice(0, 8)) {
          diagnostic.peer(session.client.getServerVersion());
        }
        const stopPageObservation = diagnostic.watchPage(controlled, proofUrl);
        const selectedOwner = relay.bridge.captureOperationTarget(selectedTab.targetId);
        const unrelatedOwner = relay.bridge.captureOperationTarget(unrelatedTab.targetId);
        const actedPage = await getPageForTargetId({
          cdpUrl: extensionCdpUrl,
          targetId: selectedTab.targetId,
          ssrfPolicy: browserState.resolved.ssrfPolicy,
        });
        const detachedNavigation = vi.spyOn(actedPage, "goto").mockImplementationOnce(() => {
          diagnostic.mark("injection.used", true);
          return Promise.reject(new Error("page.goto: Frame has been detached"));
        });
        const worker = context
          .serviceWorkers()
          .find((entry) => entry.url().startsWith(`chrome-extension://${extensionId}/`));
        if (!worker) {
          throw new Error("Extension service worker missing");
        }
        const finishNavigationProbe = await holdNavigationAccessCheck(worker, proofUrl);
        let probe: Awaited<ReturnType<typeof finishNavigationProbe>>;
        try {
          const navigationResponse = await dispatcher.dispatch({
            method: "POST",
            path: "/navigate",
            query: { profile: "e2e" },
            body: {
              targetId: selectedTab.targetId,
              url: `http://127.0.0.1:${gatewayPort}/browser-owner-proof`,
            },
          });
          diagnostic.mark("navigate.status", navigationResponse.status);
          expect(navigationResponse.status, JSON.stringify(navigationResponse.body)).toBe(200);
          expect(navigationResponse.body).toMatchObject({
            ok: true,
            targetId: selectedTab.targetId,
            url: `http://127.0.0.1:${gatewayPort}/browser-owner-proof`,
          });
          expect(detachedNavigation).toHaveBeenCalledTimes(1);
          const recoveredPage = await getPageForTargetId({
            cdpUrl: extensionCdpUrl,
            targetId: selectedTab.targetId,
            ssrfPolicy: browserState.resolved.ssrfPolicy,
          });
          diagnostic.mark("adapter.fresh", recoveredPage !== actedPage);
          expect(recoveredPage).not.toBe(actedPage);
          expect(distractingPage.url()).toBe(distractingUrl);
          process.stderr.write(
            "[browser-extension-e2e] injected-detach=1 production-reconnect=1 owner-target-preserved=1 unrelated-tab-unchanged=1 status=200\n",
          );
        } finally {
          diagnostic.mark("injection.calls", detachedNavigation.mock.calls.length);
          diagnostic.mark("owner.selected", selectedOwner?.() === selectedTab.targetId);
          diagnostic.mark("owner.unrelated", unrelatedOwner?.() === unrelatedTab.targetId);
          diagnostic.mark("direct.url", controlled.url() === proofUrl);
          diagnostic.mark("unrelated.url", distractingPage.url() === distractingUrl);
          diagnostic.mark("relay.clients", relay.bridge.cdpClientCount);
          stopPageObservation();
          diagnostic.flush();
          detachedNavigation.mockRestore();
          browserState.resolved.ssrfPolicy = previousSsrfPolicy;
          probe = await finishNavigationProbe();
        }
        expect(probe.heldReads).toBeGreaterThan(0);
        expect(probe.sawLoad).toBe(true);

        const creationPolicy = browserState.resolved.ssrfPolicy;
        browserState.resolved.ssrfPolicy = {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        };
        try {
          for (const accessMode of ["all", "selected"] as const) {
            expect(
              await extensionPage.evaluate(
                async (mode) =>
                  await chrome.runtime.sendMessage({ type: "setAccessMode", accessMode: mode }),
                accessMode,
              ),
            ).toMatchObject({ ok: true });
            await assertRelayTabCreation({
              context,
              extensionPage,
              dispatcher,
              url: `http://127.0.0.1:${gatewayPort}/browser-owner-proof`,
              accessMode,
            });
          }
        } finally {
          await extensionPage.evaluate(
            async () =>
              await chrome.runtime.sendMessage({
                type: "setAccessMode",
                accessMode: "all",
              }),
          );
          browserState.resolved.ssrfPolicy = creationPolicy;
        }

        const registration = status.registrations.find(
          (entry) => relevantManifestPaths.includes(entry.manifestPath) && entry.state === "owned",
        );
        if (!registration) {
          throw new Error("Active Chromium native host registration missing");
        }
        const manifest = JSON.parse(await fs.readFile(registration.manifestPath, "utf8")) as {
          path: string;
        };
        const requestBody = Buffer.from(
          JSON.stringify({ v: 1, op: "bootstrap", nonce: "BwcHBwcHBwcHBwcHBwcHBw" }),
        );
        const requestFrame = Buffer.alloc(requestBody.length + 4);
        if (os.endianness() === "LE") {
          requestFrame.writeUInt32LE(requestBody.length);
        } else {
          requestFrame.writeUInt32BE(requestBody.length);
        }
        requestBody.copy(requestFrame, 4);
        const hostProbe = spawnSync(manifest.path, [`chrome-extension://${extensionId}/`], {
          input: requestFrame,
          env: browserEnv,
          timeout: 30_000,
        });
        expect(
          hostProbe.status,
          `native host exit=${hostProbe.status} signal=${hostProbe.signal} stderr=${hostProbe.stderr.toString("utf8")}`,
        ).toBe(0);
        const nativeResponse = decodeSingleNativeResponse(hostProbe.stdout);
        if (
          nativeResponse.ok !== true ||
          nativeResponse.nonce !== "BwcHBwcHBwcHBwcHBwcHBw" ||
          typeof nativeResponse.pairingString !== "string"
        ) {
          throw new Error("native host did not bootstrap successfully");
        }
        const fragmentAt = nativeResponse.pairingString.lastIndexOf("#");
        if (fragmentAt < 0) {
          throw new Error("native host returned an invalid local bootstrap response");
        }
        let relayUrl: URL;
        try {
          relayUrl = new URL(nativeResponse.pairingString.slice(0, fragmentAt));
        } catch {
          throw new Error("native host returned an invalid local bootstrap response");
        }
        if (
          relayUrl.hostname !== "127.0.0.1" ||
          relayUrl.port !== String(gatewayPort) ||
          relayUrl.pathname !== "/browser/extension" ||
          relayUrl.searchParams.get("gateway") !== `ws://127.0.0.1:${gatewayPort}` ||
          nativeResponse.pairingString.slice(fragmentAt + 1) !== token
        ) {
          throw new Error("native host did not use the custom installation context");
        }
        const storeHostProbe = spawnSync(manifest.path, [STORE_ORIGIN], {
          input: requestFrame,
          env: browserEnv,
          timeout: 30_000,
        });
        expect(
          storeHostProbe.status,
          `Store native host exit=${storeHostProbe.status} signal=${storeHostProbe.signal} stderr=${storeHostProbe.stderr.toString("utf8")}`,
        ).toBe(0);
        expect(decodeSingleNativeResponse(storeHostProbe.stdout)).toMatchObject({
          ok: true,
          nonce: "BwcHBwcHBwcHBwcHBwcHBw",
        });
        process.stderr.write("[browser-extension-e2e] launcher probe passed\n");

        await expect
          .poll(() =>
            relay.bridge.accessibleTabs().some((tab) => tab.url.startsWith("data:text/html")),
          )
          .toBe(true);

        const tabId = relay.bridge
          .accessibleTabs()
          .find((tab) => tab.url.startsWith("data:text/html"))?.tabId;
        if (tabId === undefined) {
          throw new Error("Ungrouped E2E tab was not exposed in All tabs mode");
        }
        await extensionPage.evaluate(
          async ({ tabId: id }) =>
            await chrome.runtime.sendMessage({
              type: "toggleTabAccess",
              tabId: id,
              accessMode: "all",
              grant: false,
            }),
          { tabId },
        );
        await expect
          .poll(() => relay.bridge.accessibleTabs().some((tab) => tab.tabId === tabId))
          .toBe(false);

        const installedManifestPath = path.join(installed, "manifest.json");
        const installedManifest = JSON.parse(await fs.readFile(installedManifestPath, "utf8")) as {
          version: string;
        };
        const outdatedVersion = chromeExtensionManifest.version === "2.0.0" ? "1.0.0" : "2.0.0";
        await fs.writeFile(
          installedManifestPath,
          `${JSON.stringify({ ...installedManifest, version: outdatedVersion }, null, 2)}\n`,
        );
        await context.close();
        context = await launchChromium();
        await loadUnpackedExtension(context, installed);
        expect(await waitForExtensionId(context, installed)).toBe(extensionId);
        const outdatedExtensionPage = await context.newPage();
        await outdatedExtensionPage.goto(`chrome-extension://${extensionId}/options.html`);
        await expect.poll(() => relay.bridge.identity?.extensionVersion).toBe(outdatedVersion);
        const outdatedDoctor = await dispatcher.dispatch({
          method: "GET",
          path: "/doctor",
          query: { profile: "e2e" },
        });
        expect(outdatedDoctor.status).toBe(200);
        expect(outdatedDoctor.body).toMatchObject({
          ok: true,
          checks: expect.arrayContaining([
            expect.objectContaining({
              id: "extension-version",
              status: "warn",
              summary: `running ${outdatedVersion}; bundled ${chromeExtensionManifest.version} (mismatch)`,
              fixHint: expect.stringMatching(/reload/i),
            }),
          ]),
        });
        process.stderr.write(
          `[browser-extension-e2e] doctor version mismatch running=${outdatedVersion} bundled=${chromeExtensionManifest.version} status=WARN\n`,
        );

        const extensionContext = routeContext.forProfile("e2e");
        await outdatedExtensionPage.evaluate(
          async () => await chrome.runtime.sendMessage({ type: "unpair" }),
        );
        await expect.poll(() => relay.bridge.extensionConnected).toBe(false);
        const pageCountBeforeUnavailableSelection = context.pages().length;
        await expect(extensionContext.ensureTabAvailable()).rejects.toThrow();
        expect(context.pages()).toHaveLength(pageCountBeforeUnavailableSelection);
      },
    );
  }, 120_000);
});
