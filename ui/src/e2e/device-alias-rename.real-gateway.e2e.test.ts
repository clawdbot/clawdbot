// Control UI E2E: renaming a paired device alias from the Devices page against
// a real in-process Gateway. Proves the save is a persisted Gateway write, not
// a client-side effect: the alias survives a full page reload and a Gateway
// restart, and reads back from the pairing store with the UI's own RPC.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { validateDevicePairRenameParams } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { approveDevicePairing } from "../../../src/infra/device-pairing-approval.js";
import {
  listDevicePairing,
  requestDevicePairing,
  type PairedDevice,
} from "../../../src/infra/device-pairing.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI device alias rename with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

// Visual proof rides the behavioral scenario so every captured state is one the
// assertions above it already proved, at whatever SHA the lane ran.
const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function captureUiProof(page: Page, fileName: string, observed: Record<string, unknown>) {
  if (!captureEnabled) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    path: path.join(suite.artifactDir, fileName),
  });
  const script = await page.locator('script[type="module"][src]').first().getAttribute("src");
  expect(script).toBeTruthy();
  const assetUrl = new URL(script!, page.url());
  expect(assetUrl.origin).toBe(new URL(page.url()).origin);
  const response = await page.request.get(assetUrl.href);
  expect(response.ok()).toBe(true);
  const bundle = {
    path: assetUrl.pathname,
    sha256: createHash("sha256")
      .update(await response.body())
      .digest("hex"),
  };
  await writeFile(
    path.join(suite.artifactDir, fileName.replace(/\.png$/u, ".json")),
    `${JSON.stringify({ ...observed, bundle }, null, 2)}\n`,
    "utf8",
  );
}

const DISPLAY_NAME = "office-workstation.example.test";
const NEW_ALIAS = "🙂".repeat(33);

function pairedDeviceProof(device: PairedDevice | undefined) {
  if (!device) {
    return undefined;
  }
  // Internal pairing rows include credentials; proof needs only identity and naming facts.
  const { deviceId, operatorLabel, displayName, roles } = device;
  return { deviceId, operatorLabel, displayName, roles };
}

/** Confirm the gateway URL dialog. Required on first load; after a reload the UI remembers the confirmed URL and may not ask again. */
async function confirmGatewayUrl(page: Page, options: { required: boolean }) {
  const confirmation = page.locator("openclaw-gateway-url-confirmation");
  await confirmation
    .waitFor({ state: "visible", timeout: options.required ? 10_000 : 3_000 })
    .catch(() => undefined);
  if (!(await confirmation.isVisible().catch(() => false))) {
    if (options.required) {
      throw new Error("gateway URL confirmation dialog did not appear");
    }
    return;
  }
  await confirmation.getByRole("button", { name: /^Switch to /u }).click();
}

