// Control UI browser proof covers explicit agent ownership for automatic model reads.
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI model agent scoping",
});

suite.define(() => {
  it("scopes every automatic model request in a cold explicit fleet", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        defaultAgentId: "writer",
        deferredMethods: ["connect"],
        models: [{ id: "writer-model", name: "Writer Model", provider: "openai" }],
        methodResponses: {
          connect: {
            auth: {
              deviceToken: "e2e-device-token",
              role: "operator",
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
            features: { events: [], methods: [] },
            protocol: 4,
            server: { connId: "model-agent-scoping", version: "e2e" },
            snapshot: {
              sessionDefaults: {
                defaultAgentId: "writer",
                ownership: "explicit",
                selectionRequired: true,
                mainKey: "main",
                mainSessionKey: "agent:writer:main",
                scope: "agent",
              },
            },
            type: "hello-ok",
          },
          "agents.list": {
            agents: [
              { id: "writer", name: "Writer" },
              { id: "reviewer", name: "Reviewer" },
            ],
            defaultId: "writer",
            ownership: "explicit",
            selectionRequired: true,
            mainKey: "main",
            scope: "agent",
          },
          "models.authStatus": { ts: Date.now(), providers: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}debug`);
      await gateway.waitForRequest("connect");
      // Commit the settings takeover before hello so this proof cannot inherit
      // a transient app sidebar and its unrelated auth-status request.
      await waitForControlUiRoute(page, { pathname: "/debug", routeId: "debug" });
      await gateway.resolveDeferred("connect");
      await gateway.waitForRequest("models.list");
      const modelsListCount = (await gateway.getRequests("models.list")).length;
      const authStatusCount = (await gateway.getRequests("models.authStatus")).length;
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              navigate: (routeId: string, options: { pathname: string }) => void;
            };
          };
        };
        app.runtime?.context.navigate("model-providers", {
          pathname: "/settings/model-providers",
        });
      });
      await waitForControlUiRoute(page, {
        pathname: "/settings/model-providers",
        routeId: "model-providers",
      });
      await expect
        .poll(async () => (await gateway.getRequests("models.authStatus")).length)
        .toBeGreaterThan(authStatusCount);
      await expect
        .poll(async () => (await gateway.getRequests("models.list")).length)
        .toBeGreaterThan(modelsListCount);

      const modelRequests = [
        ...(await gateway.getRequests("models.list")),
        ...(await gateway.getRequests("models.authStatus")),
      ];
      expect(modelRequests.length).toBeGreaterThan(0);
      for (const request of modelRequests) {
        expect(request.params).toEqual(expect.objectContaining({ agentId: "writer" }));
      }
    });
  });
});
