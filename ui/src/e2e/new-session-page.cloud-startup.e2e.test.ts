import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  ONE_PIXEL_PNG_B64,
  SESSION_LIST_DEFAULTS,
  TARGET_REPO,
  WORKSPACE,
  captureUiProof,
  controlUiSessionPath,
  controlUiSessionUrl,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  expectPendingCloudStartupBeforeRuntime,
  installMockGateway,
  pastePng,
  pollLocatorText,
  replaceGatewayClient,
  waitForCommittedChatRoute,
  waitForConfirmModal,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const CLOUD_STARTUP_RUNTIME_REQUEST =
  /\/assets\/cloud-session-startup\.runtime-[^/?]+\.js(?:\?.*)?$/;

suite.define(() => {
  it("dispatches a cloud target before sending its first turn and shows placement", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const runtimeLoad = createDeferred();
    let runtimeRequested = false;
    await page.route(CLOUD_STARTUP_RUNTIME_REQUEST, async (route) => {
      runtimeRequested = true;
      await runtimeLoad.promise;
      await route.continue();
    });
    const sessionKey = "agent:cloud:cloud-e2e";
    const gateway = await installMockGateway(page, {
      defaultAgentId: "cloud",
      deferredMethods: ["sessions.dispatch"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.create",
        "sessions.dispatch",
        "sessions.reclaim",
      ],
      workspaceGit: true,
      sessionKey: "agent:cloud:neutral-e2e",
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
        "fs.listDir": {
          path: WORKSPACE,
          parent: "/home/peter",
          home: "/home/peter",
          entries: [],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: sessionKey },
        "sessions.list": createdSessionListResult(sessionKey),
        "sessions.dispatch": {
          ok: true,
          key: sessionKey,
          sessionId: "session-cloud-e2e",
          placement: {
            state: "active",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
            stateChangedAtMs: 2,
            environmentId: "worker-1",
            activeOwnerEpoch: 1,
            workerBundleHash: "a".repeat(64),
            workspaceBaseManifestRef: "manifest-1",
            remoteWorkspaceDir: "/workspace",
          },
        },
        "sessions.describe": {
          session: {
            placement: {
              state: "requested",
              generation: 1,
              createdAtMs: 1,
              updatedAtMs: 1,
              stateChangedAtMs: 1,
            },
          },
        },
        "sessions.delete": { ok: true, deleted: true },
        "sessions.reclaim": { ok: true },
        "sessions.send": { runId: "run-cloud-e2e", status: "started" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      expect(
        await page.evaluate(() => ({
          hasSubtleCrypto: Boolean(globalThis.crypto.subtle),
          isSecureContext: globalThis.isSecureContext,
        })),
      ).toEqual({ hasSubtleCrypto: true, isSecureContext: true });
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-place-trigger").click();
      const place = page.locator("wa-popover.new-session-page__place-popover");
      await place.getByRole("button", { name: "Cloud · aws" }).click();
      const trigger = page.locator("#new-session-place-trigger");
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await expect.poll(() => page.getByLabel("Base branch").inputValue()).toBe("main");

      const effortSelect = page.locator(
        '.new-session-page__composer [data-chat-thinking-select="true"]',
      );
      await effortSelect.click();
      const thinkingSlider = page.locator(
        '.new-session-page__composer [data-chat-thinking-slider="true"]',
      );
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe("off,minimal,low,medium,high");
      await expect
        .poll(() => page.locator(".new-session-page__composer [data-chat-speed-toggle]").count())
        .toBe(0);
      await thinkingSlider.press("End");
      await expect.poll(() => effortSelect.getAttribute("data-chat-thinking-value")).toBe("high");
      await captureUiProof(page, "01-cloud-thinking-level.png");
      await effortSelect.click();
      await expect
        .poll(() => effortSelect.evaluate((element) => element.closest("details")?.open ?? false))
        .toBe(false);

      // Picking a Gateway repo keeps the cloud selection: that folder is what
      // the managed worktree checks out and dispatch syncs to the worker.
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await trigger.click();
      await pollLocatorText(place.locator(".new-session-page__menu-note")).toContain(
        "Syncs target-repo to the cloud worker",
      );
      await captureUiProof(page, "01-cloud-worker-target.png");
      await page.keyboard.press("Escape");

      const message = "fix the cloud-only failure";
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await pastePng(composer);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      const startButton = page.getByRole("button", { name: "Start session" });
      await gateway.deferNext("environments.list");
      const profileRequests = (await gateway.getRequests("environments.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(profileRequests);
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => startButton.isDisabled()).toBe(true);
      await gateway.rejectDeferred("environments.list", {
        code: "UNAVAILABLE",
        message: "profile lookup unavailable",
      });
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => startButton.isDisabled()).toBe(true);
      const failedProfileRequests = (await gateway.getRequests("environments.list")).length;
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(failedProfileRequests);
      await expect.poll(() => startButton.isDisabled()).toBe(false);

      await startButton.click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "cloud",
        message: "",
        worktree: true,
        worktreeBaseRef: "main",
        cwd: TARGET_REPO,
        thinkingLevel: "high",
      });
      expect(create.params).not.toHaveProperty("attachments");
      await expect.poll(() => runtimeRequested).toBe(true);
      const startupStatus = await expectPendingCloudStartupBeforeRuntime(page, gateway, sessionKey);
      runtimeLoad.resolve();
      await gateway.waitForRequest("sessions.dispatch");
      const describeRequestsAfterNavigation = (await gateway.getRequests("sessions.describe"))
        .length;
      await expect.poll(() => page.url()).toContain(controlUiSessionPath(sessionKey));
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").isDisabled())
        .toBe(true);
      const publishPlacement = async (
        state: "requested" | "provisioning" | "syncing" | "starting",
        generation: number,
        includeNeutral = false,
      ) => {
        await gateway.setMethodResponse("sessions.list", {
          count: includeNeutral ? 2 : 1,
          path: "",
          defaults: SESSION_LIST_DEFAULTS,
          sessions: [
            {
              key: sessionKey,
              kind: "direct",
              label: "Cloud session",
              updatedAt: Date.now(),
              placement: {
                state,
                generation,
                createdAtMs: 1,
                updatedAtMs: generation,
                stateChangedAtMs: generation,
              },
            },
            ...(includeNeutral
              ? [
                  {
                    key: "agent:cloud:neutral-e2e",
                    kind: "direct",
                    label: "Neutral session",
                    updatedAt: Date.now() - 1,
                    placement: { state: "local" },
                  },
                ]
              : []),
          ],
          ts: Date.now(),
        });
        await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "dispatch" });
        await pollLocatorText(startupStatus).toContain(`Cloud worker: ${state}`);
      };

      for (const [state, generation] of [
        ["requested", 1],
        ["provisioning", 2],
        ["syncing", 3],
        ["starting", 4],
      ] as const) {
        await publishPlacement(state, generation, state === "starting");
        expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
      }
      expect(await gateway.getRequests("sessions.describe")).toHaveLength(
        describeRequestsAfterNavigation,
      );
      const neutralRow = page.locator('[data-session-key="agent:cloud:neutral-e2e"] a');
      await neutralRow.waitFor();
      await neutralRow.click();
      await expect.poll(() => page.url()).toContain("neutral-e2e");
      await page.evaluate((pathname) => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              navigate: (routeId: string, options: { pathname: string }) => void;
            };
          };
        };
        app.runtime?.context.navigate("chat", { pathname });
      }, controlUiSessionPath(sessionKey));
      await expect.poll(() => page.url()).toContain(controlUiSessionPath(sessionKey));
      await pollLocatorText(startupStatus).toContain("Cloud worker: starting");
      expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
      expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.dispatch", {
        ok: true,
        key: sessionKey,
        sessionId: "session-cloud-e2e",
        placement: {
          state: "active",
          generation: 5,
          createdAtMs: 1,
          updatedAtMs: 5,
          stateChangedAtMs: 5,
          environmentId: "worker-1",
          activeOwnerEpoch: 1,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "manifest-1",
          remoteWorkspaceDir: "/workspace",
        },
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
      const send = await gateway.waitForRequest("sessions.send");
      expect(send.params).toMatchObject({
        key: sessionKey,
        agentId: "cloud",
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      const orderedMethods = (await gateway.getRequests())
        .map((request) => request.method)
        .filter((method) =>
          ["sessions.create", "sessions.dispatch", "sessions.send"].includes(method),
        );
      expect(orderedMethods).toEqual(["sessions.create", "sessions.dispatch", "sessions.send"]);
      const promptBubbles = page.locator(".chat-group.user .chat-bubble", { hasText: message });
      await expect.poll(() => promptBubbles.count()).toBe(1);

      await gateway.setMethodResponse("sessions.list", {
        count: 4,
        path: "",
        defaults: {},
        sessions: [
          {
            key: sessionKey,
            kind: "direct",
            label: "Cloud session",
            updatedAt: Date.now(),
            worktree: { id: "worktree-1", branch: "openclaw/cloud-e2e", repoRoot: WORKSPACE },
            placement: { state: "active" },
          },
          {
            key: "agent:cloud:managed-e2e",
            kind: "direct",
            label: "Managed session",
            updatedAt: Date.now() - 1,
            placement: { state: "active" },
          },
          {
            key: "agent:cloud:local-e2e",
            kind: "direct",
            label: "Local session",
            updatedAt: Date.now() - 2,
            placement: { state: "local" },
          },
          {
            key: "agent:cloud:neutral-e2e",
            kind: "direct",
            label: "Neutral session",
            updatedAt: Date.now() - 3,
            placement: { state: "local" },
          },
        ],
        ts: Date.now(),
      });
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "dispatch" });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:cloud:neutral-e2e"));
      const managedSessionKey = "agent:cloud:managed-e2e";
      const sessionRow = page.locator(`[data-session-key="${managedSessionKey}"]`);
      const localSessionRow = page.locator('[data-session-key="agent:cloud:local-e2e"]');
      await sessionRow.waitFor();
      await localSessionRow.waitFor();
      const cloudPlacementBadge = sessionRow.locator('[data-placement-state="active"]');
      await cloudPlacementBadge.waitFor();
      await sessionRow.hover();
      await sessionRow.getByRole("button", { name: "Open session menu" }).click();
      const stopWorker = page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Stop cloud worker…" });
      await stopWorker.waitFor();
      await captureUiProof(page, "02-active-cloud-worker-stop.png");
      expect(await localSessionRow.locator(".session-row-badge--cloud").count()).toBe(0);
      expect(await cloudPlacementBadge.locator("circle").count()).toBe(1);
      expect(await cloudPlacementBadge.locator("rect").count()).toBe(0);
      await stopWorker.click();
      await (await waitForConfirmModal(page)).getByRole("button", { name: "Stop worker" }).click();
      const reclaim = await gateway.waitForRequest("sessions.reclaim");
      expect(reclaim.params).toEqual({ key: managedSessionKey, agentId: "cloud" });
    } finally {
      await context.close();
    }
  });

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
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      const trigger = page.locator("#new-session-place-trigger");
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");

      await gateway.setMethodResponse("environments.list", { environments: [], profiles: [] });
      const profileRequests = (await gateway.getRequests("environments.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(profileRequests);
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await pollLocatorText(trigger).toContain("Cloud · aws");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(true);
      await trigger.click();
      await expect
        .poll(() =>
          page
            .locator("wa-popover.new-session-page__place-popover")
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
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("false");
    } finally {
      await context.close();
    }
  });

  it("restores a cloud startup after a page reload without creating another session", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
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
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.evaluate(() => {
        const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
        Storage.prototype.setItem = function (key: string, value: string) {
          if (
            key.startsWith("openclaw.new-session.cloud-recovery.v2:") ||
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
      expect(firstSend.params).toMatchObject({
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      await gateway.rejectDeferred("sessions.send", {
        code: "UNAVAILABLE",
        message: "send outcome unknown",
      });
      await pollLocatorText(page.locator(".chat-cloud-startup-error")).toContain(
        "send outcome unknown",
      );
      await gateway.setMethodResponse("sessions.send", {
        runId: "run-reload-recovery",
        status: "started",
      });

      const recoveryRuntimeLoad = createDeferred();
      let recoveryRuntimeRequested = false;
      await page.route(CLOUD_STARTUP_RUNTIME_REQUEST, async (route) => {
        recoveryRuntimeRequested = true;
        await recoveryRuntimeLoad.promise;
        await route.continue();
      });
      await page.reload();
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
      const resumedSend = await gateway.waitForRequest("sessions.send");
      expect(resumedSend.params).toMatchObject({
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
        idempotencyKey: (firstSend.params as { idempotencyKey: string }).idempotencyKey,
        key: sessionKey,
        message,
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await waitForCommittedChatRoute(page);
      expect(page.url()).toContain(controlUiSessionPath(sessionKey));
    } finally {
      await context.close();
    }
  });

  it("resumes runtime recovery added while disconnected without locking the new-session page", async () => {
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
        "sessions.describe": {
          session: {
            key: "agent:cloud:offline-recovery",
            placement: { state: "active", environmentId: "environment-offline-recovery" },
          },
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
        return { gatewayUrl, legacyScope };
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
      await page.evaluate(({ gatewayUrl, legacyScope }) => {
        sessionStorage.setItem(
          `openclaw.new-session.cloud-recovery.v1:${gatewayUrl}:${legacyScope}`,
          JSON.stringify({
            sessionKey: "agent:cloud:offline-recovery",
            messageId: "message-offline-recovery",
            message: "restore after reconnect",
            profileId: "aws",
            agentId: "cloud",
            gatewayUrl,
            recoveryScope: legacyScope,
            phase: "sending",
          }),
        );
      }, recoveryIdentity);

      await gateway.setOnline(true);
      const resumedSend = await gateway.waitForRequest("sessions.send");
      expect(resumedSend.params).toMatchObject({
        idempotencyKey: "message-offline-recovery",
        key: "agent:cloud:offline-recovery",
        message: "restore after reconnect",
      });
      expect(
        await page.evaluate(
          ({ gatewayUrl, legacyScope }) =>
            sessionStorage.getItem(
              `openclaw.new-session.cloud-recovery.v1:${gatewayUrl}:${legacyScope}`,
            ),
          recoveryIdentity,
        ),
      ).toBeNull();
      await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("");
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
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

  it("retries an ambiguous cloud create with the same session key", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const message = "recover the cloud create";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.create"],
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
        "sessions.dispatch": {
          placement: { state: "active", environmentId: "worker-create-recovery" },
        },
        "sessions.send": { runId: "run-create-recovery", status: "started" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const firstCreate = await gateway.waitForRequest("sessions.create");
      const firstKey = (firstCreate.params as { key?: string }).key;
      if (!firstKey) {
        throw new Error("expected the first recovery create to include a session key");
      }
      expect(firstKey).toMatch(/^agent:cloud:dashboard:/);

      await page.reload();
      await gateway.waitForRequest("environments.list");
      await expect
        .poll(() => page.locator(".new-session-page__message").inputValue())
        .toBe(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const retryCreate = await gateway.waitForRequest("sessions.create");
      expect(retryCreate.params).toMatchObject({ key: firstKey, message: "", worktree: true });
      await gateway.resolveDeferred("sessions.create", { key: firstKey });

      expect(await gateway.waitForRequest("sessions.dispatch")).toMatchObject({
        params: { key: firstKey, agentId: "cloud", profileId: "aws" },
      });
      expect(await gateway.waitForRequest("sessions.send")).toMatchObject({
        params: { key: firstKey, agentId: "cloud", message },
      });
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(firstKey), {
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });

  it("keeps the original recovery identity when a cloud create settles after reset", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const message = "preserve this late cloud create";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.create", "sessions.delete"],
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
      },
    });

    const readRecovery = () =>
      page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((candidate) =>
          candidate.startsWith("openclaw.new-session.cloud-recovery.v2:"),
        );
        return key ? (JSON.parse(sessionStorage.getItem(key) ?? "null") as unknown) : null;
      });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      const sessionKey = (create.params as { key: string }).key;
      const staged = await readRecovery();

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=cloud");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await gateway.resolveDeferred("sessions.create", { key: sessionKey });
      await gateway.waitForRequest("sessions.delete");
      await gateway.rejectDeferred("sessions.delete", {
        code: "UNAVAILABLE",
        message: "cleanup unavailable",
      });

      await pollLocatorText(
        page.locator(".new-session-page__error").filter({ hasText: "cleanup unavailable" }),
      ).toContain("cleanup unavailable");
      const stagedIdentity = staged as { messageId: string; profileId: string; agentId: string };
      expect(await readRecovery()).toMatchObject({
        sessionKey,
        messageId: stagedIdentity.messageId,
        message,
        profileId: stagedIdentity.profileId,
        agentId: stagedIdentity.agentId,
        phase: "dispatching",
      });
    } finally {
      await context.close();
    }
  });

  it("retries an unpersisted cloud turn with its original recovery identity", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:cloud:storage-recovery";
    const message = "keep this cloud recovery task";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.send"],
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
          sessionId: "session-storage-recovery",
          placement: {
            state: "active",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
            stateChangedAtMs: 2,
            environmentId: "worker-storage-recovery",
            activeOwnerEpoch: 1,
            workerBundleHash: "a".repeat(64),
            workspaceBaseManifestRef: "manifest-storage-recovery",
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
          sessionId: "session-storage-recovery",
          sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.evaluate(() => {
        const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key.startsWith("openclaw.new-session.cloud-recovery.v2:")) {
            originalSetItem(key, value);
            return;
          }
          throw new DOMException("composer storage disabled", "SecurityError");
        };
      });
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const firstSend = await gateway.waitForRequest("sessions.send");
      await gateway.rejectDeferred("sessions.send", {
        code: "UNAVAILABLE",
        message: "send outcome unknown",
      });

      await pollLocatorText(page.locator(".chat-cloud-startup-error")).toContain(
        "send outcome unknown",
      );
      expect(new URL(page.url()).pathname).toContain(controlUiSessionPath(sessionKey));
      await replaceGatewayClient(page);
      await expect.poll(async () => (await gateway.getRequests("sessions.send")).length).toBe(2);

      const sends = await gateway.getRequests("sessions.send");
      expect(sends).toHaveLength(2);
      expect(sends[1]?.params).toMatchObject({
        idempotencyKey: (firstSend.params as { idempotencyKey: string }).idempotencyKey,
        key: sessionKey,
        message,
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      const dispatches = await gateway.getRequests("sessions.dispatch");
      expect(dispatches).toHaveLength(2);
      expect(dispatches[1]?.params).toMatchObject({ profileId: "aws" });
    } finally {
      await context.close();
    }
  });
});