function devicesPageUrl(gatewayPort: number) {
  const url = new URL("settings/devices", suite.server.baseUrl);
  url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${gatewayPort}`);
  return url.toString();
}

suite.define(() => {
  it("persists a Devices-page alias rename through the real Gateway across reload and restart", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-device-alias-rename",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    try {
      await state.writeConfig({
        gateway: {
          auth: { mode: "none" },
          controlUi: {
            allowedOrigins: [new URL(suite.server.baseUrl).origin],
            enabled: false,
          },
          port,
        },
      });
      state.applyEnv();

      // Seed one approved operator pairing before the Gateway starts so the
      // Devices page has a real persisted row to rename.
      const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
        await import("../../../src/infra/device-identity.js");
      const identityPath = path.join(state.stateDir, `device-alias-proof.sqlite`);
      const identity = loadOrCreateDeviceIdentity({ path: identityPath });
      const seeded = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        role: "operator",
        scopes: ["operator.read"],
        clientId: "control-ui-device-alias-proof",
        clientMode: "cli",
        displayName: DISPLAY_NAME,
        platform: "linux",
      });
      await approveDevicePairing(seeded.request.requestId, {
        callerScopes: ["operator.admin"],
      });

      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });

      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
          ...(captureEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } } }
            : {}),
        },
        async ({ page }) => {
          await page.goto(devicesPageUrl(port));
          await confirmGatewayUrl(page, { required: true });
          const row = page.locator(".device-entry", { hasText: DISPLAY_NAME });
          await row.waitFor();
          await captureUiProof(page, "01-real-gateway-devices-inventory.png", {
            stage: "seeded paired device listed",
            displayName: DISPLAY_NAME,
          });

          await row.locator(".device-entry__menu-trigger").click();
          await page.locator('wa-dropdown-item[value="editAlias"]').click();
          const dialog = page.locator("openclaw-modal-dialog").last();
          await dialog.locator('input[name="value"]').waitFor();
          await captureUiProof(page, "02-real-gateway-alias-dialog-open.png", {
            stage: "rename dialog opened",
          });

          const protocolAccepted = validateDevicePairRenameParams({
            deviceId: identity.deviceId,
            label: NEW_ALIAS,
          });
          expect(protocolAccepted).toBe(true);
          const input = dialog.locator('input[name="value"]');
          await input.click();
          await page.keyboard.insertText(NEW_ALIAS);
          const entered = await input.inputValue();
          await captureUiProof(page, "03-real-gateway-alias-dialog-filled.png", {
            stage: "operator entered a protocol-valid Unicode alias",
            protocolAccepted,
            requestedAlias: NEW_ALIAS,
            enteredAlias: entered,
            requestedCodeUnits: NEW_ALIAS.length,
            enteredCodeUnits: entered.length,
            maxLength: await input.getAttribute("maxlength"),
          });
          expect(entered).toBe(NEW_ALIAS);
          await dialog.getByRole("button", { name: "Save" }).click();

          await page
            .locator(".device-entry .settings-row__title", { hasText: NEW_ALIAS })
            .waitFor();

          // Independent readback from the pairing store: the rename must be a
          // durable Gateway write, not a client-side label swap.
          const stored = await listDevicePairing();
          const paired = stored.paired.find((device) => device.deviceId === identity.deviceId);
          expect(paired?.operatorLabel).toBe(NEW_ALIAS);
          expect(paired?.displayName).toBe(DISPLAY_NAME);
          await captureUiProof(page, "04-real-gateway-alias-applied.png", {
            stage: "alias applied and read back from the pairing store",
            paired: pairedDeviceProof(paired),
          });

          // Full page reload: the UI must re-read the alias from the Gateway.
          await page.reload();
          await confirmGatewayUrl(page, { required: false });
          await page
            .locator(".device-entry .settings-row__title", { hasText: NEW_ALIAS })
            .waitFor();
          await captureUiProof(page, "05-real-gateway-alias-after-reload.png", {
            stage: "alias survives full page reload",
          });

          // Stop and restart the Gateway server in this test process, then
          // verify that both the browser and pairing store retain the alias.
          await gateway?.close({ reason: "device alias rename e2e restart" });
          gateway = await startGatewayServer(port, {
            auth: { mode: "none" },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          });
          await page.reload();
          await confirmGatewayUrl(page, { required: false });
          await page
            .locator(".device-entry .settings-row__title", { hasText: NEW_ALIAS })
            .waitFor();
          const afterRestart = await listDevicePairing();
          expect(
            afterRestart.paired.find((device) => device.deviceId === identity.deviceId)
              ?.operatorLabel,
          ).toBe(NEW_ALIAS);
          await captureUiProof(page, "06-real-gateway-alias-after-restart.png", {
            stage: "alias survives Gateway restart",
            paired: pairedDeviceProof(
              afterRestart.paired.find((device) => device.deviceId === identity.deviceId),
            ),
          });
        },
      );
    } finally {
      try {
        await gateway?.close({ reason: "device alias rename e2e cleanup" });
      } finally {
        await state.cleanup();
      }
    }
  });
});
