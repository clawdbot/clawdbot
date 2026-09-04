import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import type { SessionPlacementPendingRecovery } from "../lib/sessions/session-placement-recovery.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("shows a restored startup load failure and resumes its held message through Retry", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } } }
        : {}),
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:startup-load-recovery";
    const messageId = "startup-load-first-turn";
    const message = "Continue the saved cloud task";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": createdSessionListResult(sessionKey),
        "sessions.describe": {
          session: { placement: { state: "active", environmentId: "cloud-recovery" } },
        },
        "sessions.send": { runId: messageId, status: "started" },
      },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator(".chat-pane-cache__pane--active");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => composer.isDisabled()).toBe(false);
      const owner = await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime: { context: ApplicationContext };
        };
        const { gateway: applicationGateway } = app.runtime.context;
        return {
          gatewayUrl: applicationGateway.connection.gatewayUrl,
          recoveryScope: applicationGateway.snapshot.client!.recoveryScope,
        };
      });
      const recovery: SessionPlacementPendingRecovery = {
        ...owner,
        sessionKey,
        messageId,
        message,
        agentId: "main",
        target: { kind: "profile", profileId: "test-cloud" },
        phase: "dispatching",
      };
      const storageKey = sessionPlacementRecoveryExactStorageKey(
        owner.gatewayUrl,
        owner.recoveryScope,
        sessionKey,
      );
      await page.evaluate(
        ({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)),
        { key: storageKey, record: recovery },
      );
      let moduleRequests = 0;
      let documentProbes = 0;
      await page.route("**/*", async (route) => {
        if (route.request().method() === "HEAD" && ++documentProbes === 1) {
          await route.fulfill({ status: 503 });
        } else {
          await route.fallback();
        }
      });
      await page.route(
        /\/assets\/session-placement-startup\.runtime-[^/?]+\.js(?:\?.*)?$/,
        async (route) => {
          moduleRequests += 1;
          if (moduleRequests === 1) {
            await route.abort("failed");
          } else {
            await route.continue();
          }
        },
      );
      await page.reload();
      await expect.poll(() => moduleRequests).toBe(1);
      const alert = page.getByRole("alert").filter({ hasText: "runner startup failed" });
      try {
        await alert.getByRole("button", { name: "Retry", exact: true }).waitFor();
      } finally {
        if (captureUiProofEnabled) {
          await page.screenshot({ path: path.join(suite.artifactDir, "startup-load-failure.png") });
        }
      }
      const readStartup = () =>
        page.evaluate((key) => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: { context: ApplicationContext };
          };
          return app.runtime.context.placementStartup.get(key);
        }, sessionKey);
      const failed = await readStartup();
      await expect.poll(() => page.evaluate(() => Date.now())).toBeGreaterThan(failed!.startedAt);
      for (const selectedKey of ["agent:main:another-task", sessionKey]) {
        await page.evaluate((key) => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: { context: ApplicationContext };
          };
          app.runtime.context.gateway.setSessionKey(key);
        }, selectedKey);
        expect(await readStartup()).toEqual(failed);
      }
      await alert.getByRole("button", { name: "Retry", exact: true }).waitFor();
      const held = await pane.evaluate(async (element) => {
        const { state } = element as HTMLElement & { state: ChatPageHost };
        state.handleChatDraftChange("later ordinary turn");
        await state.handleSendChat();
        return { draft: state.chatMessage, queued: state.chatQueue.map((item) => item.text) };
      });
      expect(held).toEqual({ draft: "later ordinary turn", queued: [] });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
      await alert.getByRole("button", { name: "Retry", exact: true }).click();
      expect(await gateway.waitForRequest("sessions.send")).toMatchObject({
        params: { key: sessionKey, message, idempotencyKey: messageId },
      });
      await expect
        .poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey))
        .toBeNull();
      await page.locator(".chat-group.user", { hasText: message }).waitFor();
      expect(await composer.inputValue()).toBe("later ordinary turn");
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.send")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(moduleRequests).toBe(2);
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(suite.artifactDir, "startup-load-recovered.png") });
      }
    } finally {
      await context.close();
    }
  });
});
