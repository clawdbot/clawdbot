import path from "node:path";
import type { Page } from "playwright";
import { expect } from "vitest";
import { createDashboardTool } from "../../../src/agents/tools/dashboard-tool.js";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";

export async function assertDashboardToolPresentation(params: {
  page: Page;
  gateway: MockGatewayControls;
  sessionKey: string;
  proofDir?: string;
}) {
  const { page, gateway, sessionKey, proofDir } = params;
  let commandDelivery = Promise.resolve();
  const dashboardTool = createDashboardTool({
    agentSessionKey: sessionKey,
    emitCommand: (event) => {
      commandDelivery = gateway.emitGatewayEvent("board.command", event);
      return 1;
    },
  });
  if (proofDir) {
    await page.screenshot({ path: path.join(proofDir, "07-before-presentation-command.png") });
  }
  for (const presentation of ["expanded", "split"] as const) {
    const result = await dashboardTool.execute(`${presentation}-dashboard`, {
      action: "set_presentation",
      presentation,
    });
    expect(result.details).toEqual({ ok: true, delivered: 1 });
    await commandDelivery;
    await expect
      .poll(() => page.locator(".sidebar-region--expanded").count())
      .toBe(presentation === "expanded" ? 1 : 0);
    if (proofDir && presentation === "expanded") {
      await page.screenshot({ path: path.join(proofDir, "08-expanded-by-tool.png") });
    }
  }
  await expect.poll(() => page.locator(".sidebar-region--bottom").count()).toBe(1);
}
