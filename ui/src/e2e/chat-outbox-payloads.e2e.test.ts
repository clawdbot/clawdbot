import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import type { ChatQueueItem } from "../lib/chat/chat-types.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  readOutboxPayloadAttachments,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const proofDir = path.resolve(".artifacts/control-ui-e2e/outbox-capacity/after");
const file = {
  name: "mock-original.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("Exact synthetic outbox bytes\n".repeat(1000)),
};
const history = [{ role: "assistant", content: "Mock Gateway: payload lifecycle proof." }];
const paneFor = (page: Page) => page.locator('openclaw-chat-pane[aria-hidden="false"]');
const composerFor = (page: Page) =>
  paneFor(page).locator(".agent-chat__composer-combobox textarea");

async function readQueue(page: Page): Promise<ChatQueueItem[]> {
  return page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith("openclaw.control.chatComposer.v4:"))
      .flatMap((key) => {
        const store = JSON.parse(sessionStorage.getItem(key)!) as {
          sessions: Record<string, { queue?: ChatQueueItem[] }>;
        };
        return Object.values(store.sessions).flatMap((session) => session.queue ?? []);
      }),
  );
}

async function payloadCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("openclaw-control-ui");
      request.onsuccess = () => resolve(request.result);
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("IndexedDB request failed")),
      );
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = database
          .transaction("outboxPayloads")
          .objectStore("outboxPayloads")
          .count();
        request.onsuccess = () => resolve(request.result);
        request.addEventListener("error", () =>
          reject(request.error ?? new Error("IndexedDB request failed")),
        );
      });
    } finally {
      database.close();
    }
  });
}

async function readPayloadBytes(page: Page, key: string): Promise<string[] | null> {
  return (
    (await readOutboxPayloadAttachments(page, key))?.map((attachment) => attachment.base64) ?? null
  );
}

