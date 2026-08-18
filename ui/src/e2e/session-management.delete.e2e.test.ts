import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
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
      const owner = await page.evaluate(
        async ({ store, sessionKeys }) => {
          const client = (document.querySelector("openclaw-app") as DraftDeletionTestApp).runtime
            ?.context.gateway.snapshot.client;
          if (!client?.recoveryScope) {
            throw new Error("Gateway recovery scope unavailable");
          }
          const gatewayOwner = client.gatewayUrl.trim() || "default";
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
            `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayOwner)}`,
            JSON.stringify({ version: 2, gatewayOwner, sessions }),
          );
          const recoveryScope = client.recoveryScope;
          await Promise.all(
            sessionKeys.map((key, index) =>
              store.writeDurableComposerDraft(
                { gatewayOwner, recoveryScope, scopeKey: `${key}\u0000agent:main` },
                {
                  revision: index + 1,
                  text: `durable ${key}`,
                  attachments: [{ blob: new Blob([key]), mimeType: "text/plain" }],
                },
                { expectedRevision: 0, writeId: `seed-${index}` },
              ),
            ),
          );
          return { gatewayOwner, recoveryScope };
        },
        { store: draftStore, sessionKeys: keys },
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
        agentId: "main",
        reason: "delete",
      });

      await gateway.setMethodResponse("sessions.delete", { ok: true, deleted: true });
      await gateway.deferNext("sessions.delete", { key: replacement });
      const requestsBeforeReplacement = (await gateway.getRequests("sessions.delete")).length;
      const replacementDelete = deleteFromRuntime([replacement]);
      await gateway.waitForRequest("sessions.delete", { after: requestsBeforeReplacement });
      await page.evaluate(
        async ({ store, key, scopeOwner }) => {
          const storageKey = `openclaw.control.chatComposer.v2:${encodeURIComponent(scopeOwner.gatewayOwner)}`;
          const local = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as {
            sessions: Record<string, unknown>;
          };
          const revision = Date.now() + 10_000;
          local.sessions[`${key}\u0000agent:main`] = {
            draft: "new local replacement",
            draftRevision: revision,
            updatedAt: Date.now(),
          };
          sessionStorage.setItem(storageKey, JSON.stringify(local));
          await store.writeDurableComposerDraft(
            { ...scopeOwner, scopeKey: `${key}\u0000agent:main` },
            { revision, text: "new durable replacement", attachments: [] },
            { expectedRevision: 7, writeId: "new-replacement" },
          );
        },
        { store: draftStore, key: replacement, scopeOwner: owner },
      );
      await gateway.resolveDeferred("sessions.delete", { ok: true, deleted: true });
      await expect(replacementDelete).resolves.toMatchObject({ deleted: true });

      await expect
        .poll(() =>
          page.evaluate(
            async ({ store, sessionKeys, scopeOwner }) => {
              const local = JSON.parse(
                sessionStorage.getItem(
                  `openclaw.control.chatComposer.v2:${encodeURIComponent(scopeOwner.gatewayOwner)}`,
                ) ?? "{}",
              ) as { sessions?: Record<string, { draft?: string; queue?: unknown[] }> };
              return Object.fromEntries(
                await Promise.all(
                  sessionKeys.map(async (key) => {
                    const scopeKey = `${key}\u0000agent:main`;
                    const localDraft = local.sessions?.[scopeKey];
                    const durable = await store.readDurableComposerDraft({
                      ...scopeOwner,
                      scopeKey,
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
            durable: "new durable replacement",
          },
        });
    } finally {
      await context.close();
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
});
