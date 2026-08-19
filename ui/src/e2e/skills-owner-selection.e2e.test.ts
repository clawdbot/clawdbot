import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Skills owner selection",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("scopes every initial Skills status request to the displayed default agent", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["skills.status"],
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", identity: { name: "Main" }, name: "Main" },
              { id: "research", identity: { name: "Research" }, name: "Research" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: [],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}skills`);
      await gateway.waitForRequest("skills.status");
      await gateway.resolveDeferred("skills.status", {
        workspaceDir: "/tmp/openclaw-e2e/workspace",
        managedSkillsDir: "/tmp/openclaw-e2e/skills",
        skills: [],
      });
      await page.getByText("No skills found.").waitFor();
      const requests = await gateway.getRequests("skills.status");
      expect(requests).not.toHaveLength(0);
      for (const request of requests) {
        expect(request).toEqual(expect.objectContaining({ params: { agentId: "main" } }));
      }
      expect(requests).toHaveLength(1);
    });
  });
});
