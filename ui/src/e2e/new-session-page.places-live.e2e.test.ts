import { expect, it } from "vitest";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
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

  it("shows advertised cloud machines after selecting a profile", async () => {
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
              executionMode: "worker-turn",
              executionModes: ["worker-turn"],
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
      const where = page.locator("#new-session-where-trigger");
      await where.click();
      const picker = page.locator("wa-popover.new-session-page__where-popover");
      const profile = picker.locator('[data-value="cloud:aws"]');
      await profile.click();
      await profile.waitFor({ state: "hidden" });
      await where.click();
      await picker.locator('[data-value="machine:fast"]').waitFor();
    } finally {
      await context.close();
    }
  });

  it("keeps an explicitly selected cloud destination when its runtime becomes incompatible", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
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
            cloudPlacementExecutionMode: "worker-turn",
            source: "model",
          },
        },
        {
          available: true,
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
          profiles: [
            {
              id: "aws",
              providerId: "crabbox",
              executionMode: "worker-turn",
              executionModes: ["worker-turn"],
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
      await gateway.waitForRequest("models.list");
      const where = page.locator("#new-session-where-trigger");
      const model = page.locator('[data-chat-model-select="true"]');
      const start = page.getByRole("button", { name: "Start session" });
      await where.click();

      const profile = page.locator('[data-value="cloud:aws"]');
      await profile.click();
      await where.click();
      await page.locator('[data-value="machine:fast"]').click();
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").fill("keep this task on the cloud");
      await expect.poll(() => start.isEnabled()).toBe(true);

      await model.click();
      await page.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').click();
      await expect.poll(() => model.textContent()).toContain("GPT-5.6 Luna");
      await expect.poll(() => where.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => where.getAttribute("data-machine-class")).toBe("fast");
      await expect.poll(() => start.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);

      await where.click();

      await profile.waitFor();
      await expect.poll(() => profile.isDisabled()).toBe(true);
      await expect
        .poll(() => tooltipTitleText(profile))
        .toBe(
          "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.",
        );
      await page.keyboard.press("Escape");

      await model.click();
      await page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]').click();
      await expect.poll(() => where.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => where.getAttribute("data-machine-class")).toBe("fast");
      await expect.poll(() => start.isEnabled()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it.each([
    { name: "OpenClaw", runtime: "openclaw" },
    { name: "Codex", runtime: "codex" },
  ] as const)(
    "keeps the same multimode Crabbox profile selectable for $name",
    async ({ runtime }) => {
      const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.5",
        models: [
          {
            id: "gpt-5.5",
            name: "gpt-5.5",
            provider: "openai",
            agentRuntime: {
              id: runtime,
              cloudPlacementSupported: true,
              cloudPlacementExecutionMode: runtime === "codex" ? "remote-exec" : "worker-turn",
              source: "model",
            },
          },
        ],
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": {
            environments: [],
            profiles: [
              {
                id: "aws",
                providerId: "crabbox",
                executionMode: "worker-turn",
                executionModes: ["worker-turn", "remote-exec"],
              },
            ],
          },
          "worktrees.branches": { branches: [], repositoryStatus: "git" },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await gateway.waitForRequest("models.list");
        await page.locator("#new-session-where-trigger").click();

        const profile = page.locator('[data-value="cloud:aws"]');
        await profile.waitFor();
        await expect.poll(() => profile.isEnabled()).toBe(true);
        await profile.click();
        await expect
          .poll(() => page.locator("#new-session-where-trigger").textContent())
          .toContain("aws");
      } finally {
        await context.close();
      }
    },
  );

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
        .toEqual(["No worker slots are available. Wait for a slot or pick another device."]);
      // A disabled row keeps a muted meter with no utilization claim.
      await expect
        .poll(() => runner.locator(".capacity-meter-pips").getAttribute("aria-label"))
        .toBe("Slot utilization unavailable");
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
