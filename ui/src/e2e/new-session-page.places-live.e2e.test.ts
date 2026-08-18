import { expect, it } from "vitest";
import {
  WORKSPACE,
  captureUiProof,
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps Local visible when the Gateway is the only place", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "node.list": { nodes: [] },
        "environments.list": { environments: [], profiles: [] },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      const trigger = page.locator("#new-session-where-trigger");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("Local");
      await trigger.click();
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await place.getByRole("button", { name: "Local" }).waitFor();
      expect(await place.getByText("Your devices", { exact: true }).count()).toBe(0);
      expect(await place.getByText("Cloud", { exact: true }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("shows advertised machines and treats the catalog default as no override", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "node.list": { nodes: [] },
        "environments.list": {
          environments: [],
          profiles: [
            {
              id: "aws",
              providerId: "crabbox",
              machines: [
                {
                  id: "standard",
                  label: "Standard",
                  cpu: 32,
                  memoryGb: 64,
                  default: true,
                },
                { id: "fast", label: "Fast", cpu: 64, memoryGb: 128 },
              ],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-where-trigger");
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Cloud · aws" }).click();

      await trigger.click();
      await place.getByText("Machine", { exact: true }).waitFor();
      const standard = place.locator('[data-value="machine:standard"]');
      const fast = place.locator('[data-value="machine:fast"]');
      await expect.poll(() => standard.getAttribute("aria-pressed")).toBe("true");
      await expect.poll(() => standard.textContent()).toContain("32 vCPU · 64 GB");
      await expect.poll(() => standard.textContent()).toContain("Default");
      await expect.poll(() => fast.textContent()).toContain("64 vCPU · 128 GB");

      await fast.click();
      await expect.poll(() => trigger.getAttribute("data-machine-class")).toBe("fast");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("aws · Fast");
      await captureUiProof(page, "picker-cloud-machine-fast.png");

      await standard.click();
      await expect.poll(() => trigger.getAttribute("data-machine-class")).toBeNull();
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("aws");
    } finally {
      await context.close();
    }
  });

  it("refreshes destinations from gateway events while the picker stays open", async () => {
    const updateIssue = {
      code: "update-required",
      action: "update-and-reconnect",
      updateCommand: "openclaw update",
      headlessReconnectCommand: "openclaw node restart",
    };
    const lifecycleNowMs = Date.now();
    const disconnectedAtMs = lifecycleNowMs - 2 * 60_000;
    const connectedAtMs = disconnectedAtMs - 3 * 60_000;
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: ".artifacts/control-ui-e2e/picker-liveness",
              size: { height: 900, width: 1280 },
            },
            viewport: { height: 900, width: 1280 },
          }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "node.list": {
          nodes: [
            {
              nodeId: "existing-mac",
              displayName: "Existing Mac",
              connected: true,
              commands: ["system.run"],
            },
          ],
        },
        "sessions.create": { key: "agent:main:picker-refresh" },
        "environments.list": {
          environments: [
            { id: "gateway", type: "local", status: "available" },
            { id: "node:existing-mac", type: "node", status: "available" },
          ],
          profiles: [],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-where-trigger");
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Existing Mac" }).waitFor();
      const nodeRequests = (await gateway.getRequests("node.list")).length;
      const environmentRequests = (await gateway.getRequests("environments.list")).length;
      await gateway.setMethodResponse("node.list", {
        nodes: [
          {
            nodeId: "existing-mac",
            displayName: "Existing Mac",
            connected: true,
            commands: ["system.run"],
          },
          {
            nodeId: "new-mac",
            displayName: "New Mac",
            connected: true,
            commands: ["system.run"],
          },
        ],
      });
      await gateway.setMethodResponse("environments.list", {
        environments: [
          { id: "gateway", type: "local", status: "available" },
          { id: "node:existing-mac", type: "node", status: "available" },
          { id: "node:new-mac", type: "node", status: "available" },
        ],
        profiles: [],
      });
      await gateway.emitGatewayEvent("presence", {
        presence: [
          { deviceId: "existing-mac", mode: "node", reason: "connect", ts: 1 },
          { deviceId: "new-mac", mode: "node", reason: "connect", ts: 2 },
        ],
      });

      await expect
        .poll(async () => (await gateway.getRequests("node.list")).length)
        .toBeGreaterThan(nodeRequests);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(environmentRequests);
      const newMac = place.locator('[data-value="node:new-mac"]');
      await newMac.waitFor();
      await place.getByRole("button", { name: "Local" }).waitFor();
      await place.getByText("Your devices", { exact: true }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();

      const disconnectNodeRequests = (await gateway.getRequests("node.list")).length;
      await gateway.setMethodResponse("node.list", {
        nodes: [
          {
            nodeId: "existing-mac",
            displayName: "Existing Mac",
            connected: true,
            commands: ["system.run"],
          },
          {
            nodeId: "new-mac",
            displayName: "New Mac",
            connected: false,
            commands: ["system.run"],
            lastConnectedAtMs: connectedAtMs,
            lastDisconnectedAtMs: disconnectedAtMs,
          },
        ],
      });
      await gateway.setMethodResponse("environments.list", {
        environments: [
          { id: "gateway", type: "local", status: "available" },
          { id: "node:existing-mac", type: "node", status: "available" },
          {
            id: "node:new-mac",
            type: "node",
            status: "unavailable",
            lastConnectedAtMs: connectedAtMs,
            lastDisconnectedAtMs: disconnectedAtMs,
          },
        ],
        profiles: [],
      });
      await gateway.emitGatewayEvent("presence", {
        presence: [
          { deviceId: "existing-mac", mode: "node", reason: "connect", ts: 3 },
          { deviceId: "new-mac", mode: "node", reason: "disconnect", ts: 4 },
        ],
      });
      await expect
        .poll(async () => (await gateway.getRequests("node.list")).length)
        .toBeGreaterThan(disconnectNodeRequests);
      await expect.poll(() => newMac.isDisabled()).toBe(true);
      await expect
        .poll(() => newMac.locator(".new-session-page__menu-fact").first().textContent())
        .toMatch(/^Offline for /);
      await captureUiProof(page, "picker-device-offline.png");

      const reconnectNodeRequests = (await gateway.getRequests("node.list")).length;
      await gateway.setMethodResponse("node.list", {
        nodes: [
          {
            nodeId: "existing-mac",
            displayName: "Existing Mac",
            connected: true,
            commands: ["system.run"],
          },
          {
            nodeId: "new-mac",
            displayName: "New Mac",
            connected: true,
            commands: ["system.run"],
            lastConnectedAtMs: lifecycleNowMs,
          },
        ],
      });
      await gateway.setMethodResponse("environments.list", {
        environments: [
          { id: "gateway", type: "local", status: "available" },
          { id: "node:existing-mac", type: "node", status: "available" },
          {
            id: "node:new-mac",
            type: "node",
            status: "available",
            lastConnectedAtMs: lifecycleNowMs,
          },
        ],
        profiles: [],
      });
      await gateway.emitGatewayEvent("presence", {
        presence: [
          { deviceId: "existing-mac", mode: "node", reason: "connect", ts: 5 },
          { deviceId: "new-mac", mode: "node", reason: "connect", ts: 6 },
        ],
      });
      await expect
        .poll(async () => (await gateway.getRequests("node.list")).length)
        .toBeGreaterThan(reconnectNodeRequests);
      await expect.poll(() => newMac.isDisabled()).toBe(false);
      await captureUiProof(page, "picker-device-reconnected.png");

      const refreshedEnvironmentRequests = (await gateway.getRequests("environments.list")).length;
      await gateway.setMethodResponse("environments.list", {
        environments: [],
        profiles: [{ id: "aws", providerId: "crabbox", trust: "disposable" }],
      });
      await gateway.emitGatewayEvent("config.changed", {
        path: "/tmp/openclaw.json",
        hash: "picker-cloud-refresh",
        ts: 3,
      });
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(refreshedEnvironmentRequests);
      await place.getByText("Cloud", { exact: true }).waitFor();
      await place.getByRole("button", { name: "Cloud · aws" }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();
      await captureUiProof(page, "picker-after-live-regroup.png");

      await newMac.click();
      await expect.poll(() => trigger.getAttribute("data-exec-node")).toBe("new-mac");
      const outdatedNodeRequests = (await gateway.getRequests("node.list")).length;
      await gateway.setMethodResponse("node.list", {
        nodes: [
          {
            nodeId: "existing-mac",
            displayName: "Existing Mac",
            connected: true,
            commands: ["system.run"],
          },
          {
            nodeId: "new-mac",
            displayName: "New Mac",
            connected: true,
            commands: ["system.run"],
            issues: [updateIssue],
          },
        ],
      });
      await gateway.setMethodResponse("environments.list", {
        environments: [
          { id: "gateway", type: "local", status: "available" },
          { id: "node:existing-mac", type: "node", status: "available" },
          {
            id: "node:new-mac",
            type: "node",
            status: "available",
            issues: [updateIssue],
          },
        ],
        profiles: [{ id: "aws", providerId: "crabbox", trust: "disposable" }],
      });
      await gateway.emitGatewayEvent("node.runnerInventory.changed", { nodeId: "new-mac" });
      await expect
        .poll(async () => (await gateway.getRequests("node.list")).length)
        .toBeGreaterThan(outdatedNodeRequests);
      await expect.poll(() => trigger.getAttribute("data-exec-node")).toBeNull();
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("Local");

      await page.locator(".new-session-page__message").fill("use an eligible place");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).not.toHaveProperty("execNode");
    } finally {
      await context.close();
    }
  });
});
