import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI composer recovery fences",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it.each(["incognito", "toggle-incognito", "replacement", "reconnect"])(
    "fences recovery confirmation after %s at the rendered owner boundary",
    async (change) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}settings`);
        await page.evaluate('import("/src/pages/chat/chat-outbox-recovery.ts")');
        const hostHandle = await page.evaluateHandle((initialIncognito) => {
          const host = {
            settings: { gatewayUrl: "ws://recovery-fence.test" },
            connected: true,
            client: { recoveryScopeReady: true, recoveryScope: "owner" },
            agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
            sessionKey: "agent:main:main",
            currentSessionId: "incarnation-a",
            connectionEpoch: 1,
            selectedChatSessionIncognito: initialIncognito,
            chatMessage: "",
            chatGoalDraftMode: undefined,
            chatAttachments: [],
            chatQueue: [],
          };
          sessionStorage.setItem(
            `openclaw.control.chatComposer.v2:${encodeURIComponent(host.settings.gatewayUrl)}`,
            JSON.stringify({
              version: 2,
              gatewayOwner: host.settings.gatewayUrl,
              sessions: {
                "global\u0000agent:main": {
                  draft: "Retained confirmation draft",
                  draftRevision: 1,
                  updatedAt: 1,
                },
              },
            }),
          );
          const component = Object.assign(document.createElement("openclaw-chat-outbox-recovery"), {
            host,
            identity: "unchanged-route-and-owner",
          });
          component.style.cssText =
            "position: fixed; inset: 24px; z-index: 100; background: white; color: black";
          document.body.append(component);
          return host;
        }, change === "incognito");
        const notice = page.locator("openclaw-chat-outbox-recovery");
        await notice.locator("summary").click();
        const restore = notice.getByRole("button", { name: "Restore here for review" });
        if (change === "incognito") {
          expect(await restore.isDisabled()).toBe(true);
        } else {
          await restore.click();
          const dialog = page.locator("openclaw-modal-dialog");
          await dialog.getByText("agent:main:main (main)", { exact: true }).waitFor();
          await page.evaluate(
            ({ host: currentHost, change: retirement }) => {
              if (retirement === "replacement") {
                currentHost.currentSessionId = "incarnation-b";
              } else if (retirement === "reconnect") {
                currentHost.connectionEpoch++;
              } else {
                currentHost.selectedChatSessionIncognito = true;
              }
            },
            { host: hostHandle, change },
          );
          await dialog.getByRole("button", { name: "Restore here for review" }).click();
          await dialog.waitFor({ state: "detached" });
          await expect
            .poll(
              async () =>
                (await restore.count()) === 0 ||
                change === "toggle-incognito" ||
                !(await restore.isDisabled()),
            )
            .toBe(true);
        }
        const records = await page.evaluate(() => {
          const raw = sessionStorage.getItem(
            `openclaw.control.chatComposer.v4:${encodeURIComponent("ws://recovery-fence.test")}`,
          );
          if (!raw) {
            throw new Error("Missing migrated recovery state");
          }
          return JSON.parse(raw) as {
            sessions: Record<string, unknown>;
            recovery: Record<string, unknown>;
          };
        });
        expect(records.sessions).toEqual({});
        expect(Object.keys(records.recovery)).toHaveLength(1);
        await notice.getByText("Retained confirmation draft", { exact: true }).waitFor();
      });
    },
  );

  it("migrates an identifiable draft by its captured key after the configured main key changes", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}settings`);
      const handle = await page.evaluateHandle<
        typeof import("../lib/chat/composer-draft-store.runtime.ts")
      >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
      const result = await page.evaluate(async (store) => {
        const owner = { gatewayOwner: "main-key-change", recoveryScope: "credential" };
        const legacy = { ...owner, scopeKey: "agent:main:main\u0000agent:main" };
        await store.writeDurableComposerDraft(
          legacy,
          {
            revision: 10,
            text: "original main draft",
            attachments: [],
          },
          { expectedRevision: 0, writeId: "original" },
        );
        // Migration has no current-defaults input: captured keys own the transfer.
        await store.prepareDurableComposerRecovery(owner);
        return {
          original: await store.readDurableComposerDraft({
            ...legacy,
            scopeKey: `chat:v3:${legacy.scopeKey}`,
          }),
          reinterpreted: await store.readDurableComposerDraft({
            ...owner,
            scopeKey: "chat:v3:agent:main:workspace\u0000agent:main",
          }),
        };
      }, handle);
      expect(result.original).toMatchObject({
        status: "found",
        draft: { text: "original main draft", revision: 10, writeId: "original" },
      });
      expect(result.reinterpreted.status).toBe("not-found");
    });
  });

  it("honors newer exact-target draft tombstones without retiring ambiguous legacy data", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}settings`);
      const handle = await page.evaluateHandle<
        typeof import("../lib/chat/composer-draft-store.runtime.ts")
      >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
      const result = await page.evaluate(async (store) => {
        const owner = { gatewayOwner: "tombstone-owner", recoveryScope: "credential" };
        const sources = ["agent:main:notes", "agent:main:newer", "global"].map((key) =>
          Object.assign({}, owner, {
            scopeKey: `${key}\u0000agent:main`,
          }),
        );
        for (const [index, source] of sources.entries()) {
          await store.writeDurableComposerDraft(
            source,
            {
              revision: 10,
              text: `legacy ${index}`,
              attachments: [],
            },
            { expectedRevision: 0, writeId: `legacy-${index}` },
          );
          const destination = { ...source, scopeKey: `chat:v3:${source.scopeKey}` };
          await store.writeDurableComposerDraft(
            destination,
            {
              revision: index === 1 ? 5 : 20,
              text: "",
              attachments: [],
            },
            { expectedRevision: 0, writeId: `clear-${index}` },
          );
        }
        const recovery = await store.prepareDurableComposerRecovery(owner);
        return {
          entries: recovery.status === "ready" ? recovery.entries.map((entry) => entry.text) : null,
          sources: await Promise.all(sources.map((scope) => store.readDurableComposerDraft(scope))),
        };
      }, handle);
      expect(result.entries).toEqual(["legacy 1", "legacy 2"]);
      expect(result.sources.map((row) => row.status)).toEqual(["not-found", "found", "found"]);
    });
  });
});
