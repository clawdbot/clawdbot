import { expect, it } from "vitest";
import {
  WORKSPACE,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps a definitive cloud startup failure visible in the created session", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const sessionKey = "agent:cloud:failed-startup-e2e";
    const gateway = await installMockGateway(page, {
      defaultAgentId: "cloud",
      deferredMethods: ["sessions.dispatch"],
      featureMethods: ["sessions.create", "sessions.dispatch"],
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: sessionKey },
        "sessions.list": createdSessionListResult(sessionKey),
        "sessions.describe": { session: {} },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page
        .locator("wa-popover.new-session-page__where-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.locator(".new-session-page__message").fill("surface the failed startup");
      await page.getByRole("button", { name: "Start session" }).click();
      await gateway.waitForRequest("sessions.dispatch");
      await waitForCommittedChatRoute(page);
      await gateway.rejectDeferred("sessions.dispatch", {
        code: "INVALID_REQUEST",
        message: "cloud profile was removed",
      });

      const alert = page.locator('.chat-cloud-startup-error[role="alert"]');
      await pollLocatorText(alert).toContain("cloud profile was removed");
      expect(page.url()).toContain(controlUiSessionPath(sessionKey));
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
