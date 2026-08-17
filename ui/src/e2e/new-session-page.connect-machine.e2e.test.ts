import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const proofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "connect-machine",
);

async function captureProof(page: import("playwright").Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(proofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofArtifactDir, fileName),
  });
}

suite.define(() => {
  it("lets admins mint and refresh a one-paste machine connection", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: proofArtifactDir,
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const firstJoinUrl = "https://gateway.example.com/j/first-code?label=alpha&next=$(whoami)";
    const secondJoinUrl = "https://gateway.example.com/j/second-code";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.setupCode": {
          sequence: [
            {
              setupCode: "FIRST",
              joinUrl: firstJoinUrl,
              gatewayUrl: "wss://gateway.example.com",
              auth: "token",
              urlSource: "test",
              access: "node",
              expiresAtMs: Date.now() + 10 * 60_000,
            },
            {
              setupCode: "SECOND",
              joinUrl: secondJoinUrl,
              gatewayUrl: "wss://gateway.example.com",
              auth: "token",
              urlSource: "test",
              access: "node",
              expiresAtMs: Date.now() + 10 * 60_000,
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await page.locator("#new-session-where-trigger").click();
      const connect = place.getByRole("button", { name: "Connect a machine…" });
      await connect.waitFor();
      await captureProof(page, "01-picker-foot.png");
      await connect.click();

      const firstRequest = await gateway.waitForRequest("device.pair.setupCode");
      expect(firstRequest.params).toEqual({ includeQr: false, joinUrl: true });
      const dialog = page.locator('openclaw-modal-dialog[label="Connect a machine"]');
      await dialog.getByText(`npx openclaw connect '${firstJoinUrl}'`, { exact: true }).waitFor();
      const copy = dialog.locator("button.chat-copy-btn");
      expect(await copy.count()).toBe(1);
      expect(await copy.getAttribute("aria-label")).toBe("Copy command");
      await dialog
        .getByText("Running it pairs that machine as a device for your team.", { exact: true })
        .waitFor();
      await dialog.getByText(/This link is single-use and expires at/u).waitFor();
      expect(await dialog.getByRole("button", { name: "Manage devices" }).count()).toBe(1);

      await dialog.getByRole("button", { name: "Mint fresh code" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("device.pair.setupCode")).length)
        .toBe(2);
      expect((await gateway.getRequests("device.pair.setupCode"))[1]?.params).toEqual({
        includeQr: false,
        joinUrl: true,
      });
      await dialog.getByText(`npx openclaw connect ${secondJoinUrl}`, { exact: true }).waitFor();
      await captureProof(page, "02-connect-dialog.png");
    } finally {
      await context.close();
    }
  });

  it("hides machine connection from non-admin operators", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await page.locator("#new-session-where-trigger").click();
      await place.getByRole("button", { name: "Local" }).waitFor();
      expect(await place.getByRole("button", { name: "Connect a machine…" }).count()).toBe(0);
      expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("closes an in-flight connection dialog when the Gateway reconnects", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["device.pair.setupCode"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator("#new-session-where-trigger").click();
      await page.getByRole("button", { name: "Connect a machine…" }).click();
      await gateway.waitForRequest("device.pair.setupCode");
      const dialog = page.locator('openclaw-modal-dialog[label="Connect a machine"]');
      await dialog.getByText("Creating a secure connection link…", { exact: true }).waitFor();

      await gateway.closeLatest(1012, "test reconnect");

      await expect.poll(() => dialog.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
