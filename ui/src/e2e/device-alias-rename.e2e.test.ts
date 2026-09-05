// Control UI E2E: renaming a paired device alias from the Devices page row
// menu through the shared input dialog, against a mocked Gateway.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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

const DEVICE_ID = "device-lin-workstation";

function pairedDevice(operatorLabel?: string) {
  return {
    deviceId: DEVICE_ID,
    displayName: "LIN-5F196050F5D.zte.intra",
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
  it("renames a paired device alias through the row menu", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
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

        const row = page.locator(".device-entry", { hasText: "LIN-5F196050F5D" });
        await row.waitFor();
        await captureUiProof(page, "01-devices-inventory.png");

        await row.locator(".device-entry__menu-trigger").click();
        await page.locator('wa-dropdown-item[value="editAlias"]').click();
        const dialog = page.locator("openclaw-modal-dialog").last();
        await dialog.locator('input[name="value"]').waitFor();
        await captureUiProof(page, "02-alias-dialog-open.png");

        await dialog.locator('input[name="value"]').fill("Office node");
        await captureUiProof(page, "03-alias-dialog-filled.png");

        // Hold the rename response so the refreshed device list deterministically
        // reads the post-rename alias rather than racing the reload.
        await gateway.deferNext("device.pair.rename");
        const renamesBefore = (await gateway.getRequests("device.pair.rename")).length;
        await dialog.getByRole("button", { name: "Save" }).click();

        const renameRequest = await gateway.waitForRequest("device.pair.rename", {
          after: renamesBefore,
        });
        expect(renameRequest.params).toEqual({ deviceId: DEVICE_ID, label: "Office node" });

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
      },
    );
  });
});
