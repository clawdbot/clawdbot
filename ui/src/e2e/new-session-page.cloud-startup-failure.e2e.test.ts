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
  it.each([false, true])(
    "keeps cloud startup visible through failure (history fails: %s)",
    async (historyFails) => {
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      const sessionKey = "agent:cloud:failed-startup-e2e";
      const diagnostic = `cloud profile was removed\n${"Enrollment detail. ".repeat(80)}\nFinal startup diagnostic.`;
      const gateway = await installMockGateway(page, {
        defaultAgentId: "cloud",
        deferredMethods: ["sessions.dispatch", ...(historyFails ? ["chat.startup"] : [])],
        featureMethods: ["sessions.create", "sessions.dispatch", "chat.startup"],
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
        if (historyFails) {
          await gateway.waitForRequest("chat.startup");
          await gateway.rejectDeferred("chat.startup", {
            code: "UNAVAILABLE",
            message: "History is temporarily unavailable",
          });
          await pollLocatorText(page.locator(".chat-history-error--inline")).toContain(
            "History is temporarily unavailable",
          );
        }
        const working = page.locator('.chat-thread .chat-working-indicator[role="status"]');
        await pollLocatorText(working).toContain("Provisioning environment…");
        expect(await working.locator(".chat-reading-indicator").count()).toBe(1);
        expect(
          await page
            .locator('.chat-cloud-startup, .agent-chat__composer-status-band[role="alert"]')
            .count(),
        ).toBe(0);
        expect(await page.locator(".chat-send-btn--stop").count()).toBe(0);
        await gateway.rejectDeferred("sessions.dispatch", {
          code: "INVALID_REQUEST",
          message: diagnostic,
        });

        const alert = page.getByRole("alert").filter({ hasText: "cloud profile was removed" });
        await pollLocatorText(alert).toContain("cloud profile was removed");
        await expect.poll(() => working.count()).toBe(0);
        expect(await alert.locator("summary").count()).toBe(1);
        await alert.locator("summary").click();
        const text = alert.locator("pre");
        await text.waitFor({ state: "visible" });
        expect(await text.textContent()).toContain(diagnostic);
        await alert.getByRole("button", { name: "Copy error", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(await text.textContent());
        expect(page.url()).toContain(controlUiSessionPath(sessionKey));
        expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
      } finally {
        await context.close();
      }
    },
  );
});
