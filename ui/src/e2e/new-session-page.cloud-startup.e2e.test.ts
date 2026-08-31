import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  ONE_PIXEL_PNG_B64,
  SESSION_LIST_DEFAULTS,
  WORKSPACE,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pastePng,
  pollLocatorText,
  replaceGatewayClient,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";
const suite = createNewSessionPageE2eSuite();
const SESSION_PLACEMENT_STARTUP_RUNTIME_REQUEST =
  /\/assets\/session-placement-startup\.runtime-[^/?]+\.js(?:\?.*)?$/;

suite.define(() => {
  it("clears cloud placement when the selected agent changes", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
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
            {
              id: "local",
              identity: { name: "Local" },
              name: "Local",
              workspace: "/home/peter/local",
              workspaceGit: false,
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
      const trigger = page.locator("#new-session-where-trigger");
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");

      await gateway.setMethodResponse("environments.list", { environments: [], profiles: [] });
      const profileRequests = (await gateway.getRequests("environments.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(profileRequests);
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("aws");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(true);
      await trigger.click();
      await expect
        .poll(() =>
          page
            .locator("wa-popover.new-session-page__where-popover")
            .getByRole("button", { name: "Cloud · aws" })
            .isDisabled(),
        )
        .toBe(true);
      await page.keyboard.press("Escape");

      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Local" })
        .click();
      await page.getByRole("heading", { name: "Local" }).waitFor();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBeNull();
      await expect.poll(() => page.locator("#new-session-detail-trigger").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("restores an unconfirmed cloud turn after reload and checks delivery without replay", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const recoveryRuntimeLoad = createDeferred();
    const sessionKey = "agent:cloud:reload-recovery";
    const message = "resume this cloud task after reload";
    const gateway = await installMockGateway(page, {
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
        "sessions.dispatch": {
          ok: true,
          key: sessionKey,
          sessionId: "session-reload-recovery",
          placement: {
            state: "active",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
            stateChangedAtMs: 2,
            environmentId: "worker-reload-recovery",
            activeOwnerEpoch: 1,
            workerBundleHash: "a".repeat(64),
            workspaceBaseManifestRef: "manifest-reload-recovery",
            remoteWorkspaceDir: "/workspace",
          },
        },
        "sessions.list": {
          count: 1,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [{ key: sessionKey, kind: "direct", updatedAt: Date.now() }],
          ts: Date.now(),
        },
        "chat.history": {
          messages: [],
          sessionId: "session-reload-recovery",
          sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
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
      await page.evaluate(() => {
        const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
        Storage.prototype.setItem = function (key: string, value: string) {
          if (
            key.startsWith("openclaw.new-session.session-placement-recovery.v1:") ||
            key.startsWith("openclaw.control-ui-e2e.")
          ) {
            originalSetItem(key, value);
            return;
          }
          throw new DOMException("composer storage disabled", "SecurityError");
        };
      });
      await gateway.deferNext("sessions.send");
      await page.locator(".new-session-page__message").fill(message);
      await pastePng(page.locator(".new-session-page__message"));
      await page.getByRole("button", { name: "Start session" }).click();
      const firstSend = await gateway.waitForRequest("sessions.send");
      const messageId = (firstSend.params as { idempotencyKey: string }).idempotencyKey;
      expect(firstSend.params).toMatchObject({
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      await waitForCommittedChatRoute(page);
      await gateway.rejectDeferred("sessions.send", {
        code: "UNAVAILABLE",
        message: "send outcome unknown",
      });
      const startupError = await page.evaluate(
        (key) =>
          new Promise<string>((resolve, reject) => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: {
                context: {
                  placementStartup: {
                    get: (sessionKey: string) => { error?: string; phase: string } | null;
                    subscribe: (listener: () => void) => () => void;
                  };
                };
              };
            };
            const placementStartup = app.runtime?.context.placementStartup;
            if (!placementStartup) {
              reject(new Error("session placement startup unavailable"));
              return;
            }
            let settled = false;
            const subscription: { stop?: () => void } = {};
            const resolveFailed = () => {
              const status = placementStartup.get(key);
              if (settled || status?.phase !== "failed") {
                return;
              }
              settled = true;
              subscription.stop?.();
              resolve(status.error ?? "");
            };
            subscription.stop = placementStartup.subscribe(resolveFailed);
            if (settled) {
              subscription.stop();
            } else {
              resolveFailed();
            }
          }),
        sessionKey,
      );
      expect(startupError).toContain("send outcome unknown");
      let recoveryRuntimeRequested = false;
      await page.route(SESSION_PLACEMENT_STARTUP_RUNTIME_REQUEST, async (route) => {
        recoveryRuntimeRequested = true;
        await recoveryRuntimeLoad.promise;
        await route.continue();
      });
      const reload = page.reload();
      await expect.poll(() => recoveryRuntimeRequested).toBe(true);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: { context: { gateway: { snapshot: { phase: string } } } };
            };
            return app.runtime?.context.gateway.snapshot.phase;
          }),
        )
        .toBe("connected");
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
      recoveryRuntimeLoad.resolve();
      await reload;
      await waitForCommittedChatRoute(page);
      expect(page.url()).toContain(controlUiSessionPath(sessionKey));
      const retainedTurn = page.locator(".chat-group.user", { hasText: message });
      const checkDelivery = page.getByRole("button", { name: "Check delivery", exact: true });
      await checkDelivery.waitFor({ state: "visible" });
      await retainedTurn
        .locator(`img[src="data:image/png;base64,${ONE_PIXEL_PNG_B64}"]`)
        .waitFor({ state: "visible" });
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").isDisabled())
        .toBe(true);

      const historyCount = (await gateway.getRequests("chat.history")).length;
      await checkDelivery.click();
      // Background history loads may arrive before this action's request.
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).slice(historyCount))
        .toContainEqual(
          expect.objectContaining({
            params: { sessionKey, limit: 1000, inputRunIds: [messageId] },
          }),
        );
      await pollLocatorText(page.getByRole("alert")).toContain("No matching user message");
      await retainedTurn
        .locator(`img[src="data:image/png;base64,${ONE_PIXEL_PNG_B64}"]`)
        .waitFor({ state: "visible" });

      // Gateway user-turn recording uses the admitted client key plus :user.
      await gateway.setHistoryMessages([
        {
          role: "user",
          content: [
            { type: "text", text: message },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: ONE_PIXEL_PNG_B64 },
            },
          ],
          __openclaw: { idempotencyKey: `${messageId}:user` },
        },
      ]);
      await checkDelivery.click();
      await expect.poll(() => checkDelivery.count()).toBe(0);
      await expect.poll(() => retainedTurn.count()).toBe(1);
      await expect.poll(() => retainedTurn.locator(".chat-send-status").count()).toBe(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
    } finally {
      recoveryRuntimeLoad.resolve();
      await context.close();
    }
  });

  it("reconciles an accepted turn added while disconnected without locking the new-session page", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
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
        "chat.history": {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "restore after reconnect" }],
              __openclaw: { idempotencyKey: "message-offline-recovery:user" },
            },
          ],
          sessionId: "session-offline-recovery",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const recoveryIdentity = await page.evaluate(async () => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              gateway: {
                connection: { gatewayUrl: string };
              };
            };
          };
        };
        const gatewaySnapshot = app.runtime?.context.gateway;
        const gatewayUrl = gatewaySnapshot?.connection.gatewayUrl ?? "";
        if (!gatewayUrl) {
          throw new Error("Gateway recovery identity is unavailable");
        }
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("e2e-device-token"),
        );
        const legacyScope = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const sessionKey = "agent:cloud:offline-recovery";
        const frame = (value: string) => `${value.length}:${value}`;
        const storageKey =
          `openclaw.new-session.session-placement-recovery.v1:${frame(gatewayUrl)}:` +
          `${frame(legacyScope)}:${frame(sessionKey)}`;
        return { gatewayUrl, legacyScope, storageKey };
      });

      await gateway.setOnline(false);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: { context: { gateway: { snapshot: { phase: string } } } };
            };
            return app.runtime?.context.gateway.snapshot.phase === "connected";
          }),
        )
        .toBe(false);
      await page.evaluate(({ gatewayUrl, legacyScope, storageKey }) => {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            sessionKey: "agent:cloud:offline-recovery",
            messageId: "message-offline-recovery",
            message: "restore after reconnect",
            target: { kind: "profile", profileId: "aws" },
            agentId: "cloud",
            gatewayUrl,
            recoveryScope: legacyScope,
            phase: "sending",
          }),
        );
      }, recoveryIdentity);

      await gateway.setOnline(true);
      expect(await gateway.waitForRequest("chat.history")).toMatchObject({
        params: { sessionKey: "agent:cloud:offline-recovery", limit: 1000 },
      });
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(sessionStorage).filter((key) =>
              key.startsWith("openclaw.new-session.session-placement-recovery.v1:"),
            ),
          ),
        )
        .toHaveLength(0);
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("");
      await page.locator("#new-session-where-trigger").click();
      await page
        .locator("wa-popover.new-session-page__where-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.locator(".new-session-page__message").fill("start another cloud task");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(false);
      await gateway.setOnline(false);
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
