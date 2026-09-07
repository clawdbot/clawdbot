import { expect, it } from "vitest";
import type { AgentsListResult, SessionsListResult } from "../api/types.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI sidebar agent roster" });

suite.define(() => {
  it("enables the roster from the switcher, opens all agents, and keeps the mode after reload", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        const agentsList: AgentsListResult = {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
            { id: "forge", name: "Forge", identity: { emoji: "🔧" } },
            { id: "scout", name: "Scout", identity: { emoji: "🔭" } },
            { id: "bloom", name: "Bloom", identity: { emoji: "🌱" } },
          ],
        };
        const now = Date.now();
        const sessions: SessionsListResult = {
          ts: now,
          path: "",
          count: agentsList.agents.length,
          defaults: { model: null, modelProvider: null, contextTokens: null },
          sessions: agentsList.agents.map((agent, index) => ({
            agentId: agent.id,
            key: `agent:${agent.id}:main`,
            kind: "direct",
            isMain: true,
            updatedAt: now - (index + 1) * 60_000,
            hasActiveRun: agent.id === "forge",
            lastMessagePreview:
              agent.id === "forge" ? "Preparing the sample dashboard." : "Ready for the next task.",
          })),
        };
        await installMockGateway(page, {
          methodResponses: {
            "agents.list": agentsList,
            "agent.identity.get": {
              cases: agentsList.agents.map((agent) => ({
                match: { agentId: agent.id },
                response: {
                  agentId: agent.id,
                  name: agent.name,
                  emoji: agent.identity?.emoji,
                  avatar: "",
                },
              })),
            },
            "chat.startup": {
              agentsList,
              messages: [],
              metadata: { models: [] },
              sessionId: "session:agent:main:main",
              thinkingLevel: null,
            },
            "sessions.list": sessions,
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        const sidebar = page.locator("openclaw-app-sidebar");
        const chip = sidebar.locator(".sidebar-agent-card__main");
        await expect.poll(() => chip.isVisible()).toBe(true);
        await captureSidebarUiProof(suite, page, "sidebar-roster-before.png");
        await chip.click();
        await sidebar.locator('wa-dropdown-item[value="command:sidebar-agents"]').click();

        const rows = sidebar.locator(".sidebar-agent-roster__row");
        await expect.poll(() => rows.count()).toBe(4);
        await expect.poll(() => rows.first().getAttribute("data-agent-id")).toBe("forge");
        await expect
          .poll(() => sidebar.locator('.sidebar-agent-roster__status[data-working="true"]').count())
          .toBe(1);
        await expect
          .poll(() => rows.first().textContent())
          .toContain("Working: Preparing the sample dashboard.");
        await captureSidebarUiProof(suite, page, "sidebar-roster-after.png");

        await sidebar.getByRole("link", { name: "See all", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "agents-home", pathname: "/agents" });
        await expect.poll(() => page.locator(".agents-home__card").count()).toBe(4);
        await page.reload();
        await expect.poll(() => rows.count()).toBe(4);
        await expect.poll(() => chip.count()).toBe(0);
        await sidebar.getByRole("button", { name: "Switch agent", exact: true }).click();
        await expect
          .poll(() =>
            sidebar
              .locator('wa-dropdown-item[value="command:sidebar-agents"]')
              .evaluate((element) => (element as HTMLElement & { checked: boolean }).checked),
          )
          .toBe(true);
      },
    );
  });
});
