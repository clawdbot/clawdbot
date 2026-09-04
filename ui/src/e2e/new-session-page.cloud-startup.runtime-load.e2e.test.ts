import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import type { SessionPlacementPendingRecovery } from "../lib/sessions/session-placement-recovery.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import {
  navigateToControlUiSession,
  startProductionControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createdSessionListResult,
  installMockGateway,
  navigateInApp,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const buildId = "startup-recovery-proof";
const suite = createControlUiE2eSuite({
  name: "Control UI startup recovery production E2E",
  startServer: async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-startup-recovery-"));
    try {
      const server = await startProductionControlUiE2eServer(outDir, buildId);
      return {
        ...server,
        close: async () => {
          try {
            await server.close();
          } finally {
            await rm(outDir, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await rm(outDir, { recursive: true, force: true });
      throw error;
    }
  },
});

suite.define(() => {
  it.each(["saved", "chat", "toast"])(
    "recovers a saved startup through %s recovery",
    async (escape) => {
      const incognito = escape !== "saved";
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
      const privateKey = "agent:main:private-startup";
      const privateMessage = "Keep this unsent private task in memory";
      const gateway = await installMockGateway(page, {
        serverBuildId: buildId,
        workspaceGit: true,
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", name: "Main", workspace: "/workspace/cloud-proof", workspaceGit: true },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "worktrees.branches": {
            branches: [{ kind: "local", name: "main" }],
            defaultBranch: "main",
            repositoryStatus: "git",
          },
          "environments.list": {
            environments: [],
            profiles: [{ id: "test-cloud", providerId: "crabbox" }],
          },
          "sessions.create": { key: privateKey },
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
        const alert = pane.getByRole("alert").filter({ hasText: "runner startup failed" });
        try {
          await alert.getByRole("button", { name: "Retry", exact: true }).waitFor();
        } finally {
          if (captureUiProofEnabled) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(
                suite.artifactDir,
                `${incognito ? "mixed" : "saved"}-startup-load-failure.png`,
              ),
            });
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
        if (incognito) {
          const timeOrigin = await page.evaluate(() => performance.timeOrigin);
          await page.locator(".sidebar-brand__new-thread").click();
          await page.locator("#new-session-where-trigger").click();
          await page
            .locator("wa-popover.new-session-page__where-popover")
            .getByRole("button", { name: "Cloud · test-cloud" })
            .click();
          await page.getByRole("switch", { name: "Incognito" }).click();
          await page.locator(".new-session-page__message").fill(privateMessage);
          await page.getByRole("button", { name: "Start session" }).click();
          await waitForCommittedChatRoute(page);
          expect(await gateway.waitForRequest("sessions.create")).toMatchObject({
            params: { incognito: true, message: "" },
          });
          const warning = "Recovery needs a reload. Unsaved starts will be lost.";
          for (const selectedKey of [privateKey, sessionKey]) {
            await navigateToControlUiSession(page, selectedKey);
            await expect.poll(() => alert.locator("strong").textContent()).toContain(warning);
            expect(await alert.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
            expect(await alert.locator("details").count()).toBe(0);
            if (captureUiProofEnabled) {
              await page.screenshot({
                animations: "disabled",
                path: path.join(
                  suite.artifactDir,
                  `${selectedKey === privateKey ? "incognito" : "saved"}-reload-blocked.png`,
                ),
              });
            }
          }
          await page.setViewportSize({ width: 390, height: 844 });
          expect(
            await alert.evaluate((element) => {
              const text = element.querySelector(".chat-error__content")!.getBoundingClientRect();
              const action = element.querySelector(".chat-error__discard")!.getBoundingClientRect();
              return action.top >= text.bottom && action.right <= innerWidth && action.left >= 0;
            }),
          ).toBe(true);
          if (captureUiProofEnabled) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, "mobile-reload-blocked.png"),
            });
          }
          await page.setViewportSize({ width: 1280, height: 900 });
          expect(
            await page.evaluate(
              () =>
                new Promise<string>((resolve) => {
                  const channel = new MessageChannel();
                  channel.port1.addEventListener(
                    "message",
                    (event) => {
                      channel.port1.close();
                      channel.port2.close();
                      resolve(event.data.version);
                    },
                    { once: true },
                  );
                  channel.port1.start();
                  navigator.serviceWorker.dispatchEvent(
                    new MessageEvent("message", {
                      data: { type: "sw-version-probe" },
                      ports: [channel.port2],
                    }),
                  );
                }),
            ),
          ).toBe(buildId);
          await page.evaluate(() => {
            navigator.serviceWorker.dispatchEvent(
              new MessageEvent("message", {
                data: { type: "sw-updated", version: "replacement-build" },
              }),
            );
            return new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            });
          });
          expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
          expect(documentProbes).toBe(1);
          expect(
            await page.evaluate(
              (text) =>
                [...Object.values(sessionStorage), ...Object.values(localStorage)].some((value) =>
                  value.includes(text),
                ),
              privateMessage,
            ),
          ).toBe(false);
          expect(await page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBe(
            JSON.stringify(recovery),
          );
          expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
          const configRuntime = /\/assets\/config-page-[^/?]+\.js(?:\?.*)?$/;
          await page.route(configRuntime, (route) => route.abort("failed"));
          await navigateInApp(page, "appearance");
          const reload = page
            .locator(".lazy-view-error")
            .getByRole("button", { name: "Reload", exact: true });
          await reload.click();
          const toast = page.locator(".app-toast__message");
          await expect.poll(() => toast.textContent()).toContain(warning);

          expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
          expect(documentProbes).toBe(1);
          if (captureUiProofEnabled) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, "sibling-reload-blocked.png"),
            });
          }
          await page.unroute(configRuntime);
          // Only these explicit actions authorize discarding the unsaved Incognito start.
          if (escape === "toast") {
            await page
              .locator("openclaw-toast-host")
              .getByRole("button", { name: "Discard unsaved starts and reload", exact: true })
              .click();
          } else {
            await navigateToControlUiSession(page, sessionKey);
            await alert
              .getByRole("button", { name: "Discard unsaved starts and reload", exact: true })
              .click();
          }
        } else {
          await alert.getByRole("button", { name: "Retry", exact: true }).click();
        }
        expect(await gateway.waitForRequest("sessions.send")).toMatchObject({
          params: { key: sessionKey, message, idempotencyKey: messageId },
        });
        if (escape === "toast") {
          await navigateToControlUiSession(page, sessionKey);
        }
        await expect
          .poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey))
          .toBeNull();
        await page.locator(".chat-group.user", { hasText: message }).waitFor();
        expect(await composer.inputValue()).toBe("later ordinary turn");
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.send")).toHaveLength(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(moduleRequests).toBe(2);
        if (incognito) {
          expect(
            await page.evaluate((key) => {
              const app = document.querySelector("openclaw-app") as HTMLElement & {
                runtime: { context: ApplicationContext };
              };
              return app.runtime.context.placementStartup.hasPendingTurn(key);
            }, privateKey),
          ).toBe(false);
        }
        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(
              suite.artifactDir,
              `${incognito ? "mixed" : "saved"}-startup-load-recovered.png`,
            ),
          });
        }
      } finally {
        await context.close();
      }
    },
  );
});
