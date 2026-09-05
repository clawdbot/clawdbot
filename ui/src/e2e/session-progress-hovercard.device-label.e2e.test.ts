import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

function pageOptions() {
  return {
    hasTouch: false,
    locale: "en-US",
    serviceWorkers: "block" as const,
    viewport: { height: 900, width: 1280 },
  };
}

function activeDevicePlacement(deviceId?: string) {
  const opaqueId = deviceId ?? "unavailable-device-id";
  return {
    state: "active" as const,
    environmentId: `device-environment-${opaqueId}`,
    generation: 1,
    activeOwnerEpoch: 1,
    workspaceBaseManifestRef: "manifest-device",
    remoteWorkspaceDir: "/workspace/device",
    workerBundleHash: "a".repeat(64),
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    providerId: "device",
    profileId: `device:${opaqueId}`,
    runner: {
      kind: "device" as const,
      status: "available" as const,
      ...(deviceId ? { deviceId } : {}),
    },
  };
}

function selectedSession(key: string, updatedAt = 2) {
  return {
    key,
    kind: "direct" as const,
    label: "Selected session",
    updatedAt,
  };
}

function deviceSession(key: string, deviceId?: string, updatedAt = 1) {
  return {
    key,
    kind: "direct" as const,
    label: "Device worker session",
    updatedAt,
    placement: activeDevicePlacement(deviceId),
  };
}

function nodeEnvironment(deviceId: string, label: string, type = "node") {
  return {
    id: `node:${deviceId}`,
    type,
    label,
    status: "available" as const,
  };
}

async function focusSession(page: Page, sessionKey: string): Promise<void> {
  await page
    .locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`)
    .locator(".sidebar-recent-session__link")
    .focus();
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("resolves and caches a device placement's human-readable label", async () => {
    const selectedSessionKey = "agent:main:selected-device";
    const sessionKey = "agent:main:device-worker";

    await suite.withPage(pageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["environments.list", "progressCard.get"],
        methodResponses: {
          "environments.list": {
            environments: [nodeEnvironment("opaque-device-id", "Hetzner node-01 (ash)")],
          },
          "progressCard.get": { card: null },
          "sessions.list": chatSessionListResponse([
            selectedSession(selectedSessionKey),
            deviceSession(sessionKey, "opaque-device-id"),
          ]),
        },
        sessionKey: selectedSessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
      await focusSession(page, sessionKey);

      const card = page.locator(".session-progress-hovercard");
      await expect.poll(() => card.textContent()).toContain("Hetzner node-01 (ash)");
      await gateway.waitForRequest("environments.list");
      expect(await gateway.getRequests("environments.list")).toHaveLength(1);
      expect(await card.textContent()).not.toContain("device:opaque-device-id");

      await focusSession(page, selectedSessionKey);
      await focusSession(page, sessionKey);
      await expect.poll(() => card.textContent()).toContain("Hetzner node-01 (ash)");
      expect(await gateway.getRequests("environments.list")).toHaveLength(1);
    });
  });

  it.each([
    {
      name: "the runner id is missing",
      deviceId: undefined,
      catalogCapability: false,
      environments: [],
      requestCount: 0,
    },
    {
      name: "the catalog capability is unavailable",
      deviceId: "opaque-device-id",
      catalogCapability: false,
      environments: [],
      requestCount: 0,
    },
    {
      name: "a non-node environment has a node-shaped id",
      deviceId: "opaque-device-id",
      catalogCapability: true,
      environments: [nodeEnvironment("opaque-device-id", "Wrong environment label", "worker")],
      requestCount: 1,
    },
  ])("uses the generic device label when $name", async (scenario) => {
    const selectedSessionKey = "agent:main:selected-device-fallback";
    const sessionKey = "agent:main:device-fallback";

    await suite.withPage(pageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          ...(scenario.catalogCapability ? ["environments.list"] : []),
          "progressCard.get",
        ],
        methodResponses: {
          "environments.list": { environments: scenario.environments },
          "progressCard.get": { card: null },
          "sessions.list": chatSessionListResponse([
            selectedSession(selectedSessionKey),
            deviceSession(sessionKey, scenario.deviceId),
          ]),
        },
        sessionKey: selectedSessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
      await focusSession(page, sessionKey);

      const context = page.locator(".session-progress-hovercard .session-hovercard__context-text");
      await expect.poll(() => context.textContent()).toBe("Device");
      if (scenario.requestCount > 0) {
        await gateway.waitForRequest("environments.list");
      }
      expect(await gateway.getRequests("environments.list")).toHaveLength(scenario.requestCount);
      const text = await context.textContent();
      expect(text).not.toContain("unavailable-device-id");
      expect(text).not.toContain("opaque-device-id");
      expect(text).not.toContain("Wrong environment label");
    });
  });

  it("refreshes once when the hover target changes during a catalog request", async () => {
    const selectedSessionKey = "agent:main:selected-catalog-race";
    const firstSessionKey = "agent:main:first-device";
    const secondSessionKey = "agent:main:second-device";

    await suite.withPage(pageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["environments.list", "progressCard.get"],
        methodResponses: {
          "environments.list": { environments: [] },
          "progressCard.get": { card: null },
          "sessions.list": chatSessionListResponse([
            selectedSession(selectedSessionKey, 3),
            deviceSession(firstSessionKey, "first-device", 2),
            deviceSession(secondSessionKey, "second-device"),
          ]),
        },
        sessionKey: selectedSessionKey,
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
      await gateway.deferNext("environments.list");

      await focusSession(page, firstSessionKey);
      await gateway.waitForRequest("environments.list");
      await focusSession(page, secondSessionKey);
      await gateway.setMethodResponse("environments.list", {
        environments: [nodeEnvironment("second-device", "Second human-readable device")],
      });
      await gateway.resolveDeferred("environments.list", {
        environments: [nodeEnvironment("first-device", "First human-readable device")],
      });

      const card = page.locator(".session-progress-hovercard");
      await expect.poll(() => card.textContent()).toContain("Second human-readable device");
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBe(2);
      expect(await card.textContent()).not.toContain("device:second-device");
    });
  });

  it("backs off after a catalog failure", async () => {
    const selectedSessionKey = "agent:main:selected-catalog-failure";
    const sessionKey = "agent:main:failed-catalog-device";

    await suite.withPage(pageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["environments.list", "progressCard.get"],
        methodResponses: {
          "environments.list": { environments: [] },
          "progressCard.get": { card: null },
          "sessions.list": chatSessionListResponse([
            selectedSession(selectedSessionKey),
            deviceSession(sessionKey, "opaque-device-id"),
          ]),
        },
        sessionKey: selectedSessionKey,
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
      await gateway.deferNext("environments.list");

      await focusSession(page, sessionKey);
      await gateway.waitForRequest("environments.list");
      await gateway.rejectDeferred("environments.list", { message: "catalog unavailable" });
      await focusSession(page, selectedSessionKey);
      await focusSession(page, sessionKey);

      await expect
        .poll(() => page.locator(".session-progress-hovercard").textContent())
        .toContain("Device");
      await page.waitForTimeout(50);
      expect(await gateway.getRequests("environments.list")).toHaveLength(1);
    });
  });
});
