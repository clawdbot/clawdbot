import { expect, it } from "vitest";
import type { ChatQueueItem } from "../lib/chat/chat-types.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { expectRequestCountStable, requireRecord } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI composer recovery fences",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("commits an independent offline split-pane draft after submit, remove and reorder", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          historyMessages: [{ role: "assistant", content: "Split draft owner ready." }],
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        await waitForControlUiGatewayReady(page);
        await page.getByText("Split draft owner ready.", { exact: true }).waitFor();
        await page.locator(".agent-chat__composer-combobox textarea").fill("split seed");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const seed = await gateway.waitForRequest("chat.send");
        await gateway.emitChatFinal({
          runId: String(requireRecord(seed.params).idempotencyKey),
          text: "Split seed completed.",
        });
        await page
          .locator(".chat-bubble")
          .getByText("Split seed completed.", { exact: true })
          .waitFor();
        await page.getByRole("button", { name: "Open split view", exact: true }).click();
        const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
        await expect.poll(() => panes.count()).toBe(2);
        const left = panes.nth(0);
        const right = panes.nth(1);
        const composer = left.locator(".agent-chat__composer-combobox textarea");
        const attachmentBytes = Buffer.from("independent queued attachment bytes");
        await gateway.setOnline(false);
        await waitForControlUiGatewayReconnecting(page);
        const messages = ["split tail", "split attachment", "split remove"];
        for (const [index, message] of messages.entries()) {
          await composer.fill(message);
          if (index === 1) {
            await left.locator(".agent-chat__file-input").setInputFiles({
              name: "split.txt",
              mimeType: "text/plain",
              buffer: attachmentBytes,
            });
            await expect.poll(() => left.locator(".chat-attachment-thumb").count()).toBe(1);
          }
          await left.getByRole("button", { name: "Send message", exact: true }).click();
          await expect.poll(() => composer.inputValue()).toBe("");
          await expect.poll(() => right.locator(".chat-queue__item").count()).toBe(index + 1);
        }
        await right
          .locator(".chat-queue__item", { hasText: "split remove" })
          .locator(".chat-queue__remove")
          .click();
        await expect.poll(() => left.locator(".chat-queue__item").count()).toBe(2);
        await right
          .locator(".chat-queue__item", { hasText: "split attachment" })
          .locator(".chat-queue__grip")
          .focus();
        await page.keyboard.press("ArrowUp");
        for (const pane of [left, right]) {
          await expect
            .poll(() => pane.locator(".chat-queue__item .chat-queue__text").allTextContents())
            .toEqual(["split attachment", "split tail"]);
        }
        const draft = "independent split composer draft";
        await composer.fill(draft);
        await waitForCommittedComposerDraft(
          page,
          "chat:v3:agent:main:main\u0000agent:main",
          draft,
          0,
        );
        expect(await composer.inputValue()).toBe(draft);
        await expectRequestCountStable(gateway, "chat.send", 1);
        const original = await page.evaluate(() =>
          Object.keys(sessionStorage)
            .filter((key) => key.startsWith("openclaw.control.chatComposer.v4:"))
            .flatMap((key) => {
              const store = JSON.parse(sessionStorage.getItem(key)!) as {
                sessions: Record<string, { queue?: ChatQueueItem[] }>;
              };
              return Object.values(store.sessions).flatMap((session) => session.queue ?? []);
            }),
        );
        expect(original).toHaveLength(2);
        for (const item of original) {
          expect(item.sendRunId).toEqual(expect.any(String));
        }
        const attachment = original.find((item) => item.text === "split attachment")!;
        const tail = original.find((item) => item.text === "split tail")!;
        expect(attachment.attachmentPayload).toBeDefined();
        const edited = left.locator(`[data-chat-queue-item="${attachment.id}"]`);
        await edited.dblclick();
        await edited.locator(".chat-queue__edit-input").fill("discard this replacement");
        await gateway.setOnline(true);
        await waitForControlUiGatewayReady(page);
        await expectRequestCountStable(gateway, "chat.send", 1);
        await right
          .locator(".chat-queue__item", { hasText: "split attachment" })
          .locator(".chat-queue__remove")
          .click();
        await right.getByText(/Finish or cancel that edit before removing it/).waitFor();
        expect(await left.locator(".chat-queue__item").count()).toBe(2);
        expect(await edited.locator(".chat-queue__edit-input").inputValue()).toBe(
          "discard this replacement",
        );
        await edited.locator(".chat-queue__edit-cancel").click();
        await expect.poll(() => left.locator(".chat-queue__edit-input").count()).toBe(0);
        // Cancel releases the local hold; no peer mutation or retry should be needed to drain.
        await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(2);
        const first = (await gateway.getRequests("chat.send"))[1]!;
        expect(first.params).toMatchObject({
          message: attachment.text,
          sessionKey: "agent:main:main",
          idempotencyKey: attachment.sendRunId,
          attachments: [
            {
              fileName: "split.txt",
              mimeType: "text/plain",
              content: attachmentBytes.toString("base64"),
            },
          ],
        });
        await expectRequestCountStable(gateway, "chat.send", 2);
        await gateway.emitChatFinal({
          runId: String(requireRecord(first.params).idempotencyKey),
          text: "Original attachment completed.",
        });
        await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(3);
        const second = (await gateway.getRequests("chat.send"))[2]!;
        expect(second.params).toMatchObject({
          message: tail.text,
          sessionKey: "agent:main:main",
          idempotencyKey: tail.sendRunId,
        });
        await gateway.emitChatFinal({
          runId: String(requireRecord(second.params).idempotencyKey),
          text: "Original tail completed.",
        });
        for (const pane of [left, right]) {
          await expect.poll(() => pane.locator(".chat-queue__item").count()).toBe(0);
        }
        await expectRequestCountStable(gateway, "chat.send", 3);
        expect(await composer.inputValue()).toBe(draft);
        await waitForCommittedComposerDraft(
          page,
          "chat:v3:agent:main:main\u0000agent:main",
          draft,
          0,
        );
      },
    );
  });

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
