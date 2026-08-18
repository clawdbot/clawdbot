import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { chromium, type BrowserContext } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  chromeProductRoots,
  generateChromeExtensionIdForPath,
  stableChromeExtensionDir,
} from "../src/browser/extension-install-layout.js";
import { installChromeExtensionBootstrap } from "../src/browser/extension-install.js";
import { handleGatewayExtensionUpgrade } from "../src/browser/extension-relay/gateway-relay-route.js";
import { getFreePort } from "../src/browser/test-port.js";
import { getBrowserControlState, stopBrowserControlService } from "../src/control-service.js";
import { relayTestKey } from "./relay-key.test-support.js";

declare const chrome: {
  runtime: { sendMessage: (message: unknown) => Promise<Record<string, unknown>> };
};

const runE2E =
  process.env.OPENCLAW_BROWSER_EXTENSION_E2E === "1" &&
  (process.platform === "linux" || process.platform === "darwin");
const cleanups: Array<() => Promise<void>> = [];
const STORE_ORIGIN = "chrome-extension://kcdjddhmeafeomebliikmbpblkmkfoig/";

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
        const nativeHostPath = await fs.realpath(
          path.resolve("extensions/browser/native-host-entry.ts"),
        );
        const tsxPath = await fs.realpath(path.resolve("node_modules/.bin/tsx"));
        const tsxTsconfigPath = path.resolve("tsconfig.json");
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
          nodePath: tsxPath,
          nativeHostPath,
        };
        const gatewayServer = http.createServer((_req, res) => {
          res.writeHead(426);
          res.end();
        });
        gatewayServer.on("upgrade", (req, socket, head) => {
          void handleGatewayExtensionUpgrade(req, socket, head);
        });
        await new Promise<void>((resolve) => {
          gatewayServer.listen(gatewayPort, "127.0.0.1", resolve);
        });
        cleanups.push(
          async () =>
            await new Promise<void>((resolve) => {
              gatewayServer.close(() => resolve());
            }),
        );
        cleanups.push(stopBrowserControlService);
        const browserEnv: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: homeDir,
          ...chromeRootEnv,
          TSX_TSCONFIG_PATH: tsxTsconfigPath,
        };
        delete browserEnv.OPENCLAW_STATE_DIR;
        delete browserEnv.OPENCLAW_CONFIG_PATH;
        delete browserEnv.VITEST;
        delete browserEnv.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

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
        await expect
          .poll(
            async () => await exactOwnedManifestsExist(relevantManifestPaths, expectedOrigins),
            {
              timeout: 15_000,
            },
          )
          .toBe(true);
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
        await controlled.goto("data:text/html,<title>OpenClaw E2E</title><p>ready</p>");

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
      },
    );
  }, 120_000);
});
