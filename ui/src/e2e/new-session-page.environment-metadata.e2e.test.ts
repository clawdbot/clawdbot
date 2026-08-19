import { expect, it } from "vitest";
import {
  WORKSPACE,
  captureDeviceRuntimeUiProof,
  captureEnvironmentMetadataUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

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
        "node.list": {
          nodes: [
            {
              nodeId: "build-mac",
              displayName: "Build Mac",
              connected: true,
              commands: ["system.run"],
            },
          ],
        },
        "environments.list": {
          environments: [
            {
              id: "node:build-mac",
              type: "node",
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
      const device = where.locator('[data-value="node:build-mac"]');

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
    } finally {
      await context.close();
    }
  });

  it("renders authoritative environment metadata without changing live destination filtering", async () => {
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
        "node.list": {
          nodes: [
            {
              nodeId: "capable-mac",
              displayName: "Build Mac",
              connected: true,
              commands: ["system.run"],
            },
            {
              nodeId: "outdated-mac",
              displayName: "Outdated build Mac",
              connected: true,
              commands: ["system.run"],
              issues: [
                {
                  code: "update-required",
                  action: "update-and-reconnect",
                  updateCommand: "openclaw update",
                  headlessReconnectCommand: "openclaw node restart",
                },
              ],
            },
            {
              nodeId: "offline-rich",
              displayName: "Offline rich device",
              connected: false,
              commands: ["system.run"],
            },
            {
              nodeId: "non-exec-rich",
              displayName: "Non-exec rich device",
              connected: true,
              commands: ["camera.snap"],
            },
          ],
        },
        "environments.list": {
          environments: [
            {
              id: "gateway",
              type: "local",
              status: "available",
              platform: "darwin",
              sessionHost: true,
              trust: "persistent",
              capabilities: ["agent.run", "sessions", "tools", "workspace"],
            },
            {
              id: "node:capable-mac",
              type: "node",
              status: "unavailable",
              platform: "darwin",
              sessionHost: false,
              trust: "persistent",
              capabilities: [
                "camera.snap",
                "screen.record",
                "voice",
                "microphone.capture",
                "system.run",
                "fs.listDir",
                "sessions",
                "tools",
                "workspace",
                "custom.unknown",
              ],
            },
            {
              id: "node:outdated-mac",
              type: "node",
              status: "available",
              platform: "darwin",
              sessionHost: false,
              trust: "persistent",
              capabilities: ["system.run"],
              issues: [
                {
                  code: "update-required",
                  action: "update-and-reconnect",
                  updateCommand: "openclaw update",
                  headlessReconnectCommand: "openclaw node restart",
                },
              ],
            },
            {
              id: "node:offline-rich",
              type: "node",
              status: "unavailable",
              sessionHost: false,
              lastConnectedAtMs: 1_000,
              lastDisconnectedAtMs: 4_000,
              capabilities: ["camera", "screen"],
            },
            {
              id: "node:non-exec-rich",
              type: "node",
              status: "available",
              sessionHost: true,
              capabilities: ["camera", "screen"],
            },
          ],
          profiles: [
            { id: "ephemeral", providerId: "crabbox", trust: "disposable" },
            { id: "shared", providerId: "static-ssh", trust: "persistent" },
            { id: "plain", providerId: "opaque-provider" },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      await gateway.waitForRequest("environments.list");
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await page.locator("#new-session-where-trigger").click();
      const device = place.locator('[data-value="node:capable-mac"]');
      await device.waitFor();
      await captureEnvironmentMetadataUiProof(page);

      await expect
        .poll(() => device.locator(".new-session-page__menu-fact").allTextContents())
        .toEqual(["macOS", "Camera", "Screen capture", "Voice"]);
      const outdated = place.locator('[data-value="node:outdated-mac"]');
      expect(await outdated.count()).toBe(1);
      expect(await outdated.isDisabled()).toBe(true);
      await expect
        .poll(() => outdated.locator(".new-session-page__menu-fact").allTextContents())
        .toEqual([
          "Update required: run openclaw update, then reconnect. For a headless node, run openclaw node restart.",
        ]);
      expect(await outdated.getAttribute("title")).toContain("openclaw update");
      await expect
        .poll(() =>
          place
            .locator('[data-value="cloud:ephemeral"] .new-session-page__menu-fact')
            .allTextContents(),
        )
        .toEqual(["Disposable"]);
      await expect
        .poll(() =>
          place
            .locator('[data-value="cloud:shared"] .new-session-page__menu-fact')
            .allTextContents(),
        )
        .toEqual(["Persistent"]);
      expect(
        await place.locator('[data-value="cloud:plain"] .new-session-page__menu-fact').count(),
      ).toBe(0);
      expect(
        await place.locator('[data-value="gateway"] .new-session-page__menu-fact').count(),
      ).toBe(0);
      const offline = place.locator('[data-value="node:offline-rich"]');
      expect(await offline.count()).toBe(1);
      expect(await offline.isDisabled()).toBe(true);
      expect(
        (await offline.locator(".new-session-page__menu-fact").first().textContent()) ?? "",
      ).toMatch(/^Offline for /);
      expect(await place.locator('[data-value="node:non-exec-rich"]').count()).toBe(0);

      const visibleCopy = ((await place.textContent()) ?? "").toLowerCase();
      for (const clutter of [
        "available",
        "online",
        "session host",
        "crabbox",
        "static-ssh",
        "opaque-provider",
        "system.run",
        "fs.listdir",
        "sessions",
        "tools",
        "workspace",
        "custom.unknown",
      ]) {
        expect(visibleCopy).not.toContain(clutter);
      }
    } finally {
      await context.close();
    }
  });
});
