import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

async function captureProof(page: import("playwright").Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(path.join(suite.artifactDir, "connect-machine"), { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(path.join(suite.artifactDir, "connect-machine"), fileName),
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
              dir: path.join(suite.artifactDir, "connect-machine"),
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

  it("shows a retryable error when connection-link creation never responds", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const joinUrl = "https://gateway.example.com/j/retried-code";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.setupCode": {
          setupCode: "RETRIED",
          joinUrl,
          gatewayUrl: "wss://gateway.example.com",
          auth: "token",
          urlSource: "test",
          access: "node",
          expiresAtMs: Date.now() + 10 * 60_000,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.clock.install();
      await gateway.deferNext("device.pair.setupCode");
      await page.locator("#new-session-where-trigger").click();
      await page.getByRole("button", { name: "Connect a machine…" }).click();
      await gateway.waitForRequest("device.pair.setupCode");
      const dialog = page.locator('openclaw-modal-dialog[label="Connect a machine"]');
      await dialog.getByText("Creating a secure connection link…", { exact: true }).waitFor();
      await captureProof(page, "03-connect-loading.png");

      await page.clock.fastForward(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + 1);
      await page.clock.runFor(100);

      await dialog
        .getByRole("alert")
        .filter({ hasText: "gateway request timed out after 30000ms: device.pair.setupCode" })
        .waitFor();
      expect(
        await dialog.getByText("Creating a secure connection link…", { exact: true }).count(),
      ).toBe(0);
      await captureProof(page, "04-connect-timeout.png");
      const retry = dialog.getByRole("button", { name: "Mint fresh code" });
      await retry.click();
      await dialog.getByText(`npx openclaw connect ${joinUrl}`, { exact: true }).waitFor();
      expect(await gateway.getRequests("device.pair.setupCode")).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("redacts sensitive connection-link failures before rendering them", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["device.pair.setupCode"],
    });
    const secret = "e2e-pairing-bearer-secret";

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator("#new-session-where-trigger").click();
      await page.getByRole("button", { name: "Connect a machine…" }).click();
      await gateway.waitForRequest("device.pair.setupCode");
      await gateway.rejectDeferred("device.pair.setupCode", {
        message: `pairing failed: Authorization: Bearer ${secret}`,
      });

      const alert = page
        .locator('openclaw-modal-dialog[label="Connect a machine"]')
        .getByRole("alert");
      await alert.waitFor();
      expect(await alert.textContent()).toContain("Authorization: [redacted]");
      expect(await alert.textContent()).not.toContain(secret);
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
