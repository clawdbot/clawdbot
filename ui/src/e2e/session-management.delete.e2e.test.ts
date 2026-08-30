import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
  uiProofArtifactDir,
  waitForConfirmModal,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

type DraftDeletionTestApp = HTMLElement & { runtime?: { context: ApplicationContext } };

suite.define(() => {
  it("retires confirmed single and batch drafts in both stores without touching siblings or no-ops", async () => {
    const retired = [
      "agent:main:single",
      "agent:main:batch-a",
      "agent:main:batch-b",
      "agent:main:external",
    ];
    const sibling = "agent:main:sibling";
    const noOp = "agent:main:no-op";
    const replacement = "agent:main:replacement";
    const keys = [...retired, sibling, noOp, replacement];
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.delete": { ok: true, deleted: true },
        "sessions.list": sessionsListResponse(
          keys.map((key, index) => sessionRow(key, key, index)),
        ),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      await page.waitForFunction(() => {
        const client = (document.querySelector("openclaw-app") as DraftDeletionTestApp).runtime
          ?.context.gateway.snapshot.client;
        return client?.recoveryScopeReady === true && Boolean(client.recoveryScope);
      });
      const draftStore = await page.evaluateHandle<
        typeof import("../lib/chat/composer-draft-store.runtime.ts")
      >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
      const outboxStore = await page.evaluateHandle<typeof import("../lib/chat/outbox-store.ts")>(
        'import("/src/lib/chat/outbox-store.ts")',
      );
      const owner = await page.evaluate(
        async ({ store, outbox, sessionKeys }) => {
          const client = (document.querySelector("openclaw-app") as DraftDeletionTestApp).runtime
            ?.context.gateway.snapshot.client;
          if (!client?.recoveryScope) {
            throw new Error("Gateway recovery scope unavailable");
          }
          const { gatewayOwner, key: storageKey } = outbox.storageTargetForGateway(
            client.gatewayUrl,
          );
          const sessions = Object.fromEntries(
            sessionKeys.map((key, index) => [
              `${key}\u0000agent:main`,
              {
                draft: `local ${key}`,
                draftRevision: index + 1,
                queue: [{ id: `queued-${index}`, text: "queued", createdAt: index }],
                updatedAt: index + 1,
              },
            ]),
          );
          sessionStorage.setItem(
            `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayOwner)}`,
            JSON.stringify({ version: 4, gatewayOwner, sessions, recovery: {} }),
          );
          const recoveryScope = client.recoveryScope;
          await Promise.all(
            sessionKeys.map((key, index) =>
              store.writeDurableComposerDraft(
                { gatewayOwner, recoveryScope, scopeKey: `chat:v3:${key}\u0000agent:main` },
                {
                  revision: index + 1,
                  text: `durable ${key}`,
                  attachments: [{ blob: new Blob([key]), mimeType: "text/plain" }],
                },
                { expectedRevision: 0, writeId: `seed-${index}` },
              ),
            ),
          );
          return { gatewayOwner, recoveryScope, storageKey };
        },
        { store: draftStore, outbox: outboxStore, sessionKeys: keys },
      );
      const deleteFromRuntime = (sessionKeys: string[]) =>
        page.evaluate(async (targets) => {
          const sessions = (document.querySelector("openclaw-app") as DraftDeletionTestApp).runtime
            ?.context.sessions;
          if (!sessions) {
            throw new Error("Session capability unavailable");
          }
          return targets.length === 1
            ? sessions.delete(targets[0]!, { agentId: "main" })
            : sessions.deleteMany(targets.map((key) => ({ key, agentId: "main" })));
        }, sessionKeys);

      await expect(deleteFromRuntime([retired[0]!])).resolves.toMatchObject({ deleted: true });
      await expect(deleteFromRuntime(retired.slice(1, 3))).resolves.toMatchObject({
        deleted: retired.slice(1, 3),
      });
      await gateway.setMethodResponse("sessions.delete", { ok: true, deleted: false });
      await expect(deleteFromRuntime([noOp])).resolves.toMatchObject({ deleted: false });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: retired[3],
        sessionId: `session:${retired[3]}`,
        agentId: "main",
        reason: "delete",
      });

      await gateway.setMethodResponse("sessions.delete", { ok: true, deleted: true });
      await gateway.deferNext("sessions.delete", { key: replacement });
      const requestsBeforeReplacement = (await gateway.getRequests("sessions.delete")).length;
      const replacementDelete = deleteFromRuntime([replacement]);
      await gateway.waitForRequest("sessions.delete", { after: requestsBeforeReplacement });
      const inFlightRevision = await page.evaluate(
        async ({ store, key, scopeOwner }) => {
          const storageKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(scopeOwner.gatewayOwner)}`;
          const local = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as {
            sessions: Record<string, unknown>;
          };
          const revision = Date.now();
          local.sessions[`${key}\u0000agent:main`] = {
            draft: "in-flight local edit",
            draftRevision: revision,
            updatedAt: Date.now(),
          };
          sessionStorage.setItem(storageKey, JSON.stringify(local));
          await store.writeDurableComposerDraft(
            { ...scopeOwner, scopeKey: `chat:v3:${key}\u0000agent:main` },
            { revision, text: "in-flight durable edit", attachments: [] },
            { expectedRevision: 7, writeId: "in-flight-edit" },
          );
          return revision;
        },
        { store: draftStore, key: replacement, scopeOwner: owner },
      );
      await expect
        .poll(() => page.evaluate((revision) => Date.now() > revision, inFlightRevision))
        .toBe(true);
      await gateway.resolveDeferred("sessions.delete", { ok: true, deleted: true });
      await expect(replacementDelete).resolves.toMatchObject({ deleted: true });

      await expect
        .poll(() =>
          page.evaluate(
            async ({ store, key, scopeOwner }) => {
              const storageKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(scopeOwner.gatewayOwner)}`;
              const local = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as {
                sessions?: Record<string, { draft?: string; queue?: unknown[] }>;
              };
              const scopeKey = `${key}\u0000agent:main`;
              const localDraft = local.sessions?.[scopeKey];
              const durable = await store.readDurableComposerDraft({
                ...scopeOwner,
                scopeKey: `chat:v3:${scopeKey}`,
              });
              return {
                local: Boolean(localDraft?.draft || localDraft?.queue?.length),
                durable: durable.status === "found" ? durable.draft.text : durable.status,
              };
            },
            { store: draftStore, key: replacement, scopeOwner: owner },
          ),
        )
        .toEqual({ local: false, durable: "not-found" });

      await page.evaluate(
        async ({ store, key, scopeOwner }) => {
          const storageKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(scopeOwner.gatewayOwner)}`;
          const local = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as {
            sessions: Record<string, { draft?: string; draftRevision?: number }>;
          };
          const scopeKey = `${key}\u0000agent:main`;
          const durable = await store.readDurableComposerDraft({
            ...scopeOwner,
            scopeKey: `chat:v3:${scopeKey}`,
          });
          if (durable.status !== "not-found") {
            throw new Error("confirmed deletion did not leave a durable retirement fence");
          }
          const revision = Date.now();
          local.sessions[scopeKey] = {
            draft: "post-confirm local replacement",
            draftRevision: revision,
          };
          sessionStorage.setItem(storageKey, JSON.stringify(local));
          const written = await store.writeDurableComposerDraft(
            { ...scopeOwner, scopeKey: `chat:v3:${scopeKey}` },
            { revision, text: "post-confirm durable replacement", attachments: [] },
            {
              expectedRevision: durable.revision ?? 0,
              expectedWriteId: durable.writeId,
              writeId: "post-confirm-replacement",
            },
          );
          if (written.status !== "persisted") {
            throw new Error(`post-confirm replacement failed: ${written.status}`);
          }
        },
        { store: draftStore, key: replacement, scopeOwner: owner },
      );

      await expect
        .poll(() =>
          page.evaluate(
            async ({ store, sessionKeys, scopeOwner }) => {
              const local = JSON.parse(
                sessionStorage.getItem(
                  `openclaw.control.chatComposer.v4:${encodeURIComponent(scopeOwner.gatewayOwner)}`,
                ) ?? "{}",
              ) as { sessions?: Record<string, { draft?: string; queue?: unknown[] }> };
              return Object.fromEntries(
                await Promise.all(
                  sessionKeys.map(async (key) => {
                    const scopeKey = `${key}\u0000agent:main`;
                    const localDraft = local.sessions?.[scopeKey];
                    const durable = await store.readDurableComposerDraft({
                      ...scopeOwner,
                      scopeKey: `chat:v3:${scopeKey}`,
                    });
                    return [
                      key,
                      {
                        local: Boolean(localDraft?.draft || localDraft?.queue?.length),
                        durable: durable.status === "found" ? durable.draft.text : durable.status,
                      },
                    ];
                  }),
                ),
              );
            },
            { store: draftStore, sessionKeys: keys, scopeOwner: owner },
          ),
        )
        .toEqual({
          [retired[0]!]: { local: false, durable: "not-found" },
          [retired[1]!]: { local: false, durable: "not-found" },
          [retired[2]!]: { local: false, durable: "not-found" },
          [retired[3]!]: { local: false, durable: "not-found" },
          [sibling]: { local: true, durable: `durable ${sibling}` },
          [noOp]: { local: true, durable: `durable ${noOp}` },
          [replacement]: {
            local: true,
            durable: "post-confirm durable replacement",
          },
        });
    } finally {
      await context.close();
    }
  });

  it("keeps bulk deletion fenced to the session selected before confirmation", async () => {
    const key = "agent:main:confirmed";
    const original = sessionRow(key, "Original session", 1, {
      sessionId: "confirmed-session",
    });
    const replacement = sessionRow(key, "Replacement session", 2, {
      sessionId: "replacement-session",
    });
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.delete": { ok: true, deleted: true },
        "sessions.list": sessionsListResponse([original]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      const replacementLabel = page.locator(".sessions-table").getByText("Replacement session", {
        exact: true,
      });
      await page.getByRole("checkbox", { name: `Select session: ${key}` }).check();
      await page.locator(".data-table-bulk-bar").getByRole("button", { name: "Delete" }).click();
      const confirmModal = await waitForConfirmModal(page);
      await captureUiProof(page, "sessions-bulk-delete-original-confirm.png");

      await gateway.setMethodResponse("sessions.list", sessionsListResponse([replacement]));
      await gateway.emitGatewayEvent("sessions.changed", {
        ...replacement,
        reason: "update",
        sessionKey: key,
      });
      await replacementLabel.waitFor();
      await gateway.deferNext("sessions.delete");
      await confirmModal.getByRole("button", { name: "Delete", exact: true }).click();

      const request = await gateway.waitForRequest("sessions.delete");
      expect(request).toMatchObject({
        params: { expectedSessionId: "confirmed-session", key },
      });
      await gateway.rejectDeferred("sessions.delete", {
        code: "INVALID_REQUEST",
        message: `Session ${key} changed before deletion. Retry.`,
      });
      await expect
        .poll(() => page.locator(".sessions-error[role=alert]").textContent())
        .toContain("changed before deletion. Retry.");
      await replacementLabel.waitFor();
      await captureUiProof(page, "sessions-bulk-delete-replacement-protected.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(
          path.join(uiProofArtifactDir, "sessions-bulk-delete-replaced.webm"),
        );
      }
    }
  });

  it("rejects deleting a same-key replacement after the in-app confirm", async () => {
    const key = "agent:main:research";
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    // Playwright auto-dismisses native dialogs, which is exactly how a
    // bridge-less WebView behaves. Deleting must not depend on one.
    const nativeDialogs: string[] = [];
    page.on("dialog", (dialog) => {
      nativeDialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.delete": { ok: true, deleted: true },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(key, "Research notes", Date.parse("2026-07-01T15:00:00.000Z")),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Delete…" })
        .click();

      const confirmModal = await waitForConfirmModal(page);
      await captureUiProof(page, "sidebar-delete-session-confirm.png");
      await gateway.deferNext("sessions.delete");
      await confirmModal.getByRole("button", { name: "Delete", exact: true }).evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error("expected delete confirmation button");
        }
        button.click();
        button.click();
      });

      const request = await gateway.waitForRequest("sessions.delete");
      expect(request).toMatchObject({
        params: { deleteTranscript: true, expectedSessionId: `session:${key}`, key },
      });
      await expectRequestCountStable(gateway, "sessions.delete", 1);
      await gateway.rejectDeferred("sessions.delete", {
        code: "INVALID_REQUEST",
        message: `Session ${key} changed before deletion. Retry.`,
      });
      const visibleError = page.locator("[data-sidebar-session-error]");
      await expect
        .poll(() => visibleError.textContent())
        .toContain("changed before deletion. Retry.");
      expect(await visibleError.textContent()).not.toContain("GatewayRequestError");
      await row.waitFor({ state: "visible" });
      await captureUiProof(page, "sidebar-delete-session-replaced-error.png");
      expect(nativeDialogs).toEqual([]);
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(
          path.join(uiProofArtifactDir, "sidebar-delete-session-replaced.webm"),
        );
      }
    }
  });

  it("shows the preserved worktree reason before offering forced removal", async () => {
    const key = "agent:main:snapshot-failed";
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, "worktrees.remove"],
      methodResponses: {
        "sessions.delete": {
          ok: true,
          key,
          deleted: true,
          archived: [],
          worktreePreserved: {
            id: "wt-snapshot-failed",
            branch: "openclaw/snapshot-failed",
            path: "/worktrees/snapshot-failed",
            reason: "snapshot-failed",
          },
        },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(key, "Snapshot failed", Date.parse("2026-07-01T15:00:00.000Z")),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Delete…" })
        .click();

      const deleteModal = await waitForConfirmModal(page);
      await deleteModal.getByRole("button", { name: "Delete", exact: true }).click();
      await gateway.waitForRequest("sessions.delete");

      const worktreeModal = await waitForConfirmModal(page);
      await expect
        .poll(() => worktreeModal.textContent())
        .toContain("OpenClaw could not create a safety snapshot");
      await expect.poll(() => worktreeModal.textContent()).toContain("Remove?");
      await captureUiProof(page, "sidebar-delete-preserved-snapshot-failed.png");
      await worktreeModal.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests("worktrees.remove")).toHaveLength(0);
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(
          path.join(uiProofArtifactDir, "sidebar-delete-preserved-snapshot-failed.webm"),
        );
      }
    }
  });
});
