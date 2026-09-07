import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  TERMINAL_START_FEATURE_METHODS,
  cliAgentCatalog,
} from "./new-session-page.native-terminal.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    { id: "codex", label: "Codex" },
    { id: "claude", label: "Claude Code" },
  ])(
    "updates $label native destinations automatically without losing the selected machine",
    async ({ id, label }) => {
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const local = {
        hostId: "gateway:local",
        label: `Local ${label}`,
        kind: "gateway",
        connected: true,
        canStartTerminal: true,
        sessions: [],
      };
      const node = { ...local, hostId: "node:builder", label: "Build machine", kind: "node" };
      const result = (hosts: (typeof local)[]) => ({
        catalogs: [{ ...cliAgentCatalog(true), id, label, hosts }],
      });
      const gateway = await installMockGateway(page, {
        cliAgentsEnabled: true,
        featureMethods: [...TERMINAL_START_FEATURE_METHODS],
        methodResponses: { "sessions.catalog.list": result([local]) },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new?agent=main&catalog=${id}`);
        await pollLocatorText(page.locator(".new-session-page__runtime")).toContain(label);
        const destination = page.getByRole("combobox", { name: "Where", exact: true });
        expect(await destination.count()).toBe(0);
        expect(await page.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(0);
        const message = page.locator(".new-session-page__message");
        await message.fill("Keep this draft on the selected machine");

        await gateway.setMethodResponse("sessions.catalog.list", result([local, node]));
        await gateway.emitGatewayEvent("node.runnerInventory.changed", { nodeId: "builder" });
        await destination.waitFor();
        await destination.selectOption(node.hostId);
        const folder = page.getByRole("textbox", { name: "Existing absolute folder on this node" });
        await folder.fill("/workspace/native-project");
        expect(await page.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(0);

        await gateway.setMethodResponse("sessions.catalog.list", result([local]));
        await gateway.emitGatewayEvent("presence", {
          presence: [{ deviceId: "builder", reason: "disconnect" }],
        });
        await expect.poll(() => destination.locator("option").count()).toBe(2);
        await expect.poll(() => destination.inputValue()).toBe(node.hostId);
        await expect.poll(() => folder.inputValue()).toBe("/workspace/native-project");
        await expect
          .poll(() =>
            page.getByRole("button", { name: "Start in terminal" }).getAttribute("aria-disabled"),
          )
          .toBe("true");

        await gateway.setOnline(false);
        await waitForControlUiGatewayReconnecting(page);
        await gateway.setMethodResponse("sessions.catalog.list", result([local, node]));
        await gateway.setOnline(true);
        await waitForControlUiGatewayReady(page);
        await expect
          .poll(() => destination.locator(`option[value="${node.hostId}"]`).isDisabled())
          .toBe(false);
        await expect.poll(() => destination.inputValue()).toBe(node.hostId);
        expect(await message.inputValue()).toBe("Keep this draft on the selected machine");
        expect(await folder.inputValue()).toBe("/workspace/native-project");
        expect(await gateway.getRequests("sessions.catalog.startTerminal")).toHaveLength(0);

        await gateway.setMethodResponse("sessions.catalog.list", result([]));
        await gateway.emitGatewayEvent("config.changed", {});
        await page.getByRole("status").filter({ hasText: "No native CLI is available" }).waitFor();
        expect(await destination.count()).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  it("selects the only native node without borrowing the Gateway workspace", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const catalog = cliAgentCatalog(true);
    catalog.hosts = [
      {
        ...catalog.hosts[0]!,
        hostId: "node:builder",
        label: "Build machine",
        kind: "node",
      },
    ];
    await installMockGateway(page, {
      cliAgentsEnabled: true,
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: { "sessions.catalog.list": { catalogs: [catalog] } },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main&catalog=claude`);
      const folder = page.getByRole("textbox", { name: "Existing absolute folder on this node" });
      await folder.waitFor();
      expect(await folder.inputValue()).toBe("");
      expect(await page.getByRole("combobox", { name: "Where", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
