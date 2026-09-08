// Control UI E2E: renaming a paired device alias from the Devices page row
// menu through the shared input dialog, against a mocked Gateway.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI device alias rename mocked Gateway E2E",
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
    uiProofArtifactDir = createControlUiE2eArtifactDir("device-alias-rename");
  }
});

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({ animations: "disabled", path: path.join(uiProofArtifactDir, fileName) });
}

const DEVICE_ID = "synthetic-office-workstation";

function pairedDevice(operatorLabel?: string) {
  return {
    deviceId: DEVICE_ID,
    displayName: "office-workstation.example.test",
    ...(operatorLabel ? { operatorLabel } : {}),
    platform: "linux",
    roles: ["node", "operator"],
    scopes: ["operator.read"],
    approvedVia: "owner",
    createdAtMs: Date.now() - 86_400_000,
    lastSeenAtMs: Date.now(),
  };
}

suite.define(() => {
  it("retries a rejected alias rename and dismisses unsaved edits on reconnect", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "device.pair.list": { pending: [], paired: [pairedDevice()] },
          "device.pair.rename": { deviceId: DEVICE_ID, label: "Office node" },
          "environments.list": { environments: [] },
          "exec.approvals.get": {
            exists: false,
            file: { agents: {}, defaults: {}, version: 1 },
            hash: "e2e",
            path: "/tmp/exec-approvals.json",
          },
          "node.list": { nodes: [] },
          "system-presence": [],
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/devices`);
      await waitForControlUiRoute(page, { pathname: "/settings/devices", routeId: "devices" });

      const row = page.locator(".device-entry", { hasText: "office-workstation.example.test" });
      await row.waitFor();
      await captureUiProof(page, "01-devices-inventory.png");

      await row.locator(".device-entry__menu-trigger").click();
      await page.locator('wa-dropdown-item[value="editAlias"]').click();
      const dialog = page.locator("openclaw-modal-dialog").last();
      await dialog.locator('input[name="value"]').waitFor();
      await captureUiProof(page, "02-alias-dialog-open.png");

      await dialog.locator('input[name="value"]').fill("Office node");
      await captureUiProof(page, "03-alias-dialog-filled.png");

      // Reject the first request at the transport boundary; the same dialog
      // must preserve the value and remain usable for a second attempt.
      await gateway.deferNext("device.pair.rename");
      const renamesBefore = (await gateway.getRequests("device.pair.rename")).length;
      await dialog.getByRole("button", { name: "Save" }).click();

      const renameRequest = await gateway.waitForRequest("device.pair.rename", {
        after: renamesBefore,
      });
      expect(renameRequest.params).toEqual({ deviceId: DEVICE_ID, label: "Office node" });

      await gateway.rejectDeferred("device.pair.rename", { message: "Alias change rejected" });
      const failure = dialog.getByRole("alert");
      await failure.waitFor();
      expect(await failure.textContent()).toContain("Alias change rejected");
      expect(await dialog.locator('input[name="value"]').inputValue()).toBe("Office node");
      expect(await dialog.getByRole("button", { name: "Save" }).isEnabled()).toBe(true);
      await captureUiProof(page, "03b-alias-rejected-retryable.png");

      const retryAfter = (await gateway.getRequests("device.pair.rename")).length;
      await gateway.deferNext("device.pair.rename");
      await dialog.getByRole("button", { name: "Save" }).click();
      const retryRequest = await gateway.waitForRequest("device.pair.rename", {
        after: retryAfter,
      });
      expect(retryRequest.params).toEqual({ deviceId: DEVICE_ID, label: "Office node" });

      // Publish the new list before releasing success so the refresh has no race.
      await gateway.setMethodResponse("device.pair.list", {
        pending: [],
        paired: [pairedDevice("Office node")],
      });
      await gateway.resolveDeferred("device.pair.rename", {
        deviceId: DEVICE_ID,
        label: "Office node",
      });

      await page
        .locator(".device-entry .settings-row__title", { hasText: "Office node" })
        .waitFor();
      await captureUiProof(page, "04-alias-applied.png");

      await dialog.waitFor({ state: "hidden" });
      const renamedRow = page.locator(".device-entry", { hasText: "Office node" });
      await renamedRow.locator(".device-entry__menu-trigger").click();
      await page.locator('wa-dropdown-item[value="editAlias"]').click();
      await dialog.locator('input[name="value"]').fill("Unsaved alias");
      const socketsBefore = await gateway.getSocketCount();
      await gateway.closeLatest();
      await dialog.waitFor({ state: "hidden" });
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketsBefore);
      await renamedRow.waitFor();
      expect(await gateway.getRequests("device.pair.rename")).toHaveLength(renamesBefore + 2);
      await captureUiProof(page, "05-alias-after-reconnect.png");
    });
  });
});
