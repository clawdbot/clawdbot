import { expect, it } from "vitest";
import {
  WORKSPACE,
  captureEnvironmentMetadataUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
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