async function stage(page: Page, message: string) {
  await composerFor(page).fill(message);
  await paneFor(page).locator(".agent-chat__file-input").setInputFiles(file);
  await expect.poll(() => paneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
}

suite.define(() => {
  it.each(["agent:main:topic", "global"])(
    "preserves landed v3 %s Blobs through migration, reload, explicit retry and retirement",
    async (legacySessionKey) => {
      await suite.withPage(
        { serviceWorkers: "block", locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const destination = legacySessionKey === "global" ? "agent:main:main" : legacySessionKey;
          const gateway = await installMockGateway(page, {
            sessionKey: destination,
            sessions: [
              {
                key: destination,
                kind: "direct",
                updatedAt: 1,
                hasActiveRun: false,
                activeRunIds: [],
              },
            ],
            historyMessages: history,
            deferredMethods: ["chat.send"],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, destination));
          await waitForControlUiGatewayReady(page);
          await paneFor(page)
            .getByText("Mock Gateway: payload lifecycle proof.", { exact: true })
            .waitFor();
          await gateway.setOnline(false);
          await waitForControlUiGatewayReconnecting(page);
          await stage(page, "Mock Gateway: retained v3 Blob submission");
          await paneFor(page).getByRole("button", { name: "Send message", exact: true }).click();
          await expect.poll(async () => (await readQueue(page)).length).toBe(1);
          const original = (await readQueue(page))[0]!;
          const reference = original.attachmentPayload;
          assert(
            reference,
            "Admission must own the complete Blob before seeding the legacy envelope",
          );
          await page.route("**/outbox-legacy-seed", (route) =>
            route.fulfill({ contentType: "text/html", body: "Synthetic v3 metadata seed" }),
          );
          // Leave the app before replacing its metadata; no old writer races the legacy producer.
          await page.goto(`${suite.server.baseUrl}outbox-legacy-seed`);
          const legacyKey = await page.evaluate(
            ({ item, sessionKey }) => {
              const currentKey = Object.keys(sessionStorage).find((key) =>
                key.startsWith("openclaw.control.chatComposer.v4:"),
              );
              if (!currentKey) {
                throw new Error("Missing admitted metadata");
              }
              const current = JSON.parse(sessionStorage.getItem(currentKey)!) as {
                gatewayOwner: string;
              };
              const key = `openclaw.control.chatComposer.v3:${encodeURIComponent(current.gatewayOwner)}`;
              sessionStorage.setItem(
                key,
                JSON.stringify({
                  version: 3,
                  gatewayOwner: current.gatewayOwner,
                  sessions: {
                    [`${sessionKey}\u0000agent:main`]: {
                      updatedAt: 10,
                      draftRevision: 42,
                      queue: [
                        {
                          ...item,
                          sessionKey,
                          agentId: "main",
                          sendAttempts: 1,
                          sendState: "unconfirmed",
                        },
                      ],
                    },
                  },
                }),
              );
              sessionStorage.removeItem(currentKey);
              return key;
            },
            { item: original, sessionKey: legacySessionKey },
          );
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, destination));
          await gateway.setOnline(true);
          await waitForControlUiGatewayReady(page);
          await expect
            .poll(() => page.evaluate((key) => sessionStorage.getItem(key), legacyKey))
            .toBeNull();
          expect(await readPayloadBytes(page, reference.key)).toEqual([
            file.buffer.toString("base64"),
          ]);
          if (legacySessionKey === "global") {
            expect(await readQueue(page)).toEqual([]);
            const notice = paneFor(page).locator(".chat-outbox-recovery");
            await notice.locator("summary").click();
            await notice
              .getByText("Mock Gateway: retained v3 Blob submission", { exact: true })
              .waitFor();
            await expectRequestCountStable(gateway, "chat.send", 0);
            await notice.getByRole("button", { name: "Restore here for review" }).click();
            const dialog = page.locator("openclaw-modal-dialog");
            await dialog.getByText(`${destination} (main)`, { exact: true }).waitFor();
            await dialog.getByRole("button", { name: "Restore here for review" }).click();
          }
          await paneFor(page).getByText("Delivery unconfirmed", { exact: true }).waitFor();
          await page.reload();
          await paneFor(page).getByText("Delivery unconfirmed", { exact: true }).waitFor();
          expect((await readQueue(page))[0]).toMatchObject({
            id: original.id,
            sessionKey: destination,
            agentId: "main",
            sendRunId: original.sendRunId,
            sendAttempts: 1,
            attachmentPayload: reference,
          });
          expect(await readPayloadBytes(page, reference.key)).toEqual([
            file.buffer.toString("base64"),
          ]);
          await expectRequestCountStable(gateway, "chat.send", 0);
          await mkdir(proofDir, { recursive: true });
          await page.screenshot({
            path: path.join(
              proofDir,
              `v3-${legacySessionKey === "global" ? "recovered" : "named"}-paused.png`,
            ),
            fullPage: true,
            animations: "disabled",
          });
          await paneFor(page)
            .locator(".chat-group.user")
            .getByRole("button", { name: /Retry/i })
            .click();
          const sent = await gateway.waitForRequest("chat.send");
          expect(sent.params).toMatchObject({
            sessionKey: destination,
            idempotencyKey: original.sendRunId,
            attachments: [
              {
                type: "file",
                mimeType: file.mimeType,
                fileName: file.name,
                content: file.buffer.toString("base64"),
              },
            ],
          });
          expect(requireRecord(sent.params).agentId).toBeUndefined();
          expect(await readPayloadBytes(page, reference.key)).toEqual([
            file.buffer.toString("base64"),
          ]);
          await gateway.resolveDeferred("chat.send", { runId: original.sendRunId, status: "ok" });
          await expect.poll(async () => (await readQueue(page)).length).toBe(0);
          await expect.poll(() => payloadCount(page)).toBe(0);
          await expectRequestCountStable(gateway, "chat.send", 1);
        },
      );
    },
  );

  it("reloads an offline Blob queue with exact bytes and idempotency, and never replays a lost ACK", async () => {
    await suite.withPage(
      {
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
        recordVideo: { dir: path.join(proofDir, "lifecycle-video") },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: history,
          sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
          deferredMethods: ["chat.send"],
        });
        await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
        await paneFor(page)
          .getByText("Mock Gateway: payload lifecycle proof.", { exact: true })
          .waitFor();
        await gateway.setOnline(false);
        await waitForControlUiGatewayReconnecting(page);
        await stage(page, "Mock Gateway: offline binary submission");
        await paneFor(page).getByRole("button", { name: "Send message", exact: true }).click();
        await expect.poll(async () => (await readQueue(page)).length).toBe(1);
        const queued = (await readQueue(page))[0]!;
        expect(queued.attachmentPayload).toBeDefined();
        expect(queued.sendAttempts).toBe(0);
        await expect.poll(() => composerFor(page).inputValue()).toBe("");
        await expectRequestCountStable(gateway, "chat.send", 0);
        await page.reload();
        await expect.poll(async () => (await readQueue(page))[0]?.sendRunId).toBe(queued.sendRunId);
        await gateway.setOnline(true);
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toEqual(
          expect.objectContaining({
            idempotencyKey: queued.sendRunId,
            attachments: [
              {
                type: "file",
                mimeType: file.mimeType,
                fileName: file.name,
                content: file.buffer.toString("base64"),
              },
            ],
          }),
        );
        await expect.poll(() => payloadCount(page)).toBe(1);
        // Reload destroys the pending ACK. The restored attempted row must require review.
        await page.reload();
        await paneFor(page).getByText("Delivery unconfirmed", { exact: true }).waitFor();
        await expectRequestCountStable(gateway, "chat.send", 0);
        expect((await readQueue(page))[0]?.sendRunId).toBe(queued.sendRunId);
        await page.screenshot({
          path: path.join(proofDir, "reload-unconfirmed.png"),
          fullPage: true,
          animations: "disabled",
        });
      },
    );
  });

  it("queues complete attachment bytes while the browser and Gateway are offline", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ context, page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: history,
        sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
        deferredMethods: ["chat.send"],
      });
      await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await paneFor(page)
        .getByText("Mock Gateway: payload lifecycle proof.", { exact: true })
        .waitFor();
      await waitForControlUiGatewayReady(page);
      const message = "Mock Gateway: retain complete input while offline";
      await stage(page, message);
      await context.setOffline(true);
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await paneFor(page).getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(async () => (await readQueue(page)).length).toBe(1);
      const queued = (await readQueue(page))[0]!;
      expect(queued.attachmentPayload).toBeDefined();
      expect(queued.sendAttempts).toBe(0);
      await expect.poll(() => payloadCount(page)).toBe(1);
      await expect.poll(() => composerFor(page).inputValue()).toBe("");
      await expectRequestCountStable(gateway, "chat.send", 0);
      await context.setOffline(false);
      await gateway.setOnline(true);
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toEqual(
        expect.objectContaining({
          message,
          idempotencyKey: queued.sendRunId,
          attachments: [
            {
              type: "file",
              mimeType: file.mimeType,
              fileName: file.name,
              content: file.buffer.toString("base64"),
            },
          ],
        }),
      );
      await expectRequestCountStable(gateway, "chat.send", 1);
    });
  });

  it("retains the full composer without sending when a real IndexedDB upgrade is blocked", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ context, page }) => {
      const blocker = await context.newPage();
      await blocker.route("**/outbox-blocker", (route) =>
        route.fulfill({ contentType: "text/html", body: "Mock storage blocker" }),
      );
      await blocker.goto(`${suite.server.baseUrl}outbox-blocker`);
      const connection = await blocker.evaluateHandle(
        async () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("openclaw-control-ui", 1);
            request.onupgradeneeded = () =>
              request.result
                .createObjectStore("composerDrafts", { keyPath: "key" })
                .createIndex("ownerKey", "ownerKey");
            request.onsuccess = () => resolve(request.result);
            request.addEventListener("error", () =>
              reject(request.error ?? new Error("IndexedDB request failed")),
            );
          }),
      );
      const gateway = await installMockGateway(page, {
        historyMessages: history,
        sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
      });
      await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await paneFor(page)
        .getByText("Mock Gateway: payload lifecycle proof.", { exact: true })
        .waitFor();
      await stage(page, "Mock Gateway: retain on blocked storage");
      await paneFor(page).getByRole("button", { name: "Send message", exact: true }).click();
      await paneFor(page)
        .getByRole("alert")
        .filter({ hasText: "Browser attachment storage is unavailable" })
        .waitFor();
      expect(await composerFor(page).inputValue()).toBe("Mock Gateway: retain on blocked storage");
      expect(await paneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
      await expectRequestCountStable(gateway, "chat.send", 0);
      expect(await readQueue(page)).toEqual([]);
      await connection.evaluate((database) => database.close());
      await connection.dispose();
    });
  });

  it("isolates independent tabs and gives a duplicate its own bytes without replaying the logical submission", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ context, page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: history,
        sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
      });
      await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await paneFor(page)
        .getByText("Mock Gateway: payload lifecycle proof.", { exact: true })
        .waitFor();
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await stage(page, "Mock Gateway: one logical submission");
      await paneFor(page).getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(async () => (await readQueue(page)).length).toBe(1);
      const original = (await readQueue(page))[0]!;
      const independent = await context.newPage();
      const independentGateway = await installMockGateway(independent, {
        historyMessages: history,
        sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
      });
      await independent.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await paneFor(independent)
        .getByText("Mock Gateway: payload lifecycle proof.", { exact: true })
        .waitFor();
      expect(await readQueue(independent)).toEqual([]);
      await expectRequestCountStable(independentGateway, "chat.send", 0);
      const popup = context.waitForEvent("page");
      await page.evaluate(() => window.open("about:blank"));
      const duplicate = await popup;
      const duplicateGateway = await installMockGateway(duplicate, {
        historyMessages: history,
        sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
      });
      await duplicate.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await duplicateGateway.setOnline(true);
      await expect.poll(async () => (await readQueue(duplicate))[0]?.sendState).toBe("unconfirmed");
      await expectRequestCountStable(duplicateGateway, "chat.send", 0);
      const copied = (await readQueue(duplicate))[0]!;
      expect(copied.id).toBe(original.id);
      expect(copied.sendRunId).toBe(original.sendRunId);
      expect(copied.attachmentPayload?.key).not.toBe(original.attachmentPayload?.key);
      await expect.poll(() => payloadCount(page)).toBe(2);
      const latePopup = context.waitForEvent("page");
      await page.evaluate(() => window.open("about:blank"));
      const lateDuplicate = await latePopup;
      // Retiring the source releases only its own bundle, preserving the live copy.
      await paneFor(page)
        .getByRole("button", { name: /Remove queued message/ })
        .click();
      await expect.poll(() => payloadCount(page)).toBe(1);
      expect((await readQueue(duplicate))[0]?.attachmentPayload?.key).toBe(
        copied.attachmentPayload?.key,
      );
      const lateGateway = await installMockGateway(lateDuplicate, {
        historyMessages: history,
        sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
      });
      await lateDuplicate.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await lateGateway.setOnline(true);
      await expect
        .poll(async () => (await readQueue(lateDuplicate))[0]?.attachmentStorageError)
        .toBe("missing");
      await expectRequestCountStable(lateGateway, "chat.send", 0);
      expect((await readQueue(lateDuplicate))[0]?.sendRunId).toBe(original.sendRunId);
    });
  });
  it("keeps source Blob bytes when a duplicate removes its row before lock-confirmed adoption", async () => {
    await suite.withPage(
      { serviceWorkers: "block", locale: "en-US", viewport: { width: 1280, height: 900 } },
      async ({ context, page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: history,
          sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
          deferredMethods: ["chat.send"],
        });
        await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
        await paneFor(page)
          .getByText("Mock Gateway: payload lifecycle proof.", { exact: true })
          .waitFor();
        await gateway.setOnline(false);
        await waitForControlUiGatewayReconnecting(page);
        const message = "Mock Gateway: source keeps its pre-adoption bytes";
        await stage(page, message);
        await paneFor(page).getByRole("button", { name: "Send message", exact: true }).click();
        await expect.poll(async () => (await readQueue(page)).length).toBe(1);
        const original = (await readQueue(page))[0];
        assert(
          original?.attachmentPayload && original.sendRunId,
          "Expected a durable source submission",
        );
        const reference = original.attachmentPayload;
        const runId = original.sendRunId;
        const sourceLockName = `openclaw-outbox:${reference.tabId}`;
        const sourceOwnsLock = () =>
          page.evaluate(
            async (name) =>
              (await navigator.locks.query()).held?.some((lock) => lock.name === name) ?? false,
            sourceLockName,
          );
        expect(await sourceOwnsLock()).toBe(true);
        expect(await readPayloadBytes(page, reference.key)).toEqual([
          file.buffer.toString("base64"),
        ]);
        await expectRequestCountStable(gateway, "chat.send", 0);

        const popup = context.waitForEvent("page");
        await page.evaluate(() => window.open("about:blank"));
        const duplicate = await popup;
        const releaseEvent = "openclaw-test-release-outbox-claim";
        await duplicate.addInitScript((eventName) => {
          const manager = navigator.locks;
          const nativeRequest = manager.request.bind(manager);
          let release!: () => void;
          let released = false;
          const latch = new Promise<void>((resolve) => {
            release = resolve;
          });
          window.addEventListener(
            eventName,
            () => {
              released = true;
              release();
            },
            { once: true },
          );
          function delay<T>(
            name: string,
            callback: LockGrantedCallback<T>,
          ): LockGrantedCallback<T | Promise<T>> {
            if (!name.startsWith("openclaw-outbox:")) {
              return callback;
            }
            return (lock) => {
              if (released) {
                return callback(lock);
              }
              document.documentElement.dataset.outboxClaimName = name;
              document.documentElement.dataset.outboxClaimGranted = String(lock !== null);
              document.documentElement.dataset.outboxClaimState = "blocked";
              // Native arbitration has already decided; delay only its callback delivery.
              return latch.then(() => callback(lock));
            };
          }
          function delayedRequest<T>(
            name: string,
            optionsOrCallback: LockOptions | LockGrantedCallback<T>,
            callback?: LockGrantedCallback<T>,
          ): Promise<Awaited<T>> {
            if (typeof optionsOrCallback === "function") {
              return nativeRequest(name, delay(name, optionsOrCallback));
            }
            if (!callback) {
              throw new TypeError("A Web Lock request requires a callback");
            }
            return nativeRequest(name, optionsOrCallback, delay(name, callback));
          }
          // Only this duplicate's LockManager changes; source ownership stays native.
          manager.request = delayedRequest;
        }, releaseEvent);
        const duplicateGateway = await installMockGateway(duplicate, {
          historyMessages: history,
          sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
        });
        try {
          await duplicate.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
          await duplicateGateway.setOnline(true);
          await waitForControlUiGatewayReady(duplicate);
          await duplicate.waitForFunction(
            () => document.documentElement.dataset.outboxClaimState === "blocked",
          );
          expect(
            await duplicate.evaluate(() => ({
              name: document.documentElement.dataset.outboxClaimName,
              granted: document.documentElement.dataset.outboxClaimGranted,
              marker: sessionStorage.getItem("openclaw.control.outboxTab.v1"),
            })),
          ).toEqual({ name: sourceLockName, granted: "false", marker: reference.tabId });
          expect((await readQueue(duplicate))[0]?.attachmentPayload).toEqual(reference);
          const row = paneFor(duplicate).locator(".chat-queue__item");
          await expect.poll(() => row.count()).toBe(1);
          await mkdir(proofDir, { recursive: true });
          await duplicate.screenshot({
            path: path.join(proofDir, "duplicate-before-claim-removal.png"),
            fullPage: true,
            animations: "disabled",
          });
          await row.getByRole("button", { name: "Remove queued message", exact: true }).click();
          await expect.poll(async () => (await readQueue(duplicate)).length).toBe(0);
          await expect.poll(() => row.count()).toBe(0);
          await duplicate.evaluate(
            (eventName) => window.dispatchEvent(new Event(eventName)),
            releaseEvent,
          );
          await expect
            .poll(() =>
              duplicate.evaluate(async (sourceTab) => {
                const tab = sessionStorage.getItem("openclaw.control.outboxTab.v1");
                return Boolean(
                  tab &&
                  tab !== sourceTab &&
                  (await navigator.locks.query()).held?.some(
                    (lock) => lock.name === `openclaw-outbox:${tab}`,
                  ),
                );
              }, reference.tabId),
            )
            .toBe(true);
          await expectRequestCountStable(duplicateGateway, "chat.send", 0);
          expect(await sourceOwnsLock()).toBe(true);
          expect((await readQueue(page))[0]).toMatchObject({
            id: original.id,
            sendRunId: runId,
            sendAttempts: 0,
            attachmentPayload: reference,
          });
          await page.bringToFront();
          await page.screenshot({
            path: path.join(proofDir, "source-after-duplicate-removal.png"),
            fullPage: true,
            animations: "disabled",
          });
          const sourceBytes = await readPayloadBytes(page, reference.key);
          assert(
            sourceBytes !== null,
            "Removing an unclaimed duplicate must not delete the source Blob",
          );
          expect(sourceBytes).toEqual([file.buffer.toString("base64")]);
          await gateway.setOnline(true);
          const sent = await gateway.waitForRequest("chat.send");
          expect(sent.params).toEqual(
            expect.objectContaining({
              message,
              idempotencyKey: runId,
              attachments: [
                {
                  type: "file",
                  mimeType: file.mimeType,
                  fileName: file.name,
                  content: file.buffer.toString("base64"),
                },
              ],
            }),
          );
          await expectRequestCountStable(gateway, "chat.send", 1);
          await expectRequestCountStable(duplicateGateway, "chat.send", 0);
        } finally {
          await duplicate
            .evaluate((eventName) => window.dispatchEvent(new Event(eventName)), releaseEvent)
            .catch(() => undefined);
        }
      },
    );
  });

  it("upgrades inline queues and the existing draft database, then edits and cancels without touching a newer composer", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await page.route("**/outbox-upgrade", (route) =>
        route.fulfill({ contentType: "text/html", body: "Mock upgrade seed" }),
      );
      await page.goto(`${suite.server.baseUrl}outbox-upgrade`);
      await page.evaluate(async (content) => {
        const gatewayOwner = `ws://${location.host}`;
        const scopeKey = "agent:main:main\u0000agent:main";
        sessionStorage.setItem(
          `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayOwner)}`,
          JSON.stringify({
            version: 2,
            gatewayOwner,
            sessions: {
              [scopeKey]: {
                updatedAt: Date.now(),
                queue: [
                  {
                    id: "legacy-input",
                    text: "Mock Gateway: upgrade this inline queue",
                    createdAt: Date.now(),
                    sendRunId: "legacy-idempotency",
                    sendAttempts: 0,
                    sendState: "waiting-reconnect",
                    attachments: [
                      {
                        id: "legacy-file",
                        mimeType: "text/plain",
                        fileName: "mock-original.txt",
                        dataUrl: `data:text/plain;base64,${content}`,
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("openclaw-control-ui", 1);
          request.onupgradeneeded = () =>
            request.result
              .createObjectStore("composerDrafts", { keyPath: "key" })
              .createIndex("ownerKey", "ownerKey");
          request.onsuccess = () => resolve(request.result);
          request.addEventListener("error", () =>
            reject(request.error ?? new Error("IndexedDB request failed")),
          );
        });
        const transaction = database.transaction("composerDrafts", "readwrite");
        const ownerKey = JSON.stringify([gatewayOwner, "e2e-recovery-scope"]);
        transaction.objectStore("composerDrafts").put({
          key: JSON.stringify([gatewayOwner, "e2e-recovery-scope", scopeKey]),
          ownerKey,
          gatewayOwner,
          recoveryScope: "e2e-recovery-scope",
          scopeKey,
          text: "Mock Gateway: old durable draft",
          revision: Date.now(),
          updatedAt: Date.now(),
          writeId: "upgrade-draft",
          attachments: [
            {
              blob: new Blob(["draft bytes"], { type: "text/plain" }),
              mimeType: "text/plain",
              fileName: "draft.txt",
            },
          ],
        });
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.addEventListener("abort", () =>
            reject(transaction.error ?? new Error("IndexedDB transaction failed")),
          );
        });
        database.close();
      }, file.buffer.toString("base64"));
      const gateway = await installMockGateway(page, {
        historyMessages: history,
        sessionInfo: {
          key: "main",
          hasActiveRun: true,
          activeRunIds: ["mock-held-run"],
          status: "running",
        },
        inFlightRun: { runId: "mock-held-run", text: "Mock Gateway: keeping upgrade queue held." },
      });
      await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await expect
        .poll(() => composerFor(page).inputValue())
        .toBe("Mock Gateway: old durable draft");
      await expect.poll(() => paneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
      expect((await readQueue(page))[0]?.sendRunId).toBe("legacy-idempotency");
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await composerFor(page).fill("Mock Gateway: newer independent draft");
      const row = paneFor(page).locator(".chat-queue__item");
      await row.dblclick();
      await row.locator(".chat-queue__edit-input").fill("cancel this edit");
      await row.locator(".chat-queue__edit-cancel").click();
      expect((await readQueue(page))[0]?.text).toBe("Mock Gateway: upgrade this inline queue");
      await row.dblclick();
      await row.locator(".chat-queue__edit-input").fill("Mock Gateway: edited with original bytes");
      await row.locator(".chat-queue__edit-submit").click();
      try {
        await expect
          .poll(async () => (await readQueue(page))[0]?.text)
          .toBe("Mock Gateway: edited with original bytes");
      } catch (error) {
        const bodyText = await page.locator("body").textContent();
        assert(bodyText !== null, "Expected a body for the failure capture");
        await writeFile(path.join(proofDir, "upgrade-failure.txt"), bodyText);
        await page.screenshot({ path: path.join(proofDir, "upgrade-failure.png"), fullPage: true });
        throw error;
      }
      expect((await readQueue(page))[0]?.attachmentPayload).toBeDefined();
      expect(await composerFor(page).inputValue()).toBe("Mock Gateway: newer independent draft");
      expect(await paneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
      await expect.poll(() => payloadCount(page)).toBe(1);
      await row.getByRole("button", { name: "Remove queued message", exact: true }).click();
      await expect.poll(() => payloadCount(page)).toBe(0);
      expect(await composerFor(page).inputValue()).toBe("Mock Gateway: newer independent draft");
      await expectRequestCountStable(gateway, "chat.send", 0);
    });
  });

  it("does not clear newer composer input while native Blob admission is waiting", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: history,
        sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
        deferredMethods: ["chat.send"],
      });
      await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await paneFor(page)
        .getByText("Mock Gateway: payload lifecycle proof.", { exact: true })
        .waitFor();
      await stage(page, "Mock Gateway: captured before storage wait");
      const gate = await page.evaluateHandle(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("openclaw-control-ui", 2);
          request.onsuccess = () => resolve(request.result);
          request.addEventListener("error", () =>
            reject(request.error ?? new Error("IndexedDB request failed")),
          );
        });
        let hold = true;
        const transaction = database.transaction("outboxPayloads", "readwrite");
        const next = () => {
          const request = transaction.objectStore("outboxPayloads").get("hold-native-transaction");
          request.onsuccess = () => {
            if (hold) {
              next();
            }
          };
        };
        next();
        transaction.oncomplete = () => database.close();
        return {
          release: () => {
            hold = false;
          },
        };
      });
      await paneFor(page).getByRole("button", { name: "Send message", exact: true }).click();
      await composerFor(page).fill("Mock Gateway: newer input must survive");
      expect(await readQueue(page)).toEqual([]);
      await expectRequestCountStable(gateway, "chat.send", 0);
      await gate.evaluate((value) => value.release());
      await gate.dispose();
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toEqual(
        expect.objectContaining({
          message: "Mock Gateway: captured before storage wait",
          attachments: [
            {
              type: "file",
              mimeType: file.mimeType,
              fileName: file.name,
              content: file.buffer.toString("base64"),
            },
          ],
        }),
      );
      expect(await composerFor(page).inputValue()).toBe("Mock Gateway: newer input must survive");
      expect(await paneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
    });
  });
  it("keeps another credential owner isolated and retains a corrupt bundle without sending partial content", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: history,
        sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
      });
      await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await paneFor(page)
        .getByText("Mock Gateway: payload lifecycle proof.", { exact: true })
        .waitFor();
      const hello = await page.evaluate(
        () =>
          (
            document.querySelector("openclaw-app") as unknown as {
              runtime: {
                context: { gateway: { snapshot: { hello: { auth: Record<string, unknown> } } } };
              };
            }
          ).runtime.context.gateway.snapshot.hello,
      );
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await stage(page, "Mock Gateway: credential-owned bytes");
      await paneFor(page).getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(async () => (await readQueue(page)).length).toBe(1);
      const original = (await readQueue(page))[0]!;
      await gateway.setMethodResponse("connect", {
        ...hello,
        auth: { ...hello.auth, recoveryScope: "e2e-other-owner" },
      });
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(() =>
          paneFor(page).evaluate(
            (pane) =>
              (pane as unknown as { state: { client: { recoveryScope: string } } }).state.client
                .recoveryScope,
          ),
        )
        .toBe("e2e-other-owner");
      await expect.poll(() => paneFor(page).locator(".chat-queue__item").count()).toBe(0);
      await expectRequestCountStable(gateway, "chat.send", 0);
      expect((await readQueue(page))[0]?.sendRunId).toBe(original.sendRunId);
      await page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("openclaw-control-ui");
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () =>
            reject(request.error ?? new Error("IDB open failed")),
          );
        });
        const transaction = database.transaction("outboxPayloads", "readwrite");
        const store = transaction.objectStore("outboxPayloads");
        const request = store.openCursor();
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (!cursor) {
            return;
          }
          const record = cursor.value;
          record.attachments[0].blob = "corrupt";
          cursor.update(record);
          cursor.continue();
        });
        await new Promise<void>((resolve, reject) => {
          transaction.addEventListener("complete", () => resolve());
          transaction.addEventListener("abort", () =>
            reject(transaction.error ?? new Error("IDB abort")),
          );
        });
        database.close();
      });
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await gateway.setMethodResponse("connect", hello);
      await gateway.setOnline(true);
      await expect
        .poll(async () => (await readQueue(page))[0]?.attachmentStorageError)
        .toBe("missing");
      await expect
        .poll(() => page.locator("body").textContent())
        .toContain("Queued attachments are missing or unreadable");
      await expectRequestCountStable(gateway, "chat.send", 0);
      expect((await readQueue(page))[0]?.id).toBe(original.id);
      await page.screenshot({
        path: path.join(proofDir, "corrupt-payload-retained.png"),
        animations: "disabled",
        fullPage: true,
      });
    });
  });
});
