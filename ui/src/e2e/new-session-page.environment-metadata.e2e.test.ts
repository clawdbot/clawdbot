import { expect, it } from "vitest";
import {
  WORKSPACE,
  captureDeviceRuntimeUiProof,
  captureEnvironmentMetadataUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const updateIssue = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
};

suite.define(() => {
  it("offers paired devices only to models that use the embedded runtime", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "anthropic/claude-sonnet-4-6",
      models: [
        {
          available: true,
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          provider: "anthropic",
          agentRuntime: {
            id: "openclaw",
            cloudPlacementSupported: true,
            devicePlacementSupported: true,
            source: "model",
          },
        },
        {
          available: true,
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          agentRuntime: {
            id: "codex",
            cloudPlacementSupported: true,
            devicePlacementSupported: false,
            source: "model",
          },
        },
      ],
      methodResponses: {
        "environments.list": {
          environments: [
            {
              id: "node:build-mac",
              type: "node",
              label: "Build Mac",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 2 },
            },
          ],
          profiles: [],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("chat.metadata");
      await gateway.waitForRequest("environments.list");
      const whereTrigger = page.locator("#new-session-where-trigger");
      const where = page.locator("wa-popover.new-session-page__where-popover");
      const device = where.locator('[data-value="device:build-mac"]');

      await whereTrigger.click();
      await device.waitFor();
      expect(await device.isEnabled()).toBe(true);
      expect(await device.textContent()).not.toContain("Needs the embedded runtime");
      await captureDeviceRuntimeUiProof(page, "01-embedded-device-enabled.png");
      await page.keyboard.press("Escape");

      await page.locator('[data-chat-model-select="true"]').click();
      await page.locator('[data-chat-model-option="openai/gpt-5.6-sol"]').click();
      await whereTrigger.click();
      await expect.poll(() => device.isDisabled()).toBe(true);
      await expect
        .poll(() => device.locator(".new-session-page__menu-fact").allTextContents())
        .toEqual(["Needs the embedded runtime"]);
      expect(await device.getAttribute("title")).toBe("Needs the embedded runtime");
      await captureDeviceRuntimeUiProof(page, "02-codex-device-disabled.png");
      await page.keyboard.press("Escape");

      await page.locator('[data-chat-model-select="true"]').click();
      await page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]').click();
      await whereTrigger.click();
      await expect.poll(() => device.isEnabled()).toBe(true);
      expect(await device.textContent()).not.toContain("Needs the embedded runtime");
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("renders authoritative device eligibility and exact live capacity", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": {
          environments: [
            { id: "gateway", type: "local", status: "available", sessionHost: true },
            {
              id: "node:alpha-device",
              type: "node",
              label: "Build runner",
              status: "available",
              platform: "darwin",
              sessionHost: true,
              workerSlots: { total: 4, available: 2 },
              capabilities: ["camera.snap", "screen.record"],
            },
            {
              id: "node:beta-device",
              type: "node",
              label: "Build runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 1 },
            },
            {
              id: "node:saturated",
              type: "node",
              label: "Busy runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 0 },
            },
            {
              id: "node:missing-capacity",
              type: "node",
              label: "Capacity unknown",
              status: "available",
              sessionHost: true,
            },
            {
              id: "node:offline",
              type: "node",
              label: "Offline runner",
              status: "unavailable",
              sessionHost: true,
              lastConnectedAtMs: 1_000,
              lastDisconnectedAtMs: 4_000,
            },
            {
              id: "node:disabled",
              type: "node",
              label: "Hosting disabled",
              status: "available",
              sessionHost: false,
            },
            {
              id: "node:outdated",
              type: "node",
              label: "Outdated runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
              issues: [updateIssue],
            },
          ],
          profiles: [{ id: "ephemeral", providerId: "crabbox", trust: "disposable" }],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      const place = page.locator("wa-popover.new-session-page__where-popover");
      const row = (id: string) => place.locator(`[data-value="device:${id}"]`);
      await row("alpha-device").waitFor();
      await captureEnvironmentMetadataUiProof(page);

      expect(await row("alpha-device").isEnabled()).toBe(true);
      await expect
        .poll(() => row("alpha-device").locator(".new-session-page__menu-fact").allTextContents())
        .toEqual(["Worker slots 2/4", "macOS", "Camera", "Screen capture"]);
      expect(await row("alpha-device").locator(".session-menu__sub").textContent()).toBe(
        "alpha-de",
      );
      expect(await row("beta-device").locator(".session-menu__sub").textContent()).toBe("beta-dev");
      expect(await row("saturated").locator(".session-menu__sub").count()).toBe(0);
      expect(await row("saturated").isDisabled()).toBe(true);
      await expect
        .poll(() => row("saturated").locator(".new-session-page__menu-fact").allTextContents())
        .toEqual([
          "Worker slots 0/2",
          "No worker slots are available. Wait for a slot or pick another device.",
        ]);
      expect(await row("missing-capacity").isDisabled()).toBe(true);
      expect(await row("offline").isDisabled()).toBe(true);
      expect(await row("disabled").isDisabled()).toBe(true);
      expect(await row("outdated").isDisabled()).toBe(true);
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
