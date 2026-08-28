import { expect, it } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import {
  WORKSPACE,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pastePng,
  ONE_PIXEL_PNG_B64,
  pollLocatorText,
  replaceGatewayClient,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    { historyFails: false, disconnect: false, replaceClient: false },
    { historyFails: true, disconnect: false, replaceClient: false },
    { historyFails: false, disconnect: true, replaceClient: false },
    { historyFails: false, disconnect: true, replaceClient: true },
  ])(
    "keeps cloud startup visible through failure ($historyFails, disconnect: $disconnect, replacement: $replaceClient)",
    async ({ historyFails, disconnect, replaceClient }) => {
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      const sessionKey = "agent:cloud:failed-startup-e2e";
      const message = "surface the failed startup";
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
          "chat.history": {
            messages: [],
            sessionInfo: { hasActiveRun: false, status: "done" },
          },
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
        const composer = page.locator(".new-session-page__message");
        await composer.fill(message);
        await pastePng(composer);
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
        const failedGroup = page.locator(".chat-group.user", { hasText: message });
        await failedGroup.waitFor({ state: "visible" });
        expect(await failedGroup.locator(".chat-send-status").textContent()).toContain("Not sent");
        await failedGroup
          .locator(`img[src="data:image/png;base64,${ONE_PIXEL_PNG_B64}"]`)
          .waitFor({ state: "visible" });
        if (disconnect) {
          await gateway.setOnline(false);
          if (replaceClient) {
            await replaceGatewayClient(page);
          }
          const pane = page.locator(".chat-pane-cache__pane--active");
          await expect
            .poll(() =>
              pane.evaluate(
                (element) => (element as HTMLElement & { state: ChatPageHost }).state.connected,
              ),
            )
            .toBe(false);
          // Use the public page action: non-composer callers must share admission.
          const offline = await pane.evaluate(async (element) => {
            const { state } = element as HTMLElement & { state: ChatPageHost };
            state.handleChatDraftChange("later ordinary turn");
            await state.handleSendChat();
            return { draft: state.chatMessage, queued: state.chatQueue.map((item) => item.text) };
          });
          const composerDisabled = await page
            .locator(".agent-chat__composer-combobox textarea")
            .isDisabled();
          await gateway.setOnline(true);
          await failedGroup.waitFor({ state: "visible" });
          // Observe the buggy delivery as well as admission before checking the invariant.
          if (offline.queued.includes("later ordinary turn")) {
            await gateway.waitForRequest("chat.send");
          }
          expect(composerDisabled).toBe(true);
          expect({ offline, sends: await gateway.getRequests("chat.send") }).toMatchObject({
            offline: { draft: "later ordinary turn", queued: [] },
            sends: [],
          });
          expect(await page.locator(".agent-chat__composer-combobox textarea").inputValue()).toBe(
            "later ordinary turn",
          );
          expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(1);
        } else {
          await page.reload();
        }
        await failedGroup.waitFor({ state: "visible" });
        expect(await failedGroup.locator(".chat-send-status").textContent()).toContain("Not sent");
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(disconnect ? 1 : 0);
        expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
        if (disconnect) {
          await gateway.deferNext("sessions.dispatch");
        }
        await failedGroup.getByRole("button", { name: "Retry queued message" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("sessions.dispatch")).length)
          .toBe(disconnect ? 2 : 1);
        const retry = (await gateway.getRequests("sessions.dispatch")).at(-1)!;
        expect(retry.params).toMatchObject({ key: sessionKey, profileId: "aws" });
        expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
        await gateway.resolveDeferred("sessions.dispatch", {
          placement: { state: "active", environmentId: "worker-retry" },
        });
        expect(await gateway.waitForRequest("sessions.send")).toMatchObject({
          params: {
            key: sessionKey,
            message,
            attachments: [{ content: ONE_PIXEL_PNG_B64, fileName: "pixel.png" }],
          },
        });
        expect(await gateway.getRequests("sessions.create")).toHaveLength(disconnect ? 1 : 0);
        if (disconnect) {
          expect(await page.locator(".agent-chat__composer-combobox textarea").inputValue()).toBe(
            "later ordinary turn",
          );
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        }
      } finally {
        await context.close();
      }
    },
  );
});
