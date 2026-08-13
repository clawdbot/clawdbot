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

  it("refreshes destinations from gateway events while the picker stays open", async () => {
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
      await place.getByRole("button", { name: "New Mac" }).waitFor();
      await place.getByRole("button", { name: "Local" }).waitFor();
      await place.getByText("Your devices", { exact: true }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();

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
    } finally {
      await context.close();
    }
  });
});
