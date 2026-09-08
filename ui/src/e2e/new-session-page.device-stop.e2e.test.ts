import path from "node:path";
import { expect, it } from "vitest";
import {
  captureDeviceRuntimeUiProof,
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
  waitForCommittedChatRoute,
  waitForConfirmModal,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("labels device startup and stops only its session, fencing the late dispatch", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
        ...(captureUiProofEnabled
          ? {
              recordVideo: {
                dir: path.join(suite.artifactDir, "device-runtime-gating"),
                size: { width: 1280, height: 900 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        const sessionKey = "agent:main:device-startup";
        const now = Date.now();
        const placement = {
          state: "requested",
          generation: 1,
          createdAtMs: now,
          updatedAtMs: now,
          stateChangedAtMs: now,
        };
        const gateway = await installMockGateway(page, {
          agentModel: "test-provider/test-model",
          models: [{ id: "test-model", name: "Test model", provider: "test-provider" }],
          operatorScopes: ["operator.read", "operator.write"],
          featureMethods: [
            "agent.wait",
            "chat.metadata",
            "chat.startup",
            "sessions.create",
            "sessions.dispatch",
            "sessions.reclaim",
          ],
          workspace: "/workspace/project",
          workspaceGit: true,
          deferredMethods: ["sessions.dispatch"],
          methodResponses: {
            "environments.list": {
              environments: [
                {
                  id: "node:paired-runner",
                  type: "node",
                  label: "Paired runner",
                  status: "available",
                  sessionHost: true,
                  workerSlots: { total: 2, available: 1 },
                },
              ],
              profiles: [],
            },
            "worktrees.branches": {
              branches: [{ kind: "local", name: "main" }],
              defaultBranch: "main",
              repositoryStatus: "git",
            },
            "sessions.create": { key: sessionKey },
            "sessions.list": {
              count: 1,
              defaults: {},
              path: "",
              ts: now,
              sessions: [
                {
                  key: sessionKey,
                  label: "Device startup",
                  kind: "direct",
                  updatedAt: now,
                  placement,
                },
              ],
            },
            "sessions.describe": { session: { placement } },
            "sessions.reclaim": { ok: true },
          },
        });

        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await page.locator("#new-session-where-trigger").click();
        await page.locator('[data-value="device:paired-runner"]').click();
        await page.locator(".new-session-page__message").fill("Run on the paired device");
        await captureDeviceRuntimeUiProof(suite, page, "device-selected.png");
        await page.getByRole("button", { name: "Start session" }).click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({ agentId: "main", message: "", worktree: true });
        const dispatch = await gateway.waitForRequest("sessions.dispatch");
        expect(dispatch.params).toEqual({
          key: sessionKey,
          agentId: "main",
          deviceId: "paired-runner",
        });
        await waitForCommittedChatRoute(page);

        await page.locator(".chat-pane__placement-chip").click();
        const stop = page.locator(".chat-pane__placement-reclaim");
        await stop.waitFor({ state: "visible" });
        const menuText = (await stop.textContent())?.trim();
        await captureDeviceRuntimeUiProof(suite, page, "device-startup-menu.png", {
          surface: page.locator('.chat-pane__placement-menu [part="menu"]'),
          content: [stop],
        });
        await stop.click();
        const dialog = await waitForConfirmModal(page);
        await captureDeviceRuntimeUiProof(suite, page, "device-startup-confirmation.png", {
          surface: dialog.locator("dialog"),
          content: [dialog.getByRole("button", { name: "Cancel", exact: true })],
        });
        // Both baseline captures must exist before the labeling regression fails.
        expect(menuText).toBe("Stop device worker…");
        expect(await dialog.textContent()).toContain(
          'Stop the device worker for "Device startup"?',
        );
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.send")).toHaveLength(0);

        await page.locator(".chat-pane__placement-chip").click();
        await stop.click();
        await (
          await waitForConfirmModal(page)
        )
          .getByRole("button", { name: "Stop device worker", exact: true })
          .click();
        const reclaim = await gateway.waitForRequest("sessions.reclaim");
        expect(reclaim.params).toEqual({ key: sessionKey, agentId: "main" });
        const stopNotice = page.getByRole("alert").filter({ hasText: "Worker stop requested." });
        await expect
          .poll(() => stopNotice.textContent())
          .toContain("Worker stop requested. Review the initial message before retrying.");
        await gateway.resolveDeferred("sessions.dispatch", {
          placement: {
            ...placement,
            state: "active",
            generation: 2,
            environmentId: "node:paired-runner",
            activeOwnerEpoch: 1,
            workerBundleHash: "a".repeat(64),
            workspaceBaseManifestRef: "base",
            remoteWorkspaceDir: "/workspace/project",
            runner: { kind: "device", status: "available", deviceId: "paired-runner" },
          },
        });
        await expect
          .poll(() => stopNotice.textContent())
          .toContain("Worker stop requested. Review the initial message before retrying.");
        expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(1);
        expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
        expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
        await captureDeviceRuntimeUiProof(suite, page, "device-stop-requested.png");
      },
    );
  });
});
