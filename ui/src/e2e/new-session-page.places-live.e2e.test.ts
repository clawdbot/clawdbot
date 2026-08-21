import { expect, it } from "vitest";
import {
  WORKSPACE,
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
        "environments.list": {
          environments: [{ id: "gateway", type: "local", status: "available" }],
          profiles: [],
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-where-trigger");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("Local");
      await trigger.click();
      await page.locator('[data-value="gateway"]').waitFor();
    } finally {
      await context.close();
    }
  });

  it("shows advertised cloud machines only to admins", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": {
          environments: [],
          profiles: [
            {
              id: "aws",
              providerId: "crabbox",
              machines: [
                { id: "standard", label: "Standard", default: true },
                { id: "fast", label: "Fast" },
              ],
            },
          ],
        },
        "worktrees.branches": { branches: [], repositoryStatus: "git" },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      const picker = page.locator("wa-popover.new-session-page__where-popover");
      await picker.locator('[data-value="cloud:aws"]').click();
      await picker.locator('[data-value="machine:fast"]').waitFor();
    } finally {
      await context.close();
    }
  });

  it("disables cloud profiles whose execution mode does not match the selected runtime", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "openai/gpt-5.6-luna",
      models: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          agentRuntime: {
            id: "codex",
            cloudPlacementSupported: true,
            cloudPlacementExecutionMode: "remote-exec",
            source: "model",
          },
        },
      ],
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox", executionMode: "worker-turn" }],
        },
        "worktrees.branches": { branches: [], repositoryStatus: "git" },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await gateway.waitForRequest("chat.metadata");
      await page.locator("#new-session-where-trigger").click();

      const profile = page.locator('[data-value="cloud:aws"]');
      await profile.waitFor();
      await expect.poll(() => profile.isDisabled()).toBe(true);
      expect(await profile.getAttribute("title")).toBe(
        "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.",
      );
    } finally {
      await context.close();
    }
  });

  it("refreshes authoritative device capacity from Gateway topology events", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": {
          environments: [
            {
              id: "node:runner",
              type: "node",
              label: "Build runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 1 },
            },
          ],
          profiles: [],
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      const runner = page.locator('[data-value="device:runner"]');
      await runner.waitFor();
      expect(await runner.isEnabled()).toBe(true);

      const requests = (await gateway.getRequests("environments.list")).length;
      await gateway.setMethodResponse("environments.list", {
        environments: [
          {
            id: "node:runner",
            type: "node",
            label: "Build runner",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 0 },
          },
        ],
        profiles: [],
      });
      await gateway.emitGatewayEvent("node.runnerInventory.changed", { nodeId: "runner" });
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(requests);
      await expect.poll(() => runner.isDisabled()).toBe(true);
      await expect
        .poll(() => runner.locator(".new-session-page__menu-fact").allTextContents())
        .toEqual([
          "Worker slots 0/2",
          "No worker slots are available. Wait for a slot or pick another device.",
        ]);
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
