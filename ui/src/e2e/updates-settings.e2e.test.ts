// Control UI tests cover the routed Updates settings page through a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Updates settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "updates-settings");

suite.define(() => {
  it("renders live campaign status without requesting config.schema", async () => {
    if (captureProof) {
      await mkdir(proofDir, { recursive: true });
    }
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureProof
          ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1280 } } }
          : {}),
      },
      async ({ page }) => {
        const config = { update: { auto: { enabled: true }, channel: "stable" } };
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.get", "config.set", "config.apply", "update.run"],
          methodResponses: {
            "config.get": {
              config,
              hash: "updates-config-1",
              issues: [],
              raw: JSON.stringify(config),
              runtimeConfig: config,
              valid: true,
            },
            "update.run": {
              ok: false,
              result: { reason: "restart-disabled", status: "skipped" },
            },
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/updates`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("config.get");
        expect(await gateway.getRequests("config.schema")).toHaveLength(0);

        await gateway.emitGatewayEvent("update.available", {
          updateAvailable: {
            currentVersion: "2026.8.1",
            latestVersion: "2026.8.2",
            channel: "stable",
          },
          schedule: {
            channel: "stable",
            autoEnabled: true,
            install: { kind: "package" },
            target: { kind: "package", version: "2026.8.2" },
            campaign: {
              id: "campaign-e2e",
              state: "countdown",
              announcedAtMs: Date.now(),
              applyAtMs: Date.now() + 55_000,
              forceAtMs: Date.now() + 15 * 60_000,
              updatedAtMs: Date.now(),
            },
          },
        });

        const content = page.locator("#control-ui-main");
        await content.getByText("Updates", { exact: true }).waitFor();
        const timer = content.locator("[role='timer']");
        await expect.poll(() => timer.textContent()).toContain("Updating in 0:");
        const firstCountdown = await timer.textContent();
        await expect.poll(() => timer.textContent()).not.toBe(firstCountdown);
        await content.getByText("Gateway version", { exact: true }).waitFor();
        await content.getByText("Control UI commit", { exact: true }).waitFor();

        if (captureProof) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, "01-updates-countdown.png"),
          });
        }

        await content.getByRole("radio", { name: "Beta", exact: true }).click();
        const configSet = await gateway.waitForRequest("config.set");
        const raw = (configSet.params as { raw?: unknown }).raw;
        expect(typeof raw).toBe("string");
        expect(JSON.parse(String(raw))).toMatchObject({ update: { channel: "beta" } });

        await content.getByRole("button", { name: "Update now", exact: true }).click();
        await gateway.waitForRequest("update.run");
      },
    );
  });

  it("keeps the page readable and controls locked for non-admins", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const config = { update: { auto: { enabled: true }, channel: "beta" } };
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.get", "update.run"],
          methodResponses: {
            "config.get": {
              config,
              hash: "updates-read-only-1",
              issues: [],
              raw: JSON.stringify(config),
              runtimeConfig: config,
              valid: true,
            },
          },
          operatorScopes: ["operator.read"],
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/updates`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("config.get");
        await page.getByRole("note").waitFor();
        expect(await page.getByRole("note").textContent()).toContain(
          "Administrator access is required",
        );
        expect(await page.locator("wa-radio-group").getAttribute("disabled")).not.toBeNull();
        expect(await page.getByRole("switch", { name: "Automatic updates" }).isDisabled()).toBe(
          true,
        );
        expect(await page.getByRole("button", { name: "Update now" }).isDisabled()).toBe(true);
        expect(await gateway.getRequests("config.schema")).toHaveLength(0);

        if (captureProof) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, "02-updates-read-only.png"),
          });
        }
      },
    );
  });
});
