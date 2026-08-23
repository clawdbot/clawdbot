// Control UI tests cover mobile pairing setup through the mocked Gateway.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import qrcode from "qrcode";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI mobile pairing mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/mobile-pairing");

suite.define(() => {
  it("defaults to full before issuance, supports limited fallback, and resets when reopened", async () => {
    const setupCode = Buffer.from(
      JSON.stringify({
        url: "wss://gateway.example.test",
        bootstrapToken: "e2e-bootstrap-token",
      }),
      "utf8",
    ).toString("base64url");
    const qrDataUrl = await qrcode.toDataURL(setupCode, { margin: 2, width: 360 });
    mkdirSync(artifactDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
          methodResponses: {
            "device.pair.list": {
              paired: [],
              pending: [{ deviceId: "mobile-1", requestId: "request-1" }],
            },
            "device.pair.setupCode": {
              auth: "token",
              gatewayUrl: "wss://gateway.example.test",
              qrDataUrl,
              setupCode,
              urlSource: "test",
            },
            "node.list": { nodes: [] },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}chat`);
        expect(response?.status()).toBe(200);

        // Pairing lives with the account-level controls in the footer identity menu.
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.getByRole("button", { name: /^Identity and app menu for / }).click();
        const sidebarPairingButton = sidebar
          .locator("wa-dropdown.sidebar-identity-menu")
          .locator(".sidebar-pair-mobile");
        await sidebarPairingButton.waitFor();
        await expect.poll(async () => sidebarPairingButton.isEnabled()).toBe(true);
        await gateway.deferNext("device.pair.list");
        await sidebarPairingButton.click();

        const dialog = page.getByRole("dialog", { name: "OpenClaw mobile" });
        const qr = page.getByAltText("OpenClaw mobile pairing QR code");
        await dialog.waitFor();
        expect(await dialog.isVisible()).toBe(true);
        expect(await qr.count()).toBe(0);
        expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
        expect(await page.getByRole("button", { name: "Create setup code" }).isVisible()).toBe(
          true,
        );
        await gateway.resolveDeferred("device.pair.list", {
          paired: [],
          pending: [{ deviceId: "mobile-1", requestId: "request-1" }],
        });

        // modal-dialog renders its content in light DOM outside the native dialog element.
        const accessRadios = page.locator('input[name="device-pair-access"]');
        await expect.poll(async () => accessRadios.count()).toBe(2);
        const fullAccess = accessRadios.nth(0);
        const limitedAccess = accessRadios.nth(1);
        expect(await fullAccess.isChecked()).toBe(true);
        await page.screenshot({ path: path.join(artifactDir, "01-full-access-default.png") });

        await limitedAccess.check();
        expect(await limitedAccess.isChecked()).toBe(true);
        await fullAccess.check();
        expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);

        await page.getByRole("button", { name: "Create setup code" }).click();
        const firstRequest = await gateway.waitForRequest("device.pair.setupCode");
        expect(firstRequest.params).toEqual({});
        await qr.waitFor();
        expect(await qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/u);
        expect(
          await page.getByText("wss://gateway.example.test", { exact: true }).isVisible(),
        ).toBe(true);
        expect(await page.getByText("Device requests waiting for review: 1").isVisible()).toBe(
          true,
        );
        expect(await fullAccess.isDisabled()).toBe(true);
        expect(await limitedAccess.isDisabled()).toBe(true);
        await page.screenshot({ path: path.join(artifactDir, "02-full-access-code.png") });

        const accessSequenceBeforeClose = (await gateway.getRequests("device.pair.setupCode")).map(
          (request) =>
            request.params &&
            typeof request.params === "object" &&
            "bootstrapProfile" in request.params &&
            request.params.bootstrapProfile === "limited"
              ? "limited"
              : "full",
        );
        expect(accessSequenceBeforeClose).toEqual(["full"]);
        await expect
          .poll(async () => (await gateway.getRequests("device.pair.list")).length)
          .toBe(1);

        await gateway.emitGatewayEvent("device.pair.requested", { requestId: "request-2" });
        await expect
          .poll(async () => (await gateway.getRequests("device.pair.list")).length)
          .toBe(2);

        await page.locator(".device-pair-setup__close").click();
        await dialog.waitFor({ state: "hidden" });

        const settingsResponse = await page.goto(`${suite.server.baseUrl}settings/security`);
        expect(settingsResponse?.status()).toBe(200);
        const quickSettingsPairingButton = page
          .locator(".security-page")
          .getByRole("button", { name: "Pair mobile device" });
        await quickSettingsPairingButton.waitFor();
        const setupRequestsBeforeQuickSettings = (
          await gateway.getRequests("device.pair.setupCode")
        ).length;
        await quickSettingsPairingButton.click();
        await dialog.waitFor();
        expect((await gateway.getRequests("device.pair.setupCode")).length).toBe(
          setupRequestsBeforeQuickSettings,
        );
        expect(await page.locator('input[name="device-pair-access"]').nth(0).isChecked()).toBe(
          true,
        );
        const reopenedLimitedAccess = page.locator('input[name="device-pair-access"]').nth(1);
        await reopenedLimitedAccess.check();
        await page.getByRole("button", { name: "Create setup code" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("device.pair.setupCode")).length)
          .toBe(setupRequestsBeforeQuickSettings + 1);
        await qr.waitFor();
        const reopenedAccessSequence = (await gateway.getRequests("device.pair.setupCode"))
          .slice(setupRequestsBeforeQuickSettings)
          .map((request) =>
            request.params &&
            typeof request.params === "object" &&
            "bootstrapProfile" in request.params &&
            request.params.bootstrapProfile === "limited"
              ? "limited"
              : "full",
          );
        expect(reopenedAccessSequence).toEqual(["limited"]);
        const accessSequence = [...accessSequenceBeforeClose, ...reopenedAccessSequence];
        expect(accessSequence).toEqual(["full", "limited"]);
        await page.screenshot({ path: path.join(artifactDir, "03-limited-access-code.png") });
        writeFileSync(
          path.join(artifactDir, "behavior-summary.json"),
          `${JSON.stringify(
            {
              accessSequence,
              reopenedDefault: "full",
              setupRequestsIssued: accessSequence.length,
            },
            null,
            2,
          )}\n`,
        );

        await page.getByRole("button", { name: "New code" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("device.pair.setupCode")).length)
          .toBe(setupRequestsBeforeQuickSettings + 2);
        expect((await gateway.getRequests("device.pair.setupCode")).at(-1)?.params).toEqual({
          bootstrapProfile: "limited",
        });

        await page.getByRole("button", { name: "Manage devices" }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/devices");
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
