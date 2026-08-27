import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { CLOUD_PROFILE_RETRY_DELAYS_MS } from "../pages/new-session/cloud-profile-discovery.ts";
import {
  ONE_PIXEL_PNG_B64,
  SESSION_LIST_DEFAULTS,
  TARGET_REPO,
  WORKSPACE,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  controlUiSessionUrl,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  expectPendingSessionPlacementStartupBeforeRuntime,
  installMockGateway,
  pastePng,
  pollLocatorText,
  replaceGatewayClient,
  waitForConfirmModal,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const SESSION_PLACEMENT_STARTUP_RUNTIME_REQUEST =
  /\/assets\/session-placement-startup\.runtime-[^/?]+\.js(?:\?.*)?$/;
const cloudProfileRefreshProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "cloud-profile-refresh-retention",
);

suite.define(() => {
  it("dispatches an optionless cloud profile without a machine override", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:optionless-cloud";
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        workspaceGit: true,
        deferredMethods: ["sessions.dispatch"],
        methodResponses: {
          "agents.list": {
            agents: [{ id: "main", workspace: WORKSPACE, workspaceGit: true }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "environments.list": {
            environments: [],
            profiles: [
              {
                id: "aws",
                providerId: "crabbox",
                machines: [{ id: "fast", label: "Fast" }],
              },
              { id: "machine0", providerId: "crabbox" },
            ],
          },
          "worktrees.branches": {
            branches: [{ kind: "local", name: "main" }],
            defaultBranch: "main",
            repositoryStatus: "git",
          },
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-where-trigger");
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Cloud · aws" }).click();
      await trigger.click();
      await place.getByRole("button", { name: "Fast", exact: true }).click();
      await expect.poll(() => trigger.getAttribute("data-machine-class")).toBe("fast");
      await place.getByRole("button", { name: "Cloud · machine0" }).click();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("machine0");
      await expect.poll(() => trigger.getAttribute("data-machine-class")).toBeNull();
      await trigger.click();
      await expect
        .poll(() => place.getByRole("button", { name: "Cloud · machine0" }).isDisabled())
        .toBe(false);
      expect(await place.getByText("Machine", { exact: true }).count()).toBe(0);
      expect(await place.locator('[data-value^="machine:"]').count()).toBe(0);
      await captureUiProof(page, "optionless-cloud-profile.png");
      await page.keyboard.press("Escape");

      await page.locator(".new-session-page__message").fill("Use the configured machine size");
      await page.getByRole("button", { name: "Start session" }).click();
      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toEqual({ key: sessionKey, agentId: "main", profileId: "machine0" });
    });
  });

  it("dispatches a cloud target before sending its first turn and shows placement", async () => {
    if (captureUiProofEnabled) {
      await mkdir(cloudProfileRefreshProofDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: cloudProfileRefreshProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const runtimeLoad = createDeferred();
    let runtimeRequested = false;
    await page.route(SESSION_PLACEMENT_STARTUP_RUNTIME_REQUEST, async (route) => {
      runtimeRequested = true;
      await runtimeLoad.promise;
      await route.continue();
    });
    const sessionKey = "agent:cloud:cloud-e2e";
    const gateway = await installMockGateway(page, {
      defaultAgentId: "cloud",
      operatorScopes: ["operator.admin", "operator.read", "operator.write"],
      deferredMethods: ["sessions.dispatch"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "projects.list",
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
        "projects.list": {
          projects: [
            {
              id: "openclaw",
              displayName: "OpenClaw",
              repoRoot: TARGET_REPO,
              source: "registered",
            },
          ],
        },
        "environments.list": {
          environments: [],
          profiles: [
            {
              id: "aws",
              providerId: "crabbox",
              machines: [
                {
                  id: "standard",
                  label: "Standard",
                  cpu: 32,
                  memoryGb: 64,
                  default: true,
                },
                { id: "fast", label: "Fast", cpu: 64, memoryGb: 128 },
              ],
            },
          ],
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
      await gateway.waitForRequest("projects.list");
      expect(
        await page.evaluate(() => ({
          hasSubtleCrypto: Boolean(globalThis.crypto.subtle),
          isSecureContext: globalThis.isSecureContext,
        })),
      ).toEqual({ hasSubtleCrypto: true, isSecureContext: true });
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await place.getByRole("button", { name: "Cloud · aws" }).click();
      const trigger = page.locator("#new-session-where-trigger");
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await trigger.click();
      await place.getByText("Machine", { exact: true }).waitFor();
      await place.getByRole("button", { name: /Fast/ }).click();
      await expect.poll(() => trigger.getAttribute("data-machine-class")).toBe("fast");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("aws · Fast");
      await page.keyboard.press("Escape");
      expect(await page.locator("#new-session-detail-trigger").count()).toBe(0);

      const effortSelect = page.locator(
        '.new-session-page__composer [data-chat-thinking-select="true"]',
      );
      await effortSelect.click();
      const thinkingSlider = page.locator(
        '.new-session-page__composer [data-chat-thinking-slider="true"]',
      );
      await expect.poll(() => thinkingSlider.isVisible()).toBe(true);
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe("off,minimal,low,medium,high");
      await expect
        .poll(() => page.locator(".new-session-page__composer [data-chat-speed-toggle]").count())
        .toBe(0);
      await expect.poll(() => effortSelect.getAttribute("data-chat-thinking-value")).toBe("");
      await thinkingSlider.press("Home");
      await expect.poll(() => effortSelect.getAttribute("data-chat-thinking-value")).toBe("off");
      await thinkingSlider.press("End");
      await expect.poll(() => effortSelect.getAttribute("data-chat-thinking-value")).toBe("high");
      await captureUiProof(page, "01-cloud-thinking-level.png");
      await effortSelect.click();
      await expect
        .poll(() => effortSelect.evaluate((element) => element.closest("details")?.open ?? false))
        .toBe(false);

      // Both Gateway folders and registered projects remain eligible cloud sources.
      const projectTrigger = page.locator("#new-session-project-trigger");
      const project = page.locator("wa-popover.new-session-page__project-popover");
      await projectTrigger.click();
      await project.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      expect(await page.locator("#new-session-detail-trigger").count()).toBe(0);
      await projectTrigger.click();
      await project.getByText("Advanced", { exact: true }).click();
      await expect.poll(() => project.getByLabel("Base branch").inputValue()).toBe("main");
      await project.getByLabel("Base branch").fill("release");
      await expect.poll(() => project.getByLabel("Base branch").inputValue()).toBe("release");
      await project.getByLabel("Base branch").fill("main");
      await pollLocatorText(project.locator(".new-session-page__menu-note").last()).toContain(
        "Syncs target-repo to the selected runner",
      );
      await page.keyboard.press("Escape");
      await expect
        .poll(() =>
          project.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);

      await projectTrigger.click();
      await expect
        .poll(() =>
          project.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(true);
      await project.getByRole("button", { name: "OpenClaw", exact: true }).click();
      await expect.poll(() => projectTrigger.getAttribute("data-project-id")).toBe("openclaw");
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      expect(await page.locator("#new-session-detail-trigger").count()).toBe(0);
      await projectTrigger.click();
      await expect
        .poll(() =>
          project.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(true);
      const checkoutName = project.getByLabel("Checkout name");
      if (!(await checkoutName.isVisible())) {
        await project.getByText("Advanced", { exact: true }).click();
      }
      await checkoutName.fill("cloud-e2e");
      await pollLocatorText(project.locator(".new-session-page__menu-note").last()).toContain(
        "Syncs OpenClaw to the selected runner",
      );
      await captureUiProof(page, "01-cloud-worker-target.png");
      await page.keyboard.press("Escape");

      const message = "fix the cloud-only failure";
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await pastePng(composer);
      await page.getByRole("img", { name: "pixel.png" }).waitFor();
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

      if (captureUiProofEnabled) {
        await trigger.click();
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(cloudProfileRefreshProofDir, "01-before-refresh.png"),
        });
        await page.keyboard.press("Escape");
      }

      await page.clock.install();
      await gateway.setMethodResponse("environments.list", {
        __mockError: { code: "UNAVAILABLE", message: "profile catalog remains unavailable" },
      });
      await gateway.deferNext("environments.list");
      const requestsBeforePersistentFailure = (await gateway.getRequests("environments.list"))
        .length;
      await gateway.emitGatewayEvent("node.runnerInventory.changed");
      await gateway.waitForRequest("environments.list", {
        after: requestsBeforePersistentFailure,
      });
      await expect.poll(() => startButton.isDisabled()).toBe(true);
      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(cloudProfileRefreshProofDir, "02-refresh-pending.png"),
        });
      }
      await gateway.rejectDeferred("environments.list", {
        code: "UNAVAILABLE",
        message: "profile catalog remains unavailable",
      });

      for (const delayMs of CLOUD_PROFILE_RETRY_DELAYS_MS) {
        const requestsBeforeRetry = (await gateway.getRequests("environments.list")).length;
        await page.clock.runFor(delayMs + 1);
        await gateway.waitForRequest("environments.list", { after: requestsBeforeRetry });
      }
      await page.clock.resume();
      expect(await gateway.getRequests("environments.list")).toHaveLength(
        requestsBeforePersistentFailure + 1 + CLOUD_PROFILE_RETRY_DELAYS_MS.length,
      );
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => trigger.getAttribute("data-machine-class")).toBe("fast");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("aws · Fast");
      await expect.poll(() => startButton.isDisabled()).toBe(false);
      await trigger.click();
      const retainedCloudProfile = place.getByRole("button", { name: "Cloud · aws" });
      await expect.poll(() => retainedCloudProfile.isDisabled()).toBe(false);
      expect(await retainedCloudProfile.getAttribute("title")).toBe(
        "Cloud worker provider: crabbox",
      );
      await expect.poll(() => place.getByRole("button", { name: /Fast/ }).isVisible()).toBe(true);
      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(cloudProfileRefreshProofDir, "03-after-retry-exhaustion.png"),
        });
      }
      await page.keyboard.press("Escape");

      await startButton.click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "cloud",
        message: "",
        projectId: "openclaw",
        worktree: true,
        worktreeBaseRef: "main",
        worktreeName: "cloud-e2e",
        thinkingLevel: "high",
      });
      expect(create.params).not.toHaveProperty("attachments");
      expect(create.params).not.toHaveProperty("cwd");
      await expect.poll(() => runtimeRequested).toBe(true);
      const startupStatus = await expectPendingSessionPlacementStartupBeforeRuntime(
        page,
        gateway,
        sessionKey,
      );
      runtimeLoad.resolve();
      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toMatchObject({
        key: sessionKey,
        agentId: "cloud",
        profileId: "aws",
        machineClass: "fast",
      });
      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(cloudProfileRefreshProofDir, "04-session-dispatch.png"),
        });
      }
      const describeRequestsAfterNavigation = (await gateway.getRequests("sessions.describe"))
        .length;
      await expect.poll(() => page.url()).toContain(controlUiSessionPath(sessionKey));
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").isDisabled())
        .toBe(true);
      const publishPlacement = async (
        state: "requested" | "provisioning" | "syncing" | "starting",
        generation: number,
        label: string,
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
        await pollLocatorText(startupStatus).toContain(label);
      };

      for (const [state, generation, label] of [
        ["requested", 1, "Provisioning environment…"],
        ["provisioning", 2, "Provisioning environment…"],
        ["syncing", 3, "Preparing workspace…"],
        ["starting", 4, "Starting…"],
      ] as const) {
        await publishPlacement(state, generation, label, state === "starting");
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
      await pollLocatorText(startupStatus).toContain("Starting…");
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
      expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
