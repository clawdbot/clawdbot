import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import type { SessionPlacementPendingRecovery } from "../lib/sessions/session-placement-recovery.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { holdModuleResponse } from "./control-ui-e2e-suite.test-support.ts";
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

function holdRecoveryDigest() {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.assign(window, { releaseRecoveryDigest: release });
  crypto.subtle.digest = async (algorithm, data) => {
    const result = await digest(algorithm, data);
    if (new TextDecoder().decode(data) === "e2e-device-token") {
      await ready;
    }
    return result;
  };
}

suite.define(() => {
  it.each([
    { historyFails: false, disconnect: false, replaceClient: false, coldScope: false },
    { historyFails: true, disconnect: false, replaceClient: false, coldScope: false },
    { historyFails: false, disconnect: true, replaceClient: false, coldScope: false },
    { historyFails: false, disconnect: true, replaceClient: true, coldScope: false },
    { historyFails: false, disconnect: false, replaceClient: false, coldScope: true },
  ])(
    "keeps cloud startup visible through failure ($historyFails, disconnect: $disconnect, replacement: $replaceClient, cold scope: $coldScope)",
    async ({ historyFails, disconnect, replaceClient, coldScope }) => {
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
          if (coldScope) {
            // Delay the real post-hello digest; do not override the client's readiness getter.
            await page.addInitScript(holdRecoveryDigest);
          }
          await page.reload();
          if (coldScope) {
            const pane = page.locator(".chat-pane-cache__pane--active");
            await expect
              .poll(() =>
                pane.evaluate((element) => {
                  const { state } = element as HTMLElement & { state: ChatPageHost };
                  return state.connected && !state.client?.recoveryScopeReady && !state.chatLoading;
                }),
              )
              .toBe(true);
            expect(await failedGroup.count()).toBe(0);
            const blocked = await pane.evaluate(async (element) => {
              const { state } = element as HTMLElement & { state: ChatPageHost };
              state.handleChatDraftChange("later ordinary turn");
              await state.handleSendChat();
              return { draft: state.chatMessage, queued: state.chatQueue.map((item) => item.text) };
            });
            const composerDisabled = await page
              .locator(".agent-chat__composer-combobox textarea")
              .isDisabled();
            await pollLocatorText(pane.locator(".agent-chat__composer-status-band")).toContain(
              "Finishing connection recovery.",
            );
            await page.evaluate(() =>
              (window as unknown as { releaseRecoveryDigest: () => void }).releaseRecoveryDigest(),
            );
            await failedGroup.waitFor({ state: "visible" });
            expect({ blocked, sends: await gateway.getRequests("chat.send") }).toEqual({
              blocked: { draft: "later ordinary turn", queued: [] },
              sends: [],
            });
            expect(composerDisabled).toBe(true);
          }
        }
        await failedGroup.waitFor({ state: "visible" });
        expect(await failedGroup.locator(".chat-send-status").textContent()).toContain("Not sent");
        await failedGroup
          .locator(`img[src="data:image/png;base64,${ONE_PIXEL_PNG_B64}"]`)
          .waitFor({ state: "visible" });
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
        if (disconnect || coldScope) {
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
  it.each(["none", "accepted", "invalid"] as const)(
    "resumes an unrelated offline queue after recovery releases it (%s)",
    async (recoveryKind) => {
      const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const sessionKey = "agent:main:release-recovery";
      const message = "original accepted turn";
      const messageId = "initial-release-attempt";
      const history = {
        messages:
          recoveryKind === "accepted"
            ? [
                {
                  role: "user",
                  content: [{ type: "text", text: message }],
                  __openclaw: { idempotencyKey: `${messageId}:user` },
                },
              ]
            : [],
        sessionInfo: { hasActiveRun: false, status: "done" },
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": createdSessionListResult(sessionKey),
          "chat.history": history,
        },
      });
      let runtime: Awaited<ReturnType<typeof holdModuleResponse>> | undefined;
      try {
        await page.goto(`${suite.server.baseUrl}${controlUiSessionPath(sessionKey).slice(1)}`);
        const pane = page.locator(".chat-pane-cache__pane--active");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await expect.poll(() => composer.isDisabled()).toBe(false);
        const owner = await page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: { context: ApplicationContext };
          };
          const { gateway: appGateway } = app.runtime.context;
          return {
            gatewayUrl: appGateway.connection.gatewayUrl,
            recoveryScope: appGateway.snapshot.client!.recoveryScope,
          };
        });
        const recovery: SessionPlacementPendingRecovery = {
          ...owner,
          sessionKey,
          messageId,
          message,
          agentId: "main",
          target: { kind: "profile", profileId: "aws" },
          phase: "sending",
        };
        const storageKey = sessionPlacementRecoveryExactStorageKey(
          owner.gatewayUrl,
          owner.recoveryScope,
          sessionKey,
        );
        await gateway.setOnline(false);
        await expect
          .poll(() =>
            pane.evaluate(
              (element) => (element as HTMLElement & { state: ChatPageHost }).state.connected,
            ),
          )
          .toBe(false);
        await composer.fill("queued while offline");
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: "queued while offline" }).waitFor();
        expect(await composer.inputValue()).toBe("");
        if (recoveryKind !== "none") {
          // Accepted retirement can fail to remove its sending row after the map owner
          // retires. A malformed target represents the reader's existing corruption boundary.
          await page.evaluate(
            ({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)),
            {
              key: storageKey,
              record:
                recoveryKind === "invalid"
                  ? { ...recovery, target: { kind: "profile" } }
                  : recovery,
            },
          );
        }
        await page.addInitScript(holdRecoveryDigest);
        await page.reload();
        runtime = await holdModuleResponse(
          page,
          /\/assets\/session-placement-startup\.runtime-[^/?]+\.js(?:\?.*)?$/,
        );
        await gateway.setOnline(true);
        await expect
          .poll(() =>
            pane.evaluate((element) => {
              const { state } = element as HTMLElement & { state: ChatPageHost };
              return state.connected && !state.client?.recoveryScopeReady && !state.chatLoading;
            }),
          )
          .toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await page.evaluate(() =>
          (window as unknown as { releaseRecoveryDigest: () => void }).releaseRecoveryDigest(),
        );
        await runtime.request;
        if (recoveryKind !== "none") {
          expect(
            await pane.evaluate((element) => {
              const { state } = element as HTMLElement & { state: ChatPageHost };
              return (
                state.client?.recoveryScopeReady && state.hasPendingInitialTurn?.(state.sessionKey)
              );
            }),
          ).toBe(true);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        }
        const historyCount = (await gateway.getRequests("chat.history")).length;
        if (recoveryKind === "accepted") {
          await gateway.deferNext("chat.history");
        }
        runtime.release();
        if (recoveryKind === "accepted") {
          expect(
            await gateway.waitForRequest("chat.history", { after: historyCount }),
          ).toMatchObject({
            params: { sessionKey, limit: 1000 },
          });
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await gateway.resolveDeferred("chat.history", history);
        }
        await expect
          .poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey))
          .toBeNull();
        await gateway.waitForRequest("chat.send");
        expect(await gateway.getRequests("chat.send")).toMatchObject([
          { params: { sessionKey, message: "queued while offline" } },
        ]);
        expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        if (recoveryKind === "accepted") {
          expect(await page.locator(".chat-group.user", { hasText: message }).count()).toBe(1);
        }
      } finally {
        runtime?.release();
        await context.close();
      }
    },
  );
});
