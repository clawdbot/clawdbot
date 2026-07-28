import { expect, it } from "vitest";
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
  installMockGateway,
  pastePng,
  pollLocatorText,
  replaceGatewayClient,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("dispatches a cloud target before sending its first turn and shows placement", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:cloud:cloud-e2e";
    const gateway = await installMockGateway(page, {
      defaultAgentId: "cloud",
      deferredMethods: ["sessions.dispatch"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.reclaim"],
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
        "sessions.describe": { session: {} },
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

      const modelSelect = page.locator(
        '.new-session-page__composer [data-chat-model-select="true"]',
      );
      await modelSelect.click();
      await expect.poll(() => modelSelect.getAttribute("data-chat-thinking-select")).toBe("true");
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
      await expect.poll(() => modelSelect.getAttribute("data-chat-thinking-value")).toBe("high");
      await captureUiProof(page, "01-cloud-thinking-level.png");
      await modelSelect.click();
      await expect
        .poll(() => modelSelect.evaluate((element) => element.closest("details")?.open ?? false))
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
      const startButton = page.getByRole("button", { name: "Start thread" });
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
      await gateway.waitForRequest("sessions.dispatch");
      await gateway.rejectDeferred("sessions.dispatch", {
        code: "UNAVAILABLE",
        message: "allocation response lost",
      });
      await pollLocatorText(page.locator(".new-session-page__error")).toContain(
        "cloud worker placement could not be verified",
      );
      const alert = page.locator(".new-session-page__alert");
      await expect.poll(() => alert.getAttribute("role")).toBe("alert");
      await expect.poll(() => alert.locator("svg").count()).toBe(1);
      const [alertBox, composerBox] = await Promise.all([
        alert.boundingBox(),
        page.locator(".new-session-page__composer").boundingBox(),
      ]);
      expect(alertBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(
        Math.abs(
          (alertBox?.x ?? 0) +
            (alertBox?.width ?? 0) / 2 -
            ((composerBox?.x ?? 0) + (composerBox?.width ?? 0) / 2),
        ),
      ).toBeLessThanOrEqual(1);
      await expect.poll(() => startButton.isDisabled()).toBe(false);
      await page.getByRole("button", { name: "Start thread" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.dispatch")).length)
        .toBe(2);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
      const dispatches = await gateway.getRequests("sessions.dispatch");
      expect(dispatches.at(-1)?.params).toEqual({
        key: sessionKey,
        agentId: "cloud",
        profileId: "aws",
      });
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
      expect(orderedMethods).toEqual([
        "sessions.create",
        "sessions.dispatch",
        "sessions.dispatch",
        "sessions.send",
      ]);

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
      await sessionRow.getByRole("button", { name: "Open thread menu" }).click();
      const stopWorker = page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Stop cloud worker…" });
      await stopWorker.waitFor();
      await captureUiProof(page, "02-active-cloud-worker-stop.png");
      expect(await localSessionRow.locator(".session-row-badge--cloud").count()).toBe(0);
      expect(await cloudPlacementBadge.locator("circle").count()).toBe(1);
      expect(await cloudPlacementBadge.locator("rect").count()).toBe(0);
      page.once("dialog", (dialog) => void dialog.accept());
      await stopWorker.click();
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
        .poll(() => page.getByRole("button", { name: "Start thread" }).isDisabled())
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
            key.startsWith("openclaw.new-session.cloud-recovery.v1:") ||
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
      await page.getByRole("button", { name: "Start thread" }).click();
      const firstSend = await gateway.waitForRequest("sessions.send");
      expect(firstSend.params).toMatchObject({
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      await gateway.rejectDeferred("sessions.send", {
        code: "UNAVAILABLE",
        message: "send outcome unknown",
      });
      await pollLocatorText(page.locator(".new-session-page__error")).toContain(
        "send outcome unknown",
      );
      await gateway.setMethodResponse("sessions.send", {
        runId: "run-reload-recovery",
        status: "started",
      });

      await page.reload();
      await gateway.waitForRequest("environments.list");
      await expect
        .poll(() => page.locator(".new-session-page__message").inputValue())
        .toBe(message);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await expect
        .poll(() => page.getByRole("button", { name: "Remove attachment" }).isDisabled())
        .toBe(true);
      await expect
        .poll(() => page.getByRole("button", { name: "Start thread" }).isDisabled())
        .toBe(false);
      await page.getByRole("button", { name: "Start thread" }).click();
      const resumedSend = await gateway.waitForRequest("sessions.send");
      expect(resumedSend.params).toMatchObject({
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
        idempotencyKey: (firstSend.params as { idempotencyKey: string }).idempotencyKey,
        key: sessionKey,
        message,
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });

  it("restores cloud recovery added while the Gateway is disconnected", async () => {
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
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const recoveryIdentity = await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              gateway: {
                connection: { gatewayUrl: string };
                snapshot: { client?: { recoveryScope?: string } | null };
              };
            };
          };
        };
        const gatewaySnapshot = app.runtime?.context.gateway;
        const gatewayUrl = gatewaySnapshot?.connection.gatewayUrl ?? "";
        const recoveryScope = gatewaySnapshot?.snapshot.client?.recoveryScope ?? "";
        if (!gatewayUrl || !recoveryScope) {
          throw new Error("Gateway recovery identity is unavailable");
        }
        return { gatewayUrl, recoveryScope };
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
      await page.evaluate(({ gatewayUrl, recoveryScope }) => {
        sessionStorage.setItem(
          `openclaw.new-session.cloud-recovery.v1:${gatewayUrl}:${recoveryScope}`,
          JSON.stringify({
            sessionKey: "agent:cloud:offline-recovery",
            messageId: "message-offline-recovery",
            message: "restore after reconnect",
            attachments: [
              {
                type: "image",
                mimeType: "image/png",
                fileName: "pixel.png",
                content:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
              },
            ],
            profileId: "aws",
            agentId: "cloud",
            gatewayUrl,
            recoveryScope,
            phase: "sending",
          }),
        );
      }, recoveryIdentity);

      await gateway.setOnline(true);
      await expect
        .poll(() => page.locator(".new-session-page__message").inputValue())
        .toBe("restore after reconnect");
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await expect
        .poll(() => page.getByRole("button", { name: "Start thread" }).isDisabled())
        .toBe(false);
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              gateway: {
                snapshot: {
                  client?: { recoveryScopeTracker?: { ready: boolean } } | null;
                };
              };
            };
          };
        };
        const client = app.runtime?.context.gateway.snapshot.client;
        if (!client?.recoveryScopeTracker) {
          throw new Error("Gateway recovery tracker is unavailable");
        }
        client.recoveryScopeTracker.ready = false;
        (
          document.querySelector("openclaw-new-session-page") as
            | (HTMLElement & { requestUpdate: () => void })
            | null
        )?.requestUpdate();
      });
      await expect
        .poll(() => page.getByRole("button", { name: "Start thread" }).isDisabled())
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
      await page.getByRole("button", { name: "Start thread" }).click();
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
      await page.getByRole("button", { name: "Start thread" }).click();
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
          candidate.startsWith("openclaw.new-session.cloud-recovery.v1:"),
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
      await page.getByRole("button", { name: "Start thread" }).click();
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

      await pollLocatorText(page.locator(".new-session-page__error")).toContain(
        "cleanup unavailable",
      );
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
          if (key.startsWith("openclaw.new-session.cloud-recovery.v1:")) {
            originalSetItem(key, value);
            return;
          }
          throw new DOMException("composer storage disabled", "SecurityError");
        };
      });
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start thread" }).click();
      const firstSend = await gateway.waitForRequest("sessions.send");
      await gateway.rejectDeferred("sessions.send", {
        code: "UNAVAILABLE",
        message: "send outcome unknown",
      });

      await pollLocatorText(page.locator(".new-session-page__error")).toContain(
        "send outcome unknown",
      );
      await expect.poll(() => page.locator(".new-session-page__message").isDisabled()).toBe(true);
      expect(await page.locator(".new-session-page__message").inputValue()).toBe(message);
      expect(new URL(page.url()).pathname).toContain("/new");
      await gateway.setMethodResponse("environments.list", { environments: [], profiles: [] });
      const profileRequests = (await gateway.getRequests("environments.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(profileRequests);
      await page.getByRole("button", { name: "Start thread" }).click();
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
        timeout: 30_000,
      });

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
