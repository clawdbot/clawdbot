// Control UI tests cover mobile pairing setup through the mocked Gateway.
import path from "node:path";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { Page } from "playwright";
import qrcode from "qrcode";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI mobile pairing mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

// Visual proof rides the behavioral scenario so every captured state is one the
// assertions above it already proved, at whatever SHA the lane ran.
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("mobile-pairing");
  }
});

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({ animations: "disabled", path: path.join(uiProofArtifactDir, fileName) });
}

suite.define(() => {
  it("opens pairing from a catalog command without creating a transcript turn", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const baselineText = "Pairing command baseline transcript.";
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              content: [{ text: baselineText, type: "text" }],
              role: "assistant",
              timestamp: Date.now(),
            },
          ],
          methodResponses: {
            "commands.list": {
              commands: [
                {
                  name: "pair",
                  textAliases: ["/pair"],
                  description: "Generate setup codes and approve device pairing requests.",
                  source: "plugin",
                  scope: "both",
                  acceptsArgs: true,
                  clientPresentation: {
                    when: "no-arguments",
                    action: { kind: "device-pairing" },
                  },
                },
              ],
            },
            "device.pair.list": { paired: [], pending: [] },
          },
          operatorScopes: ["operator.admin"],
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const baseline = page
          .locator(".chat-group.assistant .chat-text")
          .getByText(baselineText, { exact: true });
        await baseline.waitFor();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("/pa");
        await gateway.waitForRequest("commands.list");
        const pairOption = page.getByRole("option").filter({ hasText: "/pair" });
        await pairOption.waitFor();
        await pairOption.click();
        await expect.poll(() => composer.inputValue()).toBe("/pair ");
        await page.getByRole("button", { name: "Send message" }).click();

        const dialog = page.getByRole("dialog", { name: "Pair a device" });
        await dialog.waitFor();
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
        expect(await baseline.count()).toBe(1);
        expect(await page.locator(".chat-group.user", { hasText: "/pair" }).count()).toBe(0);

        await page.locator(".device-pair-setup__close").click();
        await dialog.waitFor({ state: "hidden" });
        await page.reload();
        await baseline.waitFor();
        expect(await page.locator(".chat-group.user", { hasText: "/pair" }).count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toEqual([]);

        await composer.fill("/pair status");
        await page.getByRole("button", { name: "Send message" }).click();
        const remote = await gateway.waitForRequest("chat.send");
        const remoteParams = requireRecord(remote.params);
        expect(remoteParams).toEqual(expect.objectContaining({ message: "/pair status" }));
        const remoteReply = "Pair status completed remotely.";
        await gateway.emitChatFinal({
          runId: requireString(remoteParams.idempotencyKey, "pair status run id"),
          text: remoteReply,
        });
        await page
          .locator(".chat-group.assistant .chat-text")
          .getByText(remoteReply, { exact: true })
          .waitFor();
        await expect.poll(() => page.locator(".chat-queue").count()).toBe(0);

        await gateway.setMethodResponse("commands.list", {
          commands: [
            {
              name: "pair",
              textAliases: ["/pair"],
              description: "Generate setup codes and approve device pairing requests.",
              source: "plugin",
              scope: "both",
              acceptsArgs: true,
            },
          ],
        });
        await page.reload();
        await baseline.waitFor();
        await composer.fill("/pa");
        await expect.poll(async () => (await gateway.getRequests("commands.list")).length).toBe(1);
        await page.getByRole("option").filter({ hasText: "/pair" }).click();
        await page.getByRole("button", { name: "Send message" }).click();
        await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(1);
        expect((await gateway.getRequests("chat.send")).at(-1)?.params).toEqual(
          expect.objectContaining({ message: "/pair" }),
        );
      },
    );
  });

  it("retires exact setup credentials across success, expiry, regeneration, and errors", async () => {
    const setupCode = Buffer.from(
      JSON.stringify({
        url: "wss://gateway.example.test",
        bootstrapToken: "e2e-bootstrap-token",
      }),
      "utf8",
    ).toString("base64url");
    const qrDataUrl = await qrcode.toDataURL(setupCode, { margin: 2, width: 360 });
    const setupResult = (
      setupId: string,
      access: "full" | "limited" | "node",
      expiresAtMs = Date.now() + 120_000,
      resolvedSetupCode = setupCode,
    ) => ({
      setupId,
      expiresAtMs,
      auth: "token",
      gatewayUrl: "wss://gateway.example.test",
      ...(access === "node" ? {} : { qrDataUrl }),
      setupCode: resolvedSetupCode,
      urlSource: "test",
      access,
    });

    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
          methodResponses: {
            "device.pair.list": { paired: [], pending: [] },
            "device.pair.setupCode": setupResult("setup-full", "full"),
            "device.pair.setupStatus": {},
            "node.list": { nodes: [] },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/security`);
        expect(response?.status()).toBe(200);
        const pairFromSettings = page
          .locator(".security-page")
          .getByRole("button", { name: "Pair device" });
        await expect.poll(async () => pairFromSettings.isEnabled()).toBe(true);
        await pairFromSettings.click();

        const dialog = page.getByRole("dialog", { name: "Pair a device" });
        const qr = page.getByAltText("OpenClaw mobile pairing QR code");
        await dialog.waitFor();
        await page.getByRole("button", { name: "Create setup code" }).waitFor();
        const dialogBox = await page.locator(".device-pair-setup").boundingBox();
        expect(dialogBox?.width).toBeLessThanOrEqual(390);
        await captureUiProof(page, "01-mobile-access-selection.png");

        const helpDocumentUrl = "https://docs.openclaw.ai/channels/pairing";
        const helpUrl = `${helpDocumentUrl}#pair-from-the-control-ui-recommended`;
        // This mocked scenario owns navigation, not docs-site availability. Context
        // routing also covers the popup's first request, which page routing misses.
        await page.context().route(helpDocumentUrl, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Pairing help</title>",
          }),
        );
        const help = page.getByRole("link", { name: "Pairing help (opens in a new tab)" });
        expect(await help.getAttribute("href")).toBe(helpUrl);
        expect(await help.getAttribute("target")).toBe("_blank");
        expect((await help.getAttribute("rel"))?.split(" ")).toEqual(
          expect.arrayContaining(["noopener", "noreferrer"]),
        );
        expect(await help.locator("svg").count()).toBe(1);
        await help.focus();
        expect(await help.evaluate((element) => element === document.activeElement)).toBe(true);
        await help.hover();
        await captureUiProof(page, "10-mobile-pairing-help-focus-hover.png");
        const [helpPopup] = await Promise.all([page.waitForEvent("popup"), help.click()]);
        await helpPopup.waitForURL(helpUrl);
        expect(helpPopup.url()).toBe(helpUrl);
        expect(await helpPopup.title()).toBe("Pairing help");
        await helpPopup.close();

        await gateway.deferNext("device.pair.setupCode");
        await page.getByRole("button", { name: "Create setup code" }).click();
        expect(
          await page.getByRole("status").getByText("Creating a secure setup code…").isVisible(),
        ).toBe(true);
        expect(await qr.count()).toBe(0);
        expect(await page.locator('input[name="device-pair-access"]').first().isDisabled()).toBe(
          true,
        );
        await captureUiProof(page, "02-mobile-loading.png");
        await gateway.resolveDeferred("device.pair.setupCode", setupResult("setup-full", "full"));
        await qr.waitFor();
        await captureUiProof(page, "03-mobile-waiting.png");

        await gateway.emitGatewayEvent("device.pair.setup.completed", {
          setupId: "setup-unrelated",
          deviceId: "phone-unrelated",
          deviceName: "Unrelated phone",
          access: "full",
          ts: 1,
        });
        expect(await qr.isVisible()).toBe(true);
        await gateway.emitGatewayEvent("device.pair.setup.completed", {
          setupId: "setup-full",
          deviceId: "phone-full",
          deviceName: "Test iPhone",
          access: "full",
          ts: 2,
        });
        await expect.poll(async () => qr.count()).toBe(0);
        expect(await page.getByText("Test iPhone", { exact: true }).isVisible()).toBe(true);
        expect(
          await page.getByText("Device paired · Full access", { exact: true }).isVisible(),
        ).toBe(true);
        await captureUiProof(page, "04-mobile-full-success.png");
        await page.getByRole("button", { name: "Done" }).click();
        await dialog.waitFor({ state: "hidden" });

        await page.setViewportSize({ height: 900, width: 1280 });
        await pairFromSettings.click();
        await page.locator('input[name="device-pair-access"]').nth(1).check();
        await gateway.setMethodResponse(
          "device.pair.setupCode",
          setupResult("setup-limited", "limited"),
        );
        await page.getByRole("button", { name: "Create setup code" }).click();
        await qr.waitFor();
        expect((await gateway.getRequests("device.pair.setupCode")).at(-1)?.params).toEqual({
          bootstrapProfile: "limited",
        });
        await gateway.emitGatewayEvent("device.pair.setup.completed", {
          setupId: "setup-limited",
          deviceId: "phone-limited",
          access: "limited",
          ts: 3,
        });
        await expect.poll(async () => qr.count()).toBe(0);
        expect(
          await page.getByRole("heading", { name: "Device paired", exact: true }).isVisible(),
        ).toBe(true);
        expect(await page.getByText("Limited access", { exact: true }).isVisible()).toBe(true);
        await captureUiProof(page, "05-desktop-limited-success.png");
        await page.getByRole("button", { name: "Done" }).click();

        // The completion event is droppable. With the event never delivered, the
        // lapsing credential must still resolve to paired, not to expired.
        await pairFromSettings.click();
        await gateway.setMethodResponse(
          "device.pair.setupCode",
          setupResult("setup-missed", "full", Date.now() + 2_000),
        );
        await gateway.setMethodResponse("device.pair.setupStatus", {
          completion: {
            setupId: "setup-missed",
            deviceId: "phone-missed",
            deviceName: "Recovered iPhone",
            access: "full",
            ts: 5,
          },
        });
        await page.getByRole("button", { name: "Create setup code" }).click();
        await qr.waitFor();
        await page.getByText("Recovered iPhone", { exact: true }).waitFor();
        expect(await qr.count()).toBe(0);
        expect(await page.getByText("Setup code expired", { exact: true }).count()).toBe(0);
        expect((await gateway.getRequests("device.pair.setupStatus")).at(-1)?.params).toEqual({
          setupId: "setup-missed",
        });
        await captureUiProof(page, "06-desktop-reconciled-success.png");
        await page.getByRole("button", { name: "Done" }).click();

        // Retiring the bearer is not success when the credential-bearing
        // response did not finish. Surface a recovery path instead.
        await pairFromSettings.click();
        await gateway.setMethodResponse(
          "device.pair.setupCode",
          setupResult("setup-uncertain", "full", Date.now() + 2_000),
        );
        await gateway.setMethodResponse("device.pair.setupStatus", {
          deliveryUncertain: {
            setupId: "setup-uncertain",
            deviceId: "phone-uncertain",
            access: "full",
            ts: 6,
          },
        });
        await page.getByRole("button", { name: "Create setup code" }).click();
        await page
          .getByRole("heading", { name: "Pairing delivery could not be confirmed" })
          .waitFor();
        expect(await qr.count()).toBe(0);
        expect(await page.getByRole("button", { name: "Generate new code" }).isVisible()).toBe(
          true,
        );
        expect(await page.getByRole("button", { name: "Manage devices" }).isVisible()).toBe(true);
        await captureUiProof(page, "07-desktop-delivery-uncertain.png");
        await page.locator(".device-pair-setup__close").click();

        await pairFromSettings.click();
        await gateway.deferNext("device.pair.setupStatus");
        await gateway.setMethodResponse(
          "device.pair.setupCode",
          setupResult("setup-expired", "full", 0),
        );
        await page.getByRole("button", { name: "Create setup code" }).click();
        await page.getByRole("status").getByText("Loading…", { exact: true }).waitFor();
        expect(await qr.count()).toBe(0);
        expect(await page.getByRole("button", { name: "Copy setup code" }).count()).toBe(0);
        expect(await page.getByText(setupCode, { exact: true }).count()).toBe(0);
        await gateway.resolveDeferred("device.pair.setupStatus", {});
        await page.getByRole("heading", { name: "Setup code expired", exact: true }).waitFor();
        expect(await qr.count()).toBe(0);
        await captureUiProof(page, "07-desktop-expired.png");

        await gateway.setMethodResponse(
          "device.pair.setupCode",
          setupResult("setup-current", "full"),
        );
        await gateway.deferNext("device.pair.setupCode");
        await page.getByRole("button", { name: "Generate new code" }).click();
        expect(await qr.count()).toBe(0);
        expect(
          await page.getByText("Creating a secure setup code…", { exact: true }).isVisible(),
        ).toBe(true);
        await gateway.resolveDeferred(
          "device.pair.setupCode",
          setupResult("setup-current", "full"),
        );
        await qr.waitFor();
        await gateway.emitGatewayEvent("device.pair.setup.completed", {
          setupId: "setup-expired",
          deviceId: "phone-stale",
          access: "full",
          ts: 4,
        });
        expect(await qr.isVisible()).toBe(true);
        await captureUiProof(page, "08-desktop-regenerated-waiting.png");

        await gateway.deferNext("device.pair.setupCode");
        await page.getByRole("button", { name: "New code" }).click();
        expect(await qr.count()).toBe(0);
        await gateway.rejectDeferred("device.pair.setupCode", { message: "setup unavailable" });
        const error = page.getByRole("alert");
        expect(await error.getByText("Could not create a setup code.").isVisible()).toBe(true);
        expect(await error.getByText("setup unavailable", { exact: false }).isVisible()).toBe(true);
        await captureUiProof(page, "09-desktop-error.png");

        await gateway.setMethodResponse(
          "device.pair.setupCode",
          setupResult("setup-recovered", "full"),
        );
        await page.getByRole("button", { name: "Reload" }).click();
        await qr.waitFor();

        await page.clock.install();
        await gateway.deferNext("device.pair.setupCode");
        await page.getByRole("button", { name: "New code" }).click();
        await page.clock.fastForward(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + 1);
        await page.clock.runFor(100);
        expect(
          await error
            .getByText("gateway request timed out after 30000ms: device.pair.setupCode")
            .isVisible(),
        ).toBe(true);
        await page.getByRole("button", { name: "Reload" }).click();
        await qr.waitFor();
        await page.locator(".device-pair-setup__close").click();
        await dialog.waitFor({ state: "hidden" });
        await gateway.setMethodResponse(
          "device.pair.setupCode",
          setupResult("setup-node", "node", Date.now() + 60_000, "Node_AbC123"),
        );
        await pairFromSettings.click();
        await dialog.waitFor();
        const nodeAccess = page.locator('input[name="device-pair-access"]').nth(2);
        await nodeAccess.check();
        await page.getByRole("button", { name: "Create setup code" }).click();
        expect((await gateway.getRequests("device.pair.setupCode")).at(-1)?.params).toEqual({
          bootstrapProfile: "node",
          includeQr: false,
        });
        await page
          .getByText('openclaw node run --pair "oc-pair://Node_AbC123"', { exact: true })
          .waitFor();
        expect(await qr.count()).toBe(0);
        await page.getByRole("button", { name: "Manage devices" }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/devices");
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
