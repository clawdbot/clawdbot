// Control UI tests cover mobile pairing setup through the mocked Gateway.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import qrcode from "qrcode";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI mobile pairing mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/mobile-pairing");

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

        const dialog = page.getByRole("dialog", { name: "Pair a device" });
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
        await expect.poll(async () => accessRadios.count()).toBe(3);
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
          .getByRole("button", { name: "Pair device" });
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

        await page.locator(".device-pair-setup__close").click();
        await dialog.waitFor({ state: "hidden" });
        await gateway.setMethodResponse("device.pair.setupCode", {
          access: "node",
          auth: "token",
          expiresAtMs: Date.now() + 60_000,
          gatewayUrl: "wss://gateway.example.test",
          setupCode: "Node_AbC123",
          urlSource: "test",
        });
        await quickSettingsPairingButton.click();
        await dialog.waitFor();
        const nodeAccess = page.locator('input[name="device-pair-access"]').nth(2);
        await nodeAccess.check();
        await page.getByRole("button", { name: "Create setup code" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("device.pair.setupCode")).length)
          .toBe(setupRequestsBeforeQuickSettings + 3);
        expect((await gateway.getRequests("device.pair.setupCode")).at(-1)?.params).toEqual({
          bootstrapProfile: "node",
          includeQr: false,
        });
        const nodeCommand = page.getByText('openclaw node run --pair "oc-pair://Node_AbC123"', {
          exact: true,
        });
        await nodeCommand.waitFor();
        expect(await nodeCommand.isVisible()).toBe(true);

        await page.getByRole("button", { name: "Manage devices" }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/devices");
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
